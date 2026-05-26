#!/usr/bin/env node
import { cpus, freemem, hostname, loadavg, platform, release, totalmem, uptime } from "node:os";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const SAMPLE_FILE = "samples.jsonl";
const STATE_FILE = "state.json";

if (import.meta.url === `file://${process.argv[1]}`) {
  runPlugin().catch((error) => {
    writeResult({ ok: false, stderr: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}

export async function runPlugin() {
  const request = await readRequest();
  const settings = normalizeSettings(request.settings);
  const dataDir = request.dataDir || process.cwd();
  await mkdir(dataDir, { recursive: true });

  if (request.type === "collector") {
    requirePermission(request, "system.metrics.read");
    const sample = await collectAndStoreSample(dataDir, settings, request);
    writeResult({ ok: true, output: { sample } });
    return;
  }

  if (request.type === "command") {
    requirePermission(request, "system.metrics.read");
    await handleCommand(request, dataDir, settings);
    return;
  }

  if (request.type === "web-panel") {
    writeResult({ ok: true, html: renderDashboardPanel(request.input, request.context) });
    return;
  }

  if (request.type === "diagnostics") {
    const samples = await readSamples(dataDir, 5);
    writeResult({
      ok: true,
      diagnostics: {
        plugin: "system-monitor",
        samples: samples.length,
        latest: samples.at(-1) ?? null,
        dataDir,
      },
    });
    return;
  }

  writeResult({ ok: false, stderr: `Unsupported request type: ${request.type}` });
}

async function handleCommand(request, dataDir, settings) {
  const command = request.command || request.capabilityId;
  if (command === "sample") {
    const sample = await collectAndStoreSample(dataDir, settings, request);
    writeResult({ ok: true, output: { sample } });
    return;
  }
  if (command === "latest") {
    const sample = await collectAndStoreSample(dataDir, settings, request);
    const history = await readSamples(dataDir, numberInput(request.input.limit, 60));
    writeResult({ ok: true, output: { sample, history } });
    return;
  }
  if (command === "history") {
    const samples = await readSamples(dataDir, numberInput(request.input.limit, 120));
    writeResult({ ok: true, output: { samples } });
    return;
  }
  if (command === "status") {
    const samples = await readSamples(dataDir, 1);
    const samplePath = path.join(dataDir, SAMPLE_FILE);
    const size = existsSync(samplePath) ? (await stat(samplePath)).size : 0;
    writeResult({ ok: true, output: { latest: samples.at(-1) ?? null, sampleBytes: size, dataDir } });
    return;
  }
  if (command === "cleanup") {
    const kept = await cleanupSamples(dataDir, settings.retentionHours);
    writeResult({ ok: true, output: { kept } });
    return;
  }
  writeResult({ ok: false, stderr: `Unknown system-monitor command: ${command}` });
}

async function collectAndStoreSample(dataDir, settings, request) {
  const state = await readState(dataDir);
  const cpuSnapshot = cpuCounters();
  const networkCounters = settings.trackNetworkInterfaces ? collectNetworkCounters() : [];
  const now = new Date().toISOString();
  const node = request.context?.runtime ?? {};
  const sample = {
    timestamp: now,
    node: {
      id: node.nodeId || "",
      name: node.nodeName || hostname(),
      platform: node.platform || platform(),
      hostname: hostname(),
      release: release(),
      workspace: node.workspace || "",
    },
    uptimeSeconds: Math.floor(uptime()),
    cpu: {
      percent: cpuPercent(state.cpu, cpuSnapshot),
      cores: cpus().length,
      load1: loadavg()[0] ?? 0,
      load5: loadavg()[1] ?? 0,
      load15: loadavg()[2] ?? 0,
    },
    memory: memorySample(),
    disk: settings.trackDisks ? collectDisks() : [],
    network: networkSample(state.network, networkCounters),
  };
  await appendSample(dataDir, sample);
  await writeState(dataDir, { cpu: cpuSnapshot, network: networkCounters, lastSampleAt: now });
  await cleanupSamples(dataDir, settings.retentionHours);
  return sample;
}

function cpuCounters() {
  return cpus().reduce((acc, cpu) => {
    const times = cpu.times;
    acc.idle += times.idle;
    acc.total += times.user + times.nice + times.sys + times.idle + times.irq;
    return acc;
  }, { idle: 0, total: 0 });
}

function cpuPercent(previous, current) {
  if (!previous || !Number.isFinite(previous.total) || previous.total <= 0) return 0;
  const idle = current.idle - previous.idle;
  const total = current.total - previous.total;
  if (total <= 0) return 0;
  return roundPercent((1 - idle / total) * 100);
}

function memorySample() {
  const total = totalmem();
  const free = freemem();
  const used = Math.max(0, total - free);
  return {
    totalBytes: total,
    freeBytes: free,
    usedBytes: used,
    percent: total > 0 ? roundPercent((used / total) * 100) : 0,
  };
}

function collectDisks() {
  if (platform() === "win32") {
    return parseWindowsDiskOutput(run("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_LogicalDisk -Filter DriveType=3 | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress"]));
  }
  return parseDf(run("df", ["-kP"]));
}

export function parseDf(output) {
  return String(output || "")
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 6)
    .map((parts) => {
      const totalBytes = Number(parts[1]) * 1024;
      const usedBytes = Number(parts[2]) * 1024;
      const availableBytes = Number(parts[3]) * 1024;
      return {
        filesystem: parts[0],
        mount: parts.slice(5).join(" "),
        totalBytes,
        usedBytes,
        availableBytes,
        percent: totalBytes > 0 ? roundPercent((usedBytes / totalBytes) * 100) : 0,
      };
    })
    .filter((item) => Number.isFinite(item.totalBytes) && item.totalBytes > 0);
}

export function parseWindowsDiskOutput(output) {
  try {
    const parsed = JSON.parse(String(output || "[]"));
    const disks = Array.isArray(parsed) ? parsed : [parsed];
    return disks.map((item) => {
      const totalBytes = Number(item.Size) || 0;
      const freeBytes = Number(item.FreeSpace) || 0;
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      return {
        filesystem: String(item.DeviceID || ""),
        mount: String(item.DeviceID || ""),
        totalBytes,
        usedBytes,
        availableBytes: freeBytes,
        percent: totalBytes > 0 ? roundPercent((usedBytes / totalBytes) * 100) : 0,
      };
    }).filter((item) => item.totalBytes > 0);
  } catch {
    return [];
  }
}

function collectNetworkCounters() {
  if (platform() === "linux" && existsSync("/proc/net/dev")) {
    return parseProcNetDev(readFileSync("/proc/net/dev", "utf8"));
  }
  if (platform() === "darwin") {
    return parseNetstatIb(run("netstat", ["-ib"]));
  }
  if (platform() === "win32") {
    return parseWindowsNetworkOutput(run("powershell.exe", ["-NoProfile", "-Command", "Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes | ConvertTo-Json -Compress"]));
  }
  return [];
}

export function parseProcNetDev(output) {
  return String(output || "")
    .split(/\r?\n/)
    .slice(2)
    .map((line) => {
      const [name, values] = line.split(":");
      if (!name || !values) return null;
      const parts = values.trim().split(/\s+/).map(Number);
      if (parts.length < 16) return null;
      return { name: name.trim(), rxBytes: parts[0], txBytes: parts[8] };
    })
    .filter(Boolean)
    .filter((item) => item.name !== "lo");
}

export function parseNetstatIb(output) {
  const rows = String(output || "").split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length > 10);
  const map = new Map();
  for (const parts of rows.slice(1)) {
    const name = parts[0];
    const rxBytes = Number(parts[6]);
    const txBytes = Number(parts[9]);
    if (!name || name === "lo0" || !Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue;
    const previous = map.get(name) || { name, rxBytes: 0, txBytes: 0 };
    previous.rxBytes += rxBytes;
    previous.txBytes += txBytes;
    map.set(name, previous);
  }
  return [...map.values()];
}

export function parseWindowsNetworkOutput(output) {
  try {
    const parsed = JSON.parse(String(output || "[]"));
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((item) => ({
      name: String(item.Name || ""),
      rxBytes: Number(item.ReceivedBytes) || 0,
      txBytes: Number(item.SentBytes) || 0,
    })).filter((item) => item.name);
  } catch {
    return [];
  }
}

function networkSample(previous = [], current = []) {
  const previousByName = new Map(previous.map((item) => [item.name, item]));
  return current.map((item) => {
    const old = previousByName.get(item.name);
    return {
      ...item,
      rxBytesPerSec: old ? Math.max(0, item.rxBytes - old.rxBytes) : 0,
      txBytesPerSec: old ? Math.max(0, item.txBytes - old.txBytes) : 0,
    };
  });
}

async function appendSample(dataDir, sample) {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, SAMPLE_FILE);
  const existing = existsSync(file) ? await readFile(file, "utf8") : "";
  await writeFile(file, `${existing}${JSON.stringify(sample)}\n`, "utf8");
}

async function readSamples(dataDir, limit = 120) {
  try {
    const raw = await readFile(path.join(dataDir, SAMPLE_FILE), "utf8");
    const rows = raw.trim().split(/\r?\n/).filter(Boolean).slice(-Math.max(1, limit));
    return rows.map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function cleanupSamples(dataDir, retentionHours) {
  const samples = await readSamples(dataDir, 100000);
  const cutoff = Date.now() - Math.max(1, retentionHours) * 60 * 60 * 1000;
  const kept = samples.filter((sample) => new Date(sample.timestamp).getTime() >= cutoff);
  const file = path.join(dataDir, SAMPLE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, kept.map((sample) => JSON.stringify(sample)).join("\n") + (kept.length ? "\n" : ""), "utf8");
  await rename(tmp, file);
  return kept.length;
}

async function readState(dataDir) {
  try {
    return JSON.parse(await readFile(path.join(dataDir, STATE_FILE), "utf8"));
  } catch {
    return {};
  }
}

async function writeState(dataDir, state) {
  await writeFile(path.join(dataDir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function renderDashboardPanel(input = {}, context = {}) {
  const aggregate = input.aggregate && typeof input.aggregate === "object" ? input.aggregate : {};
  const results = Array.isArray(aggregate.results) ? aggregate.results : [];
  const nodes = results.length ? results : [{ node: context.runtime || { name: "Local node" }, ok: false, error: "No aggregate data available." }];
  const cards = nodes.map(renderNodeCard).join("");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
:root{color-scheme:light dark;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{margin:0;padding:16px;color:#d8dee9;background:#111827}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.card{border:1px solid rgba(255,255,255,.14);border-radius:8px;background:#172033;padding:14px}
.card.failed{border-color:#ef4444}
h1{font-size:18px;margin:0 0 14px}h2{font-size:15px;margin:0 0 8px}.muted{color:#9ca3af}.metric{display:grid;grid-template-columns:110px 1fr;gap:6px;font-size:13px;margin:4px 0}.bar{height:7px;background:#263244;border-radius:999px;overflow:hidden}.fill{height:100%;background:#22c55e}.warn .fill{background:#f59e0b}.bad .fill{background:#ef4444}small{display:block;color:#9ca3af;margin-top:8px}code{font-size:12px;color:#cbd5e1}
</style>
</head>
<body>
<h1>System Monitor <span class="muted">· ${escapeHtml(nodes.length)} node${nodes.length === 1 ? "" : "s"}</span></h1>
<div class="grid">${cards}</div>
</body>
</html>`;
}

function renderNodeCard(item) {
  const node = item.node || {};
  if (!item.ok) {
    return `<section class="card failed"><h2>${escapeHtml(node.name || node.id || "Node")}</h2><div class="muted">${escapeHtml(item.error || "Plugin unavailable")}</div></section>`;
  }
  const sample = item.result?.output?.sample || item.result?.sample || item.output?.sample;
  if (!sample) {
    return `<section class="card failed"><h2>${escapeHtml(node.name || node.id || "Node")}</h2><div class="muted">No metrics sample returned.</div></section>`;
  }
  const disk = Array.isArray(sample.disk) ? sample.disk.sort((a, b) => b.percent - a.percent)[0] : null;
  const network = Array.isArray(sample.network) ? sample.network.reduce((acc, row) => ({
    rxBytesPerSec: acc.rxBytesPerSec + (Number(row.rxBytesPerSec) || 0),
    txBytesPerSec: acc.txBytesPerSec + (Number(row.txBytesPerSec) || 0),
  }), { rxBytesPerSec: 0, txBytesPerSec: 0 }) : null;
  return `<section class="card">
    <h2>${escapeHtml(node.name || sample.node?.name || node.id || "Node")}</h2>
    <div class="muted">${escapeHtml(sample.node?.platform || node.platform || "")} ${escapeHtml(sample.node?.hostname || "")}</div>
    ${metricRow("CPU", sample.cpu?.percent, "%")}
    ${metricRow("Memory", sample.memory?.percent, "%")}
    ${disk ? metricRow(`Disk ${disk.mount || ""}`, disk.percent, "%") : ""}
    <div class="metric"><span>Network</span><span>${formatBytes(network?.rxBytesPerSec || 0)}/s down · ${formatBytes(network?.txBytesPerSec || 0)}/s up</span></div>
    <small>${escapeHtml(sample.timestamp || "")}</small>
  </section>`;
}

function metricRow(label, value, suffix) {
  const number = Number(value) || 0;
  const cls = number >= 90 ? "bad" : number >= 75 ? "warn" : "";
  return `<div class="metric ${cls}"><span>${escapeHtml(label)}</span><span>${number.toFixed(1)}${suffix}<div class="bar"><div class="fill" style="width:${Math.max(0, Math.min(100, number))}%"></div></div></span></div>`;
}

function normalizeSettings(settings = {}) {
  return {
    sampleIntervalMs: numberInput(settings.sampleIntervalMs, 5000),
    retentionHours: numberInput(settings.retentionHours, 72),
    trackDisks: settings.trackDisks !== false && settings.trackDisks !== "false",
    trackNetworkInterfaces: settings.trackNetworkInterfaces !== false && settings.trackNetworkInterfaces !== "false",
  };
}

async function readRequest() {
  const raw = await new Promise((resolve, reject) => {
    process.stdin.setEncoding("utf8");
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(input));
  });
  return raw.trim() ? JSON.parse(raw) : {};
}

function requirePermission(request, permission) {
  if (!Array.isArray(request.permissions) || !request.permissions.includes(permission)) {
    throw new Error(`Plugin permission required: ${permission}`);
  }
}

function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 2000, windowsHide: true });
  return result.status === 0 ? result.stdout : "";
}

function numberInput(value, fallback) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function roundPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function formatBytes(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number < 1024) return `${Math.round(number)} B`;
  if (number < 1024 * 1024) return `${(number / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  if (number < 1024 * 1024 * 1024) return `${(number / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
  return `${(number / 1024 / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} GB`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

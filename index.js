#!/usr/bin/env node
import { cpus, freemem, hostname, loadavg, platform, release, totalmem, uptime } from "node:os";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DB_FILE = "metrics.sqlite";
const STATE_FILE = "state.json";
const SQLITE_SCHEMA_VERSION = 1;
const DEFAULT_RANGE = "1h";
const RANGE_PRESETS = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

let DatabaseSyncClass;

if (isDirectCliEntry()) {
  runPlugin().catch((error) => {
    writeResult({ ok: false, stderr: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}

function isDirectCliEntry() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

export async function runPlugin() {
  const request = await readRequest();
  const settings = normalizeSettings(request.settings);
  const dataDir = request.dataDir || process.cwd();
  await mkdir(dataDir, { recursive: true });

  if (request.type === "web-panel") {
    writeResult({ ok: true, html: renderDashboardPanel(request.input, request.context) });
    return;
  }

  if (request.type === "diagnostics") {
    const db = await openMetricsDatabase(dataDir);
    try {
      writeResult({
        ok: true,
        diagnostics: {
          plugin: "system-monitor",
          sqlite: await storageStatus(db, dataDir, settings),
          latest: readLatestSample(db),
          dataDir,
        },
      });
    } finally {
      db.close();
    }
    return;
  }

  requirePermission(request, "system.metrics.read");
  const db = await openMetricsDatabase(dataDir);
  try {
    if (request.type === "collector") {
      const sample = await collectAndStoreSample(db, dataDir, settings, request);
      writeResult({ ok: true, output: { sample } });
      return;
    }

    if (request.type === "command") {
      await handleCommand(request, db, dataDir, settings);
      return;
    }
  } finally {
    db.close();
  }

  writeResult({ ok: false, stderr: `Unsupported request type: ${request.type}` });
}

async function handleCommand(request, db, dataDir, settings) {
  const command = request.command || request.capabilityId;
  if (command === "sample") {
    const sample = await collectAndStoreSample(db, dataDir, settings, request);
    writeResult({ ok: true, output: { sample } });
    return;
  }
  if (command === "latest") {
    const sample = await ensureFreshSample(db, dataDir, settings, request);
    const panelData = await buildPanelData(db, dataDir, settings, request);
    writeResult({ ok: true, output: { sample, panelData } });
    return;
  }
  if (command === "history") {
    writeResult({ ok: true, output: { history: readHistory(db, request.input, settings) } });
    return;
  }
  if (command === "panel-data") {
    const panelData = await buildPanelData(db, dataDir, settings, request);
    writeResult({ ok: true, output: { panelData } });
    return;
  }
  if (command === "series") {
    writeResult({ ok: true, output: { series: readSeries(db, request.input, settings) } });
    return;
  }
  if (command === "summary") {
    writeResult({ ok: true, output: { summary: readSummary(db, request.input, settings) } });
    return;
  }
  if (command === "status" || command === "storage") {
    writeResult({
      ok: true,
      output: {
        latest: readLatestSample(db),
        storage: await storageStatus(db, dataDir, settings),
        dataDir,
      },
    });
    return;
  }
  if (command === "cleanup") {
    const deleted = cleanupOldSamples(db, settings);
    writeResult({ ok: true, output: { deleted, storage: await storageStatus(db, dataDir, settings) } });
    return;
  }
  if (command === "vacuum") {
    db.exec("VACUUM");
    writeResult({ ok: true, output: { storage: await storageStatus(db, dataDir, settings) } });
    return;
  }
  writeResult({ ok: false, stderr: `Unknown system-monitor command: ${command}` });
}

async function collectAndStoreSample(db, dataDir, settings, request) {
  const state = await readState(dataDir);
  const cpuSnapshot = cpuCounters();
  const networkCounters = settings.trackNetworkInterfaces ? collectNetworkCounters() : [];
  const timestampMs = Date.now();
  const node = request.context?.runtime ?? {};
  const sample = {
    timestamp: new Date(timestampMs).toISOString(),
    timestampMs,
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
    network: networkSample(state.network, networkCounters, state.lastSampleAtMs, timestampMs),
  };
  const id = insertSample(db, sample);
  maybeCleanup(db, settings, state, timestampMs);
  await writeState(dataDir, {
    cpu: cpuSnapshot,
    network: networkCounters,
    lastSampleAt: sample.timestamp,
    lastSampleAtMs: timestampMs,
    lastCleanupAtMs: state.lastCleanupAtMs,
  });
  return { ...sample, id };
}

async function ensureFreshSample(db, dataDir, settings, request) {
  const latest = readLatestSample(db);
  const maxAge = Math.max(1000, settings.sampleIntervalMs * 2);
  if (!latest || Date.now() - latest.timestampMs > maxAge) {
    return collectAndStoreSample(db, dataDir, settings, request);
  }
  return latest;
}

async function buildPanelData(db, dataDir, settings, request) {
  const current = await ensureFreshSample(db, dataDir, settings, request);
  const history = readHistory(db, request.input, settings);
  const summary = readSummary(db, request.input, settings);
  const storage = await storageStatus(db, dataDir, settings);
  return {
    current,
    history,
    summary,
    storage,
    settings: {
      retentionDays: settings.retentionDays,
      maxChartPoints: settings.maxChartPoints,
      autoRefreshMs: settings.autoRefreshMs,
    },
  };
}

async function openMetricsDatabase(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const DatabaseSync = await loadDatabaseSync();
  const db = new DatabaseSync(path.join(dataDir, DB_FILE));
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      node_name TEXT,
      node_platform TEXT,
      node_hostname TEXT,
      node_release TEXT,
      node_workspace TEXT,
      uptime_seconds INTEGER,
      cpu_percent REAL,
      cpu_cores INTEGER,
      load1 REAL,
      load5 REAL,
      load15 REAL,
      memory_percent REAL,
      memory_used_bytes INTEGER,
      memory_free_bytes INTEGER,
      memory_total_bytes INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);
    CREATE INDEX IF NOT EXISTS idx_samples_node_ts ON samples(node_id, ts);
    CREATE TABLE IF NOT EXISTS disks (
      sample_id INTEGER NOT NULL,
      mount TEXT NOT NULL,
      filesystem TEXT,
      percent REAL,
      used_bytes INTEGER,
      available_bytes INTEGER,
      total_bytes INTEGER,
      PRIMARY KEY(sample_id, mount, filesystem),
      FOREIGN KEY(sample_id) REFERENCES samples(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_disks_sample ON disks(sample_id);
    CREATE TABLE IF NOT EXISTS network (
      sample_id INTEGER NOT NULL,
      interface TEXT NOT NULL,
      rx_bps REAL,
      tx_bps REAL,
      rx_bytes INTEGER,
      tx_bytes INTEGER,
      PRIMARY KEY(sample_id, interface),
      FOREIGN KEY(sample_id) REFERENCES samples(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_network_sample ON network(sample_id);
  `);
  db.prepare("INSERT OR REPLACE INTO schema_meta(key,value) VALUES (?, ?)").run("schemaVersion", String(SQLITE_SCHEMA_VERSION));
  return db;
}

async function loadDatabaseSync() {
  if (DatabaseSyncClass) return DatabaseSyncClass;
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function emitWarningWithoutSqliteExperimentalNoise(warning, ...args) {
    const text = typeof warning === "string" ? warning : warning?.message;
    const type = typeof args[0] === "string" ? args[0] : warning?.name;
    if (type === "ExperimentalWarning" && /SQLite/i.test(String(text || ""))) return;
    return originalEmitWarning.call(this, warning, ...args);
  };
  try {
    const sqlite = await import("node:sqlite");
    if (typeof sqlite.DatabaseSync !== "function") {
      throw new Error("node:sqlite DatabaseSync is not available in this Node.js runtime.");
    }
    DatabaseSyncClass = sqlite.DatabaseSync;
    return DatabaseSyncClass;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function insertSample(db, sample) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const info = db.prepare(`
      INSERT INTO samples (
        ts, node_id, node_name, node_platform, node_hostname, node_release, node_workspace,
        uptime_seconds, cpu_percent, cpu_cores, load1, load5, load15,
        memory_percent, memory_used_bytes, memory_free_bytes, memory_total_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sample.timestampMs,
      sample.node.id || "",
      sample.node.name || "",
      sample.node.platform || "",
      sample.node.hostname || "",
      sample.node.release || "",
      sample.node.workspace || "",
      sample.uptimeSeconds || 0,
      sample.cpu.percent,
      sample.cpu.cores,
      sample.cpu.load1,
      sample.cpu.load5,
      sample.cpu.load15,
      sample.memory.percent,
      sample.memory.usedBytes,
      sample.memory.freeBytes,
      sample.memory.totalBytes,
    );
    const sampleId = Number(info.lastInsertRowid);
    const diskStmt = db.prepare(`
      INSERT INTO disks(sample_id, mount, filesystem, percent, used_bytes, available_bytes, total_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const disk of sample.disk || []) {
      diskStmt.run(
        sampleId,
        disk.mount || "",
        disk.filesystem || "",
        numberOrNull(disk.percent),
        integerOrNull(disk.usedBytes),
        integerOrNull(disk.availableBytes),
        integerOrNull(disk.totalBytes),
      );
    }
    const networkStmt = db.prepare(`
      INSERT INTO network(sample_id, interface, rx_bps, tx_bps, rx_bytes, tx_bytes)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const row of sample.network || []) {
      networkStmt.run(
        sampleId,
        row.name || "",
        numberOrNull(row.rxBytesPerSec),
        numberOrNull(row.txBytesPerSec),
        integerOrNull(row.rxBytes),
        integerOrNull(row.txBytes),
      );
    }
    db.exec("COMMIT");
    return sampleId;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function readLatestSample(db) {
  const row = db.prepare("SELECT * FROM samples ORDER BY ts DESC LIMIT 1").get();
  return row ? hydrateSample(db, row) : null;
}

function hydrateSample(db, row) {
  const disks = db.prepare("SELECT * FROM disks WHERE sample_id = ? ORDER BY percent DESC").all(row.id);
  const networkRows = db.prepare("SELECT * FROM network WHERE sample_id = ? ORDER BY interface ASC").all(row.id);
  return {
    id: Number(row.id),
    timestamp: new Date(Number(row.ts)).toISOString(),
    timestampMs: Number(row.ts),
    node: {
      id: row.node_id || "",
      name: row.node_name || "",
      platform: row.node_platform || "",
      hostname: row.node_hostname || "",
      release: row.node_release || "",
      workspace: row.node_workspace || "",
    },
    uptimeSeconds: Number(row.uptime_seconds) || 0,
    cpu: {
      percent: roundPercent(Number(row.cpu_percent) || 0),
      cores: Number(row.cpu_cores) || 0,
      load1: Number(row.load1) || 0,
      load5: Number(row.load5) || 0,
      load15: Number(row.load15) || 0,
    },
    memory: {
      percent: roundPercent(Number(row.memory_percent) || 0),
      usedBytes: Number(row.memory_used_bytes) || 0,
      freeBytes: Number(row.memory_free_bytes) || 0,
      totalBytes: Number(row.memory_total_bytes) || 0,
    },
    disk: disks.map((disk) => ({
      mount: disk.mount || "",
      filesystem: disk.filesystem || "",
      percent: roundPercent(Number(disk.percent) || 0),
      usedBytes: Number(disk.used_bytes) || 0,
      availableBytes: Number(disk.available_bytes) || 0,
      totalBytes: Number(disk.total_bytes) || 0,
    })),
    network: networkRows.map((row) => ({
      name: row.interface || "",
      rxBytesPerSec: Math.max(0, Number(row.rx_bps) || 0),
      txBytesPerSec: Math.max(0, Number(row.tx_bps) || 0),
      rxBytes: Number(row.rx_bytes) || 0,
      txBytes: Number(row.tx_bytes) || 0,
    })),
  };
}

function readHistory(db, input = {}, settings = normalizeSettings()) {
  const range = resolveRange(input, settings);
  const bucketMs = Math.max(1000, Math.ceil(range.rangeMs / Math.max(1, range.maxPoints) / 1000) * 1000);
  const core = db.prepare(`
    SELECT CAST(ts / ? AS INTEGER) * ? AS timestamp,
      avg(cpu_percent) AS cpu_percent,
      max(cpu_percent) AS cpu_max_percent,
      avg(memory_percent) AS memory_percent,
      avg(load1) AS load1,
      avg(load5) AS load5,
      avg(load15) AS load15
    FROM samples
    WHERE ts >= ? AND ts <= ?
    GROUP BY CAST(ts / ? AS INTEGER)
    ORDER BY timestamp ASC
  `).all(bucketMs, bucketMs, range.fromMs, range.toMs, bucketMs).map((row) => ({
    timestamp: Number(row.timestamp),
    cpuPercent: roundPercent(Number(row.cpu_percent) || 0),
    cpuMaxPercent: roundPercent(Number(row.cpu_max_percent) || 0),
    memoryPercent: roundPercent(Number(row.memory_percent) || 0),
    load1: roundNumber(row.load1),
    load5: roundNumber(row.load5),
    load15: roundNumber(row.load15),
  }));
  return {
    ...range,
    bucketMs,
    points: core,
    disks: readDiskSeries(db, range, bucketMs),
    network: readNetworkSeries(db, range, bucketMs),
  };
}

function readDiskSeries(db, range, bucketMs) {
  const targets = db.prepare(`
    SELECT disks.mount AS mount, disks.filesystem AS filesystem, max(disks.percent) AS max_percent
    FROM disks
    JOIN samples ON samples.id = disks.sample_id
    WHERE samples.ts >= ? AND samples.ts <= ?
    GROUP BY disks.mount, disks.filesystem
    ORDER BY max_percent DESC
    LIMIT 4
  `).all(range.fromMs, range.toMs);
  return targets.map((target) => ({
    mount: target.mount || "",
    filesystem: target.filesystem || "",
    points: db.prepare(`
      SELECT CAST(samples.ts / ? AS INTEGER) * ? AS timestamp,
        avg(disks.percent) AS percent,
        avg(disks.used_bytes) AS used_bytes,
        avg(disks.total_bytes) AS total_bytes
      FROM disks
      JOIN samples ON samples.id = disks.sample_id
      WHERE samples.ts >= ? AND samples.ts <= ? AND disks.mount = ? AND disks.filesystem = ?
      GROUP BY CAST(samples.ts / ? AS INTEGER)
      ORDER BY timestamp ASC
    `).all(bucketMs, bucketMs, range.fromMs, range.toMs, target.mount || "", target.filesystem || "", bucketMs).map((row) => ({
      timestamp: Number(row.timestamp),
      percent: roundPercent(Number(row.percent) || 0),
      usedBytes: Math.round(Number(row.used_bytes) || 0),
      totalBytes: Math.round(Number(row.total_bytes) || 0),
    })),
  }));
}

function readNetworkSeries(db, range, bucketMs) {
  const targets = db.prepare(`
    SELECT network.interface AS interface, avg(network.rx_bps + network.tx_bps) AS average_bps
    FROM network
    JOIN samples ON samples.id = network.sample_id
    WHERE samples.ts >= ? AND samples.ts <= ?
    GROUP BY network.interface
    ORDER BY average_bps DESC
    LIMIT 4
  `).all(range.fromMs, range.toMs);
  return targets.map((target) => ({
    name: target.interface || "",
    points: db.prepare(`
      SELECT CAST(samples.ts / ? AS INTEGER) * ? AS timestamp,
        avg(network.rx_bps) AS rx_bps,
        avg(network.tx_bps) AS tx_bps
      FROM network
      JOIN samples ON samples.id = network.sample_id
      WHERE samples.ts >= ? AND samples.ts <= ? AND network.interface = ?
      GROUP BY CAST(samples.ts / ? AS INTEGER)
      ORDER BY timestamp ASC
    `).all(bucketMs, bucketMs, range.fromMs, range.toMs, target.interface || "", bucketMs).map((row) => ({
      timestamp: Number(row.timestamp),
      rxBytesPerSec: Math.max(0, Math.round(Number(row.rx_bps) || 0)),
      txBytesPerSec: Math.max(0, Math.round(Number(row.tx_bps) || 0)),
    })),
  }));
}

function readSeries(db, input = {}, settings = normalizeSettings()) {
  const history = readHistory(db, input, settings);
  const metric = String(input.metric || "cpu").toLowerCase();
  if (metric === "memory") return { ...history, series: history.points.map((p) => ({ timestamp: p.timestamp, value: p.memoryPercent })) };
  if (metric === "disk") {
    const mount = String(input.mount || history.disks[0]?.mount || "");
    const disk = history.disks.find((item) => item.mount === mount) || history.disks[0] || { points: [] };
    return { ...history, series: disk.points.map((p) => ({ timestamp: p.timestamp, value: p.percent })), target: disk.mount || "" };
  }
  if (metric === "network") {
    const name = String(input.interface || history.network[0]?.name || "");
    const network = history.network.find((item) => item.name === name) || history.network[0] || { points: [] };
    return {
      ...history,
      series: network.points.map((p) => ({ timestamp: p.timestamp, rxBytesPerSec: p.rxBytesPerSec, txBytesPerSec: p.txBytesPerSec })),
      target: network.name || "",
    };
  }
  return { ...history, series: history.points.map((p) => ({ timestamp: p.timestamp, value: p.cpuPercent })) };
}

function readSummary(db, input = {}, settings = normalizeSettings()) {
  const range = resolveRange(input, settings);
  const row = db.prepare(`
    SELECT count(*) AS samples,
      min(cpu_percent) AS cpu_min,
      avg(cpu_percent) AS cpu_avg,
      max(cpu_percent) AS cpu_max,
      min(memory_percent) AS memory_min,
      avg(memory_percent) AS memory_avg,
      max(memory_percent) AS memory_max
    FROM samples
    WHERE ts >= ? AND ts <= ?
  `).get(range.fromMs, range.toMs);
  const disk = db.prepare(`
    SELECT disks.mount AS mount, max(disks.percent) AS max_percent
    FROM disks
    JOIN samples ON samples.id = disks.sample_id
    WHERE samples.ts >= ? AND samples.ts <= ?
    GROUP BY disks.mount
    ORDER BY max_percent DESC
    LIMIT 1
  `).get(range.fromMs, range.toMs);
  const network = db.prepare(`
    SELECT max(network.rx_bps) AS max_rx_bps, max(network.tx_bps) AS max_tx_bps, avg(network.rx_bps + network.tx_bps) AS avg_total_bps
    FROM network
    JOIN samples ON samples.id = network.sample_id
    WHERE samples.ts >= ? AND samples.ts <= ?
  `).get(range.fromMs, range.toMs);
  return {
    ...range,
    samples: Number(row?.samples) || 0,
    cpu: {
      min: roundPercent(Number(row?.cpu_min) || 0),
      avg: roundPercent(Number(row?.cpu_avg) || 0),
      max: roundPercent(Number(row?.cpu_max) || 0),
    },
    memory: {
      min: roundPercent(Number(row?.memory_min) || 0),
      avg: roundPercent(Number(row?.memory_avg) || 0),
      max: roundPercent(Number(row?.memory_max) || 0),
    },
    disk: disk ? { mount: disk.mount || "", max: roundPercent(Number(disk.max_percent) || 0) } : null,
    network: network ? {
      maxRxBytesPerSec: Math.round(Number(network.max_rx_bps) || 0),
      maxTxBytesPerSec: Math.round(Number(network.max_tx_bps) || 0),
      averageBytesPerSec: Math.round(Number(network.avg_total_bps) || 0),
    } : null,
  };
}

async function storageStatus(db, dataDir, settings) {
  const row = db.prepare("SELECT count(*) AS samples, min(ts) AS oldest_ts, max(ts) AS newest_ts FROM samples").get();
  const diskRows = db.prepare("SELECT count(*) AS count FROM disks").get();
  const networkRows = db.prepare("SELECT count(*) AS count FROM network").get();
  const file = path.join(dataDir, DB_FILE);
  const wal = `${file}-wal`;
  const shm = `${file}-shm`;
  const sizeBytes = (await statSize(file)) + (await statSize(wal)) + (await statSize(shm));
  return {
    database: file,
    sizeBytes,
    samples: Number(row?.samples) || 0,
    diskRows: Number(diskRows?.count) || 0,
    networkRows: Number(networkRows?.count) || 0,
    oldestTimestamp: row?.oldest_ts ? new Date(Number(row.oldest_ts)).toISOString() : null,
    newestTimestamp: row?.newest_ts ? new Date(Number(row.newest_ts)).toISOString() : null,
    retentionDays: settings.retentionDays,
  };
}

async function statSize(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

function maybeCleanup(db, settings, state, nowMs) {
  const intervalMs = Math.max(1, settings.cleanupIntervalMinutes) * 60 * 1000;
  if (state.lastCleanupAtMs && nowMs - Number(state.lastCleanupAtMs) < intervalMs) return 0;
  const deleted = cleanupOldSamples(db, settings);
  state.lastCleanupAtMs = nowMs;
  return deleted;
}

function cleanupOldSamples(db, settings) {
  const retentionDays = Math.max(1, Number(settings.retentionDays) || 30);
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const result = db.prepare("DELETE FROM samples WHERE ts < ?").run(cutoff);
  return Number(result.changes) || 0;
}

function resolveRange(input = {}, settings = normalizeSettings()) {
  const now = Date.now();
  const rangeKey = String(input.range || DEFAULT_RANGE);
  const fallbackRangeMs = RANGE_PRESETS[rangeKey] || RANGE_PRESETS[DEFAULT_RANGE];
  const rangeMs = Math.max(60 * 1000, numberInput(input.rangeMs, fallbackRangeMs));
  const toMs = timestampInput(input.to, now);
  const fromMs = timestampInput(input.from, toMs - rangeMs);
  const maxPoints = Math.max(24, Math.min(2000, numberInput(input.maxPoints, settings.maxChartPoints)));
  return {
    range: RANGE_PRESETS[rangeKey] ? rangeKey : `${Math.round(rangeMs / 60000)}m`,
    rangeMs: Math.max(1, toMs - fromMs),
    fromMs,
    toMs,
    maxPoints,
  };
}

function timestampInput(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
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

function networkSample(previous = [], current = [], previousMs = 0, nowMs = Date.now()) {
  const previousByName = new Map(previous.map((item) => [item.name, item]));
  const elapsedSeconds = previousMs ? Math.max(1, (nowMs - Number(previousMs)) / 1000) : 1;
  return current.map((item) => {
    const old = previousByName.get(item.name);
    return {
      ...item,
      rxBytesPerSec: old ? Math.max(0, Math.round((item.rxBytes - old.rxBytes) / elapsedSeconds)) : 0,
      txBytesPerSec: old ? Math.max(0, Math.round((item.txBytes - old.txBytes) / elapsedSeconds)) : 0,
    };
  });
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
  const range = String(input.range || DEFAULT_RANGE);
  const maxPoints = numberInput(input.maxPoints, 240);
  const panels = nodes.map((item) => renderNodePanel(item, range)).join("");
  return `<div class="stack" data-system-monitor data-range="${escapeHtml(range)}" data-max-points="${escapeHtml(maxPoints)}">
    <div class="section-header">
      <div>
        <h1>System Monitor <small>- ${escapeHtml(nodes.length)} node${nodes.length === 1 ? "" : "s"}</small></h1>
        <small>SQLite-backed history with downsampled charts.</small>
      </div>
      <div class="row">
        ${renderRangeButtons(range)}
        <label class="checkbox"><input type="checkbox" data-auto-refresh> Auto refresh</label>
        ${uiBadge(results.length ? "aggregate" : "local", results.length ? "enabled" : "warning")}
      </div>
    </div>
    ${panels || '<div class="empty-state">No monitor data available.</div>'}
    ${panelScript()}
  </div>`;
}

function renderRangeButtons(selected) {
  return Object.keys(RANGE_PRESETS).map((range) => {
    const active = range === selected ? "active" : "";
    return `<button type="button" class="secondary mini-button ${active}" data-range-button="${escapeHtml(range)}">${escapeHtml(range)}</button>`;
  }).join("");
}

function renderNodePanel(item, range) {
  const node = item.node || {};
  if (!item.ok) {
    return `<section class="panel">
      <div class="section-header"><h2>${escapeHtml(node.name || node.id || "Node")}</h2>${uiBadge("failed", "failed")}</div>
      <div class="error-state">${escapeHtml(item.error || "Plugin unavailable")}</div>
    </section>`;
  }
  const panelData = item.result?.output?.panelData || item.result?.panelData || item.output?.panelData;
  const sample = panelData?.current || item.result?.output?.sample || item.result?.sample || item.output?.sample;
  if (!sample) {
    return `<section class="panel">
      <div class="section-header"><h2>${escapeHtml(node.name || node.id || "Node")}</h2>${uiBadge("missing", "warning")}</div>
      <div class="empty-state">No metrics sample returned.</div>
    </section>`;
  }
  const disk = Array.isArray(sample.disk) ? sample.disk.sort((a, b) => b.percent - a.percent)[0] : null;
  const network = Array.isArray(sample.network) ? sample.network.reduce((acc, row) => ({
    rxBytesPerSec: acc.rxBytesPerSec + (Number(row.rxBytesPerSec) || 0),
    txBytesPerSec: acc.txBytesPerSec + (Number(row.txBytesPerSec) || 0),
  }), { rxBytesPerSec: 0, txBytesPerSec: 0 }) : null;
  const history = panelData?.history || { points: [], disks: [], network: [] };
  const summary = panelData?.summary || {};
  const storage = panelData?.storage || {};
  const title = node.name || sample.node?.name || node.id || "Node";
  return `<section class="panel">
    <div class="section-header">
      <div>
        <h2>${escapeHtml(title)}</h2>
        <small>${escapeHtml([sample.node?.platform || node.platform || "", sample.node?.hostname || ""].filter(Boolean).join(" - "))}</small>
      </div>
      ${uiBadge("ok", "enabled")}
    </div>
    <div class="metrics-grid">
      ${metricCard("CPU", `${formatNumber(sample.cpu?.percent)}%`, progressBar(sample.cpu?.percent))}
      ${metricCard("Memory", `${formatNumber(sample.memory?.percent)}%`, progressBar(sample.memory?.percent))}
      ${metricCard("Disk", disk ? `${formatNumber(disk.percent)}%` : "-", disk ? `${progressBar(disk.percent)}<small>${escapeHtml(disk.mount || "")}</small>` : "")}
      ${metricCard("Network", `${formatBytes(network?.rxBytesPerSec || 0)}/s down`, `<small>${formatBytes(network?.txBytesPerSec || 0)}/s up</small>`)}
    </div>
    <div class="stack">
      ${renderLineChart("CPU and memory - " + range, history.points || [], [
        { key: "cpuPercent", label: "CPU", color: "#1d8a5b", max: 100 },
        { key: "memoryPercent", label: "Memory", color: "#f2c94c", max: 100 },
      ], "%")}
      ${renderDiskCharts(history.disks || [])}
      ${renderNetworkCharts(history.network || [])}
    </div>
    <div class="data-table-wrap">
      <table class="data-table" style="--table-min-width:640px">
        <thead><tr><th>Metric</th><th>Value</th><th>Detail</th></tr></thead>
        <tbody>
          <tr><td>Samples</td><td>${escapeHtml(summary.samples ?? 0)}</td><td>${escapeHtml(formatTimeRange(history.fromMs, history.toMs))}</td></tr>
          <tr><td>CPU range</td><td>${escapeHtml(formatNumber(summary.cpu?.min))}% - ${escapeHtml(formatNumber(summary.cpu?.max))}%</td><td>avg ${escapeHtml(formatNumber(summary.cpu?.avg))}%</td></tr>
          <tr><td>Memory range</td><td>${escapeHtml(formatNumber(summary.memory?.min))}% - ${escapeHtml(formatNumber(summary.memory?.max))}%</td><td>avg ${escapeHtml(formatNumber(summary.memory?.avg))}%</td></tr>
          <tr><td>Storage</td><td>${escapeHtml(formatBytes(storage.sizeBytes || 0))}</td><td>${escapeHtml(storage.samples || 0)} samples retained ${escapeHtml(storage.retentionDays || "")}d</td></tr>
        </tbody>
      </table>
    </div>
    <small>Last sample ${escapeHtml(sample.timestamp || "")}</small>
  </section>`;
}

function renderDiskCharts(disks) {
  if (!Array.isArray(disks) || !disks.length) return "";
  return disks.slice(0, 2).map((disk) => renderLineChart(`Disk ${disk.mount || disk.filesystem || ""}`, disk.points || [], [
    { key: "percent", label: "Used", color: "#9b1c1c", max: 100 },
  ], "%")).join("");
}

function renderNetworkCharts(network) {
  if (!Array.isArray(network) || !network.length) return "";
  return network.slice(0, 2).map((item) => renderLineChart(`Network ${item.name || ""}`, item.points || [], [
    { key: "rxBytesPerSec", label: "Down", color: "#1d8a5b" },
    { key: "txBytesPerSec", label: "Up", color: "#235c42" },
  ], "B/s", (value) => `${formatBytes(value)}/s`)).join("");
}

function renderLineChart(title, points, series, unit = "", formatter = (value) => `${formatNumber(value)}${unit}`) {
  const width = 760;
  const height = 180;
  const pad = { left: 42, right: 14, top: 24, bottom: 28 };
  const rows = Array.isArray(points) ? points.filter((point) => Number.isFinite(Number(point.timestamp))) : [];
  if (!rows.length) {
    return `<div class="panel"><h3>${escapeHtml(title)}</h3><div class="empty-state">No history for this range.</div></div>`;
  }
  const minTs = Math.min(...rows.map((point) => Number(point.timestamp)));
  const maxTs = Math.max(...rows.map((point) => Number(point.timestamp)));
  const values = rows.flatMap((point) => series.map((line) => Number(point[line.key]) || 0));
  const configuredMax = Math.max(...series.map((line) => Number(line.max) || 0));
  const maxValue = Math.max(configuredMax, ...values, 1);
  const x = (timestamp) => pad.left + ((Number(timestamp) - minTs) / Math.max(1, maxTs - minTs)) * (width - pad.left - pad.right);
  const y = (value) => pad.top + (1 - (Number(value) || 0) / maxValue) * (height - pad.top - pad.bottom);
  const paths = series.map((line) => {
    const d = rows.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.timestamp).toFixed(1)},${y(point[line.key]).toFixed(1)}`).join(" ");
    return `<path d="${escapeHtml(d)}" fill="none" stroke="${escapeHtml(line.color)}" stroke-width="2.2" vector-effect="non-scaling-stroke"><title>${escapeHtml(line.label)}</title></path>`;
  }).join("");
  const hitAreas = rows.map((point, index) => {
    const currentX = x(point.timestamp);
    const previousX = index > 0 ? x(rows[index - 1].timestamp) : pad.left;
    const nextX = index < rows.length - 1 ? x(rows[index + 1].timestamp) : width - pad.right;
    const left = index > 0 ? (previousX + currentX) / 2 : pad.left;
    const right = index < rows.length - 1 ? (currentX + nextX) / 2 : width - pad.right;
    return `<rect class="chart-hit" x="${left.toFixed(1)}" y="${pad.top}" width="${Math.max(2, right - left).toFixed(1)}" height="${height - pad.top - pad.bottom}" fill="transparent" pointer-events="all"><title>${escapeHtml(chartTooltip(point, series, formatter))}</title></rect>`;
  }).join("");
  const legend = series.map((line) => `<span class="chip"><span style="display:inline-block;width:9px;height:9px;border-radius:999px;background:${escapeHtml(line.color)}"></span>${escapeHtml(line.label)}</span>`).join("");
  const latest = rows.at(-1) || {};
  const latestText = series.map((line) => `${line.label}: ${formatter(Number(latest[line.key]) || 0)}`).join(" | ");
  return `<div class="panel">
    <div class="section-header"><h3>${escapeHtml(title)}</h3><small>${escapeHtml(latestText)}</small></div>
    <svg role="img" aria-label="${escapeHtml(title)} chart" viewBox="0 0 ${width} ${height}" width="100%" height="180" preserveAspectRatio="none">
      <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
      <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" stroke="currentColor" opacity="0.18"></line>
      <line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" stroke="currentColor" opacity="0.18"></line>
      <text x="4" y="${pad.top + 4}" fill="currentColor" opacity="0.55" font-size="11">${escapeHtml(formatter(maxValue))}</text>
      <text x="4" y="${height - pad.bottom}" fill="currentColor" opacity="0.55" font-size="11">0</text>
      ${paths}
      ${hitAreas}
    </svg>
    <div class="row">${legend}</div>
    <small class="chart-tooltip-note">Hover the chart for exact values.</small>
  </div>`;
}

function chartTooltip(point, series, formatter) {
  const lines = [new Date(Number(point.timestamp)).toLocaleString()];
  for (const line of series) {
    lines.push(`${line.label}: ${formatter(Number(point[line.key]) || 0)}`);
  }
  return lines.join("\n");
}

function metricCard(label, value, body = "") {
  return `<div class="metric"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${escapeHtml(value)}</div>${body}</div>`;
}

function metricRow(label, value, suffix) {
  const number = Number(value) || 0;
  return `<div class="metric-row"><span>${escapeHtml(label)}</span><span><span class="metric-kv-number">${number.toFixed(1)}${escapeHtml(suffix)}</span>${progressBar(number)}</span></div>`;
}

function progressBar(value) {
  const number = Number(value) || 0;
  const cls = number >= 90 ? "error" : number >= 75 ? "warn" : "";
  const width = Math.max(0, Math.min(100, number));
  return `<div class="progress"><span class="progress-fill ${cls}" style="width:${width}%"></span></div>`;
}

function panelScript() {
  return `<script>
(function(){
  var root=document.currentScript.closest('[data-system-monitor]');
  if(!root)return;
  function input(range){return {range:range||root.dataset.range||'${DEFAULT_RANGE}',maxPoints:Number(root.dataset.maxPoints)||240};}
  root.querySelectorAll('[data-range-button]').forEach(function(button){
    button.addEventListener('click',function(){window.NordRelayPanel&&window.NordRelayPanel.reload&&window.NordRelayPanel.reload(input(button.dataset.rangeButton));});
  });
  var timer=null;
  var checkbox=root.querySelector('[data-auto-refresh]');
  function stop(){if(timer){clearInterval(timer);timer=null;}}
  function start(){stop();timer=setInterval(function(){if(document.visibilityState==='visible'&&window.NordRelayPanel&&window.NordRelayPanel.reload)window.NordRelayPanel.reload(input(root.dataset.range));},10000);}
  if(checkbox)checkbox.addEventListener('change',function(){checkbox.checked?start():stop();});
  window.addEventListener('pagehide',stop);
  if(window.NordRelayPanel&&window.NordRelayPanel.ready)window.NordRelayPanel.ready();
})();</script>`;
}

function normalizeSettings(settings = {}) {
  return {
    sampleIntervalMs: numberInput(settings.sampleIntervalMs, 5000),
    retentionDays: numberInput(settings.retentionDays, 30),
    maxChartPoints: numberInput(settings.maxChartPoints, 240),
    cleanupIntervalMinutes: numberInput(settings.cleanupIntervalMinutes, 30),
    autoRefreshMs: numberInput(settings.autoRefreshMs, 10000),
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

function integerOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function roundNumber(value) {
  const parsed = Number(value) || 0;
  return Math.round(parsed * 100) / 100;
}

function formatNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "0";
  return parsed.toFixed(1).replace(/\.0$/, "");
}

function formatBytes(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number < 1024) return `${Math.round(number)} B`;
  if (number < 1024 * 1024) return `${(number / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  if (number < 1024 * 1024 * 1024) return `${(number / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
  return `${(number / 1024 / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} GB`;
}

function formatTimeRange(fromMs, toMs) {
  if (!fromMs || !toMs) return "-";
  return `${new Date(Number(fromMs)).toLocaleString()} - ${new Date(Number(toMs)).toLocaleString()}`;
}

function uiBadge(text, status = "disabled") {
  return `<span class="badge ${escapeHtml(status)}">${escapeHtml(text)}</span>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

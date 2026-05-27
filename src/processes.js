import { spawnSync } from "node:child_process";
import path from "node:path";

const AGENT_EXECUTABLES = new Set(["codex", "claude", "claude-code", "openclaw", "hermes", "pi"]);

export function collectProcesses(platformName, limit = 10) {
  const max = Math.max(1, Math.min(50, Math.round(Number(limit) || 10)));
  if (platformName === "win32") {
    return parseWindowsProcessOutput(run("powershell.exe", ["-NoProfile", "-Command", "Get-Process | Select-Object Id,ProcessName,CPU,WorkingSet64,Path | Sort-Object CPU -Descending | Select-Object -First 50 | ConvertTo-Json -Compress"]), max);
  }
  return parsePsOutput(run("ps", ["-axo", "pid,ppid,pcpu,pmem,rss,comm,args"]), max);
}

export function parsePsOutput(output, limit = 10) {
  const rows = String(output || "").split(/\r?\n/).slice(1).map((line) => {
    const trimmed = line.trim();
    const withParent = trimmed.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    const withoutParent = withParent ? null : trimmed.match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    const match = withParent || withoutParent;
    if (!match) return null;
    const pid = Number(match[1]) || 0;
    const ppid = withParent ? Number(match[2]) || 0 : 0;
    const cpuIndex = withParent ? 3 : 2;
    const memoryIndex = withParent ? 4 : 3;
    const rssIndex = withParent ? 5 : 4;
    const nameIndex = withParent ? 6 : 5;
    const commandIndex = withParent ? 7 : 6;
    const command = match[commandIndex] || match[nameIndex] || "";
    const name = path.basename(match[nameIndex] || command || "process");
    const directAgent = isDirectAgentProcess(name, command);
    return {
      pid,
      ppid,
      cpuPercent: roundPercent(Number(match[cpuIndex]) || 0),
      memoryPercent: roundPercent(Number(match[memoryIndex]) || 0),
      rssBytes: (Number(match[rssIndex]) || 0) * 1024,
      name,
      command: command.slice(0, 180),
      processType: directAgent ? "agent" : "system",
      agent: directAgent,
    };
  }).filter(Boolean);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  for (const row of rows) {
    if (row.agent) continue;
    if (hasAgentAncestor(row, byPid)) {
      row.processType = "agent-child";
      row.agent = true;
    }
  }
  return rows.sort((a, b) => processScore(b) - processScore(a)).slice(0, limit);
}

export function parseWindowsProcessOutput(output, limit = 10) {
  try {
    const parsed = JSON.parse(String(output || "[]"));
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => {
      const command = String(row.Path || row.ProcessName || "");
      const directAgent = isDirectAgentProcess(row.ProcessName, command);
      return {
        pid: Number(row.Id) || 0,
        ppid: 0,
        cpuPercent: 0,
        memoryPercent: 0,
        rssBytes: Number(row.WorkingSet64) || 0,
        name: String(row.ProcessName || "process"),
        command: command.slice(0, 180),
        processType: directAgent ? "agent" : "system",
        agent: directAgent,
      };
    }).sort((a, b) => processScore(b) - processScore(a)).slice(0, limit);
  } catch {
    return [];
  }
}

function processScore(row) {
  const typeScore = row.processType === "agent" ? 2000 : row.processType === "agent-child" ? 1000 : 0;
  return typeScore + row.cpuPercent + row.memoryPercent + Number(row.rssBytes || 0) / 1024 / 1024 / 1024;
}

function hasAgentAncestor(row, byPid) {
  const seen = new Set();
  let current = byPid.get(row.ppid);
  while (current && !seen.has(current.pid)) {
    if (current.processType === "agent") return true;
    seen.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return false;
}

function isDirectAgentProcess(name, command) {
  const executable = normalizeExecutable(name || firstCommandToken(command));
  return AGENT_EXECUTABLES.has(executable);
}

function firstCommandToken(command) {
  const [token = ""] = String(command || "").trim().split(/\s+/);
  return token;
}

function normalizeExecutable(value) {
  return path.basename(String(value || "").replace(/\\/g, "/")).replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 2000, windowsHide: true });
  return result.status === 0 ? result.stdout : "";
}

function roundPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

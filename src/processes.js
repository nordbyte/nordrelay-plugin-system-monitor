import { spawnSync } from "node:child_process";
import path from "node:path";

const AGENT_PROCESS_PATTERN = /\b(codex|claude|claude-code|openclaw|hermes|pi)\b/i;

export function collectProcesses(platformName, limit = 10) {
  const max = Math.max(1, Math.min(50, Math.round(Number(limit) || 10)));
  if (platformName === "win32") {
    return parseWindowsProcessOutput(run("powershell.exe", ["-NoProfile", "-Command", "Get-Process | Select-Object Id,ProcessName,CPU,WorkingSet64,Path | Sort-Object CPU -Descending | Select-Object -First 50 | ConvertTo-Json -Compress"]), max);
  }
  return parsePsOutput(run("ps", ["-axo", "pid,pcpu,pmem,rss,comm,args"]), max);
}

export function parsePsOutput(output, limit = 10) {
  const rows = String(output || "").split(/\r?\n/).slice(1).map((line) => {
    const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) return null;
    const command = match[6] || match[5] || "";
    return {
      pid: Number(match[1]) || 0,
      cpuPercent: roundPercent(Number(match[2]) || 0),
      memoryPercent: roundPercent(Number(match[3]) || 0),
      rssBytes: (Number(match[4]) || 0) * 1024,
      name: path.basename(match[5] || command || "process"),
      command: command.slice(0, 180),
      agent: AGENT_PROCESS_PATTERN.test(command) || AGENT_PROCESS_PATTERN.test(match[5] || ""),
    };
  }).filter(Boolean);
  return rows.sort((a, b) => (b.agent ? 1000 : 0) + b.cpuPercent + b.memoryPercent - ((a.agent ? 1000 : 0) + a.cpuPercent + a.memoryPercent)).slice(0, limit);
}

export function parseWindowsProcessOutput(output, limit = 10) {
  try {
    const parsed = JSON.parse(String(output || "[]"));
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => {
      const command = String(row.Path || row.ProcessName || "");
      return {
        pid: Number(row.Id) || 0,
        cpuPercent: 0,
        memoryPercent: 0,
        rssBytes: Number(row.WorkingSet64) || 0,
        name: String(row.ProcessName || "process"),
        command: command.slice(0, 180),
        agent: AGENT_PROCESS_PATTERN.test(command),
      };
    }).sort((a, b) => Number(b.rssBytes) - Number(a.rssBytes)).slice(0, limit);
  } catch {
    return [];
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 2000, windowsHide: true });
  return result.status === 0 ? result.stdout : "";
}

function roundPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

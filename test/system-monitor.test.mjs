import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMMANDS,
  parseDf,
  parseDfInodes,
  parseDarwinBattery,
  parseDarwinIostatOutput,
  parseDarwinSwapUsage,
  parseNetstatIb,
  parseProcDiskStats,
  parseProcMeminfo,
  parseProcNetDev,
  parseProcNetSnmp,
  parseProcPressureMemory,
  parseProcStat,
  parseProcVmstat,
  parsePsOutput,
  parseWindowsBatteryOutput,
  parseWindowsDiskOutput,
  parseWindowsDiskIoOutput,
  parseWindowsNetworkOutput,
  parseWindowsProcessOutput,
  parseWindowsSwapOutput,
} from "../index.js";

function assertPluginSucceeded(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
}

function pluginRoot() {
  return path.resolve(fileURLToPath(new URL("..", import.meta.url)));
}

function invokePlugin(payload) {
  const result = spawnSync(process.execPath, ["index.js"], {
    cwd: pluginRoot(),
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  assertPluginSucceeded(result);
  assert.notEqual(result.stdout.trim(), "", result.stderr || "Plugin process produced no JSON output");
  return JSON.parse(result.stdout);
}

function testSettings(settings = {}) {
  return {
    trackDisks: false,
    trackDiskIo: false,
    trackInodes: false,
    trackNetworkInterfaces: false,
    trackThermals: false,
    trackBattery: false,
    ...settings,
  };
}

test("parses df -kP output and filters pseudo filesystems", () => {
  const disks = parseDf(`Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/sda1 1000 250 750 25% /
tmpfs 2000 100 1900 5% /run
squashfs 1000 1000 0 100% /snap/core
Nextcloud.AppImage 1000 1000 0 100% /tmp/.mount_NextclABC
`);
  assert.equal(disks.length, 1);
  assert.equal(disks[0].mount, "/");
  assert.equal(disks[0].totalBytes, 1024000);
  assert.equal(disks[0].percent, 25);
});

test("parses inode usage", () => {
  const disks = parseDfInodes(`Filesystem Inodes IUsed IFree IUse% Mounted on
/dev/sda1 1000 200 800 20% /
tmpfs 100 1 99 1% /run
`);
  assert.equal(disks.length, 1);
  assert.equal(disks[0].inodesPercent, 20);
});

test("parses Linux CPU, memory pressure, and disk I/O counters", () => {
  const cpu = parseProcStat(`cpu  100 10 40 850 20 1 2 3 0 0
cpu0 50 5 20 425 10 1 1 1 0 0
cpu1 50 5 20 425 10 0 1 2 0 0
`);
  assert.equal(cpu.cores.length, 2);
  assert.equal(cpu.iowait, 20);

  const mem = parseProcMeminfo(`MemTotal:       1000 kB
MemFree:         200 kB
MemAvailable:    600 kB
SwapTotal:       500 kB
SwapFree:        300 kB
`);
  assert.equal(mem.usedBytes, 400 * 1024);
  assert.equal(mem.swapUsedBytes, 200 * 1024);

  const pressure = parseProcPressureMemory(`some avg10=0.10 avg60=0.20 avg300=0.30 total=123
full avg10=0.01 avg60=0.02 avg300=0.03 total=12
`);
  assert.equal(pressure.some.avg10, 0.1);
  assert.equal(pressure.full.avg300, 0.03);

  const vmstat = parseProcVmstat("pgfault 100\npgmajfault 2\n");
  assert.equal(vmstat.pgfault, 100);

  const disks = parseProcDiskStats("8 0 sda 10 0 100 20 5 0 50 10 0 30 40 0 0 0 0 0 0\n", new Set(["sda"]));
  assert.equal(disks[0].readBytes, 51200);
  assert.equal(disks[0].ioTimeMs, 30);
});

test("parses Linux /proc/net/dev output", () => {
  const interfaces = parseProcNetDev(`Inter-| Receive | Transmit
 face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed
 eth0: 1000 1 2 3 0 0 0 0 2000 1 4 5 0 0 0 0
 lo: 1 1 0 0 0 0 0 0 2 1 0 0 0 0 0 0
`);
  assert.deepEqual(interfaces, [{ name: "eth0", rxBytes: 1000, rxErrors: 2, rxDropped: 3, txBytes: 2000, txErrors: 4, txDropped: 5 }]);
  const snmp = parseProcNetSnmp(`Tcp: RtoAlgorithm RtoMin RtoMax MaxConn ActiveOpens PassiveOpens AttemptFails EstabResets CurrEstab InSegs OutSegs RetransSegs
Tcp: 1 200 120000 -1 1 2 3 4 5 6 7 8
`);
  assert.equal(snmp.tcpRetransmits, 8);
});

test("parses Windows counters", () => {
  const disks = parseWindowsDiskOutput(JSON.stringify({ DeviceID: "C:", Size: "1000", FreeSpace: "250" }));
  assert.equal(disks[0].mount, "C:");
  assert.equal(disks[0].percent, 75);
  const diskIo = parseWindowsDiskIoOutput(JSON.stringify({ Name: "C:", DiskReadBytesPersec: "10", DiskWriteBytesPersec: "20", DiskReadsPersec: "1", DiskWritesPersec: "2", PercentDiskTime: "3" }));
  assert.equal(diskIo[0].writeBytesPerSec, 20);
  const network = parseWindowsNetworkOutput(JSON.stringify({ Name: "Ethernet", ReceivedBytes: "10", SentBytes: "20", ReceivedPacketErrors: "1", OutboundPacketErrors: "2" }));
  assert.deepEqual(network, [{ name: "Ethernet", rxBytes: 10, txBytes: 20, rxErrors: 1, txErrors: 2, rxDropped: 0, txDropped: 0 }]);
  const swap = parseWindowsSwapOutput(JSON.stringify({ TotalVirtualMemorySize: 2000, FreeVirtualMemory: 500, TotalVisibleMemorySize: 1000, FreePhysicalMemory: 250 }));
  assert.equal(swap.swapTotalBytes, 1000 * 1024);
  assert.equal(swap.swapUsedBytes, 750 * 1024);
  const battery = parseWindowsBatteryOutput(JSON.stringify({ EstimatedChargeRemaining: 73, BatteryStatus: 2 }));
  assert.equal(battery.percent, 73);
  assert.equal(battery.status, "AC");
});

test("parses macOS counters", () => {
  const swap = parseDarwinSwapUsage("total = 4096.00M  used = 1024.00M  free = 3072.00M  (encrypted)");
  assert.equal(swap.swapTotalBytes, 4096 * 1024 ** 2);
  assert.equal(swap.swapUsedBytes, 1024 * 1024 ** 2);

  const battery = parseDarwinBattery(`Now drawing from 'AC Power'
 -InternalBattery-0 (id=1234567) 85%; charging; 2:01 remaining present: true`);
  assert.equal(battery.percent, 85);
  assert.equal(battery.status, "Charging");

  const diskIo = parseDarwinIostatOutput(`          disk0           disk1
KB/t xfrs MB/s KB/t xfrs MB/s
4.00 10 0.04 8.00 20 0.16
`);
  assert.equal(diskIo[0].name, "disk0");
  assert.equal(diskIo[0].writeBytesPerSec, 41943.04);

  const network = parseNetstatIb(`Name  Mtu Network Address Ipkts Ierrs Idrop Ibytes Opkts Oerrs Obytes Coll
en0 1500 <Link#4> aa:bb 1 2 1000 20 0 2000 0 3
lo0 16384 <Link#1> lo0 1 0 0 1 1 0 1 0
`);
  assert.deepEqual(network, [{ name: "en0", rxBytes: 1000, txBytes: 2000, rxErrors: 1, txErrors: 3, rxDropped: 0, txDropped: 0 }]);
});

test("parses top processes and marks coding agents", () => {
  const rows = parsePsOutput(`  PID  PPID %CPU %MEM   RSS COMM             COMMAND
  100     1 12.5  1.5 10000 node             node /tmp/.openclaw/browser.js
  101     1  2.0  0.5  8000 codex            codex exec prompt
  102   101  1.0  0.2  3000 bash             bash tool.sh
`);
  assert.equal(rows[0].agent, true);
  assert.equal(rows[0].name, "codex");
  assert.equal(rows[0].processType, "agent");
  assert.equal(rows[0].rssBytes, 8000 * 1024);
  assert.equal(rows[1].processType, "agent-child");
  assert.equal(rows[2].agent, false);

  const windows = parseWindowsProcessOutput(JSON.stringify([{ Id: 10, ProcessName: "claude", WorkingSet64: 1024, Path: "C:\\\\Tools\\\\claude.exe" }]));
  assert.equal(windows[0].agent, true);
  assert.equal(windows[0].processType, "agent");
  assert.equal(windows[0].rssBytes, 1024);
});

test("collects a sample through the NordRelay plugin request contract", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "nordrelay-system-monitor-"));
  const payload = {
    protocolVersion: 1,
    type: "command",
    pluginId: "system-monitor",
    command: "sample",
    input: {},
    settings: testSettings(),
    dataDir,
    permissions: ["system.metrics.read"],
    context: { runtime: { nodeName: "test-node", platform: process.platform } },
  };
  const parsed = invokePlugin(payload);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.output.sample.node.name, "test-node");
  assert.equal(typeof parsed.output.sample.memory.percent, "number");
  assert.equal(existsSync(path.join(dataDir, "metrics.sqlite")), true);
  assert.equal(existsSync(path.join(dataDir, "samples.jsonl")), false);
});

test("returns chart-ready panel data from SQLite history", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "nordrelay-system-monitor-"));
  const basePayload = {
    protocolVersion: 1,
    type: "command",
    pluginId: "system-monitor",
    command: "sample",
    input: {},
    settings: testSettings(),
    dataDir,
    permissions: ["system.metrics.read"],
    context: { runtime: { nodeName: "test-node", platform: process.platform } },
  };
  for (let index = 0; index < 3; index += 1) {
    invokePlugin(basePayload);
  }
  const parsed = invokePlugin({ ...basePayload, command: "panel-data", input: { range: "1h", maxPoints: 20 } });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.output.panelData.current.node.name, "test-node");
  assert.ok(parsed.output.panelData.history.points.length >= 1);
  assert.ok(parsed.output.panelData.storage.samples >= 3);
  assert.ok(parsed.output.panelData.storage.rollupRows >= 1);
  assert.ok(parsed.output.panelData.storage.diskRollupRows >= 0);
  assert.ok(Array.isArray(parsed.output.panelData.alerts.events));
  assert.ok(Array.isArray(parsed.output.panelData.current.collectors));
  assert.ok(Array.isArray(parsed.output.panelData.current.processes));
  assert.ok(typeof parsed.output.panelData.current.cpu.breakdown.user === "number");
  assert.ok(typeof parsed.output.panelData.current.memory.swapPercent === "number");
  assert.ok(Array.isArray(parsed.output.panelData.history.diskIo));
  assert.ok(parsed.output.panelData.storage.rollupRows >= 1);

  const exported = invokePlugin({ ...basePayload, command: "export", input: { format: "csv", range: "1h", maxPoints: 20 } });
  assert.equal(exported.ok, true);
  assert.equal(exported.output.format, "csv");
  assert.match(exported.output.data, /timestamp,cpu_percent,memory_percent,swap_percent/);
});

test("stores alert history and collector diagnostics", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "nordrelay-system-monitor-"));
  const payload = {
    protocolVersion: 1,
    type: "command",
    pluginId: "system-monitor",
    command: "sample",
    input: {},
    settings: testSettings({ thresholdMemoryPercent: 1, trackProcesses: true, maxProcesses: 3 }),
    dataDir,
    permissions: ["system.metrics.read"],
    context: { runtime: { nodeName: "alert-node", platform: process.platform } },
  };
  const sample = invokePlugin(payload).output.sample;
  assert.ok(sample.alerts.some((alert) => alert.label === "Memory"));
  assert.ok(sample.collectors.some((collector) => collector.name === "memory" && collector.ok));
  assert.ok(Array.isArray(sample.processes));

  const alerts = invokePlugin({ ...payload, command: "alerts", input: { range: "24h" } }).output.alerts.events;
  assert.ok(alerts.some((alert) => alert.label === "Memory"));
});

test("handles notifications, acknowledgement, JSONL export, and storage maintenance commands", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "nordrelay-system-monitor-"));
  const payload = {
    protocolVersion: 1,
    type: "command",
    pluginId: "system-monitor",
    command: "sample",
    input: {},
    settings: testSettings({ thresholdMemoryPercent: 1, alertCooldownMinutes: 0 }),
    dataDir,
    permissions: ["system.metrics.read"],
    context: { runtime: { nodeId: "node-a", nodeName: "alert-node", platform: process.platform } },
  };

  const sample = invokePlugin(payload).output.sample;
  assert.ok(sample.notifications.some((item) => item.label === "Memory"));

  const notifications = invokePlugin({ ...payload, command: "notifications", input: { range: "24h", includeDelivered: false } }).output.notifications.events;
  assert.ok(notifications.some((item) => item.label === "Memory" && item.delivered === false));

  const delivered = invokePlugin({ ...payload, command: "notifications", input: { range: "24h", markDelivered: true } }).output.notifications.events;
  assert.ok(delivered.length >= 1);
  const pending = invokePlugin({ ...payload, command: "notifications", input: { range: "24h" } }).output.notifications.events;
  assert.equal(pending.length, 0);

  const ack = invokePlugin({ ...payload, command: "ack-alert", input: { label: "Memory", nodeId: "node-a", untilMinutes: 30 } }).output.acknowledgement;
  assert.equal(ack.label, "Memory");
  const acknowledgedSample = invokePlugin(payload).output.sample;
  assert.equal(acknowledgedSample.alerts.some((alert) => alert.label === "Memory"), false);

  const jsonl = invokePlugin({ ...payload, command: "export", input: { format: "jsonl", range: "24h", maxPoints: 10, includeAlerts: true, includeNotifications: true } }).output;
  assert.equal(jsonl.format, "jsonl");
  assert.match(jsonl.data, /"timestamp"/);

  const storageHealth = invokePlugin({ ...payload, command: "storage-health", input: {} }).output;
  assert.equal(storageHealth.health.integrity, "ok");
  assert.equal(storageHealth.storage.health.integrity, "ok");

  const checkpoint = invokePlugin({ ...payload, command: "checkpoint", input: { mode: "TRUNCATE" } }).output;
  assert.ok(Array.isArray(checkpoint.checkpoint));

  const rebuilt = invokePlugin({ ...payload, command: "rebuild-rollups", input: {} }).output.rebuilt;
  assert.ok(rebuilt.samples >= 1);
});

test("silences configured alert labels", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "nordrelay-system-monitor-"));
  const payload = {
    protocolVersion: 1,
    type: "command",
    pluginId: "system-monitor",
    command: "sample",
    input: {},
    settings: testSettings({ thresholdMemoryPercent: 1, silencedAlertLabels: "Memory" }),
    dataDir,
    permissions: ["system.metrics.read"],
    context: { runtime: { nodeName: "silent-node", platform: process.platform } },
  };
  const sample = invokePlugin(payload).output.sample;
  assert.equal(sample.alerts.some((alert) => alert.label === "Memory"), false);
});

test("migrates an existing v1 SQLite database in place", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "nordrelay-system-monitor-"));
  const dbPath = path.join(dataDir, "metrics.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE samples (
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
    CREATE TABLE disks (
      sample_id INTEGER NOT NULL,
      mount TEXT NOT NULL,
      filesystem TEXT,
      percent REAL,
      used_bytes INTEGER,
      available_bytes INTEGER,
      total_bytes INTEGER,
      PRIMARY KEY(sample_id, mount, filesystem)
    );
    CREATE TABLE network (
      sample_id INTEGER NOT NULL,
      interface TEXT NOT NULL,
      rx_bps REAL,
      tx_bps REAL,
      rx_bytes INTEGER,
      tx_bytes INTEGER,
      PRIMARY KEY(sample_id, interface)
    );
  `);
  db.close();
  const payload = {
    protocolVersion: 1,
    type: "command",
    pluginId: "system-monitor",
    command: "sample",
    input: {},
    settings: testSettings(),
    dataDir,
    permissions: ["system.metrics.read"],
    context: { runtime: { nodeName: "test-node", platform: process.platform } },
  };
  const parsed = invokePlugin(payload);
  assert.equal(parsed.ok, true);
  const migrated = new DatabaseSync(dbPath);
  const sampleColumns = migrated.prepare("PRAGMA table_info(samples)").all().map((row) => row.name);
  const tables = migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  migrated.close();
  assert.ok(sampleColumns.includes("swap_percent"));
  assert.ok(tables.includes("rollups"));
});

test("manifest command catalog matches runtime command catalog", () => {
  const manifest = JSON.parse(readFileSync(path.join(pluginRoot(), "nordrelay.plugin.json"), "utf8"));
  const manifestCommands = manifest.capabilities.commands.map((command) => command.name).sort();
  assert.deepEqual(manifestCommands, [...COMMANDS].sort());
  assert.equal(manifest.entry, "index.js");
  assert.ok(manifest.settings.some((setting) => setting.key === "diskSampleIntervalMs"));
  assert.ok(manifest.settings.some((setting) => setting.key === "alertCooldownMinutes"));
});

test("can run an optional NordRelay plugin-host smoke", { skip: process.env.NORDRELAY_PLUGIN_HOST_SMOKE !== "1" }, () => {
  const result = spawnSync("nordrelay", ["plugin", "invoke", "system-monitor", "command", "status"], {
    cwd: pluginRoot(),
    encoding: "utf8",
    timeout: 10000,
  });
  assertPluginSucceeded(result);
});

test("renders the web panel with NordRelay shared plugin UI classes", async () => {
  const payload = {
    protocolVersion: 1,
    type: "web-panel",
    pluginId: "system-monitor",
    panelId: "dashboard",
    input: {
      autoRefresh: true,
      autoRefreshMs: 15000,
      rangeMs: 90 * 60 * 1000,
      aggregate: {
        results: [{
          node: { name: "test-node", platform: "linux" },
          ok: true,
          result: {
            output: {
              panelData: {
                current: {
                  timestamp: "2026-05-26T08:00:00.000Z",
                  timestampMs: Date.parse("2026-05-26T08:00:00.000Z"),
                  node: { name: "test-node", platform: "linux", hostname: "test" },
                  cpu: { percent: 12.5, load1: 0.12, load5: 0.34, load15: 0.56, breakdown: { user: 4, system: 2, iowait: 1, idle: 93 }, perCore: [{ index: 0, percent: 15 }] },
                  memory: { percent: 50, usedBytes: 8 * 1024 ** 3, freeBytes: 8 * 1024 ** 3, availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, swapPercent: 10, swapUsedBytes: 1 * 1024 ** 3, swapFreeBytes: 9 * 1024 ** 3, swapTotalBytes: 10 * 1024 ** 3, pressure: { some: { avg10: 0.1 }, full: { avg10: 0.01 } }, pageFaultsPerSec: 12, majorPageFaultsPerSec: 0.2 },
                  disk: [{ mount: "/", percent: 60, usedBytes: 120 * 1024 ** 3, availableBytes: 80 * 1024 ** 3, totalBytes: 200 * 1024 ** 3, inodesPercent: 40, inodesAvailable: 600, inodesTotal: 1000 }],
                  diskIo: [{ name: "sda", readBytesPerSec: 4096, writeBytesPerSec: 8192, busyPercent: 12, readIops: 1, writeIops: 2 }],
                  network: [{ rxBytesPerSec: 1024, txBytesPerSec: 2048, rxErrors: 1, txErrors: 0, rxDropped: 2, txDropped: 0 }],
                  networkHealth: { errors: 1, drops: 2, tcpRetransmitsPerSec: 0.1 },
                  environment: { thermal: [{ label: "cpu", celsius: 45 }], battery: { percent: 80, status: "Charging" } },
                  alerts: [{ level: "warning", label: "Disk", value: 90, threshold: 90, unit: "%" }],
                  collectors: [{ name: "cpu", ok: true, durationMs: 2, failures: 0 }],
                  processes: [{ pid: 123, name: "codex", command: "codex exec", cpuPercent: 5, rssBytes: 1024, agent: true }],
                },
                history: {
                  fromMs: Date.parse("2026-05-26T07:00:00.000Z"),
                  toMs: Date.parse("2026-05-26T08:00:00.000Z"),
                  points: [
                    { timestamp: Date.parse("2026-05-26T07:00:00.000Z"), cpuPercent: 10, memoryPercent: 30, swapPercent: 5, cpuSystemPercent: 2, cpuIowaitPercent: 1, cpuStealPercent: 0, diskReadBytesPerSec: 100, diskWriteBytesPerSec: 200, rxBytesPerSec: 300, txBytesPerSec: 400 },
                    { timestamp: Date.parse("2026-05-26T08:00:00.000Z"), cpuPercent: 12.5, memoryPercent: 34.5, swapPercent: 10, cpuSystemPercent: 4, cpuIowaitPercent: 2, cpuStealPercent: 0, diskReadBytesPerSec: 200, diskWriteBytesPerSec: 300, rxBytesPerSec: 400, txBytesPerSec: 500 },
                  ],
                  disks: [{ mount: "/", points: [
                    { timestamp: Date.parse("2026-05-26T07:00:00.000Z"), percent: 55 },
                    { timestamp: Date.parse("2026-05-26T08:00:00.000Z"), percent: 56.5 },
                  ] }],
                  diskIo: [{ name: "sda", points: [
                    { timestamp: Date.parse("2026-05-26T07:00:00.000Z"), readBytesPerSec: 100, writeBytesPerSec: 200 },
                    { timestamp: Date.parse("2026-05-26T08:00:00.000Z"), readBytesPerSec: 200, writeBytesPerSec: 300 },
                  ] }],
                  network: [{ name: "eth0", points: [
                    { timestamp: Date.parse("2026-05-26T07:00:00.000Z"), rxBytesPerSec: 512, txBytesPerSec: 1024 },
                    { timestamp: Date.parse("2026-05-26T08:00:00.000Z"), rxBytesPerSec: 1024, txBytesPerSec: 2048 },
                  ] }],
                },
                alerts: { events: [{ timestamp: "2026-05-26T08:00:00.000Z", level: "warning", label: "Disk", value: 90, threshold: 90, unit: "%" }] },
                summary: { samples: 2, cpu: { min: 10, avg: 11.2, max: 12.5 }, cpuIowait: { avg: 1.5, max: 2 }, memory: { min: 30, avg: 32.2, max: 34.5 }, swap: { min: 5, avg: 7.5, max: 10 }, diskIo: { maxReadBytesPerSec: 4096, maxWriteBytesPerSec: 8192, maxBusyPercent: 12 } },
                storage: { samples: 2, sizeBytes: 1024, retentionDays: 30 },
              },
            },
          },
        }],
      },
    },
    settings: {},
    dataDir: "/tmp/nordrelay-system-monitor-test",
    permissions: ["system.metrics.read"],
    context: {},
  };
  const result = spawnSync(process.execPath, ["index.js"], {
    cwd: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.match(parsed.html, /class="stack"/);
  assert.match(parsed.html, /class="metrics-grid"/);
  assert.match(parsed.html, /data-range-ms="5400000"/);
  assert.match(parsed.html, /data-auto-refresh-ms="15000"/);
  assert.match(parsed.html, /class="panel"/);
  assert.match(parsed.html, /class="progress-svg/);
  assert.match(parsed.html, /aria-valuenow="10"/);
  assert.match(parsed.html, /width="10"/);
  assert.match(parsed.html, /fill="var\(--success,#1d8a5b\)"/);
  assert.match(parsed.html, /metrics-chart-stack/);
  assert.match(parsed.html, /data-auto-refresh checked/);
  assert.match(parsed.html, /data-auto-refresh-countdown/);
  assert.equal(typeof parsed.panel?.script, "string");
  assert.match(parsed.panel.script, /autoRefresh:autoRefreshEnabled\(\)/);
  assert.match(parsed.panel.script, /Math\.ceil\(remainingMs\/1000\)/);
  assert.match(parsed.panel.script, /if\(checkbox&&checkbox\.checked\)start\(\)/);
  assert.match(parsed.panel.script, /__nordrelaySystemMonitorAutoRefresh/);
  assert.match(parsed.panel.script, /nextRefreshAt=Date\.now\(\)\+refreshMs\(\)/);
  assert.match(parsed.panel.script, /isCurrentAutoRefreshInstance/);
  assert.match(parsed.html, /data-node-filter/);
  assert.match(parsed.html, /data-node-sort/);
  assert.match(parsed.html, /data-node-collapse/);
  assert.match(parsed.html, /Top process/);
  assert.match(parsed.html, /Collector diagnostics/);
  assert.match(parsed.html, /Alert history/);
  assert.match(parsed.html, /<svg role="img"/);
  assert.match(parsed.html, /data-chart-points=/);
  assert.match(parsed.html, /data-chart-hit-area/);
  assert.match(parsed.html, /data-chart-tooltip-popup/);
  assert.match(parsed.html, /class="chart-axis-label/);
  assert.match(parsed.html, /class="row chart-legend"/);
  assert.match(parsed.html, /Hover the chart for exact values/);
  assert.match(parsed.html, /CPU: 10%/);
  assert.match(parsed.html, /CPU load/);
  assert.match(parsed.html, /0\.12 \/ 0\.34 \/ 0\.56/);
  assert.match(parsed.html, /Real memory/);
  assert.match(parsed.html, /8 GB available \/ 16 GB total/);
  assert.match(parsed.html, /Local disk/);
  assert.match(parsed.html, /80 GB free \/ 200 GB total/);
  assert.match(parsed.html, /Node comparison/);
  assert.match(parsed.html, /CPU breakdown/);
  assert.match(parsed.html, /Disk I\/O/);
  assert.match(parsed.html, /Network health/);
  assert.match(parsed.html, /Pressure/);
  assert.match(parsed.html, /Swap/);
  assert.match(parsed.panel.script, /panelReload/);
  assert.match(parsed.panel.script, /data-chart-hit-area/);
  assert.doesNotMatch(parsed.html, /<script>/i);
  assert.doesNotMatch(parsed.html, /<!doctype html>/i);
  assert.doesNotMatch(parsed.html, /<style>/i);
  assert.doesNotMatch(parsed.html, /style="/i);
  assert.doesNotMatch(parsed.html, /<text /i);
});

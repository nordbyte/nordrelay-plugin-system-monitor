import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseDf,
  parseDfInodes,
  parseProcDiskStats,
  parseProcMeminfo,
  parseProcNetDev,
  parseProcNetSnmp,
  parseProcPressureMemory,
  parseProcStat,
  parseProcVmstat,
  parseWindowsDiskOutput,
  parseWindowsDiskIoOutput,
  parseWindowsNetworkOutput,
} from "../index.js";

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
});

test("collects a sample through the NordRelay plugin request contract", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "nordrelay-system-monitor-"));
  const payload = {
    protocolVersion: 1,
    type: "command",
    pluginId: "system-monitor",
    command: "sample",
    input: {},
    settings: { trackDisks: false, trackNetworkInterfaces: false },
    dataDir,
    permissions: ["system.metrics.read"],
    context: { runtime: { nodeName: "test-node", platform: process.platform } },
  };
  const result = spawnSync(process.execPath, ["index.js"], {
    cwd: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
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
    settings: { trackDisks: false, trackNetworkInterfaces: false },
    dataDir,
    permissions: ["system.metrics.read"],
    context: { runtime: { nodeName: "test-node", platform: process.platform } },
  };
  for (let index = 0; index < 3; index += 1) {
    const sampleResult = spawnSync(process.execPath, ["index.js"], {
      cwd: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
      input: JSON.stringify(basePayload),
      encoding: "utf8",
    });
    assert.equal(sampleResult.status, 0, sampleResult.stderr);
  }
  const panelResult = spawnSync(process.execPath, ["index.js"], {
    cwd: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
    input: JSON.stringify({ ...basePayload, command: "panel-data", input: { range: "1h", maxPoints: 20 } }),
    encoding: "utf8",
  });
  assert.equal(panelResult.status, 0, panelResult.stderr);
  const parsed = JSON.parse(panelResult.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.output.panelData.current.node.name, "test-node");
  assert.ok(parsed.output.panelData.history.points.length >= 1);
  assert.ok(parsed.output.panelData.storage.samples >= 3);
  assert.ok(typeof parsed.output.panelData.current.cpu.breakdown.user === "number");
  assert.ok(typeof parsed.output.panelData.current.memory.swapPercent === "number");
  assert.ok(Array.isArray(parsed.output.panelData.history.diskIo));
  assert.ok(parsed.output.panelData.storage.rollupRows >= 1);

  const exportResult = spawnSync(process.execPath, ["index.js"], {
    cwd: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
    input: JSON.stringify({ ...basePayload, command: "export", input: { format: "csv", range: "1h", maxPoints: 20 } }),
    encoding: "utf8",
  });
  assert.equal(exportResult.status, 0, exportResult.stderr);
  const exported = JSON.parse(exportResult.stdout);
  assert.equal(exported.ok, true);
  assert.equal(exported.output.format, "csv");
  assert.match(exported.output.data, /timestamp,cpu_percent,memory_percent,swap_percent/);
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
    settings: { trackDisks: false, trackNetworkInterfaces: false, trackDiskIo: false },
    dataDir,
    permissions: ["system.metrics.read"],
    context: { runtime: { nodeName: "test-node", platform: process.platform } },
  };
  const result = spawnSync(process.execPath, ["index.js"], {
    cwd: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  const migrated = new DatabaseSync(dbPath);
  const sampleColumns = migrated.prepare("PRAGMA table_info(samples)").all().map((row) => row.name);
  const tables = migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  migrated.close();
  assert.ok(sampleColumns.includes("swap_percent"));
  assert.ok(tables.includes("rollups"));
});

test("renders the web panel with NordRelay shared plugin UI classes", async () => {
  const payload = {
    protocolVersion: 1,
    type: "web-panel",
    pluginId: "system-monitor",
    panelId: "dashboard",
    input: {
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
  assert.match(parsed.html, /class="panel"/);
  assert.match(parsed.html, /class="progress"/);
  assert.match(parsed.html, /aria-valuenow="10"/);
  assert.match(parsed.html, /width:10%/);
  assert.match(parsed.html, /max-width:10%/);
  assert.match(parsed.html, /<svg role="img"/);
  assert.match(parsed.html, /class="chart-hit"/);
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
  assert.match(parsed.html, /NordRelayPanel\.reload/);
  assert.doesNotMatch(parsed.html, /<!doctype html>/i);
  assert.doesNotMatch(parsed.html, /<style>/i);
});

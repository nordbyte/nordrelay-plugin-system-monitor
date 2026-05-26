import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseDf,
  parseProcNetDev,
  parseWindowsDiskOutput,
  parseWindowsNetworkOutput,
} from "../index.js";

test("parses df -kP output", () => {
  const disks = parseDf(`Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/sda1 1000 250 750 25% /
tmpfs 2000 100 1900 5% /run
`);
  assert.equal(disks.length, 2);
  assert.equal(disks[0].mount, "/");
  assert.equal(disks[0].totalBytes, 1024000);
  assert.equal(disks[0].percent, 25);
});

test("parses Linux /proc/net/dev output", () => {
  const interfaces = parseProcNetDev(`Inter-| Receive | Transmit
 face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed
 eth0: 1000 1 0 0 0 0 0 0 2000 1 0 0 0 0 0 0
 lo: 1 1 0 0 0 0 0 0 2 1 0 0 0 0 0 0
`);
  assert.deepEqual(interfaces, [{ name: "eth0", rxBytes: 1000, txBytes: 2000 }]);
});

test("parses Windows counters", () => {
  const disks = parseWindowsDiskOutput(JSON.stringify({ DeviceID: "C:", Size: "1000", FreeSpace: "250" }));
  assert.equal(disks[0].mount, "C:");
  assert.equal(disks[0].percent, 75);
  const network = parseWindowsNetworkOutput(JSON.stringify({ Name: "Ethernet", ReceivedBytes: "10", SentBytes: "20" }));
  assert.deepEqual(network, [{ name: "Ethernet", rxBytes: 10, txBytes: 20 }]);
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
                  cpu: { percent: 12.5 },
                  memory: { percent: 34.5 },
                  disk: [{ mount: "/", percent: 56.5 }],
                  network: [{ rxBytesPerSec: 1024, txBytesPerSec: 2048 }],
                },
                history: {
                  fromMs: Date.parse("2026-05-26T07:00:00.000Z"),
                  toMs: Date.parse("2026-05-26T08:00:00.000Z"),
                  points: [
                    { timestamp: Date.parse("2026-05-26T07:00:00.000Z"), cpuPercent: 10, memoryPercent: 30 },
                    { timestamp: Date.parse("2026-05-26T08:00:00.000Z"), cpuPercent: 12.5, memoryPercent: 34.5 },
                  ],
                  disks: [{ mount: "/", points: [
                    { timestamp: Date.parse("2026-05-26T07:00:00.000Z"), percent: 55 },
                    { timestamp: Date.parse("2026-05-26T08:00:00.000Z"), percent: 56.5 },
                  ] }],
                  network: [{ name: "eth0", points: [
                    { timestamp: Date.parse("2026-05-26T07:00:00.000Z"), rxBytesPerSec: 512, txBytesPerSec: 1024 },
                    { timestamp: Date.parse("2026-05-26T08:00:00.000Z"), rxBytesPerSec: 1024, txBytesPerSec: 2048 },
                  ] }],
                },
                summary: { samples: 2, cpu: { min: 10, avg: 11.2, max: 12.5 }, memory: { min: 30, avg: 32.2, max: 34.5 } },
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
  assert.match(parsed.html, /<svg role="img"/);
  assert.match(parsed.html, /NordRelayPanel\.reload/);
  assert.doesNotMatch(parsed.html, /<!doctype html>/i);
  assert.doesNotMatch(parsed.html, /<style>/i);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
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
});

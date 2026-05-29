#!/usr/bin/env node
import { cpus, freemem, hostname, loadavg, platform, release, totalmem, uptime } from "node:os";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectCachedMetric, collectMetric } from "./collectors.js";
import { normalizeCommand } from "./commands.js";
import { rollupPeriodForRange as selectRollupPeriod } from "./history.js";
import { collectProcesses } from "./processes.js";
import { dashboardPanelScript, renderDashboardPanel } from "./render-panel.js";
import { checkpointDatabase, databaseFilesSize, databaseHealth, optimizeDatabase } from "./storage.js";

const DB_FILE = "metrics.sqlite";
const STATE_FILE = "state.json";
const SQLITE_SCHEMA_VERSION = 3;
const DEFAULT_RANGE = "1h";
const RANGE_PRESETS = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};
const ROLLUP_PERIODS = {
  "5m": 5 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};
const DEFAULT_THRESHOLDS = {
  cpuPercent: 90,
  memoryPercent: 90,
  diskPercent: 90,
  swapPercent: 75,
  iowaitPercent: 25,
  diskBusyPercent: 85,
  criticalPercent: 95,
};
const PSEUDO_FILESYSTEMS = new Set([
  "autofs",
  "binfmt_misc",
  "bpf",
  "cgroup",
  "cgroup2",
  "configfs",
  "debugfs",
  "devfs",
  "devpts",
  "devtmpfs",
  "efivarfs",
  "fusectl",
  "hugetlbfs",
  "mqueue",
  "nsfs",
  "proc",
  "pstore",
  "securityfs",
  "squashfs",
  "sysfs",
  "tmpfs",
  "tracefs",
]);
const PSEUDO_MOUNT_PREFIXES = [
  "/dev",
  "/proc",
  "/run",
  "/snap",
  "/sys",
  "/var/lib/docker",
  "/var/lib/containers",
  "/var/lib/kubelet",
];

let DatabaseSyncClass;

if (isDirectCliEntry()) {
  runPlugin().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    writeResult({ ok: false, stderr: message });
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
    const html = renderDashboardPanel(request.input, request.context, settings);
    writeResult({ ok: true, html, panel: { script: dashboardPanelScript() } });
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
  const command = normalizeCommand(request);
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
  if (command === "alerts") {
    writeResult({ ok: true, output: { alerts: readAlertHistory(db, request.input, settings) } });
    return;
  }
  if (command === "notifications") {
    writeResult({ ok: true, output: { notifications: readNotifications(db, request.input, settings) } });
    return;
  }
  if (command === "ack-alert") {
    const state = await readState(dataDir);
    const acknowledgement = await acknowledgeAlert(dataDir, state, request.input, settings);
    writeResult({ ok: true, output: { acknowledgement } });
    return;
  }
  if (command === "export") {
    writeResult({ ok: true, output: buildExport(db, request.input, settings) });
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
  if (command === "storage-health") {
    writeResult({ ok: true, output: { storage: await storageStatus(db, dataDir, settings), health: await databaseHealth(db, dataDir, DB_FILE) } });
    return;
  }
  if (command === "checkpoint") {
    const checkpoint = checkpointDatabase(db, request.input?.mode || "TRUNCATE");
    optimizeDatabase(db);
    writeResult({ ok: true, output: { checkpoint, health: await databaseHealth(db, dataDir, DB_FILE) } });
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
  if (command === "rebuild-rollups") {
    const rebuilt = rebuildRollups(db, request.input || {});
    writeResult({ ok: true, output: { rebuilt, storage: await storageStatus(db, dataDir, settings) } });
    return;
  }
  writeResult({ ok: false, stderr: `Unknown system-monitor command: ${command}` });
}

async function collectAndStoreSample(db, dataDir, settings, request) {
  const throttle = shouldThrottleSample(request);
  const fresh = throttle ? reusableLatestSample(db, await readState(dataDir), settings) : null;
  if (fresh) return fresh;

  const lock = throttle ? await tryAcquireSampleLock(dataDir, Math.max(3000, settings.sampleIntervalMs * 2)) : null;
  if (throttle && !lock?.acquired) {
    const latest = readLatestSample(db);
    if (latest) return { ...latest, reused: true, reuseReason: "collector-already-running" };
  }

  try {
    const state = await readState(dataDir);
    const lockedFresh = throttle ? reusableLatestSample(db, state, settings) : null;
    if (lockedFresh) return lockedFresh;
    return await collectAndStoreSampleUnlocked(db, dataDir, settings, request, state);
  } finally {
    await lock?.release?.();
  }
}

async function collectAndStoreSampleUnlocked(db, dataDir, settings, request, state) {
  const collectorDiagnostics = [];
  const previousCollectors = state.collectors || {};
  const collect = (name, fallback, collector) => collectMetric(name, fallback, collector, previousCollectors, collectorDiagnostics);
  const collectorCache = { ...(state.collectorCache || {}) };
  const cachedCollect = (name, intervalMs, fallback, collector) => {
    const result = collectCachedMetric(name, intervalMs, fallback, collector, state, previousCollectors, collectorDiagnostics);
    if (result.cacheUpdated) collectorCache[name] = result.cacheEntry;
    return result.value;
  };
  const cpuSnapshot = collect("cpu", cpuCountersFromOs(), cpuCounters);
  const networkCounters = settings.trackNetworkInterfaces ? collect("network", [], collectNetworkCounters) : [];
  const networkHealthCounters = settings.trackNetworkInterfaces ? collect("network-health", {}, collectNetworkHealthCounters) : {};
  const diskIoCounters = settings.trackDiskIo ? collect("disk-io", [], collectDiskIoCounters) : [];
  const memoryCounters = collect("memory", memoryCountersFromOs(), collectMemoryCounters);
  const timestampMs = Date.now();
  const node = request.context?.runtime ?? {};
  const cpu = {
    percent: cpuPercent(state.cpu, cpuSnapshot),
    cores: cpus().length,
    load1: loadavg()[0] ?? 0,
    load5: loadavg()[1] ?? 0,
    load15: loadavg()[2] ?? 0,
    breakdown: cpuBreakdown(state.cpu, cpuSnapshot),
    perCore: cpuCoreUsage(state.cpuCores, cpuSnapshot.cores),
  };
  const memory = memorySample(state.memory, memoryCounters, state.lastSampleAtMs, timestampMs);
  const disk = settings.trackDisks ? cachedCollect("disk", settings.diskSampleIntervalMs, [], () => collectDisks(settings)) : [];
  const diskIo = diskIoSample(state.diskIo, diskIoCounters, state.lastSampleAtMs, timestampMs);
  const network = networkSample(state.network, networkCounters, state.lastSampleAtMs, timestampMs);
  const networkHealth = networkHealthSample(state.networkHealth, networkHealthCounters, state.lastSampleAtMs, timestampMs, network);
  const environment = {
    thermal: settings.trackThermals ? cachedCollect("thermal", settings.thermalSampleIntervalMs, [], collectThermals) : [],
    battery: settings.trackBattery ? cachedCollect("battery", settings.batterySampleIntervalMs, null, collectBattery) : null,
  };
  const processes = settings.trackProcesses ? cachedCollect("processes", settings.processSampleIntervalMs, [], () => collectProcesses(platform(), settings.maxProcesses)) : [];
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
    cpu,
    memory,
    disk,
    diskIo,
    network,
    networkHealth,
    environment,
    processes,
    collectors: collectorDiagnostics,
  };
  sample.alerts = buildAlerts(sample, settings, state);
  const id = insertSample(db, sample);
  const notifications = recordAlertNotifications(db, sample, settings, state, id);
  maybeCleanup(db, settings, state, timestampMs);
  await writeState(dataDir, {
    cpu: cpuSnapshot,
    cpuCores: cpuSnapshot.cores,
    memory: memoryCounters,
    diskIo: diskIoCounters,
    network: networkCounters,
    networkHealth: networkHealthCounters,
    collectors: Object.fromEntries(collectorDiagnostics.map((item) => [item.name, item])),
    collectorCache,
    alertNotifications: state.alertNotifications || {},
    acknowledgedAlerts: state.acknowledgedAlerts || {},
    lastSampleAt: sample.timestamp,
    lastSampleAtMs: timestampMs,
    lastCleanupAtMs: state.lastCleanupAtMs,
  });
  return { ...sample, id, notifications };
}

function shouldThrottleSample(request) {
  return request.type === "collector" || request.input?.scheduled === true;
}

function reusableLatestSample(db, state, settings) {
  const latest = readLatestSample(db);
  const lastSampleAtMs = Number(state.lastSampleAtMs || latest?.timestampMs || 0);
  const minIntervalMs = Math.max(1000, Number(settings.sampleIntervalMs) || 5000);
  if (!latest || !lastSampleAtMs || Date.now() - lastSampleAtMs >= minIntervalMs) {
    return null;
  }
  return { ...latest, reused: true, reuseReason: "sample-interval" };
}

async function tryAcquireSampleLock(dataDir, ttlMs) {
  const lockPath = path.join(dataDir, "sample.lock");
  const token = `${process.pid}:${Date.now()}`;
  const acquire = async () => {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(token, "utf8");
    await handle.close();
    return {
      acquired: true,
      release: async () => {
        try {
          const current = await readFile(lockPath, "utf8");
          if (current === token) await rm(lockPath, { force: true });
        } catch {
          // Best-effort lock cleanup.
        }
      },
    };
  };
  try {
    return await acquire();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      const raw = await readFile(lockPath, "utf8");
      const [, timestamp] = raw.split(":");
      if (Date.now() - Number(timestamp || 0) > ttlMs) {
        await rm(lockPath, { force: true });
        return await acquire();
      }
    } catch {
      // Treat unreadable locks as active; the next run can retry.
    }
    return { acquired: false };
  }
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
  const alerts = readAlertHistory(db, request.input, settings);
  const storage = await storageStatus(db, dataDir, settings);
  return {
    current,
    history,
    summary,
    alerts,
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
  initializeSchema(db);
  return db;
}

function initializeSchema(db) {
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
      memory_total_bytes INTEGER,
      memory_available_bytes INTEGER,
      swap_percent REAL,
      swap_used_bytes INTEGER,
      swap_free_bytes INTEGER,
      swap_total_bytes INTEGER,
      memory_pressure_some_avg10 REAL,
      memory_pressure_some_avg60 REAL,
      memory_pressure_some_avg300 REAL,
      memory_pressure_full_avg10 REAL,
      memory_pressure_full_avg60 REAL,
      memory_pressure_full_avg300 REAL,
      page_faults INTEGER,
      major_page_faults INTEGER,
      page_faults_per_sec REAL,
      major_page_faults_per_sec REAL,
      cpu_user_percent REAL,
      cpu_nice_percent REAL,
      cpu_system_percent REAL,
      cpu_idle_percent REAL,
      cpu_iowait_percent REAL,
      cpu_irq_percent REAL,
      cpu_steal_percent REAL,
      network_rx_bps_total REAL,
      network_tx_bps_total REAL,
      network_errors_total INTEGER,
      network_drops_total INTEGER,
      tcp_retransmits INTEGER,
      tcp_retransmits_per_sec REAL,
      disk_read_bps_total REAL,
      disk_write_bps_total REAL,
      disk_read_iops_total REAL,
      disk_write_iops_total REAL,
      disk_busy_percent_max REAL,
      temp_celsius_max REAL,
      battery_percent REAL,
      battery_status TEXT,
      alerts_json TEXT,
      alerts_count INTEGER,
      processes_json TEXT,
      collector_diagnostics_json TEXT
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
      inodes_percent REAL,
      inodes_used INTEGER,
      inodes_available INTEGER,
      inodes_total INTEGER,
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
      rx_errors INTEGER,
      tx_errors INTEGER,
      rx_dropped INTEGER,
      tx_dropped INTEGER,
      rx_errors_per_sec REAL,
      tx_errors_per_sec REAL,
      rx_dropped_per_sec REAL,
      tx_dropped_per_sec REAL,
      PRIMARY KEY(sample_id, interface),
      FOREIGN KEY(sample_id) REFERENCES samples(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_network_sample ON network(sample_id);
    CREATE TABLE IF NOT EXISTS disk_io (
      sample_id INTEGER NOT NULL,
      device TEXT NOT NULL,
      read_bps REAL,
      write_bps REAL,
      read_iops REAL,
      write_iops REAL,
      busy_percent REAL,
      queue_depth REAL,
      read_latency_ms REAL,
      write_latency_ms REAL,
      read_bytes INTEGER,
      write_bytes INTEGER,
      reads INTEGER,
      writes INTEGER,
      PRIMARY KEY(sample_id, device),
      FOREIGN KEY(sample_id) REFERENCES samples(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_disk_io_sample ON disk_io(sample_id);
    CREATE TABLE IF NOT EXISTS cpu_cores (
      sample_id INTEGER NOT NULL,
      core_index INTEGER NOT NULL,
      percent REAL,
      user_percent REAL,
      system_percent REAL,
      idle_percent REAL,
      iowait_percent REAL,
      steal_percent REAL,
      PRIMARY KEY(sample_id, core_index),
      FOREIGN KEY(sample_id) REFERENCES samples(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_cpu_cores_sample ON cpu_cores(sample_id);
    CREATE TABLE IF NOT EXISTS rollups (
      period TEXT NOT NULL,
      bucket_ms INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      sample_count INTEGER,
      cpu_percent_avg REAL,
      cpu_percent_max REAL,
      cpu_iowait_avg REAL,
      memory_percent_avg REAL,
      memory_percent_max REAL,
      memory_used_bytes_avg INTEGER,
      memory_available_bytes_avg INTEGER,
      memory_total_bytes_avg INTEGER,
      swap_percent_avg REAL,
      swap_percent_max REAL,
      swap_used_bytes_avg INTEGER,
      swap_free_bytes_avg INTEGER,
      swap_total_bytes_avg INTEGER,
      disk_percent_avg REAL,
      disk_percent_max REAL,
      rx_bps_avg REAL,
      rx_bps_max REAL,
      tx_bps_avg REAL,
      tx_bps_max REAL,
      disk_read_bps_avg REAL,
      disk_write_bps_avg REAL,
      alerts_count INTEGER,
      PRIMARY KEY(period, bucket_ms, node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rollups_period_bucket ON rollups(period, bucket_ms);
    CREATE TABLE IF NOT EXISTS disk_rollups (
      period TEXT NOT NULL,
      bucket_ms INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      mount TEXT NOT NULL,
      filesystem TEXT,
      percent_avg REAL,
      percent_max REAL,
      used_bytes_avg INTEGER,
      total_bytes_avg INTEGER,
      inodes_percent_max REAL,
      PRIMARY KEY(period, bucket_ms, node_id, mount, filesystem)
    );
    CREATE INDEX IF NOT EXISTS idx_disk_rollups_period_bucket ON disk_rollups(period, bucket_ms);
    CREATE TABLE IF NOT EXISTS disk_io_rollups (
      period TEXT NOT NULL,
      bucket_ms INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      device TEXT NOT NULL,
      read_bps_avg REAL,
      write_bps_avg REAL,
      busy_percent_max REAL,
      queue_depth_avg REAL,
      PRIMARY KEY(period, bucket_ms, node_id, device)
    );
    CREATE INDEX IF NOT EXISTS idx_disk_io_rollups_period_bucket ON disk_io_rollups(period, bucket_ms);
    CREATE TABLE IF NOT EXISTS network_rollups (
      period TEXT NOT NULL,
      bucket_ms INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      interface TEXT NOT NULL,
      rx_bps_avg REAL,
      tx_bps_avg REAL,
      rx_errors_max INTEGER,
      tx_errors_max INTEGER,
      rx_dropped_max INTEGER,
      tx_dropped_max INTEGER,
      PRIMARY KEY(period, bucket_ms, node_id, interface)
    );
    CREATE INDEX IF NOT EXISTS idx_network_rollups_period_bucket ON network_rollups(period, bucket_ms);
    CREATE TABLE IF NOT EXISTS alert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sample_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      level TEXT,
      label TEXT,
      value REAL,
      threshold REAL,
      unit TEXT,
      FOREIGN KEY(sample_id) REFERENCES samples(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_alert_events_ts ON alert_events(ts);
    CREATE INDEX IF NOT EXISTS idx_alert_events_node_ts ON alert_events(node_id, ts);
    CREATE TABLE IF NOT EXISTS notification_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      channel TEXT,
      level TEXT,
      label TEXT,
      message TEXT,
      delivered INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_notification_events_ts ON notification_events(ts);
    CREATE INDEX IF NOT EXISTS idx_notification_events_delivered ON notification_events(delivered, ts);
  `);
  migrateSchema(db);
  db.prepare("INSERT OR REPLACE INTO schema_meta(key,value) VALUES (?, ?)").run("schemaVersion", String(SQLITE_SCHEMA_VERSION));
}

function migrateSchema(db) {
  const columns = {
    samples: {
      memory_available_bytes: "INTEGER",
      swap_percent: "REAL",
      swap_used_bytes: "INTEGER",
      swap_free_bytes: "INTEGER",
      swap_total_bytes: "INTEGER",
      memory_pressure_some_avg10: "REAL",
      memory_pressure_some_avg60: "REAL",
      memory_pressure_some_avg300: "REAL",
      memory_pressure_full_avg10: "REAL",
      memory_pressure_full_avg60: "REAL",
      memory_pressure_full_avg300: "REAL",
      page_faults: "INTEGER",
      major_page_faults: "INTEGER",
      page_faults_per_sec: "REAL",
      major_page_faults_per_sec: "REAL",
      cpu_user_percent: "REAL",
      cpu_nice_percent: "REAL",
      cpu_system_percent: "REAL",
      cpu_idle_percent: "REAL",
      cpu_iowait_percent: "REAL",
      cpu_irq_percent: "REAL",
      cpu_steal_percent: "REAL",
      network_rx_bps_total: "REAL",
      network_tx_bps_total: "REAL",
      network_errors_total: "INTEGER",
      network_drops_total: "INTEGER",
      tcp_retransmits: "INTEGER",
      tcp_retransmits_per_sec: "REAL",
      disk_read_bps_total: "REAL",
      disk_write_bps_total: "REAL",
      disk_read_iops_total: "REAL",
      disk_write_iops_total: "REAL",
      disk_busy_percent_max: "REAL",
      temp_celsius_max: "REAL",
      battery_percent: "REAL",
      battery_status: "TEXT",
      alerts_json: "TEXT",
      alerts_count: "INTEGER",
      processes_json: "TEXT",
      collector_diagnostics_json: "TEXT",
    },
    rollups: {
      memory_used_bytes_avg: "INTEGER",
      memory_available_bytes_avg: "INTEGER",
      memory_total_bytes_avg: "INTEGER",
      swap_used_bytes_avg: "INTEGER",
      swap_free_bytes_avg: "INTEGER",
      swap_total_bytes_avg: "INTEGER",
    },
    disks: {
      inodes_percent: "REAL",
      inodes_used: "INTEGER",
      inodes_available: "INTEGER",
      inodes_total: "INTEGER",
    },
    network: {
      rx_errors: "INTEGER",
      tx_errors: "INTEGER",
      rx_dropped: "INTEGER",
      tx_dropped: "INTEGER",
      rx_errors_per_sec: "REAL",
      tx_errors_per_sec: "REAL",
      rx_dropped_per_sec: "REAL",
      tx_dropped_per_sec: "REAL",
    },
  };
  for (const [table, wanted] of Object.entries(columns)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
    for (const [column, definition] of Object.entries(wanted)) {
      if (!existing.has(column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    }
  }
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
    const diskIoTotals = diskIoSummary(sample.diskIo);
    const networkTotals = networkSummary(sample.network, sample.networkHealth);
    const thermal = thermalSummary(sample.environment?.thermal);
    const battery = sample.environment?.battery || {};
    const info = db.prepare(`
      INSERT INTO samples (
        ts, node_id, node_name, node_platform, node_hostname, node_release, node_workspace,
        uptime_seconds, cpu_percent, cpu_cores, load1, load5, load15,
        memory_percent, memory_used_bytes, memory_free_bytes, memory_total_bytes,
        memory_available_bytes, swap_percent, swap_used_bytes, swap_free_bytes, swap_total_bytes,
        memory_pressure_some_avg10, memory_pressure_some_avg60, memory_pressure_some_avg300,
        memory_pressure_full_avg10, memory_pressure_full_avg60, memory_pressure_full_avg300,
        page_faults, major_page_faults, page_faults_per_sec, major_page_faults_per_sec,
        cpu_user_percent, cpu_nice_percent, cpu_system_percent, cpu_idle_percent,
        cpu_iowait_percent, cpu_irq_percent, cpu_steal_percent,
        network_rx_bps_total, network_tx_bps_total, network_errors_total, network_drops_total,
        tcp_retransmits, tcp_retransmits_per_sec,
        disk_read_bps_total, disk_write_bps_total, disk_read_iops_total, disk_write_iops_total, disk_busy_percent_max,
        temp_celsius_max, battery_percent, battery_status, alerts_json, alerts_count,
        processes_json, collector_diagnostics_json
      ) VALUES (${Array.from({ length: 57 }, () => "?").join(", ")})
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
      sample.memory.availableBytes,
      sample.memory.swapPercent,
      sample.memory.swapUsedBytes,
      sample.memory.swapFreeBytes,
      sample.memory.swapTotalBytes,
      numberOrNull(sample.memory.pressure?.some?.avg10),
      numberOrNull(sample.memory.pressure?.some?.avg60),
      numberOrNull(sample.memory.pressure?.some?.avg300),
      numberOrNull(sample.memory.pressure?.full?.avg10),
      numberOrNull(sample.memory.pressure?.full?.avg60),
      numberOrNull(sample.memory.pressure?.full?.avg300),
      sample.memory.pageFaults,
      sample.memory.majorPageFaults,
      sample.memory.pageFaultsPerSec,
      sample.memory.majorPageFaultsPerSec,
      numberOrNull(sample.cpu.breakdown?.user),
      numberOrNull(sample.cpu.breakdown?.nice),
      numberOrNull(sample.cpu.breakdown?.system),
      numberOrNull(sample.cpu.breakdown?.idle),
      numberOrNull(sample.cpu.breakdown?.iowait),
      numberOrNull(sample.cpu.breakdown?.irq),
      numberOrNull(sample.cpu.breakdown?.steal),
      networkTotals.rxBytesPerSec,
      networkTotals.txBytesPerSec,
      networkTotals.errors,
      networkTotals.drops,
      integerOrNull(sample.networkHealth?.tcpRetransmits),
      numberOrNull(sample.networkHealth?.tcpRetransmitsPerSec),
      diskIoTotals.readBytesPerSec,
      diskIoTotals.writeBytesPerSec,
      diskIoTotals.readIops,
      diskIoTotals.writeIops,
      diskIoTotals.maxBusyPercent,
      numberOrNull(thermal.maxCelsius),
      numberOrNull(battery.percent),
      battery.status || "",
      JSON.stringify(sample.alerts || []),
      Array.isArray(sample.alerts) ? sample.alerts.length : 0,
      JSON.stringify(sample.processes || []),
      JSON.stringify(sample.collectors || []),
    );
    const sampleId = Number(info.lastInsertRowid);
    const alertStmt = db.prepare(`
      INSERT INTO alert_events(sample_id, ts, node_id, level, label, value, threshold, unit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const alert of sample.alerts || []) {
      alertStmt.run(
        sampleId,
        sample.timestampMs,
        sample.node.id || "",
        alert.level || "",
        alert.label || "",
        numberOrNull(alert.value),
        numberOrNull(alert.threshold),
        alert.unit || "",
      );
    }
    const diskStmt = db.prepare(`
      INSERT INTO disks(sample_id, mount, filesystem, percent, used_bytes, available_bytes, total_bytes, inodes_percent, inodes_used, inodes_available, inodes_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        numberOrNull(disk.inodesPercent),
        integerOrNull(disk.inodesUsed),
        integerOrNull(disk.inodesAvailable),
        integerOrNull(disk.inodesTotal),
      );
    }
    const networkStmt = db.prepare(`
      INSERT INTO network(sample_id, interface, rx_bps, tx_bps, rx_bytes, tx_bytes, rx_errors, tx_errors, rx_dropped, tx_dropped, rx_errors_per_sec, tx_errors_per_sec, rx_dropped_per_sec, tx_dropped_per_sec)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of sample.network || []) {
      networkStmt.run(
        sampleId,
        row.name || "",
        numberOrNull(row.rxBytesPerSec),
        numberOrNull(row.txBytesPerSec),
        integerOrNull(row.rxBytes),
        integerOrNull(row.txBytes),
        integerOrNull(row.rxErrors),
        integerOrNull(row.txErrors),
        integerOrNull(row.rxDropped),
        integerOrNull(row.txDropped),
        numberOrNull(row.rxErrorsPerSec),
        numberOrNull(row.txErrorsPerSec),
        numberOrNull(row.rxDroppedPerSec),
        numberOrNull(row.txDroppedPerSec),
      );
    }
    const diskIoStmt = db.prepare(`
      INSERT INTO disk_io(sample_id, device, read_bps, write_bps, read_iops, write_iops, busy_percent, queue_depth, read_latency_ms, write_latency_ms, read_bytes, write_bytes, reads, writes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of sample.diskIo || []) {
      diskIoStmt.run(
        sampleId,
        row.name || "",
        numberOrNull(row.readBytesPerSec),
        numberOrNull(row.writeBytesPerSec),
        numberOrNull(row.readIops),
        numberOrNull(row.writeIops),
        numberOrNull(row.busyPercent),
        numberOrNull(row.queueDepth),
        numberOrNull(row.readLatencyMs),
        numberOrNull(row.writeLatencyMs),
        integerOrNull(row.readBytes),
        integerOrNull(row.writeBytes),
        integerOrNull(row.reads),
        integerOrNull(row.writes),
      );
    }
    const coreStmt = db.prepare(`
      INSERT INTO cpu_cores(sample_id, core_index, percent, user_percent, system_percent, idle_percent, iowait_percent, steal_percent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const core of sample.cpu?.perCore || []) {
      coreStmt.run(
        sampleId,
        core.index,
        numberOrNull(core.percent),
        numberOrNull(core.user),
        numberOrNull(core.system),
        numberOrNull(core.idle),
        numberOrNull(core.iowait),
        numberOrNull(core.steal),
      );
    }
    updateRollups(db, sample);
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
  const diskIoRows = db.prepare("SELECT * FROM disk_io WHERE sample_id = ? ORDER BY (read_bps + write_bps) DESC").all(row.id);
  const cpuCoreRows = db.prepare("SELECT * FROM cpu_cores WHERE sample_id = ? ORDER BY core_index ASC").all(row.id);
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
      breakdown: {
        user: roundPercent(Number(row.cpu_user_percent) || 0),
        nice: roundPercent(Number(row.cpu_nice_percent) || 0),
        system: roundPercent(Number(row.cpu_system_percent) || 0),
        idle: roundPercent(Number(row.cpu_idle_percent) || 0),
        iowait: roundPercent(Number(row.cpu_iowait_percent) || 0),
        irq: roundPercent(Number(row.cpu_irq_percent) || 0),
        steal: roundPercent(Number(row.cpu_steal_percent) || 0),
      },
      perCore: cpuCoreRows.map((core) => ({
        index: Number(core.core_index) || 0,
        percent: roundPercent(Number(core.percent) || 0),
        user: roundPercent(Number(core.user_percent) || 0),
        system: roundPercent(Number(core.system_percent) || 0),
        idle: roundPercent(Number(core.idle_percent) || 0),
        iowait: roundPercent(Number(core.iowait_percent) || 0),
        steal: roundPercent(Number(core.steal_percent) || 0),
      })),
    },
    memory: {
      percent: roundPercent(Number(row.memory_percent) || 0),
      usedBytes: Number(row.memory_used_bytes) || 0,
      freeBytes: Number(row.memory_free_bytes) || 0,
      totalBytes: Number(row.memory_total_bytes) || 0,
      availableBytes: Number(row.memory_available_bytes) || Number(row.memory_free_bytes) || 0,
      swapPercent: roundPercent(Number(row.swap_percent) || 0),
      swapUsedBytes: Number(row.swap_used_bytes) || 0,
      swapFreeBytes: Number(row.swap_free_bytes) || 0,
      swapTotalBytes: Number(row.swap_total_bytes) || 0,
      pressure: {
        some: {
          avg10: roundNumber(row.memory_pressure_some_avg10),
          avg60: roundNumber(row.memory_pressure_some_avg60),
          avg300: roundNumber(row.memory_pressure_some_avg300),
        },
        full: {
          avg10: roundNumber(row.memory_pressure_full_avg10),
          avg60: roundNumber(row.memory_pressure_full_avg60),
          avg300: roundNumber(row.memory_pressure_full_avg300),
        },
      },
      pageFaults: Number(row.page_faults) || 0,
      majorPageFaults: Number(row.major_page_faults) || 0,
      pageFaultsPerSec: Math.max(0, Number(row.page_faults_per_sec) || 0),
      majorPageFaultsPerSec: Math.max(0, Number(row.major_page_faults_per_sec) || 0),
    },
    disk: disks.map((disk) => ({
      mount: disk.mount || "",
      filesystem: disk.filesystem || "",
      percent: roundPercent(Number(disk.percent) || 0),
      usedBytes: Number(disk.used_bytes) || 0,
      availableBytes: Number(disk.available_bytes) || 0,
      totalBytes: Number(disk.total_bytes) || 0,
      inodesPercent: roundPercent(Number(disk.inodes_percent) || 0),
      inodesUsed: Number(disk.inodes_used) || 0,
      inodesAvailable: Number(disk.inodes_available) || 0,
      inodesTotal: Number(disk.inodes_total) || 0,
    })),
    diskIo: diskIoRows.map((row) => ({
      name: row.device || "",
      readBytesPerSec: Math.max(0, Number(row.read_bps) || 0),
      writeBytesPerSec: Math.max(0, Number(row.write_bps) || 0),
      readIops: Math.max(0, Number(row.read_iops) || 0),
      writeIops: Math.max(0, Number(row.write_iops) || 0),
      busyPercent: roundPercent(Number(row.busy_percent) || 0),
      queueDepth: Math.max(0, roundNumber(row.queue_depth)),
      readLatencyMs: Math.max(0, roundNumber(row.read_latency_ms)),
      writeLatencyMs: Math.max(0, roundNumber(row.write_latency_ms)),
      readBytes: Number(row.read_bytes) || 0,
      writeBytes: Number(row.write_bytes) || 0,
      reads: Number(row.reads) || 0,
      writes: Number(row.writes) || 0,
    })),
    network: networkRows.map((row) => ({
      name: row.interface || "",
      rxBytesPerSec: Math.max(0, Number(row.rx_bps) || 0),
      txBytesPerSec: Math.max(0, Number(row.tx_bps) || 0),
      rxBytes: Number(row.rx_bytes) || 0,
      txBytes: Number(row.tx_bytes) || 0,
      rxErrors: Number(row.rx_errors) || 0,
      txErrors: Number(row.tx_errors) || 0,
      rxDropped: Number(row.rx_dropped) || 0,
      txDropped: Number(row.tx_dropped) || 0,
      rxErrorsPerSec: Math.max(0, Number(row.rx_errors_per_sec) || 0),
      txErrorsPerSec: Math.max(0, Number(row.tx_errors_per_sec) || 0),
      rxDroppedPerSec: Math.max(0, Number(row.rx_dropped_per_sec) || 0),
      txDroppedPerSec: Math.max(0, Number(row.tx_dropped_per_sec) || 0),
    })),
    networkHealth: {
      rxBytesPerSec: Math.max(0, Number(row.network_rx_bps_total) || 0),
      txBytesPerSec: Math.max(0, Number(row.network_tx_bps_total) || 0),
      errors: Number(row.network_errors_total) || 0,
      drops: Number(row.network_drops_total) || 0,
      tcpRetransmits: Number(row.tcp_retransmits) || 0,
      tcpRetransmitsPerSec: Math.max(0, Number(row.tcp_retransmits_per_sec) || 0),
    },
    environment: {
      thermal: Number.isFinite(Number(row.temp_celsius_max)) ? [{ label: "max", celsius: Number(row.temp_celsius_max) }] : [],
      battery: Number.isFinite(Number(row.battery_percent)) ? { percent: Number(row.battery_percent), status: row.battery_status || "" } : null,
    },
    alerts: parseJsonArray(row.alerts_json),
    processes: parseJsonArray(row.processes_json),
    collectors: parseJsonArray(row.collector_diagnostics_json),
  };
}

function readHistory(db, input = {}, settings = normalizeSettings()) {
  const range = resolveRange(input, settings);
  const bucketMs = Math.max(1000, Math.ceil(range.rangeMs / Math.max(1, range.maxPoints) / 1000) * 1000);
  const core = readCoreHistory(db, range, bucketMs);
  return {
    ...range,
    bucketMs,
    points: core,
    disks: readDiskSeries(db, range, bucketMs),
    diskIo: readDiskIoSeries(db, range, bucketMs),
    network: readNetworkSeries(db, range, bucketMs),
  };
}

function readCoreHistory(db, range, bucketMs) {
  const rollup = readRollupHistory(db, range);
  if (rollup.length) return rollup;
  return db.prepare(`
    SELECT CAST(ts / ? AS INTEGER) * ? AS timestamp,
      avg(cpu_percent) AS cpu_percent,
      max(cpu_percent) AS cpu_max_percent,
      avg(cpu_system_percent) AS cpu_system_percent,
      avg(cpu_iowait_percent) AS cpu_iowait_percent,
      avg(cpu_steal_percent) AS cpu_steal_percent,
      avg(memory_percent) AS memory_percent,
      avg(memory_used_bytes) AS memory_used_bytes,
      avg(memory_available_bytes) AS memory_available_bytes,
      avg(memory_total_bytes) AS memory_total_bytes,
      avg(swap_percent) AS swap_percent,
      avg(swap_used_bytes) AS swap_used_bytes,
      avg(swap_free_bytes) AS swap_free_bytes,
      avg(swap_total_bytes) AS swap_total_bytes,
      avg(load1) AS load1,
      avg(load5) AS load5,
      avg(load15) AS load15,
      avg(network_rx_bps_total) AS rx_bps,
      avg(network_tx_bps_total) AS tx_bps,
      avg(disk_read_bps_total) AS disk_read_bps,
      avg(disk_write_bps_total) AS disk_write_bps
    FROM samples
    WHERE ts >= ? AND ts <= ?
    GROUP BY CAST(ts / ? AS INTEGER)
    ORDER BY timestamp ASC
  `).all(bucketMs, bucketMs, range.fromMs, range.toMs, bucketMs).map((row) => ({
    timestamp: Number(row.timestamp),
    cpuPercent: roundPercent(Number(row.cpu_percent) || 0),
    cpuMaxPercent: roundPercent(Number(row.cpu_max_percent) || 0),
    cpuSystemPercent: roundPercent(Number(row.cpu_system_percent) || 0),
    cpuIowaitPercent: roundPercent(Number(row.cpu_iowait_percent) || 0),
    cpuStealPercent: roundPercent(Number(row.cpu_steal_percent) || 0),
    memoryPercent: roundPercent(Number(row.memory_percent) || 0),
    memoryUsedBytes: Math.max(0, Math.round(Number(row.memory_used_bytes) || 0)),
    memoryAvailableBytes: Math.max(0, Math.round(Number(row.memory_available_bytes) || 0)),
    memoryTotalBytes: Math.max(0, Math.round(Number(row.memory_total_bytes) || 0)),
    swapPercent: roundPercent(Number(row.swap_percent) || 0),
    swapUsedBytes: Math.max(0, Math.round(Number(row.swap_used_bytes) || 0)),
    swapFreeBytes: Math.max(0, Math.round(Number(row.swap_free_bytes) || 0)),
    swapTotalBytes: Math.max(0, Math.round(Number(row.swap_total_bytes) || 0)),
    load1: roundNumber(row.load1),
    load5: roundNumber(row.load5),
    load15: roundNumber(row.load15),
    rxBytesPerSec: Math.max(0, Math.round(Number(row.rx_bps) || 0)),
    txBytesPerSec: Math.max(0, Math.round(Number(row.tx_bps) || 0)),
    diskReadBytesPerSec: Math.max(0, Math.round(Number(row.disk_read_bps) || 0)),
    diskWriteBytesPerSec: Math.max(0, Math.round(Number(row.disk_write_bps) || 0)),
  }));
}

function readRollupHistory(db, range) {
  const period = rollupPeriodForRange(range);
  if (!period) return [];
  const rows = db.prepare(`
    SELECT bucket_ms AS timestamp,
      cpu_percent_avg,
      cpu_percent_max,
      cpu_iowait_avg,
      memory_percent_avg,
      memory_percent_max,
      memory_used_bytes_avg,
      memory_available_bytes_avg,
      memory_total_bytes_avg,
      swap_percent_avg,
      swap_used_bytes_avg,
      swap_free_bytes_avg,
      swap_total_bytes_avg,
      rx_bps_avg,
      tx_bps_avg,
      disk_read_bps_avg,
      disk_write_bps_avg
    FROM rollups
    WHERE period = ? AND bucket_ms >= ? AND bucket_ms <= ?
      ORDER BY bucket_ms ASC
  `).all(period, range.fromMs, range.toMs);
  if (!rows.some((row) => Number(row.memory_total_bytes_avg) > 0 && Number.isFinite(Number(row.memory_used_bytes_avg)))) return [];
  return rows.map((row) => ({
    timestamp: Number(row.timestamp),
    cpuPercent: roundPercent(Number(row.cpu_percent_avg) || 0),
    cpuMaxPercent: roundPercent(Number(row.cpu_percent_max) || 0),
    cpuIowaitPercent: roundPercent(Number(row.cpu_iowait_avg) || 0),
    memoryPercent: roundPercent(Number(row.memory_percent_avg) || 0),
    memoryMaxPercent: roundPercent(Number(row.memory_percent_max) || 0),
    memoryUsedBytes: Math.max(0, Math.round(Number(row.memory_used_bytes_avg) || 0)),
    memoryAvailableBytes: Math.max(0, Math.round(Number(row.memory_available_bytes_avg) || 0)),
    memoryTotalBytes: Math.max(0, Math.round(Number(row.memory_total_bytes_avg) || 0)),
    swapPercent: roundPercent(Number(row.swap_percent_avg) || 0),
    swapUsedBytes: Math.max(0, Math.round(Number(row.swap_used_bytes_avg) || 0)),
    swapFreeBytes: Math.max(0, Math.round(Number(row.swap_free_bytes_avg) || 0)),
    swapTotalBytes: Math.max(0, Math.round(Number(row.swap_total_bytes_avg) || 0)),
    rxBytesPerSec: Math.max(0, Math.round(Number(row.rx_bps_avg) || 0)),
    txBytesPerSec: Math.max(0, Math.round(Number(row.tx_bps_avg) || 0)),
    diskReadBytesPerSec: Math.max(0, Math.round(Number(row.disk_read_bps_avg) || 0)),
    diskWriteBytesPerSec: Math.max(0, Math.round(Number(row.disk_write_bps_avg) || 0)),
  }));
}

function rollupPeriodForRange(range) {
  return selectRollupPeriod(range, RANGE_PRESETS);
}

function readDiskRollupSeries(db, range) {
  const period = rollupPeriodForRange(range);
  if (!period) return [];
  const targets = db.prepare(`
    SELECT mount, filesystem, max(percent_max) AS max_percent
    FROM disk_rollups
    WHERE period = ? AND bucket_ms >= ? AND bucket_ms <= ?
    GROUP BY mount, filesystem
    ORDER BY max_percent DESC
    LIMIT 4
  `).all(period, range.fromMs, range.toMs);
  return targets.map((target) => ({
    mount: target.mount || "",
    filesystem: target.filesystem || "",
    points: db.prepare(`
      SELECT bucket_ms AS timestamp, percent_avg, used_bytes_avg, total_bytes_avg, inodes_percent_max
      FROM disk_rollups
      WHERE period = ? AND bucket_ms >= ? AND bucket_ms <= ? AND mount = ? AND filesystem = ?
      ORDER BY bucket_ms ASC
    `).all(period, range.fromMs, range.toMs, target.mount || "", target.filesystem || "").map((row) => ({
      timestamp: Number(row.timestamp),
      percent: roundPercent(Number(row.percent_avg) || 0),
      usedBytes: Math.round(Number(row.used_bytes_avg) || 0),
      totalBytes: Math.round(Number(row.total_bytes_avg) || 0),
      inodesPercent: roundPercent(Number(row.inodes_percent_max) || 0),
    })),
  }));
}

function readDiskIoRollupSeries(db, range) {
  const period = rollupPeriodForRange(range);
  if (!period) return [];
  const targets = db.prepare(`
    SELECT device, avg(read_bps_avg + write_bps_avg) AS average_bps
    FROM disk_io_rollups
    WHERE period = ? AND bucket_ms >= ? AND bucket_ms <= ?
    GROUP BY device
    ORDER BY average_bps DESC
    LIMIT 4
  `).all(period, range.fromMs, range.toMs);
  return targets.map((target) => ({
    name: target.device || "",
    points: db.prepare(`
      SELECT bucket_ms AS timestamp, read_bps_avg, write_bps_avg, busy_percent_max, queue_depth_avg
      FROM disk_io_rollups
      WHERE period = ? AND bucket_ms >= ? AND bucket_ms <= ? AND device = ?
      ORDER BY bucket_ms ASC
    `).all(period, range.fromMs, range.toMs, target.device || "").map((row) => ({
      timestamp: Number(row.timestamp),
      readBytesPerSec: Math.max(0, Math.round(Number(row.read_bps_avg) || 0)),
      writeBytesPerSec: Math.max(0, Math.round(Number(row.write_bps_avg) || 0)),
      busyPercent: roundPercent(Number(row.busy_percent_max) || 0),
      queueDepth: Math.max(0, roundNumber(row.queue_depth_avg)),
    })),
  }));
}

function readNetworkRollupSeries(db, range) {
  const period = rollupPeriodForRange(range);
  if (!period) return [];
  const targets = db.prepare(`
    SELECT interface, avg(rx_bps_avg + tx_bps_avg) AS average_bps
    FROM network_rollups
    WHERE period = ? AND bucket_ms >= ? AND bucket_ms <= ?
    GROUP BY interface
    ORDER BY average_bps DESC
    LIMIT 4
  `).all(period, range.fromMs, range.toMs);
  return targets.map((target) => ({
    name: target.interface || "",
    points: db.prepare(`
      SELECT bucket_ms AS timestamp, rx_bps_avg, tx_bps_avg, rx_errors_max, tx_errors_max, rx_dropped_max, tx_dropped_max
      FROM network_rollups
      WHERE period = ? AND bucket_ms >= ? AND bucket_ms <= ? AND interface = ?
      ORDER BY bucket_ms ASC
    `).all(period, range.fromMs, range.toMs, target.interface || "").map((row) => ({
      timestamp: Number(row.timestamp),
      rxBytesPerSec: Math.max(0, Math.round(Number(row.rx_bps_avg) || 0)),
      txBytesPerSec: Math.max(0, Math.round(Number(row.tx_bps_avg) || 0)),
      rxErrors: Number(row.rx_errors_max) || 0,
      txErrors: Number(row.tx_errors_max) || 0,
      rxDropped: Number(row.rx_dropped_max) || 0,
      txDropped: Number(row.tx_dropped_max) || 0,
    })),
  }));
}

function readDiskSeries(db, range, bucketMs) {
  const rollup = readDiskRollupSeries(db, range);
  if (rollup.length) return rollup;
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

function readDiskIoSeries(db, range, bucketMs) {
  const rollup = readDiskIoRollupSeries(db, range);
  if (rollup.length) return rollup;
  const targets = db.prepare(`
    SELECT disk_io.device AS device, avg(disk_io.read_bps + disk_io.write_bps) AS average_bps
    FROM disk_io
    JOIN samples ON samples.id = disk_io.sample_id
    WHERE samples.ts >= ? AND samples.ts <= ?
    GROUP BY disk_io.device
    ORDER BY average_bps DESC
    LIMIT 4
  `).all(range.fromMs, range.toMs);
  return targets.map((target) => ({
    name: target.device || "",
    points: db.prepare(`
      SELECT CAST(samples.ts / ? AS INTEGER) * ? AS timestamp,
        avg(disk_io.read_bps) AS read_bps,
        avg(disk_io.write_bps) AS write_bps,
        avg(disk_io.busy_percent) AS busy_percent,
        avg(disk_io.queue_depth) AS queue_depth
      FROM disk_io
      JOIN samples ON samples.id = disk_io.sample_id
      WHERE samples.ts >= ? AND samples.ts <= ? AND disk_io.device = ?
      GROUP BY CAST(samples.ts / ? AS INTEGER)
      ORDER BY timestamp ASC
    `).all(bucketMs, bucketMs, range.fromMs, range.toMs, target.device || "", bucketMs).map((row) => ({
      timestamp: Number(row.timestamp),
      readBytesPerSec: Math.max(0, Math.round(Number(row.read_bps) || 0)),
      writeBytesPerSec: Math.max(0, Math.round(Number(row.write_bps) || 0)),
      busyPercent: roundPercent(Number(row.busy_percent) || 0),
      queueDepth: Math.max(0, roundNumber(row.queue_depth)),
    })),
  }));
}

function readNetworkSeries(db, range, bucketMs) {
  const rollup = readNetworkRollupSeries(db, range);
  if (rollup.length) return rollup;
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
  if (metric === "swap") return { ...history, series: history.points.map((p) => ({ timestamp: p.timestamp, value: p.swapPercent })) };
  if (metric === "load") return { ...history, series: history.points.map((p) => ({ timestamp: p.timestamp, load1: p.load1, load5: p.load5, load15: p.load15 })) };
  if (metric === "disk-io" || metric === "diskio") {
    const name = String(input.device || history.diskIo[0]?.name || "");
    const disk = history.diskIo.find((item) => item.name === name) || history.diskIo[0] || { points: [] };
    return {
      ...history,
      series: disk.points.map((p) => ({ timestamp: p.timestamp, readBytesPerSec: p.readBytesPerSec, writeBytesPerSec: p.writeBytesPerSec, busyPercent: p.busyPercent })),
      target: disk.name || "",
    };
  }
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
      max(memory_percent) AS memory_max,
      min(swap_percent) AS swap_min,
      avg(swap_percent) AS swap_avg,
      max(swap_percent) AS swap_max,
      avg(cpu_iowait_percent) AS cpu_iowait_avg,
      max(cpu_iowait_percent) AS cpu_iowait_max,
      max(disk_busy_percent_max) AS disk_busy_max,
      max(alerts_count) AS alerts_max
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
  const diskIo = db.prepare(`
    SELECT max(disk_io.read_bps) AS max_read_bps, max(disk_io.write_bps) AS max_write_bps, max(disk_io.busy_percent) AS max_busy_percent
    FROM disk_io
    JOIN samples ON samples.id = disk_io.sample_id
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
    swap: {
      min: roundPercent(Number(row?.swap_min) || 0),
      avg: roundPercent(Number(row?.swap_avg) || 0),
      max: roundPercent(Number(row?.swap_max) || 0),
    },
    cpuIowait: {
      avg: roundPercent(Number(row?.cpu_iowait_avg) || 0),
      max: roundPercent(Number(row?.cpu_iowait_max) || 0),
    },
    disk: disk ? { mount: disk.mount || "", max: roundPercent(Number(disk.max_percent) || 0) } : null,
    diskIo: diskIo ? {
      maxReadBytesPerSec: Math.round(Number(diskIo.max_read_bps) || 0),
      maxWriteBytesPerSec: Math.round(Number(diskIo.max_write_bps) || 0),
      maxBusyPercent: roundPercent(Number(diskIo.max_busy_percent) || 0),
    } : null,
    network: network ? {
      maxRxBytesPerSec: Math.round(Number(network.max_rx_bps) || 0),
      maxTxBytesPerSec: Math.round(Number(network.max_tx_bps) || 0),
      averageBytesPerSec: Math.round(Number(network.avg_total_bps) || 0),
    } : null,
    alertsMax: Number(row?.alerts_max) || 0,
  };
}

function readAlertHistory(db, input = {}, settings = normalizeSettings()) {
  const range = resolveRange(input, settings);
  const limit = Math.max(1, Math.min(500, Math.round(numberInput(input.limit, 100))));
  const rows = db.prepare(`
    SELECT ts, node_id, level, label, value, threshold, unit
    FROM alert_events
    WHERE ts >= ? AND ts <= ?
    ORDER BY ts DESC
    LIMIT ?
  `).all(range.fromMs, range.toMs, limit);
  return {
    ...range,
    events: rows.map((row) => ({
      timestamp: new Date(Number(row.ts)).toISOString(),
      timestampMs: Number(row.ts),
      nodeId: row.node_id || "",
      level: row.level || "",
      label: row.label || "",
      value: roundNumber(row.value),
      threshold: roundNumber(row.threshold),
      unit: row.unit || "",
    })),
  };
}

function readNotifications(db, input = {}, settings = normalizeSettings()) {
  const range = resolveRange(input, settings);
  const includeDelivered = input.includeDelivered === true || input.includeDelivered === "true";
  const limit = Math.max(1, Math.min(500, Math.round(numberInput(input.limit, 100))));
  const rows = db.prepare(`
    SELECT id, ts, node_id, channel, level, label, message, delivered
    FROM notification_events
    WHERE ts >= ? AND ts <= ? ${includeDelivered ? "" : "AND delivered = 0"}
    ORDER BY ts DESC
    LIMIT ?
  `).all(range.fromMs, range.toMs, limit);
  if (input.markDelivered === true || input.markDelivered === "true") {
    const ids = rows.map((row) => Number(row.id)).filter(Boolean);
    if (ids.length) db.prepare(`UPDATE notification_events SET delivered = 1 WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
  }
  return {
    ...range,
    events: rows.map((row) => ({
      id: Number(row.id),
      timestamp: new Date(Number(row.ts)).toISOString(),
      timestampMs: Number(row.ts),
      nodeId: row.node_id || "",
      channel: row.channel || "",
      level: row.level || "",
      label: row.label || "",
      message: row.message || "",
      delivered: Number(row.delivered) === 1,
    })),
  };
}

async function acknowledgeAlert(dataDir, state, input = {}, settings = normalizeSettings()) {
  const label = String(input.label || "").trim();
  if (!label) throw new Error("ack-alert requires input.label");
  const nodeId = String(input.nodeId || "*");
  const untilMinutes = Math.max(1, Math.min(60 * 24 * 365, numberInput(input.untilMinutes, settings.alertAcknowledgeMinutes)));
  const key = `${nodeId}\0${label}`;
  state.acknowledgedAlerts = state.acknowledgedAlerts || {};
  state.acknowledgedAlerts[key] = Date.now() + untilMinutes * 60 * 1000;
  await writeState(dataDir, state);
  return { label, nodeId, until: new Date(state.acknowledgedAlerts[key]).toISOString() };
}

function recordAlertNotifications(db, sample, settings, state, sampleId) {
  const cooldownMs = Math.max(0, settings.alertCooldownMinutes) * 60 * 1000;
  const notifications = [];
  state.alertNotifications = state.alertNotifications || {};
  const stmt = db.prepare(`
    INSERT INTO notification_events(ts, node_id, channel, level, label, message, delivered)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `);
  for (const alert of sample.alerts || []) {
    const key = `${sample.node?.id || ""}\0${alert.label}`;
    const last = Number(state.alertNotifications[key]) || 0;
    if (cooldownMs && sample.timestampMs - last < cooldownMs) continue;
    state.alertNotifications[key] = sample.timestampMs;
    const message = `${sample.node?.name || "Node"}: ${alert.label} ${formatAlertValue(alert)} reached threshold ${formatAlertThreshold(alert)}`;
    const notification = {
      sampleId,
      timestamp: sample.timestamp,
      timestampMs: sample.timestampMs,
      nodeId: sample.node?.id || "",
      channel: settings.alertChannel,
      level: alert.level,
      label: alert.label,
      message,
    };
    stmt.run(notification.timestampMs, notification.nodeId, notification.channel, notification.level, notification.label, notification.message);
    notifications.push(notification);
  }
  return notifications;
}

function formatAlertValue(alert) {
  return `${roundNumber(alert.value)}${alert.unit || ""}`;
}

function formatAlertThreshold(alert) {
  return `${roundNumber(alert.threshold)}${alert.unit || ""}`;
}

async function storageStatus(db, dataDir, settings) {
  const row = db.prepare("SELECT count(*) AS samples, min(ts) AS oldest_ts, max(ts) AS newest_ts FROM samples").get();
  const diskRows = db.prepare("SELECT count(*) AS count FROM disks").get();
  const networkRows = db.prepare("SELECT count(*) AS count FROM network").get();
  const diskIoRows = db.prepare("SELECT count(*) AS count FROM disk_io").get();
  const cpuCoreRows = db.prepare("SELECT count(*) AS count FROM cpu_cores").get();
  const rollupRows = db.prepare("SELECT count(*) AS count FROM rollups").get();
  const diskRollupRows = db.prepare("SELECT count(*) AS count FROM disk_rollups").get();
  const diskIoRollupRows = db.prepare("SELECT count(*) AS count FROM disk_io_rollups").get();
  const networkRollupRows = db.prepare("SELECT count(*) AS count FROM network_rollups").get();
  const alertRows = db.prepare("SELECT count(*) AS count FROM alert_events").get();
  const notificationRows = db.prepare("SELECT count(*) AS count FROM notification_events").get();
  const file = path.join(dataDir, DB_FILE);
  const sizeBytes = await databaseFilesSize(file);
  const health = await databaseHealth(db, dataDir, DB_FILE);
  return {
    database: file,
    sizeBytes,
    health,
    samples: Number(row?.samples) || 0,
    diskRows: Number(diskRows?.count) || 0,
    networkRows: Number(networkRows?.count) || 0,
    diskIoRows: Number(diskIoRows?.count) || 0,
    cpuCoreRows: Number(cpuCoreRows?.count) || 0,
    rollupRows: Number(rollupRows?.count) || 0,
    diskRollupRows: Number(diskRollupRows?.count) || 0,
    diskIoRollupRows: Number(diskIoRollupRows?.count) || 0,
    networkRollupRows: Number(networkRollupRows?.count) || 0,
    alertRows: Number(alertRows?.count) || 0,
    notificationRows: Number(notificationRows?.count) || 0,
    oldestTimestamp: row?.oldest_ts ? new Date(Number(row.oldest_ts)).toISOString() : null,
    newestTimestamp: row?.newest_ts ? new Date(Number(row.newest_ts)).toISOString() : null,
    retentionDays: settings.retentionDays,
  };
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
  db.prepare("DELETE FROM rollups WHERE bucket_ms < ?").run(cutoff);
  db.prepare("DELETE FROM disk_rollups WHERE bucket_ms < ?").run(cutoff);
  db.prepare("DELETE FROM disk_io_rollups WHERE bucket_ms < ?").run(cutoff);
  db.prepare("DELETE FROM network_rollups WHERE bucket_ms < ?").run(cutoff);
  db.prepare("DELETE FROM alert_events WHERE ts < ?").run(cutoff);
  db.prepare("DELETE FROM notification_events WHERE ts < ?").run(cutoff);
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
  if (platform() === "linux" && existsSync("/proc/stat")) {
    const parsed = parseProcStat(readFileSync("/proc/stat", "utf8"));
    if (parsed) return parsed;
  }
  return cpuCountersFromOs();
}

export function parseProcStat(output) {
  const lines = String(output || "").split(/\r?\n/).filter((line) => /^cpu\d*\s/.test(line));
  if (!lines.length) return null;
  const snapshots = lines.map((line, index) => {
    const parts = line.trim().split(/\s+/);
    return cpuSnapshotFromValues(parts[0], parts.slice(1).map(Number), index - 1);
  }).filter(Boolean);
  const aggregate = snapshots.find((item) => item.name === "cpu");
  if (!aggregate) return null;
  return { ...aggregate, cores: snapshots.filter((item) => item.name !== "cpu").map((item, index) => ({ ...item, index })) };
}

function cpuCountersFromOs() {
  const cores = cpus().map((cpu, index) => cpuSnapshotFromOsTimes(cpu.times, index));
  const aggregate = cores.reduce((acc, core) => {
    for (const key of ["user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal", "total"]) {
      acc[key] = (acc[key] || 0) + (core[key] || 0);
    }
    return acc;
  }, { name: "cpu", cores: [] });
  return { ...aggregate, cores };
}

function cpuSnapshotFromValues(name, values, index) {
  if (values.length < 4 || values.some((value) => !Number.isFinite(value))) return null;
  const snapshot = {
    name,
    index,
    user: values[0] || 0,
    nice: values[1] || 0,
    system: values[2] || 0,
    idle: values[3] || 0,
    iowait: values[4] || 0,
    irq: values[5] || 0,
    softirq: values[6] || 0,
    steal: values[7] || 0,
  };
  snapshot.total = snapshot.user + snapshot.nice + snapshot.system + snapshot.idle + snapshot.iowait + snapshot.irq + snapshot.softirq + snapshot.steal;
  return snapshot;
}

function cpuSnapshotFromOsTimes(times, index) {
  const snapshot = {
    name: `cpu${index}`,
    index,
    user: Number(times.user) || 0,
    nice: Number(times.nice) || 0,
    system: Number(times.sys) || 0,
    idle: Number(times.idle) || 0,
    iowait: 0,
    irq: Number(times.irq) || 0,
    softirq: 0,
    steal: 0,
  };
  snapshot.total = snapshot.user + snapshot.nice + snapshot.system + snapshot.idle + snapshot.irq;
  return snapshot;
}

function cpuPercent(previous, current) {
  if (!previous || !Number.isFinite(previous.total) || previous.total <= 0) return 0;
  const idle = (current.idle + current.iowait) - (previous.idle + (previous.iowait || 0));
  const total = current.total - previous.total;
  if (total <= 0) return 0;
  return roundPercent((1 - idle / total) * 100);
}

function cpuBreakdown(previous, current) {
  if (!previous || !Number.isFinite(previous.total) || previous.total <= 0) {
    return { user: 0, nice: 0, system: 0, idle: 0, iowait: 0, irq: 0, steal: 0 };
  }
  const total = current.total - previous.total;
  if (total <= 0) return { user: 0, nice: 0, system: 0, idle: 0, iowait: 0, irq: 0, steal: 0 };
  return {
    user: counterPercent(previous, current, "user", total),
    nice: counterPercent(previous, current, "nice", total),
    system: counterPercent(previous, current, "system", total),
    idle: counterPercent(previous, current, "idle", total),
    iowait: counterPercent(previous, current, "iowait", total),
    irq: roundPercent((counterDelta(previous, current, "irq") + counterDelta(previous, current, "softirq")) / total * 100),
    steal: counterPercent(previous, current, "steal", total),
  };
}

function cpuCoreUsage(previous = [], current = []) {
  const previousByIndex = new Map((Array.isArray(previous) ? previous : []).map((core) => [Number(core.index), core]));
  return current.map((core, index) => {
    const old = previousByIndex.get(Number(core.index ?? index));
    const breakdown = cpuBreakdown(old, core);
    return {
      index: Number(core.index ?? index),
      percent: roundPercent(100 - (breakdown.idle || 0) - (breakdown.iowait || 0)),
      user: breakdown.user,
      system: breakdown.system,
      idle: breakdown.idle,
      iowait: breakdown.iowait,
      steal: breakdown.steal,
    };
  });
}

function counterDelta(previous, current, key) {
  return Math.max(0, (Number(current?.[key]) || 0) - (Number(previous?.[key]) || 0));
}

function counterPercent(previous, current, key, total) {
  return roundPercent((counterDelta(previous, current, key) / Math.max(1, total)) * 100);
}

function collectMemoryCounters() {
  if (platform() === "linux" && existsSync("/proc/meminfo")) {
    const meminfo = parseProcMeminfo(readFileSync("/proc/meminfo", "utf8"));
    const vmstat = existsSync("/proc/vmstat") ? parseProcVmstat(readFileSync("/proc/vmstat", "utf8")) : {};
    return {
      ...meminfo,
      pressure: existsSync("/proc/pressure/memory") ? parseProcPressureMemory(readFileSync("/proc/pressure/memory", "utf8")) : emptyPressure(),
      pageFaults: Number(vmstat.pgfault) || 0,
      majorPageFaults: Number(vmstat.pgmajfault) || 0,
    };
  }
  return memoryCountersFromOs();
}

function memoryCountersFromOs() {
  const total = totalmem();
  const free = freemem();
  return {
    totalBytes: total,
    freeBytes: free,
    availableBytes: free,
    usedBytes: Math.max(0, total - free),
    swapTotalBytes: 0,
    swapFreeBytes: 0,
    swapUsedBytes: 0,
    pressure: emptyPressure(),
    pageFaults: 0,
    majorPageFaults: 0,
    ...collectPlatformSwap(),
  };
}

export function parseProcMeminfo(output) {
  const values = {};
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s+(\d+)/);
    if (match) values[match[1]] = Number(match[2]) * 1024;
  }
  const total = values.MemTotal || totalmem();
  const available = values.MemAvailable || values.MemFree || freemem();
  const free = values.MemFree || available;
  const used = Math.max(0, total - available);
  const swapTotal = values.SwapTotal || 0;
  const swapFree = values.SwapFree || 0;
  return {
    totalBytes: total,
    freeBytes: free,
    availableBytes: available,
    usedBytes: used,
    swapTotalBytes: swapTotal,
    swapFreeBytes: swapFree,
    swapUsedBytes: Math.max(0, swapTotal - swapFree),
  };
}

export function parseProcVmstat(output) {
  const values = {};
  for (const line of String(output || "").split(/\r?\n/)) {
    const [key, value] = line.trim().split(/\s+/);
    if (key) values[key] = Number(value) || 0;
  }
  return values;
}

export function parseProcPressureMemory(output) {
  const pressure = emptyPressure();
  for (const line of String(output || "").split(/\r?\n/)) {
    const [type, ...pairs] = line.trim().split(/\s+/);
    if (type !== "some" && type !== "full") continue;
    const row = {};
    for (const pair of pairs) {
      const [key, value] = pair.split("=");
      row[key] = Number(value) || 0;
    }
    pressure[type] = {
      avg10: roundNumber(row.avg10),
      avg60: roundNumber(row.avg60),
      avg300: roundNumber(row.avg300),
      total: Number(row.total) || 0,
    };
  }
  return pressure;
}

function emptyPressure() {
  return {
    some: { avg10: 0, avg60: 0, avg300: 0, total: 0 },
    full: { avg10: 0, avg60: 0, avg300: 0, total: 0 },
  };
}

function collectPlatformSwap() {
  if (platform() === "darwin") return parseDarwinSwapUsage(run("sysctl", ["-n", "vm.swapusage"]));
  if (platform() === "win32") {
    return parseWindowsSwapOutput(run("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_OperatingSystem | Select-Object TotalVirtualMemorySize,FreeVirtualMemory,TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json -Compress"]));
  }
  return {};
}

export function parseDarwinSwapUsage(output) {
  const match = String(output || "").match(/total\s*=\s*([\d.]+)([MG])\s+used\s*=\s*([\d.]+)([MG])\s+free\s*=\s*([\d.]+)([MG])/i);
  if (!match) return {};
  const total = unitToBytes(match[1], match[2]);
  const used = unitToBytes(match[3], match[4]);
  const free = unitToBytes(match[5], match[6]);
  return { swapTotalBytes: total, swapUsedBytes: used, swapFreeBytes: free };
}

export function parseWindowsSwapOutput(output) {
  try {
    const row = JSON.parse(String(output || "{}"));
    const totalVirtual = Number(row.TotalVirtualMemorySize) * 1024 || 0;
    const freeVirtual = Number(row.FreeVirtualMemory) * 1024 || 0;
    const totalPhysical = Number(row.TotalVisibleMemorySize) * 1024 || 0;
    const freePhysical = Number(row.FreePhysicalMemory) * 1024 || 0;
    const swapTotal = Math.max(0, totalVirtual - totalPhysical);
    const swapFree = Math.max(0, freeVirtual - freePhysical);
    return { swapTotalBytes: swapTotal, swapFreeBytes: swapFree, swapUsedBytes: Math.max(0, swapTotal - swapFree) };
  } catch {
    return {};
  }
}

function memorySample(previous = {}, current = collectMemoryCounters(), previousMs = 0, nowMs = Date.now()) {
  const total = Number(current.totalBytes) || totalmem();
  const available = Number(current.availableBytes) || Number(current.freeBytes) || freemem();
  const free = Number(current.freeBytes) || available;
  const used = Number(current.usedBytes) || Math.max(0, total - available);
  const swapTotal = Number(current.swapTotalBytes) || 0;
  const swapUsed = Number(current.swapUsedBytes) || 0;
  const elapsedSeconds = previousMs ? Math.max(1, (nowMs - Number(previousMs)) / 1000) : 1;
  return {
    totalBytes: total,
    freeBytes: free,
    availableBytes: available,
    usedBytes: used,
    percent: total > 0 ? roundPercent((used / total) * 100) : 0,
    swapTotalBytes: swapTotal,
    swapFreeBytes: Number(current.swapFreeBytes) || 0,
    swapUsedBytes: swapUsed,
    swapPercent: swapTotal > 0 ? roundPercent((swapUsed / swapTotal) * 100) : 0,
    pressure: current.pressure || emptyPressure(),
    pageFaults: Number(current.pageFaults) || 0,
    majorPageFaults: Number(current.majorPageFaults) || 0,
    pageFaultsPerSec: previous?.pageFaults ? Math.max(0, Math.round((Number(current.pageFaults) - Number(previous.pageFaults)) / elapsedSeconds)) : 0,
    majorPageFaultsPerSec: previous?.majorPageFaults ? Math.max(0, roundNumber((Number(current.majorPageFaults) - Number(previous.majorPageFaults)) / elapsedSeconds)) : 0,
  };
}

function collectDisks(settings = normalizeSettings()) {
  if (platform() === "win32") {
    return parseWindowsDiskOutput(run("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_LogicalDisk -Filter DriveType=3 | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress"]));
  }
  const disks = mergeDiskInodes(parseDf(run("df", ["-kP"])), settings.trackInodes ? parseDfInodes(run("df", ["-iP"])) : []);
  return disks.filter((disk) => !isPseudoDisk(disk));
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
    .filter((item) => Number.isFinite(item.totalBytes) && item.totalBytes > 0)
    .filter((item) => !isPseudoDisk(item));
}

export function parseDfInodes(output) {
  return String(output || "")
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 6)
    .map((parts) => {
      const total = Number(parts[1]) || 0;
      const used = Number(parts[2]) || 0;
      const available = Number(parts[3]) || 0;
      return {
        filesystem: parts[0],
        mount: parts.slice(5).join(" "),
        inodesTotal: total,
        inodesUsed: used,
        inodesAvailable: available,
        inodesPercent: total > 0 ? roundPercent((used / total) * 100) : 0,
      };
    })
    .filter((item) => item.inodesTotal > 0)
    .filter((item) => !isPseudoDisk(item));
}

function mergeDiskInodes(disks, inodes) {
  const byKey = new Map((inodes || []).map((item) => [`${item.mount}\0${item.filesystem}`, item]));
  return (disks || []).map((disk) => ({ ...disk, ...(byKey.get(`${disk.mount}\0${disk.filesystem}`) || {}) }));
}

function isPseudoDisk(disk) {
  const fs = String(disk?.filesystem || "").toLowerCase();
  const mount = String(disk?.mount || "");
  if (!mount || mount === "/" || /^[A-Z]:\\?$/i.test(mount)) return false;
  if (PSEUDO_FILESYSTEMS.has(fs)) return true;
  if (fs === "overlay" && mount !== "/") return true;
  if (mount.startsWith("/tmp/.mount_")) return true;
  return PSEUDO_MOUNT_PREFIXES.some((prefix) => mount === prefix || mount.startsWith(`${prefix}/`));
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

function collectDiskIoCounters() {
  if (platform() === "linux" && existsSync("/proc/diskstats")) {
    return parseProcDiskStats(readFileSync("/proc/diskstats", "utf8"), linuxBlockDeviceNames());
  }
  if (platform() === "win32") {
    return parseWindowsDiskIoOutput(run("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_PerfFormattedData_PerfDisk_LogicalDisk | Where-Object {$_.Name -ne '_Total'} | Select-Object Name,DiskReadBytesPersec,DiskWriteBytesPersec,DiskReadsPersec,DiskWritesPersec,PercentDiskTime,CurrentDiskQueueLength,AvgDisksecPerRead,AvgDisksecPerWrite | ConvertTo-Json -Compress"]));
  }
  if (platform() === "darwin") {
    return parseDarwinIostatOutput(run("iostat", ["-Id", "-K"]));
  }
  return [];
}

export function parseProcDiskStats(output, allowedDevices = null) {
  const allowed = allowedDevices && allowedDevices.size ? allowedDevices : null;
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 14)
    .map((parts) => {
      const name = parts[2];
      if (!isDiskIoDevice(name, allowed)) return null;
      const reads = Number(parts[3]) || 0;
      const sectorsRead = Number(parts[5]) || 0;
      const readTimeMs = Number(parts[6]) || 0;
      const writes = Number(parts[7]) || 0;
      const sectorsWritten = Number(parts[9]) || 0;
      const writeTimeMs = Number(parts[10]) || 0;
      return {
        name,
        reads,
        writes,
        readBytes: sectorsRead * 512,
        writeBytes: sectorsWritten * 512,
        readTimeMs,
        writeTimeMs,
        ioTimeMs: Number(parts[12]) || 0,
        weightedIoTimeMs: Number(parts[13]) || 0,
      };
    })
    .filter(Boolean);
}

function linuxBlockDeviceNames() {
  try {
    return new Set(readdirSync("/sys/block").filter((name) => !/^(loop|ram|fd|sr)/.test(name)));
  } catch {
    return null;
  }
}

function isDiskIoDevice(name, allowed) {
  if (!name || /^(loop|ram|fd|sr)/.test(name)) return false;
  if (allowed) return allowed.has(name);
  return !/(?:\d+p?\d+|p\d+)$/.test(name);
}

export function parseWindowsDiskIoOutput(output) {
  try {
    const parsed = JSON.parse(String(output || "[]"));
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => ({
      name: String(row.Name || ""),
      readBytesPerSec: Number(row.DiskReadBytesPersec) || 0,
      writeBytesPerSec: Number(row.DiskWriteBytesPersec) || 0,
      readIops: Number(row.DiskReadsPersec) || 0,
      writeIops: Number(row.DiskWritesPersec) || 0,
      busyPercent: roundPercent(Number(row.PercentDiskTime) || 0),
      queueDepth: Number(row.CurrentDiskQueueLength) || 0,
      readLatencyMs: (Number(row.AvgDisksecPerRead) || 0) * 1000,
      writeLatencyMs: (Number(row.AvgDisksecPerWrite) || 0) * 1000,
      rateSample: true,
    })).filter((row) => row.name);
  } catch {
    return [];
  }
}

export function parseDarwinIostatOutput(output) {
  const lines = String(output || "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 3) return [];
  const deviceLine = lines.find((line) => /^disk\d/.test(line.trim()));
  const valueLine = lines.at(-1);
  if (!deviceLine || !valueLine) return [];
  const devices = deviceLine.trim().split(/\s+/).filter((item) => /^disk/.test(item));
  const values = valueLine.trim().split(/\s+/).map(Number);
  return devices.map((name, index) => {
    const offset = index * 3;
    const tps = values[offset + 1] || 0;
    const mbps = values[offset + 2] || 0;
    return {
      name,
      readBytesPerSec: 0,
      writeBytesPerSec: Math.max(0, mbps * 1024 * 1024),
      readIops: 0,
      writeIops: tps,
      busyPercent: 0,
      queueDepth: 0,
      readLatencyMs: 0,
      writeLatencyMs: 0,
      rateSample: true,
    };
  });
}

function diskIoSample(previous = [], current = [], previousMs = 0, nowMs = Date.now()) {
  const previousByName = new Map((Array.isArray(previous) ? previous : []).map((item) => [item.name, item]));
  const elapsedSeconds = previousMs ? Math.max(1, (nowMs - Number(previousMs)) / 1000) : 1;
  const elapsedMs = elapsedSeconds * 1000;
  return current.map((item) => {
    if (item.rateSample) return { ...item };
    const old = previousByName.get(item.name);
    const reads = old ? counterDelta(old, item, "reads") : 0;
    const writes = old ? counterDelta(old, item, "writes") : 0;
    const readBytes = old ? counterDelta(old, item, "readBytes") : 0;
    const writeBytes = old ? counterDelta(old, item, "writeBytes") : 0;
    const readTime = old ? counterDelta(old, item, "readTimeMs") : 0;
    const writeTime = old ? counterDelta(old, item, "writeTimeMs") : 0;
    return {
      name: item.name,
      readBytes: item.readBytes,
      writeBytes: item.writeBytes,
      reads: item.reads,
      writes: item.writes,
      readBytesPerSec: Math.round(readBytes / elapsedSeconds),
      writeBytesPerSec: Math.round(writeBytes / elapsedSeconds),
      readIops: roundNumber(reads / elapsedSeconds),
      writeIops: roundNumber(writes / elapsedSeconds),
      busyPercent: old ? roundPercent((counterDelta(old, item, "ioTimeMs") / elapsedMs) * 100) : 0,
      queueDepth: old ? roundNumber(counterDelta(old, item, "weightedIoTimeMs") / elapsedMs) : 0,
      readLatencyMs: reads > 0 ? roundNumber(readTime / reads) : 0,
      writeLatencyMs: writes > 0 ? roundNumber(writeTime / writes) : 0,
    };
  });
}

function collectNetworkCounters() {
  if (platform() === "linux" && existsSync("/proc/net/dev")) {
    return parseProcNetDev(readFileSync("/proc/net/dev", "utf8"));
  }
  if (platform() === "darwin") {
    return parseNetstatIb(run("netstat", ["-ib"]));
  }
  if (platform() === "win32") {
    return parseWindowsNetworkOutput(run("powershell.exe", ["-NoProfile", "-Command", "Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes,ReceivedPacketErrors,OutboundPacketErrors,ReceivedDiscardedPackets,OutboundDiscardedPackets | ConvertTo-Json -Compress"]));
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
      return {
        name: name.trim(),
        rxBytes: parts[0],
        rxErrors: parts[2] || 0,
        rxDropped: parts[3] || 0,
        txBytes: parts[8],
        txErrors: parts[10] || 0,
        txDropped: parts[11] || 0,
      };
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
    const rxErrors = Number(parts[4]) || 0;
    const txBytes = Number(parts[9]);
    const txErrors = Number(parts[11]) || 0;
    if (!name || name === "lo0" || !Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue;
    const previous = map.get(name) || { name, rxBytes: 0, txBytes: 0, rxErrors: 0, txErrors: 0, rxDropped: 0, txDropped: 0 };
    previous.rxBytes += rxBytes;
    previous.txBytes += txBytes;
    previous.rxErrors += rxErrors;
    previous.txErrors += txErrors;
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
      rxErrors: Number(item.ReceivedPacketErrors) || 0,
      txErrors: Number(item.OutboundPacketErrors) || 0,
      rxDropped: Number(item.ReceivedDiscardedPackets) || 0,
      txDropped: Number(item.OutboundDiscardedPackets) || 0,
    })).filter((item) => item.name);
  } catch {
    return [];
  }
}

function networkSample(previous = [], current = [], previousMs = 0, nowMs = Date.now()) {
  const previousByName = new Map((Array.isArray(previous) ? previous : []).map((item) => [item.name, item]));
  const elapsedSeconds = previousMs ? Math.max(1, (nowMs - Number(previousMs)) / 1000) : 1;
  return current.map((item) => {
    const old = previousByName.get(item.name);
    return {
      ...item,
      rxBytesPerSec: old ? Math.max(0, Math.round((item.rxBytes - old.rxBytes) / elapsedSeconds)) : 0,
      txBytesPerSec: old ? Math.max(0, Math.round((item.txBytes - old.txBytes) / elapsedSeconds)) : 0,
      rxErrorsPerSec: old ? Math.max(0, roundNumber((Number(item.rxErrors || 0) - Number(old.rxErrors || 0)) / elapsedSeconds)) : 0,
      txErrorsPerSec: old ? Math.max(0, roundNumber((Number(item.txErrors || 0) - Number(old.txErrors || 0)) / elapsedSeconds)) : 0,
      rxDroppedPerSec: old ? Math.max(0, roundNumber((Number(item.rxDropped || 0) - Number(old.rxDropped || 0)) / elapsedSeconds)) : 0,
      txDroppedPerSec: old ? Math.max(0, roundNumber((Number(item.txDropped || 0) - Number(old.txDropped || 0)) / elapsedSeconds)) : 0,
    };
  });
}

function collectNetworkHealthCounters() {
  if (platform() === "linux" && existsSync("/proc/net/snmp")) {
    return parseProcNetSnmp(readFileSync("/proc/net/snmp", "utf8"));
  }
  return {};
}

export function parseProcNetSnmp(output) {
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].startsWith("Tcp:") || !lines[index + 1].startsWith("Tcp:")) continue;
    const headers = lines[index].split(/\s+/).slice(1);
    const values = lines[index + 1].split(/\s+/).slice(1).map(Number);
    const row = Object.fromEntries(headers.map((header, rowIndex) => [header, values[rowIndex] || 0]));
    return { tcpRetransmits: Number(row.RetransSegs) || 0 };
  }
  return {};
}

function networkHealthSample(previous = {}, current = {}, previousMs = 0, nowMs = Date.now(), network = []) {
  const elapsedSeconds = previousMs ? Math.max(1, (nowMs - Number(previousMs)) / 1000) : 1;
  const totals = networkSummary(network, current);
  return {
    ...totals,
    tcpRetransmits: Number(current.tcpRetransmits) || 0,
    tcpRetransmitsPerSec: previous?.tcpRetransmits ? Math.max(0, roundNumber((Number(current.tcpRetransmits) - Number(previous.tcpRetransmits)) / elapsedSeconds)) : 0,
  };
}

function collectThermals() {
  if (platform() !== "linux" || !existsSync("/sys/class/thermal")) return [];
  try {
    return readdirSync("/sys/class/thermal").filter((entry) => entry.startsWith("thermal_zone")).map((entry) => {
      const root = path.join("/sys/class/thermal", entry);
      const raw = Number(readFileSync(path.join(root, "temp"), "utf8").trim());
      const label = readFileIfExists(path.join(root, "type")) || entry;
      return { label: label.trim(), celsius: raw > 1000 ? roundNumber(raw / 1000) : roundNumber(raw) };
    }).filter((item) => Number.isFinite(item.celsius));
  } catch {
    return [];
  }
}

function collectBattery() {
  if (platform() === "linux" && existsSync("/sys/class/power_supply")) {
    try {
      const battery = readdirSync("/sys/class/power_supply").find((entry) => /^BAT/i.test(entry));
      if (!battery) return null;
      const root = path.join("/sys/class/power_supply", battery);
      const percent = Number(readFileIfExists(path.join(root, "capacity")));
      const status = readFileIfExists(path.join(root, "status")) || "";
      return Number.isFinite(percent) ? { percent: roundPercent(percent), status: status.trim() } : null;
    } catch {
      return null;
    }
  }
  if (platform() === "darwin") return parseDarwinBattery(run("pmset", ["-g", "batt"]));
  if (platform() === "win32") return parseWindowsBatteryOutput(run("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress"]));
  return null;
}

export function parseDarwinBattery(output) {
  const percent = Number(String(output || "").match(/(\d+)%/)?.[1]);
  if (!Number.isFinite(percent)) return null;
  const status = /discharging/i.test(output) ? "Discharging" : /charging/i.test(output) ? "Charging" : "Charged";
  return { percent: roundPercent(percent), status };
}

export function parseWindowsBatteryOutput(output) {
  try {
    const parsed = JSON.parse(String(output || "null"));
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const row = rows.find(Boolean);
    if (!row) return null;
    const statusMap = { 1: "Discharging", 2: "AC", 3: "Fully charged", 6: "Charging", 7: "Charging" };
    return { percent: roundPercent(Number(row.EstimatedChargeRemaining) || 0), status: statusMap[row.BatteryStatus] || String(row.BatteryStatus || "") };
  } catch {
    return null;
  }
}

function diskIoSummary(rows = []) {
  return (Array.isArray(rows) ? rows : []).reduce((acc, row) => {
    acc.readBytesPerSec += Number(row.readBytesPerSec) || 0;
    acc.writeBytesPerSec += Number(row.writeBytesPerSec) || 0;
    acc.readIops += Number(row.readIops) || 0;
    acc.writeIops += Number(row.writeIops) || 0;
    acc.maxBusyPercent = Math.max(acc.maxBusyPercent, Number(row.busyPercent) || 0);
    return acc;
  }, { readBytesPerSec: 0, writeBytesPerSec: 0, readIops: 0, writeIops: 0, maxBusyPercent: 0 });
}

function networkSummary(rows = [], health = {}) {
  const totals = (Array.isArray(rows) ? rows : []).reduce((acc, row) => {
    acc.rxBytesPerSec += Number(row.rxBytesPerSec) || 0;
    acc.txBytesPerSec += Number(row.txBytesPerSec) || 0;
    acc.errors += (Number(row.rxErrors) || 0) + (Number(row.txErrors) || 0);
    acc.drops += (Number(row.rxDropped) || 0) + (Number(row.txDropped) || 0);
    return acc;
  }, { rxBytesPerSec: 0, txBytesPerSec: 0, errors: 0, drops: 0 });
  return {
    ...totals,
    tcpRetransmits: Number(health?.tcpRetransmits) || 0,
    tcpRetransmitsPerSec: Number(health?.tcpRetransmitsPerSec) || 0,
  };
}

function thermalSummary(rows = []) {
  const values = (Array.isArray(rows) ? rows : []).map((row) => Number(row.celsius)).filter(Number.isFinite);
  return { maxCelsius: values.length ? Math.max(...values) : null };
}

function primaryDisk(disks) {
  if (!Array.isArray(disks) || !disks.length) return null;
  const usable = disks.filter((disk) => Number(disk?.totalBytes) > 0);
  if (!usable.length) return null;
  const preferred = usable.find((disk) => disk.mount === "/")
    || usable.find((disk) => /^[A-Z]:\\?$/i.test(String(disk.mount || "")))
    || usable.find((disk) => String(disk.mount || "").toLowerCase() === "/system/volumes/data")
    || usable.find((disk) => String(disk.mount || "").toLowerCase() === "/users")
    || null;
  return preferred || [...usable].sort((a, b) => (Number(b.totalBytes) || 0) - (Number(a.totalBytes) || 0))[0];
}

function buildAlerts(sample, settings, state = {}) {
  const thresholds = settings.thresholds || DEFAULT_THRESHOLDS;
  const alerts = [];
  addThresholdAlert(alerts, "CPU", sample.cpu?.percent, thresholds.cpuPercent, "%", thresholds.criticalPercent);
  addThresholdAlert(alerts, "Memory", sample.memory?.percent, thresholds.memoryPercent, "%", thresholds.criticalPercent);
  addThresholdAlert(alerts, "Swap", sample.memory?.swapPercent, thresholds.swapPercent, "%", thresholds.criticalPercent);
  addThresholdAlert(alerts, "CPU iowait", sample.cpu?.breakdown?.iowait, thresholds.iowaitPercent, "%", thresholds.criticalPercent);
  addThresholdAlert(alerts, "Disk busy", diskIoSummary(sample.diskIo).maxBusyPercent, thresholds.diskBusyPercent, "%", thresholds.criticalPercent);
  const disk = primaryDisk(sample.disk);
  if (disk) addThresholdAlert(alerts, `Disk ${disk.mount || disk.filesystem}`, disk.percent, thresholds.diskPercent, "%", thresholds.criticalPercent);
  const inodeDisk = (sample.disk || []).find((row) => Number(row.inodesPercent) >= thresholds.diskPercent);
  if (inodeDisk) addThresholdAlert(alerts, `Inodes ${inodeDisk.mount || inodeDisk.filesystem}`, inodeDisk.inodesPercent, thresholds.diskPercent, "%", thresholds.criticalPercent);
  const silenced = new Set(settings.silencedAlertLabels || []);
  return alerts.filter((alert) => !silenced.has(alert.label) && !isAlertAcknowledged(state, sample.node?.id || "", alert.label));
}

function isAlertAcknowledged(state, nodeId, label) {
  const acknowledgements = state.acknowledgedAlerts || {};
  const now = Date.now();
  const specific = Number(acknowledgements[`${nodeId}\0${label}`]) || 0;
  const global = Number(acknowledgements[`*\0${label}`]) || 0;
  return specific > now || global > now;
}

function addThresholdAlert(alerts, label, value, threshold, unit, criticalThreshold = DEFAULT_THRESHOLDS.criticalPercent) {
  const numeric = Number(value);
  const limit = Number(threshold);
  if (!Number.isFinite(numeric) || !Number.isFinite(limit) || limit <= 0 || numeric < limit) return;
  alerts.push({ level: numeric >= Number(criticalThreshold) ? "critical" : "warning", label, value: roundNumber(numeric), threshold: limit, unit });
}

function updateRollups(db, sample) {
  const sampleId = sample.id || 0;
  const nodeId = sample.node?.id || "";
  for (const [period, periodMs] of Object.entries(ROLLUP_PERIODS)) {
    const bucket = Math.floor(Number(sample.timestampMs) / periodMs) * periodMs;
    const from = bucket;
    const to = bucket + periodMs;
    const core = db.prepare(`
      SELECT count(*) AS sample_count,
        avg(cpu_percent) AS cpu_avg,
        max(cpu_percent) AS cpu_max,
        avg(cpu_iowait_percent) AS iowait_avg,
        avg(memory_percent) AS memory_avg,
        max(memory_percent) AS memory_max,
        avg(memory_used_bytes) AS memory_used_avg,
        avg(memory_available_bytes) AS memory_available_avg,
        avg(memory_total_bytes) AS memory_total_avg,
        avg(swap_percent) AS swap_avg,
        max(swap_percent) AS swap_max,
        avg(swap_used_bytes) AS swap_used_avg,
        avg(swap_free_bytes) AS swap_free_avg,
        avg(swap_total_bytes) AS swap_total_avg,
        avg(network_rx_bps_total) AS rx_avg,
        max(network_rx_bps_total) AS rx_max,
        avg(network_tx_bps_total) AS tx_avg,
        max(network_tx_bps_total) AS tx_max,
        avg(disk_read_bps_total) AS disk_read_avg,
        avg(disk_write_bps_total) AS disk_write_avg,
        max(alerts_count) AS alerts_count
      FROM samples
      WHERE node_id = ? AND ts >= ? AND ts < ?
    `).get(nodeId, from, to);
    const disk = db.prepare(`
      SELECT avg(disks.percent) AS disk_avg, max(disks.percent) AS disk_max
      FROM disks
      JOIN samples ON samples.id = disks.sample_id
      WHERE samples.node_id = ? AND samples.ts >= ? AND samples.ts < ?
    `).get(nodeId, from, to);
    db.prepare(`
      INSERT OR REPLACE INTO rollups(
        period, bucket_ms, node_id, sample_count, cpu_percent_avg, cpu_percent_max, cpu_iowait_avg,
        memory_percent_avg, memory_percent_max, memory_used_bytes_avg, memory_available_bytes_avg, memory_total_bytes_avg,
        swap_percent_avg, swap_percent_max, swap_used_bytes_avg, swap_free_bytes_avg, swap_total_bytes_avg,
        disk_percent_avg, disk_percent_max, rx_bps_avg, rx_bps_max, tx_bps_avg, tx_bps_max,
        disk_read_bps_avg, disk_write_bps_avg, alerts_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      period,
      bucket,
      nodeId,
      Number(core?.sample_count) || (sampleId ? 1 : 0),
      numberOrNull(core?.cpu_avg),
      numberOrNull(core?.cpu_max),
      numberOrNull(core?.iowait_avg),
      numberOrNull(core?.memory_avg),
      numberOrNull(core?.memory_max),
      integerOrNull(core?.memory_used_avg),
      integerOrNull(core?.memory_available_avg),
      integerOrNull(core?.memory_total_avg),
      numberOrNull(core?.swap_avg),
      numberOrNull(core?.swap_max),
      integerOrNull(core?.swap_used_avg),
      integerOrNull(core?.swap_free_avg),
      integerOrNull(core?.swap_total_avg),
      numberOrNull(disk?.disk_avg),
      numberOrNull(disk?.disk_max),
      numberOrNull(core?.rx_avg),
      numberOrNull(core?.rx_max),
      numberOrNull(core?.tx_avg),
      numberOrNull(core?.tx_max),
      numberOrNull(core?.disk_read_avg),
      numberOrNull(core?.disk_write_avg),
      integerOrNull(core?.alerts_count),
    );
    const diskRows = db.prepare(`
      SELECT disks.mount AS mount, disks.filesystem AS filesystem,
        avg(disks.percent) AS percent_avg,
        max(disks.percent) AS percent_max,
        avg(disks.used_bytes) AS used_bytes_avg,
        avg(disks.total_bytes) AS total_bytes_avg,
        max(disks.inodes_percent) AS inodes_percent_max
      FROM disks
      JOIN samples ON samples.id = disks.sample_id
      WHERE samples.node_id = ? AND samples.ts >= ? AND samples.ts < ?
      GROUP BY disks.mount, disks.filesystem
    `).all(nodeId, from, to);
    const diskRollupStmt = db.prepare(`
      INSERT OR REPLACE INTO disk_rollups(period, bucket_ms, node_id, mount, filesystem, percent_avg, percent_max, used_bytes_avg, total_bytes_avg, inodes_percent_max)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of diskRows) {
      diskRollupStmt.run(period, bucket, nodeId, row.mount || "", row.filesystem || "", numberOrNull(row.percent_avg), numberOrNull(row.percent_max), integerOrNull(row.used_bytes_avg), integerOrNull(row.total_bytes_avg), numberOrNull(row.inodes_percent_max));
    }
    const diskIoRows = db.prepare(`
      SELECT disk_io.device AS device,
        avg(disk_io.read_bps) AS read_bps_avg,
        avg(disk_io.write_bps) AS write_bps_avg,
        max(disk_io.busy_percent) AS busy_percent_max,
        avg(disk_io.queue_depth) AS queue_depth_avg
      FROM disk_io
      JOIN samples ON samples.id = disk_io.sample_id
      WHERE samples.node_id = ? AND samples.ts >= ? AND samples.ts < ?
      GROUP BY disk_io.device
    `).all(nodeId, from, to);
    const diskIoRollupStmt = db.prepare(`
      INSERT OR REPLACE INTO disk_io_rollups(period, bucket_ms, node_id, device, read_bps_avg, write_bps_avg, busy_percent_max, queue_depth_avg)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of diskIoRows) {
      diskIoRollupStmt.run(period, bucket, nodeId, row.device || "", numberOrNull(row.read_bps_avg), numberOrNull(row.write_bps_avg), numberOrNull(row.busy_percent_max), numberOrNull(row.queue_depth_avg));
    }
    const networkRows = db.prepare(`
      SELECT network.interface AS interface,
        avg(network.rx_bps) AS rx_bps_avg,
        avg(network.tx_bps) AS tx_bps_avg,
        max(network.rx_errors) AS rx_errors_max,
        max(network.tx_errors) AS tx_errors_max,
        max(network.rx_dropped) AS rx_dropped_max,
        max(network.tx_dropped) AS tx_dropped_max
      FROM network
      JOIN samples ON samples.id = network.sample_id
      WHERE samples.node_id = ? AND samples.ts >= ? AND samples.ts < ?
      GROUP BY network.interface
    `).all(nodeId, from, to);
    const networkRollupStmt = db.prepare(`
      INSERT OR REPLACE INTO network_rollups(period, bucket_ms, node_id, interface, rx_bps_avg, tx_bps_avg, rx_errors_max, tx_errors_max, rx_dropped_max, tx_dropped_max)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of networkRows) {
      networkRollupStmt.run(period, bucket, nodeId, row.interface || "", numberOrNull(row.rx_bps_avg), numberOrNull(row.tx_bps_avg), integerOrNull(row.rx_errors_max), integerOrNull(row.tx_errors_max), integerOrNull(row.rx_dropped_max), integerOrNull(row.tx_dropped_max));
    }
  }
}

function rebuildRollups(db, input = {}) {
  const limit = Math.max(0, Math.round(Number(input.limit) || 0));
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM rollups; DELETE FROM disk_rollups; DELETE FROM disk_io_rollups; DELETE FROM network_rollups;");
    const rows = db.prepare(`SELECT * FROM samples ORDER BY ts ASC${limit ? " LIMIT ?" : ""}`).all(...(limit ? [limit] : []));
    for (const row of rows) updateRollups(db, hydrateSample(db, row));
    db.exec("COMMIT");
    return { samples: rows.length };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function buildExport(db, input = {}, settings = normalizeSettings()) {
  const format = String(input.format || "json").toLowerCase();
  const metric = String(input.metric || "").toLowerCase();
  const history = readHistory(db, input, settings);
  const summary = readSummary(db, input, settings);
  const alerts = input.includeAlerts === true || input.includeAlerts === "true" ? readAlertHistory(db, input, settings) : null;
  const notifications = input.includeNotifications === true || input.includeNotifications === "true" ? readNotifications(db, { ...input, includeDelivered: true }, settings) : null;
  const series = metric ? readSeries(db, input, settings) : null;
  const generatedAt = new Date().toISOString();
  if (format === "jsonl") {
    const range = resolveRange(input, settings);
    const nodeId = String(input.nodeId || "");
    const rows = db.prepare(`
      SELECT * FROM samples
      WHERE ts >= ? AND ts <= ? ${nodeId ? "AND node_id = ?" : ""}
      ORDER BY ts ASC
      LIMIT ?
    `).all(...(nodeId ? [range.fromMs, range.toMs, nodeId, range.maxPoints] : [range.fromMs, range.toMs, range.maxPoints]));
    return {
      format: "jsonl",
      filename: `system-monitor-${history.range}-${Date.now()}.jsonl`,
      contentType: "application/x-ndjson",
      data: rows.map((row) => JSON.stringify(hydrateSample(db, row))).join("\n"),
      generatedAt,
    };
  }
  if (format === "csv") {
    const rows = [
      ["timestamp", "cpu_percent", "memory_percent", "swap_percent", "disk_read_bps", "disk_write_bps", "network_rx_bps", "network_tx_bps"],
      ...history.points.map((point) => [
        new Date(Number(point.timestamp)).toISOString(),
        point.cpuPercent,
        point.memoryPercent,
        point.swapPercent,
        point.diskReadBytesPerSec,
        point.diskWriteBytesPerSec,
        point.rxBytesPerSec,
        point.txBytesPerSec,
      ]),
    ];
    return {
      format: "csv",
      filename: `system-monitor-${history.range}-${Date.now()}.csv`,
      contentType: "text/csv",
      data: rows.map((row) => row.map(csvCell).join(",")).join("\n"),
      generatedAt,
    };
  }
  return {
    format: "json",
    filename: `system-monitor-${history.range}-${Date.now()}.json`,
    contentType: "application/json",
    data: JSON.stringify({ generatedAt, history, summary, series, alerts, notifications }, null, 2),
    generatedAt,
  };
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function readFileIfExists(file) {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function unitToBytes(value, unit) {
  const number = Number(value) || 0;
  return Math.round(number * (String(unit).toUpperCase() === "G" ? 1024 ** 3 : 1024 ** 2));
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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

function normalizeSettings(settings = {}) {
  const thresholds = {
    cpuPercent: numberInput(settings.thresholdCpuPercent, DEFAULT_THRESHOLDS.cpuPercent),
    memoryPercent: numberInput(settings.thresholdMemoryPercent, DEFAULT_THRESHOLDS.memoryPercent),
    diskPercent: numberInput(settings.thresholdDiskPercent, DEFAULT_THRESHOLDS.diskPercent),
    swapPercent: numberInput(settings.thresholdSwapPercent, DEFAULT_THRESHOLDS.swapPercent),
    iowaitPercent: numberInput(settings.thresholdIowaitPercent, DEFAULT_THRESHOLDS.iowaitPercent),
    diskBusyPercent: numberInput(settings.thresholdDiskBusyPercent, DEFAULT_THRESHOLDS.diskBusyPercent),
    criticalPercent: numberInput(settings.thresholdCriticalPercent, DEFAULT_THRESHOLDS.criticalPercent),
  };
  const silencedAlertLabels = String(settings.silencedAlertLabels || "").split(",").map((item) => item.trim()).filter(Boolean);
  return {
    sampleIntervalMs: numberInput(settings.sampleIntervalMs, 5000),
    diskSampleIntervalMs: numberInput(settings.diskSampleIntervalMs, 15_000),
    processSampleIntervalMs: numberInput(settings.processSampleIntervalMs, 15_000),
    thermalSampleIntervalMs: numberInput(settings.thermalSampleIntervalMs, 30_000),
    batterySampleIntervalMs: numberInput(settings.batterySampleIntervalMs, 30_000),
    retentionDays: numberInput(settings.retentionDays, 30),
    maxChartPoints: numberInput(settings.maxChartPoints, 240),
    cleanupIntervalMinutes: numberInput(settings.cleanupIntervalMinutes, 30),
    autoRefreshMs: numberInput(settings.autoRefreshMs, 10000),
    trackDisks: settings.trackDisks !== false && settings.trackDisks !== "false",
    trackDiskIo: settings.trackDiskIo !== false && settings.trackDiskIo !== "false",
    trackInodes: settings.trackInodes !== false && settings.trackInodes !== "false",
    trackNetworkInterfaces: settings.trackNetworkInterfaces !== false && settings.trackNetworkInterfaces !== "false",
    trackThermals: settings.trackThermals !== false && settings.trackThermals !== "false",
    trackBattery: settings.trackBattery !== false && settings.trackBattery !== "false",
    trackProcesses: settings.trackProcesses !== false && settings.trackProcesses !== "false",
    maxProcesses: Math.max(1, Math.min(50, Math.round(numberInput(settings.maxProcesses, 10)))),
    alertCooldownMinutes: numberInput(settings.alertCooldownMinutes, 15),
    alertAcknowledgeMinutes: numberInput(settings.alertAcknowledgeMinutes, 60),
    alertChannel: String(settings.alertChannel || "nordrelay"),
    silencedAlertLabels,
    thresholds,
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

function formatCompactNumber(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.round(number));
}

function formatGigabytes(value) {
  return `${(Math.max(0, Number(value) || 0) / 1024 / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} GB`;
}

function formatLoadAverage(cpu = {}) {
  return [cpu.load1, cpu.load5, cpu.load15].map((value) => formatLoadNumber(value)).join(" / ");
}

function formatLoadNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "0.00";
  return parsed.toFixed(2);
}

function formatCpuBreakdown(breakdown = {}) {
  return `${formatNumber(breakdown.user)} / ${formatNumber(breakdown.system)} / ${formatNumber(breakdown.iowait)}%`;
}

function formatMemoryMain(memory = {}) {
  return `${formatGigabytes(memory.usedBytes)} used`;
}

function formatMemoryDetail(memory = {}) {
  return `${formatGigabytes(memory.availableBytes ?? memory.freeBytes)} available / ${formatGigabytes(memory.totalBytes)} total`;
}

function formatSwapMain(memory = {}) {
  return memory.swapTotalBytes ? `${formatGigabytes(memory.swapUsedBytes)} used` : "0 GB used";
}

function formatSwapDetail(memory = {}) {
  return memory.swapTotalBytes ? `${formatGigabytes(memory.swapFreeBytes)} free / ${formatGigabytes(memory.swapTotalBytes)} total` : "No swap configured";
}

function formatDiskMain(disk = {}) {
  return `${formatGigabytes(disk.usedBytes)} used`;
}

function formatDiskDetail(disk = {}) {
  const mount = disk.mount ? `${disk.mount} - ` : "";
  return `${mount}${formatGigabytes(disk.availableBytes)} free / ${formatGigabytes(disk.totalBytes)} total`;
}

function formatInodeDetail(disk = {}) {
  if (!disk.inodesTotal) return "No inode data";
  return `${formatCompactNumber(disk.inodesAvailable)} free / ${formatCompactNumber(disk.inodesTotal)} total`;
}

function formatTopCores(cores = []) {
  const top = (Array.isArray(cores) ? cores : []).slice().sort((a, b) => (Number(b.percent) || 0) - (Number(a.percent) || 0)).slice(0, 4);
  return top.length ? top.map((core) => `#${core.index}: ${formatNumber(core.percent)}%`).join(" | ") : "No per-core data";
}

function formatNetworkHealth(health = {}) {
  return `${formatCompactNumber(health.errors || 0)} errors`;
}

function formatNetworkDrops(health = {}) {
  return `${formatCompactNumber(health.drops || 0)} drops / ${formatNumber(health.tcpRetransmitsPerSec || 0)} retransmits/s`;
}

function formatPressure(pressure = emptyPressure()) {
  return `${formatNumber(pressure.some?.avg10)} / ${formatNumber(pressure.full?.avg10)}`;
}

function formatTimeRange(fromMs, toMs) {
  if (!fromMs || !toMs) return "-";
  return `${new Date(Number(fromMs)).toLocaleString()} - ${new Date(Number(toMs)).toLocaleString()}`;
}

function shortText(value, maxLength) {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function uiBadge(text, status = "disabled") {
  return `<span class="badge ${escapeHtml(status)}">${escapeHtml(text)}</span>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

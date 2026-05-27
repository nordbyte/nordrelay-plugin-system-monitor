import {
  escapeHtml,
  formatBytes,
  formatCompactNumber,
  formatCpuBreakdown,
  formatDiskDetail,
  formatDiskMain,
  formatGigabytes,
  formatInodeDetail,
  formatLoadAverage,
  formatMemoryDetail,
  formatMemoryMain,
  formatNetworkDrops,
  formatNetworkHealth,
  formatNumber,
  formatPressure,
  formatSwapDetail,
  formatSwapMain,
  formatTimeRange,
  formatTopCores,
  shortText,
  uiBadge,
} from './format.js';

const DEFAULT_RANGE = '1h';
const RANGE_PRESETS = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

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

function thermalSummary(rows = []) {
  const values = (Array.isArray(rows) ? rows : []).map((row) => Number(row.celsius)).filter(Number.isFinite);
  return { maxCelsius: values.length ? Math.max(...values) : null };
}

function numberInput(value, fallback) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function renderDashboardPanel(input = {}, context = {}, settings = { autoRefreshMs: 10000 }) {
  const aggregate = input.aggregate && typeof input.aggregate === "object" ? input.aggregate : {};
  const results = Array.isArray(aggregate.results) ? aggregate.results : [];
  const nodes = (results.length ? results : [{ node: context.runtime || { name: "Local node" }, ok: false, error: "No aggregate data available." }])
    .map((item) => ({ ...item, stressScore: nodeStressScore(item) }))
    .sort((a, b) => b.stressScore - a.stressScore);
  const rangeState = panelRangeState(input);
  const range = rangeState.range;
  const maxPoints = numberInput(input.maxPoints, 240);
  const autoRefreshMs = Math.max(1000, numberInput(input.autoRefreshMs, settings.autoRefreshMs));
  const autoRefresh = input.autoRefresh === true || input.autoRefresh === "true";
  const panels = nodes.map((item) => renderNodePanel(item, range)).join("");
  return `<div class="stack" data-system-monitor data-range="${escapeHtml(rangeState.preset || "")}" data-range-ms="${rangeState.rangeMs ? escapeHtml(rangeState.rangeMs) : ""}" data-max-points="${escapeHtml(maxPoints)}" data-auto-refresh-ms="${escapeHtml(autoRefreshMs)}" data-auto-refresh-enabled="${autoRefresh ? "true" : "false"}">
    <div class="section-header">
      <div>
        <h1>System Monitor <small>- ${escapeHtml(nodes.length)} node${nodes.length === 1 ? "" : "s"}</small></h1>
        <small>SQLite-backed history with downsampled charts.</small>
      </div>
      <div class="row">
        ${renderRangeButtons(rangeState.preset || "")}
        <label class="row mini-control"><span>Custom minutes</span><input type="number" min="1" step="1" value="${rangeState.customMinutes ? escapeHtml(rangeState.customMinutes) : ""}" data-custom-minutes placeholder="90"></label>
        <button type="button" class="secondary mini-button" data-custom-range-apply>Apply</button>
        <label class="checkbox"><input type="checkbox" data-auto-refresh${autoRefresh ? " checked" : ""}> Auto refresh</label>
        ${uiBadge(results.length ? "aggregate" : "local", results.length ? "enabled" : "warning")}
      </div>
    </div>
    <div class="panel compact-panel">
      <div class="row">
        <label class="mini-control"><span>Filter nodes</span><input type="search" data-node-filter placeholder="name, host, platform"></label>
        <label class="mini-control"><span>Sort</span><select data-node-sort><option value="stress">Stress</option><option value="cpu">CPU</option><option value="memory">Memory</option><option value="alerts">Alerts</option><option value="name">Name</option></select></label>
        <label class="checkbox"><input type="checkbox" data-alerts-only> Show only alerts</label>
        <button type="button" class="secondary mini-button" data-collapse-all>Collapse all</button>
        <button type="button" class="secondary mini-button" data-expand-all>Expand all</button>
      </div>
    </div>
    ${renderComparisonTable(nodes)}
    ${panels || '<div class="empty-state">No monitor data available.</div>'}
    ${panelScript()}
  </div>`;
}

function panelRangeState(input = {}) {
  if (input.rangeMs !== undefined && input.rangeMs !== null && input.rangeMs !== "") {
    const rangeMs = Math.max(60_000, numberInput(input.rangeMs, RANGE_PRESETS[DEFAULT_RANGE]));
    return { preset: "", range: `${Math.round(rangeMs / 60_000)}m`, rangeMs, customMinutes: Math.round(rangeMs / 60_000) };
  }
  const preset = RANGE_PRESETS[String(input.range || "")] ? String(input.range) : DEFAULT_RANGE;
  return { preset, range: preset, rangeMs: 0, customMinutes: "" };
}

function renderRangeButtons(selected) {
  return Object.keys(RANGE_PRESETS).map((range) => {
    const active = range === selected ? "active" : "";
    return `<button type="button" class="secondary mini-button ${active}" data-range-button="${escapeHtml(range)}">${escapeHtml(range)}</button>`;
  }).join("");
}

function renderComparisonTable(nodes) {
  const rows = nodes.map((item) => {
    const panelData = item.result?.output?.panelData || item.result?.panelData || item.output?.panelData;
    const sample = panelData?.current || item.result?.output?.sample || item.result?.sample || item.output?.sample;
    const name = item.node?.name || sample?.node?.name || item.node?.id || "Node";
    if (!item.ok || !sample) {
      return `<tr><td>${escapeHtml(name)}</td><td colspan="6">${escapeHtml(item.error || "No data")}</td></tr>`;
    }
    const disk = primaryDisk(sample.disk);
    const diskIo = diskIoSummary(sample.diskIo);
    const history = panelData?.history || {};
    const sparkline = renderSparkline(history.points || [], "cpuPercent", "#1d8a5b");
    return `<tr>
      <td>${escapeHtml(name)}</td>
      <td>${escapeHtml(formatNumber(sample.cpu?.percent))}% ${sparkline}</td>
      <td>${escapeHtml(formatNumber(sample.memory?.percent))}%</td>
      <td>${escapeHtml(formatNumber(sample.memory?.swapPercent))}%</td>
      <td>${escapeHtml(disk ? `${formatNumber(disk.percent)}%` : "-")}</td>
      <td>${escapeHtml(formatBytes(diskIo.readBytesPerSec + diskIo.writeBytesPerSec))}/s</td>
      <td>${escapeHtml(sample.alerts?.length || 0)}</td>
    </tr>`;
  }).join("");
  return `<section class="panel">
    <div class="section-header"><h2>Node comparison</h2><small>Sorted by current stress.</small></div>
    <div class="data-table-wrap">
      <table class="data-table">
        <thead><tr><th>Node</th><th>CPU</th><th>Memory</th><th>Swap</th><th>Disk</th><th>I/O</th><th>Alerts</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7">No nodes available.</td></tr>'}</tbody>
      </table>
    </div>
  </section>`;
}

function renderSparkline(points, key, color) {
  const rows = (Array.isArray(points) ? points : []).slice(-24).filter((point) => Number.isFinite(Number(point[key])));
  if (rows.length < 2) return "";
  const width = 80;
  const height = 22;
  const max = Math.max(1, ...rows.map((point) => Number(point[key]) || 0));
  const d = rows.map((point, index) => {
    const x = (index / Math.max(1, rows.length - 1)) * width;
    const y = height - ((Number(point[key]) || 0) / max) * height;
    return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return `<svg class="sparkline" aria-hidden="true" viewBox="0 0 ${width} ${height}" width="80" height="22"><path d="${escapeHtml(d)}" fill="none" stroke="${escapeHtml(color)}" stroke-width="2"></path></svg>`;
}

function nodeStressScore(item) {
  const panelData = item.result?.output?.panelData || item.result?.panelData || item.output?.panelData;
  const sample = panelData?.current || item.result?.output?.sample || item.result?.sample || item.output?.sample;
  if (!item.ok || !sample) return -1;
  const disk = primaryDisk(sample.disk);
  const diskIo = diskIoSummary(sample.diskIo);
  return Math.max(
    Number(sample.cpu?.percent) || 0,
    Number(sample.memory?.percent) || 0,
    Number(sample.memory?.swapPercent) || 0,
    Number(sample.cpu?.breakdown?.iowait) || 0,
    Number(disk?.percent) || 0,
    Number(diskIo.maxBusyPercent) || 0,
    (Number(sample.alerts?.length) || 0) * 100,
  );
}

function renderNodePanel(item, range) {
  const node = item.node || {};
  if (!item.ok) {
    return `<section class="panel" data-monitor-node-panel data-node-name="${escapeHtml(node.name || node.id || "Node")}" data-node-alerts="0" data-node-stress="-1" data-node-cpu="0" data-node-memory="0">
      <div class="section-header"><h2>${escapeHtml(node.name || node.id || "Node")}</h2>${uiBadge("failed", "failed")}</div>
      <div class="error-state">${escapeHtml(item.error || "Plugin unavailable")}</div>
    </section>`;
  }
  const panelData = item.result?.output?.panelData || item.result?.panelData || item.output?.panelData;
  const sample = panelData?.current || item.result?.output?.sample || item.result?.sample || item.output?.sample;
  if (!sample) {
    return `<section class="panel" data-monitor-node-panel data-node-name="${escapeHtml(node.name || node.id || "Node")}" data-node-alerts="0" data-node-stress="0" data-node-cpu="0" data-node-memory="0">
      <div class="section-header"><h2>${escapeHtml(node.name || node.id || "Node")}</h2>${uiBadge("missing", "warning")}</div>
      <div class="empty-state">No metrics sample returned.</div>
    </section>`;
  }
  const disk = primaryDisk(sample.disk);
  const network = Array.isArray(sample.network) ? sample.network.reduce((acc, row) => ({
    rxBytesPerSec: acc.rxBytesPerSec + (Number(row.rxBytesPerSec) || 0),
    txBytesPerSec: acc.txBytesPerSec + (Number(row.txBytesPerSec) || 0),
  }), { rxBytesPerSec: 0, txBytesPerSec: 0 }) : null;
  const diskIo = diskIoSummary(sample.diskIo);
  const thermal = thermalSummary(sample.environment?.thermal);
  const battery = sample.environment?.battery;
  const history = panelData?.history || { points: [], disks: [], network: [] };
  const summary = panelData?.summary || {};
  const storage = panelData?.storage || {};
  const title = node.name || sample.node?.name || node.id || "Node";
  const alerts = Array.isArray(sample.alerts) ? sample.alerts : [];
  return `<section class="panel" data-monitor-node-panel data-node-name="${escapeHtml(title)} ${escapeHtml(sample.node?.hostname || "")} ${escapeHtml(sample.node?.platform || node.platform || "")}" data-node-alerts="${escapeHtml(alerts.length)}" data-node-stress="${escapeHtml(nodeStressScore(item))}" data-node-cpu="${escapeHtml(sample.cpu?.percent || 0)}" data-node-memory="${escapeHtml(sample.memory?.percent || 0)}">
    <div class="section-header">
      <div>
        <h2>${escapeHtml(title)}</h2>
        <small>${escapeHtml([sample.node?.platform || node.platform || "", sample.node?.hostname || ""].filter(Boolean).join(" - "))}</small>
      </div>
      <div class="row">
        ${alerts.length ? uiBadge(`${alerts.length} alert${alerts.length === 1 ? "" : "s"}`, "warning") : uiBadge("ok", "enabled")}
        <button type="button" class="secondary mini-button" data-node-collapse>Collapse</button>
      </div>
    </div>
    <div data-node-body>
      ${renderAlerts(alerts)}
      <div class="metrics-grid">
      ${metricCard("CPU", `${formatNumber(sample.cpu?.percent)}%`, progressBar(sample.cpu?.percent))}
      ${metricCard("CPU load", formatLoadAverage(sample.cpu), "<small>1m / 5m / 15m</small>")}
      ${metricCard("CPU breakdown", formatCpuBreakdown(sample.cpu?.breakdown), `<small>user / sys / iowait</small>`)}
      ${metricCard("Real memory", formatMemoryMain(sample.memory), `${progressBar(sample.memory?.percent)}<small>${escapeHtml(formatMemoryDetail(sample.memory))}</small>`)}
      ${metricCard("Swap", formatSwapMain(sample.memory), `${progressBar(sample.memory?.swapPercent)}<small>${escapeHtml(formatSwapDetail(sample.memory))}</small>`)}
      ${metricCard("Local disk", disk ? formatDiskMain(disk) : "-", disk ? `${progressBar(disk.percent)}<small>${escapeHtml(formatDiskDetail(disk))}</small>` : "")}
      ${metricCard("Disk I/O", `${formatBytes(diskIo.readBytesPerSec)}/s read`, `<small>${formatBytes(diskIo.writeBytesPerSec)}/s write - ${formatNumber(diskIo.maxBusyPercent)}% busy</small>`)}
      ${metricCard("Network", `${formatBytes(network?.rxBytesPerSec || 0)}/s down`, `<small>${formatBytes(network?.txBytesPerSec || 0)}/s up</small>`)}
      ${metricCard("Network health", formatNetworkHealth(sample.networkHealth), `<small>${escapeHtml(formatNetworkDrops(sample.networkHealth))}</small>`)}
      ${metricCard("Pressure", formatPressure(sample.memory?.pressure), `<small>some / full avg10</small>`)}
      ${metricCard("Thermals", Number.isFinite(thermal.maxCelsius) ? `${formatNumber(thermal.maxCelsius)}C` : "-", `<small>${escapeHtml(battery ? `Battery ${formatNumber(battery.percent)}% ${battery.status || ""}` : "No battery")}</small>`)}
      </div>
      ${renderProcessTable(sample.processes || [])}
      ${renderCollectorDiagnostics(sample.collectors || [])}
      ${renderAlertHistory(panelData?.alerts?.events || [])}
      <div class="stack metrics-chart-stack">
      ${renderLineChart("CPU and memory - " + range, history.points || [], [
        { key: "cpuPercent", label: "CPU", color: "#1d8a5b", max: 100 },
        { key: "memoryPercent", label: "Memory", color: "#f2c94c", max: 100 },
        { key: "swapPercent", label: "Swap", color: "#9b1c1c", max: 100 },
      ], "%")}
      ${renderLineChart("CPU breakdown - " + range, history.points || [], [
        { key: "cpuSystemPercent", label: "System", color: "#2f80ed", max: 100 },
        { key: "cpuIowaitPercent", label: "I/O wait", color: "#f2994a", max: 100 },
        { key: "cpuStealPercent", label: "Steal", color: "#9b51e0", max: 100 },
      ], "%")}
      ${renderLineChart("Total disk and network throughput - " + range, history.points || [], [
        { key: "diskReadBytesPerSec", label: "Disk read", color: "#1d8a5b" },
        { key: "diskWriteBytesPerSec", label: "Disk write", color: "#235c42" },
        { key: "rxBytesPerSec", label: "Net down", color: "#2f80ed" },
        { key: "txBytesPerSec", label: "Net up", color: "#56ccf2" },
      ], "B/s", (value) => `${formatBytes(value)}/s`)}
      ${renderDiskCharts(history.disks || [])}
      ${renderDiskIoCharts(history.diskIo || [])}
      ${renderNetworkCharts(history.network || [])}
      </div>
      <div class="data-table-wrap">
      <table class="data-table">
        <thead><tr><th>Metric</th><th>Value</th><th>Detail</th></tr></thead>
        <tbody>
          <tr><td>Samples</td><td>${escapeHtml(summary.samples ?? 0)}</td><td>${escapeHtml(formatTimeRange(history.fromMs, history.toMs))}</td></tr>
          <tr><td>CPU range</td><td>${escapeHtml(formatNumber(summary.cpu?.min))}% - ${escapeHtml(formatNumber(summary.cpu?.max))}%</td><td>avg ${escapeHtml(formatNumber(summary.cpu?.avg))}%</td></tr>
          <tr><td>CPU load average</td><td>${escapeHtml(formatLoadAverage(sample.cpu))}</td><td>1m / 5m / 15m</td></tr>
          <tr><td>CPU iowait</td><td>${escapeHtml(formatNumber(summary.cpuIowait?.max))}% max</td><td>avg ${escapeHtml(formatNumber(summary.cpuIowait?.avg))}%</td></tr>
          <tr><td>CPU cores</td><td>${escapeHtml(sample.cpu?.perCore?.length || 0)} cores</td><td>${escapeHtml(formatTopCores(sample.cpu?.perCore))}</td></tr>
          <tr><td>Memory range</td><td>${escapeHtml(formatNumber(summary.memory?.min))}% - ${escapeHtml(formatNumber(summary.memory?.max))}%</td><td>avg ${escapeHtml(formatNumber(summary.memory?.avg))}%</td></tr>
          <tr><td>Swap range</td><td>${escapeHtml(formatNumber(summary.swap?.min))}% - ${escapeHtml(formatNumber(summary.swap?.max))}%</td><td>avg ${escapeHtml(formatNumber(summary.swap?.avg))}%</td></tr>
          <tr><td>Page faults</td><td>${escapeHtml(formatNumber(sample.memory?.pageFaultsPerSec))}/s</td><td>major ${escapeHtml(formatNumber(sample.memory?.majorPageFaultsPerSec))}/s</td></tr>
          <tr><td>Real memory</td><td>${escapeHtml(formatMemoryMain(sample.memory))}</td><td>${escapeHtml(formatMemoryDetail(sample.memory))}</td></tr>
          <tr><td>Local disk</td><td>${escapeHtml(disk ? formatDiskMain(disk) : "-")}</td><td>${escapeHtml(disk ? formatDiskDetail(disk) : "No disk data collected")}</td></tr>
          <tr><td>Inodes</td><td>${escapeHtml(disk ? formatNumber(disk.inodesPercent) : "0")}%</td><td>${escapeHtml(disk ? formatInodeDetail(disk) : "No inode data collected")}</td></tr>
          <tr><td>Disk I/O</td><td>${escapeHtml(formatBytes(summary.diskIo?.maxReadBytesPerSec || 0))}/s max read</td><td>${escapeHtml(formatBytes(summary.diskIo?.maxWriteBytesPerSec || 0))}/s max write - ${escapeHtml(formatNumber(summary.diskIo?.maxBusyPercent))}% busy</td></tr>
          <tr><td>Network errors</td><td>${escapeHtml(sample.networkHealth?.errors || 0)} errors</td><td>${escapeHtml(sample.networkHealth?.drops || 0)} drops - retransmits ${escapeHtml(formatNumber(sample.networkHealth?.tcpRetransmitsPerSec))}/s</td></tr>
          <tr><td>Storage</td><td>${escapeHtml(formatBytes(storage.sizeBytes || 0))}</td><td>${escapeHtml(storage.samples || 0)} samples retained ${escapeHtml(storage.retentionDays || "")}d</td></tr>
          <tr><td>Storage health</td><td>${escapeHtml(storage.health?.integrity || "unknown")}</td><td>${escapeHtml(storageHealthDetail(storage))}</td></tr>
          <tr><td>Notifications</td><td>${escapeHtml(storage.notificationRows || 0)}</td><td>Stored alert notification events</td></tr>
        </tbody>
      </table>
      </div>
      <small>Last sample ${escapeHtml(sample.timestamp || "")}</small>
    </div>
  </section>`;
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

function renderProcessTable(processes = []) {
  const rows = (Array.isArray(processes) ? processes : []).slice(0, 10).map((process) => `<tr>
    <td>${escapeHtml(process.name || "process")}</td>
    <td>${process.processType === "agent" ? uiBadge("agent", "enabled") : process.processType === "agent-child" ? uiBadge("agent child", "warning") : uiBadge("system", "disabled")}</td>
    <td>${escapeHtml(process.pid || "-")}</td>
    <td>${escapeHtml(formatNumber(process.cpuPercent))}%</td>
    <td>${escapeHtml(formatBytes(process.rssBytes || 0))}</td>
    <td><span title="${escapeHtml(process.command || "")}">${escapeHtml(shortText(process.command || "", 90))}</span></td>
  </tr>`).join("");
  return `<div class="data-table-wrap">
    <table class="data-table">
      <thead><tr><th>Top process</th><th>Type</th><th>PID</th><th>CPU</th><th>Memory</th><th>Command</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6">No process data collected.</td></tr>'}</tbody>
    </table>
  </div>`;
}

function storageHealthDetail(storage = {}) {
  const warnings = Array.isArray(storage.health?.warnings) ? storage.health.warnings : [];
  const wal = Number(storage.health?.walBytes) || 0;
  const warningText = warnings.length ? warnings.join(" | ") : "No storage warnings";
  return `${warningText} - WAL ${formatBytes(wal)}`;
}

function renderCollectorDiagnostics(collectors = []) {
  const rows = (Array.isArray(collectors) ? collectors : []).map((collector) => `<tr>
    <td>${escapeHtml(collector.name || "-")}</td>
    <td>${collector.ok ? uiBadge("ok", "enabled") : uiBadge("failed", "failed")}</td>
    <td>${escapeHtml(collector.durationMs || 0)}ms</td>
    <td>${escapeHtml(collector.failures || 0)}</td>
    <td>${escapeHtml(collector.lastError || "")}</td>
  </tr>`).join("");
  return `<details class="panel-details"><summary>Collector diagnostics (${escapeHtml((collectors || []).length)})</summary>
    <div class="data-table-wrap">
      <table class="data-table">
        <thead><tr><th>Collector</th><th>Status</th><th>Duration</th><th>Failures</th><th>Last error</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5">No collector diagnostics.</td></tr>'}</tbody>
      </table>
    </div>
  </details>`;
}

function renderAlertHistory(alerts = []) {
  const rows = (Array.isArray(alerts) ? alerts : []).slice(0, 20).map((alert) => `<tr>
    <td>${escapeHtml(alert.timestamp || "")}</td>
    <td>${uiBadge(alert.level || "warning", alert.level === "critical" ? "failed" : "warning")}</td>
    <td>${escapeHtml(alert.label || "")}</td>
    <td>${escapeHtml(formatNumber(alert.value))}${escapeHtml(alert.unit || "")}</td>
    <td>${escapeHtml(formatNumber(alert.threshold))}${escapeHtml(alert.unit || "")}</td>
  </tr>`).join("");
  return `<details class="panel-details"><summary>Alert history (${escapeHtml((alerts || []).length)})</summary>
    <div class="data-table-wrap">
      <table class="data-table">
        <thead><tr><th>Time</th><th>Level</th><th>Alert</th><th>Value</th><th>Threshold</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5">No alerts in this range.</td></tr>'}</tbody>
      </table>
    </div>
  </details>`;
}

function renderAlerts(alerts) {
  if (!Array.isArray(alerts) || !alerts.length) return "";
  const items = alerts.map((alert) => `<span class="chip ${alert.level === "critical" ? "error" : "warn"}">${escapeHtml(alert.label)} ${escapeHtml(formatNumber(alert.value))}${escapeHtml(alert.unit || "")}</span>`).join("");
  return `<div class="row">${items}</div>`;
}

function renderDiskCharts(disks) {
  if (!Array.isArray(disks) || !disks.length) return "";
  const charts = disks.slice(0, 4).map((disk, index) => `<div data-selectable-chart="disk" data-chart-index="${index}"${index ? ' hidden' : ""}>${renderLineChart(`Disk ${disk.mount || disk.filesystem || ""}`, disk.points || [], [
    { key: "percent", label: "Used", color: "#9b1c1c", max: 100 },
  ], "%")}</div>`).join("");
  return renderChartSelector("disk", disks.slice(0, 4).map((disk) => disk.mount || disk.filesystem || "disk"), charts);
}

function renderDiskIoCharts(disks) {
  if (!Array.isArray(disks) || !disks.length) return "";
  const charts = disks.slice(0, 4).map((disk, index) => `<div data-selectable-chart="disk-io" data-chart-index="${index}"${index ? ' hidden' : ""}>${renderLineChart(`Disk I/O ${disk.name || ""}`, disk.points || [], [
    { key: "readBytesPerSec", label: "Read", color: "#1d8a5b" },
    { key: "writeBytesPerSec", label: "Write", color: "#235c42" },
  ], "B/s", (value) => `${formatBytes(value)}/s`)}</div>`).join("");
  return renderChartSelector("disk-io", disks.slice(0, 4).map((disk) => disk.name || "disk"), charts);
}

function renderNetworkCharts(network) {
  if (!Array.isArray(network) || !network.length) return "";
  const charts = network.slice(0, 4).map((item, index) => `<div data-selectable-chart="network" data-chart-index="${index}"${index ? ' hidden' : ""}>${renderLineChart(`Network ${item.name || ""}`, item.points || [], [
    { key: "rxBytesPerSec", label: "Down", color: "#1d8a5b" },
    { key: "txBytesPerSec", label: "Up", color: "#235c42" },
  ], "B/s", (value) => `${formatBytes(value)}/s`)}</div>`).join("");
  return renderChartSelector("network", network.slice(0, 4).map((item) => item.name || "interface"), charts);
}

function renderChartSelector(type, labels, charts) {
  if (labels.length <= 1) return charts;
  const options = labels.map((label, index) => `<option value="${index}">${escapeHtml(label)}</option>`).join("");
  return `<div class="panel">
    <div class="section-header"><h3>${escapeHtml(type === "network" ? "Network interfaces" : type === "disk-io" ? "Disk I/O devices" : "Disks")}</h3><select data-chart-selector="${escapeHtml(type)}">${options}</select></div>
    ${charts}
  </div>`;
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
    const tooltip = chartTooltip(point, series, formatter);
    return `<rect class="chart-hit" tabindex="0" role="img" aria-label="${escapeHtml(tooltip)}" data-chart-tooltip="${escapeHtml(tooltip).replace(/\n/g, "&#10;")}" x="${left.toFixed(1)}" y="${pad.top}" width="${Math.max(2, right - left).toFixed(1)}" height="${height - pad.top - pad.bottom}" fill="transparent" pointer-events="all"><title>${escapeHtml(tooltip)}</title></rect>`;
  }).join("");
  const legend = series.map((line) => `<span class="chip chart-legend-item"><svg class="chart-legend-dot" aria-hidden="true" viewBox="0 0 9 9" width="9" height="9"><circle cx="4.5" cy="4.5" r="4.5" fill="${escapeHtml(line.color)}"></circle></svg>${escapeHtml(line.label)}</span>`).join("");
  const latest = rows.at(-1) || {};
  const latestText = series.map((line) => `${line.label}: ${formatter(Number(latest[line.key]) || 0)}`).join(" | ");
  return `<div class="panel">
    <div class="section-header"><h3>${escapeHtml(title)}</h3><small>${escapeHtml(latestText)}</small></div>
    <div class="chart-wrap" data-chart-wrap>
      <span class="chart-axis-label chart-axis-label-top">${escapeHtml(formatter(maxValue))}</span>
      <span class="chart-axis-label chart-axis-label-bottom">0</span>
      <svg role="img" aria-label="${escapeHtml(title)} chart" viewBox="0 0 ${width} ${height}" width="100%" height="180" preserveAspectRatio="none">
        <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
        <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" stroke="currentColor" opacity="0.18"></line>
        <line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" stroke="currentColor" opacity="0.18"></line>
        ${paths}
        ${hitAreas}
      </svg>
      <div class="chart-tooltip" data-chart-tooltip-popup hidden></div>
    </div>
    <div class="row chart-legend">${legend}</div>
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
  const color = cls === "error" ? "var(--danger)" : cls === "warn" ? "var(--warn-text)" : "var(--success)";
  return `<svg class="progress-svg ${cls}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${width}" viewBox="0 0 100 7" preserveAspectRatio="none"><rect class="progress-track" x="0" y="0" width="100" height="7" rx="3.5"></rect><rect class="progress-fill" x="0" y="0" width="${width}" height="7" rx="3.5" fill="${color}"></rect></svg>`;
}

function panelScript() {
  return `<script>
(function(){
  var root=document.currentScript.closest('[data-system-monitor]');
  if(!root)return;
  function autoRefreshEnabled(){
    var checkbox=root.querySelector('[data-auto-refresh]');
    return !!(checkbox&&checkbox.checked);
  }
  function input(range){
    var payload={maxPoints:Number(root.dataset.maxPoints)||240,autoRefresh:autoRefreshEnabled(),autoRefreshMs:Number(root.dataset.autoRefreshMs)||10000};
    if(range){payload.range=range;return payload;}
    if(root.dataset.rangeMs){payload.rangeMs=Number(root.dataset.rangeMs)||3600000;return payload;}
    payload.range=root.dataset.range||'${DEFAULT_RANGE}';
    return payload;
  }
  root.querySelectorAll('[data-range-button]').forEach(function(button){
    button.addEventListener('click',function(){window.NordRelayPanel&&window.NordRelayPanel.reload&&window.NordRelayPanel.reload(input(button.dataset.rangeButton));});
  });
  var customApply=root.querySelector('[data-custom-range-apply]');
  var customMinutes=root.querySelector('[data-custom-minutes]');
  if(customApply&&customMinutes)customApply.addEventListener('click',function(){
    var minutes=Math.max(1,Number(customMinutes.value)||0);
    if(minutes&&window.NordRelayPanel&&window.NordRelayPanel.reload)window.NordRelayPanel.reload({rangeMs:minutes*60000,maxPoints:Number(root.dataset.maxPoints)||240,autoRefresh:autoRefreshEnabled(),autoRefreshMs:Number(root.dataset.autoRefreshMs)||10000});
  });
  function applyNodeFilters(){
    var text=(root.querySelector('[data-node-filter]')&&root.querySelector('[data-node-filter]').value||'').toLowerCase();
    var alertsOnly=!!(root.querySelector('[data-alerts-only]')&&root.querySelector('[data-alerts-only]').checked);
    var sort=(root.querySelector('[data-node-sort]')&&root.querySelector('[data-node-sort]').value)||'stress';
    var panels=Array.prototype.slice.call(root.querySelectorAll('[data-monitor-node-panel]'));
    panels.sort(function(a,b){
      if(sort==='name')return String(a.dataset.nodeName||'').localeCompare(String(b.dataset.nodeName||''));
      if(sort==='cpu')return (Number(b.dataset.nodeCpu)||0)-(Number(a.dataset.nodeCpu)||0);
      if(sort==='memory')return (Number(b.dataset.nodeMemory)||0)-(Number(a.dataset.nodeMemory)||0);
      if(sort==='alerts')return (Number(b.dataset.nodeAlerts)||0)-(Number(a.dataset.nodeAlerts)||0);
      return (Number(b.dataset.nodeStress)||0)-(Number(a.dataset.nodeStress)||0);
    }).forEach(function(panel){panel.parentNode&&panel.parentNode.appendChild(panel);});
    panels.forEach(function(panel){
      var match=!text||String(panel.dataset.nodeName||'').toLowerCase().indexOf(text)!==-1;
      var hasAlerts=(Number(panel.dataset.nodeAlerts)||0)>0;
      panel.hidden=!match||(alertsOnly&&!hasAlerts);
    });
  }
  ['input','change'].forEach(function(eventName){
    root.querySelectorAll('[data-node-filter],[data-node-sort],[data-alerts-only]').forEach(function(control){control.addEventListener(eventName,applyNodeFilters);});
  });
  root.querySelectorAll('[data-node-collapse]').forEach(function(button){
    button.addEventListener('click',function(){
      var panel=button.closest('[data-monitor-node-panel]');
      var body=panel&&panel.querySelector('[data-node-body]');
      if(!body)return;
      body.hidden=!body.hidden;
      button.textContent=body.hidden?'Expand':'Collapse';
    });
  });
  var collapseAll=root.querySelector('[data-collapse-all]');
  var expandAll=root.querySelector('[data-expand-all]');
  if(collapseAll)collapseAll.addEventListener('click',function(){root.querySelectorAll('[data-node-body]').forEach(function(body){body.hidden=true;});root.querySelectorAll('[data-node-collapse]').forEach(function(button){button.textContent='Expand';});});
  if(expandAll)expandAll.addEventListener('click',function(){root.querySelectorAll('[data-node-body]').forEach(function(body){body.hidden=false;});root.querySelectorAll('[data-node-collapse]').forEach(function(button){button.textContent='Collapse';});});
  root.querySelectorAll('[data-chart-selector]').forEach(function(select){
    select.addEventListener('change',function(){
      var type=select.dataset.chartSelector;
      hideChartTooltips();
      root.querySelectorAll('[data-selectable-chart="'+type+'"]').forEach(function(chart){
        chart.hidden=chart.dataset.chartIndex!==select.value;
      });
    });
  });
  function tooltipFor(target){
    var chart=target.closest('[data-chart-wrap]');
    return chart?chart.querySelector('[data-chart-tooltip-popup]'):null;
  }
  function positionTooltip(target,event){
    var tooltip=tooltipFor(target);
    var chart=target.closest('[data-chart-wrap]');
    if(!tooltip||!chart)return;
    var rect=chart.getBoundingClientRect();
    var x=event&&Number.isFinite(event.clientX)?event.clientX-rect.left:Number(target.getAttribute('x')||0);
    var y=event&&Number.isFinite(event.clientY)?event.clientY-rect.top:Number(target.getAttribute('y')||0);
    var tooltipWidth=Math.min(280,tooltip.offsetWidth||220);
    var left=Math.max(8,Math.min(Math.max(8,rect.width-tooltipWidth-8),x+12));
    var top=Math.max(8,y+12);
    if(top+(tooltip.offsetHeight||60)>rect.height-8)top=Math.max(8,y-(tooltip.offsetHeight||60)-12);
    tooltip.style.left=left+'px';
    tooltip.style.top=top+'px';
  }
  function showTooltip(target,event){
    var tooltip=tooltipFor(target);
    var value=target.getAttribute('data-chart-tooltip');
    if(!tooltip||!value)return;
    tooltip.textContent=value;
    tooltip.hidden=false;
    positionTooltip(target,event);
  }
  function hideTooltip(target){
    var tooltip=tooltipFor(target);
    if(tooltip)tooltip.hidden=true;
  }
  function hideChartTooltips(){
    root.querySelectorAll('[data-chart-tooltip-popup]').forEach(function(tooltip){tooltip.hidden=true;});
  }
  root.querySelectorAll('.chart-hit').forEach(function(hit){
    hit.addEventListener('pointerenter',function(event){showTooltip(hit,event);});
    hit.addEventListener('pointermove',function(event){positionTooltip(hit,event);});
    hit.addEventListener('pointerleave',function(){hideTooltip(hit);});
    hit.addEventListener('focus',function(){showTooltip(hit);});
    hit.addEventListener('blur',function(){hideTooltip(hit);});
  });
  var timer=null;
  var checkbox=root.querySelector('[data-auto-refresh]');
  function stop(){if(timer){clearInterval(timer);timer=null;}}
  function start(){stop();timer=setInterval(function(){if(document.visibilityState==='visible'&&window.NordRelayPanel&&window.NordRelayPanel.reload)window.NordRelayPanel.reload(input(root.dataset.range));},Number(root.dataset.autoRefreshMs)||10000);}
  if(checkbox)checkbox.addEventListener('change',function(){checkbox.checked?start():stop();});
  window.addEventListener('pagehide',stop);
  if(checkbox&&checkbox.checked)start();
  applyNodeFilters();
  if(window.NordRelayPanel&&window.NordRelayPanel.ready)window.NordRelayPanel.ready();
})();</script>`;
}

export function formatNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "0";
  return parsed.toFixed(1).replace(/\.0$/, "");
}

export function formatBytes(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number < 1024) return `${Math.round(number)} B`;
  if (number < 1024 * 1024) return `${(number / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  if (number < 1024 * 1024 * 1024) return `${(number / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
  return `${(number / 1024 / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} GB`;
}

export function formatCompactNumber(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.round(number));
}

export function formatGigabytes(value) {
  return `${(Math.max(0, Number(value) || 0) / 1024 / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} GB`;
}

export function formatLoadAverage(cpu = {}) {
  return [cpu.load1, cpu.load5, cpu.load15].map((value) => formatLoadNumber(value)).join(" / ");
}

export function formatLoadNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "0.00";
  return parsed.toFixed(2);
}

export function formatCpuBreakdown(breakdown = {}) {
  return `${formatNumber(breakdown.user)} / ${formatNumber(breakdown.system)} / ${formatNumber(breakdown.iowait)}%`;
}

export function formatMemoryMain(memory = {}) {
  return `${formatGigabytes(memory.usedBytes)} used`;
}

export function formatMemoryDetail(memory = {}) {
  return `${formatGigabytes(memory.availableBytes ?? memory.freeBytes)} available / ${formatGigabytes(memory.totalBytes)} total`;
}

export function formatSwapMain(memory = {}) {
  return memory.swapTotalBytes ? `${formatGigabytes(memory.swapUsedBytes)} used` : "0 GB used";
}

export function formatSwapDetail(memory = {}) {
  return memory.swapTotalBytes ? `${formatGigabytes(memory.swapFreeBytes)} free / ${formatGigabytes(memory.swapTotalBytes)} total` : "No swap configured";
}

export function formatDiskMain(disk = {}) {
  return `${formatGigabytes(disk.usedBytes)} used`;
}

export function formatDiskDetail(disk = {}) {
  const mount = disk.mount ? `${disk.mount} - ` : "";
  return `${mount}${formatGigabytes(disk.availableBytes)} free / ${formatGigabytes(disk.totalBytes)} total`;
}

export function formatInodeDetail(disk = {}) {
  if (!disk.inodesTotal) return "No inode data";
  return `${formatCompactNumber(disk.inodesAvailable)} free / ${formatCompactNumber(disk.inodesTotal)} total`;
}

export function formatTopCores(cores = []) {
  const top = (Array.isArray(cores) ? cores : []).slice().sort((a, b) => (Number(b.percent) || 0) - (Number(a.percent) || 0)).slice(0, 4);
  return top.length ? top.map((core) => `#${core.index}: ${formatNumber(core.percent)}%`).join(" | ") : "No per-core data";
}

export function formatNetworkHealth(health = {}) {
  return `${formatCompactNumber(health.errors || 0)} errors`;
}

export function formatNetworkDrops(health = {}) {
  return `${formatCompactNumber(health.drops || 0)} drops / ${formatNumber(health.tcpRetransmitsPerSec || 0)} retransmits/s`;
}

export function formatPressure(pressure = emptyPressure()) {
  return `${formatNumber(pressure.some?.avg10)} / ${formatNumber(pressure.full?.avg10)}`;
}

export function formatTimeRange(fromMs, toMs) {
  if (!fromMs || !toMs) return "-";
  return `${new Date(Number(fromMs)).toLocaleString()} - ${new Date(Number(toMs)).toLocaleString()}`;
}

export function shortText(value, maxLength) {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}...` : text;
}

export function uiBadge(text, status = "disabled") {
  return `<span class="badge ${escapeHtml(status)}">${escapeHtml(text)}</span>`;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

function emptyPressure() {
  return {
    some: { avg10: 0, avg60: 0, avg300: 0, total: 0 },
    full: { avg10: 0, avg60: 0, avg300: 0, total: 0 },
  };
}

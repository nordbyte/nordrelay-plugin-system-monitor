export function rollupPeriodForRange(range, presets) {
  return range.rangeMs >= presets["30d"] ? "1d" : range.rangeMs >= presets["7d"] ? "1h" : null;
}

export function rangeLabel(range) {
  if (!range?.fromMs || !range?.toMs) return "-";
  return `${new Date(Number(range.fromMs)).toLocaleString()} - ${new Date(Number(range.toMs)).toLocaleString()}`;
}

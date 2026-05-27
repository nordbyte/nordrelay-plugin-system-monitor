export function collectMetric(name, fallback, collector, previousCollectors = {}, collectorDiagnostics = []) {
  const started = Date.now();
  const previous = previousCollectors?.[name] || {};
  try {
    const value = collector();
    collectorDiagnostics.push({
      name,
      ok: true,
      cached: false,
      durationMs: Date.now() - started,
      failures: 0,
      lastError: "",
      checkedAt: new Date().toISOString(),
    });
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    collectorDiagnostics.push({
      name,
      ok: false,
      cached: false,
      durationMs: Date.now() - started,
      failures: (Number(previous.failures) || 0) + 1,
      lastError: message.slice(0, 240),
      checkedAt: new Date().toISOString(),
    });
    return fallback;
  }
}

export function collectCachedMetric(name, intervalMs, fallback, collector, state = {}, previousCollectors = {}, collectorDiagnostics = []) {
  const cache = state.collectorCache || {};
  const cached = cache[name];
  const now = Date.now();
  if (cached && now - Number(cached.collectedAtMs || 0) < Math.max(1000, Number(intervalMs) || 0)) {
    collectorDiagnostics.push({
      name,
      ok: true,
      cached: true,
      durationMs: 0,
      failures: 0,
      lastError: "",
      checkedAt: new Date().toISOString(),
    });
    return { value: cached.value ?? fallback, cacheUpdated: false };
  }
  const value = collectMetric(name, fallback, collector, previousCollectors, collectorDiagnostics);
  return { value, cacheUpdated: true, cacheEntry: { value, collectedAtMs: now } };
}

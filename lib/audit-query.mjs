/**
 * lib/audit-query.mjs — OLP audit ndjson aggregate query layer (Phase 3 / D49)
 *
 * Authority: ADR 0008 § 4 (query API surface) + § 5 (rotation file naming) +
 * § 3 (storage layout). Reads `~/.olp/logs/audit.ndjson` (live) +
 * `audit-YYYY-MM-DD.ndjson` (rotated dailies) and returns aggregate
 * summaries shaped for the Dashboard endpoints (D50).
 *
 * Query model (ADR 0008 Lane 2 = A): in-memory scan per request. O(N) where
 * N = total lines in the date range. Family-scale acceptable; SQLite hybrid
 * (ADR 0007 § 13) is the documented forward path when N+queries get slow.
 *
 * PII discipline (ADR 0007 § 8 + ADR 0008 § 4.3): event shape is hash + shape
 * only — no message content, no response content, no raw tokens. This module
 * MUST NOT introduce derived fields that reveal content. Every aggregate
 * function asserts the input event has the expected shape but does NOT inspect
 * or relay message bodies.
 *
 * What is NOT in this module (intentional split):
 *   - Daily rotation trigger (D52, lib/audit.mjs extension)
 *   - Server endpoints that consume these queries (D50, server.mjs)
 *   - Dashboard HTML / DOM render (D51, dashboard.html)
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_OLP_HOME = join(homedir(), '.olp');
const OLP_HOME_ENV = 'OLP_HOME';
const LIVE_AUDIT_FILE = 'audit.ndjson';
const ROTATED_FILE_PATTERN = /^audit-(\d{4}-\d{2}-\d{2})\.ndjson$/;

// ── Path helpers ──────────────────────────────────────────────────────────

function _resolveOlpHome(opts) {
  if (opts?.olpHome) return opts.olpHome;
  if (process.env[OLP_HOME_ENV]) return process.env[OLP_HOME_ENV];
  return DEFAULT_OLP_HOME;
}

function _logsDir(opts) {
  return join(_resolveOlpHome(opts), 'logs');
}

/**
 * Returns the UTC-date string (YYYY-MM-DD) for an ISO-8601 timestamp.
 */
function _utcDateString(isoTs) {
  if (typeof isoTs !== 'string' || isoTs.length < 10) return null;
  return isoTs.slice(0, 10);
}

/**
 * Returns the UTC-date string for an epoch-ms.
 */
function _utcDateFromMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Inclusive range of UTC date strings from startDate to endDate (both
 * YYYY-MM-DD). Returns the list in ascending order. Safe for spans up to
 * several years (no upper bound enforced — caller's responsibility).
 */
function _dateRange(startDate, endDate) {
  const dates = [];
  const cur = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

// ── File enumeration ──────────────────────────────────────────────────────

/**
 * Discover audit files in the logs directory. Returns a Map from
 * date-string ('YYYY-MM-DD' or 'live' for the un-rotated file) to absolute
 * file path. The 'live' entry is `audit.ndjson` if present; date-string
 * entries are the rotated daily files matching `audit-YYYY-MM-DD.ndjson`.
 *
 * Returns an empty Map if the logs directory does not exist or is empty.
 * Caller responsible for date filtering.
 *
 * @param {object} [opts] - { olpHome }
 * @returns {Map<string, string>} date-string → absolute file path
 */
export function discoverAuditFiles(opts = {}) {
  const dir = _logsDir(opts);
  const out = new Map();
  if (!existsSync(dir)) return out;
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === LIVE_AUDIT_FILE) {
      out.set('live', join(dir, name));
      continue;
    }
    const m = ROTATED_FILE_PATTERN.exec(name);
    if (m) {
      out.set(m[1], join(dir, name));
    }
  }
  return out;
}

// ── Line-level read + parse ───────────────────────────────────────────────

/**
 * Parse a single ndjson line. Returns the event object on success, or
 * null on parse error. Caller logs warn for null returns.
 */
function _parseLine(line) {
  if (!line) return null;
  try {
    const obj = JSON.parse(line);
    if (typeof obj !== 'object' || obj === null) return null;
    return obj;
  } catch {
    return null;
  }
}

/**
 * Read all events from a single file, skipping malformed lines.
 * Logs warn (via logEvent override or console) for each malformed line so
 * a corrupted day doesn't kill the query.
 *
 * @param {string} path
 * @param {(level: string, event: string, data?: object) => void} [logEvent]
 * @returns {Array<object>} parsed events
 */
function _readFileEvents(path, logEvent) {
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    // Re-throw read errors (EACCES, ENOENT during race) so the dashboard
    // endpoint surfaces 500 with diagnostic per ADR 0008 § 4.4.
    throw new Error(`audit_query_read_failed: ${path}: ${err?.message ?? err}`);
  }
  const lines = raw.split('\n');
  const events = [];
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const ev = _parseLine(line);
    if (ev === null) {
      skipped++;
      continue;
    }
    events.push(ev);
  }
  if (skipped > 0 && logEvent) {
    logEvent('warn', 'audit_query_skip_malformed', { path, skipped });
  }
  return events;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Iterate all audit events in [startMs, endMs). Walks the rotated daily
 * files whose date overlaps the range + today's live audit.ndjson. Within
 * each file, includes only events whose `ts` falls in the window.
 *
 * Per ADR 0008 § 4.2: window semantics are half-open [start, end).
 *
 * @param {object} args
 * @param {number} args.startMs - epoch-ms inclusive lower bound
 * @param {number} args.endMs   - epoch-ms exclusive upper bound
 * @param {string} [args.olpHome]
 * @param {(level: string, event: string, data?: object) => void} [args.logEvent]
 * @yields {object} parsed audit event
 */
export function* readAuditWindow({ startMs, endMs, olpHome, logEvent } = {}) {
  if (typeof startMs !== 'number' || typeof endMs !== 'number') {
    throw new Error('readAuditWindow: startMs and endMs (numbers) are required');
  }
  if (endMs <= startMs) return; // empty window

  const files = discoverAuditFiles({ olpHome });
  if (files.size === 0) return;

  // Walk all dates in [startMs, endMs) plus the live file (today).
  const startDate = _utcDateFromMs(startMs);
  const endDate = _utcDateFromMs(endMs - 1); // endMs is exclusive
  const dateList = _dateRange(startDate, endDate);

  for (const date of dateList) {
    const path = files.get(date);
    if (!path) continue;
    const events = _readFileEvents(path, logEvent);
    for (const ev of events) {
      const tsStr = ev.ts;
      if (typeof tsStr !== 'string') continue;
      const tsMs = Date.parse(tsStr);
      if (Number.isNaN(tsMs)) continue;
      if (tsMs >= startMs && tsMs < endMs) yield ev;
    }
  }

  // Live file (today) — always check; date may overlap window's end.
  const livePath = files.get('live');
  if (livePath) {
    const events = _readFileEvents(livePath, logEvent);
    for (const ev of events) {
      const tsStr = ev.ts;
      if (typeof tsStr !== 'string') continue;
      const tsMs = Date.parse(tsStr);
      if (Number.isNaN(tsMs)) continue;
      if (tsMs >= startMs && tsMs < endMs) yield ev;
    }
  }
}

/**
 * Aggregate request shape over a rolling window ending at "now".
 *
 * Returns:
 *   {
 *     window: { startMs, endMs },
 *     request_count, status_2xx, status_4xx, status_5xx,
 *     by_provider: { [providerKey]: { count, cache_hit, cache_miss, cache_bypass, cache_streaming_attached, fallback_count } },
 *     by_owner_tier: { owner: N, guest: N, anonymous: N },
 *     by_path: { '/v1/chat/completions': N, '/v1/models': N, ... },
 *     median_latency_ms, p95_latency_ms,
 *   }
 *
 * Per ADR 0008 § 4.1 + § 4.3 PII discipline: aggregates count + categorical
 * breakdowns only, NEVER message content.
 *
 * @param {object} args
 * @param {number} args.windowMs - duration in ms; window = [now - windowMs, now)
 * @param {string} [args.olpHome]
 * @param {(level, event, data?) => void} [args.logEvent]
 * @param {() => number} [args._nowFn] - injectable for testing
 */
export function aggregateRequests({ windowMs, olpHome, logEvent, _nowFn } = {}) {
  if (typeof windowMs !== 'number' || windowMs <= 0) {
    throw new Error('aggregateRequests: windowMs (positive number) is required');
  }
  const now = (_nowFn ?? Date.now)();
  const startMs = now - windowMs;
  const endMs = now;

  const result = {
    window: { startMs, endMs },
    request_count: 0,
    status_2xx: 0,
    status_4xx: 0,
    status_5xx: 0,
    by_provider: {},
    by_owner_tier: { owner: 0, guest: 0, anonymous: 0 },
    by_path: {},
    median_latency_ms: 0,
    p95_latency_ms: 0,
  };
  const latencies = [];

  for (const ev of readAuditWindow({ startMs, endMs, olpHome, logEvent })) {
    result.request_count++;

    // Status code bucket
    const sc = typeof ev.status_code === 'number' ? ev.status_code : 0;
    if (sc >= 200 && sc < 300) result.status_2xx++;
    else if (sc >= 400 && sc < 500) result.status_4xx++;
    else if (sc >= 500) result.status_5xx++;

    // By provider
    if (typeof ev.provider === 'string' && ev.provider.length > 0) {
      const p = result.by_provider[ev.provider] ??= {
        count: 0, cache_hit: 0, cache_miss: 0, cache_bypass: 0, cache_streaming_attached: 0, fallback_count: 0,
      };
      p.count++;
      if (ev.cache_status === 'hit') p.cache_hit++;
      else if (ev.cache_status === 'miss') p.cache_miss++;
      else if (ev.cache_status === 'bypass') p.cache_bypass++;
      // D58 — ADR 0005 Amendment 8 §11 + lib/audit.mjs cache_status enum: streaming
      // singleflight joiners (attached) share the source spawn but did not hit a
      // cache. Tracked separately so `count` and `cache_hit + cache_miss +
      // cache_bypass + cache_streaming_attached` reconcile.
      else if (ev.cache_status === 'streaming_attached') p.cache_streaming_attached++;
      if (typeof ev.fallback_hops === 'number' && ev.fallback_hops > 0) p.fallback_count++;
    }

    // By owner tier
    if (ev.owner_tier === 'owner') result.by_owner_tier.owner++;
    else if (ev.owner_tier === 'guest') result.by_owner_tier.guest++;
    else result.by_owner_tier.anonymous++;

    // By path
    if (typeof ev.path === 'string' && ev.path.length > 0) {
      result.by_path[ev.path] = (result.by_path[ev.path] ?? 0) + 1;
    }

    // Latency
    if (typeof ev.latency_ms === 'number' && ev.latency_ms >= 0) {
      latencies.push(ev.latency_ms);
    }
  }

  // Median + p95 over sorted latencies
  if (latencies.length > 0) {
    latencies.sort((a, b) => a - b);
    const midIdx = Math.floor(latencies.length / 2);
    result.median_latency_ms = latencies.length % 2 === 0
      ? Math.round((latencies[midIdx - 1] + latencies[midIdx]) / 2)
      : latencies[midIdx];
    const p95Idx = Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95));
    result.p95_latency_ms = latencies[p95Idx];
  }

  return result;
}

/**
 * Top-N fallback chains by trigger count in window. A "chain" is the
 * `tried_providers` array from an event with fallback_hops > 0. Returns
 * sorted array descending by count; ties broken by earliest first_seen.
 *
 *   [{ chain: ['anthropic', 'openai'], count: 42, first_seen, last_seen }, ...]
 *
 * @param {object} args
 * @param {number} args.windowMs
 * @param {number} [args.limit=10]
 * @param {string} [args.olpHome]
 * @param {(level, event, data?) => void} [args.logEvent]
 * @param {() => number} [args._nowFn]
 */
export function topFallbackChains({ windowMs, limit = 10, olpHome, logEvent, _nowFn } = {}) {
  if (typeof windowMs !== 'number' || windowMs <= 0) {
    throw new Error('topFallbackChains: windowMs (positive number) is required');
  }
  const now = (_nowFn ?? Date.now)();
  const startMs = now - windowMs;
  const endMs = now;

  // Map chain-key (joined string) → aggregate
  const chains = new Map();
  for (const ev of readAuditWindow({ startMs, endMs, olpHome, logEvent })) {
    if (typeof ev.fallback_hops !== 'number' || ev.fallback_hops <= 0) continue;
    if (!Array.isArray(ev.tried_providers) || ev.tried_providers.length < 2) continue;
    const key = ev.tried_providers.join('→');
    const entry = chains.get(key);
    const ts = typeof ev.ts === 'string' ? ev.ts : null;
    if (entry === undefined) {
      chains.set(key, {
        chain: [...ev.tried_providers],
        count: 1,
        first_seen: ts,
        last_seen: ts,
      });
    } else {
      entry.count++;
      if (ts && (!entry.first_seen || ts < entry.first_seen)) entry.first_seen = ts;
      if (ts && (!entry.last_seen || ts > entry.last_seen)) entry.last_seen = ts;
    }
  }

  // Sort desc by count, ascending by first_seen on ties
  const arr = [...chains.values()];
  arr.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (a.first_seen && b.first_seen) return a.first_seen < b.first_seen ? -1 : a.first_seen > b.first_seen ? 1 : 0;
    return 0;
  });
  return arr.slice(0, limit);
}

/**
 * Daily series of request_count + median latency_ms + by_provider over N
 * UTC days ending today. Sparse-fills zero-request days. Returns ascending
 * by date:
 *
 *   [{ date: '2026-05-22', request_count, median_latency_ms, by_provider }, ...]
 *
 * by_provider is { [providerKey]: count } per day.
 *
 * @param {object} args
 * @param {number} args.days
 * @param {string} [args.olpHome]
 * @param {(level, event, data?) => void} [args.logEvent]
 * @param {() => number} [args._nowFn]
 */
export function spendTrendDaily({ days, olpHome, logEvent, _nowFn } = {}) {
  if (typeof days !== 'number' || days <= 0) {
    throw new Error('spendTrendDaily: days (positive number) is required');
  }
  const now = (_nowFn ?? Date.now)();

  // Compute the N UTC dates ending today (inclusive). Semantics: "last N
  // calendar dates ending today" — NOT "events within a rolling N*86400-ms
  // window ago" (the latter would span N+1 distinct UTC dates and produce
  // off-by-one buckets at non-midnight call times).
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    dates.push(_utcDateFromMs(now - i * 86400 * 1000));
  }
  // Window covers the start of the first date through "now" so readAuditWindow
  // sees every event whose ts falls in any of the N dates' UTC days.
  const startMs = Date.parse(`${dates[0]}T00:00:00Z`);
  const endMs = now;

  // Bucket by UTC date
  const buckets = new Map();
  for (const ev of readAuditWindow({ startMs, endMs, olpHome, logEvent })) {
    const date = _utcDateString(ev.ts);
    if (!date) continue;
    const b = buckets.get(date) ?? { request_count: 0, latencies: [], by_provider: {} };
    b.request_count++;
    if (typeof ev.latency_ms === 'number') b.latencies.push(ev.latency_ms);
    if (typeof ev.provider === 'string' && ev.provider.length > 0) {
      b.by_provider[ev.provider] = (b.by_provider[ev.provider] ?? 0) + 1;
    }
    buckets.set(date, b);
  }

  // Sparse-fill using the precomputed dates list (preserves ascending order)
  return dates.map(date => {
    const b = buckets.get(date);
    if (b) {
      b.latencies.sort((a, b) => a - b);
      const midIdx = Math.floor(b.latencies.length / 2);
      const median = b.latencies.length === 0 ? 0
        : b.latencies.length % 2 === 0
          ? Math.round((b.latencies[midIdx - 1] + b.latencies[midIdx]) / 2)
          : b.latencies[midIdx];
      return {
        date,
        request_count: b.request_count,
        median_latency_ms: median,
        by_provider: b.by_provider,
      };
    }
    return { date, request_count: 0, median_latency_ms: 0, by_provider: {} };
  });
}

/**
 * Normalize a single quotaStatus() return value from the anthropic plugin into
 * the dashboard-friendly shape (D81 / ADR 0008 Amendment).
 * Provider-specific: called only for 'anthropic'. Returns null if the raw
 * shape is absent or malformed.
 *
 * @internal — used by aggregateProviderQuota()
 */
function _normalizeAnthropicQuota(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw.fields ?? {};
  return {
    schema_version: raw.schemaVersion ?? null,
    last_fresh_at: raw.stale ? (raw.last_fresh_at ?? null) : (raw.probedAt ?? null),
    utilization: {
      '5h': f.utilization_5h ?? null,
      '7d': f.utilization_7d ?? null,
    },
    reset: {
      '5h': f.reset_5h ?? null,
      '7d': f.reset_7d ?? null,
      overall: f.reset ?? null,
      overage: f.overage_reset ?? null,
    },
    representative_claim: f.representative_claim ?? null,
    fallback_percentage: f.fallback_percentage ?? null,
    overage: {
      status: f.overage_status ?? null,
      disabled_reason: f.overage_disabled_reason ?? null,
    },
    raw_available: (typeof raw.raw === 'object' && raw.raw !== null),
  };
}

/**
 * Aggregate per-provider quota status into a normalized dashboard-friendly
 * shape. This is the D81 Phase 5 extension of lib/audit-query.mjs per
 * ADR 0008 Amendment (D81).
 *
 * For each loaded provider, calls quotaStatus() (already cached at the plugin
 * layer per ADR 0013 Rule 3) and normalizes to a consistent shape. Providers
 * returning null (codex, mistral) produce a { status: 'unavailable' } row.
 *
 * Audit-query stays in-memory scan per ADR 0008 Lane 2 = A. This function
 * does NOT scan the ndjson files; it calls the live provider plugins.
 *
 * Authority: ADR 0008 Amendment (D81) + ADR 0012 D81 + ADR 0013 Rule 5.
 *
 * @param {object} args
 * @param {Map<string, object>} args.providers - Map of provider name → plugin object
 * @param {(name: string) => Promise<object|null>} [args.getQuotaStatus] - injectable for tests;
 *   defaults to calling providers.get(name).quotaStatus?.()
 * @returns {Promise<Array<{
 *   provider: string,
 *   status: 'live' | 'stale' | 'unavailable' | 'disabled',
 *   reason?: string,
 *   schema_version: string | null,
 *   last_fresh_at: number | null,
 *   utilization: { '5h': number|null, '7d': number|null } | null,
 *   reset: { '5h': number|null, '7d': number|null, overall: number|null, overage: number|null } | null,
 *   representative_claim: string | null,
 *   fallback_percentage: number | null,
 *   overage: { status: string|null, disabled_reason: string|null } | null,
 *   raw_available: boolean,
 * }>>}
 */
export async function aggregateProviderQuota({
  providers,
  getQuotaStatus,
} = {}) {
  if (!providers) {
    throw new Error('aggregateProviderQuota: providers (Map) is required');
  }

  // Normalize the providers argument — accept both Map and plain object.
  const providerEntries = (providers instanceof Map)
    ? [...providers.entries()]
    : Object.entries(providers);

  const results = [];
  for (const [name, plugin] of providerEntries) {
    // Default getter: call the plugin's quotaStatus() if present.
    const fetchQuota = getQuotaStatus
      ? () => getQuotaStatus(name)
      : () => (typeof plugin?.quotaStatus === 'function' ? plugin.quotaStatus(null) : Promise.resolve(null));

    let rawResult = null;
    let callError = null;
    try {
      rawResult = await fetchQuota();
    } catch (err) {
      callError = err?.message ?? String(err);
    }

    if (callError !== null) {
      // quotaStatus() threw — treat as error / unavailable.
      results.push({
        provider: name,
        status: 'unavailable',
        reason: callError,
        schema_version: null,
        last_fresh_at: null,
        utilization: null,
        reset: null,
        representative_claim: null,
        fallback_percentage: null,
        overage: null,
        raw_available: false,
      });
      continue;
    }

    if (rawResult === null || rawResult === undefined) {
      // Plugin returned null: either disabled, no quota API, or no credentials.
      results.push({
        provider: name,
        status: 'unavailable',
        reason: 'no public quota api or probe disabled',
        schema_version: null,
        last_fresh_at: null,
        utilization: null,
        reset: null,
        representative_claim: null,
        fallback_percentage: null,
        overage: null,
        raw_available: false,
      });
      continue;
    }

    // quotaStatus() returned a non-null shape — normalize.
    // Currently only 'anthropic' returns a structured shape; other providers
    // returning structured data will work if their shape is compatible.
    const isStale = rawResult.stale === true;
    const normalized = _normalizeAnthropicQuota(rawResult);

    if (normalized === null) {
      // Shape was present but unrecognizable.
      results.push({
        provider: name,
        status: 'unavailable',
        reason: 'unrecognized quota shape',
        schema_version: null,
        last_fresh_at: null,
        utilization: null,
        reset: null,
        representative_claim: null,
        fallback_percentage: null,
        overage: null,
        raw_available: false,
      });
      continue;
    }

    results.push({
      provider: name,
      status: isStale ? 'stale' : 'live',
      ...normalized,
    });
  }

  return results;
}

/**
 * Audit-derived cache hit rate over the window. Differs from
 * `cacheStore.stats()` in server.mjs: that is the live in-process counter;
 * this is the audit-side rate scoped to the rolling window.
 *
 *   { window: { startMs, endMs }, total, hit, miss, bypass, streaming_attached, hit_rate, by_provider }
 *
 * `streaming_attached` (D58, ADR 0005 Amendment 8 §11): D58 streaming
 * singleflight joiners did not hit a literal cache, so they are excluded
 * from both numerator AND denominator of `hit_rate`. Tracked separately
 * so the count reconciles with `total = hit + miss + bypass + streaming_attached`.
 *
 * @param {object} args
 * @param {number} args.windowMs
 * @param {string} [args.olpHome]
 * @param {(level, event, data?) => void} [args.logEvent]
 * @param {() => number} [args._nowFn]
 */
export function cacheHitRateWindow({ windowMs, olpHome, logEvent, _nowFn } = {}) {
  if (typeof windowMs !== 'number' || windowMs <= 0) {
    throw new Error('cacheHitRateWindow: windowMs (positive number) is required');
  }
  const now = (_nowFn ?? Date.now)();
  const startMs = now - windowMs;
  const endMs = now;

  let total = 0, hit = 0, miss = 0, bypass = 0, streaming_attached = 0;
  const by_provider = {};

  for (const ev of readAuditWindow({ startMs, endMs, olpHome, logEvent })) {
    if (ev.cache_status === null || ev.cache_status === undefined) continue;
    total++;
    const p = typeof ev.provider === 'string' && ev.provider.length > 0 ? ev.provider : '__unknown__';
    const pe = by_provider[p] ??= { total: 0, hit: 0, miss: 0, bypass: 0, streaming_attached: 0, hit_rate: 0 };
    pe.total++;
    if (ev.cache_status === 'hit') { hit++; pe.hit++; }
    else if (ev.cache_status === 'miss') { miss++; pe.miss++; }
    else if (ev.cache_status === 'bypass') { bypass++; pe.bypass++; }
    // D58 — ADR 0005 Amendment 8 §11: streaming singleflight joiners.
    // Excluded from hit_rate numerator + denominator (they did not hit a
    // literal cache); tracked so `total` reconciles.
    else if (ev.cache_status === 'streaming_attached') { streaming_attached++; pe.streaming_attached++; }
  }

  // Compute hit_rate per provider + overall (excludes bypass from denominator
  // since bypass-by-cache_control is intentional non-cacheable, not a cache miss).
  for (const p of Object.values(by_provider)) {
    const denom = p.hit + p.miss;
    p.hit_rate = denom > 0 ? p.hit / denom : 0;
  }
  const overallDenom = hit + miss;
  const hit_rate = overallDenom > 0 ? hit / overallDenom : 0;

  return {
    window: { startMs, endMs },
    total, hit, miss, bypass, streaming_attached, hit_rate, by_provider,
  };
}

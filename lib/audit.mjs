/**
 * lib/audit.mjs — OLP audit ndjson append (Phase 2 / D45)
 *
 * Authority: ADR 0007 § 6.2 (audit append semantics) + § 8 (event schema).
 *
 * Behaviour:
 *   - One JSON event per line; newline-terminated; UTF-8.
 *   - Append to ~/.olp/logs/audit.ndjson (chmod 0600 file, 0700 dir).
 *   - On append failure: log a warn ('audit_append_failed_once') + retry
 *     once synchronously.
 *   - On second-failure: increment per-process drop counter + log warn
 *     ('audit_append_dropped'); NEVER throw to the caller (audit is
 *     observability, not authorization). Per § 6.2.
 *   - No memory buffer at Phase 2 (forward-path note in ADR § 13).
 *
 * Atomicity note: Node's `fs.appendFileSync` opens with O_APPEND which is
 * POSIX-atomic for writes <= PIPE_BUF (typically 4096 bytes). Our event
 * payloads (§ 8 schema with hash + shape fields, no PII / no message
 * content) are well under that limit, so concurrent in-process appends
 * are line-atomic without explicit locking.
 *
 * No PII: § 8 explicitly excludes request body, response body, and IR
 * message content. Hash + shape only.
 */

import { appendFileSync, mkdirSync, chmodSync, renameSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_OLP_HOME = join(homedir(), '.olp');
const OLP_HOME_ENV = 'OLP_HOME';
const RETRY_COUNT = 1; // § 6.2: warn + 1 retry
const LIVE_AUDIT_FILE = 'audit.ndjson';
const ROTATED_FILE_PREFIX = 'audit-';
const ROTATED_FILE_SUFFIX = '.ndjson';

let _dropCounter = 0;
let _rotateCounter = 0;       // observability + test assertion target
let _rotateFailCounter = 0;
// Module-cached "last UTC date we saw at append time" so we don't read
// disk metadata on every append just to check for rotation.
let _lastSeenUtcDate = _utcDateNow();

/**
 * Resolve OLP home dir (matches lib/keys.mjs precedence): opts.olpHome →
 * process.env.OLP_HOME → ~/.olp. Resolved per call so tests setting the
 * env mid-run take effect.
 */
function _resolveOlpHome(opts) {
  if (opts?.olpHome) return opts.olpHome;
  if (process.env[OLP_HOME_ENV]) return process.env[OLP_HOME_ENV];
  return DEFAULT_OLP_HOME;
}

/**
 * Current UTC date as YYYY-MM-DD. Module-private; reused by rotation logic.
 */
function _utcDateNow() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Read the first event's `ts` from the live audit file to discover the
 * date it was opened on (for stale-cache recovery when the process is
 * restarted and the in-memory `_lastSeenUtcDate` doesn't match). Returns
 * the YYYY-MM-DD string, or null if the file is missing / empty /
 * malformed.
 */
function _firstEventDateInLiveFile(livePath) {
  try {
    if (!existsSync(livePath)) return null;
    // Read the file + slice off the first ndjson line. For audit ndjson the
    // first line is at most a few hundred bytes; this is fine for the rare
    // "process restart with a stale live file" recovery path. (Family-scale
    // single-file audit is bounded; multi-MB scans are not a real concern
    // until Phase 4+ when Option 3 SQLite migration would kick in anyway.)
    const raw = readFileSync(livePath, 'utf-8');
    const nl = raw.indexOf('\n');
    const firstLine = nl === -1 ? raw : raw.slice(0, nl);
    if (!firstLine) return null;
    const obj = JSON.parse(firstLine);
    if (typeof obj?.ts !== 'string') return null;
    return obj.ts.slice(0, 10);
  } catch {
    return null;
  }
}

/**
 * Rotate the live audit file (if any) to its UTC-date suffix. Idempotent:
 * if a rotated file with that name already exists (e.g., cron beat us to
 * it), this skips the rename.
 *
 * Per ADR 0008 § 5.1 + § 5.3. SYNCHRONOUS so callers (appendAuditEvent +
 * external cron) can rely on it completing before the next IO operation.
 * Sync rotation eliminates the race that an async wrapper would create
 * between the date-change-detection and the append (where the append could
 * land in the old un-rotated file).
 *
 * Concurrent in-process invocations: Node's single-threaded event loop
 * serializes synchronous calls within a tick. Cross-tick concurrency
 * uses the `_lastSeenUtcDate` cache as the gate — once set, subsequent
 * appends short-circuit the rotation check.
 *
 * @param {object} args - { olpHome, logEvent, _nowFn (test injection) }
 * @returns {{ rotated: boolean, fromPath?: string, toPath?: string, dateUsed?: string }}
 */
export function _maybeRotateAudit(args = {}) {
  const olpHome = _resolveOlpHome(args);
  const logEvent = args.logEvent ?? ((level, ev, data) => {
    const entry = { ts: new Date().toISOString(), level, event: ev, ...(data ?? {}) };
    process.stderr.write(JSON.stringify(entry) + '\n');
  });
  const nowFn = args._nowFn ?? (() => new Date());

  const logsDir = join(olpHome, 'logs');
  const livePath = join(logsDir, LIVE_AUDIT_FILE);
  if (!existsSync(livePath)) {
    // No live file yet (first append ever); no rotation needed.
    _lastSeenUtcDate = nowFn().toISOString().slice(0, 10);
    return { rotated: false };
  }
  // Determine the "date the live file holds" — use the first event's ts.
  // Fall back to file mtime if events absent (corrupt / empty file edge).
  let fileDate = _firstEventDateInLiveFile(livePath);
  if (fileDate === null) {
    try {
      fileDate = statSync(livePath).mtime.toISOString().slice(0, 10);
    } catch {
      return { rotated: false };
    }
  }
  const today = nowFn().toISOString().slice(0, 10);
  if (fileDate === today) {
    _lastSeenUtcDate = today;
    return { rotated: false };
  }

  // Rotate: rename live → audit-<fileDate>.ndjson.
  const rotatedName = `${ROTATED_FILE_PREFIX}${fileDate}${ROTATED_FILE_SUFFIX}`;
  const rotatedPath = join(logsDir, rotatedName);
  if (existsSync(rotatedPath)) {
    // Cron or another writer beat us; the live file holding fileDate's
    // events must be merged manually. Per ADR 0008 § 5.3 we log + skip.
    logEvent('warn', 'audit_rotate_target_exists', {
      livePath, rotatedPath,
      message: 'rotation target exists — concurrent rotator beat in-process check; manual merge required if events overlap',
    });
    _lastSeenUtcDate = today;
    return { rotated: false };
  }
  try {
    renameSync(livePath, rotatedPath);
    _rotateCounter++;
    _lastSeenUtcDate = today;
    logEvent('info', 'audit_rotated', { fromPath: livePath, toPath: rotatedPath, dateUsed: fileDate });
    return { rotated: true, fromPath: livePath, toPath: rotatedPath, dateUsed: fileDate };
  } catch (err) {
    _rotateFailCounter++;
    logEvent('warn', 'audit_rotate_failed', {
      livePath, rotatedPath,
      error: err?.message ?? String(err),
    });
    // Don't update _lastSeenUtcDate so the next append retries.
    return { rotated: false };
  }
}

/**
 * Append a single audit event to ~/.olp/logs/audit.ndjson.
 *
 * @param {object} event - § 8 schema fields (ts, key_id, owner_tier,
 *   method, path, provider, model, status_code, latency_ms, cache_status,
 *   fallback_hops, tried_providers, error_code, ir_request_hash, chain_id).
 *   Caller is responsible for populating fields; missing fields are
 *   serialized as undefined → omitted by JSON.stringify.
 *
 *   cache_status enum (free-form string; not schema-validated at append):
 *     'hit'                 — served from cache (buffered-replay or streaming
 *                              cache_hit role from ADR 0005 Amendment 8 §1).
 *     'miss'                — buffered or streaming source path; provider
 *                              spawn fired for this request.
 *     'bypass'              — D2 cache_control bypass (no cache read/write).
 *     'streaming_attached'  — D58 / ADR 0005 Amendment 8 §11: client joined
 *                              an in-flight streaming source spawn from
 *                              another caller; this request did NOT spawn a
 *                              provider but also did NOT hit the cache (the
 *                              cache was empty at the inflight Map check).
 *     null                  — pre-chain error paths (the cache layer was
 *                              never consulted; e.g. 401, 415, 400 IR).
 * @param {object} [opts]
 * @param {string} [opts.olpHome] - test override; defaults to ~/.olp
 * @param {(level: string, event: string, data?: object) => void} [opts.logEvent]
 *   - injectable structured logger; defaults to console.warn with JSON line
 */
export function appendAuditEvent(event, opts = {}) {
  const olpHome = _resolveOlpHome(opts);
  const logsDir = join(olpHome, 'logs');
  const path = join(logsDir, LIVE_AUDIT_FILE);
  const line = JSON.stringify(event) + '\n';
  const logEvent = opts.logEvent ?? ((level, ev, data) => {
    const entry = { ts: new Date().toISOString(), level, event: ev, ...(data ?? {}) };
    process.stderr.write(JSON.stringify(entry) + '\n');
  });

  // D52: cheap fast-path date check. If the module-cached date matches the
  // current UTC date, skip the rotation probe entirely (no disk I/O). If
  // the date has changed, synchronously rotate BEFORE the append so the
  // append lands in the (post-rotation) new live file rather than the
  // about-to-rotate-away old one.
  // Per ADR 0008 § 5.1: rotation fires "on the first append after a UTC
  // date change." Synchronous rotation ensures no append straddles the
  // boundary — old-date events land in the rotated file; new-date events
  // land in the fresh live file. The cache flip happens INSIDE
  // _maybeRotateAudit so concurrent in-process re-triggers short-circuit.
  const today = _utcDateNow();
  if (today !== _lastSeenUtcDate) {
    _maybeRotateAudit({ olpHome, logEvent });
  }

  for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
    try {
      mkdirSync(logsDir, { recursive: true, mode: 0o700 });
      // Tighten dir mode in case it already existed with broader permissions.
      try { chmodSync(logsDir, 0o700); } catch { /* tolerate EPERM */ }
      appendFileSync(path, line, { mode: 0o600 });
      return;
    } catch (err) {
      if (attempt < RETRY_COUNT) {
        logEvent('warn', 'audit_append_failed_once', {
          path,
          error: err?.message ?? String(err),
        });
        continue;
      }
      _dropCounter++;
      logEvent('warn', 'audit_append_dropped', {
        path,
        error: err?.message ?? String(err),
        drop_count: _dropCounter,
      });
      return;
    }
  }
}

/**
 * Per-process count of audit events dropped due to repeated append failure.
 * Useful for /health observability surface (D46).
 */
export function getAuditDropCount() {
  return _dropCounter;
}

/**
 * Test-only: reset the drop counter to zero. Suite 20 uses this between
 * cases to assert independent failure-handling counts.
 */
export function __resetAuditDropCount() {
  _dropCounter = 0;
}

/**
 * Per-process count of successful rotations performed. Test + future
 * observability surface.
 */
export function getAuditRotateCount() {
  return _rotateCounter;
}

/**
 * Per-process count of failed rotation attempts (rename threw, target
 * existed, etc.). Test + future observability surface.
 */
export function getAuditRotateFailCount() {
  return _rotateFailCounter;
}

/**
 * Test-only: reset the rotation counters + the in-process "last seen UTC
 * date" cache so each test exercises a fresh code path.
 */
export function __resetAuditRotateState() {
  _rotateCounter = 0;
  _rotateFailCounter = 0;
  _lastSeenUtcDate = _utcDateNow();
}

/**
 * Test-only: force the cached "last seen UTC date" to a specific value
 * so the next appendAuditEvent observes a date change and triggers
 * rotation deterministically.
 */
export function __setLastSeenUtcDateForTesting(dateStr) {
  _lastSeenUtcDate = dateStr;
}

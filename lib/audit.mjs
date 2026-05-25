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

import { appendFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_OLP_HOME = join(homedir(), '.olp');
const OLP_HOME_ENV = 'OLP_HOME';
const RETRY_COUNT = 1; // § 6.2: warn + 1 retry

let _dropCounter = 0;

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
 * Append a single audit event to ~/.olp/logs/audit.ndjson.
 *
 * @param {object} event - § 8 schema fields (ts, key_id, owner_tier,
 *   method, path, provider, model, status_code, latency_ms, cache_status,
 *   fallback_hops, tried_providers, error_code, ir_request_hash, chain_id).
 *   Caller is responsible for populating fields; missing fields are
 *   serialized as undefined → omitted by JSON.stringify.
 * @param {object} [opts]
 * @param {string} [opts.olpHome] - test override; defaults to ~/.olp
 * @param {(level: string, event: string, data?: object) => void} [opts.logEvent]
 *   - injectable structured logger; defaults to console.warn with JSON line
 */
export function appendAuditEvent(event, opts = {}) {
  const olpHome = _resolveOlpHome(opts);
  const logsDir = join(olpHome, 'logs');
  const path = join(logsDir, 'audit.ndjson');
  const line = JSON.stringify(event) + '\n';
  const logEvent = opts.logEvent ?? ((level, ev, data) => {
    const entry = { ts: new Date().toISOString(), level, event: ev, ...(data ?? {}) };
    process.stderr.write(JSON.stringify(entry) + '\n');
  });

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

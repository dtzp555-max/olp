#!/usr/bin/env node
/**
 * bin/olp.mjs — OLP operator CLI (Phase 4 / D64)
 *
 * Authority: ADR 0010 § Phase 4 D64-D67. Ports OCP's `ocp` bash wrapper
 *   (https://github.com/dtzp555-max/ocp /ocp) to Node.js, eliminating the
 *   python3 JSON-parsing fragility called out in the ADR.
 *
 * Subcommands:
 *   status                 GET /v0/management/status      (owner-only)
 *   health                 GET /health
 *   usage                  GET /v0/management/dashboard-data (owner-only)
 *   models                 GET /v1/models
 *   cache                  GET /cache/stats               (owner-only)
 *   providers              local: models-registry + config providers.enabled
 *   chain show [<model>]   local: ~/.olp/config.json routing.chains
 *   logs [N] [--level X]   local: read ~/.olp/logs/audit.ndjson via audit-query
 *   restart                launchctl (macOS) / systemctl --user (Linux)
 *   doctor [--check X]     run lib/doctor.mjs runDoctor + format
 *   keys ...               delegate to bin/olp-keys.mjs
 *   help | --help          usage
 *
 * Global flags:
 *   --json                 emit raw JSON (silences human-readable output)
 *   --proxy-url=<url>      override resolved proxy URL
 *   --olp-home=<path>      override ~/.olp
 *
 * URL resolution:
 *   OLP_PROXY_URL env (full URL)  →  http://127.0.0.1:${OLP_PORT || 4567}
 *
 * Auth (Bearer token) resolution:
 *   1. OLP_API_KEY env
 *   2. OLP_OWNER_TOKEN env (synthetic env-owner per ADR 0007 § 9.4)
 *   3. Most recently used active owner-tier key from listKeys()    ← plaintext NOT recoverable from disk
 *
 *   Note: the third option only works during the same session in which `olp-keys
 *   keygen --owner` was run if the operator captured the token + set OLP_OWNER_TOKEN.
 *   listKeys() returns manifests; manifest.token_hash is one-way. The CLI therefore
 *   reports "no owner token available" + remediation instructions if env vars are
 *   absent — it does NOT try to crack the hash.
 *
 * Exit codes:
 *   0 = success
 *   1 = bad usage / unknown subcommand
 *   2 = network or HTTP error (4xx/5xx)
 *   3 = auth missing / forbidden
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn as spawnProc } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

import { runDoctor, resolveProxyUrl, resolveOlpHome } from '../lib/doctor.mjs';
import { listKeys } from '../lib/keys.mjs';
import { readAuditWindow } from '../lib/audit-query.mjs';
import modelsRegistry from '../models-registry.json' with { type: 'json' };
import { runCli as runKeysCli } from './olp-keys.mjs';

// ── ANSI helpers (no chalk dep) ───────────────────────────────────────────

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function colorize(s, code, useColor) {
  if (!useColor) return s;
  return `${code}${s}${ANSI.reset}`;
}

function statusBadge(status, useColor) {
  const map = {
    ok:   { txt: 'PASS', col: ANSI.green },
    warn: { txt: 'WARN', col: ANSI.yellow },
    fail: { txt: 'FAIL', col: ANSI.red },
  };
  const m = map[status] ?? { txt: String(status).toUpperCase(), col: ANSI.gray };
  return colorize(`[${m.txt}]`, m.col, useColor);
}

// ── Arg parser (mirror bin/olp-keys.mjs shape) ────────────────────────────

export function parseArgv(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const name = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// ── Output helpers (respect --json) ───────────────────────────────────────

function makeIO(opts) {
  const out = opts.out ?? (s => process.stdout.write(s));
  const err = opts.err ?? (s => process.stderr.write(s));
  const wantJson = opts.json === true;
  // When wantJson, the only stdout writer used is `emitJson`. `log` becomes a no-op
  // (debug noise suppression per the bundle requirements). `errln` always writes
  // to stderr.
  const log = (...parts) => { if (!wantJson) out(parts.join(' ') + '\n'); };
  const errln = (...parts) => err(parts.join(' ') + '\n');
  const emitJson = (obj) => out(JSON.stringify(obj, null, 2) + '\n');
  return { log, errln, emitJson, wantJson, useColor: !wantJson && (opts.useColor ?? true) };
}

// ── HTTP helper ───────────────────────────────────────────────────────────

async function httpFetch(url, { method = 'GET', headers = {}, timeoutMs = 15000 } = {}) {
  return new Promise(resolve => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let urlObj;
    try { urlObj = new URL(url); }
    catch (e) { return finish({ ok: false, error: `invalid url: ${e?.message ?? e}` }); }
    const isHttps = urlObj.protocol === 'https:';
    const reqFn = isHttps ? httpsRequest : httpRequest;
    let req;
    try {
      req = reqFn(url, { method, headers, timeout: timeoutMs }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => finish({ ok: true, status: res.statusCode, body: data, headers: res.headers }));
      });
    } catch (e) {
      return finish({ ok: false, error: String(e?.message ?? e) });
    }
    req.on('error', e => finish({ ok: false, error: String(e?.message ?? e), code: e?.code }));
    req.on('timeout', () => {
      try { req.destroy(new Error(`timeout after ${timeoutMs}ms`)); } catch { /* ignore */ }
    });
    req.end();
  });
}

// ── Token resolution ──────────────────────────────────────────────────────

/**
 * Resolve a Bearer token. Returns the plaintext token string or null.
 * Precedence: OLP_API_KEY → OLP_OWNER_TOKEN → null (manifests are one-way hashed).
 */
export function resolveBearerToken() {
  if (process.env.OLP_API_KEY) return process.env.OLP_API_KEY;
  if (process.env.OLP_OWNER_TOKEN) return process.env.OLP_OWNER_TOKEN;
  return null;
}

function authHeaders() {
  const tok = resolveBearerToken();
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

// ── HTTP-error → exit code mapping ────────────────────────────────────────

function httpErrorToExit(res, io) {
  if (!res.ok) {
    if (res.code === 'ECONNREFUSED' || (res.error && res.error.includes('ECONNREFUSED'))) {
      io.errln(`Error: OLP server unreachable (${res.error}). Is it running?`);
      io.errln(`Hint: run 'npx olp restart' (or 'npm start' for foreground) — see 'npx olp doctor' for the full diagnostic.`);
      return 2;
    }
    io.errln(`Error: network error: ${res.error}`);
    return 2;
  }
  if (res.status === 401) {
    io.errln(`Error: 401 unauthorized — set OLP_API_KEY env (Bearer token) or OLP_OWNER_TOKEN.`);
    io.errln(`Hint: 'npx olp-keys keygen --owner' creates a new owner-tier key (capture the plaintext token).`);
    return 3;
  }
  if (res.status === 403) {
    io.errln(`Error: 403 forbidden — current key is not owner-tier (this endpoint is owner-only).`);
    return 3;
  }
  if (res.status >= 400) {
    io.errln(`Error: HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    return 2;
  }
  return 0;
}

// ── Human-readable formatters ─────────────────────────────────────────────

function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '?';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`;
}

function formatMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '?';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h${Math.floor((ms % 3600000) / 60000)}m`;
}

// ── Subcommand: status ────────────────────────────────────────────────────

async function cmdStatus(flags, io) {
  const url = resolveProxyUrl({ proxyUrl: flags['proxy-url'] });
  const res = await httpFetch(`${url}/v0/management/status`, { headers: authHeaders() });
  const ec = httpErrorToExit(res, io);
  if (ec !== 0) return ec;
  let body;
  try { body = JSON.parse(res.body); }
  catch { io.errln('Error: server returned non-JSON body'); return 2; }
  if (io.wantJson) { io.emitJson(body); return 0; }
  io.log(colorize('OLP status', ANSI.bold, io.useColor));
  io.log('─'.repeat(60));
  io.log(`  version:     ${body.version}`);
  io.log(`  uptime:      ${body.uptime_human} (${formatMs(body.uptime_ms)})`);
  io.log(`  started:     ${body.started_at}`);
  io.log(`  providers:   ${body.providers?.enabled ?? '?'} enabled / ${body.providers?.available ?? '?'} available`);
  if (body.providers?.status && typeof body.providers.status === 'object') {
    for (const [name, s] of Object.entries(body.providers.status)) {
      const okIcon = s?.ok ? colorize('ok', ANSI.green, io.useColor) : colorize('FAIL', ANSI.red, io.useColor);
      io.log(`     - ${name.padEnd(12)} ${okIcon} ${s?.error ? `(${s.error})` : ''}`);
    }
  }
  io.log(`  total reqs:  ${body.stats?.total_requests ?? 0}`);
  io.log(`  active reqs: ${body.stats?.active_requests ?? 0}`);
  // D75 F4 fix: server payload nests cache stats under stats.cache (per
  // server.mjs handleManagementStatus, ~line 2092). The CacheStore.stats()
  // contract returns { hits, misses, size, inflightCount } per
  // lib/cache/store.mjs — there is no `entries` field. Pre-D75 cmdStatus read
  // `body.stats.cache.entries` (OCP-era) which was always undefined → output
  // showed "entries=?". Same pattern as D74 P2-3 applied to cmdCache/cmdUsage.
  if (body.stats?.cache) {
    const c = body.stats.cache;
    io.log(`  cache:       hits=${c.hits ?? 0} misses=${c.misses ?? 0} entries=${c.size ?? 0}${typeof c.inflightCount === 'number' ? ` inflight=${c.inflightCount}` : ''}`);
  }
  if (Array.isArray(body.recent_errors) && body.recent_errors.length > 0) {
    io.log(`  recent errors: ${body.recent_errors.length}`);
    for (const e of body.recent_errors.slice(0, 5)) {
      io.log(`     - [${e.at ?? '?'}] ${e.provider ?? '?'} ${e.path ?? '?'} — ${(e.message ?? '').slice(0, 80)}`);
    }
  }
  return 0;
}

// ── Subcommand: health ────────────────────────────────────────────────────

async function cmdHealth(flags, io) {
  const url = resolveProxyUrl({ proxyUrl: flags['proxy-url'] });
  const res = await httpFetch(`${url}/health`, { headers: authHeaders() });
  const ec = httpErrorToExit(res, io);
  if (ec !== 0) return ec;
  let body;
  try { body = JSON.parse(res.body); }
  catch { io.errln('Error: server returned non-JSON body'); return 2; }
  if (io.wantJson) { io.emitJson(body); return 0; }
  io.log(colorize(`OLP /health → ${res.status}`, ANSI.bold, io.useColor));
  io.log('─'.repeat(60));
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === 'object' && v !== null) {
      io.log(`  ${k}:`);
      for (const [k2, v2] of Object.entries(v)) {
        io.log(`     ${k2}: ${typeof v2 === 'object' ? JSON.stringify(v2) : v2}`);
      }
    } else {
      io.log(`  ${k}: ${v}`);
    }
  }
  return 0;
}

// ── Subcommand: usage ─────────────────────────────────────────────────────

async function cmdUsage(flags, io) {
  const url = resolveProxyUrl({ proxyUrl: flags['proxy-url'] });
  const res = await httpFetch(`${url}/v0/management/dashboard-data`, { headers: authHeaders() });
  const ec = httpErrorToExit(res, io);
  if (ec !== 0) return ec;
  let body;
  try { body = JSON.parse(res.body); }
  catch { io.errln('Error: server returned non-JSON body'); return 2; }
  if (io.wantJson) { io.emitJson(body); return 0; }
  // D74 P2-3 fix: server payload shape is { generated_at, window_24h: { request_count, status_2xx,
  // status_4xx, status_5xx, by_provider, by_owner_tier, by_path, median_latency_ms, p95_latency_ms },
  // cache_hit_24h: { total, hit, miss, bypass, streaming_attached, hit_rate, by_provider }, quota: [{provider, ...}],
  // spend_trend_30d: [{date, request_count, by_provider}], top_fallback_chains_24h: [{chain, count, ...}],
  // cache_stats: { hits, misses, size, inflightCount } } per server.mjs:2027 + lib/audit-query.mjs.
  io.log(colorize('OLP usage (24h)', ANSI.bold, io.useColor));
  io.log('─'.repeat(60));
  const w24 = body.window_24h ?? {};
  const cache24 = body.cache_hit_24h ?? {};
  if (typeof w24 === 'object' && (w24.request_count ?? 0) > 0) {
    io.log(`  requests:        ${w24.request_count}`);
    io.log(`  2xx / 4xx / 5xx: ${w24.status_2xx ?? 0} / ${w24.status_4xx ?? 0} / ${w24.status_5xx ?? 0}`);
    if (typeof w24.median_latency_ms === 'number') {
      io.log(`  latency p50/p95: ${w24.median_latency_ms}ms / ${w24.p95_latency_ms ?? 0}ms`);
    }
    if (typeof cache24.hit_rate === 'number') {
      const pct = (cache24.hit_rate * 100).toFixed(1);
      io.log(`  cache hit rate:  ${pct}% (hit=${cache24.hit ?? 0} miss=${cache24.miss ?? 0}${cache24.streaming_attached ? ` streaming_attached=${cache24.streaming_attached}` : ''})`);
    }
  } else {
    io.log('  (no 24h usage data — server may not have processed any requests yet)');
  }
  if (Array.isArray(body.quota) && body.quota.length > 0) {
    io.log('');
    io.log(colorize('Per-provider quota', ANSI.bold, io.useColor));
    io.log('─'.repeat(60));
    for (const p of body.quota) {
      const label = String(p.provider ?? '?').padEnd(12);
      if (p.error) {
        io.log(`  ${label} error: ${p.error}`);
      } else if (typeof p.percent_used === 'number') {
        io.log(`  ${label} ${p.percent_used}% used${p.resets_in_human ? ` (resets in ${p.resets_in_human})` : ''}`);
      } else if (p.available === false) {
        io.log(`  ${label} unavailable`);
      } else {
        io.log(`  ${label} no quota api`);
      }
    }
  }
  if (Array.isArray(body.top_fallback_chains_24h) && body.top_fallback_chains_24h.length > 0) {
    io.log('');
    io.log(colorize('Top fallback chains (24h)', ANSI.bold, io.useColor));
    io.log('─'.repeat(60));
    for (const f of body.top_fallback_chains_24h.slice(0, 10)) {
      io.log(`  ${String(f.count ?? '?').padStart(5)}  ${(f.chain ?? []).join(' → ')}`);
    }
  }
  return 0;
}

// ── Subcommand: models ────────────────────────────────────────────────────

async function cmdModels(flags, io) {
  const url = resolveProxyUrl({ proxyUrl: flags['proxy-url'] });
  const res = await httpFetch(`${url}/v1/models`, { headers: authHeaders() });
  const ec = httpErrorToExit(res, io);
  if (ec !== 0) return ec;
  let body;
  try { body = JSON.parse(res.body); }
  catch { io.errln('Error: server returned non-JSON body'); return 2; }
  if (io.wantJson) { io.emitJson(body); return 0; }
  io.log(colorize(`OLP models (${(body.data ?? []).length})`, ANSI.bold, io.useColor));
  io.log('─'.repeat(60));
  for (const m of body.data ?? []) {
    io.log(`  ${m.id.padEnd(35)} ${colorize(`(${m.owned_by ?? '?'})`, ANSI.gray, io.useColor)}`);
  }
  return 0;
}

// ── Subcommand: cache ─────────────────────────────────────────────────────

async function cmdCache(flags, io) {
  const url = resolveProxyUrl({ proxyUrl: flags['proxy-url'] });
  const res = await httpFetch(`${url}/cache/stats`, { headers: authHeaders() });
  const ec = httpErrorToExit(res, io);
  if (ec !== 0) return ec;
  let body;
  try { body = JSON.parse(res.body); }
  catch { io.errln('Error: server returned non-JSON body'); return 2; }
  if (io.wantJson) { io.emitJson(body); return 0; }
  // D74 P2-3 fix: cacheStore.stats() returns { hits, misses, size, inflightCount }
  // per lib/cache/store.mjs:320. There is no entries / evictions / bytes / maxBytes
  // in the OLP cache model — those were OCP-era field names. Compute a hit rate from
  // the numerator/denominator instead of fabricating bytes.
  const hits = body.hits ?? 0;
  const misses = body.misses ?? 0;
  const denom = hits + misses;
  const hitRate = denom > 0 ? ((hits / denom) * 100).toFixed(1) : '0.0';
  io.log(colorize('OLP cache (live in-memory)', ANSI.bold, io.useColor));
  io.log('─'.repeat(60));
  io.log(`  entries:        ${body.size ?? 0}`);
  io.log(`  hits / misses:  ${hits} / ${misses}  (hit rate ${hitRate}%)`);
  io.log(`  inflight:       ${body.inflightCount ?? 0}`);
  if (body.generated_at) io.log(`  generated_at:   ${body.generated_at}`);
  return 0;
}

// ── Subcommand: providers (local) ─────────────────────────────────────────

function cmdProviders(flags, io) {
  const olpHome = resolveOlpHome({ olpHome: flags['olp-home'] });
  const configPath = join(olpHome, 'config.json');
  let enabled = {};
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    enabled = cfg?.providers?.enabled ?? {};
  } catch { /* fine — empty enabled map */ }

  const providers = modelsRegistry?.providers ?? {};
  const rows = [];
  for (const [name, p] of Object.entries(providers)) {
    rows.push({
      name,
      displayName: p?.displayName ?? name,
      tier: p?.tier ?? '?',
      modelCount: (p?.models ?? []).length,
      enabled: enabled[name] === true,
      candidate: p?.candidate === true,
    });
  }
  if (io.wantJson) {
    io.emitJson({ providers: rows, config_path: configPath });
    return 0;
  }
  io.log(colorize(`OLP providers (${rows.length} in registry)`, ANSI.bold, io.useColor));
  io.log('─'.repeat(60));
  for (const r of rows) {
    const enabledTxt = r.enabled
      ? colorize('enabled ', ANSI.green, io.useColor)
      : colorize('disabled', ANSI.gray, io.useColor);
    const candTxt = r.candidate ? colorize('(candidate)', ANSI.yellow, io.useColor) : '';
    io.log(`  ${r.name.padEnd(10)} ${enabledTxt}  tier ${r.tier}  models ${String(r.modelCount).padStart(2)}  ${candTxt}`);
  }
  io.log('');
  io.log(colorize(`config: ${configPath}`, ANSI.dim, io.useColor));
  return 0;
}

// ── Subcommand: chain show ────────────────────────────────────────────────

function cmdChainShow(positional, flags, io) {
  const target = positional[0] ?? null;  // model name, or null = print all
  const olpHome = resolveOlpHome({ olpHome: flags['olp-home'] });
  const configPath = join(olpHome, 'config.json');
  let chains = {};
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    chains = cfg?.routing?.chains ?? {};
  } catch { /* empty */ }

  if (io.wantJson) {
    if (target) {
      io.emitJson({ model: target, chain: chains[target] ?? null });
    } else {
      io.emitJson({ chains });
    }
    return 0;
  }
  io.log(colorize('OLP routing.chains', ANSI.bold, io.useColor));
  io.log('─'.repeat(60));
  if (Object.keys(chains).length === 0) {
    io.log(`  (no chains configured in ${configPath})`);
    return 0;
  }
  if (target) {
    const chain = chains[target];
    if (!chain) {
      io.errln(`Error: model "${target}" not in routing.chains (configured: ${Object.keys(chains).join(', ')}).`);
      return 1;
    }
    io.log(`  ${target}:`);
    for (const hop of chain) {
      io.log(`     → ${typeof hop === 'string' ? hop : JSON.stringify(hop)}`);
    }
  } else {
    for (const [model, chain] of Object.entries(chains)) {
      io.log(`  ${model}:`);
      for (const hop of chain) {
        io.log(`     → ${typeof hop === 'string' ? hop : JSON.stringify(hop)}`);
      }
    }
  }
  return 0;
}

// ── Subcommand: logs ──────────────────────────────────────────────────────

async function cmdLogs(positional, flags, io) {
  const n = positional[0] ? parseInt(positional[0], 10) : 20;
  if (!Number.isFinite(n) || n <= 0) {
    io.errln(`Error: invalid log count "${positional[0]}"`);
    return 1;
  }
  const olpHome = resolveOlpHome({ olpHome: flags['olp-home'] });
  // readAuditWindow is a generator over [startMs, endMs). Default window = last 24h.
  const windowMs = flags['window-ms'] ? parseInt(flags['window-ms'], 10) : 24 * 3600 * 1000;
  const endMs = Date.now();
  const startMs = endMs - windowMs;
  let events = [];
  try {
    for (const ev of readAuditWindow({ startMs, endMs, olpHome })) {
      events.push(ev);
    }
  } catch (e) {
    io.errln(`Error: readAuditWindow failed: ${e?.message ?? e}`);
    return 2;
  }
  let filtered = events;
  if (flags.level) {
    filtered = filtered.filter(e => e.level === flags.level);
  }
  // Tail (audit events are already chronological per generator order).
  filtered = filtered.slice(-n);
  if (io.wantJson) {
    io.emitJson({ events: filtered });
    return 0;
  }
  io.log(colorize(`OLP logs (last ${filtered.length} of ${events.length}${flags.level ? `, level=${flags.level}` : ''})`, ANSI.bold, io.useColor));
  io.log('─'.repeat(60));
  for (const e of filtered) {
    // Audit event shape per lib/audit.mjs: { ts, event, ...data }. `level` is
    // not always present in audit ndjson (it is in stderr-side logEvent).
    const level = (e.level ?? 'info').toUpperCase();
    const levelColor =
      level === 'ERROR' ? ANSI.red
      : level === 'WARN' ? ANSI.yellow
      : ANSI.gray;
    const summary = e.message ?? e.error ?? '';
    io.log(`  ${colorize(level.padEnd(5), levelColor, io.useColor)} ${e.ts ?? '?'} ${e.event ?? '?'} ${summary}`);
  }
  return 0;
}

// ── Subcommand: restart ───────────────────────────────────────────────────

async function cmdRestart(flags, io) {
  // macOS: launchctl kickstart -k gui/$(id -u)/dev.olp.proxy
  // Linux: systemctl --user restart olp-proxy
  // Neither installed → fall through to a helpful error.
  //
  // CAVEAT (D64-D67 reviewer P2-2; known OCP institutional lesson per
  // ~/.cc-rules/memory/auto/MEMORY.md PIT INDEX): `launchctl kickstart -k`
  // does NOT re-read the plist's EnvironmentVariables block — launchd
  // sticks to its cached env from the most recent bootstrap. If you edited
  // ~/Library/LaunchAgents/dev.olp.proxy.plist's env, this subcommand will
  // silently use stale values. Use `launchctl bootout gui/<uid>/dev.olp.proxy`
  // followed by `launchctl bootstrap gui/<uid> ~/Library/LaunchAgents/dev.olp.proxy.plist`
  // to force a clean env reload. The Phase 4 installer (planned post-D73)
  // will expose `olp restart --full` for the bootout/bootstrap dance.
  const platform = process.platform;
  const uid = process.getuid?.() ?? null;
  let cmd, args;
  if (platform === 'darwin') {
    if (uid == null) {
      io.errln('Error: cannot resolve UID on this platform; cannot drive launchctl');
      return 2;
    }
    cmd = 'launchctl';
    args = ['kickstart', '-k', `gui/${uid}/dev.olp.proxy`];
  } else if (platform === 'linux') {
    cmd = 'systemctl';
    args = ['--user', 'restart', 'olp-proxy'];
  } else {
    io.errln(`Error: platform "${platform}" not supported for 'olp restart'.`);
    io.errln(`Hint: run 'npm start' (or whatever launches your OLP server) manually.`);
    return 2;
  }
  // Spawn + wait for exit; bubble up any error.
  const result = await new Promise(resolve => {
    const child = spawnProc(cmd, args, { stdio: io.wantJson ? 'ignore' : 'inherit' });
    child.on('error', e => resolve({ code: -1, error: e }));
    child.on('exit', code => resolve({ code }));
  });
  if (result.code === 0) {
    if (io.wantJson) {
      io.emitJson({ ok: true, cmd, args });
    } else {
      io.log(colorize(`Restart issued (${cmd} ${args.join(' ')})`, ANSI.green, io.useColor));
    }
    return 0;
  }
  if (result.error?.code === 'ENOENT' || result.code === 127) {
    io.errln(`Error: '${cmd}' not found on this system.`);
    if (platform === 'darwin') {
      io.errln(`Hint: no launchd service 'dev.olp.proxy' installed; run 'npm start' manually.`);
    } else {
      io.errln(`Hint: no systemd user unit 'olp-proxy' installed; run 'npm start' manually.`);
    }
    return 2;
  }
  io.errln(`Error: ${cmd} ${args.join(' ')} exited with code ${result.code}`);
  return 2;
}

// ── Subcommand: doctor ────────────────────────────────────────────────────

async function cmdDoctor(flags, io) {
  const olpHome = resolveOlpHome({ olpHome: flags['olp-home'] });
  const proxyUrl = resolveProxyUrl({ proxyUrl: flags['proxy-url'] });
  const checkFilter = typeof flags.check === 'string' ? flags.check : undefined;

  // D74 P1-1: pass authHeaders so server.running / server.version checks
  // succeed under the default production posture (auth.allow_anonymous:
  // false). resolveBearerToken returns null when no env var is set; the
  // doctor still runs but distinguishes 401 from "server down" by status
  // code per the updated check.
  const result = await runDoctor({
    olpHome,
    proxyUrl,
    checkFilter,
    authHeaders: authHeaders(),
  });

  if (io.wantJson) {
    io.emitJson(result);
    return result.fail_count === 0 ? 0 : 2;
  }

  io.log(colorize(`OLP doctor — ${result.summary}`, ANSI.bold, io.useColor));
  io.log('─'.repeat(60));
  for (const c of result.checks) {
    io.log(`  ${statusBadge(c.status, io.useColor)} ${c.id.padEnd(36)} ${c.message}`);
  }
  io.log('');
  io.log(`  fail=${result.fail_count} warn=${result.warn_count} ok=${result.ok_count}  kind=${result.kind}`);
  if (result.next_action.ai_executable.length > 0) {
    io.log('');
    io.log(colorize('Next (AI-executable):', ANSI.cyan, io.useColor));
    for (const cmd of result.next_action.ai_executable) io.log(`  $ ${cmd}`);
  }
  if (result.next_action.human_required.length > 0) {
    io.log('');
    io.log(colorize('Next (human-required):', ANSI.yellow, io.useColor));
    for (const step of result.next_action.human_required) io.log(`  • ${step}`);
  }
  io.log('');
  io.log(colorize(`verify: ${result.next_action.verify}`, ANSI.dim, io.useColor));
  return result.fail_count === 0 ? 0 : 2;
}

// ── Subcommand: keys (delegate) ───────────────────────────────────────────

async function cmdKeys(rest, io) {
  // Re-use bin/olp-keys.mjs's runCli. Its `out`/`err` writers receive raw strings
  // (no \n needed since the underlying CLI emits them itself).
  return await runKeysCli(rest, {
    out: s => process.stdout.write(s),
    err: s => process.stderr.write(s),
  });
}

// ── Usage ──────────────────────────────────────────────────────────────────

const USAGE = `OLP operator CLI — Phase 4 (ADR 0010)

Usage:
  olp <subcommand> [args] [--json] [--proxy-url=<url>] [--olp-home=<path>]

Subcommands:
  status                    GET /v0/management/status     (owner-only)
  health                    GET /health
  usage                     GET /v0/management/dashboard-data (owner-only)
  models                    GET /v1/models
  cache                     GET /cache/stats              (owner-only)
  providers                 list providers (registry + config providers.enabled)
  chain show [<model>]      print routing.chains from ~/.olp/config.json
  logs [N] [--level X]      last N audit events from ~/.olp/logs/audit.ndjson
  restart                   launchctl (macOS) / systemctl --user (Linux)
  doctor [--check X]        run diagnostic checks (id, category, or prefix filter)
  keys [args ...]           delegate to bin/olp-keys.mjs
  help                      print this message

Global flags:
  --json                    emit raw JSON (silences human-readable formatting)
  --proxy-url=<url>         override resolved proxy URL
  --olp-home=<path>         override ~/.olp

Env:
  OLP_PROXY_URL             full URL (overrides OLP_PORT)
  OLP_PORT                  port for default URL  (default: 4567)
  OLP_API_KEY               Bearer token for the proxy
  OLP_OWNER_TOKEN           synthetic env-owner token (ADR 0007 § 9.4)
  OLP_HOME                  ~/.olp override

Exit codes:
  0 success
  1 bad usage / unknown subcommand
  2 network or HTTP error (4xx/5xx)
  3 auth missing / forbidden`;

// ── runCli (testable entry) ───────────────────────────────────────────────

/**
 * Run the CLI with explicit argv + IO streams. Returns the exit code (no
 * process.exit). Exported for tests.
 *
 * @param {string[]} argv  args after the script name
 * @param {object} [opts]
 * @param {(s: string) => void} [opts.out]
 * @param {(s: string) => void} [opts.err]
 * @param {boolean} [opts.useColor]  default true; tests pass false for deterministic strings
 * @returns {Promise<number>}
 */
export async function runCli(argv, opts = {}) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    const io = makeIO({ ...opts, json: false });
    io.log(USAGE);
    return argv.length === 0 ? 1 : 0;
  }

  const [subcommand, ...rest] = argv;

  // `olp keys ...` passes the remaining argv straight to bin/olp-keys.mjs.
  if (subcommand === 'keys') {
    const io = makeIO({ ...opts, json: false });
    return await cmdKeys(rest, io);
  }

  const { positional, flags } = parseArgv(rest);
  const json = flags.json === true;
  const io = makeIO({ ...opts, json });

  switch (subcommand) {
    case 'status':    return await cmdStatus(flags, io);
    case 'health':    return await cmdHealth(flags, io);
    case 'usage':     return await cmdUsage(flags, io);
    case 'models':    return await cmdModels(flags, io);
    case 'cache':     return await cmdCache(flags, io);
    case 'providers': return cmdProviders(flags, io);
    case 'chain': {
      // `olp chain show [model]`
      const sub = positional[0];
      if (sub !== 'show') {
        io.errln(`Error: unknown 'chain' subcommand "${sub}". Try: olp chain show [model]`);
        return 1;
      }
      return cmdChainShow(positional.slice(1), flags, io);
    }
    case 'logs':      return await cmdLogs(positional, flags, io);
    case 'restart':   return await cmdRestart(flags, io);
    case 'doctor':    return await cmdDoctor(flags, io);
    default:
      io.errln(`Error: unknown subcommand "${subcommand}".`);
      io.errln(USAGE);
      return 1;
  }
}

// ── Main guard ────────────────────────────────────────────────────────────

function _isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

if (_isMain()) {
  runCli(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(e => {
      process.stderr.write(`Fatal: ${e?.stack ?? e}\n`);
      process.exit(2);
    });
}

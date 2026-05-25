#!/usr/bin/env node
/**
 * server.mjs — OLP HTTP listener and request dispatcher
 *
 * Authority (entry surface): OpenAI Chat Completions API
 *   https://platform.openai.com/docs/api-reference/chat/create
 * Authority (IR): ADR 0003
 * Authority (provider dispatch): ADR 0002
 * Authority (cache layer): ADR 0005
 *
 * Design principles (OCP precedent, ESM/.mjs, http built-ins, no external deps):
 * - Node ESM, no build step, no bundler
 * - http built-in only (no Express/Fastify)
 * - Zero runtime npm dependencies in the proxy core
 *
 * Env vars:
 *   OLP_PORT  — listen port (default: 4567 since D60 / v0.4.0 — moved off 3456
 *               so OLP can co-host with OCP for migration windows. ADR 0010 §
 *               Default port. Set OLP_PORT=3456 explicitly to restore the
 *               pre-D60 default when not co-hosting with OCP.)
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { openAIToIR, BadRequestError } from './lib/ir/openai-to-ir.mjs';
import {
  irChunkToOpenAISSE,
  irResponseToOpenAINonStream,
  generateRequestId,
  SSE_DONE,
} from './lib/ir/ir-to-openai.mjs';
import {
  loadProviders,
  listAllProviderNames,
  getAliasMap,
  getModelCreated,
  tryAcquireSpawn,
  releaseSpawn,
  getActiveSpawnCount,
  DEFAULT_MAX_CONCURRENT_SPAWNS,
} from './lib/providers/index.mjs';
import { ProviderError } from './lib/providers/base.mjs';
import { computeCacheKey, hasCacheControl, extractCacheControlMarkers } from './lib/cache/keys.mjs';
import { CacheStore } from './lib/cache/store.mjs';
import {
  evaluateHardTriggers,
  executeWithFallback,
  buildDefaultChain,
  loadFallbackConfigSync,
} from './lib/fallback/engine.mjs';
// Phase 2 / D45 — multi-key auth integration per ADR 0007.
import {
  validateKey,
  touchLastUsed,
  loadAuthConfigSync,
  ANONYMOUS_KEY_ID,
  ENV_OWNER_KEY_ID,
} from './lib/keys.mjs';
import { appendAuditEvent } from './lib/audit.mjs';
// Phase 3 / D50 — management endpoints consume the audit aggregate query layer.
import {
  aggregateRequests as auditAggregateRequests,
  topFallbackChains as auditTopFallbackChains,
  spendTrendDaily as auditSpendTrendDaily,
  cacheHitRateWindow as auditCacheHitRateWindow,
} from './lib/audit-query.mjs';

// ── Config ────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
const VERSION = pkg.version;

const PORT = parseInt(process.env.OLP_PORT ?? '4567', 10);
const BODY_LIMIT = 5 * 1024 * 1024; // 5 MB

// ── Logging ───────────────────────────────────────────────────────────────
// Defined early so it is available for startup-time warnings (e.g. F16
// soft-trigger deferred warning) before the provider registry is loaded.

function logEvent(level, event, data = {}) {
  const entry = { ts: new Date().toISOString(), level, event, ...data };
  if (level === 'error' || level === 'warn') {
    process.stderr.write(JSON.stringify(entry) + '\n');
  } else {
    process.stdout.write(JSON.stringify(entry) + '\n');
  }
}

// ── Startup config ────────────────────────────────────────────────────────
// Read ~/.olp/config.json once at startup. Provides:
//   - providers.enabled   → which providers are loaded (ADR 0002 § Disable model)
//   - routing.chains      → fallback chain config (ADR 0004 § D9)
//   - routing.soft_triggers → soft trigger thresholds (ADR 0004)
// If the file is absent or malformed, defaults are safe:
//   empty providersEnabled → all 503 (ALIGNMENT.md § v0.1 zero-Enabled-Providers posture)
//   empty chains/soft_triggers → single-hop mode
const _startupConfig = loadFallbackConfigSync();

// D26 round-3 F16: soft triggers are deferred to v1.x per ADR 0004 Amendment 2.
// If the user has configured any, emit a startup warning so the inert state is
// observable rather than silently ignored. ADR 0004 Amendment 2 § Mitigations.
const _softTriggersConfigured = Object.keys(_startupConfig.soft_triggers ?? {}).length > 0;
if (_softTriggersConfigured) {
  logEvent('warn', 'soft_triggers_deferred_v1x', {
    configured_providers: Object.keys(_startupConfig.soft_triggers),
    message: 'routing.soft_triggers configured but soft triggers are deferred to v1.x; ' +
      'thresholds will not fire at v0.1 — see ADR 0004 Amendment 2',
  });
}

// ── Auth config (Phase 2 / D45, ADR 0007 § 7.2) ───────────────────────────
// auth.allow_anonymous default false (production-off). Test seam below.
let _authConfig = loadAuthConfigSync();
if (_authConfig.allow_anonymous === true) {
  logEvent('warn', 'auth_allow_anonymous_enabled', {
    message: 'config.json auth.allow_anonymous is true — all routes accept requests without an OLP API key; production deployments should set this to false (ADR 0007 § 7).',
  });
}

/** @internal — test seam: inject a synthetic auth config (no file I/O). */
export function __setAuthConfig(config) {
  _authConfig = config ?? { allow_anonymous: false, owner_only_endpoints: ['/health'], fallback_detail_header_policy: 'owner_only' };
}

/** @internal — reset auth config to file-loaded state. */
export function __resetAuthConfig() {
  _authConfig = loadAuthConfigSync();
}

// ── Provider registry ─────────────────────────────────────────────────────
// ALIGNMENT.md § Provider Inventory: 0 Enabled Providers at v0.1 unless
// ~/.olp/config.json has providers.enabled.X = true.
// ADR 0002 § Disable model: enabled toggle in config.json transitions Candidate → Enabled.
const loadedProviders = loadProviders({ enabled: _startupConfig.providersEnabled ?? {} });

// ── Fallback config ───────────────────────────────────────────────────────
// Read ~/.olp/config.json routing.chains at startup. Empty at v0.1.
// Per ADR 0004 § D9: fallback engine is wired; activates when user populates chains.
// Tests may inject a synthetic fallbackConfig via __setFallbackConfig().
let _fallbackConfig = _startupConfig;

/** @internal — test seam: inject a synthetic fallback config (no file I/O) */
export function __setFallbackConfig(config) {
  _fallbackConfig = config ?? { chains: {}, soft_triggers: {} };
}

/** @internal — reset to file-based config */
export function __resetFallbackConfig() {
  _fallbackConfig = loadFallbackConfigSync();
}

/**
 * @internal — test seam: reload loadedProviders to match a given enabledMap.
 * Mirrors __setFallbackConfig. Allows tests to exercise the production
 * loadProviders() code path without touching the config file.
 *
 * Usage: __setProvidersEnabled({ anthropic: true }) before creating a server.
 * Reset: __resetProvidersEnabled() or __setProvidersEnabled({}) to clear all.
 *
 * @param {Record<string, boolean>} enabledMap
 */
export function __setProvidersEnabled(enabledMap) {
  const next = loadProviders({ enabled: enabledMap ?? {} });
  // Mutate the shared map in-place so existing references see the update.
  loadedProviders.clear();
  for (const [name, p] of next) {
    loadedProviders.set(name, p);
  }
}

/** @internal — reset loadedProviders to the startup-config state */
export function __resetProvidersEnabled() {
  const startup = loadFallbackConfigSync();
  const next = loadProviders({ enabled: startup.providersEnabled ?? {} });
  loadedProviders.clear();
  for (const [name, p] of next) {
    loadedProviders.set(name, p);
  }
}

/** @internal — clear the cache store (for tests that need a fresh cache state) */
export function __clearCache() {
  cacheStore.clear();
}

// ── Cache layer ───────────────────────────────────────────────────────────
// D1 per-key isolation + D4 singleflight per ADR 0005.
// keyId: '__anonymous__' at D5 — Phase 2 multi-key infrastructure wires in
// the real OLP API key ID here.
export const cacheStore = new CacheStore();

// ── Body reader ───────────────────────────────────────────────────────────

/**
 * Reads and JSON-parses the request body.
 * Enforces the 5MB body limit.
 * Throws on parse failure or oversized body.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
function readJSON(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('Request body too large (limit 5MB)'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error('Invalid JSON in request body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// ── Response helpers ──────────────────────────────────────────────────────

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} body
 * @param {Record<string,string>} [extraHeaders]
 */
function sendJSON(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

/**
 * OpenAI-format error response helper.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} message
 * @param {string} type
 * @param {Record<string,string>} [extraHeaders] — optional extra headers (e.g. X-OLP-Latency-Ms)
 */
function sendError(res, status, message, type, extraHeaders = {}) {
  sendJSON(res, status, { error: { message, type } }, extraHeaders);
}

// ── OLP response headers ──────────────────────────────────────────────────

/**
 * Returns the standard OLP diagnostic headers.
 * Per spec §4.7 and ADR 0004 § Observability headers:
 *   X-OLP-Provider-Used, X-OLP-Model-Used, X-OLP-Fallback-Hops,
 *   X-OLP-Cache, X-OLP-Latency-Ms.
 * Fallback-Hops reflects which chain index served the request (0=primary).
 * Cache reflects actual hit/miss/bypass status from the cache layer (ADR 0005).
 *
 * @param {object} opts
 * @param {string} opts.providerUsed
 * @param {string} opts.modelUsed
 * @param {number} opts.startMs
 * @param {'hit'|'miss'|'bypass'} [opts.cacheStatus='miss']
 * @param {number} [opts.fallbackHops=0] — from executeWithFallback result
 * @returns {Record<string,string>}
 */
function olpHeaders({ providerUsed, modelUsed, startMs, cacheStatus = 'miss', fallbackHops = 0 }) {
  return {
    'X-OLP-Provider-Used': providerUsed,
    'X-OLP-Model-Used': modelUsed,
    'X-OLP-Fallback-Hops': String(fallbackHops),
    'X-OLP-Cache': cacheStatus,
    'X-OLP-Latency-Ms': String(Date.now() - startMs),
  };
}

/**
 * Returns the standard 5-header OLP diagnostic set for pre-chain error paths
 * (no provider was attempted yet). Used by sendError call sites that occur
 * before chain construction (415 wrong Content-Type, 400 bad JSON, 400 IR
 * validation failure, 503 no-enabled-providers).
 *
 * Per F8 (D32 round-4 cold-audit): ADR 0004 § Observability requires the full
 * 5-header set on every response; early error paths must emit canonical
 * "no provider attempted" defaults.
 *
 * @param {object} opts
 * @param {number} opts.startMs — request start timestamp (Date.now())
 * @param {string|null|undefined} [opts.model] — ir.model if IR was parsed; undefined/null otherwise
 * @returns {Record<string,string>}
 */
function olpErrorHeaders({ startMs, model }) {
  return {
    'X-OLP-Provider-Used': 'none',
    'X-OLP-Model-Used': model ?? 'unknown',
    'X-OLP-Fallback-Hops': '0',
    'X-OLP-Cache': 'bypass',
    'X-OLP-Latency-Ms': String(Date.now() - startMs),
  };
}

// ── X-OLP-Fallback-Detail (D40, issue #7) ─────────────────────────────────

/**
 * 4KB UTF-8 byte cap on the X-OLP-Fallback-Detail header value. Per RFC 7230 §3.2.5
 * intermediaries are not obligated to forward arbitrarily large header values;
 * 4KB matches the conservative upper bound (well below the 8KB total-header
 * default of common reverse proxies — nginx `large_client_header_buffers`,
 * Apache `LimitRequestFieldSize`). Tuples beyond the cap are dropped and
 * a sentinel { truncated:true, omitted_hops:N } is appended.
 */
export const FALLBACK_DETAIL_BYTE_CAP = 4096;

/**
 * Serialises per-hop fallback failure tuples into the X-OLP-Fallback-Detail
 * header value. Returns null if the input array is empty/missing (header
 * should not be emitted in that case).
 *
 * D40 (issue #7) — see ADR 0004 § Observability headers.
 *
 * Cap behaviour:
 *   - JSON.stringify the tuples; if Buffer.byteLength <= 4096, return as-is.
 *   - Otherwise, drop tuples from the tail one at a time until the array PLUS
 *     a trailing { truncated:true, omitted_hops:N } sentinel fits under the cap.
 *   - If even a single tuple + sentinel cannot fit (extremely long error_message
 *     beyond engine truncation, e.g. very long provider/model names), return
 *     just the sentinel { truncated:true, omitted_hops:<all> } — never produce
 *     a value > 4096 bytes.
 *
 * RFC 7230 hygiene: JSON.stringify already escapes raw newlines (\n → \\n),
 * carriage returns, and other control characters. In addition, we escape all
 * non-ASCII code points to \uXXXX sequences because Node's HTTP header
 * validator rejects multi-byte UTF-8 in field values (and RFC 7230 §3.2.6
 * limits `field-vchar` to ASCII VCHAR / obs-text). Without this step, an
 * em dash (U+2014) in a synthesised error message — e.g. the CONCURRENCY_LIMIT
 * message produced in server.mjs `collectAllChunks` — would trigger
 * `Invalid character in header content` from `res.writeHead`.
 *
 * @param {Array<object>|null|undefined} fallbackDetail — from FallbackResult.fallbackDetail
 * @returns {string|null} — header value, or null to skip emission
 */
export function serializeFallbackDetailHeader(fallbackDetail) {
  if (!Array.isArray(fallbackDetail) || fallbackDetail.length === 0) {
    return null;
  }
  const full = jsonStringifyAscii(fallbackDetail);
  if (Buffer.byteLength(full, 'utf8') <= FALLBACK_DETAIL_BYTE_CAP) {
    return full;
  }

  // Cap exceeded — drop tail tuples until [...kept, sentinel] fits.
  // Linear scan from the full array down to 0 kept tuples. Worst case O(n^2)
  // on serialisation length, but n is bounded by chain length (small) so this
  // is fine in practice.
  for (let kept = fallbackDetail.length - 1; kept >= 0; kept--) {
    const omitted = fallbackDetail.length - kept;
    const sentinel = { truncated: true, omitted_hops: omitted };
    const candidate = jsonStringifyAscii([...fallbackDetail.slice(0, kept), sentinel]);
    if (Buffer.byteLength(candidate, 'utf8') <= FALLBACK_DETAIL_BYTE_CAP) {
      return candidate;
    }
  }

  // Even an array containing only the sentinel exceeds the cap — produce the
  // shortest possible valid sentinel value. This branch should be unreachable
  // for any realistic chain (the sentinel itself is ~45 bytes for omitted_hops
  // up to 9999).
  return jsonStringifyAscii([{ truncated: true, omitted_hops: fallbackDetail.length }]);
}

/**
 * JSON.stringify wrapper that escapes every non-ASCII code point as \uXXXX
 * so the result is safe to embed in an HTTP header value (RFC 7230 §3.2.6
 * field-vchar). JSON itself accepts both literal Unicode and \uXXXX escapes,
 * so JSON.parse round-trips correctly.
 *
 * Surrogate-pair handling: characters above U+FFFF (emoji etc.) are already
 * emitted as JS surrogate pairs by the string iterator; each surrogate is
 * a code unit in range 0xD800–0xDFFF, which our >= 0x80 guard catches.
 *
 * @param {unknown} value
 * @returns {string}
 */
function jsonStringifyAscii(value) {
  // The replace pattern is the UTF-8 literal byte range for code points
  // U+0080..U+FFFF (every non-ASCII BMP character). U+0080 is non-printable,
  // so the source line can render as the empty character class "[-...]" in
  // editors that hide it — the range is intentional and load-bearing for
  // RFC 7230 §3.2.6 compliance.
  return JSON.stringify(value).replace(/[-￿]/g, (ch) => {
    return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
  });
}

/**
 * Identity-aware gate for X-OLP-Fallback-Detail emission per ADR 0007 § 7.2.
 * Reads `_authConfig.fallback_detail_header_policy`:
 *   - 'owner_only' (default) → emit only when olpIdentity.owner_tier === 'owner'
 *   - 'all'                  → emit unconditionally (v0.1.1 behaviour, opt-in)
 *   - 'none'                 → suppress unconditionally
 * When olpIdentity is null (early-error paths before auth completed),
 * defaults to 'all' → emit (preserves the v0.1.1 ungated behaviour for
 * pre-auth errors where we don't yet know identity).
 *
 * @param {{owner_tier?: string}|null|undefined} olpIdentity
 * @returns {boolean}
 */
function shouldEmitFallbackDetailHeader(olpIdentity) {
  const policy = _authConfig?.fallback_detail_header_policy ?? 'owner_only';
  if (policy === 'none') return false;
  if (policy === 'all') return true;
  // 'owner_only' — gate by identity tier
  if (!olpIdentity) return true; // pre-auth path: don't suppress diagnostic info
  return olpIdentity.owner_tier === 'owner';
}

/**
 * Merges X-OLP-Fallback-Detail into a base header object when the per-hop
 * failure tuples are non-empty AND the per-request identity is permitted
 * to see the header per the policy (ADR 0007 § 7.2). Returns the base
 * object unchanged otherwise.
 *
 * D40 (issue #7) — gating added at D46 per ADR 0004 Amendment 5 ratification.
 *
 * @param {Record<string,string>} baseHeaders
 * @param {Array<object>|null|undefined} fallbackDetail
 * @param {{owner_tier?: string}|null|undefined} olpIdentity - request identity; null on pre-auth paths
 * @returns {Record<string,string>}
 */
function withFallbackDetailHeader(baseHeaders, fallbackDetail, olpIdentity) {
  if (!shouldEmitFallbackDetailHeader(olpIdentity)) return baseHeaders;
  const value = serializeFallbackDetailHeader(fallbackDetail);
  if (value === null) return baseHeaders;
  return { ...baseHeaders, 'X-OLP-Fallback-Detail': value };
}

// ── Route handlers ────────────────────────────────────────────────────────

// ── Auth middleware (Phase 2 / D45, ADR 0007 § 5 + § 7) ───────────────────

/**
 * Extract the plaintext OLP token from request headers.
 * Tries `Authorization: Bearer <token>` first, then `x-api-key: <token>`.
 * Returns the token string or null.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string|null}
 */
function extractToken(req) {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(\S+)$/i.exec(auth);
    if (match) return match[1];
  }
  const xKey = req.headers['x-api-key'];
  if (typeof xKey === 'string' && xKey.length > 0) return xKey;
  return null;
}

/**
 * Authenticate the request per ADR 0007 §§ 5 / 7 / 9.4.
 *   - Try env-owner override first (OLP_OWNER_TOKEN).
 *   - Then filesystem manifest lookup by SHA-256 hash.
 *   - Else, if auth.allow_anonymous is true → anonymous identity.
 *   - Else → 401 auth_required.
 *
 * Returns { ok: true, authContext } on success or
 * { ok: false, status, code, message } on failure (401).
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ ok: true, authContext: { keyId: string, owner_tier: 'owner'|'guest'|'anonymous', providers_enabled: string[]|'*', source: 'env'|'filesystem'|'anonymous' } } | { ok: false, status: number, code: string, message: string }}
 */
function authenticate(req) {
  const token = extractToken(req);
  const identity = validateKey(token, { allowAnonymous: _authConfig.allow_anonymous });
  if (identity === null) {
    // Distinguish "no token presented" from "token presented but invalid/revoked".
    // Both surface as 401 to the client (don't leak which case it was), but the
    // server-side audit + log captures the source for operator diagnosis.
    return {
      ok: false,
      status: 401,
      code: token ? 'invalid_or_revoked_key' : 'auth_required',
      message: token
        ? 'OLP API key is invalid or has been revoked.'
        : 'OLP API key required. Pass via "Authorization: Bearer <token>" or "x-api-key: <token>".',
    };
  }
  return {
    ok: true,
    authContext: {
      keyId: identity.id,
      owner_tier: identity.owner_tier,
      providers_enabled: identity.providers_enabled,
      source: identity.source,
    },
  };
}

/**
 * Check whether the given provider key is permitted for this identity.
 * `providers_enabled: '*'` grants all; an array is a whitelist.
 *
 * @param {{ providers_enabled: string[]|'*' }} authContext
 * @param {string} providerKey
 * @returns {boolean}
 */
function isProviderEnabled(authContext, providerKey) {
  if (authContext.providers_enabled === '*') return true;
  return Array.isArray(authContext.providers_enabled) && authContext.providers_enabled.includes(providerKey);
}

/**
 * GET /health
 *
 * Phase 2 / D46 (ADR 0007 § 7.1): identity-aware payload.
 *   - owner identity     → full per-provider details (existing payload)
 *   - guest / anonymous  → trimmed { ok, version } only
 *   - no auth, allow_anonymous=false → 401 (consistent with /v1/* routes)
 *
 * The trimming behavior is gated on `_authConfig.owner_only_endpoints` —
 * the entry `/health` lives there by default. Removing `/health` from
 * the list reverts to v0.1.1 full-payload-to-everyone behaviour.
 *
 * Authority: ADR 0007 § 7.1 (Identity-class table) + § 7.2 (owner_only_endpoints).
 * Closes acceptance criterion #4.
 */
async function handleHealth(req, res) {
  const startMs = Date.now();

  // D46: audit on /health is intentionally NOT enabled at Phase 2.
  // /health is a high-volume monitoring endpoint; per-call audit rows would
  // generate operational noise that has no observability value until a
  // Phase 3+ Dashboard aggregates /health stats. Deferred to Phase 3.

  const authResult = authenticate(req);
  if (!authResult.ok) {
    return sendError(res, authResult.status, authResult.message, authResult.code);
  }
  const olpIdentity = authResult.authContext;

  // Per § 7.1: owner sees full payload; guest + anonymous see trimmed.
  // Per § 7.2: gating is opt-out via `owner_only_endpoints` config; if
  // `/health` is removed from the list, all identities see the full
  // payload (operators wanting v0.1.1 behaviour have this knob).
  const gatedEndpoints = Array.isArray(_authConfig?.owner_only_endpoints)
    ? _authConfig.owner_only_endpoints
    : ['/health'];
  const isGated = gatedEndpoints.includes('/health');
  const isOwner = olpIdentity.owner_tier === 'owner';

  // Touch last_used_at for filesystem identities post-response. The callee
  // also early-returns on ANONYMOUS / ENV_OWNER keyIds (lib/keys.mjs § 6.3
  // wrapper) — this guard is defense-in-depth + skip the async call entirely
  // for non-filesystem identities.
  if (olpIdentity.keyId !== ANONYMOUS_KEY_ID && olpIdentity.keyId !== ENV_OWNER_KEY_ID) {
    res.on('finish', () => {
      touchLastUsed(olpIdentity.keyId).catch(() => {});
    });
  }

  if (isGated && !isOwner) {
    // Trimmed payload per § 7.1.
    return sendJSON(res, 200, { ok: true, version: VERSION });
  }

  // Full payload (owner OR /health removed from owner_only_endpoints).
  const enabled = loadedProviders.size;
  const available = listAllProviderNames().length;
  const providerStatuses = {};
  for (const [name, provider] of loadedProviders) {
    // D56 / v1.x roadmap #4 (ADR 0002 Amendment 6 forward note): surface
    // per-provider active spawn count for capacity-planning observability.
    // D38 shipped getActiveSpawnCount; this is the /health integration.
    // The field is set BEFORE healthCheck() in case healthCheck throws —
    // activeSpawns is cheap (in-memory counter read) and useful even
    // when healthCheck fails.
    const activeSpawns = getActiveSpawnCount(name);
    try {
      providerStatuses[name] = { ...(await provider.healthCheck()), activeSpawns };
    } catch (e) {
      providerStatuses[name] = { ok: false, error: e.message, activeSpawns };
    }
  }
  sendJSON(res, 200, {
    ok: true,
    version: VERSION,
    providers: { enabled, available, status: providerStatuses },
  });
}

/**
 * GET /v1/models
 * Returns the list of models served by all currently loaded (enabled) providers.
 * Per ADR 0002 § "Loading model" + OpenAI spec /v1/models:
 *   Each entry: { id, object: 'model', created, owned_by }
 *   - id:        canonical model ID (or alias string for alias entries)
 *   - object:    literal 'model' (OpenAI spec)
 *   - created:   Unix epoch seconds (stable per request; computed once from Date.now())
 *   - owned_by:  provider.name (e.g. 'anthropic', 'openai', 'mistral')
 * Order: canonical models first (insertion order of loadedProviders, then models[]),
 *        then alias entries (for aliases whose target provider is currently loaded).
 * Authority: OpenAI /v1/models spec (https://platform.openai.com/docs/api-reference/models);
 *            models-registry.json alias map (SPOT per D17); F15 round-3 adds alias surfacing.
 * Empty case: if no providers are enabled, data: [] is returned naturally.
 */
function handleModels(req, res) {
  const startMs = Date.now();

  // Audit + auth for /v1/models per Phase 2 / D45 (ADR 0007 § 7).
  const auditCtx = {
    ts: new Date().toISOString(),
    key_id: ANONYMOUS_KEY_ID,
    owner_tier: 'anonymous',
    method: 'GET',
    path: '/v1/models',
    provider: null,
    model: null,
    status_code: 0,
    latency_ms: 0,
    cache_status: null,
    fallback_hops: 0,
    tried_providers: [],
    error_code: null,
    ir_request_hash: null,
    chain_id: null,
  };
  let _authedKeyId = null;
  res.on('finish', () => {
    auditCtx.status_code = res.statusCode;
    auditCtx.latency_ms = Date.now() - startMs;
    try { appendAuditEvent(auditCtx); } catch { /* best-effort */ }
    if (_authedKeyId && _authedKeyId !== ANONYMOUS_KEY_ID) {
      touchLastUsed(_authedKeyId).catch(() => {});
    }
  });

  const authResult = authenticate(req);
  if (!authResult.ok) {
    auditCtx.error_code = authResult.code;
    return sendError(res, authResult.status, authResult.message, authResult.code,
      olpErrorHeaders({ startMs }));
  }
  auditCtx.key_id = authResult.authContext.keyId;
  auditCtx.owner_tier = authResult.authContext.owner_tier;
  _authedKeyId = authResult.authContext.keyId;

  const data = [];

  // Canonical entries first
  for (const [providerName, provider] of loadedProviders) {
    for (const modelId of provider.models) {
      data.push({
        id: modelId,
        object: 'model',
        // F12 (round-5 cold-audit): use stable per-model timestamp from
        // models-registry.json rather than Date.now() on each request.
        // OpenAI spec treats `created` as a stable per-model attribute.
        created: getModelCreated(modelId),
        owned_by: providerName,
      });
    }
  }

  // Alias entries for loaded (enabled) providers, canonical-first ordering preserved
  for (const [alias, { providerName, canonicalModel }] of getAliasMap()) {
    if (loadedProviders.has(providerName)) {
      data.push({
        id: alias,
        object: 'model',
        // Alias entries use the same stable timestamp as their canonical model.
        created: getModelCreated(canonicalModel),
        owned_by: providerName,
      });
    }
  }

  sendJSON(res, 200, { object: 'list', data });
}

/**
 * POST /v1/chat/completions
 * Core dispatch path: OpenAI request → IR → fallback engine → provider.spawn → OpenAI response.
 *
 * D9: Fallback engine (ADR 0004) is wired between IR construction and provider.spawn.
 * Chain advancement, soft/hard trigger evaluation, and first-chunk safety are all
 * handled by executeWithFallback(). At v0.1 with empty routing.chains config, this
 * is a transparent single-hop pass-through. Multi-hop fallback activates when the
 * user populates ~/.olp/config.json.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleChatCompletions(req, res) {
  const startMs = Date.now();

  // Audit context — fields populated as the request proceeds; § 8 schema.
  // Fired on res.on('finish') below regardless of success / error path.
  const auditCtx = {
    ts: new Date().toISOString(),
    key_id: ANONYMOUS_KEY_ID,        // updated post-auth
    owner_tier: 'anonymous',         // updated post-auth
    method: 'POST',
    path: '/v1/chat/completions',
    provider: null,
    model: null,
    status_code: 0,                  // updated on finish
    latency_ms: 0,                   // updated on finish
    cache_status: null,
    fallback_hops: 0,
    tried_providers: [],
    error_code: null,
    ir_request_hash: null,
    chain_id: null,
  };
  // Wire post-response audit + lazy last_used_at update once, at the top, so
  // every code path below (401, 400, 500, 200, streaming) emits an audit row.
  // touchLastUsed is best-effort and never throws (§ 6.3).
  let _authedKeyId = null;
  res.on('finish', () => {
    auditCtx.status_code = res.statusCode;
    auditCtx.latency_ms = Date.now() - startMs;
    try { appendAuditEvent(auditCtx); } catch { /* audit is best-effort */ }
    if (_authedKeyId && _authedKeyId !== ANONYMOUS_KEY_ID) {
      // Anonymous + __env_owner__ have no on-disk manifest to touch; touchLastUsed
      // itself early-returns for those identities (§ 6.3 wrapper). For
      // filesystem-stored keys, fire-and-forget.
      touchLastUsed(_authedKeyId).catch(() => { /* warned internally */ });
    }
  });

  // ── Authentication (Phase 2 / D45, ADR 0007 § 5 + § 7) ───────────────────
  // olpIdentity carries the OLP-side identity (keyId / owner_tier /
  // providers_enabled). It is SEPARATE from `authContext` which is the
  // per-provider OAuth/credential artifact passed to provider.spawn().
  // Provider plugins treat `authContext === null` as "fall back to your
  // own credential discovery (env / keychain / file)" — that contract is
  // preserved at D45. Per-provider per-key credential mapping is a Phase
  // 3+ concern (ADR 0007 § 12 Out of scope; v0.1 spec § 4.5 anticipated).
  const authResult = authenticate(req);
  if (!authResult.ok) {
    auditCtx.error_code = authResult.code;
    return sendError(res, authResult.status, authResult.message, authResult.code,
      olpErrorHeaders({ startMs }));
  }
  const olpIdentity = authResult.authContext;
  auditCtx.key_id = olpIdentity.keyId;
  auditCtx.owner_tier = olpIdentity.owner_tier;
  _authedKeyId = olpIdentity.keyId;

  // Require JSON content-type
  const ct = req.headers['content-type'] ?? '';
  if (!ct.includes('application/json')) {
    auditCtx.error_code = 'invalid_content_type';
    return sendError(res, 415, 'Content-Type must be application/json', 'invalid_request_error',
      olpErrorHeaders({ startMs }));
  }

  let body;
  try {
    body = await readJSON(req);
  } catch (e) {
    auditCtx.error_code = 'invalid_request_body';
    return sendError(res, e.statusCode ?? 400, e.message, 'invalid_request_error',
      olpErrorHeaders({ startMs }));
  }

  // Translate OpenAI → IR (ADR 0003)
  let ir;
  try {
    ir = openAIToIR(body);
  } catch (e) {
    if (e instanceof BadRequestError) {
      auditCtx.error_code = 'invalid_ir';
      return sendError(res, 400, e.message, 'invalid_request_error',
        olpErrorHeaders({ startMs }));
    }
    throw e;
  }
  auditCtx.model = ir.model;

  // ── Fallback engine: build chain (ADR 0004) ─────────────────────────────
  // buildDefaultChain returns null if no enabled provider serves this model.
  // Per ADR 0004 § D9: at v0.1, chain is single-hop (no fallback) unless the
  // user has populated ~/.olp/config.json routing.chains.
  //
  // `let` (not `const`) because the chain may be filtered below per the
  // authenticated key's providers_enabled allowlist (ADR 0007 § 10 #11).
  let chain = buildDefaultChain(
    ir.model,
    loadedProviders,
    _fallbackConfig.chains,
    _fallbackConfig.soft_triggers,
  );

  if (!chain) {
    // ALIGNMENT.md: 0 Enabled Providers at v0.1 → 503 per spec
    auditCtx.error_code = 'no_enabled_provider';
    return sendError(
      res, 503,
      `No enabled providers for model ${ir.model}. See README § Supported Providers.`,
      'no_enabled_provider',
      olpErrorHeaders({ startMs, model: ir.model }),
    );
  }

  // ── providers_enabled scope enforcement (Phase 2 / D45, ADR 0007 § 10 #11) ─
  // Filter the chain to providers this key is authorized for. If the resulting
  // chain is empty, return 403 — the model exists in the registry but no hop
  // is reachable from this identity's allowlist.
  const _originalChainProviders = chain.map(hop => hop.provider);
  chain = chain.filter(hop => isProviderEnabled(olpIdentity, hop.provider));
  if (chain.length === 0) {
    auditCtx.error_code = 'key_no_provider_access';
    // D53 (D45 P2 deferral fix): tried_providers semantic per ADR 0007 § 8 is
    // "providers the server actually dispatched a spawn against". On 403 the
    // filtered chain is empty — no provider was dispatched, so the audit
    // value is []. The configured-but-blocked chain providers go into the
    // human-readable error message + a separate _diagnostic field we don't
    // surface in audit (would distort downstream queries like "which
    // providers did key X actually call"). ADR 0007 § 8 amended in this
    // D-day's CHANGELOG entry to spell the semantic.
    auditCtx.tried_providers = [];
    const allowed = olpIdentity.providers_enabled === '*' ? '*' : (olpIdentity.providers_enabled ?? []).join(', ') || '(none)';
    return sendError(
      res, 403,
      `This OLP key does not have access to any provider serving model "${ir.model}". Key's providers_enabled: [${allowed}]. Chain providers: [${_originalChainProviders.join(', ')}].`,
      'key_no_provider_access',
      olpErrorHeaders({ startMs, model: ir.model }),
    );
  }

  // Auth context is null at D45 — providers fall back to their own credential
  // discovery (env var, keychain, credentials file). The OLP-side identity
  // (olpIdentity above) is consumed for cache namespacing + providers_enabled
  // gating + audit attribution. Per-provider per-key credential mapping is a
  // Phase 3+ deferral (ADR 0007 § 12).
  const authContext = null;

  const requestId = generateRequestId();

  // ── Cache layer (ADR 0005, namespaced per OLP key per ADR 0007 § 7) ─────
  // keyId is the authenticated identity's namespace token. For anonymous
  // (when auth.allow_anonymous=true) this is the legacy '__anonymous__'
  // shared namespace; for filesystem keys it is the per-key id; for the
  // OLP_OWNER_TOKEN env override it is the synthetic '__env_owner__'.
  const keyId = olpIdentity.keyId;

  // D2 bypass (per-hop, per ADR 0005 § D2):
  // cache_control markers bypass OLP's response cache ONLY when the active hop
  // provider is Anthropic. For non-Anthropic hops the markers are noop'd
  // (openai-to-ir already strips them from the IR before provider translation,
  // so they never reach a non-Anthropic plugin — no separate strip needed here).
  //
  // Pre-compute whether the raw request carries any cache_control markers at all.
  // The per-hop decision is: markers present AND hop is Anthropic → bypass.
  const hasCacheControlMarkers =
    hasCacheControl(ir) || extractCacheControlMarkers(body?.messages ?? []).length > 0;

  // D36 #2 (ADR 0005 § D2): when cache_control markers are present AND at least one
  // hop in the chain is non-Anthropic, the markers are noop'd for those hops.
  // Per ADR 0005 § Context: "for non-Anthropic targets, the bypass markers are
  // noop'd (logged once per request at debug level so users can see they were
  // ignored)." Fires at most once per request, gated on (markers AND mixed/non-anthropic
  // chain). No log when no markers, or when every chain hop is Anthropic.
  if (hasCacheControlMarkers && chain.some(hop => hop.provider !== 'anthropic')) {
    // marker_count sums body-side and IR-side markers. At v0.1 the IR term is
    // structurally 0 (openAIToIR strips cache_control). When a future ADR 0003
    // amendment activates cache_control in the IR whitelist, both terms will be
    // non-zero for the same logical marker set → revisit to avoid 2× counting.
    const markerCount =
      extractCacheControlMarkers(body?.messages ?? []).length +
      extractCacheControlMarkers(ir.messages ?? []).length;
    logEvent('debug', 'cache_control_partial_noop', {
      chain: chain.map(hop => hop.provider),
      marker_count: markerCount,
    });
  }

  /**
   * Returns true if OLP's response cache should be bypassed for the given hop.
   * Per ADR 0005 § D2: bypass only when provider is Anthropic AND markers present.
   *
   * @param {string} hopProviderName — e.g. 'anthropic', 'openai', 'mistral'
   * @returns {boolean}
   */
  function shouldBypassCacheForHop(hopProviderName) {
    return hasCacheControlMarkers && hopProviderName === 'anthropic';
  }

  // ── executeHopFn: per-hop spawn + cache wrapper ─────────────────────────
  // This is the function executeWithFallback calls for each chain hop.
  // Each hop gets its own (provider, model) cache key per ADR 0005 § Per-model isolation.
  //
  // First-chunk safety (ADR 0004 § Fallback safety):
  //   collectAllChunks fully buffers the provider response before returning.
  //   Therefore, if executeHopFn throws, zero bytes have been written to `res`.
  //   The fallback engine safely advances the chain on hard triggers.
  //   If executeHopFn returns successfully, the chunks are buffered and we write
  //   them to `res` only AFTER executeWithFallback returns — ensuring no writes
  //   occur during chain iteration.
  //
  // F8 (round-5 cold-audit): track whether the SERVING hop's response came from
  // cache. preCheckHit only covered the PRIMARY hop's key; when a fallback hop
  // serves from its own cache, the header must report 'hit', not 'miss'.
  // lastHopWasCached is set by executeHopFn before returning so the cacheStatus
  // computation below can consume it after executeWithFallback completes.
  let lastHopWasCached = false;

  async function executeHopFn(hopProvider, hopModel, irReq) {
    const hopCacheKey = computeCacheKey(hopProvider, hopModel, irReq);
    const hopProviderPlugin = loadedProviders.get(hopProvider);

    if (!hopProviderPlugin) {
      // Provider in the chain is not loaded (config references a disabled provider)
      throw Object.assign(
        new Error(`Provider ${hopProvider} is not enabled`),
        { statusCode: 503 },
      );
    }

    // Collect all chunks from this provider, throwing on error chunks.
    // Error semantics: ProviderError thrown here propagates to executeWithFallback
    // which decides whether to advance the chain.
    //
    // D16 (ADR 0004 Amendment 1): if the generator throws ProviderError SPAWN_FAILED
    // after yielding one or more chunks, those chunks are usable content the provider
    // committed — dropping them and falling back to the next hop is strict waste.
    // In that case: synthesize a stop chunk with finish_reason='length', return the
    // partial chunks, and do NOT re-throw (fallback engine sees a success, hops=0).
    // If chunks.length===0 on SPAWN_FAILED, re-throw as before (hard trigger fires).
    // Any other error code always re-throws unchanged.
    //
    // D16 cache note: truncated responses are NOT cached (ADR 0005 § cache write
    // conditions item 1 requires no truncation). A non-enumerable __truncated marker
    // is set on the returned array so executeHopFn can evict the cache entry below.
    async function collectAllChunks() {
      // D38 (issue #1): maxConcurrent runtime enforcement.
      // Authority: ADR 0002 Amendment 6 + ADR 0004 Amendment 4.
      //
      // Try to acquire a spawn slot for this provider BEFORE invoking spawn().
      // If at limit, synthesise ProviderError(CONCURRENCY_LIMIT) which the
      // fallback engine treats as a hard trigger — the chain advances to the
      // next hop. validateProvider guarantees hints.maxConcurrent is present;
      // DEFAULT_MAX_CONCURRENT_SPAWNS is a defense-in-depth fallback.
      const maxConcurrent = hopProviderPlugin.hints?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_SPAWNS;
      if (!tryAcquireSpawn(hopProvider, maxConcurrent)) {
        const concurrencyErr = new ProviderError(
          `provider ${hopProvider} at maxConcurrent (${maxConcurrent}) — advancing to next hop`,
          'CONCURRENCY_LIMIT',
        );
        concurrencyErr.providerName = hopProvider;
        concurrencyErr.maxConcurrent = maxConcurrent;
        // activeSpawns reflects the live counter at the rejection moment,
        // queried directly. Since tryAcquireSpawn returned false the value
        // equals maxConcurrent — read it explicitly for diagnostic clarity
        // rather than echoing the limit (avoids future-reader confusion).
        concurrencyErr.activeSpawns = getActiveSpawnCount(hopProvider);
        throw concurrencyErr;
      }

      const chunks = [];
      // try/finally: releaseSpawn MUST fire on every exit path — success
      // (return at end), spawn throw (caught and re-thrown below), or the
      // D16 truncation-salvage return. The finally is the only mechanism
      // that guarantees release across all three.
      try {
        try {
          for await (const irChunk of hopProviderPlugin.spawn(irReq, authContext)) {
            // D16: check error chunks BEFORE pushing — preserves the invariant that
            // chunks array contains only delta/stop chunks. Without this, the catch
            // block's `chunks.length > 0` would mistake a single error chunk for
            // "usable content streamed" (Case B) and synthesize a stop + return,
            // sending an empty body to the client when the correct behavior is to
            // re-throw and let the fallback engine advance the chain.
            if (irChunk.type === 'error') {
              throw new ProviderError(
                irChunk.error ?? 'Provider emitted error chunk',
                'SPAWN_FAILED',
              );
            }
            chunks.push(irChunk);
            if (irChunk.type === 'stop') break;
          }
        } catch (spawnErr) {
          if (spawnErr instanceof ProviderError && spawnErr.code === 'SPAWN_FAILED' && chunks.length > 0) {
            // Case B (ADR 0004 Amendment 1): provider emitted usable chunks then exited
            // non-zero. Synthesize a truncated stop and surface the partial response.
            chunks.push({ type: 'stop', finish_reason: 'length' });
            logEvent('warn', 'spawn_failed_after_usable_chunks', {
              chunks_count: chunks.length - 1, // exclude the synthesized stop
              provider: hopProvider,
              model: hopModel,
            });
            // Mark as truncated so the caller can evict this entry from cache.
            Object.defineProperty(chunks, '__truncated', { value: true, enumerable: false });
            return chunks;
          }
          // Case A (SPAWN_FAILED with no chunks) or any other error: re-throw.
          // Fallback engine fires hard trigger and advances chain as before.
          throw spawnErr;
        }
        return chunks;
      } finally {
        // D38: spawn lifecycle ended (drain completed, stop chunk received,
        // SPAWN_FAILED salvage returned, or any unexpected throw). Release
        // the slot so the next caller can acquire it. Single-threaded JS
        // guarantees no other caller has incremented this provider's count
        // between our tryAcquireSpawn() above and this releaseSpawn().
        releaseSpawn(hopProvider);
      }
    }

    // D23: cacheable opt-out check (ADR 0002 Amendment 3 + ADR 0005 Amendment 3).
    // If a provider explicitly sets hints.cacheable === false, skip the cache entirely
    // for every request to this provider. collectAllChunks is called directly; neither
    // cacheStore.get nor cacheStore.set is invoked. This is upstream of D13's
    // cache_control bypass — both are "skip the cache" paths, but for different reasons.
    if (hopProviderPlugin.hints?.cacheable === false) {
      logEvent('debug', 'cache_opted_out', {
        provider: hopProvider,
        model: hopModel,
      });
      return collectAllChunks();
    }

    // D13: per-hop bypass evaluation (ADR 0005 § D2).
    // Bypass only when this hop's provider is Anthropic AND markers are present.
    const bypassCacheForThisHop = shouldBypassCacheForHop(hopProvider);
    if (bypassCacheForThisHop) {
      logEvent('debug', 'cache_bypass', {
        model: hopModel,
        provider: hopProvider,
        reason: 'cache_control_markers',
      });
      return collectAllChunks();
    }

    // D4 singleflight + D1 per-key isolation per ADR 0005.
    // Each hop has its own (provider, model) key — cross-provider contamination
    // is structurally impossible (ADR 0005 § Per-model isolation).
    //
    // D16: after getOrCompute returns, check if collectAllChunks used the salvage
    // path (chunks.__truncated===true). If so, evict the just-written cache entry
    // to satisfy ADR 0005 § "Cache write conditions" item 1 (no truncation).
    // D4 singleflight is preserved: getOrCompute still deduplicates concurrent
    // requests during the spawn; the eviction only affects persistent caching.
    //
    // F8 (round-5 cold-audit): peek before getOrCompute so we know whether the
    // value comes from cache or is freshly computed. peek() is stats-neutral per
    // its contract (no hit/miss counter side-effect), so it does not distort the
    // stats that getOrCompute will update on the canonical miss path.
    // This is option (b) of the F8 spec: check cache BEFORE calling getOrCompute.
    const hopWasCached = await cacheStore.peek(keyId, hopCacheKey);
    const result = await cacheStore.getOrCompute(keyId, hopCacheKey, collectAllChunks);
    // Record for use in cacheStatus computation after executeWithFallback returns.
    lastHopWasCached = hopWasCached;
    if (result.__truncated) {
      // Evict the truncated entry so future requests get a fresh spawn.
      // ADR 0005 § "Cache write conditions" item 1: truncated responses must
      // not persist in cache.
      //
      // D39 (issue #3 Part 1): use explicit cacheStore.delete() rather than
      // the prior set(..., ttlMs=0) tombstone. delete() removes the entry
      // from the namespace Map immediately (and removes the empty namespace
      // entry from the outer Map if applicable), instead of waiting for the
      // next get/peek to lazily purge a TTL=0 entry.
      // Capture the boolean — false indicates a race (concurrent eviction or
      // TTL purge already removed the entry). Surfaces in the log so the
      // dashboard can distinguish "we evicted" from "we tried but it was gone."
      const evicted = cacheStore.delete(keyId, hopCacheKey);
      // D39 (issue #3 Part 2): observability — surface salvage frequency to
      // dashboards. Provider + model identify which hop's truncated entry was
      // evicted. cache_eviction_hit distinguishes actual-evict vs already-gone.
      logEvent('info', 'cache_evicted_truncated', {
        provider: hopProvider,
        model: hopModel,
        cache_eviction_hit: evicted,
      });
    }
    return result;
  }

  // ── Execute with fallback (ADR 0004) ────────────────────────────────────
  // Pre-check for cache status reporting uses first hop's key (primary provider).
  // D13: preCheckHit is gated on whether the first hop would bypass — if it would
  // bypass (anthropic + markers), the cache is not consulted (preCheckHit=false).
  // If the first hop is non-Anthropic (or no markers), the cache peek proceeds normally.
  const bypassCacheForFirstHop = shouldBypassCacheForHop(chain[0].provider);
  // D23: ADR 0002 Amendment 3 — cacheable: false providers skip cache entirely.
  // Compute once here so both the peek guard and the streaming-branch entry condition
  // can consult the same flag without re-reading the plugin map.
  const firstHopProvider = loadedProviders.get(chain[0].provider);
  const cacheableForFirstHop = firstHopProvider?.hints?.cacheable !== false;
  const firstHopCacheKey = computeCacheKey(chain[0].provider, chain[0].model, ir);
  const preCheckHit = (bypassCacheForFirstHop || !cacheableForFirstHop) ? false : await cacheStore.peek(keyId, firstHopCacheKey);

  // ── P1.2: Real SSE streaming path (single-hop cache-miss) ──────────────
  // ADR 0003 entry adapter pattern: for await irChunk → res.write(irChunkToOpenAISSE).
  // Condition: streaming + single-hop + no bypass + no pre-check cache hit.
  //   - stream===true  → caller wants SSE
  //   - chain.length===1  → no fallback needed; first-chunk rule allows streaming
  //   - !bypassCacheForFirstHop + !preCheckHit → genuine cache miss (not hit/bypass)
  //   - cacheableForFirstHop → provider allows caching (D23: cacheable: false falls
  //     through to the buffered executeHopFn path which already respects the opt-out)
  //
  // If any chunk has been written (firstChunkEmitted), fallback is impossible
  // per ADR 0004 § Fallback safety first-chunk rule. On error after first chunk:
  // truncate the response (end with no [DONE]). On error before any chunk:
  // throw so the outer handler can surface a clean error (no bytes written).
  //
  // On success: chunks are written to res, and the cache layer (via
  // getOrComputeStreaming) writes accumulated chunks on source completion.
  //
  // D58 — ADR 0005 Amendment 8 §§7, 11, 12: streaming singleflight via
  // cacheStore.getOrComputeStreaming(...). The peek+spawn TOCTOU window
  // (server.mjs:1104 peek vs. spawn) is collapsed by the synchronous Map
  // check+insert in the cache layer (D57). The D38 tryAcquireSpawn gate now
  // lives INSIDE the sourceFactory closure: only the first caller acquires a
  // slot; attached joiners share it. On factory-throw CONCURRENCY_LIMIT, the
  // cache layer rejects → we fall through to the buffered path (same outcome
  // as today). preCheckHit gates entry exactly as before — the cache_hit
  // outcome from getOrComputeStreaming is the TTL-race safety net; in
  // practice it should not fire because preCheckHit excludes alive entries.
  // See docs/adr/0005-cache-cross-provider.md Amendment 8 + issue #16.
  if (ir.stream && chain.length === 1 && !bypassCacheForFirstHop && !preCheckHit && cacheableForFirstHop) {
    const streamProvider = chain[0].provider;
    const streamModel = chain[0].model;
    const streamCacheKey = computeCacheKey(streamProvider, streamModel, ir);
    const streamPlugin = loadedProviders.get(streamProvider);

    if (!streamPlugin) {
      // Provider disappeared between chain build and here (edge case).
      auditCtx.provider = streamProvider;
      auditCtx.error_code = 'no_enabled_provider';
      return sendError(res, 503, `Provider ${streamProvider} is not enabled`, 'no_enabled_provider',
        olpErrorHeaders({ startMs, model: ir.model }));
    }

    // D58 — ADR 0005 Amendment 8 §7: sourceFactory wraps acquire + spawn.
    // Acquire fires ONLY for the first caller; attached clients share the
    // slot. Release fires EXACTLY ONCE when the source iterator's
    // try/finally executes (normal exhaustion, error, or iterator.return()
    // propagated from sourceAbortController via the cache layer).
    const candidateMax = streamPlugin.hints?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_SPAWNS;
    const sourceFactory = () => {
      if (!tryAcquireSpawn(streamProvider, candidateMax)) {
        const err = new ProviderError(
          `provider ${streamProvider} at maxConcurrent (${candidateMax})`,
          'CONCURRENCY_LIMIT',
        );
        err.providerName = streamProvider;
        err.maxConcurrent = candidateMax;
        err.activeSpawns = getActiveSpawnCount(streamProvider);
        throw err;
      }
      // Wrap streamPlugin.spawn in an async generator that guarantees
      // releaseSpawn fires exactly once in finally — regardless of normal
      // exhaustion, mid-stream throw, or iterator.return() from cache-layer
      // sourceAbortController propagation (§9).
      return (async function* sourceWithRelease() {
        try {
          for await (const irChunk of streamPlugin.spawn(ir, authContext)) {
            yield irChunk;
          }
        } finally {
          releaseSpawn(streamProvider);
        }
      })();
    };

    // D58 — invoke the cache-layer coordinator. CONCURRENCY_LIMIT from the
    // factory falls through to the buffered path (the buffered fallback
    // engine re-attempts acquire). Any other pre-stream error surfaces 502.
    let stream;
    let role;
    try {
      const result = await cacheStore.getOrComputeStreaming(
        keyId,
        streamCacheKey,
        sourceFactory,
        { clientId: requestId },
      );
      stream = result.stream;
      role = result.role;
    } catch (e) {
      if (e instanceof ProviderError && e.code === 'CONCURRENCY_LIMIT') {
        // Fall through to the buffered path — the existing executeHopFn /
        // executeWithFallback machinery re-attempts acquire and surfaces a
        // chain-exhausted 502 for a single-hop chain at maxConcurrent, which
        // matches today's pre-D58 behaviour for this saturation scenario.
        logEvent('debug', 'streaming_concurrency_limit_fallthrough', {
          provider: streamProvider,
          model: streamModel,
        });
        // (proceed past this block)
      } else {
        // Any other pre-first-chunk error — surface a clean 502.
        auditCtx.provider = streamProvider;
        auditCtx.tried_providers = [streamProvider];
        auditCtx.cache_status = 'miss';
        auditCtx.error_code = e?.code ?? 'provider_error';
        logEvent('error', 'streaming_error_before_first_chunk', {
          provider: streamProvider,
          model: streamModel,
          error: e.message,
        });
        return sendError(res, 502, e.message ?? 'Provider error', 'provider_error',
          olpHeaders({ providerUsed: streamProvider, modelUsed: streamModel, startMs, cacheStatus: 'miss', fallbackHops: 0 }));
      }
    }

    if (stream) {
      // D58 — ADR 0005 Amendment 8 §11: cache_status reflects role-of-this-
      // client at attach-time. `source` did real work (miss); `attached`
      // shared a live spawn (streaming_attached); `cache_hit` served from
      // cache (hit). See lib/audit.mjs cache_status JSDoc for the enum.
      auditCtx.provider = streamProvider;
      auditCtx.tried_providers = [streamProvider];
      if (role === 'cache_hit') {
        auditCtx.cache_status = 'hit';
      } else if (role === 'attached') {
        auditCtx.cache_status = 'streaming_attached';
      } else {
        auditCtx.cache_status = 'miss';
      }

      // D58 — ADR 0005 Amendment 8 §9: wire HTTP req close → iterator
      // return() so a client disconnect propagates into the cache layer.
      // Without this the cache layer never learns of disconnect and the
      // source spawn may orphan (last-client-gone abort would not fire).
      // try/catch guards against concurrent return() throws (Node async
      // generators can throw if return() is invoked while iteration is
      // pending). The cache layer's iterator return() is idempotent.
      // D58 — ADR 0005 Amendment 8 §9: detect client disconnect via res
      // 'close' event (not req 'close'). For SSE responses Node emits
      // res.on('close') when the underlying socket goes away while the
      // response is still streaming. req.on('close') in Node 18+ fires only
      // after the response is fully sent, which is too late for our abort
      // propagation needs. Without this wire-up the cache layer would never
      // learn of disconnect → potential orphan spawns.
      const onClose = () => {
        try { stream.return?.(); } catch { /* best-effort */ }
      };
      res.on('close', onClose);

      // D58 — ADR 0005 Amendment 8 §11: X-OLP-Streaming-Inflight header.
      //   role === 'source'   → 'source' (first caller; may upgrade to
      //                          'solo' post-stream if no joiners ever
      //                          attached — see deferral note below).
      //   role === 'attached' → 'attached'
      //   role === 'cache_hit'→ omitted; the existing X-OLP-Cache: hit
      //                          already signals that path.
      // 'solo' (no joiners ever attached) is observable only post-stream —
      // emitted via streaming_inflight_source_done log event with
      // attached_count=0; the wire header reports `source` initially and
      // does NOT flip mid-stream. Future ADR may expose it on a trailer.
      const cacheStatusForHeader = (role === 'cache_hit') ? 'hit' : 'miss';
      const streamHeaders = olpHeaders({
        providerUsed: streamProvider,
        modelUsed: streamModel,
        startMs,
        cacheStatus: cacheStatusForHeader,
        fallbackHops: 0,
      });
      if (role === 'source' || role === 'attached') {
        streamHeaders['X-OLP-Streaming-Inflight'] = role;
      }

      // D14: writeHead is deferred until just before the first res.write so
      // that pre-first-chunk errors can still produce a JSON 502 (matching
      // the buffered path). Calling writeHead unconditionally was the D14
      // defect.

      const streamedChunks = [];
      let firstChunkEmitted = false;
      try {
        for await (const irChunk of stream) {
          if (irChunk.type === 'error') {
            // Error chunk from provider
            if (firstChunkEmitted) {
              // Past first-chunk boundary — emit truncation marker + [DONE].
              logEvent('warn', 'streaming_error_after_first_chunk', {
                provider: streamProvider,
                model: streamModel,
                error: irChunk.error,
              });
              auditCtx.error_code = 'streaming_error_after_first_chunk';
              res.write(irChunkToOpenAISSE({ type: 'stop', finish_reason: 'length' }, requestId, ir.model));
              res.write(SSE_DONE);
              res.end();
              return;
            }
            throw new ProviderError(irChunk.error ?? 'Provider emitted error chunk', 'SPAWN_FAILED');
          }

          if (!res.headersSent) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
              'X-Accel-Buffering': 'no',
              ...streamHeaders,
            });
          }
          streamedChunks.push(irChunk);
          res.write(irChunkToOpenAISSE(irChunk, requestId, ir.model));
          firstChunkEmitted = true;

          if (irChunk.type === 'stop') {
            res.write(SSE_DONE);
            res.end();
            // D58 — ADR 0005 Amendment 8 §4: cache write is performed by the
            // cache layer's tee task on source completion. Server no longer
            // calls cacheStore.set from this branch; the cache layer applies
            // the same write conditions (truncated-not-cached, cacheable:false
            // opt-out, replay-cap, maxEntryBytes cap) internally.
            return;
          }
        }

        // Generator exhausted without a stop chunk — emit truncation marker
        // + [DONE]. D58 — the cache layer (per ADR 0005 Amendment 8 §4) writes
        // accumulatedChunks on normal source exhaustion regardless of stop-
        // chunk semantics; IR-level stop-chunk inspection is the server's
        // responsibility. Mirror D16 truncation-eviction: the source role
        // explicitly deletes the just-written entry so subsequent identical
        // requests respawn (matches D16 buffered-path truncation behaviour
        // and ADR 0005 § "Cache write conditions" item 1). Only the source
        // role performs the delete; attached clients did not trigger the
        // write. Idempotent across concurrent source-truncation observers.
        if (streamedChunks.length > 0) {
          const truncMarker = { type: 'stop', finish_reason: 'length' };
          res.write(irChunkToOpenAISSE(truncMarker, requestId, ir.model));
        }
        if (role === 'source' && cacheableForFirstHop) {
          cacheStore.delete(keyId, streamCacheKey);
        }

        // D35 #9: zero-chunk empty-stream — writeHead deferred (no chunks
        // yielded), emit headers + [DONE] so the response is still valid SSE.
        if (!res.headersSent) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            ...streamHeaders,
          });
        }

        res.write(SSE_DONE);
        res.end();
        if (streamedChunks.length > 0 && cacheableForFirstHop) {
          logEvent('warn', 'streaming_no_stop_chunk', {
            chunks_count: streamedChunks.length,
            provider: streamProvider,
            model: streamModel,
          });
        }
      } catch (e) {
        if (firstChunkEmitted) {
          logEvent('warn', 'streaming_error_after_first_chunk', {
            provider: streamProvider,
            model: streamModel,
            error: e.message,
          });
          res.write(irChunkToOpenAISSE({ type: 'stop', finish_reason: 'length' }, requestId, ir.model));
          res.write(SSE_DONE);
          res.end();
        } else {
          // No bytes written — surface a clean JSON error.
          logEvent('error', 'streaming_error_before_first_chunk', {
            provider: streamProvider,
            model: streamModel,
            error: e.message,
          });
          auditCtx.error_code = e?.code ?? 'provider_error';
          if (!res.headersSent) {
            sendError(res, 502, e.message ?? 'Provider error', 'provider_error',
              olpHeaders({ providerUsed: streamProvider, modelUsed: streamModel, startMs, cacheStatus: 'miss', fallbackHops: 0 }));
          } else {
            res.end();
          }
        }
      } finally {
        // D58 — releaseSpawn lives inside sourceFactory's finally (only the
        // source caller acquired). The req-close listener is detached here
        // so it doesn't leak past the response lifetime.
        res.removeListener('close', onClose);
      }
      return;
    }
    // CONCURRENCY_LIMIT fallthrough — flow continues into the buffered path
    // below.
  }

  let fallbackResult;
  try {
    fallbackResult = await executeWithFallback(chain, ir, executeHopFn, {
      logEvent,
    });
  } catch (e) {
    // executeWithFallback throws only on programming errors (empty chain).
    logEvent('error', 'fallback_engine_error', { error: e.message });
    return sendError(res, 500, 'Internal server error', 'internal_error',
      olpErrorHeaders({ startMs, model: ir.model }));
  }

  const {
    chunks,
    providerUsed,
    modelUsed,
    fallbackHops,
    originalError,
    triedProviders,
    fallbackDetail,  // D40 (issue #7): per-hop failure tuples for X-OLP-Fallback-Detail
  } = fallbackResult;

  // ── Chain exhausted or non-trigger error ─────────────────────────────────
  if (chunks === null) {
    logEvent('error', 'spawn_error', {
      model: ir.model,
      providerUsed,
      fallbackHops,
      triedProviders,
      error: originalError?.message,
    });

    // Emit exhausted header if more than one provider was tried
    const exhaustedHeader = triedProviders.length > 1
      ? { 'X-OLP-Fallback-Exhausted': triedProviders.join(',') }
      : {};

    // Determine status: preserve client errors (400/401/403/404/422) as-is.
    // Otherwise map ProviderError → 502, unknown → 500.
    let errStatus = 502;
    if (originalError) {
      const httpStatus = originalError.statusCode ?? originalError.status ?? null;
      if (httpStatus !== null) {
        errStatus = httpStatus;
      } else if (!(originalError instanceof ProviderError)) {
        errStatus = 500;
      }
    }

    // Per ADR 0004 § Observability headers: all responses (including errors) carry
    // the standard 5-header set. On the exhausted/error path the engine returns
    // values per ADR 0004 step 4 ("preserve A's identity — return the FIRST hop's
    // provider/model and original error to the user"):
    //   - providerUsed: chain[0].provider on chain-exhausted (the primary that
    //                   first failed); set to 'none' only if engine somehow returned null
    //   - modelUsed:    chain[0].model on chain-exhausted, or the original request
    //                   model if engine state is unknown
    //   - cacheStatus:  'miss' — all hops were attempted (bypass is per-hop, not relevant
    //                   when the whole chain exhausted)
    //   - fallbackHops: number of hops actually attempted before exhaustion
    // X-OLP-Fallback-Exhausted is preserved as an additional flag on top of these.
    const errorOlpHeaders = olpHeaders({
      providerUsed: providerUsed ?? 'none',
      modelUsed: modelUsed ?? ir.model,
      startMs,
      cacheStatus: 'miss',
      fallbackHops: fallbackHops ?? 0,
    });

    // Audit ctx capture for chain-exhausted / provider-error path (audit fires
    // on res.on('finish'); fields populated here so the row reflects what we
    // know at exhaustion time — provider is the chain[0] primary per ADR 0004
    // step 4, tried_providers is the failed-hop trail from fallbackDetail).
    auditCtx.provider = providerUsed ?? 'none';
    auditCtx.fallback_hops = fallbackHops ?? 0;
    auditCtx.tried_providers = Array.isArray(fallbackDetail)
      ? fallbackDetail.map(t => t?.provider).filter(Boolean)
      : [];
    auditCtx.cache_status = 'miss';
    auditCtx.error_code = originalError?.code ?? 'provider_error';

    // Send error with standard OLP headers + optional exhausted header +
    // D40 X-OLP-Fallback-Detail (when any hop attempted to spawn failed).
    // D40 (issue #7) — ungated v0.1 per maintainer decision; owner-vs-non-owner
    // gating planned for Phase 2 with lib/keys.mjs.
    const payload = JSON.stringify({
      error: {
        message: originalError?.message ?? 'Provider error',
        type: 'provider_error',
      },
    });
    const detailHeader = withFallbackDetailHeader({}, fallbackDetail, olpIdentity);
    res.writeHead(errStatus, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      ...errorOlpHeaders,
      ...exhaustedHeader,
      ...detailHeader,
    });
    res.end(payload);
    return;
  }

  // ── Success: emit response ─────────────────────────────────────────────
  // Per ADR 0004 § Observability headers: X-OLP-Fallback-Hops reflects the
  // chain index of the serving hop; 0 = primary served, 1 = first fallback, etc.
  // D13: bypass status is per the SERVING hop's provider (providerUsed), not a
  // global flag. If the serving provider was Anthropic and markers were present,
  // the cache was bypassed; otherwise it was a hit (preCheckHit) or miss.
  const bypassCacheForServingHop = shouldBypassCacheForHop(providerUsed);
  // F8 (round-5 cold-audit): cacheStatus accounts for fallback-hop cache hits.
  // preCheckHit covers the primary-hop case (fallbackHops===0); lastHopWasCached
  // covers any hop (including fallback hops that served from their own cache).
  // The two flags combine: if either signals a cache hit AND no bypass, report 'hit'.
  const cacheStatus = bypassCacheForServingHop ? 'bypass'
    : (lastHopWasCached || (preCheckHit && fallbackHops === 0)) ? 'hit'
    : 'miss';
  // D40 (issue #7): when at least one prior hop failed before this success,
  // surface X-OLP-Fallback-Detail with the failure trail. Header is omitted
  // when fallbackDetail is empty (single-hop success).
  const headers = withFallbackDetailHeader(
    olpHeaders({ providerUsed, modelUsed, startMs, cacheStatus, fallbackHops }),
    fallbackDetail,
    olpIdentity,
  );

  // Audit ctx capture for success path (audit fires on res.on('finish');
  // status_code + latency_ms populated then).
  auditCtx.provider = providerUsed;
  auditCtx.fallback_hops = fallbackHops;
  auditCtx.tried_providers = (Array.isArray(fallbackDetail) ? fallbackDetail.map(t => t?.provider).filter(Boolean) : []).concat([providerUsed]);
  auditCtx.cache_status = cacheStatus;

  if (ir.stream) {
    // Streaming response path: burst replay from buffered chunks.
    // Reaches here only when: bypassCacheForFirstHop=true OR preCheckHit=true OR chain.length>1.
    // (Single-hop cache-miss streaming is handled by the real-streaming path above.)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...headers,
    });

    for (const irChunk of chunks) {
      res.write(irChunkToOpenAISSE(irChunk, requestId, ir.model));
      if (irChunk.type === 'stop') break;
    }
    res.write(SSE_DONE);
    res.end();
  } else {
    // Non-streaming response path
    const responseObj = irResponseToOpenAINonStream(chunks, requestId, ir.model);
    sendJSON(res, 200, responseObj, headers);
  }
}

// ── Phase 3 / D50 — Management endpoints (owner_only_block per ADR 0008 §8) ──

// Read dashboard.html once at startup; cached in memory thereafter. If the
// file is absent (e.g. test that imports server.mjs from a non-repo cwd), we
// still serve a minimal in-memory fallback. The file lives at the repo root.
let _dashboardHtmlCache = null;
function _loadDashboardHtml() {
  if (_dashboardHtmlCache !== null) return _dashboardHtmlCache;
  try {
    const path = join(__dirname, 'dashboard.html');
    _dashboardHtmlCache = readFileSync(path, 'utf-8');
  } catch {
    _dashboardHtmlCache = '<!DOCTYPE html><title>OLP Dashboard</title><p>dashboard.html not on disk; server has fallen back to this in-memory stub. Check the OLP installation.</p>';
  }
  return _dashboardHtmlCache;
}

/**
 * Gated owner-only_block handler factory per ADR 0008 §8 + §7.5. Builds the
 * audit ctx, runs auth, blocks non-owner with 401, wires res.on('finish') for
 * audit + touchLastUsed, then calls inner(req, res, olpIdentity, auditCtx).
 *
 * inner should be async (or sync); errors propagate to the router's catch.
 */
async function _runOwnerOnlyManagementEndpoint(req, res, method, path, inner) {
  const startMs = Date.now();
  const auditCtx = {
    ts: new Date().toISOString(),
    key_id: ANONYMOUS_KEY_ID,
    owner_tier: 'anonymous',
    method,
    path,
    provider: null,
    model: null,
    status_code: 0,
    latency_ms: 0,
    cache_status: null,
    fallback_hops: 0,
    tried_providers: [],
    error_code: null,
    ir_request_hash: null,
    chain_id: null,
  };
  let _authedKeyId = null;
  res.on('finish', () => {
    auditCtx.status_code = res.statusCode;
    auditCtx.latency_ms = Date.now() - startMs;
    try { appendAuditEvent(auditCtx); } catch { /* best-effort */ }
    if (_authedKeyId && _authedKeyId !== ANONYMOUS_KEY_ID && _authedKeyId !== ENV_OWNER_KEY_ID) {
      touchLastUsed(_authedKeyId).catch(() => {});
    }
  });

  // Step 1: authenticate.
  const authResult = authenticate(req);
  if (!authResult.ok) {
    auditCtx.error_code = authResult.code;
    return sendError(res, authResult.status, authResult.message, authResult.code,
      olpErrorHeaders({ startMs }));
  }
  const olpIdentity = authResult.authContext;
  auditCtx.key_id = olpIdentity.keyId;
  auditCtx.owner_tier = olpIdentity.owner_tier;
  _authedKeyId = olpIdentity.keyId;

  // Step 2: owner-only_block. ADR 0008 §8 says management endpoints REJECT
  // non-owner identities outright (vs /health's trim model). Anonymous +
  // guest both produce 401 here.
  if (olpIdentity.owner_tier !== 'owner') {
    auditCtx.error_code = 'owner_required';
    return sendError(res, 401,
      'OLP owner-tier identity required for this management endpoint.',
      'owner_required',
      olpErrorHeaders({ startMs }));
  }

  // Step 3: delegate.
  return await inner(req, res, olpIdentity, auditCtx);
}

/**
 * GET /dashboard
 * Serves dashboard.html to owner identities. Owner-only_block (per ADR 0008 §8).
 * Cached in memory at startup; D51 ships the real multi-panel UI; D50 ships a
 * placeholder.
 */
async function handleDashboard(req, res) {
  return _runOwnerOnlyManagementEndpoint(req, res, 'GET', '/dashboard',
    async (_req, res2, _identity, _auditCtx) => {
      const html = _loadDashboardHtml();
      res2.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html, 'utf-8'),
        'Cache-Control': 'no-cache',
      });
      res2.end(html);
    });
}

/**
 * GET /v0/management/dashboard-data
 * Full JSON aggregate per ADR 0008 § 7.2. The dashboard 30s poll consumes
 * this. Owner-only_block.
 */
async function handleManagementDashboardData(req, res) {
  return _runOwnerOnlyManagementEndpoint(req, res, 'GET', '/v0/management/dashboard-data',
    async (_req, res2, _identity, _auditCtx) => {
      // Quota panel: collect quotaStatus from each loaded provider; null on
      // throw or null return → "unavailable" indicator.
      const quota = [];
      for (const [name, provider] of loadedProviders) {
        try {
          const q = await provider.quotaStatus(null);
          quota.push({ provider: name, ...(q ?? {}), available: q?.available ?? null });
        } catch (err) {
          quota.push({ provider: name, error: err?.message ?? String(err), available: null });
        }
      }

      const WINDOW_24H = 24 * 60 * 60 * 1000;
      const payload = {
        generated_at: new Date().toISOString(),
        window_24h: auditAggregateRequests({ windowMs: WINDOW_24H, logEvent }),
        cache_hit_24h: auditCacheHitRateWindow({ windowMs: WINDOW_24H, logEvent }),
        quota,
        spend_trend_30d: auditSpendTrendDaily({ days: 30, logEvent }),
        top_fallback_chains_24h: auditTopFallbackChains({ windowMs: WINDOW_24H, limit: 10, logEvent }),
        cache_stats: cacheStore.stats(),
      };
      sendJSON(res2, 200, payload);
    });
}

/**
 * GET /v0/management/quota
 * Per-provider quota snapshot only (subset of dashboard-data). Useful for
 * scripted monitoring. Owner-only_block.
 */
async function handleManagementQuota(req, res) {
  return _runOwnerOnlyManagementEndpoint(req, res, 'GET', '/v0/management/quota',
    async (_req, res2, _identity, _auditCtx) => {
      const quota = [];
      for (const [name, provider] of loadedProviders) {
        try {
          const q = await provider.quotaStatus(null);
          quota.push({ provider: name, ...(q ?? {}), available: q?.available ?? null });
        } catch (err) {
          quota.push({ provider: name, error: err?.message ?? String(err), available: null });
        }
      }
      sendJSON(res2, 200, { generated_at: new Date().toISOString(), quota });
    });
}

/**
 * GET /cache/stats
 * Live in-memory CacheStore stats. Owner-only_block.
 * Per ADR 0008 § 7.4: returns the current cacheStore.stats() shape
 * ({ hits, misses, size, inflightCount }). Per-(provider, model) breakdown
 * is a Phase 4+ amendment trigger.
 */
async function handleCacheStats(req, res) {
  return _runOwnerOnlyManagementEndpoint(req, res, 'GET', '/cache/stats',
    async (_req, res2, _identity, _auditCtx) => {
      sendJSON(res2, 200, { generated_at: new Date().toISOString(), ...cacheStore.stats() });
    });
}

// ── Request router ────────────────────────────────────────────────────────

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function router(req, res) {
  const { method, url } = req;

  // Strip query string for routing
  const path = url?.split('?')[0] ?? '/';

  try {
    if (method === 'GET' && path === '/health') {
      return await handleHealth(req, res);
    }

    if (method === 'GET' && path === '/v1/models') {
      return handleModels(req, res);
    }

    if (method === 'POST' && path === '/v1/chat/completions') {
      return await handleChatCompletions(req, res);
    }

    // Phase 3 / D50 — management endpoints (owner-only_block per ADR 0008 § 8)
    if (method === 'GET' && path === '/dashboard') {
      return await handleDashboard(req, res);
    }
    if (method === 'GET' && path === '/v0/management/dashboard-data') {
      return await handleManagementDashboardData(req, res);
    }
    if (method === 'GET' && path === '/v0/management/quota') {
      return await handleManagementQuota(req, res);
    }
    if (method === 'GET' && path === '/cache/stats') {
      return await handleCacheStats(req, res);
    }

    // 404 for any unrecognised route
    sendError(res, 404, `Route ${method} ${path} not found`, 'not_found');
  } catch (e) {
    logEvent('error', 'unhandled_request_error', { method, path, error: e?.message });
    if (!res.headersSent) {
      sendError(res, 500, 'Internal server error', 'internal_error');
    }
  }
}

// ── Server factory + main guard ───────────────────────────────────────────
//
// Factory pattern: `createOlpServer()` returns an http.Server bound to the
// shared router but NOT yet listening. Tests import this factory and call
// .listen() on their own port. The main guard below only runs .listen()
// when this file is invoked directly via `node server.mjs` — preventing
// import-time side effects when tests pull in server.mjs.

export function createOlpServer() {
  return createServer(router);
}

export { router, loadedProviders, VERSION };

// Main guard: only listen when invoked as the entrypoint. ESM equivalent of
// `require.main === module` is comparing import.meta.url against argv[1].
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  const server = createOlpServer();
  server.listen(PORT, '127.0.0.1', () => {
    const enabledCount = loadedProviders.size;
    process.stdout.write(
      `OLP v${VERSION} listening on :${PORT} (${enabledCount} providers enabled — Phase 1 in progress)\n`,
    );
  });
}

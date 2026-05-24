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
 *   OLP_PORT  — listen port (default: 3456)
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

// ── Config ────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
const VERSION = pkg.version;

const PORT = parseInt(process.env.OLP_PORT ?? '3456', 10);
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

// ── Route handlers ────────────────────────────────────────────────────────

/**
 * GET /health
 * Returns server health including count of loaded providers and per-provider
 * healthCheck() snapshots (ADR 0002 § Provider contract: healthCheck is used
 * by startup and /health endpoint per ADR 0002 § Provider contract description).
 */
async function handleHealth(req, res) {
  const enabled = loadedProviders.size;
  const available = listAllProviderNames().length;
  const providerStatuses = {};
  for (const [name, provider] of loadedProviders) {
    try {
      providerStatuses[name] = await provider.healthCheck();
    } catch (e) {
      providerStatuses[name] = { ok: false, error: e.message };
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

  // Require JSON content-type
  const ct = req.headers['content-type'] ?? '';
  if (!ct.includes('application/json')) {
    return sendError(res, 415, 'Content-Type must be application/json', 'invalid_request_error',
      olpErrorHeaders({ startMs }));
  }

  let body;
  try {
    body = await readJSON(req);
  } catch (e) {
    return sendError(res, e.statusCode ?? 400, e.message, 'invalid_request_error',
      olpErrorHeaders({ startMs }));
  }

  // Translate OpenAI → IR (ADR 0003)
  let ir;
  try {
    ir = openAIToIR(body);
  } catch (e) {
    if (e instanceof BadRequestError) {
      return sendError(res, 400, e.message, 'invalid_request_error',
        olpErrorHeaders({ startMs }));
    }
    throw e;
  }

  // Auth context is null at D5/D9 — providers fall back to their own credential
  // discovery (env var, keychain, credentials file). Phase 2 multi-key
  // infrastructure will pass a real authContext carrying the per-key OLP token.
  const authContext = null;

  // ── Fallback engine: build chain (ADR 0004) ─────────────────────────────
  // buildDefaultChain returns null if no enabled provider serves this model.
  // Per ADR 0004 § D9: at v0.1, chain is single-hop (no fallback) unless the
  // user has populated ~/.olp/config.json routing.chains.
  const chain = buildDefaultChain(
    ir.model,
    loadedProviders,
    _fallbackConfig.chains,
    _fallbackConfig.soft_triggers,
  );

  if (!chain) {
    // ALIGNMENT.md: 0 Enabled Providers at v0.1 → 503 per spec
    return sendError(
      res, 503,
      `No enabled providers for model ${ir.model}. See README § Supported Providers.`,
      'no_enabled_provider',
      olpErrorHeaders({ startMs, model: ir.model }),
    );
  }

  const requestId = generateRequestId();

  // ── Cache layer (ADR 0005) ──────────────────────────────────────────────
  // keyId: '__anonymous__' at D5/D9. Phase 2 multi-key infrastructure wires the
  // real OLP API key ID here for D1 per-key isolation.
  const keyId = '__anonymous__';

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
      // ADR 0005 § "Cache write conditions" item 1: truncated responses must not
      // persist in cache. Overwrite with ttlMs=0 so any subsequent get/peek
      // finds the entry already-expired and deletes it.
      await cacheStore.set(keyId, hopCacheKey, result, 0);
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
  // On success: write chunks to res AND cache so subsequent identical requests
  // hit the burst-replay path.
  // D38 (issue #1): pre-acquire a concurrency slot for the streaming path so
  // saturation here behaves identically to saturation on the buffered path.
  // If acquire fails, fall through (skip this branch) — the buffered path
  // below also gates via tryAcquireSpawn and will surface a chain-exhausted
  // error through executeWithFallback (correct behaviour: a single-hop chain
  // at maxConcurrent has no other hop to advance to).
  //
  // Acquired here, released in the `finally` below. The gate intentionally
  // lives BEFORE the streaming-branch entry check so the buffered fallthrough
  // can re-attempt acquire from a clean slate.
  let streamingAcquired = false;
  if (ir.stream && chain.length === 1 && !bypassCacheForFirstHop && !preCheckHit && cacheableForFirstHop) {
    const candidatePlugin = loadedProviders.get(chain[0].provider);
    const candidateMax = candidatePlugin?.hints?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_SPAWNS;
    streamingAcquired = candidatePlugin ? tryAcquireSpawn(chain[0].provider, candidateMax) : false;
  }

  if (ir.stream && chain.length === 1 && !bypassCacheForFirstHop && !preCheckHit && cacheableForFirstHop && streamingAcquired) {
    const streamProvider = chain[0].provider;
    const streamModel = chain[0].model;
    const streamCacheKey = computeCacheKey(streamProvider, streamModel, ir);
    const streamPlugin = loadedProviders.get(streamProvider);

    if (!streamPlugin) {
      // Provider disappeared between chain build and here (edge case).
      // Release the slot we acquired above so the counter stays balanced.
      releaseSpawn(streamProvider);
      return sendError(res, 503, `Provider ${streamProvider} is not enabled`, 'no_enabled_provider',
        olpErrorHeaders({ startMs, model: ir.model }));
    }

    const streamHeaders = olpHeaders({
      providerUsed: streamProvider,
      modelUsed: streamModel,
      startMs,
      cacheStatus: 'miss',
      fallbackHops: 0,
    });

    // D14: writeHead is deferred until just before the first res.write so that
    // pre-first-chunk errors can still produce a JSON 502 (matching the buffered
    // path). Calling writeHead unconditionally here was the D14 defect.

    const streamedChunks = [];
    let firstChunkEmitted = false;
    try {
      for await (const irChunk of streamPlugin.spawn(ir, authContext)) {
        if (irChunk.type === 'error') {
          // Error chunk from provider
          if (firstChunkEmitted) {
            // Past first-chunk boundary — can't fallback; emit truncation marker + [DONE]
            // so clients can detect the incomplete response in-band (aligns D26 F19
            // stop-less exhaustion behaviour and the catch-block fix in D35 #10).
            logEvent('warn', 'streaming_error_after_first_chunk', {
              provider: streamProvider,
              model: streamModel,
              error: irChunk.error,
            });
            res.write(irChunkToOpenAISSE({ type: 'stop', finish_reason: 'length' }, requestId, ir.model));
            res.write(SSE_DONE);
            res.end();
            return;
          }
          // No bytes written yet — throw to surface a clean error.
          throw new ProviderError(irChunk.error ?? 'Provider emitted error chunk', 'SPAWN_FAILED');
        }

        // Defer writeHead until the moment we are about to emit the first byte.
        // After this point firstChunkEmitted===true ↔ res.headersSent===true.
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
          // Cache the buffered chunks for burst-replay on subsequent identical requests.
          // D23 defense-in-depth: cacheableForFirstHop is true here (cacheable: false
          // falls through to the buffered path, never enters this block), but the guard
          // makes the intent explicit and survives future refactors.
          if (cacheableForFirstHop) {
            await cacheStore.set(keyId, streamCacheKey, streamedChunks);
            logEvent('info', 'streaming_response_cached', {
              provider: streamProvider,
              model: streamModel,
              chunks: streamedChunks.length,
            });
          }
          return;
        }
      }

      // Generator exhausted without a stop chunk — emit [DONE] but do NOT cache.
      // A stop-less exhaustion means the response is truncated (the generator
      // ended without the model signalling completion). Caching a truncated
      // response would serve wrong answers to future identical requests.
      // Compare: D16's buffered-path truncation eviction explicitly avoids
      // persisting truncated entries for the same reason.
      //
      // D26 round-3 F19: emit a synthetic truncation marker BEFORE [DONE] so
      // clients can detect the incomplete response in-band. Only emit when there
      // is actual partial content (streamedChunks.length > 0) — emitting a
      // truncation marker on an empty response is misleading.
      // The buffered D16 path synthesizes {type:'stop', finish_reason:'length'}
      // before returning; this aligns the streaming branch with that behaviour.
      if (streamedChunks.length > 0) {
        const truncMarker = { type: 'stop', finish_reason: 'length' };
        res.write(irChunkToOpenAISSE(truncMarker, requestId, ir.model));
      }

      // D35 #9: Zero-chunk empty-stream path — writeHead is still deferred
      // (firstChunkEmitted===false) when the generator yields no chunks at all and
      // exits cleanly. Without an explicit writeHead Node auto-emits 200 with the
      // default Content-Type and none of the X-OLP-* headers.
      // A provider that yielded nothing still constitutes an attempted call, so we
      // emit the full olpHeaders (provider WAS attempted, just yielded zero chunks).
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
      // Loop exhausted without stop chunk = truncation. The stop-chunk completion
      // path returns earlier (above, inside the for-await loop); reaching here means
      // the generator returned without emitting stop. Never cache (per ADR 0005 cache
      // write conditions item 1: truncated responses must not persist in cache).
      if (streamedChunks.length > 0 && cacheableForFirstHop) {
        logEvent('warn', 'streaming_no_stop_chunk', {
          chunks_count: streamedChunks.length,
          provider: streamProvider,
          model: streamModel,
        });
      }
    } catch (e) {
      if (firstChunkEmitted) {
        // Past first-chunk boundary — can't fallback; emit truncation marker + [DONE]
        // so clients can detect the incomplete response in-band (aligns with D26 F19
        // stop-less exhaustion behaviour). ADR 0004 § Fallback safety: no fallback
        // after first-chunk boundary; truncation is the correct recovery.
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
        if (!res.headersSent) {
          sendError(res, 502, e.message ?? 'Provider error', 'provider_error',
            olpHeaders({ providerUsed: streamProvider, modelUsed: streamModel, startMs, cacheStatus: 'miss', fallbackHops: 0 }));
        } else {
          res.end();
        }
      }
    } finally {
      // D38 (issue #1): streaming spawn lifecycle ended — drain completed,
      // stop chunk seen, generator exhausted without stop, or any catch
      // path returned via res.end(). Release the slot acquired before
      // entering the streaming branch. The finally fires on every JS exit
      // path including the `return;` statements inside the try/catch body.
      releaseSpawn(streamProvider);
    }
    return;
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

    // Send error with standard OLP headers + optional exhausted header
    const payload = JSON.stringify({
      error: {
        message: originalError?.message ?? 'Provider error',
        type: 'provider_error',
      },
    });
    res.writeHead(errStatus, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      ...errorOlpHeaders,
      ...exhaustedHeader,
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
  const headers = olpHeaders({ providerUsed, modelUsed, startMs, cacheStatus, fallbackHops });

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

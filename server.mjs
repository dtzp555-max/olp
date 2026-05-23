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
import { loadProviders, getProviderForModel, listAllProviderNames } from './lib/providers/index.mjs';
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

// ── Provider registry ─────────────────────────────────────────────────────
// ALIGNMENT.md § Provider Inventory: 0 Enabled Providers at v0.1.
// Empty config → empty loaded map → all POST /v1/chat/completions → 503.
const loadedProviders = loadProviders({ enabled: {} });

// ── Fallback config ───────────────────────────────────────────────────────
// Read ~/.olp/config.json routing.chains at startup. Empty at v0.1.
// Per ADR 0004 § D9: fallback engine is wired; activates when user populates chains.
// Tests may inject a synthetic fallbackConfig via __setFallbackConfig().
let _fallbackConfig = loadFallbackConfigSync();

/** @internal — test seam: inject a synthetic fallback config (no file I/O) */
export function __setFallbackConfig(config) {
  _fallbackConfig = config ?? { chains: {}, soft_triggers: {} };
}

/** @internal — reset to file-based config */
export function __resetFallbackConfig() {
  _fallbackConfig = loadFallbackConfigSync();
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

// ── Logging ───────────────────────────────────────────────────────────────

function logEvent(level, event, data = {}) {
  const entry = { ts: new Date().toISOString(), level, event, ...data };
  if (level === 'error' || level === 'warn') {
    process.stderr.write(JSON.stringify(entry) + '\n');
  } else {
    process.stdout.write(JSON.stringify(entry) + '\n');
  }
}

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
 */
function sendError(res, status, message, type) {
  sendJSON(res, status, { error: { message, type } });
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

// ── Route handlers ────────────────────────────────────────────────────────

/**
 * GET /health
 * Returns server health including count of loaded providers.
 */
function handleHealth(req, res) {
  const enabled = loadedProviders.size;
  const available = listAllProviderNames().length;
  sendJSON(res, 200, {
    ok: true,
    version: VERSION,
    providers: { enabled, available },
  });
}

/**
 * GET /v1/models
 * Returns an empty data array at D3.
 * Will be populated from models-registry.json + loaded providers in Phase 1 Day 2.
 */
function handleModels(req, res) {
  sendJSON(res, 200, { object: 'list', data: [] });
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
    return sendError(res, 415, 'Content-Type must be application/json', 'invalid_request_error');
  }

  let body;
  try {
    body = await readJSON(req);
  } catch (e) {
    return sendError(res, e.statusCode ?? 400, e.message, 'invalid_request_error');
  }

  // Translate OpenAI → IR (ADR 0003)
  let ir;
  try {
    ir = openAIToIR(body);
  } catch (e) {
    if (e instanceof BadRequestError) {
      return sendError(res, 400, e.message, 'invalid_request_error');
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
    );
  }

  const requestId = generateRequestId();

  // ── Cache layer (ADR 0005) ──────────────────────────────────────────────
  // keyId: '__anonymous__' at D5/D9. Phase 2 multi-key infrastructure wires the
  // real OLP API key ID here for D1 per-key isolation.
  const keyId = '__anonymous__';

  // D2 bypass: if the request contains Anthropic cache_control markers,
  // skip OLP's response cache (prompt cache lives at Anthropic's side per ADR 0005 § D2).
  const bypassCache = hasCacheControl(ir) || extractCacheControlMarkers(body?.messages ?? []).length > 0;

  if (bypassCache) {
    logEvent('debug', 'cache_bypass', { model: ir.model, reason: 'cache_control_markers' });
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
    async function collectAllChunks() {
      const chunks = [];
      for await (const irChunk of hopProviderPlugin.spawn(irReq, authContext)) {
        chunks.push(irChunk);
        if (irChunk.type === 'error') {
          throw new ProviderError(
            irChunk.error ?? 'Provider emitted error chunk',
            'SPAWN_FAILED',
          );
        }
        if (irChunk.type === 'stop') break;
      }
      return chunks;
    }

    if (bypassCache) {
      return collectAllChunks();
    }

    // D4 singleflight + D1 per-key isolation per ADR 0005.
    // Each hop has its own (provider, model) key — cross-provider contamination
    // is structurally impossible (ADR 0005 § Per-model isolation).
    return cacheStore.getOrCompute(keyId, hopCacheKey, collectAllChunks);
  }

  // ── Execute with fallback (ADR 0004) ────────────────────────────────────
  // Pre-check for cache status reporting uses first hop's key (primary provider).
  const firstHopCacheKey = computeCacheKey(chain[0].provider, chain[0].model, ir);
  const preCheckHit = bypassCache ? false : await cacheStore.peek(keyId, firstHopCacheKey);

  let fallbackResult;
  try {
    fallbackResult = await executeWithFallback(chain, ir, executeHopFn, {
      logEvent,
    });
  } catch (e) {
    // executeWithFallback throws only on programming errors (empty chain).
    logEvent('error', 'fallback_engine_error', { error: e.message });
    return sendError(res, 500, 'Internal server error', 'internal_error');
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

    // Send error with exhausted header
    const payload = JSON.stringify({
      error: {
        message: originalError?.message ?? 'Provider error',
        type: 'provider_error',
      },
    });
    res.writeHead(errStatus, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      ...exhaustedHeader,
    });
    res.end(payload);
    return;
  }

  // ── Success: emit response ─────────────────────────────────────────────
  // Per ADR 0004 § Observability headers: X-OLP-Fallback-Hops reflects the
  // chain index of the serving hop; 0 = primary served, 1 = first fallback, etc.
  const cacheStatus = bypassCache ? 'bypass' : (preCheckHit && fallbackHops === 0 ? 'hit' : 'miss');
  const headers = olpHeaders({ providerUsed, modelUsed, startMs, cacheStatus, fallbackHops });

  if (ir.stream) {
    // Streaming response path (D3 simplified: burst replay, no timing fidelity)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...headers,
    });

    for (const irChunk of chunks) {
      res.write(irChunkToOpenAISSE(irChunk, requestId, ir.model));
      if (irChunk.type === 'stop' || irChunk.type === 'error') break;
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
      return handleHealth(req, res);
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

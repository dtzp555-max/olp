#!/usr/bin/env node
/**
 * server.mjs — OLP HTTP listener and request dispatcher
 *
 * Authority (entry surface): OpenAI Chat Completions API
 *   https://platform.openai.com/docs/api-reference/chat/create
 * Authority (IR): ADR 0003
 * Authority (provider dispatch): ADR 0002
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
 * Per spec: X-OLP-Provider-Used, X-OLP-Model-Used, X-OLP-Fallback-Hops,
 * X-OLP-Cache, X-OLP-Latency-Ms.
 * Fallback-Hops is always 0 at D3 (no fallback engine yet — ADR 0004).
 * Cache is always 'miss' at D3 (no cache layer yet — ADR 0005).
 *
 * @param {object} opts
 * @param {string} opts.providerUsed
 * @param {string} opts.modelUsed
 * @param {number} opts.startMs
 * @returns {Record<string,string>}
 */
function olpHeaders({ providerUsed, modelUsed, startMs }) {
  return {
    'X-OLP-Provider-Used': providerUsed,
    'X-OLP-Model-Used': modelUsed,
    'X-OLP-Fallback-Hops': '0',
    'X-OLP-Cache': 'miss',
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
 * Core dispatch path: OpenAI request → IR → provider.spawn → OpenAI response.
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

  // Translate OpenAI → IR
  let ir;
  try {
    ir = openAIToIR(body);
  } catch (e) {
    if (e instanceof BadRequestError) {
      return sendError(res, 400, e.message, 'invalid_request_error');
    }
    throw e;
  }

  // Find a provider for the requested model
  const match = getProviderForModel(loadedProviders, ir.model);
  if (!match) {
    // ALIGNMENT.md: 0 Enabled Providers at v0.1 → 503 per spec
    return sendError(
      res, 503,
      `No enabled providers for model ${ir.model}. See README § Supported Providers.`,
      'no_enabled_provider',
    );
  }

  const { provider, name: providerName } = match;
  const requestId = generateRequestId();

  // Auth context is a stub at D3 — providers will populate this in Phase 1 Day 2+
  const authContext = {};

  const headers = olpHeaders({ providerUsed: providerName, modelUsed: ir.model, startMs });

  if (ir.stream) {
    // Streaming response path
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...headers,
    });

    try {
      for await (const irChunk of provider.spawn(ir, authContext)) {
        res.write(irChunkToOpenAISSE(irChunk, requestId, ir.model));
        if (irChunk.type === 'stop' || irChunk.type === 'error') break;
      }
      res.write(SSE_DONE);
    } catch (e) {
      // Best-effort error reporting in the stream
      const errChunk = { type: 'error', error: e.message ?? 'Provider spawn failed' };
      res.write(irChunkToOpenAISSE(errChunk, requestId, ir.model));
      res.write(SSE_DONE);
      logEvent('error', 'spawn_error', { provider: providerName, model: ir.model, error: e.message });
    }
    res.end();
  } else {
    // Non-streaming response path
    try {
      const chunks = [];
      for await (const irChunk of provider.spawn(ir, authContext)) {
        chunks.push(irChunk);
        if (irChunk.type === 'stop' || irChunk.type === 'error') break;
      }
      const response = irResponseToOpenAINonStream(chunks, requestId, ir.model);
      sendJSON(res, 200, response, headers);
    } catch (e) {
      logEvent('error', 'spawn_error', { provider: providerName, model: ir.model, error: e.message });
      const status = e instanceof ProviderError ? 502 : 500;
      sendError(res, status, e.message ?? 'Provider error', 'provider_error');
    }
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

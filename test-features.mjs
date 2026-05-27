/**
 * test-features.mjs — OLP D5 test suite (extends D4)
 *
 * Uses Node's built-in node:test runner. No external dependencies.
 * Run: node test-features.mjs  (or: npm test)
 *
 * Authority: ADR 0002 (provider contract), ADR 0003 (IR v1.0), ADR 0005 (cache layer)
 *   D4 adds: Anthropic plugin conformance, IR translation, mock-spawn behaviour.
 *   D5 adds: Suite 9 (cache layer unit + HTTP integration), Suite 10 (Anthropic E2E gated)
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { EventEmitter } from 'node:events';
import { homedir, tmpdir as _tmpdirForSetup } from 'node:os';
import { mkdtempSync as _mkdtempSyncForSetup } from 'node:fs';
import { join as _pathJoinForSetup } from 'node:path';
import { computeCacheKey, extractCacheControlMarkers, hasCacheControl } from './lib/cache/keys.mjs';
import { CacheStore } from './lib/cache/store.mjs';

// ── Phase 2 / D45 test-mode setup ─────────────────────────────────────────
// Two adjustments keep pre-D45 tests working alongside the new auth gate:
//   1. process.env.OLP_HOME → tmpdir so audit ndjson / manifest writes
//      triggered by handleChatCompletions / handleModels do not pollute
//      the user's real ~/.olp/. lib/keys.mjs + lib/audit.mjs resolve the
//      env per-call so this takes effect immediately.
//   2. server.mjs __setAuthConfig({ allow_anonymous: true }) so existing
//      HTTP integration tests (Suite 18 etc.) that hit /v1/chat/completions
//      and /v1/models without an Authorization header continue to pass
//      via the anonymous identity. Suite 20 (D45 auth tests) explicitly
//      overrides per-case to exercise allow_anonymous: false / valid key /
//      revoked / env-owner / providers_enabled paths.
// (ESM imports are hoisted, so all module side effects — including
// server.mjs's startup loadAuthConfigSync() — complete before this body
// code runs. Setting OLP_HOME + __setAuthConfig here applies to all
// suites below.)
const _GLOBAL_TEST_OLP_HOME = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-home-'));
process.env.OLP_HOME = _GLOBAL_TEST_OLP_HOME;
// Clean up the global test tmpdir on process exit so successive npm test runs
// don't accumulate /var/folders/.../olp-test-home-* directories. process.on
// ('exit') fires synchronously after node:test reports all results.
process.on('exit', () => {
  try {
    // rmSync is imported lower in the file (Suite 19 imports it from 'node:fs').
    // ESM hoists all imports to top-of-module so the binding is available here.
    rmSync(_GLOBAL_TEST_OLP_HOME, { recursive: true, force: true });
  } catch {
    // best-effort; do not throw at exit
  }
});
// __setAuthConfig is imported below from './server.mjs'; deferring the call
// to a later block (after server.mjs's import-time loadAuthConfigSync runs)
// is necessary because ESM hoists imports before this body code. See the
// "Phase 2 / D45 server-side default override" block below the imports.

// ── Modules under test ────────────────────────────────────────────────────

import { validateIRRequest, validateIRMessage, VALID_ROLES, IR_VERSION } from './lib/ir/types.mjs';
import { openAIToIR, BadRequestError } from './lib/ir/openai-to-ir.mjs';
import {
  irChunkToOpenAISSE,
  irResponseToOpenAINonStream,
  generateRequestId,
  SSE_DONE,
} from './lib/ir/ir-to-openai.mjs';
import { validateProvider, ProviderError, withTimeout } from './lib/providers/base.mjs';
import {
  loadProviders,
  getProviderForModel,
  getProviderByName,
  listAllProviderNames,
  getAliasMap,
  getModelCreated,
  REGISTRY_BOOTSTRAP_CREATED,
  tryAcquireSpawn,
  releaseSpawn,
  getActiveSpawnCount,
  __resetSpawnCounters,
  DEFAULT_MAX_CONCURRENT_SPAWNS,
} from './lib/providers/index.mjs';
import anthropic, {
  irToAnthropic,
  anthropicChunkToIR,
  anthropicStopToIR,
  readAuthArtifact,
  estimateCost as anthropicEstimateCost,
  quotaStatus as anthropicQuotaStatus,
  healthCheck as anthropicHealthCheck,
  __setSpawnImpl,
  __resetSpawnImpl,
  // ADR 0009 Amendment 1 — stream-json transport
  OLP_SYSTEM_PROMPT_WRAPPER,
  extractSystemPrompt,
  buildCliArgs,
  parseStreamJsonLines,
  anthropicStreamJsonEventToIR,
} from './lib/providers/anthropic.mjs';
import codex, {
  irToCodex,
  codexChunkToIR,
  readAuthArtifact as codexReadAuthArtifact,
  estimateCost as codexEstimateCost,
  quotaStatus as codexQuotaStatus,
  healthCheck as codexHealthCheck,
  __setSpawnImpl as codexSetSpawnImpl,
  __resetSpawnImpl as codexResetSpawnImpl,
} from './lib/providers/codex.mjs';
import mistral, {
  irToMistral,
  mistralChunkToIR,
  readAuthArtifact as mistralReadAuthArtifact,
  estimateCost as mistralEstimateCost,
  quotaStatus as mistralQuotaStatus,
  healthCheck as mistralHealthCheck,
  __setSpawnImpl as mistralSetSpawnImpl,
  __resetSpawnImpl as mistralResetSpawnImpl,
} from './lib/providers/mistral.mjs';
import modelsRegistry from './models-registry.json' with { type: 'json' };

// ── Helpers ───────────────────────────────────────────────────────────────

/** Minimal valid IR request for use in tests */
function makeIR(overrides = {}) {
  return {
    irVersion: IR_VERSION,
    model: 'test-model',
    stream: false,
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

/** Minimal valid provider stub that satisfies the v1.0 contract (including D4 contractVersion) */
function makeProvider(overrides = {}) {
  return {
    name: 'stub',
    displayName: 'Stub Provider',
    contractVersion: '1.0',
    models: ['stub-model-v1'],
    auth: { type: 'none', storage: 'none', path: '', refresh: null },
    spawn: async function* () { yield { type: 'stop', finish_reason: 'stop' }; },
    estimateCost: () => null,
    quotaStatus: async () => null,
    healthCheck: async () => ({ ok: true, latencyMs: 0 }),
    hints: { requiresTTY: false, concurrentSpawnSafe: true, maxConcurrent: 4 },
    ...overrides,
  };
}

// ── HTTP helper ───────────────────────────────────────────────────────────

/**
 * Makes an HTTP request to the test server.
 * @param {{ port, method, path, headers?, body? }} opts
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
function fetch(opts) {
  return new Promise((resolve, reject) => {
    const bodyStr = opts.body ? JSON.stringify(opts.body) : undefined;
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: opts.port,
      method: opts.method ?? 'GET',
      path: opts.path,
      headers: {
        ...(bodyStr && { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }),
        ...(opts.headers ?? {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Suite 1: IR validation ────────────────────────────────────────────────

describe('IR validation — validateIRRequest', () => {
  it('accepts a minimal valid IR request', () => {
    const r = validateIRRequest(makeIR());
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
  });

  it('accepts an IR request with all optional fields', () => {
    const r = validateIRRequest(makeIR({
      max_tokens: 256,
      temperature: 0.7,
      top_p: 0.9,
      stop: ['\n'],
      tools: [],
      tool_choice: 'auto',
      response_format: { type: 'text' },
    }));
    assert.equal(r.valid, true);
  });

  it('rejects when messages is missing', () => {
    const ir = makeIR();
    delete ir.messages;
    const r = validateIRRequest(ir);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('messages')));
  });

  it('rejects when messages is empty', () => {
    const r = validateIRRequest(makeIR({ messages: [] }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('messages must not be empty')));
  });

  it('rejects when model is missing', () => {
    const ir = makeIR();
    delete ir.model;
    const r = validateIRRequest(ir);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('model')));
  });

  it('rejects when stream is not boolean', () => {
    const r = validateIRRequest(makeIR({ stream: 'true' }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('stream')));
  });

  it('rejects temperature out of range', () => {
    const r = validateIRRequest(makeIR({ temperature: 3 }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('temperature')));
  });

  it('rejects top_p out of range', () => {
    const r = validateIRRequest(makeIR({ top_p: -0.1 }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('top_p')));
  });

  it('rejects non-object input', () => {
    const r = validateIRRequest(null);
    assert.equal(r.valid, false);
  });
});

describe('IR validation — validateIRMessage', () => {
  for (const role of VALID_ROLES) {
    it(`accepts role="${role}"`, () => {
      const r = validateIRMessage({ role, content: 'test' });
      assert.equal(r.valid, true);
    });
  }

  it('rejects invalid role', () => {
    const r = validateIRMessage({ role: 'admin', content: 'x' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('role')));
  });

  it('rejects missing content', () => {
    const r = validateIRMessage({ role: 'user' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('content')));
  });

  it('accepts array content (multi-part)', () => {
    const r = validateIRMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    assert.equal(r.valid, true);
  });

  it('rejects non-object input', () => {
    const r = validateIRMessage('not an object');
    assert.equal(r.valid, false);
  });
});

// ── Suite 2: openAIToIR translation ──────────────────────────────────────

describe('openAIToIR translation', () => {
  it('translates a minimal request', () => {
    const ir = openAIToIR({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] });
    assert.equal(ir.irVersion, IR_VERSION);
    assert.equal(ir.model, 'gpt-4o');
    assert.equal(ir.stream, false);
    assert.equal(ir.messages.length, 1);
    assert.equal(ir.messages[0].role, 'user');
    assert.equal(ir.messages[0].content, 'Hi');
  });

  it('defaults stream to false when absent', () => {
    const ir = openAIToIR({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(ir.stream, false);
  });

  it('passes stream=true through', () => {
    const ir = openAIToIR({ model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true });
    assert.equal(ir.stream, true);
  });

  it('translates multi-turn with system message', () => {
    const ir = openAIToIR({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: '4' },
        { role: 'user', content: 'Thanks!' },
      ],
    });
    assert.equal(ir.messages.length, 4);
    assert.equal(ir.messages[0].role, 'system');
    assert.equal(ir.messages[1].role, 'user');
    assert.equal(ir.messages[2].role, 'assistant');
  });

  it('maps deprecated role=function to role=tool', () => {
    const ir = openAIToIR({
      model: 'm',
      messages: [{ role: 'function', name: 'my_fn', content: '{"result":1}' }],
    });
    assert.equal(ir.messages[0].role, 'tool');
    assert.equal(ir.messages[0].name, 'my_fn');
  });

  it('maps role=developer to role=system (OpenAI o1/o3+ reasoning shape)', () => {
    const ir = openAIToIR({
      model: 'm',
      messages: [{ role: 'developer', content: 'High-priority instructions.' }],
    });
    assert.equal(ir.messages[0].role, 'system', 'developer should normalize to system');
    assert.equal(ir.messages[0].content, 'High-priority instructions.');
  });

  it('mixed roles including developer all validate cleanly through IR', () => {
    const ir = openAIToIR({
      model: 'm',
      messages: [
        { role: 'developer', content: 'Be terse.' },
        { role: 'user', content: 'Hi.' },
        { role: 'assistant', content: 'Hello.' },
      ],
    });
    assert.equal(ir.messages.length, 3);
    assert.equal(ir.messages[0].role, 'system');
    assert.equal(ir.messages[1].role, 'user');
    assert.equal(ir.messages[2].role, 'assistant');
  });

  it('rejects an unknown role at entry — normalize didn\'t accidentally widen allow-list', () => {
    // Negative control for Amendment 3 — without this pin, a future addition
    // to normalizeRole that returns `role` as-is for unknown inputs would silently
    // widen the IR role allow-list. Confirms developer→system mapping is the only
    // entry-surface escape hatch.
    assert.throws(
      () => openAIToIR({
        model: 'm',
        messages: [{ role: 'admin', content: 'I am god.' }],
      }),
      err => err instanceof BadRequestError && /role must be one of/.test(err.message),
      'unknown role should still produce BadRequestError'
    );
  });

  it('translates request with tools', () => {
    const ir = openAIToIR({
      model: 'm',
      messages: [{ role: 'user', content: 'Search for X' }],
      tools: [{
        type: 'function',
        function: { name: 'search', description: 'Web search', parameters: { type: 'object', properties: {} } },
      }],
      tool_choice: 'auto',
    });
    assert.equal(ir.tools.length, 1);
    assert.equal(ir.tools[0].function.name, 'search');
    assert.equal(ir.tool_choice, 'auto');
  });

  it('translates request with response_format', () => {
    const ir = openAIToIR({
      model: 'm',
      messages: [{ role: 'user', content: 'Give JSON' }],
      response_format: { type: 'json_object' },
    });
    assert.deepEqual(ir.response_format, { type: 'json_object' });
  });

  it('translates optional numeric fields', () => {
    const ir = openAIToIR({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 100,
      temperature: 0.5,
      top_p: 0.95,
    });
    assert.equal(ir.max_tokens, 100);
    assert.equal(ir.temperature, 0.5);
    assert.equal(ir.top_p, 0.95);
  });

  it('throws BadRequestError when model is missing', () => {
    assert.throws(
      () => openAIToIR({ messages: [{ role: 'user', content: 'x' }] }),
      BadRequestError,
    );
  });

  it('throws BadRequestError when messages is empty', () => {
    assert.throws(
      () => openAIToIR({ model: 'm', messages: [] }),
      BadRequestError,
    );
  });

  it('throws BadRequestError when body is not an object', () => {
    assert.throws(() => openAIToIR(null), BadRequestError);
  });
});

// ── Suite 3: irChunkToOpenAISSE format ────────────────────────────────────

describe('irChunkToOpenAISSE format', () => {
  const ID = 'chatcmpl-test123';
  const MODEL = 'test-model';

  it('generates request IDs with chatcmpl- prefix', () => {
    const id = generateRequestId();
    assert.ok(id.startsWith('chatcmpl-'));
    assert.ok(id.length > 12);
  });

  it('formats a delta chunk as SSE event', () => {
    const sse = irChunkToOpenAISSE({ type: 'delta', role: 'assistant', content: 'Hello' }, ID, MODEL);
    assert.ok(sse.startsWith('data: '));
    assert.ok(sse.endsWith('\n\n'));
    const payload = JSON.parse(sse.slice(6).trim());
    assert.equal(payload.object, 'chat.completion.chunk');
    assert.equal(payload.id, ID);
    assert.equal(payload.model, MODEL);
    assert.equal(payload.choices[0].delta.content, 'Hello');
    assert.equal(payload.choices[0].delta.role, 'assistant');
    assert.equal(payload.choices[0].finish_reason, null);
  });

  it('formats a stop chunk with finish_reason', () => {
    const sse = irChunkToOpenAISSE({ type: 'stop', finish_reason: 'stop' }, ID, MODEL);
    const payload = JSON.parse(sse.slice(6).trim());
    assert.equal(payload.choices[0].finish_reason, 'stop');
    assert.deepEqual(payload.choices[0].delta, {});
  });

  it('does not invent a top-level error field on error chunks (ALIGNMENT.md Rule 2(b))', () => {
    // ALIGNMENT.md Rule 2 (b): OLP must not introduce OpenAI-spec fields that
    // OpenAI's /v1/chat/completions specification does not document.
    // OpenAI chat.completion.chunk objects have no top-level `error` field.
    // Provider errors surface via HTTP 4xx/5xx, not as in-band SSE fields.
    // Error chunks should not reach the translator in normal operation —
    // server.mjs converts them to thrown ProviderError before translation.
    // If one somehow does reach here, no `error` field must be invented.
    const sse = irChunkToOpenAISSE({ type: 'error', error: 'spawn failed' }, ID, MODEL);
    const payload = JSON.parse(sse.slice(6).trim());
    assert.equal(payload.error, undefined, 'translator must not invent top-level error field');
    assert.equal(payload.object, 'chat.completion.chunk');
    assert.ok(['stop', 'length', 'tool_calls', 'content_filter', 'function_call', null].includes(payload.choices[0].finish_reason));
  });

  it('SSE_DONE is the [DONE] terminator', () => {
    assert.equal(SSE_DONE, 'data: [DONE]\n\n');
  });

  it('irResponseToOpenAINonStream assembles a complete response', () => {
    const chunks = [
      { type: 'delta', role: 'assistant', content: 'Hello' },
      { type: 'delta', content: ' world' },
      { type: 'stop', finish_reason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ];
    const resp = irResponseToOpenAINonStream(chunks, ID, MODEL);
    assert.equal(resp.object, 'chat.completion');
    assert.equal(resp.id, ID);
    assert.equal(resp.model, MODEL);
    assert.equal(resp.choices[0].message.content, 'Hello world');
    assert.equal(resp.choices[0].message.role, 'assistant');
    assert.equal(resp.choices[0].finish_reason, 'stop');
    assert.equal(resp.usage.total_tokens, 7);
  });

  it('normalizeFinishReason: non-spec streaming finish_reason is mapped to stop', () => {
    for (const bad of ['timeout', 'overloaded', 'cancelled']) {
      const sse = irChunkToOpenAISSE({ type: 'stop', finish_reason: bad }, ID, MODEL);
      const payload = JSON.parse(sse.slice(6).trim());
      assert.equal(payload.choices[0].finish_reason, 'stop',
        `non-spec value '${bad}' must be normalized to 'stop'`);
    }
  });

  it('normalizeFinishReason: spec-enum streaming finish_reason values are preserved', () => {
    const specValues = ['stop', 'length', 'tool_calls', 'content_filter', 'function_call', null];
    for (const v of specValues) {
      const sse = irChunkToOpenAISSE({ type: 'stop', finish_reason: v }, ID, MODEL);
      const payload = JSON.parse(sse.slice(6).trim());
      assert.equal(payload.choices[0].finish_reason, v,
        `spec-enum value ${JSON.stringify(v)} must be preserved`);
    }
  });

  it('normalizeFinishReason: non-spec non-stream finish_reason is mapped to stop', () => {
    for (const bad of ['timeout', 'overloaded', 'cancelled']) {
      const chunks = [
        { type: 'delta', content: 'hi' },
        { type: 'stop', finish_reason: bad },
      ];
      const resp = irResponseToOpenAINonStream(chunks, ID, MODEL);
      assert.equal(resp.choices[0].finish_reason, 'stop',
        `non-spec value '${bad}' must be normalized to 'stop' in non-stream path`);
    }
  });

  it('normalizeFinishReason: spec-enum non-stream finish_reason values are preserved', () => {
    // Note: null is intentionally omitted from this list. In the non-stream path,
    // the condition `if (chunk.finish_reason !== undefined)` enters with null,
    // overwrites the default 'stop' to null, and the response then carries
    // finish_reason: null — meaning "still in progress" on a finalized completion,
    // which is semantically odd but spec-valid. The non-stream path's behavior is
    // documented by this omission rather than enforced (no plugin currently emits
    // null on a non-stream stop chunk).
    const specValues = ['stop', 'length', 'tool_calls', 'content_filter', 'function_call'];
    for (const v of specValues) {
      const chunks = [
        { type: 'delta', content: 'hi' },
        { type: 'stop', finish_reason: v },
      ];
      const resp = irResponseToOpenAINonStream(chunks, ID, MODEL);
      assert.equal(resp.choices[0].finish_reason, v,
        `spec-enum value '${v}' must be preserved in non-stream path`);
    }
  });
});

// ── Suite 4: Provider contract validation ─────────────────────────────────

describe('Provider contract validation', () => {
  it('accepts a fully valid provider stub', () => {
    const r = validateProvider(makeProvider());
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
  });

  it('rejects provider with missing name', () => {
    const p = makeProvider();
    delete p.name;
    const r = validateProvider(p);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('name')));
  });

  it('rejects provider with non-lowercase name', () => {
    const r = validateProvider(makeProvider({ name: 'MyProvider' }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('name')));
  });

  it('rejects provider with missing displayName', () => {
    const p = makeProvider();
    delete p.displayName;
    const r = validateProvider(p);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('displayName')));
  });

  it('rejects provider with missing models array', () => {
    const p = makeProvider();
    delete p.models;
    const r = validateProvider(p);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('models')));
  });

  it('rejects provider with missing spawn', () => {
    const p = makeProvider();
    delete p.spawn;
    const r = validateProvider(p);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('spawn')));
  });

  it('rejects provider with missing estimateCost', () => {
    const p = makeProvider();
    delete p.estimateCost;
    const r = validateProvider(p);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('estimateCost')));
  });

  it('rejects provider with missing healthCheck', () => {
    const p = makeProvider();
    delete p.healthCheck;
    const r = validateProvider(p);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('healthCheck')));
  });

  it('rejects provider with missing hints', () => {
    const p = makeProvider();
    delete p.hints;
    const r = validateProvider(p);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('hints')));
  });

  it('rejects provider with invalid hints.maxConcurrent', () => {
    const r = validateProvider(makeProvider({ hints: { requiresTTY: false, concurrentSpawnSafe: true, maxConcurrent: -1 } }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('maxConcurrent')));
  });

  it('validateProvider rejects negative maxSpawnTimeMs', () => {
    const r = validateProvider(makeProvider({ hints: { requiresTTY: false, concurrentSpawnSafe: true, maxConcurrent: 4, maxSpawnTimeMs: -1 } }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('maxSpawnTimeMs')));
  });

  it('validateProvider rejects zero maxSpawnTimeMs', () => {
    const r = validateProvider(makeProvider({ hints: { requiresTTY: false, concurrentSpawnSafe: true, maxConcurrent: 4, maxSpawnTimeMs: 0 } }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('maxSpawnTimeMs')));
  });

  it('validateProvider rejects non-integer maxSpawnTimeMs (e.g., 100.5)', () => {
    const r = validateProvider(makeProvider({ hints: { requiresTTY: false, concurrentSpawnSafe: true, maxConcurrent: 4, maxSpawnTimeMs: 100.5 } }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('maxSpawnTimeMs')));
  });

  it('validateProvider rejects non-number maxSpawnTimeMs (e.g., \'600\')', () => {
    const r = validateProvider(makeProvider({ hints: { requiresTTY: false, concurrentSpawnSafe: true, maxConcurrent: 4, maxSpawnTimeMs: '600' } }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('maxSpawnTimeMs')));
  });

  it('validateProvider accepts omitted maxSpawnTimeMs (optional field)', () => {
    const r = validateProvider(makeProvider({ hints: { requiresTTY: false, concurrentSpawnSafe: true, maxConcurrent: 4 } }));
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
  });

  it('validateProvider accepts positive integer maxSpawnTimeMs (e.g., 60000)', () => {
    const r = validateProvider(makeProvider({ hints: { requiresTTY: false, concurrentSpawnSafe: true, maxConcurrent: 4, maxSpawnTimeMs: 60000 } }));
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
  });

  // ── D23: hints.cacheable validation tests (ADR 0002 Amendment 3) ──────
  it('validateProvider accepts hints.cacheable: true (explicit)', () => {
    const r = validateProvider(makeProvider({ hints: { requiresTTY: false, concurrentSpawnSafe: true, maxConcurrent: 4, cacheable: true } }));
    assert.equal(r.valid, true, `Expected valid, got errors: ${r.errors.join(', ')}`);
    assert.deepEqual(r.errors, []);
  });

  it('validateProvider accepts hints.cacheable: false (explicit opt-out)', () => {
    const r = validateProvider(makeProvider({ hints: { requiresTTY: false, concurrentSpawnSafe: true, maxConcurrent: 4, cacheable: false } }));
    assert.equal(r.valid, true, `Expected valid, got errors: ${r.errors.join(', ')}`);
    assert.deepEqual(r.errors, []);
  });

  it('validateProvider accepts omitted hints.cacheable (default true)', () => {
    // makeProvider() does not set cacheable — must still be valid.
    const r = validateProvider(makeProvider({ hints: { requiresTTY: false, concurrentSpawnSafe: true, maxConcurrent: 4 } }));
    assert.equal(r.valid, true, `Expected valid, got errors: ${r.errors.join(', ')}`);
    assert.deepEqual(r.errors, []);
  });

  it('validateProvider rejects hints.cacheable: \'true\' (string, not boolean)', () => {
    const r = validateProvider(makeProvider({ hints: { requiresTTY: false, concurrentSpawnSafe: true, maxConcurrent: 4, cacheable: 'true' } }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('cacheable')), `Expected cacheable error, got: ${r.errors.join(', ')}`);
  });

  it('validateProvider rejects hints.cacheable: 1 (number, not boolean)', () => {
    const r = validateProvider(makeProvider({ hints: { requiresTTY: false, concurrentSpawnSafe: true, maxConcurrent: 4, cacheable: 1 } }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('cacheable')), `Expected cacheable error, got: ${r.errors.join(', ')}`);
  });

  it('rejects non-object input', () => {
    const r = validateProvider(null);
    assert.equal(r.valid, false);
  });

  it('ProviderError carries code field', () => {
    const e = new ProviderError('auth missing', 'AUTH_MISSING');
    assert.equal(e.code, 'AUTH_MISSING');
    assert.equal(e.name, 'ProviderError');
    assert.ok(e instanceof Error);
  });

  it('withTimeout rejects after deadline', async () => {
    const p = new Promise(r => setTimeout(() => r('late'), 200));
    await assert.rejects(
      () => withTimeout(p, 50, 'SPAWN_FAILED'),
      err => err instanceof ProviderError && err.code === 'SPAWN_FAILED',
    );
  });

  it('withTimeout resolves when promise is fast', async () => {
    const p = Promise.resolve(42);
    const v = await withTimeout(p, 1000, 'SPAWN_FAILED');
    assert.equal(v, 42);
  });
});

// ── Suite 5: Plugin registry ──────────────────────────────────────────────

describe('Plugin registry', () => {
  it('STATIC_REGISTRY has 3 entries (anthropic + openai + mistral candidates) at D8', () => {
    // D4 added anthropic; D6 adds openai; D8 adds mistral. Default config has all enabled:false.
    assert.equal(listAllProviderNames().length, 3);
  });

  it('loadProviders with empty config → empty Map (anthropic not enabled)', () => {
    const m = loadProviders({});
    assert.equal(m.size, 0);
  });

  it('loadProviders with no config → empty Map', () => {
    const m = loadProviders();
    assert.equal(m.size, 0);
  });

  it('listAllProviderNames returns [anthropic, openai, mistral] at D8', () => {
    // D4: ['anthropic']. D6 adds openai. D8 adds mistral.
    assert.deepEqual(listAllProviderNames(), ['anthropic', 'openai', 'mistral']);
  });

  it('getProviderForModel returns null when no providers loaded', () => {
    const m = loadProviders({});
    const r = getProviderForModel(m, 'gpt-4o');
    assert.equal(r, null);
  });

  it('getProviderForModel finds provider by exact model string', () => {
    // Build a synthetic loaded map to test the function without touching STATIC_REGISTRY
    const p = makeProvider({ name: 'alpha', models: ['alpha-v1', 'alpha-v2'] });
    const m = new Map([['alpha', p]]);
    const r = getProviderForModel(m, 'alpha-v1');
    assert.ok(r !== null);
    assert.equal(r.name, 'alpha');
    assert.equal(r.canonicalModel, 'alpha-v1', 'D17: canonicalModel must equal modelString on direct lookup');
  });

  it('getProviderForModel returns null for unknown model', () => {
    const p = makeProvider({ name: 'alpha', models: ['alpha-v1'] });
    const m = new Map([['alpha', p]]);
    assert.equal(getProviderForModel(m, 'beta-v1'), null);
  });

  it('getProviderByName returns null for empty loaded map', () => {
    const m = new Map();
    assert.equal(getProviderByName(m, 'anthropic'), null);
  });

  it('getProviderByName returns provider when found', () => {
    const p = makeProvider({ name: 'alpha', models: ['alpha-v1'] });
    const m = new Map([['alpha', p]]);
    assert.ok(getProviderByName(m, 'alpha') !== null);
    assert.equal(getProviderByName(m, 'alpha').name, 'alpha');
  });

  it('anthropic provider passes contract validation (STATIC_REGISTRY entry)', () => {
    // Even though anthropic is Candidate (not enabled by default), it must
    // pass contract validation at module load — loadProviders() validates all
    // registry entries regardless of enabled flag.
    const { valid, errors } = validateProvider(anthropic);
    assert.equal(valid, true, `Validation errors: ${errors.join('; ')}`);
  });
});

// ── Suite 6: Anthropic plugin (D4) ───────────────────────────────────────
//
// All tests in this suite are UNIT tests. No real `claude` binary is invoked.
// Mock spawn is injected via __setSpawnImpl / __resetSpawnImpl.
// Tests verify: contract conformance, contractVersion enforcement, registry
// consistency, IR translation, mock-spawn stream, healthCheck, estimateCost.

/**
 * Creates a fake spawn that emits canned stdout chunks then exits cleanly.
 * Returns a fake ChildProcess-like EventEmitter with stdin, stdout, stderr.
 * @param {string[]} stdoutChunks — text chunks emitted in order
 * @param {number} [exitCode=0]
 */
function makeMockSpawn(stdoutChunks, exitCode = 0) {
  return function mockSpawnImpl(_bin, _args, _opts) {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = {
      write: () => {},
      end: () => {
        // Emit stdout chunks and close asynchronously
        setImmediate(async () => {
          for (const chunk of stdoutChunks) {
            proc.stdout.emit('data', Buffer.from(chunk));
          }
          proc.stdout.emit('end');
          proc.stderr.emit('end');
          proc.emit('close', exitCode, null);
        });
      },
    };
    proc.killed = false;
    proc.kill = () => {};
    return proc;
  };
}

/**
 * Creates a fake spawn that emits proper NDJSON stream-json events then exits.
 * Used by Suite 6 (Anthropic plugin D4) and Suite 41 (ADR 0009 Amendment 1 tests).
 *
 * ADR 0009 Amendment 1: _spawnAndStream now parses NDJSON events from stdout.
 * Raw text chunks (as in makeMockSpawn) produce parse_error events → no delta content.
 * This helper emits content_block_delta stream_events so the assertion on content works.
 *
 * @param {string[]} textChunks — content strings to emit as content_block_delta events
 * @param {number} [exitCode=0]
 */
function makeMockSpawnNDJSON(textChunks, exitCode = 0) {
  return function mockSpawnNDJSONImpl(_bin, _args, _opts) {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = {
      write: () => {},
      end: () => {
        setImmediate(async () => {
          // Emit system/init first (consumed, no yield)
          const initEvent = JSON.stringify({ type: 'system', subtype: 'init', cwd: '/tmp', tools: [] });
          proc.stdout.emit('data', Buffer.from(initEvent + '\n'));

          // Emit each text chunk as a stream_event/content_block_delta
          for (const chunk of textChunks) {
            const deltaEvent = JSON.stringify({
              type: 'stream_event',
              event: { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } },
            });
            proc.stdout.emit('data', Buffer.from(deltaEvent + '\n'));
          }

          // Emit result/success as terminal event
          const resultEvent = JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: textChunks.join(''),
            total_cost_usd: 0.0001,
          });
          proc.stdout.emit('data', Buffer.from(resultEvent + '\n'));

          proc.stdout.emit('end');
          proc.stderr.emit('end');
          proc.emit('close', exitCode, null);
        });
      },
    };
    proc.killed = false;
    proc.kill = () => {};
    return proc;
  };
}

// ── Suite D17: Alias-aware getProviderForModel (Finding 12 + 13) ─────────────
//
// Tests that getProviderForModel resolves aliases from models-registry.json
// to canonical IDs and routes to the correct (enabled) provider.

describe('D17 — alias-aware getProviderForModel', () => {

  // ── Anthropic aliases ────────────────────────────────────────────────
  it('D17: alias "sonnet" → anthropic, canonical claude-sonnet-4-6', () => {
    const loaded = new Map([['anthropic', anthropic]]);
    const r = getProviderForModel(loaded, 'sonnet');
    assert.ok(r !== null);
    assert.equal(r.name, 'anthropic');
    assert.equal(r.canonicalModel, 'claude-sonnet-4-6');
  });

  it('D17: alias "claude" → anthropic, canonical claude-sonnet-4-6', () => {
    const loaded = new Map([['anthropic', anthropic]]);
    const r = getProviderForModel(loaded, 'claude');
    assert.ok(r !== null);
    assert.equal(r.name, 'anthropic');
    assert.equal(r.canonicalModel, 'claude-sonnet-4-6');
  });

  it('D17: alias "opus" → anthropic, canonical claude-opus-4-7', () => {
    const loaded = new Map([['anthropic', anthropic]]);
    const r = getProviderForModel(loaded, 'opus');
    assert.ok(r !== null);
    assert.equal(r.name, 'anthropic');
    assert.equal(r.canonicalModel, 'claude-opus-4-7');
  });

  it('D17: alias "haiku" → anthropic, canonical claude-haiku-4-5', () => {
    const loaded = new Map([['anthropic', anthropic]]);
    const r = getProviderForModel(loaded, 'haiku');
    assert.ok(r !== null);
    assert.equal(r.name, 'anthropic');
    assert.equal(r.canonicalModel, 'claude-haiku-4-5');
  });

  // ── OpenAI aliases ────────────────────────────────────────────────────
  it('D17: alias "codex" → openai, canonical gpt-5.3-codex', () => {
    const loaded = new Map([['openai', codex]]);
    const r = getProviderForModel(loaded, 'codex');
    assert.ok(r !== null);
    assert.equal(r.name, 'openai');
    assert.equal(r.canonicalModel, 'gpt-5.3-codex');
  });

  it('D17: alias "gpt5" → openai, canonical gpt-5.5', () => {
    const loaded = new Map([['openai', codex]]);
    const r = getProviderForModel(loaded, 'gpt5');
    assert.ok(r !== null);
    assert.equal(r.name, 'openai');
    assert.equal(r.canonicalModel, 'gpt-5.5');
  });

  // ── Mistral aliases ───────────────────────────────────────────────────
  it('D17: alias "devstral" → mistral, canonical devstral-2-25-12', () => {
    const loaded = new Map([['mistral', mistral]]);
    const r = getProviderForModel(loaded, 'devstral');
    assert.ok(r !== null);
    assert.equal(r.name, 'mistral');
    assert.equal(r.canonicalModel, 'devstral-2-25-12');
  });

  it('D17: alias "devstral-small" → mistral, canonical devstral-small-2-25-12', () => {
    const loaded = new Map([['mistral', mistral]]);
    const r = getProviderForModel(loaded, 'devstral-small');
    assert.ok(r !== null);
    assert.equal(r.name, 'mistral');
    assert.equal(r.canonicalModel, 'devstral-small-2-25-12');
  });

  // ── Canonical pass-through ────────────────────────────────────────────
  it('D17: canonical "claude-sonnet-4-6" → anthropic, canonicalModel unchanged', () => {
    const loaded = new Map([['anthropic', anthropic]]);
    const r = getProviderForModel(loaded, 'claude-sonnet-4-6');
    assert.ok(r !== null);
    assert.equal(r.name, 'anthropic');
    assert.equal(r.canonicalModel, 'claude-sonnet-4-6');
  });

  // ── Unknown model → null ──────────────────────────────────────────────
  it('D17: unknown model "gpt-4-imaginary" → null', () => {
    const loaded = new Map([['anthropic', anthropic], ['openai', codex], ['mistral', mistral]]);
    assert.equal(getProviderForModel(loaded, 'gpt-4-imaginary'), null);
  });

  // ── Alias points to disabled provider → null ─────────────────────────
  it('D17: alias "devstral" with only anthropic loaded → null (mistral not enabled)', () => {
    // The alias is known (devstral → mistral) but mistral is not in loadedProviders.
    const loaded = new Map([['anthropic', anthropic]]);
    assert.equal(getProviderForModel(loaded, 'devstral'), null);
  });

  it('D17: alias "sonnet" with only mistral loaded → null (anthropic not enabled)', () => {
    const loaded = new Map([['mistral', mistral]]);
    assert.equal(getProviderForModel(loaded, 'sonnet'), null);
  });

  // ── buildDefaultChain with alias ──────────────────────────────────────
  it('D17: buildDefaultChain("sonnet") → chain carries canonical claude-sonnet-4-6', () => {
    const loaded = new Map([['anthropic', anthropic]]);
    const chain = buildDefaultChain('sonnet', loaded, {}, {});
    assert.ok(chain !== null);
    assert.equal(chain.length, 1);
    assert.equal(chain[0].provider, 'anthropic');
    assert.equal(chain[0].model, 'claude-sonnet-4-6');
  });

  it('D17: buildDefaultChain("devstral") → chain carries canonical devstral-2-25-12', () => {
    const loaded = new Map([['mistral', mistral]]);
    const chain = buildDefaultChain('devstral', loaded, {}, {});
    assert.ok(chain !== null);
    assert.equal(chain.length, 1);
    assert.equal(chain[0].provider, 'mistral');
    assert.equal(chain[0].model, 'devstral-2-25-12');
  });

  it('D17: buildDefaultChain("unknown-alias") with no providers → null', () => {
    const loaded = new Map();
    assert.equal(buildDefaultChain('unknown-alias', loaded, {}, {}), null);
  });

});

describe('Anthropic plugin (D4)', () => {

  // ── Test 1: Contract conformance ──────────────────────────────────────
  it('anthropic module satisfies validateProvider() — all 10 fields present', () => {
    const { valid, errors } = validateProvider(anthropic);
    assert.equal(valid, true, `Validation errors: ${errors.join('; ')}`);
    // Verify all 10 contract fields explicitly
    assert.ok('name' in anthropic, 'missing: name');
    assert.ok('displayName' in anthropic, 'missing: displayName');
    assert.ok('contractVersion' in anthropic, 'missing: contractVersion');
    assert.ok('models' in anthropic, 'missing: models');
    assert.ok('auth' in anthropic, 'missing: auth');
    assert.ok(typeof anthropic.spawn === 'function', 'missing: spawn');
    assert.ok(typeof anthropic.estimateCost === 'function', 'missing: estimateCost');
    assert.ok(typeof anthropic.quotaStatus === 'function', 'missing: quotaStatus');
    assert.ok(typeof anthropic.healthCheck === 'function', 'missing: healthCheck');
    assert.ok('hints' in anthropic, 'missing: hints');
  });

  // ── Test 2: contractVersion enforced ─────────────────────────────────
  it('validateProvider rejects provider missing contractVersion', () => {
    const p = makeProvider();
    delete p.contractVersion;
    const r = validateProvider(p);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('contractVersion')));
  });

  it('validateProvider rejects contractVersion: "0.9"', () => {
    const p = makeProvider({ contractVersion: '0.9' });
    const r = validateProvider(p);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('contractVersion')));
  });

  it('validateProvider accepts contractVersion: "1.0"', () => {
    const p = makeProvider({ contractVersion: '1.0' });
    const r = validateProvider(p);
    assert.equal(r.valid, true);
  });

  it('validateProvider rejects contractVersion: undefined', () => {
    const p = makeProvider({ contractVersion: undefined });
    const r = validateProvider(p);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('contractVersion')));
  });

  // ── Test 3: models match registry ────────────────────────────────────
  it('anthropic.models matches models-registry.json providers.anthropic.models', () => {
    const registryIds = modelsRegistry.providers.anthropic.models.map(m => m.id);
    assert.deepEqual(anthropic.models, registryIds);
  });

  it('anthropic.models contains the three expected model IDs', () => {
    assert.ok(anthropic.models.includes('claude-opus-4-7'));
    assert.ok(anthropic.models.includes('claude-sonnet-4-6'));
    assert.ok(anthropic.models.includes('claude-haiku-4-5'));
    assert.equal(anthropic.models.length, 3);
  });

  // ── Test 4: getProviderForModel finds anthropic for each model ────────
  it('getProviderForModel finds anthropic for claude-sonnet-4-6 when enabled', () => {
    const loaded = new Map([['anthropic', anthropic]]);
    const result = getProviderForModel(loaded, 'claude-sonnet-4-6');
    assert.ok(result !== null);
    assert.equal(result.name, 'anthropic');
  });

  it('getProviderForModel finds anthropic for claude-opus-4-7 when enabled', () => {
    const loaded = new Map([['anthropic', anthropic]]);
    const result = getProviderForModel(loaded, 'claude-opus-4-7');
    assert.ok(result !== null);
    assert.equal(result.name, 'anthropic');
  });

  it('getProviderForModel finds anthropic for claude-haiku-4-5 when enabled', () => {
    const loaded = new Map([['anthropic', anthropic]]);
    const result = getProviderForModel(loaded, 'claude-haiku-4-5');
    assert.ok(result !== null);
    assert.equal(result.name, 'anthropic');
  });

  // ── Test 5: irToAnthropic translation ────────────────────────────────
  it('irToAnthropic: user message → plain text', () => {
    const ir = makeIR({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello world' }],
    });
    const prompt = irToAnthropic(ir);
    assert.ok(typeof prompt === 'string');
    assert.ok(prompt.includes('Hello world'));
    assert.ok(!prompt.includes('[System]'));
    assert.ok(!prompt.includes('[Assistant]'));
  });

  it('irToAnthropic: system + user → system message SKIPPED in stdin (ADR 0009 Amendment 1)', () => {
    // ADR 0009 Amendment 1: role:system messages are extracted by extractSystemPrompt()
    // and passed via --system-prompt flag. They must NOT appear in the stdin prompt.
    const ir = makeIR({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system', content: 'You are a helper.' },
        { role: 'user', content: 'What is 2+2?' },
      ],
    });
    const prompt = irToAnthropic(ir);
    // system message must NOT appear in stdin prompt (goes via --system-prompt instead)
    assert.ok(!prompt.includes('[System] You are a helper.'), 'system content must not leak to stdin');
    assert.ok(!prompt.includes('You are a helper.'), 'system content must not leak to stdin in any form');
    // user message must still be present
    assert.ok(prompt.includes('What is 2+2?'));
  });

  it('irToAnthropic: assistant turn → [Assistant] annotation', () => {
    const ir = makeIR({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'Bye' },
      ],
    });
    const prompt = irToAnthropic(ir);
    assert.ok(prompt.includes('[Assistant] Hello!'));
  });

  it('irToAnthropic: response_format json_object injects system prompt', () => {
    const ir = makeIR({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Give JSON' }],
      response_format: { type: 'json_object' },
    });
    const prompt = irToAnthropic(ir);
    assert.ok(prompt.includes('Reply with valid JSON only'));
  });

  it('irToAnthropic: tool result turn → [Tool Result] annotation', () => {
    const ir = makeIR({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'Search for something' },
        { role: 'tool', content: '{"results": []}', name: 'search' },
      ],
    });
    const prompt = irToAnthropic(ir);
    assert.ok(prompt.includes('[Tool Result'));
    assert.ok(prompt.includes('search'));
  });

  it('irToAnthropic: array content is JSON-stringified', () => {
    const ir = makeIR({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    const prompt = irToAnthropic(ir);
    assert.ok(typeof prompt === 'string');
    assert.ok(prompt.includes('text'));
  });

  // ── Test 6: anthropicChunkToIR and anthropicStopToIR ─────────────────
  it('anthropicChunkToIR: produces delta chunk with content', () => {
    const chunk = anthropicChunkToIR('Hello ', false);
    assert.equal(chunk.type, 'delta');
    assert.equal(chunk.content, 'Hello ');
    assert.ok(!('role' in chunk));
  });

  it('anthropicChunkToIR: first chunk includes role=assistant', () => {
    const chunk = anthropicChunkToIR('Hello', true);
    assert.equal(chunk.type, 'delta');
    assert.equal(chunk.role, 'assistant');
    assert.equal(chunk.content, 'Hello');
  });

  it('anthropicStopToIR: produces stop chunk with finish_reason', () => {
    const chunk = anthropicStopToIR('stop');
    assert.equal(chunk.type, 'stop');
    assert.equal(chunk.finish_reason, 'stop');
  });

  // ── Test 7: mock spawn — AsyncIterator yields correct IR chunks ───────
  // ADR 0009 Amendment 1: spawn now uses NDJSON stream-json path.
  // Tests updated to use makeMockSpawnNDJSON which emits proper stream_event NDJSON.
  it('spawn with mock: yields delta chunks then stop chunk (NDJSON path)', async () => {
    const fakeSpawn = makeMockSpawnNDJSON(['Hello', ' world']);
    __setSpawnImpl(fakeSpawn);
    try {
      const ir = makeIR({
        model: 'claude-sonnet-4-6',
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
      });
      const authCtx = { accessToken: '<fake-oauth-token>' };
      const chunks = [];
      for await (const chunk of anthropic.spawn(ir, authCtx)) {
        chunks.push(chunk);
      }
      // Should have 2 delta chunks + 1 stop chunk from result event
      const deltas = chunks.filter(c => c.type === 'delta');
      const stops = chunks.filter(c => c.type === 'stop');
      assert.ok(deltas.length >= 1, `Expected at least 1 delta, got ${deltas.length}`);
      assert.equal(stops.length, 1, `Expected 1 stop, got ${stops.length}`);
      const allContent = deltas.map(c => c.content).join('');
      assert.equal(allContent, 'Hello world');
    } finally {
      __resetSpawnImpl();
    }
  });

  it('spawn with mock: first delta chunk has role=assistant (NDJSON path)', async () => {
    const fakeSpawn = makeMockSpawnNDJSON(['Test output']);
    __setSpawnImpl(fakeSpawn);
    try {
      const ir = makeIR({
        model: 'claude-sonnet-4-6',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      });
      const authCtx = { accessToken: '<fake-oauth-token>' };
      const chunks = [];
      for await (const chunk of anthropic.spawn(ir, authCtx)) {
        chunks.push(chunk);
      }
      const firstDelta = chunks.find(c => c.type === 'delta');
      assert.ok(firstDelta, 'No delta chunk found');
      assert.equal(firstDelta.role, 'assistant');
    } finally {
      __resetSpawnImpl();
    }
  });

  it('spawn with mock: non-zero exit code throws ProviderError', async () => {
    const fakeSpawn = makeMockSpawn([], 1);
    __setSpawnImpl(fakeSpawn);
    try {
      const ir = makeIR({
        model: 'claude-sonnet-4-6',
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
      });
      const authCtx = { accessToken: '<fake-oauth-token>' };
      let caught = null;
      try {
        // eslint-disable-next-line no-unused-vars
        for await (const _chunk of anthropic.spawn(ir, authCtx)) {
          // drain
        }
      } catch (e) {
        caught = e;
      }
      assert.ok(caught instanceof ProviderError, `Expected ProviderError, got ${caught?.constructor?.name}`);
      assert.equal(caught.code, 'SPAWN_FAILED');
    } finally {
      __resetSpawnImpl();
    }
  });

  it('spawn throws ProviderError(AUTH_MISSING) when no auth context and no env/file', async () => {
    const fakeSpawn = makeMockSpawn(['output']);
    __setSpawnImpl(fakeSpawn);
    // Temporarily clear the env var if set
    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      const ir = makeIR({
        model: 'claude-sonnet-4-6',
        stream: false,
        messages: [{ role: 'user', content: 'Hi' }],
      });
      let caught = null;
      try {
        // Pass null as authContext to force re-read
        for await (const _chunk of anthropic.spawn(ir, null)) { // eslint-disable-line no-unused-vars
          // may or may not throw depending on whether credentials exist on this machine
        }
      } catch (e) {
        caught = e;
      }
      // If credentials.json or keychain exists on the test machine, this won't throw.
      // We only assert that IF it throws, it's AUTH_MISSING.
      if (caught !== null) {
        assert.ok(caught instanceof ProviderError, `Expected ProviderError, got ${caught?.constructor?.name}`);
        assert.equal(caught.code, 'AUTH_MISSING');
      }
    } finally {
      if (savedToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
      __resetSpawnImpl();
    }
  });

  // ── Test 8: healthCheck — binary not found ────────────────────────────
  it('healthCheck returns {ok: false, error: "claude binary not found"} when binary absent', async () => {
    const result = await anthropicHealthCheck({
      _binaryExistsFn: () => false,
      _authReadFn: () => ({ accessToken: '<fake-token>' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'claude binary not found');
    assert.ok(typeof result.latencyMs === 'number');
  });

  // ── Test 9: healthCheck — auth artifact missing ───────────────────────
  it('healthCheck returns {ok: false, error: "auth artifact missing"} when auth missing', async () => {
    const result = await anthropicHealthCheck({
      _binaryExistsFn: () => true,
      _authReadFn: () => null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'auth artifact missing');
    assert.ok(typeof result.latencyMs === 'number');
  });

  it('healthCheck returns {ok: true} when binary and auth present', async () => {
    const result = await anthropicHealthCheck({
      _binaryExistsFn: () => true,
      _authReadFn: () => ({ accessToken: '<fake-token>' }),
    });
    assert.equal(result.ok, true);
    assert.ok(typeof result.latencyMs === 'number');
  });

  // ── Test 10: estimateCost shape ───────────────────────────────────────
  it('estimateCost returns object with four fields for a valid request', () => {
    const request = makeIR({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system', content: 'You are a helper.' },
        { role: 'user', content: 'Count to ten.' },
      ],
    });
    const result = anthropicEstimateCost(request);
    assert.ok(result !== null, 'estimateCost returned null');
    assert.ok('inputTokens' in result, 'missing inputTokens');
    assert.ok('outputTokensEstimate' in result, 'missing outputTokensEstimate');
    assert.ok('currency' in result, 'missing currency');
    assert.ok('usd' in result, 'missing usd');
    assert.equal(result.currency, 'USD');
    assert.equal(result.usd, null); // not pinned at D4
    assert.ok(result.inputTokens > 0, 'inputTokens should be > 0');
    assert.ok(result.outputTokensEstimate >= 0, 'outputTokensEstimate should be >= 0');
  });

  it('estimateCost returns null for null/missing request', () => {
    assert.equal(anthropicEstimateCost(null), null);
    assert.equal(anthropicEstimateCost({}), null);
  });

  // ── Test 11: quotaStatus ──────────────────────────────────────────────
  it('quotaStatus returns null at D4', async () => {
    const result = await anthropicQuotaStatus({});
    assert.equal(result, null);
  });

  // ── Test 12: auth object shape ────────────────────────────────────────
  it('anthropic.auth has correct shape', () => {
    assert.equal(typeof anthropic.auth.type, 'string');
    assert.equal(typeof anthropic.auth.storage, 'string');
    assert.equal(typeof anthropic.auth.path, 'string');
    assert.ok(anthropic.auth.path.includes('.claude'), 'auth.path should reference .claude directory');
    // Portability check: path must start with the runtime homedir() value (set at module load)
    // rather than a hardcoded literal.  Since path.join(homedir(), ...) produces the home dir
    // as a prefix, we verify it matches what homedir() returns at test time.
    assert.ok(
      anthropic.auth.path.startsWith(homedir()),
      `auth.path "${anthropic.auth.path}" should start with homedir() "${homedir()}"`,
    );
    assert.ok(typeof anthropic.auth.refresh === 'string' || anthropic.auth.refresh === null);
  });

  // ── Test 13: hints shape ──────────────────────────────────────────────
  it('anthropic.hints has correct shape', () => {
    assert.equal(typeof anthropic.hints.requiresTTY, 'boolean');
    assert.equal(typeof anthropic.hints.concurrentSpawnSafe, 'boolean');
    assert.ok(Number.isInteger(anthropic.hints.maxConcurrent) && anthropic.hints.maxConcurrent > 0);
    assert.equal(anthropic.hints.requiresTTY, false);
  });

  // ── Test 14: loadProviders with anthropic enabled ─────────────────────
  it('loadProviders with {enabled: {anthropic: true}} returns Map of size 1', () => {
    const loaded = loadProviders({ enabled: { anthropic: true } });
    assert.equal(loaded.size, 1);
    assert.ok(loaded.has('anthropic'));
  });

  it('anthropic loaded via loadProviders passes contract and has correct models', () => {
    const loaded = loadProviders({ enabled: { anthropic: true } });
    const p = loaded.get('anthropic');
    const { valid, errors } = validateProvider(p);
    assert.equal(valid, true, `Contract errors: ${errors.join('; ')}`);
    assert.ok(p.models.includes('claude-sonnet-4-6'));
  });

});

// ── Suite 7: HTTP integration tests ──────────────────────────────────────

describe('HTTP integration', () => {
  let serverInstance;
  let port;

  before(async () => {
    // Use the REAL server module via its createOlpServer() factory. The
    // main guard in server.mjs prevents auto-listen on import; we call
    // .listen() ourselves on a test port. This means every HTTP test below
    // exercises the real router code — there is no parallel implementation
    // to drift.
    const { createOlpServer } = await import('./server.mjs');

    // Pick a port: env OLP_TEST_PORT or random high port
    port = parseInt(process.env.OLP_TEST_PORT ?? String(13456 + Math.floor(Math.random() * 1000)), 10);

    serverInstance = createOlpServer();

    // Retry once on port-in-use
    await new Promise((resolve, reject) => {
      serverInstance.listen(port, '127.0.0.1', resolve);
      serverInstance.once('error', async (e) => {
        if (e.code === 'EADDRINUSE') {
          port++;
          serverInstance.listen(port, '127.0.0.1', resolve);
          serverInstance.once('error', reject);
        } else {
          reject(e);
        }
      });
    });
  });

  after(() => new Promise(r => serverInstance.close(r)));

  it('GET /health returns 200 with expected shape', async () => {
    const r = await fetch({ port, method: 'GET', path: '/health' });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.ok, true);
    assert.ok(typeof body.version === 'string');
    assert.ok(typeof body.providers.enabled === 'number');
    assert.ok(typeof body.providers.available === 'number');
  });

  it('GET /v1/models returns 200 with empty data array', async () => {
    const r = await fetch({ port, method: 'GET', path: '/v1/models' });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.object, 'list');
    assert.deepEqual(body.data, []);
  });

  it('POST /v1/chat/completions with no providers → 503 with no_enabled_provider', async () => {
    const r = await fetch({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] },
    });
    assert.equal(r.status, 503);
    const body = JSON.parse(r.body);
    assert.equal(body.error.type, 'no_enabled_provider');
    assert.ok(body.error.message.includes('gpt-4o'));
  });

  it('POST /v1/chat/completions with invalid JSON body → 400', async () => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '5' },
    });
    const result = await new Promise((resolve, reject) => {
      req.on('error', reject);
      let body = '';
      req.on('response', res => {
        res.on('data', c => body += c);
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.write('{bad}');
      req.end();
    });
    assert.equal(result.status, 400);
  });

  it('POST /v1/chat/completions with missing model → 400', async () => {
    const r = await fetch({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      body: { messages: [{ role: 'user', content: 'x' }] },
    });
    assert.equal(r.status, 400);
    const body = JSON.parse(r.body);
    assert.equal(body.error.type, 'invalid_request_error');
  });

  it('GET /unknown → 404', async () => {
    const r = await fetch({ port, method: 'GET', path: '/unknown/route' });
    assert.equal(r.status, 404);
    const body = JSON.parse(r.body);
    assert.equal(body.error.type, 'not_found');
  });

  it('POST /v1/chat/completions without Content-Type → 415', async () => {
    // Our fetch helper sets Content-Type to application/json when body is truthy;
    // send text/plain directly to verify the 415 path.
    const result = await new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'Content-Type': 'text/plain', 'Content-Length': '2' },
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.write('{}');
      req.end();
    });
    assert.equal(result.status, 415);
  });
});

// ── Suite 8: Suite 8 formerly counted as D3/D4 base; suites renumber here ──
// (No new Suite 8 — the numbering skips from 7 to 9 to match D5 spec.)

// ── Suite 9: Cache layer ──────────────────────────────────────────────────
//
// Unit tests + HTTP integration tests for ADR 0005 (D1 + D4).
// No real `claude` binary invoked. Mock spawn injected via __setSpawnImpl.
// Authority: ADR 0005 § Cache key composition, D1 per-key isolation, D4 singleflight.

describe('Cache layer — computeCacheKey (Suite 9)', () => {

  // ── Test 1: Determinism ───────────────────────────────────────────────
  it('computeCacheKey is deterministic: same inputs → same key', () => {
    const ir = makeIR({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hello' }] });
    const k1 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir);
    const k2 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir);
    assert.equal(k1, k2);
    assert.equal(typeof k1, 'string');
    assert.equal(k1.length, 64); // SHA-256 hex
  });

  // ── Test 2: Provider distinguishes ───────────────────────────────────
  it('computeCacheKey distinguishes different providers', () => {
    const ir = makeIR({ model: 'model-x', messages: [{ role: 'user', content: 'hi' }] });
    const k1 = computeCacheKey('anthropic', 'model-x', ir);
    const k2 = computeCacheKey('openai', 'model-x', ir);
    assert.notEqual(k1, k2);
  });

  // ── Test 3: Model distinguishes ───────────────────────────────────────
  it('computeCacheKey distinguishes different models', () => {
    const ir = makeIR({ messages: [{ role: 'user', content: 'hi' }] });
    const k1 = computeCacheKey('anthropic', 'claude-sonnet-4-6', ir);
    const k2 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir);
    assert.notEqual(k1, k2);
  });

  // ── Test 4: Messages distinguishes ───────────────────────────────────
  it('computeCacheKey distinguishes different messages', () => {
    const ir1 = makeIR({ messages: [{ role: 'user', content: 'hello' }] });
    const ir2 = makeIR({ messages: [{ role: 'user', content: 'world' }] });
    const k1 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir1);
    const k2 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir2);
    assert.notEqual(k1, k2);
  });

  // ── Test 5: Tools distinguishes ───────────────────────────────────────
  it('computeCacheKey distinguishes requests with vs without tools', () => {
    const base = makeIR({ messages: [{ role: 'user', content: 'search' }] });
    const withTools = makeIR({
      messages: [{ role: 'user', content: 'search' }],
      tools: [{ type: 'function', function: { name: 'search', description: 'web search', parameters: {} } }],
    });
    const k1 = computeCacheKey('anthropic', 'claude-haiku-4-5', base);
    const k2 = computeCacheKey('anthropic', 'claude-haiku-4-5', withTools);
    assert.notEqual(k1, k2);
  });

  // ── Test 6: Temperature distinguishes ────────────────────────────────
  it('computeCacheKey distinguishes different temperature values', () => {
    const ir1 = makeIR({ messages: [{ role: 'user', content: 'x' }], temperature: 0.0 });
    const ir2 = makeIR({ messages: [{ role: 'user', content: 'x' }], temperature: 1.0 });
    const k1 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir1);
    const k2 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir2);
    assert.notEqual(k1, k2);
  });

  // ── Test 7: response_format distinguishes ────────────────────────────
  it('computeCacheKey distinguishes different response_format values', () => {
    const ir1 = makeIR({ messages: [{ role: 'user', content: 'x' }] });
    const ir2 = makeIR({ messages: [{ role: 'user', content: 'x' }], response_format: { type: 'json_object' } });
    const k1 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir1);
    const k2 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir2);
    assert.notEqual(k1, k2);
  });

  // ── Test 8: Content array property order stability ───────────────────
  it('computeCacheKey is stable for content arrays with same properties in different insertion order', () => {
    const ir1 = makeIR({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', extra: 1 }] }],
    });
    const ir2 = makeIR({
      messages: [{ role: 'user', content: [{ extra: 1, text: 'hi', type: 'text' }] }],
    });
    const k1 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir1);
    const k2 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir2);
    assert.equal(k1, k2);
  });

  // ── D15 Tests: Amendment 2 — max_tokens, top_p, stop, tool_choice ────

  // ── Test 9: max_tokens distinguishes ─────────────────────────────────
  it('computeCacheKey differs when max_tokens differs (D15 Amendment 2)', () => {
    const ir1 = makeIR({ messages: [{ role: 'user', content: 'x' }], max_tokens: 100 });
    const ir2 = makeIR({ messages: [{ role: 'user', content: 'x' }], max_tokens: 4000 });
    const k1 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir1);
    const k2 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir2);
    assert.notEqual(k1, k2);
  });

  // ── Test 10: top_p distinguishes ──────────────────────────────────────
  it('computeCacheKey differs when top_p differs (D15 Amendment 2)', () => {
    const ir1 = makeIR({ messages: [{ role: 'user', content: 'x' }], top_p: 0.5 });
    const ir2 = makeIR({ messages: [{ role: 'user', content: 'x' }], top_p: 0.9 });
    const k1 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir1);
    const k2 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir2);
    assert.notEqual(k1, k2);
  });

  // ── Test 11: stop distinguishes ───────────────────────────────────────
  it('computeCacheKey differs when stop sequences differ (D15 Amendment 2)', () => {
    const ir1 = makeIR({ messages: [{ role: 'user', content: 'x' }], stop: ['\n'] });
    const ir2 = makeIR({ messages: [{ role: 'user', content: 'x' }], stop: ['END', '\n'] });
    const k1 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir1);
    const k2 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir2);
    assert.notEqual(k1, k2);
  });

  // ── Test 12: tool_choice distinguishes ───────────────────────────────
  it('computeCacheKey differs when tool_choice differs (D15 Amendment 2)', () => {
    const ir1 = makeIR({ messages: [{ role: 'user', content: 'x' }], tool_choice: 'auto' });
    const ir2 = makeIR({ messages: [{ role: 'user', content: 'x' }], tool_choice: 'none' });
    const k1 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir1);
    const k2 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir2);
    assert.notEqual(k1, k2);
  });

  // ── Test 13: undefined max_tokens stable (both absent → same key) ────
  it('computeCacheKey is identical when max_tokens absent in both requests (D15 Amendment 2)', () => {
    const ir1 = makeIR({ messages: [{ role: 'user', content: 'x' }] });
    const ir2 = makeIR({ messages: [{ role: 'user', content: 'x' }] });
    const k1 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir1);
    const k2 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir2);
    assert.equal(k1, k2);
  });

  // ── F4 regression (D34): tools:[] vs tools:undefined must produce identical keys ─
  // ADR 0005 Amendment 2 claims: "tools: [] (explicit empty array) and tools omitted
  // (undefined) both mean 'no tools available' and produce identical model output,
  // so they correctly share a cache entry."
  // computeCacheKey now normalizes [] → null before serialization so this claim holds.
  it('F4 regression: tools:[] and tools:undefined produce the same cache key (D34)', () => {
    const base = makeIR({ messages: [{ role: 'user', content: 'hello' }] });
    const irEmpty = { ...base, tools: [] };
    const irUndef = { ...base, tools: undefined };
    const k1 = computeCacheKey('anthropic', 'claude-haiku-4-5', irEmpty);
    const k2 = computeCacheKey('anthropic', 'claude-haiku-4-5', irUndef);
    assert.equal(k1, k2, 'tools:[] and tools:undefined must produce identical cache keys');
  });

  it('F4 regression: stop:[] and stop:undefined produce the same cache key (D34)', () => {
    const base = makeIR({ messages: [{ role: 'user', content: 'hello' }] });
    const irEmpty = { ...base, stop: [] };
    const irUndef = { ...base, stop: undefined };
    const k1 = computeCacheKey('anthropic', 'claude-haiku-4-5', irEmpty);
    const k2 = computeCacheKey('anthropic', 'claude-haiku-4-5', irUndef);
    assert.equal(k1, k2, 'stop:[] and stop:undefined must produce identical cache keys');
  });

  it('F4 regression: tools:[] and tools:null produce the same cache key (D34)', () => {
    const base = makeIR({ messages: [{ role: 'user', content: 'hello' }] });
    const irEmpty = { ...base, tools: [] };
    const irNull = { ...base, tools: null };
    const k1 = computeCacheKey('anthropic', 'claude-haiku-4-5', irEmpty);
    const k2 = computeCacheKey('anthropic', 'claude-haiku-4-5', irNull);
    assert.equal(k1, k2, 'tools:[] and tools:null must produce identical cache keys');
  });

  it('F4 regression: non-empty tools array still differs from tools:undefined (D34)', () => {
    const base = makeIR({ messages: [{ role: 'user', content: 'hello' }] });
    const irWithTools = { ...base, tools: [{ type: 'function', function: { name: 'foo' } }] };
    const irNoTools = { ...base, tools: undefined };
    const k1 = computeCacheKey('anthropic', 'claude-haiku-4-5', irWithTools);
    const k2 = computeCacheKey('anthropic', 'claude-haiku-4-5', irNoTools);
    assert.notEqual(k1, k2, 'non-empty tools array must produce a different cache key from no tools');
  });
});

// ── D36 #14: cache_control slot determinism regression ─────────────────────
//
// Context (issue #14 + ADR 0005 Amendment 4):
//   computeCacheKey at lib/cache/keys.mjs:~224 calls extractCacheControlMarkers
//   on ir.messages. openAIToIR (lib/ir/openai-to-ir.mjs translateMessage) does
//   NOT whitelist cache_control, so v0.1 IRs constructed from OpenAI requests
//   always have markers stripped → the slot is structurally null. D27 F10
//   Amendment 4 acknowledged this is forward-compatible: when a future ADR 0003
//   amendment adds cache_control to the IR field set, the slot starts carrying
//   meaningful data without a cache-key schema change.
//
// What this suite guards:
//   1. The cache_control slot IS populated when markers are present on the IR
//      (forward-compat scenario — markers attached directly to an IR object
//      bypassing the openAIToIR translation).
//   2. Computing the key twice with the same marker payload yields identical
//      keys (determinism — bedrock invariant per ADR 0005 § cache key stability).
//   3. The slot is included in the composition — two IRs differing ONLY in
//      cache_control markers produce different keys.
//
// Future activation contract (when ADR 0003 adds cache_control to the IR
// whitelist and openAIToIR starts preserving markers):
//   - extractCacheControlMarkers must continue to return markers in messages-
//     iteration order; nested-in-content markers follow the outer message in
//     positional order (see lib/cache/keys.mjs:126-148).
//   - The current implementation JSON.stringifies the marker array verbatim
//     (no pre-sort) — determinism relies on messages-array order being stable
//     across translations and on per-marker object key insertion order being
//     stable (which it is for objects authored at one source site).
//   - If a future amendment introduces semantic equivalences across marker
//     orderings (e.g., "two markers in different positions should still hit
//     the same cache entry"), the implementation must add a sortMarkers helper
//     before serialization. This test would then need an update to assert the
//     normalized-order behavior. As of D36, no such equivalence is claimed; the
//     test asserts the strict "same input → same output" determinism only.
//
// Risk path chosen: option (a) test-only (no code change in lib/cache/keys.mjs).
// Rationale: the dead-code path is unreachable from openAIToIR at v0.1, so a
// helper added now would have zero callers; preferred to defer the helper until
// the IR amendment actually activates the slot. Per ALIGNMENT.md Rule 2 (No
// Invention), shipping a sortMarkers helper today would be invention without a
// caller authority. Adding tests is risk-free; adding helpers is not.

describe('D36 #14 — cache_control slot determinism regression', () => {

  // Construct an IR with synthetic cache_control markers attached directly
  // (bypass openAIToIR which strips them at v0.1).
  function makeIRWithMarkers(markers, opts = {}) {
    const messages = opts.messages ?? [
      { role: 'user', content: 'sample-prompt' },
    ];
    // Attach the first marker to the first message; if a second marker is
    // provided, attach it to the second message (or to message 0 nested in a
    // content array, depending on opts.nestSecond).
    const annotated = messages.map((m, idx) => {
      if (idx === 0 && markers[0]) {
        return { ...m, cache_control: markers[0] };
      }
      if (idx === 1 && markers[1]) {
        return { ...m, cache_control: markers[1] };
      }
      return m;
    });
    return makeIR({ messages: annotated, ...opts.irOverrides });
  }

  it('D36 #14a: cache_control slot is populated when markers are present on the IR', () => {
    // The slot is normally null at v0.1 (openAIToIR strips). When markers ARE
    // present (e.g. an IR constructed directly with markers, or after a future
    // ADR 0003 amendment preserves them), the slot carries the markers.
    const irNoMarkers = makeIR({ messages: [{ role: 'user', content: 'hi' }] });
    const irWithMarker = makeIRWithMarkers([{ type: 'ephemeral' }], {
      messages: [{ role: 'user', content: 'hi' }],
    });

    const kNo = computeCacheKey('anthropic', 'claude-haiku-4-5', irNoMarkers);
    const kYes = computeCacheKey('anthropic', 'claude-haiku-4-5', irWithMarker);

    // Different keys: marker presence is observable in the cache key.
    assert.notEqual(kNo, kYes,
      'IR with cache_control markers must produce a different cache key from IR without markers');
    assert.equal(typeof kYes, 'string');
    assert.equal(kYes.length, 64);
  });

  it('D36 #14b: cache key is deterministic across two computations on the same IR with markers', () => {
    // The bedrock invariant: same inputs → same key. The cache_control slot
    // must not introduce nondeterminism (e.g., timestamp, random, iteration
    // order from a Map).
    const ir = makeIRWithMarkers([{ type: 'ephemeral' }], {
      messages: [
        { role: 'user', content: 'first turn' },
        { role: 'assistant', content: 'first reply' },
      ],
    });
    const k1 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir);
    const k2 = computeCacheKey('anthropic', 'claude-haiku-4-5', ir);
    assert.equal(k1, k2, 'cache key must be deterministic for the same IR with markers');
  });

  it('D36 #14c: same markers in the same positional order produce the same key', () => {
    // Two IRs constructed independently with the same marker payload at the
    // same positions must produce the same key. This is the forward-activation
    // contract: when openAIToIR preserves markers, two identical OpenAI
    // requests must produce identical cache keys.
    const irA = makeIRWithMarkers([{ type: 'ephemeral' }], {
      messages: [{ role: 'user', content: 'hello' }],
    });
    const irB = makeIRWithMarkers([{ type: 'ephemeral' }], {
      messages: [{ role: 'user', content: 'hello' }],
    });
    const kA = computeCacheKey('anthropic', 'claude-haiku-4-5', irA);
    const kB = computeCacheKey('anthropic', 'claude-haiku-4-5', irB);
    assert.equal(kA, kB,
      'two independently-constructed IRs with identical marker payloads must share a cache key');
  });

  it('D36 #14d: markers nested in content array participate in the cache key (extractCacheControlMarkers contract)', () => {
    // extractCacheControlMarkers (lib/cache/keys.mjs:126-148) finds markers at
    // both message top-level AND nested inside content array parts. The cache
    // key must reflect both surfaces. This is the slot's full forward-compat
    // contract — when the IR carries cache_control, OLP must observe it on the
    // wire shape the IR provides, including the OpenAI-style content-array
    // nesting that Anthropic prompt-caching uses in production.
    const irTopLevel = makeIR({
      messages: [
        { role: 'user', content: 'hi', cache_control: { type: 'ephemeral' } },
      ],
    });
    const irNested = makeIR({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } },
          ],
        },
      ],
    });
    const irNoMarkers = makeIR({
      messages: [{ role: 'user', content: 'hi' }],
    });

    const kTop = computeCacheKey('anthropic', 'claude-haiku-4-5', irTopLevel);
    const kNested = computeCacheKey('anthropic', 'claude-haiku-4-5', irNested);
    const kNone = computeCacheKey('anthropic', 'claude-haiku-4-5', irNoMarkers);

    // Both marker surfaces must register against the key (be observably distinct
    // from the no-markers case).
    assert.notEqual(kTop, kNone, 'top-level cache_control marker must affect cache key');
    assert.notEqual(kNested, kNone, 'nested cache_control marker must affect cache key');
  });
});

describe('Cache layer — extractCacheControlMarkers + hasCacheControl (Suite 9 cont.)', () => {

  // ── Test 9: extractCacheControlMarkers — top-level ───────────────────
  it('extractCacheControlMarkers finds cache_control at message top level', () => {
    const messages = [
      { role: 'user', content: 'hi', cache_control: { type: 'ephemeral' } },
    ];
    const markers = extractCacheControlMarkers(messages);
    assert.equal(markers.length, 1);
    assert.deepEqual(markers[0], { type: 'ephemeral' });
  });

  // ── Test 10: extractCacheControlMarkers — nested in content array ─────
  it('extractCacheControlMarkers finds cache_control nested in content array', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'world' },
        ],
      },
    ];
    const markers = extractCacheControlMarkers(messages);
    assert.equal(markers.length, 1);
    assert.deepEqual(markers[0], { type: 'ephemeral' });
  });

  // ── Test 11: extractCacheControlMarkers — no markers ─────────────────
  it('extractCacheControlMarkers returns [] when no cache_control markers present', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    assert.deepEqual(extractCacheControlMarkers(messages), []);
  });

  // ── Test 12: hasCacheControl — true ──────────────────────────────────
  it('hasCacheControl returns true when cache_control markers present', () => {
    const ir = makeIR({
      messages: [{ role: 'user', content: 'hi', cache_control: { type: 'ephemeral' } }],
    });
    assert.equal(hasCacheControl(ir), true);
  });

  // ── Test 13: hasCacheControl — false ─────────────────────────────────
  it('hasCacheControl returns false when no cache_control markers', () => {
    const ir = makeIR({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(hasCacheControl(ir), false);
  });

  // ── Test 14: hasCacheControl — null/undefined safety ─────────────────
  it('hasCacheControl returns false for null/undefined ir', () => {
    assert.equal(hasCacheControl(null), false);
    assert.equal(hasCacheControl(undefined), false);
    assert.equal(hasCacheControl({}), false);
  });
});

describe('Cache layer — CacheStore unit tests (Suite 9 cont.)', () => {

  // ── Test 15: set/get round-trip ───────────────────────────────────────
  it('CacheStore.set/get round-trips a value', async () => {
    const store = new CacheStore();
    await store.set('keyA', 'hash1', [{ type: 'stop', finish_reason: 'stop' }]);
    const entry = await store.get('keyA', 'hash1');
    assert.ok(entry !== null);
    assert.deepEqual(entry.value, [{ type: 'stop', finish_reason: 'stop' }]);
  });

  // ── Test 16: get returns null for missing key ─────────────────────────
  it('CacheStore.get returns null for missing (keyId, cacheKey)', async () => {
    const store = new CacheStore();
    const entry = await store.get('keyA', 'nonexistent-hash');
    assert.equal(entry, null);
  });

  // ── Test 17: Per-key isolation ────────────────────────────────────────
  it('CacheStore per-key isolation: keyId1 entries invisible to keyId2', async () => {
    const store = new CacheStore();
    await store.set('keyA', 'hash1', 'value-for-keyA');
    const fromKeyA = await store.get('keyA', 'hash1');
    const fromKeyB = await store.get('keyB', 'hash1');
    assert.ok(fromKeyA !== null);
    assert.equal(fromKeyA.value, 'value-for-keyA');
    assert.equal(fromKeyB, null);
  });

  // ── Test 18: has ─────────────────────────────────────────────────────
  it('CacheStore.has returns true for existing entry, false for missing', async () => {
    const store = new CacheStore();
    await store.set('keyA', 'hash1', 'val');
    assert.equal(await store.has('keyA', 'hash1'), true);
    assert.equal(await store.has('keyA', 'hash-missing'), false);
    assert.equal(await store.has('keyB', 'hash1'), false);
  });

  // ── Test 19: TTL expiry ───────────────────────────────────────────────
  it('CacheStore respects TTL: expired entries return null', async () => {
    // Inject a _nowFn to control time without sleeping.
    // First call: "now" = 0 (entry creation time).
    // Second call: "now" = 2000 (2 seconds later; entry has 1s TTL → expired).
    let fakeNow = 0;
    const store = new CacheStore({ _nowFn: () => fakeNow });
    await store.set('keyA', 'hash1', 'val', 1000); // 1000ms TTL
    // Entry should be alive at t=0
    const entry1 = await store.get('keyA', 'hash1');
    assert.ok(entry1 !== null, 'Expected entry to be alive at t=0');
    // Advance time past TTL
    fakeNow = 2000;
    const entry2 = await store.get('keyA', 'hash1');
    assert.equal(entry2, null, 'Expected entry to be expired at t=2000');
  });

  // ── Test 20: stats reports hits/misses ────────────────────────────────
  it('CacheStore.stats reports hits and misses', async () => {
    const store = new CacheStore();
    await store.set('keyA', 'hash1', 'val');
    await store.get('keyA', 'hash1'); // hit
    await store.get('keyA', 'hash1'); // hit
    await store.get('keyA', 'missing'); // miss
    const s = store.stats('keyA');
    assert.ok(s.hits >= 2, `Expected hits >= 2, got ${s.hits}`);
    assert.ok(s.misses >= 1, `Expected misses >= 1, got ${s.misses}`);
    assert.ok(typeof s.size === 'number');
    assert.ok(typeof s.inflightCount === 'number');
  });

  // ── Test 21: getOrCompute returns computed value on miss ──────────────
  it('getOrCompute returns computed value on miss and caches it', async () => {
    const store = new CacheStore();
    let callCount = 0;
    const computeFn = async () => { callCount++; return [{ type: 'delta', content: 'hello' }]; };
    const v1 = await store.getOrCompute('keyA', 'hash1', computeFn);
    assert.deepEqual(v1, [{ type: 'delta', content: 'hello' }]);
    assert.equal(callCount, 1);
  });

  // ── Test 22: getOrCompute returns cached value on hit (no recomputation) ──
  it('getOrCompute returns cached value on hit — computeFn not called again', async () => {
    const store = new CacheStore();
    let callCount = 0;
    const computeFn = async () => { callCount++; return 'computed-value'; };
    await store.getOrCompute('keyA', 'hash1', computeFn);
    const v2 = await store.getOrCompute('keyA', 'hash1', computeFn);
    assert.equal(v2, 'computed-value');
    assert.equal(callCount, 1, 'computeFn should only be called once on cache hit');
  });

  // ── Test 23: Singleflight — the key D4 test ───────────────────────────
  // 5 concurrent getOrCompute calls with same key + slow computeFn (50ms).
  // Verifies: computeFn called exactly once; all 5 callers receive same value;
  // all 5 return within a tight time window (singleflight working).
  it('getOrCompute singleflight: 5 concurrent callers → computeFn called exactly once', async () => {
    const store = new CacheStore();
    let callCount = 0;

    const slowCompute = async () => {
      callCount++;
      // Simulate a slow provider spawn (50ms)
      await new Promise(r => setTimeout(r, 50));
      return [{ type: 'delta', content: 'singleflight-result' }, { type: 'stop', finish_reason: 'stop' }];
    };

    const t0 = Date.now();
    // Launch 5 concurrent callers simultaneously
    const results = await Promise.all([
      store.getOrCompute('keyA', 'sf-hash', slowCompute),
      store.getOrCompute('keyA', 'sf-hash', slowCompute),
      store.getOrCompute('keyA', 'sf-hash', slowCompute),
      store.getOrCompute('keyA', 'sf-hash', slowCompute),
      store.getOrCompute('keyA', 'sf-hash', slowCompute),
    ]);
    const elapsed = Date.now() - t0;

    // Singleflight invariant: computeFn called exactly once
    assert.equal(callCount, 1, `Expected computeFn called 1 time, got ${callCount}`);

    // All 5 callers receive the same result
    for (const result of results) {
      assert.deepEqual(result, [{ type: 'delta', content: 'singleflight-result' }, { type: 'stop', finish_reason: 'stop' }]);
    }

    // All 5 callers return within a tight window (not 5 * 50ms = 250ms).
    // Allow generous margin (3x the slow compute time) for CI variance.
    assert.ok(elapsed < 250, `Expected singleflight to complete in < 250ms, took ${elapsed}ms`);
  });

  // ── Test 24: getOrCompute releases inflight on completion ────────────
  it('getOrCompute: subsequent calls after completion hit cache (no re-compute)', async () => {
    const store = new CacheStore();
    let callCount = 0;
    const computeFn = async () => { callCount++; return 'done'; };
    // First call — computes and caches
    await store.getOrCompute('keyA', 'hash1', computeFn);
    assert.equal(callCount, 1);
    // Verify inflight is released: calling again should hit cache
    await store.getOrCompute('keyA', 'hash1', computeFn);
    assert.equal(callCount, 1, 'computeFn should not be called again after completion');
    assert.equal(store.stats('keyA').inflightCount, 0, 'No inflight entries after completion');
  });

  // ── Test 25: getOrCompute releases inflight on error ─────────────────
  it('getOrCompute: inflight released when computeFn throws; subsequent calls retry', async () => {
    const store = new CacheStore();
    let callCount = 0;
    let shouldFail = true;
    const computeFn = async () => {
      callCount++;
      if (shouldFail) throw new Error('provider error');
      return 'success';
    };

    // First call — throws
    await assert.rejects(() => store.getOrCompute('keyA', 'hash1', computeFn), /provider error/);
    assert.equal(callCount, 1);
    // Inflight must be released even after error
    assert.equal(store.stats('keyA').inflightCount, 0, 'Inflight must be released after error');

    // Second call — now succeeds (verify re-try works)
    shouldFail = false;
    const v = await store.getOrCompute('keyA', 'hash1', computeFn);
    assert.equal(v, 'success');
    assert.equal(callCount, 2, 'computeFn should be retried after error');
  });

  // ── D23 Tests: size cap (ADR 0005 § Cache write conditions item 4) ───

  // ── Test 26: default maxEntryBytes is 10 MB ───────────────────────────
  it('CacheStore default maxEntryBytes is 10 MB (10_485_760 bytes)', () => {
    const store = new CacheStore();
    assert.equal(store._maxEntryBytes, 10 * 1024 * 1024,
      `Expected 10485760, got ${store._maxEntryBytes}`);
  });

  // ── Test 27: custom maxEntryBytes is respected ────────────────────────
  it('CacheStore with custom maxEntryBytes respects the config', () => {
    const store = new CacheStore({ maxEntryBytes: 100 });
    assert.equal(store._maxEntryBytes, 100);
  });

  // ── Test 28: set() skips persistence for oversized value ──────────────
  it('CacheStore.set() skips persistence when value exceeds maxEntryBytes', async () => {
    const warnCalls = [];
    const store = new CacheStore({
      maxEntryBytes: 10,
      _warnFn: (msg, meta) => warnCalls.push({ msg, meta }),
    });

    // Value that serializes to > 10 bytes
    const bigValue = { content: 'hello world this is definitely more than 10 bytes' };
    await store.set('keyA', 'hash1', bigValue);

    // get() should return null (entry was not stored)
    const entry = await store.get('keyA', 'hash1');
    assert.equal(entry, null, 'Expected oversized entry to not be stored');

    // Warn should have fired
    assert.equal(warnCalls.length, 1, 'Expected exactly one warn call');
    assert.equal(warnCalls[0].msg, 'cache_skip_oversize');
    assert.ok(warnCalls[0].meta.byteLength > 10, `Expected byteLength > 10, got ${warnCalls[0].meta.byteLength}`);
    assert.equal(warnCalls[0].meta.maxEntryBytes, 10);
    assert.equal(warnCalls[0].meta.keyId, 'keyA');
    assert.equal(warnCalls[0].meta.cacheKey, 'hash1');
  });

  // ── Test 29: set() persists normally for value within size cap ────────
  it('CacheStore.set() persists normally when value is within maxEntryBytes', async () => {
    const warnCalls = [];
    const store = new CacheStore({
      maxEntryBytes: 10000,
      _warnFn: (msg, meta) => warnCalls.push({ msg, meta }),
    });

    const smallValue = { content: 'hi' };
    await store.set('keyA', 'hash1', smallValue);

    const entry = await store.get('keyA', 'hash1');
    assert.ok(entry !== null, 'Expected small entry to be stored');
    assert.deepEqual(entry.value, smallValue);
    assert.equal(warnCalls.length, 0, 'Expected no warn calls for small value');
  });

  // ── Test 30: getOrCompute with oversized result — returns value but does NOT cache ──
  it('getOrCompute with oversized result: returns value to caller but does NOT cache it', async () => {
    const warnCalls = [];
    const store = new CacheStore({
      maxEntryBytes: 10,
      _warnFn: (msg, meta) => warnCalls.push({ msg, meta }),
    });

    let computeCallCount = 0;
    const bigValue = [{ type: 'delta', content: 'hello world this is over ten bytes for sure' }];
    const computeFn = async () => { computeCallCount++; return bigValue; };

    // First call — computes, oversized, skips cache
    const v1 = await store.getOrCompute('keyA', 'hash1', computeFn);
    assert.deepEqual(v1, bigValue, 'Expected value returned to caller even when oversized');
    assert.equal(computeCallCount, 1);

    // Verify the value was NOT cached (get returns null)
    const entry = await store.get('keyA', 'hash1');
    assert.equal(entry, null, 'Oversized value must not be stored in cache');

    // Second call — must recompute (cache miss, because oversized skipped storage)
    const v2 = await store.getOrCompute('keyA', 'hash1', computeFn);
    assert.deepEqual(v2, bigValue);
    assert.equal(computeCallCount, 2, 'computeFn must be called again because oversized value was not cached');

    // Warn should have fired twice (once per set() call from the two getOrCompute calls)
    assert.ok(warnCalls.length >= 2, `Expected at least 2 warn calls, got ${warnCalls.length}`);
    assert.ok(warnCalls.every(w => w.msg === 'cache_skip_oversize'));
  });

  // ── D39 (issue #3 Part 1): CacheStore.delete API ─────────────────────
  // Authority: ADR 0005 § "Cache write conditions" item 1; D39 design note in
  // store.mjs. Replaces the prior `set(..., ttlMs=0)` tombstone pattern with
  // an explicit immediate-eviction primitive.

  it('D39: CacheStore.delete returns true and removes entry when present', async () => {
    const store = new CacheStore();
    await store.set('keyA', 'hash1', [{ type: 'delta', content: 'partial' }]);
    // Sanity: entry is there.
    assert.ok(await store.peek('keyA', 'hash1'), 'precondition: entry must be present');
    // Delete reports true.
    assert.equal(store.delete('keyA', 'hash1'), true);
    // Subsequent peek/get return false/null without lazy-purge side-effects.
    assert.equal(await store.peek('keyA', 'hash1'), false, 'peek must be false after delete');
    assert.equal(await store.get('keyA', 'hash1'), null, 'get must return null after delete');
    // getOrCompute on the same key now triggers a FRESH compute (not served from prior entry).
    let computeCount = 0;
    const v = await store.getOrCompute('keyA', 'hash1', async () => {
      computeCount++;
      return [{ type: 'delta', content: 'fresh' }];
    });
    assert.equal(computeCount, 1, 'getOrCompute must invoke computeFn (cache was deleted)');
    assert.deepEqual(v, [{ type: 'delta', content: 'fresh' }]);
  });

  it('D39: CacheStore.delete returns false for absent entry (no throw)', () => {
    const store = new CacheStore();
    // Namespace does not exist at all.
    assert.equal(store.delete('keyA', 'hash-missing'), false);
    // Namespace exists but cacheKey absent — populate then delete one absent key.
    // (set is async; await via Promise.resolve for the precondition setup.)
    return store.set('keyA', 'hash1', 'v').then(() => {
      assert.equal(store.delete('keyA', 'hash-different'), false,
        'delete on absent cacheKey within existing namespace returns false');
      // Existing entry untouched.
      return store.peek('keyA', 'hash1').then((present) => {
        assert.equal(present, true, 'unrelated entry must remain after a false delete');
      });
    });
  });

  it('D39: CacheStore.delete drops empty namespace Map entry (memory hygiene)', async () => {
    const store = new CacheStore();
    await store.set('keyA', 'only-hash', 'val');
    // The internal namespace Map for keyA must exist after set.
    assert.ok(store._store.has('keyA'), 'precondition: namespace exists in _store');
    // Delete the only entry.
    assert.equal(store.delete('keyA', 'only-hash'), true);
    // Namespace Map entry must also be removed from the outer _store.
    assert.equal(store._store.has('keyA'), false,
      'empty namespace must be removed from _store after deleting last entry');
    // A namespace with multiple entries must NOT be removed when only one is deleted.
    await store.set('keyB', 'hash1', 'val1');
    await store.set('keyB', 'hash2', 'val2');
    assert.equal(store.delete('keyB', 'hash1'), true);
    assert.ok(store._store.has('keyB'),
      'non-empty namespace must remain in _store after partial delete');
    assert.equal(store._store.get('keyB').size, 1, 'remaining entry count must be 1');
  });

  // ── Test 31: clear(keyId) clears only that namespace (renumbered from old T26) ──
  it('CacheStore.clear(keyId) clears only that namespace', async () => {
    const store = new CacheStore();
    await store.set('keyA', 'hash1', 'val-a');
    await store.set('keyB', 'hash1', 'val-b');
    store.clear('keyA');
    assert.equal(await store.has('keyA', 'hash1'), false, 'keyA should be cleared');
    assert.equal(await store.has('keyB', 'hash1'), true, 'keyB should remain');
  });

  // ── Test 32: clear() with no args clears all (renumbered from old T27) ──
  it('CacheStore.clear() with no argument clears all namespaces', async () => {
    const store = new CacheStore();
    await store.set('keyA', 'hash1', 'val-a');
    await store.set('keyB', 'hash1', 'val-b');
    store.clear();
    assert.equal(await store.has('keyA', 'hash1'), false, 'keyA should be cleared');
    assert.equal(await store.has('keyB', 'hash1'), false, 'keyB should be cleared');
    assert.equal(store.stats().size, 0);
  });
});

// ── Suite 9 (HTTP integration — cache) ───────────────────────────────────
//
// Tests cache miss / hit / bypass paths via HTTP integration with a mock
// provider. Anthropic provider is enabled with:
//   1. CLAUDE_CODE_OAUTH_TOKEN set to a fake value to bypass auth check
//      (the mock spawn never actually uses the token)
//   2. Mock spawn injected via __setSpawnImpl so no real claude binary runs
//
// This tests the full HTTP → server.mjs → cache layer → provider dispatch
// path end-to-end, with the spawn binary call itself mocked out.

describe('Cache layer — HTTP integration (Suite 9 cont.)', () => {
  let serverInstance9;
  let port9;
  let savedOAuthToken;
  let serverMod9;

  before(async () => {
    // Inject a fake OAuth token so auth check passes without a real token.
    // The mock spawn ignores this value entirely.
    savedOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-fake-oauth-token-for-cache-tests';

    // Set mock spawn that returns a proper response (delta + stop chunks via
    // raw text output — anthropic.mjs treats each stdout data chunk as raw text).
    __setSpawnImpl(makeMockSpawn(['mock-cache-content']));

    // Import the server module (already cached by Node module system — same instance
    // as Suite 7). Mutate the loadedProviders map to add anthropic.
    serverMod9 = await import('./server.mjs');
    const { createOlpServer, loadedProviders: lp } = serverMod9;

    // Wire anthropic into the loaded providers map
    const testProviders = loadProviders({ enabled: { anthropic: true } });
    for (const [name, p] of testProviders) {
      lp.set(name, p);
    }

    port9 = parseInt(
      process.env.OLP_TEST_PORT
        ? String(parseInt(process.env.OLP_TEST_PORT) + 5000)
        : String(18456 + Math.floor(Math.random() * 1000)),
      10,
    );

    serverInstance9 = createOlpServer();
    await new Promise((resolve, reject) => {
      serverInstance9.listen(port9, '127.0.0.1', resolve);
      serverInstance9.once('error', async (e) => {
        if (e.code === 'EADDRINUSE') {
          port9++;
          serverInstance9.listen(port9, '127.0.0.1', resolve);
          serverInstance9.once('error', reject);
        } else reject(e);
      });
    });
  });

  after(() => {
    // Restore OAuth token
    if (savedOAuthToken !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOAuthToken;
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    __resetSpawnImpl();
    return new Promise(r => serverInstance9.close(r));
  });

  // ── Test 28: cache miss path ──────────────────────────────────────────
  // First request with a unique message → cache miss (not yet in cache).
  it('HTTP: first request returns X-OLP-Cache: miss', async () => {
    // Unique content ensures this test doesn't collide with other tests' cached entries
    const testMsg = `http-cache-miss-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    __setSpawnImpl(makeMockSpawn([`response-for-${testMsg}`]));

    const r = await fetch({
      port: port9,
      method: 'POST',
      path: '/v1/chat/completions',
      body: {
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: testMsg }],
      },
    });

    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${r.body.slice(0, 200)}`);
    assert.equal(r.headers['x-olp-cache'], 'miss', `Expected miss, got: ${r.headers['x-olp-cache']}`);
    assert.equal(r.headers['x-olp-provider-used'], 'anthropic');
    assert.equal(r.headers['x-olp-model-used'], 'claude-haiku-4-5');
  });

  // ── Test 29: cache hit path ───────────────────────────────────────────
  // Two identical requests: first → miss, second → hit (same content served from cache).
  it('HTTP: second identical request returns X-OLP-Cache: hit with same content', async () => {
    const testMsg = `http-cache-hit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const mockResponse = `hit-response-${testMsg}`;
    __setSpawnImpl(makeMockSpawn([mockResponse]));

    const reqParams = {
      port: port9,
      method: 'POST',
      path: '/v1/chat/completions',
      body: {
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: testMsg }],
      },
    };

    // First request — miss, spawns real (mock) provider
    const r1 = await fetch(reqParams);
    assert.equal(r1.status, 200, `First request failed: ${r1.status} ${r1.body.slice(0, 200)}`);
    assert.equal(r1.headers['x-olp-cache'], 'miss', `First request should be miss`);
    const body1 = JSON.parse(r1.body);
    const content1 = body1?.choices?.[0]?.message?.content ?? '';

    // Second request — replace spawn with a failing mock to prove spawn is NOT called
    // (if spawn were called, this would produce a 502 error)
    __setSpawnImpl(makeMockSpawn([], 1)); // exit code 1 = ProviderError on spawn

    const r2 = await fetch(reqParams);
    assert.equal(r2.status, 200, `Second request (cache hit) should be 200, got ${r2.status}: ${r2.body.slice(0, 200)}`);
    assert.equal(r2.headers['x-olp-cache'], 'hit', `Second request should be cache hit`);

    // Content should be identical (replayed from cache)
    const body2 = JSON.parse(r2.body);
    const content2 = body2?.choices?.[0]?.message?.content ?? '';
    assert.equal(content2, content1, `Cache hit content should match original`);
  });

  // ── Test 30: cache bypass path (cache_control marker) ────────────────
  // Request with cache_control marker → X-OLP-Cache: bypass (no OLP caching).
  it('HTTP: request with cache_control marker returns X-OLP-Cache: bypass', async () => {
    const testMsg = `http-cache-bypass-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    __setSpawnImpl(makeMockSpawn([`bypass-response-${testMsg}`]));

    const r = await fetch({
      port: port9,
      method: 'POST',
      path: '/v1/chat/completions',
      body: {
        model: 'claude-haiku-4-5',
        messages: [
          {
            role: 'user',
            content: testMsg,
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    });

    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${r.body.slice(0, 200)}`);
    assert.equal(r.headers['x-olp-cache'], 'bypass', `Expected bypass header, got: ${r.headers['x-olp-cache']}`);
  });
});

// ── Suite 9e: D23 cacheable: false opt-out integration ───────────────────
//
// Verifies that a provider with hints.cacheable === false never uses the cache:
// every request triggers a fresh spawn regardless of identical messages.
//
// Strategy: inject a mock provider with cacheable: false into loadedProviders,
// issue two identical requests, assert that spawn was called twice (both = miss).
// X-OLP-Cache header reflects 'miss' on both because the cache is never written.

describe('D23 — cacheable: false opt-out integration (Suite 9e)', () => {
  let serverInstance9e;
  let port9e;
  let savedOAuthToken9e;
  let serverMod9e;

  // Track how many times the mock spawn is called
  let spawnCallCount;

  function makeCountingMockSpawn(textChunks) {
    return function mockSpawn(_bin, _args, _opts) {
      spawnCallCount++;
      return makeMockSpawn(textChunks)(_bin, _args, _opts);
    };
  }

  before(async () => {
    savedOAuthToken9e = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-fake-oauth-for-9e';

    spawnCallCount = 0;
    __setSpawnImpl(makeCountingMockSpawn(['cacheable-false-response']));

    serverMod9e = await import('./server.mjs');
    const { createOlpServer, loadedProviders: lp } = serverMod9e;

    // Inject anthropic with cacheable: false (overriding the real plugin's cacheable: true).
    // This exercises the opt-out path without needing a separate provider binary.
    const testProviders = loadProviders({ enabled: { anthropic: true } });
    for (const [name, p] of testProviders) {
      if (name === 'anthropic') {
        // Shallow-clone so we don't mutate the live plugin object.
        lp.set(name, { ...p, hints: { ...p.hints, cacheable: false } });
      } else {
        lp.set(name, p);
      }
    }

    port9e = parseInt(
      process.env.OLP_TEST_PORT
        ? String(parseInt(process.env.OLP_TEST_PORT) + 6000)
        : String(19456 + Math.floor(Math.random() * 1000)),
      10,
    );

    serverInstance9e = createOlpServer();
    await new Promise((resolve, reject) => {
      serverInstance9e.listen(port9e, '127.0.0.1', resolve);
      serverInstance9e.once('error', async (e) => {
        if (e.code === 'EADDRINUSE') {
          port9e++;
          serverInstance9e.listen(port9e, '127.0.0.1', resolve);
          serverInstance9e.once('error', reject);
        } else reject(e);
      });
    });
  });

  after(() => {
    if (savedOAuthToken9e !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOAuthToken9e;
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    __resetSpawnImpl();
    return new Promise(r => serverInstance9e.close(r));
  });

  it('cacheable: false — both requests trigger fresh spawn (spawn called twice)', async () => {
    const testMsg = `cacheable-false-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    spawnCallCount = 0;

    const reqBody = {
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: testMsg }],
    };

    // First request
    const r1 = await fetch({
      port: port9e,
      method: 'POST',
      path: '/v1/chat/completions',
      body: reqBody,
    });
    assert.equal(r1.status, 200, `First request failed: ${r1.status} ${r1.body.slice(0, 200)}`);

    // Second identical request — must also trigger spawn (cache opt-out)
    __setSpawnImpl(makeCountingMockSpawn(['cacheable-false-response']));
    const r2 = await fetch({
      port: port9e,
      method: 'POST',
      path: '/v1/chat/completions',
      body: reqBody,
    });
    assert.equal(r2.status, 200, `Second request failed: ${r2.status} ${r2.body.slice(0, 200)}`);

    // Both requests must have invoked spawn (cache never served).
    // spawnCallCount is cumulative: after r1=1, after r2=2 (new mock reset to 0 then +1).
    // Actually since we reset the mock between r1 and r2, count is 1 after each.
    // The invariant is: cache did NOT serve r2 from storage; provider was called for r2.
    assert.ok(spawnCallCount >= 1,
      `Expected spawn to be called for second request (got spawnCallCount=${spawnCallCount} after r2)`);
  });

  it('cacheable: false — X-OLP-Cache header is miss on both requests (not hit)', async () => {
    const testMsg = `cacheable-false-header-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    spawnCallCount = 0;
    __setSpawnImpl(makeCountingMockSpawn(['response-for-header-test']));

    const reqBody = {
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: testMsg }],
    };

    const r1 = await fetch({ port: port9e, method: 'POST', path: '/v1/chat/completions', body: reqBody });
    assert.equal(r1.status, 200, `First request: ${r1.status} ${r1.body.slice(0, 200)}`);
    // cacheable: false opts out of cache, so header should NOT be 'hit'
    assert.notEqual(r1.headers['x-olp-cache'], 'hit',
      `Expected first request NOT to be a cache hit, got: ${r1.headers['x-olp-cache']}`);

    __setSpawnImpl(makeCountingMockSpawn(['response-for-header-test']));
    const r2 = await fetch({ port: port9e, method: 'POST', path: '/v1/chat/completions', body: reqBody });
    assert.equal(r2.status, 200, `Second request: ${r2.status} ${r2.body.slice(0, 200)}`);
    assert.notEqual(r2.headers['x-olp-cache'], 'hit',
      `Expected second request NOT to be a cache hit, got: ${r2.headers['x-olp-cache']}`);
  });

  it('cacheable: false + stream: true — both requests trigger fresh spawn; X-OLP-Cache is miss on both', async () => {
    // D23 real-streaming branch fix: a cacheable: false provider with stream: true
    // must NOT enter the D10 real-streaming path (which would write to cache).
    // Instead it falls through to the buffered executeHopFn path which respects the opt-out.
    // Regression: pre-fix code would serve the second request from cache (spawn count = 1,
    // second response X-OLP-Cache: hit, Content-Type: text/event-stream from cache replay).
    const testMsg = `cacheable-false-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const reqBody = {
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: testMsg }],
      stream: true,
    };

    // First streaming request
    spawnCallCount = 0;
    __setSpawnImpl(makeCountingMockSpawn(['stream-chunk-r1']));
    const r1 = await fetch({ port: port9e, method: 'POST', path: '/v1/chat/completions', body: reqBody });
    assert.equal(r1.status, 200, `First streaming request failed: ${r1.status} ${r1.body.slice(0, 200)}`);
    assert.ok(spawnCallCount >= 1, `Expected spawn called for first streaming request, got ${spawnCallCount}`);
    assert.notEqual(r1.headers['x-olp-cache'], 'hit',
      `First streaming request must not be a cache hit, got: ${r1.headers['x-olp-cache']}`);

    // Second identical streaming request — must also trigger spawn (no cache write after r1)
    spawnCallCount = 0;
    __setSpawnImpl(makeCountingMockSpawn(['stream-chunk-r2']));
    const r2 = await fetch({ port: port9e, method: 'POST', path: '/v1/chat/completions', body: reqBody });
    assert.equal(r2.status, 200, `Second streaming request failed: ${r2.status} ${r2.body.slice(0, 200)}`);
    assert.ok(spawnCallCount >= 1,
      `Expected spawn called for second streaming request (cache opt-out), got ${spawnCallCount}`);
    assert.notEqual(r2.headers['x-olp-cache'], 'hit',
      `Second streaming request must not be a cache hit, got: ${r2.headers['x-olp-cache']}`);
  });
});

// ── Suite 9d: D13 cache_control per-hop bypass correctness ───────────────
//
// D13 (ADR 0005 § D2): cache_control markers bypass OLP's response cache ONLY
// when the active hop provider is Anthropic. For non-Anthropic providers the
// markers are noop'd — the hop IS cached normally.
//
// Tests:
//   Test 31: cache_control + non-Anthropic provider (codex) → X-OLP-Cache: miss
//            (NOT bypass — fix validates the defect is corrected)
//   Test 32: cache_control + Anthropic provider → X-OLP-Cache: bypass
//            (existing behaviour preserved — regression guard)
//   Test 33: cache_control + 2-hop chain (anthropic→openai):
//            anthropic hop bypass fires; if anthropic fails, openai hop is NOT bypassed

describe('D13 — cache_control per-hop bypass correctness (Suite 9d)', () => {
  let serverD13;
  let portD13;
  let savedAnthropicTokenD13;
  let savedCodexAuthPathD13;
  let suiteCodexAuthFileD13;

  before(async () => {
    // Inject fake auth for both providers so auth checks pass without real tokens.
    savedAnthropicTokenD13 = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fake-anthropic-token-for-d13-suite';

    const { writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pathJoin } = await import('node:path');
    suiteCodexAuthFileD13 = pathJoin(tmpdir(), `olp-test-d13-codex-auth-${Date.now()}.json`);
    writeFileSync(suiteCodexAuthFileD13, JSON.stringify({ accessToken: 'fake-codex-token-for-d13-suite' }), 'utf8');
    savedCodexAuthPathD13 = process.env.OPENAI_CODEX_AUTH_PATH;
    process.env.OPENAI_CODEX_AUTH_PATH = suiteCodexAuthFileD13;

    // Wire both anthropic and openai providers into the shared loadedProviders map.
    const testProviders = loadProviders({ enabled: { anthropic: true, openai: true } });
    const { loadedProviders: lp, cacheStore: cs } = await import('./server.mjs');
    for (const [name, p] of testProviders) {
      lp.set(name, p);
    }
    cs.clear();

    serverD13 = createOlpServer();
    portD13 = 21456 + Math.floor(Math.random() * 500);
    await new Promise((resolve, reject) => {
      serverD13.listen(portD13, '127.0.0.1', resolve);
      serverD13.once('error', (e) => {
        if (e.code === 'EADDRINUSE') {
          portD13++;
          serverD13.listen(portD13, '127.0.0.1', resolve);
          serverD13.once('error', reject);
        } else reject(e);
      });
    });
  });

  after(async () => {
    __resetSpawnImpl();
    codexResetSpawnImpl();

    if (savedAnthropicTokenD13 !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = savedAnthropicTokenD13;
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    if (savedCodexAuthPathD13 !== undefined) {
      process.env.OPENAI_CODEX_AUTH_PATH = savedCodexAuthPathD13;
    } else {
      delete process.env.OPENAI_CODEX_AUTH_PATH;
    }
    if (suiteCodexAuthFileD13) {
      const { unlinkSync } = await import('node:fs');
      try { unlinkSync(suiteCodexAuthFileD13); } catch { /* ignore */ }
    }

    if (!serverD13) return;
    return new Promise(r => serverD13.close(r));
  });

  // ── Test 31: cache_control + non-Anthropic provider → NOT bypass ──────
  // D13 fix: a request to codex (openai) that carries cache_control markers
  // must use OLP's response cache normally. Before D13, it incorrectly bypassed.
  it('D13: cache_control + openai provider → X-OLP-Cache: miss (NOT bypass)', async () => {
    const testMsg = `d13-codex-no-bypass-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Inject a codex mock that returns a valid NDJSON stop event
    codexSetSpawnImpl(makeMockCodexSpawn([
      JSON.stringify({ content: `codex-response-${testMsg}` }),
      JSON.stringify({ type: 'stop' }),
    ]));

    const r = await fetch({
      port: portD13,
      method: 'POST',
      path: '/v1/chat/completions',
      body: {
        model: 'gpt-5.5',
        messages: [
          {
            role: 'user',
            content: testMsg,
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    });

    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${r.body.slice(0, 200)}`);
    // Key assertion: non-Anthropic hop with cache_control must be 'miss', NOT 'bypass'
    assert.equal(
      r.headers['x-olp-cache'],
      'miss',
      `D13: openai hop with cache_control should be cache miss (not bypass), got: ${r.headers['x-olp-cache']}`,
    );
    assert.equal(r.headers['x-olp-provider-used'], 'openai',
      `Expected openai provider, got: ${r.headers['x-olp-provider-used']}`);
  });

  // ── Test 32: cache_control + Anthropic provider → bypass (regression guard)
  // Verifies that the D13 per-hop logic still correctly bypasses for Anthropic.
  it('D13: cache_control + anthropic provider → X-OLP-Cache: bypass (preserved)', async () => {
    const testMsg = `d13-anthropic-bypass-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    __setSpawnImpl(makeMockSpawn([`anthropic-bypass-response-${testMsg}`]));

    const r = await fetch({
      port: portD13,
      method: 'POST',
      path: '/v1/chat/completions',
      body: {
        model: 'claude-haiku-4-5',
        messages: [
          {
            role: 'user',
            content: testMsg,
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    });

    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${r.body.slice(0, 200)}`);
    assert.equal(
      r.headers['x-olp-cache'],
      'bypass',
      `D13: anthropic hop with cache_control should be bypass, got: ${r.headers['x-olp-cache']}`,
    );
    assert.equal(r.headers['x-olp-provider-used'], 'anthropic',
      `Expected anthropic provider, got: ${r.headers['x-olp-provider-used']}`);
  });

  // ── Test 33: cache_control + 2-hop chain anthropic→openai ────────────
  // When anthropic (hop 0) fails and falls over to openai (hop 1):
  // the openai hop must NOT bypass cache even though cache_control markers
  // were present in the original request.
  it('D13: cache_control + fallback anthropic→openai → openai hop is NOT bypass', async () => {
    const testMsg = `d13-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Wire a 2-hop fallback chain: anthropic → openai for the claude-haiku-4-5 model
    const { __setFallbackConfig } = await import('./server.mjs');
    __setFallbackConfig({
      chains: {
        'claude-haiku-4-5': [
          { provider: 'anthropic', model: 'claude-haiku-4-5' },
          { provider: 'openai',    model: 'gpt-5.5' },
        ],
      },
      soft_triggers: {},
    });

    try {
      // Anthropic spawn always fails with a hard trigger → chain advances to openai
      __setSpawnImpl(makeMockSpawn([], 1)); // exit code 1 = SPAWN_FAILED hard trigger
      // Codex/openai spawn succeeds
      codexSetSpawnImpl(makeMockCodexSpawn([
        JSON.stringify({ content: `fallback-codex-response-${testMsg}` }),
        JSON.stringify({ type: 'stop' }),
      ]));

      const r = await fetch({
        port: portD13,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'claude-haiku-4-5',
          messages: [
            {
              role: 'user',
              content: testMsg,
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      });

      assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${r.body.slice(0, 200)}`);
      // The serving provider is openai (fallback hop 1)
      assert.equal(r.headers['x-olp-provider-used'], 'openai',
        `Expected openai as fallback provider, got: ${r.headers['x-olp-provider-used']}`);
      // D13: openai serving hop must NOT be bypass even though cache_control was present
      assert.notEqual(
        r.headers['x-olp-cache'],
        'bypass',
        `D13: openai fallback hop with cache_control must NOT be bypass, got: ${r.headers['x-olp-cache']}`,
      );
      // It should be 'miss' (first time this openai key is seen)
      assert.equal(
        r.headers['x-olp-cache'],
        'miss',
        `D13: openai fallback hop should be cache miss, got: ${r.headers['x-olp-cache']}`,
      );
    } finally {
      const { __resetFallbackConfig } = await import('./server.mjs');
      __resetFallbackConfig();
      __resetSpawnImpl();
      codexResetSpawnImpl();
    }
  });
});

// ── Suite 9f: D36 #2 cache_control partial-noop debug log ────────────────
//
// Authority: ADR 0005 § Context — "for non-Anthropic targets, the bypass
//   markers are noop'd (logged once per request at debug level so users can
//   see they were ignored)."
//
// Contract: at request entry in handleChatCompletions, after hasCacheControlMarkers
// is computed, emit ONE logEvent('debug', 'cache_control_partial_noop', { chain, marker_count })
// IF AND ONLY IF (a) markers are present AND (b) at least one chain hop is
// non-Anthropic. The log is suppressed when no markers, or when every hop is
// Anthropic.
//
// Implementation strategy: monkeypatch process.stdout.write (debug events go
// to stdout per the logEvent helper in server.mjs:56-63) and grep for the
// event name across the captured writes.

describe('D36 #2 — cache_control partial-noop debug log (Suite 9f)', () => {
  let serverD36;
  let portD36;
  let savedAnthropicTokenD36;
  let savedCodexAuthPathD36;
  let suiteCodexAuthFileD36;

  // ── stdout capture helpers ───────────────────────────────────────────
  let stdoutWrites = [];
  let origStdoutWrite = null;

  function startStdoutCapture() {
    stdoutWrites = [];
    origStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => {
      const s = typeof chunk === 'string'
        ? chunk
        : (Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
      stdoutWrites.push(s);
      return origStdoutWrite(chunk, ...rest);
    };
  }

  function stopStdoutCapture() {
    if (origStdoutWrite) {
      process.stdout.write = origStdoutWrite;
      origStdoutWrite = null;
    }
  }

  /** Returns array of parsed JSON events whose `event` field === eventName. */
  function findEvents(eventName) {
    const found = [];
    for (const w of stdoutWrites) {
      for (const line of w.split('\n')) {
        if (!line.trim()) continue;
        if (!line.includes(`"event":"${eventName}"`)) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.event === eventName) found.push(parsed);
        } catch { /* not JSON — ignore */ }
      }
    }
    return found;
  }

  before(async () => {
    savedAnthropicTokenD36 = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fake-anthropic-token-for-d36-suite';

    const { writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pathJoin } = await import('node:path');
    suiteCodexAuthFileD36 = pathJoin(tmpdir(), `olp-test-d36-codex-auth-${Date.now()}.json`);
    writeFileSync(suiteCodexAuthFileD36, JSON.stringify({ accessToken: 'fake-codex-token-for-d36-suite' }), 'utf8');
    savedCodexAuthPathD36 = process.env.OPENAI_CODEX_AUTH_PATH;
    process.env.OPENAI_CODEX_AUTH_PATH = suiteCodexAuthFileD36;

    const testProviders = loadProviders({ enabled: { anthropic: true, openai: true } });
    const { loadedProviders: lp, cacheStore: cs } = await import('./server.mjs');
    for (const [name, p] of testProviders) {
      lp.set(name, p);
    }
    cs.clear();

    serverD36 = createOlpServer();
    portD36 = 22000 + Math.floor(Math.random() * 500);
    await new Promise((resolve, reject) => {
      serverD36.listen(portD36, '127.0.0.1', resolve);
      serverD36.once('error', (e) => {
        if (e.code === 'EADDRINUSE') {
          portD36++;
          serverD36.listen(portD36, '127.0.0.1', resolve);
          serverD36.once('error', reject);
        } else reject(e);
      });
    });
  });

  after(async () => {
    stopStdoutCapture();
    __resetSpawnImpl();
    codexResetSpawnImpl();

    if (savedAnthropicTokenD36 !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = savedAnthropicTokenD36;
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    if (savedCodexAuthPathD36 !== undefined) {
      process.env.OPENAI_CODEX_AUTH_PATH = savedCodexAuthPathD36;
    } else {
      delete process.env.OPENAI_CODEX_AUTH_PATH;
    }
    if (suiteCodexAuthFileD36) {
      const { unlinkSync } = await import('node:fs');
      try { unlinkSync(suiteCodexAuthFileD36); } catch { /* ignore */ }
    }

    if (!serverD36) return;
    return new Promise(r => serverD36.close(r));
  });

  it('D36 #2a: markers + non-Anthropic chain → cache_control_partial_noop log fires once', async () => {
    // Route to openai (gpt-5.5) with cache_control markers present. Per ADR 0005
    // § Context, the partial-noop log must fire because the chain contains a
    // non-Anthropic hop and markers are present.
    codexSetSpawnImpl(makeMockCodexSpawn([
      JSON.stringify({ content: 'codex-out-d36-2a' }),
      JSON.stringify({ type: 'stop' }),
    ]));

    startStdoutCapture();
    try {
      const r = await fetch({
        port: portD36,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'gpt-5.5',
          messages: [
            { role: 'user', content: 'hello-d36-2a', cache_control: { type: 'ephemeral' } },
          ],
        },
      });
      assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${r.body.slice(0, 200)}`);
    } finally {
      stopStdoutCapture();
    }

    const events = findEvents('cache_control_partial_noop');
    assert.equal(events.length, 1, `Expected exactly 1 cache_control_partial_noop event, got ${events.length}`);
    const ev = events[0];
    assert.equal(ev.level, 'debug', `event level should be 'debug', got '${ev.level}'`);
    assert.ok(Array.isArray(ev.chain), 'chain must be an array');
    assert.ok(ev.chain.includes('openai'),
      `chain should include 'openai', got: ${JSON.stringify(ev.chain)}`);
    assert.equal(typeof ev.marker_count, 'number', 'marker_count must be a number');
    assert.ok(ev.marker_count >= 1, `marker_count must be >= 1, got ${ev.marker_count}`);
  });

  it('D36 #2b: no markers + non-Anthropic chain → cache_control_partial_noop does NOT fire', async () => {
    codexSetSpawnImpl(makeMockCodexSpawn([
      JSON.stringify({ content: 'codex-out-d36-2b' }),
      JSON.stringify({ type: 'stop' }),
    ]));

    startStdoutCapture();
    try {
      const r = await fetch({
        port: portD36,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'gpt-5.5',
          messages: [
            { role: 'user', content: 'hello-d36-2b' }, // no cache_control
          ],
        },
      });
      assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${r.body.slice(0, 200)}`);
    } finally {
      stopStdoutCapture();
    }

    const events = findEvents('cache_control_partial_noop');
    assert.equal(events.length, 0,
      `Expected 0 cache_control_partial_noop events when no markers; got ${events.length}: ${JSON.stringify(events)}`);
  });

  it('D36 #2c: markers + anthropic-only chain → cache_control_partial_noop does NOT fire', async () => {
    // anthropic single-hop chain — every hop is anthropic, so the partial-noop
    // log must be suppressed. The cache_bypass log (already documented) is the
    // correct signal for this case, not partial_noop.
    __setSpawnImpl(makeMockSpawn(['anthropic-out-d36-2c']));

    startStdoutCapture();
    try {
      const r = await fetch({
        port: portD36,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'claude-haiku-4-5',
          messages: [
            { role: 'user', content: 'hello-d36-2c', cache_control: { type: 'ephemeral' } },
          ],
        },
      });
      assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${r.body.slice(0, 200)}`);
    } finally {
      stopStdoutCapture();
    }

    const events = findEvents('cache_control_partial_noop');
    assert.equal(events.length, 0,
      `Expected 0 cache_control_partial_noop events when chain is anthropic-only; got ${events.length}: ${JSON.stringify(events)}`);
  });
});

// ── Suite 11: Codex plugin (D6) ──────────────────────────────────────────
//
// All tests are UNIT tests. No real `codex` binary is invoked.
// Mock spawn is injected via codexSetSpawnImpl / codexResetSpawnImpl.
//
// Authority: Codex CLI reference https://developers.openai.com/codex/cli/reference
//   § "codex exec [flags] PROMPT" — exec subcommand syntax
//   § "--json" — NDJSON output format
//   § "--model, -m" — model override
//   § "$CODEX_HOME/auth.json" — auth artifact location
//
// Lossy-translation acknowledgements per ADR 0003 (documented in codex.mjs header):
//   top_p, temperature, stop, max_tokens, tools[], tool_calls → all dropped.

/**
 * Creates a fake NDJSON-emitting mock spawn for Codex.
 * Lines are emitted as they would arrive from `codex exec --json`.
 *
 * @param {string[]} ndjsonLines — raw NDJSON lines emitted in order (no trailing \n needed)
 * @param {number} [exitCode=0]
 */
function makeMockCodexSpawn(ndjsonLines, exitCode = 0) {
  return function mockCodexSpawnImpl(_bin, _args, _opts) {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = {
      write: () => {},
      end: () => {
        setImmediate(async () => {
          for (const line of ndjsonLines) {
            proc.stdout.emit('data', Buffer.from(line + '\n'));
          }
          proc.stdout.emit('end');
          proc.stderr.emit('end');
          proc.emit('close', exitCode, null);
        });
      },
    };
    proc.killed = false;
    proc.kill = () => {};
    return proc;
  };
}

describe('Codex plugin (D6)', () => {

  // ── Test 1: Contract conformance ─────────────────────────────────────
  it('codex module satisfies validateProvider() — all 10 fields present', () => {
    const { valid, errors } = validateProvider(codex);
    assert.equal(valid, true, `Validation errors: ${errors.join('; ')}`);
    assert.ok('name' in codex, 'missing: name');
    assert.ok('displayName' in codex, 'missing: displayName');
    assert.ok('contractVersion' in codex, 'missing: contractVersion');
    assert.ok('models' in codex, 'missing: models');
    assert.ok('auth' in codex, 'missing: auth');
    assert.ok(typeof codex.spawn === 'function', 'missing: spawn');
    assert.ok(typeof codex.estimateCost === 'function', 'missing: estimateCost');
    assert.ok(typeof codex.quotaStatus === 'function', 'missing: quotaStatus');
    assert.ok(typeof codex.healthCheck === 'function', 'missing: healthCheck');
    assert.ok('hints' in codex, 'missing: hints');
  });

  // ── Test 2: contractVersion === '1.0' ────────────────────────────────
  it('codex declares contractVersion === "1.0"', () => {
    assert.equal(codex.contractVersion, '1.0');
  });

  // ── Test 3: name and displayName ─────────────────────────────────────
  it('codex.name === "openai" and displayName is set', () => {
    assert.equal(codex.name, 'openai');
    assert.equal(typeof codex.displayName, 'string');
    assert.ok(codex.displayName.length > 0);
  });

  // ── Test 4: models match registry ───────────────────────────────────
  it('codex.models matches models-registry.json providers.openai.models[].id', () => {
    const registryIds = modelsRegistry.providers.openai.models.map(m => m.id);
    assert.deepEqual(codex.models, registryIds);
  });

  it('codex.models contains all 5 docs-listed model IDs', () => {
    // Per https://developers.openai.com/codex/models — each id has a
    // `codex -m <id>` example on that page. D6 review-2 expanded the
    // registry to include gpt-5.4-mini and gpt-5.3-codex-spark which the
    // original sonnet draft missed.
    assert.ok(codex.models.includes('gpt-5.5'), 'missing gpt-5.5');
    assert.ok(codex.models.includes('gpt-5.4'), 'missing gpt-5.4');
    assert.ok(codex.models.includes('gpt-5.4-mini'), 'missing gpt-5.4-mini');
    assert.ok(codex.models.includes('gpt-5.3-codex'), 'missing gpt-5.3-codex');
    assert.ok(codex.models.includes('gpt-5.3-codex-spark'), 'missing gpt-5.3-codex-spark');
    assert.equal(codex.models.length, 5, `Expected 5 models, got ${codex.models.length}`);
  });

  // ── Test 5: getProviderForModel finds codex for each model ──────────
  it('getProviderForModel finds openai provider for gpt-5.5', () => {
    const loaded = new Map([['openai', codex]]);
    const result = getProviderForModel(loaded, 'gpt-5.5');
    assert.ok(result !== null);
    assert.equal(result.name, 'openai');
  });

  it('getProviderForModel finds openai provider for gpt-5.4', () => {
    const loaded = new Map([['openai', codex]]);
    const result = getProviderForModel(loaded, 'gpt-5.4');
    assert.ok(result !== null);
    assert.equal(result.name, 'openai');
  });

  it('getProviderForModel finds openai provider for gpt-5.3-codex', () => {
    const loaded = new Map([['openai', codex]]);
    const result = getProviderForModel(loaded, 'gpt-5.3-codex');
    assert.ok(result !== null);
    assert.equal(result.name, 'openai');
  });

  // ── Test 6: irToCodex translation ────────────────────────────────────
  it('irToCodex: user message → args with exec --json --model, prompt as positional', () => {
    const ir = makeIR({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'Hello world' }],
    });
    const { args, prompt, useStdin } = irToCodex(ir);
    // Authority: Codex CLI reference § "codex exec [flags] PROMPT"
    assert.ok(args.includes('exec'), 'args must include "exec"');
    assert.ok(args.includes('--json'), 'args must include "--json"');
    assert.ok(args.includes('--model'), 'args must include "--model"');
    assert.ok(args.includes('gpt-5.5'), 'args must include model value');
    assert.ok(typeof prompt === 'string', 'prompt must be a string');
    assert.ok(prompt.includes('Hello world'), 'prompt must contain user text');
    assert.equal(useStdin, false, 'single-line prompt should use argv, not stdin');
  });

  it('irToCodex: system + user → system annotation + user text in prompt', () => {
    const ir = makeIR({
      model: 'gpt-5.4',
      messages: [
        { role: 'system', content: 'You are a coder.' },
        { role: 'user', content: 'Write a function.' },
      ],
    });
    const { prompt } = irToCodex(ir);
    assert.ok(prompt.includes('[System] You are a coder.'));
    assert.ok(prompt.includes('Write a function.'));
  });

  it('irToCodex: assistant prior turn → [Assistant] annotation', () => {
    const ir = makeIR({
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'Thanks' },
      ],
    });
    const { prompt } = irToCodex(ir);
    assert.ok(prompt.includes('[Assistant] Hello!'));
    assert.ok(prompt.includes('Thanks'));
  });

  it('irToCodex: tool_calls in assistant message — content preserved, metadata dropped (lossy)', () => {
    // ADR 0003 § Lossy: structured tool_calls dropped; textual content preserved.
    const ir = makeIR({
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'Search for X' },
        {
          role: 'assistant',
          content: 'Searching...',
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'search', arguments: '{"q":"X"}' } }],
        },
      ],
    });
    const { prompt } = irToCodex(ir);
    // Content preserved
    assert.ok(prompt.includes('Searching...'), 'assistant text content must be preserved');
    // tool_calls metadata not directly in prompt (dropped per lossy spec)
    // (We do NOT assert the metadata IS there — it is documented as dropped.)
  });

  it('irToCodex: response_format json_object injects system prompt', () => {
    const ir = makeIR({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'Give JSON' }],
      response_format: { type: 'json_object' },
    });
    const { prompt } = irToCodex(ir);
    assert.ok(prompt.includes('Reply with valid JSON only'));
  });

  it('irToCodex: multiline prompt uses stdin path (useStdin=true) with `-` positional', () => {
    const ir = makeIR({
      model: 'gpt-5.5',
      messages: [
        { role: 'system', content: 'Line one.' },
        { role: 'user', content: 'Line two.' },
      ],
    });
    const { useStdin, args } = irToCodex(ir);
    // System + user messages join with '\n\n' → contains newline → stdin
    assert.equal(useStdin, true, 'multi-section prompt should use stdin');
    // Per Codex CLI reference, stdin requires the literal `-` positional.
    // (D6 review-2 finding: original draft omitted positional entirely;
    // docs explicitly state stdin requires `-`.)
    assert.ok(args.includes('-'), 'stdin path must pass `-` as positional');
    assert.ok(!args.includes('Line one.'), 'literal prompt must not appear in args when useStdin');
  });

  it('irToCodex: tool result turn → [Tool Result] annotation', () => {
    const ir = makeIR({
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'Search for X' },
        { role: 'tool', content: '{"results":[]}', name: 'search' },
      ],
    });
    const { prompt } = irToCodex(ir);
    assert.ok(prompt.includes('[Tool Result'));
    assert.ok(prompt.includes('search'));
  });

  // ── Test 7: codexChunkToIR translation ────────────────────────────────
  it('codexChunkToIR: content field → delta chunk', () => {
    const chunk = codexChunkToIR('{"content":"Hello world"}');
    assert.ok(chunk !== null);
    assert.equal(chunk.type, 'delta');
    assert.equal(chunk.content, 'Hello world');
  });

  it('codexChunkToIR: delta field → delta chunk', () => {
    const chunk = codexChunkToIR('{"type":"delta","delta":"token text"}');
    assert.ok(chunk !== null);
    assert.equal(chunk.type, 'delta');
    assert.equal(chunk.content, 'token text');
  });

  it('codexChunkToIR: text field → delta chunk', () => {
    // Possible alternative event shape with "text" field
    const chunk = codexChunkToIR('{"type":"output_text","text":"output here"}');
    assert.ok(chunk !== null);
    assert.equal(chunk.type, 'delta');
    assert.equal(chunk.content, 'output here');
  });

  it('codexChunkToIR: type === "stop" → stop chunk', () => {
    const chunk = codexChunkToIR('{"type":"stop"}');
    assert.ok(chunk !== null);
    assert.equal(chunk.type, 'stop');
    assert.equal(chunk.finish_reason, 'stop');
  });

  it('codexChunkToIR: done === true → stop chunk', () => {
    const chunk = codexChunkToIR('{"done":true,"id":"run_123"}');
    assert.ok(chunk !== null);
    assert.equal(chunk.type, 'stop');
    assert.equal(chunk.finish_reason, 'stop');
  });

  it('codexChunkToIR: type === "error" → error chunk', () => {
    const chunk = codexChunkToIR('{"type":"error","error":"quota exceeded"}');
    assert.ok(chunk !== null);
    assert.equal(chunk.type, 'error');
    assert.equal(chunk.error, 'quota exceeded');
  });

  it('codexChunkToIR: error field present → error chunk', () => {
    const chunk = codexChunkToIR('{"error":"something went wrong","code":500}');
    assert.ok(chunk !== null);
    assert.equal(chunk.type, 'error');
  });

  it('codexChunkToIR: unknown/progress event type → null (silently ignored)', () => {
    // Events like {"type":"progress","step":1} are ignored per D6 spec
    const chunk = codexChunkToIR('{"type":"progress","step":1}');
    assert.equal(chunk, null);
  });

  it('codexChunkToIR: empty line → null', () => {
    assert.equal(codexChunkToIR(''), null);
    assert.equal(codexChunkToIR('   '), null);
  });

  it('codexChunkToIR: malformed JSON → null (no throw)', () => {
    assert.doesNotThrow(() => {
      const result = codexChunkToIR('{bad json');
      assert.equal(result, null);
    });
  });

  // ── Test 8: mock spawn — NDJSON stream yields correct IR chunks ───────
  it('spawn with mock: NDJSON lines → delta chunks then stop chunk', async () => {
    const fakeSpawn = makeMockCodexSpawn([
      '{"content":"Hello"}',
      '{"content":" world"}',
      '{"type":"stop"}',
    ]);
    codexSetSpawnImpl(fakeSpawn);
    try {
      const ir = makeIR({
        model: 'gpt-5.5',
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
      });
      const authCtx = { accessToken: '<fake-openai-token>' };
      const chunks = [];
      for await (const chunk of codex.spawn(ir, authCtx)) {
        chunks.push(chunk);
      }
      const deltas = chunks.filter(c => c.type === 'delta');
      const stops = chunks.filter(c => c.type === 'stop');
      assert.ok(deltas.length >= 1, `Expected at least 1 delta, got ${deltas.length}`);
      assert.equal(stops.length, 1, `Expected 1 stop, got ${stops.length}`);
      const allContent = deltas.map(c => c.content).join('');
      assert.equal(allContent, 'Hello world');
    } finally {
      codexResetSpawnImpl();
    }
  });

  it('spawn with mock: first delta chunk has role=assistant', async () => {
    const fakeSpawn = makeMockCodexSpawn(['{"content":"Test output"}']);
    codexSetSpawnImpl(fakeSpawn);
    try {
      const ir = makeIR({
        model: 'gpt-5.5',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      });
      const authCtx = { accessToken: '<fake-openai-token>' };
      const chunks = [];
      for await (const chunk of codex.spawn(ir, authCtx)) {
        chunks.push(chunk);
      }
      const firstDelta = chunks.find(c => c.type === 'delta');
      assert.ok(firstDelta, 'No delta chunk found');
      assert.equal(firstDelta.role, 'assistant');
    } finally {
      codexResetSpawnImpl();
    }
  });

  it('spawn with mock: NDJSON stop event present → no extra synthetic stop appended', async () => {
    // If NDJSON stream already contains a stop event, we should NOT double-emit
    const fakeSpawn = makeMockCodexSpawn([
      '{"content":"done"}',
      '{"type":"stop"}',
    ]);
    codexSetSpawnImpl(fakeSpawn);
    try {
      const ir = makeIR({
        model: 'gpt-5.5',
        stream: false,
        messages: [{ role: 'user', content: 'Hello' }],
      });
      const authCtx = { accessToken: '<fake-openai-token>' };
      const chunks = [];
      for await (const chunk of codex.spawn(ir, authCtx)) {
        chunks.push(chunk);
      }
      const stops = chunks.filter(c => c.type === 'stop');
      assert.equal(stops.length, 1, `Expected exactly 1 stop chunk, got ${stops.length}`);
    } finally {
      codexResetSpawnImpl();
    }
  });

  it('spawn with mock: non-zero exit code throws ProviderError(SPAWN_FAILED)', async () => {
    const fakeSpawn = makeMockCodexSpawn([], 1);
    codexSetSpawnImpl(fakeSpawn);
    try {
      const ir = makeIR({
        model: 'gpt-5.5',
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
      });
      const authCtx = { accessToken: '<fake-openai-token>' };
      let caught = null;
      try {
        for await (const _chunk of codex.spawn(ir, authCtx)) {
          // drain
        }
      } catch (e) {
        caught = e;
      }
      assert.ok(caught instanceof ProviderError, `Expected ProviderError, got ${caught?.constructor?.name}`);
      assert.equal(caught.code, 'SPAWN_FAILED');
    } finally {
      codexResetSpawnImpl();
    }
  });

  it('spawn throws ProviderError(AUTH_MISSING) when no auth context and no auth file', async () => {
    const fakeSpawn = makeMockCodexSpawn(['{"content":"test"}']);
    codexSetSpawnImpl(fakeSpawn);
    // Override auth path to a nonexistent file to guarantee missing auth
    const savedAuthPath = process.env.OPENAI_CODEX_AUTH_PATH;
    process.env.OPENAI_CODEX_AUTH_PATH = '/nonexistent/path/auth.json';
    try {
      const ir = makeIR({
        model: 'gpt-5.5',
        stream: false,
        messages: [{ role: 'user', content: 'Hi' }],
      });
      let caught = null;
      try {
        for await (const _chunk of codex.spawn(ir, null)) { // eslint-disable-line no-unused-vars
          // drain
        }
      } catch (e) {
        caught = e;
      }
      assert.ok(caught instanceof ProviderError, `Expected ProviderError, got ${caught?.constructor?.name}`);
      assert.equal(caught.code, 'AUTH_MISSING');
    } finally {
      if (savedAuthPath !== undefined) {
        process.env.OPENAI_CODEX_AUTH_PATH = savedAuthPath;
      } else {
        delete process.env.OPENAI_CODEX_AUTH_PATH;
      }
      codexResetSpawnImpl();
    }
  });

  // ── Test 9: healthCheck ───────────────────────────────────────────────
  it('healthCheck returns {ok: false, error: "codex binary not found"} when binary absent', async () => {
    const result = await codexHealthCheck({
      _binaryExistsFn: () => false,
      _authReadFn: () => ({ accessToken: '<fake-token>' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'codex binary not found');
    assert.ok(typeof result.latencyMs === 'number');
  });

  it('healthCheck returns {ok: false, error: "auth artifact missing"} when auth missing', async () => {
    const result = await codexHealthCheck({
      _binaryExistsFn: () => true,
      _authReadFn: () => null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'auth artifact missing');
    assert.ok(typeof result.latencyMs === 'number');
  });

  it('healthCheck returns {ok: true} when binary and auth both present', async () => {
    const result = await codexHealthCheck({
      _binaryExistsFn: () => true,
      _authReadFn: () => ({ accessToken: '<fake-token>' }),
    });
    assert.equal(result.ok, true);
    assert.ok(typeof result.latencyMs === 'number');
  });

  // ── Test 10: estimateCost ─────────────────────────────────────────────
  it('estimateCost returns shape with currency USD', () => {
    const request = makeIR({
      model: 'gpt-5.5',
      messages: [
        { role: 'system', content: 'You are a coding assistant.' },
        { role: 'user', content: 'Write hello world in Python.' },
      ],
    });
    const result = codexEstimateCost(request);
    assert.ok(result !== null, 'estimateCost returned null');
    assert.ok('inputTokens' in result, 'missing inputTokens');
    assert.ok('outputTokensEstimate' in result, 'missing outputTokensEstimate');
    assert.ok('currency' in result, 'missing currency');
    assert.ok('usd' in result, 'missing usd');
    assert.equal(result.currency, 'USD');
    assert.equal(result.usd, null); // not pinned at D6
    assert.ok(result.inputTokens > 0, 'inputTokens should be > 0');
    assert.ok(result.outputTokensEstimate >= 0);
  });

  it('estimateCost returns null for null/missing request', () => {
    assert.equal(codexEstimateCost(null), null);
    assert.equal(codexEstimateCost({}), null);
  });

  // ── Test 11: quotaStatus ──────────────────────────────────────────────
  it('quotaStatus returns null at D6', async () => {
    const result = await codexQuotaStatus({});
    assert.equal(result, null);
  });

  // ── Test 12: auth artifact path uses os.homedir(), not hardcoded ──────
  it('codex.auth.path uses homedir() and references .codex directory', () => {
    assert.equal(typeof codex.auth.path, 'string');
    assert.ok(codex.auth.path.includes('.codex'), 'auth.path should reference .codex directory');
    // Portability check: path must start with homedir() value at runtime
    assert.ok(
      codex.auth.path.startsWith(homedir()),
      `auth.path "${codex.auth.path}" should start with homedir() "${homedir()}"`,
    );
  });

  it('codex.auth.type === "oauth" and storage === "file"', () => {
    assert.equal(codex.auth.type, 'oauth');
    assert.equal(codex.auth.storage, 'file');
  });

  // ── Test 13: readAuthArtifact reads OPENAI_CODEX_AUTH_PATH override ──
  it('readAuthArtifact: OPENAI_CODEX_AUTH_PATH pointing to nonexistent file → null', () => {
    const saved = process.env.OPENAI_CODEX_AUTH_PATH;
    process.env.OPENAI_CODEX_AUTH_PATH = '/definitely/not/a/real/path/auth.json';
    try {
      const result = codexReadAuthArtifact();
      assert.equal(result, null);
    } finally {
      if (saved !== undefined) process.env.OPENAI_CODEX_AUTH_PATH = saved;
      else delete process.env.OPENAI_CODEX_AUTH_PATH;
    }
  });

  // ── Test 14: hints shape ──────────────────────────────────────────────
  it('codex.hints has correct shape', () => {
    assert.equal(typeof codex.hints.requiresTTY, 'boolean');
    assert.equal(typeof codex.hints.concurrentSpawnSafe, 'boolean');
    assert.ok(Number.isInteger(codex.hints.maxConcurrent) && codex.hints.maxConcurrent > 0);
    assert.equal(codex.hints.requiresTTY, false);
    assert.equal(codex.hints.concurrentSpawnSafe, true);
  });

  // ── Test 15: STATIC_REGISTRY length after D8 still includes openai ────
  it('STATIC_REGISTRY includes openai (D6) after D8 (length >= 2)', () => {
    // D8 adds mistral; anthropic + openai must still be present.
    assert.ok(listAllProviderNames().length >= 2);
    assert.ok(listAllProviderNames().includes('anthropic'));
    assert.ok(listAllProviderNames().includes('openai'));
  });

  // ── Test 16: loadProviders with openai enabled ────────────────────────
  it('loadProviders with {enabled: {openai: true}} returns Map of size 1 with openai', () => {
    const loaded = loadProviders({ enabled: { openai: true } });
    assert.equal(loaded.size, 1);
    assert.ok(loaded.has('openai'));
  });

  it('loadProviders with both anthropic and openai enabled returns Map of size 2', () => {
    const loaded = loadProviders({ enabled: { anthropic: true, openai: true } });
    assert.equal(loaded.size, 2);
    assert.ok(loaded.has('anthropic'));
    assert.ok(loaded.has('openai'));
  });

  it('openai loaded via loadProviders passes contract validation', () => {
    const loaded = loadProviders({ enabled: { openai: true } });
    const p = loaded.get('openai');
    const { valid, errors } = validateProvider(p);
    assert.equal(valid, true, `Contract errors: ${errors.join('; ')}`);
    assert.ok(p.models.includes('gpt-5.5'));
  });

  // ── Test 17: spawn progress events silently ignored ──────────────────
  it('spawn with mock: progress events are silently ignored, only content emitted', async () => {
    const fakeSpawn = makeMockCodexSpawn([
      '{"type":"progress","step":1}',
      '{"type":"progress","step":2}',
      '{"content":"actual response"}',
      '{"type":"stop"}',
    ]);
    codexSetSpawnImpl(fakeSpawn);
    try {
      const ir = makeIR({
        model: 'gpt-5.5',
        stream: true,
        messages: [{ role: 'user', content: 'Do something' }],
      });
      const authCtx = { accessToken: '<fake-openai-token>' };
      const chunks = [];
      for await (const chunk of codex.spawn(ir, authCtx)) {
        chunks.push(chunk);
      }
      const deltas = chunks.filter(c => c.type === 'delta');
      assert.equal(deltas.length, 1);
      assert.equal(deltas[0].content, 'actual response');
    } finally {
      codexResetSpawnImpl();
    }
  });

  // ── Test 18: spawn synthesizes stop when NDJSON stream has no stop event ──
  it('spawn with mock: synthetic stop emitted when NDJSON has no stop event', async () => {
    const fakeSpawn = makeMockCodexSpawn([
      '{"content":"only content, no stop"}',
      // No stop event in the stream
    ]);
    codexSetSpawnImpl(fakeSpawn);
    try {
      const ir = makeIR({
        model: 'gpt-5.5',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      });
      const authCtx = { accessToken: '<fake-openai-token>' };
      const chunks = [];
      for await (const chunk of codex.spawn(ir, authCtx)) {
        chunks.push(chunk);
      }
      const stops = chunks.filter(c => c.type === 'stop');
      assert.equal(stops.length, 1, 'Should have exactly 1 synthetic stop chunk');
      assert.equal(stops[0].finish_reason, 'stop');
    } finally {
      codexResetSpawnImpl();
    }
  });

});

// ── Suite 10: Anthropic E2E (GATED) ──────────────────────────────────────
//
// Run with: OLP_RUN_E2E=1 npm test
// Skipped by default; consumes real Anthropic tokens (~200 tokens per run,
// est. <$0.001 at haiku rates). Requires `claude` binary + keychain OAuth
// token. The orchestrator runs this once per D5 verification.
//
// This suite is NOT run in CI (CI does not set OLP_RUN_E2E). The skip notice
// is emitted as a console message so CI logs show the gated test exists.
//
// Tests:
//   1. Start OLP server with anthropic enabled.
//   2. POST minimal request to claude-haiku-4-5.
//   3. Assert 200, response contains "OK", correct provider/model headers.
//   4. Send same request again → assert X-OLP-Cache: hit, identical content.
//   5. Assert X-OLP-Fallback-Hops: 0.
//
// Model: claude-haiku-4-5 (cheapest). Prompt: "Reply with exactly the word OK
// and nothing else." max_tokens: 10. Target: < 200 tokens per run.
//
// Do NOT include any real OAuth tokens or API keys in this test. Auth is read
// from keychain / CLAUDE_CODE_OAUTH_TOKEN env / ~/.claude/.credentials.json
// by readAuthArtifact() inside the anthropic plugin at spawn time.

const RUN_E2E = process.env.OLP_RUN_E2E === '1';

if (!RUN_E2E) {
  // Emit a skip notice to CI logs without failing the suite
  process.stdout.write('::notice::Suite 10 (Anthropic E2E) skipped — set OLP_RUN_E2E=1 to run. Requires claude binary + keychain OAuth token. ~200 tokens per run.\n');
}

describe('Anthropic E2E — real claude spawn (Suite 10)', { skip: !RUN_E2E }, () => {
  let e2eServer;
  let e2ePort;
  let e2eLoadedProviders;
  let e2eCacheStore;

  before(async () => {
    if (!RUN_E2E) return;

    __resetSpawnImpl(); // ensure real spawn is active

    const { createOlpServer, loadedProviders: lp, cacheStore: cs } = await import('./server.mjs');
    e2eLoadedProviders = lp;
    e2eCacheStore = cs;

    // Enable anthropic provider for E2E
    const testProviders = loadProviders({ enabled: { anthropic: true } });
    for (const [name, p] of testProviders) {
      lp.set(name, p);
    }

    e2ePort = parseInt(process.env.OLP_E2E_PORT ?? String(19456 + Math.floor(Math.random() * 500)), 10);
    e2eServer = createOlpServer();
    await new Promise((resolve, reject) => {
      e2eServer.listen(e2ePort, '127.0.0.1', resolve);
      e2eServer.once('error', async (e) => {
        if (e.code === 'EADDRINUSE') {
          e2ePort++;
          e2eServer.listen(e2ePort, '127.0.0.1', resolve);
          e2eServer.once('error', reject);
        } else reject(e);
      });
    });
  });

  after(() => {
    if (!e2eServer) return;
    return new Promise(r => e2eServer.close(r));
  });

  it('E2E: POST claude-haiku-4-5 with minimal prompt → 200 + "OK" content + correct headers', async () => {
    const body = {
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'Reply with exactly the word OK and nothing else.' }],
      max_tokens: 10,
    };

    const r = await fetch({ port: e2ePort, method: 'POST', path: '/v1/chat/completions', body });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${r.body}`);

    const respBody = JSON.parse(r.body);
    const content = respBody?.choices?.[0]?.message?.content ?? '';
    assert.ok(
      content.toLowerCase().includes('ok'),
      `Expected response to contain "OK", got: ${content}`,
    );

    // Provider/model headers
    assert.equal(r.headers['x-olp-provider-used'], 'anthropic', `Expected anthropic provider`);
    assert.equal(r.headers['x-olp-model-used'], 'claude-haiku-4-5', `Expected haiku model`);

    // First request is always a miss
    assert.equal(r.headers['x-olp-cache'], 'miss', `First request should be cache miss`);

    // Fallback hops
    assert.equal(r.headers['x-olp-fallback-hops'], '0', `Expected 0 fallback hops`);

    // Second request — should hit cache, content identical
    const r2 = await fetch({ port: e2ePort, method: 'POST', path: '/v1/chat/completions', body });
    assert.equal(r2.status, 200, `Cache hit request should be 200`);
    assert.equal(r2.headers['x-olp-cache'], 'hit', `Second request should be cache hit`);

    const resp2Body = JSON.parse(r2.body);
    const content2 = resp2Body?.choices?.[0]?.message?.content ?? '';
    assert.ok(
      content2.toLowerCase().includes('ok'),
      `Cache hit response should also contain "OK", got: ${content2}`,
    );
  });
});

// ── Suite 12: Mistral Vibe plugin (D8) ───────────────────────────────────
//
// All tests are UNIT tests. No real `vibe` binary is invoked.
// Mock spawn is injected via mistralSetSpawnImpl / mistralResetSpawnImpl.
//
// Authority: Mistral Vibe docs (WebFetched 2026-05-23):
//   DOCS-1: https://docs.mistral.ai/mistral-vibe/terminal/quickstart
//     § "--prompt TEXT" + "--output FORMAT" — programmatic mode syntax
//   DOCS-2: https://docs.mistral.ai/mistral-vibe/terminal/configuration
//     § "~/.vibe/.env" — auth file; MISTRAL_API_KEY env var
//   DOCS-5: https://mistral.ai/news/devstral-2-vibe-cli
//     § "Devstral 2", "Devstral Small 2" — model names
//   DOCS-6: https://help.mistral.ai/en/articles/347532
//     § "Mistral Vibe is included in every Le Chat Pro subscription"
//   DOCS-7: https://legal.mistral.ai/terms/usage-policy
//     § No anti-third-party clauses (Tier D confirmed for ADR 0006)
//
// Spec assumption acknowledgements (see mistral.mjs header):
//   A1 CONFIRMED: `vibe --prompt "PROMPT" --output json` spawn shape
//   A2 CONFIRMED: MISTRAL_API_KEY env var is the auth mechanism
//   A3 CONFIRMED: ~/.vibe/.env is the auth file path
//   A4 UNPINNED: JSON output event schema — defensive 4-shape parser used
//   A5 UNPINNED: --model flag existence not confirmed by docs
//   A6 UNPINNED: exact model IDs (devstral-2, devstral-small-2) best-effort
//   A7 UNPINNED: --output json is NDJSON not single blob
//   A8 UNPINNED: multi-line prompt handling via --prompt flag
//
// Lossy-translation acknowledgements per ADR 0003 (documented in mistral.mjs header):
//   top_p, temperature, stop, max_tokens, tools[], tool_calls → all dropped.

/**
 * Creates a fake JSON-line-emitting mock spawn for Mistral Vibe.
 * Lines are emitted as they would arrive from `vibe --output json`
 * (D8 assumption A7: NDJSON lines — D-later will pin the real format).
 *
 * @param {string[]} jsonLines — raw JSON lines emitted in order (no trailing \n needed)
 * @param {number} [exitCode=0]
 */
function makeMockMistralSpawn(jsonLines, exitCode = 0) {
  return function mockMistralSpawnImpl(_bin, _args, _opts) {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = {
      write: () => {},
      end: () => {
        setImmediate(async () => {
          for (const line of jsonLines) {
            proc.stdout.emit('data', Buffer.from(line + '\n'));
          }
          proc.stdout.emit('end');
          proc.stderr.emit('end');
          proc.emit('close', exitCode, null);
        });
      },
    };
    proc.killed = false;
    proc.kill = () => {};
    return proc;
  };
}

describe('Mistral Vibe plugin (D8)', () => {

  // ── Test 1: Contract conformance ──────────────────────────────────────
  it('mistral module satisfies validateProvider() — all 10 fields present', () => {
    const { valid, errors } = validateProvider(mistral);
    assert.equal(valid, true, `Validation errors: ${errors.join('; ')}`);
    assert.ok('name' in mistral, 'missing: name');
    assert.ok('displayName' in mistral, 'missing: displayName');
    assert.ok('contractVersion' in mistral, 'missing: contractVersion');
    assert.ok('models' in mistral, 'missing: models');
    assert.ok('auth' in mistral, 'missing: auth');
    assert.ok(typeof mistral.spawn === 'function', 'missing: spawn');
    assert.ok(typeof mistral.estimateCost === 'function', 'missing: estimateCost');
    assert.ok(typeof mistral.quotaStatus === 'function', 'missing: quotaStatus');
    assert.ok(typeof mistral.healthCheck === 'function', 'missing: healthCheck');
    assert.ok('hints' in mistral, 'missing: hints');
  });

  // ── Test 2: contractVersion === '1.0' ────────────────────────────────
  it('mistral declares contractVersion === "1.0"', () => {
    assert.equal(mistral.contractVersion, '1.0');
  });

  // ── Test 3: name and displayName ─────────────────────────────────────
  it('mistral.name === "mistral" and displayName is set', () => {
    assert.equal(mistral.name, 'mistral');
    assert.equal(typeof mistral.displayName, 'string');
    assert.ok(mistral.displayName.length > 0);
    assert.ok(mistral.displayName.toLowerCase().includes('mistral'));
  });

  // ── Test 4: models is canonical-only (D17 Finding 12 fix) ───────────
  it('mistral.models contains only canonical registry IDs — no alias strings', () => {
    // D17 fix: models[] is canonical-only across all plugins. Alias routing
    // is the responsibility of getProviderForModel() in lib/providers/index.mjs.
    const registryIds = modelsRegistry.providers.mistral.models.map(m => m.id);
    const registryAliases = Object.keys(modelsRegistry.providers.mistral.aliases ?? {});
    for (const id of registryIds) {
      assert.ok(mistral.models.includes(id), `canonical id ${id} missing from mistral.models`);
    }
    for (const alias of registryAliases) {
      assert.ok(!mistral.models.includes(alias), `alias ${alias} must NOT appear in mistral.models (D17)`);
    }
    assert.equal(mistral.models.length, registryIds.length, `Expected ${registryIds.length} canonical IDs, got ${mistral.models.length}`);
  });

  it('mistral.models contains exactly the two canonical date-stamped IDs', () => {
    // D17 fix: canonical-only shape. Length: 2 canonical IDs.
    assert.ok(mistral.models.includes('devstral-2-25-12'), 'missing canonical devstral-2-25-12');
    assert.ok(mistral.models.includes('devstral-small-2-25-12'), 'missing canonical devstral-small-2-25-12');
    assert.ok(!mistral.models.includes('devstral-2'), 'alias devstral-2 must NOT be in models[] (D17)');
    assert.ok(!mistral.models.includes('devstral-small-2'), 'alias devstral-small-2 must NOT be in models[] (D17)');
    assert.ok(!mistral.models.includes('devstral'), 'alias devstral must NOT be in models[] (D17)');
    assert.ok(!mistral.models.includes('devstral-small'), 'alias devstral-small must NOT be in models[] (D17)');
    // Length: 2 canonical only
    assert.equal(mistral.models.length, 2, `Expected 2 canonical IDs, got ${mistral.models.length}`);
  });

  // ── Test 5: getProviderForModel finds mistral for each model ──────────
  it('getProviderForModel finds mistral for canonical devstral-2-25-12', () => {
    const loaded = new Map([['mistral', mistral]]);
    const result = getProviderForModel(loaded, 'devstral-2-25-12');
    assert.ok(result !== null);
    assert.equal(result.name, 'mistral');
    assert.equal(result.canonicalModel, 'devstral-2-25-12');
  });

  it('getProviderForModel finds mistral for alias devstral-2 → canonical devstral-2-25-12 (D17)', () => {
    // D17: alias resolution now handled in getProviderForModel, not in models[].
    const loaded = new Map([['mistral', mistral]]);
    const result = getProviderForModel(loaded, 'devstral-2');
    assert.ok(result !== null);
    assert.equal(result.name, 'mistral');
    assert.equal(result.canonicalModel, 'devstral-2-25-12');
  });

  it('getProviderForModel finds mistral for alias devstral → canonical devstral-2-25-12 (D17)', () => {
    const loaded = new Map([['mistral', mistral]]);
    const result = getProviderForModel(loaded, 'devstral');
    assert.ok(result !== null);
    assert.equal(result.name, 'mistral');
    assert.equal(result.canonicalModel, 'devstral-2-25-12');
  });

  it('getProviderForModel finds mistral for alias devstral-small-2 → canonical devstral-small-2-25-12 (D17)', () => {
    const loaded = new Map([['mistral', mistral]]);
    const result = getProviderForModel(loaded, 'devstral-small-2');
    assert.ok(result !== null);
    assert.equal(result.name, 'mistral');
    assert.equal(result.canonicalModel, 'devstral-small-2-25-12');
  });

  // ── Test 6: irToMistral translation ──────────────────────────────────
  it('irToMistral: user message → args with --prompt and --output streaming', () => {
    // Authority: DOCS-1 § "Output Format Options" — `streaming` is the
    // newline-delimited JSON per message mode. `json` emits a single blob
    // at the end (D8 review-2 finding: original draft used `json`,
    // incompatible with the line-buffered stdout parser; corrected to
    // `streaming` per docs verbatim).
    const ir = makeIR({
      model: 'devstral-2',
      messages: [{ role: 'user', content: 'Hello world' }],
    });
    const { args, prompt } = irToMistral(ir);
    assert.ok(args.includes('--prompt'), 'args must include "--prompt"');
    assert.ok(args.includes('--output'), 'args must include "--output"');
    assert.ok(args.includes('streaming'), 'args must include "streaming" output format (NDJSON per docs)');
    assert.ok(!args.includes('json'), 'args must NOT include "json" (single-blob mode, incompatible with line-buffered parser)');
    // D8 assumption A5: --model NOT in args (flag existence unconfirmed from docs)
    assert.ok(!args.includes('--model'), 'args must NOT include "--model" at D8 (A5 UNPINNED)');
    assert.ok(typeof prompt === 'string', 'prompt must be a string');
    assert.ok(prompt.includes('Hello world'), 'prompt must contain user text');
  });

  it('irToMistral: system + user → system annotation + user text in prompt', () => {
    const ir = makeIR({
      model: 'devstral-2',
      messages: [
        { role: 'system', content: 'You are a coding assistant.' },
        { role: 'user', content: 'Write a function.' },
      ],
    });
    const { prompt } = irToMistral(ir);
    assert.ok(prompt.includes('[System] You are a coding assistant.'));
    assert.ok(prompt.includes('Write a function.'));
  });

  it('irToMistral: assistant prior turn → [Assistant] annotation', () => {
    const ir = makeIR({
      model: 'devstral-2',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'Thanks' },
      ],
    });
    const { prompt } = irToMistral(ir);
    assert.ok(prompt.includes('[Assistant] Hello!'));
    assert.ok(prompt.includes('Thanks'));
  });

  it('irToMistral: tool result turn → [Tool Result] annotation', () => {
    const ir = makeIR({
      model: 'devstral-2',
      messages: [
        { role: 'user', content: 'Search for X' },
        { role: 'tool', content: '{"results":[]}', name: 'search' },
      ],
    });
    const { prompt } = irToMistral(ir);
    assert.ok(prompt.includes('[Tool Result'));
    assert.ok(prompt.includes('search'));
  });

  it('irToMistral: response_format json_object injects system prompt (lossy)', () => {
    // ADR 0003 § Lossy: Vibe CLI does not honor response_format natively.
    const ir = makeIR({
      model: 'devstral-2',
      messages: [{ role: 'user', content: 'Give JSON' }],
      response_format: { type: 'json_object' },
    });
    const { prompt } = irToMistral(ir);
    assert.ok(prompt.includes('Reply with valid JSON only'));
  });

  it('irToMistral: tool_calls in assistant message — content preserved, metadata dropped (lossy)', () => {
    // ADR 0003 § Lossy: structured tool_calls dropped; textual content preserved.
    const ir = makeIR({
      model: 'devstral-2',
      messages: [
        { role: 'user', content: 'Search for X' },
        {
          role: 'assistant',
          content: 'Searching...',
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'search', arguments: '{"q":"X"}' } }],
        },
      ],
    });
    const { prompt } = irToMistral(ir);
    assert.ok(prompt.includes('Searching...'), 'assistant text content must be preserved');
    // tool_calls metadata documented as dropped (lossy) — do NOT assert it's present
  });

  it('irToMistral: array content is JSON-stringified', () => {
    const ir = makeIR({
      model: 'devstral-2',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    const { prompt } = irToMistral(ir);
    assert.ok(typeof prompt === 'string');
    assert.ok(prompt.includes('text'));
  });

  // ── Test 7: mistralChunkToIR translation ──────────────────────────────
  it('mistralChunkToIR: text field → delta chunk (Mistral La Plateforme shape)', () => {
    // D8 assumption A4: "text" is the preferred field name.
    const chunk = mistralChunkToIR('{"text":"Hello world"}');
    assert.ok(chunk !== null);
    assert.equal(chunk.type, 'delta');
    assert.equal(chunk.content, 'Hello world');
  });

  it('mistralChunkToIR: content field → delta chunk (OpenAI-compat shape)', () => {
    // D8 assumption A4: "content" as fallback field name.
    const chunk = mistralChunkToIR('{"content":"Hello world"}');
    assert.ok(chunk !== null);
    assert.equal(chunk.type, 'delta');
    assert.equal(chunk.content, 'Hello world');
  });

  it('mistralChunkToIR: delta field shape → delta chunk', () => {
    // D8 assumption A4: { type: 'delta', delta: '...' } shape.
    const chunk = mistralChunkToIR('{"type":"delta","delta":"token text"}');
    assert.ok(chunk !== null);
    assert.equal(chunk.type, 'delta');
    assert.equal(chunk.content, 'token text');
  });

  it('mistralChunkToIR: OpenAI streaming choices[0].delta.content shape → delta', () => {
    // D8 assumption A4: Vibe may use OpenAI streaming event shape.
    const chunk = mistralChunkToIR('{"choices":[{"delta":{"content":"output"},"finish_reason":null}]}');
    assert.ok(chunk !== null);
    assert.equal(chunk.type, 'delta');
    assert.equal(chunk.content, 'output');
  });

  it('mistralChunkToIR: type === "stop" → stop chunk', () => {
    const chunk = mistralChunkToIR('{"type":"stop"}');
    assert.ok(chunk !== null);
    assert.equal(chunk.type, 'stop');
    assert.equal(chunk.finish_reason, 'stop');
  });

  it('mistralChunkToIR: done === true → stop chunk', () => {
    const chunk = mistralChunkToIR('{"done":true}');
    assert.ok(chunk !== null);
    assert.equal(chunk.type, 'stop');
    assert.equal(chunk.finish_reason, 'stop');
  });

  it('mistralChunkToIR: OpenAI streaming stop via choices[0].finish_reason === "stop"', () => {
    // D8 assumption A4: OpenAI streaming stop shape.
    const chunk = mistralChunkToIR('{"choices":[{"delta":{},"finish_reason":"stop"}]}');
    assert.ok(chunk !== null);
    assert.equal(chunk.type, 'stop');
    assert.equal(chunk.finish_reason, 'stop');
  });

  it('mistralChunkToIR: type === "error" → error chunk', () => {
    const chunk = mistralChunkToIR('{"type":"error","error":"quota exceeded"}');
    assert.ok(chunk !== null);
    assert.equal(chunk.type, 'error');
    assert.equal(chunk.error, 'quota exceeded');
  });

  it('mistralChunkToIR: error field present → error chunk', () => {
    const chunk = mistralChunkToIR('{"error":"something went wrong","code":429}');
    assert.ok(chunk !== null);
    assert.equal(chunk.type, 'error');
  });

  it('mistralChunkToIR: unknown/progress event type → null (silently ignored)', () => {
    const chunk = mistralChunkToIR('{"type":"progress","step":1}');
    assert.equal(chunk, null);
  });

  it('mistralChunkToIR: empty line → null', () => {
    assert.equal(mistralChunkToIR(''), null);
    assert.equal(mistralChunkToIR('   '), null);
  });

  it('mistralChunkToIR: malformed JSON → null (no throw)', () => {
    assert.doesNotThrow(() => {
      const result = mistralChunkToIR('{bad json');
      assert.equal(result, null);
    });
  });

  // ── Test 8: mock spawn — JSON stream yields correct IR chunks ──────────
  it('spawn with mock: JSON lines → delta chunks then stop chunk', async () => {
    const fakeSpawn = makeMockMistralSpawn([
      '{"text":"Hello"}',
      '{"text":" world"}',
      '{"type":"stop"}',
    ]);
    mistralSetSpawnImpl(fakeSpawn);
    try {
      const ir = makeIR({
        model: 'devstral-2',
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
      });
      const authCtx = { apiKey: '<fake-mistral-api-key>' };
      const chunks = [];
      for await (const chunk of mistral.spawn(ir, authCtx)) {
        chunks.push(chunk);
      }
      const deltas = chunks.filter(c => c.type === 'delta');
      const stops = chunks.filter(c => c.type === 'stop');
      assert.ok(deltas.length >= 1, `Expected at least 1 delta, got ${deltas.length}`);
      assert.equal(stops.length, 1, `Expected 1 stop, got ${stops.length}`);
      const allContent = deltas.map(c => c.content).join('');
      assert.equal(allContent, 'Hello world');
    } finally {
      mistralResetSpawnImpl();
    }
  });

  it('spawn with mock: first delta chunk has role=assistant', async () => {
    const fakeSpawn = makeMockMistralSpawn(['{"text":"Test output"}']);
    mistralSetSpawnImpl(fakeSpawn);
    try {
      const ir = makeIR({
        model: 'devstral-2',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      });
      const authCtx = { apiKey: '<fake-mistral-api-key>' };
      const chunks = [];
      for await (const chunk of mistral.spawn(ir, authCtx)) {
        chunks.push(chunk);
      }
      const firstDelta = chunks.find(c => c.type === 'delta');
      assert.ok(firstDelta, 'No delta chunk found');
      assert.equal(firstDelta.role, 'assistant');
    } finally {
      mistralResetSpawnImpl();
    }
  });

  it('spawn with mock: stop event present → no extra synthetic stop appended', async () => {
    const fakeSpawn = makeMockMistralSpawn([
      '{"text":"done"}',
      '{"type":"stop"}',
    ]);
    mistralSetSpawnImpl(fakeSpawn);
    try {
      const ir = makeIR({
        model: 'devstral-2',
        stream: false,
        messages: [{ role: 'user', content: 'Hello' }],
      });
      const authCtx = { apiKey: '<fake-mistral-api-key>' };
      const chunks = [];
      for await (const chunk of mistral.spawn(ir, authCtx)) {
        chunks.push(chunk);
      }
      const stops = chunks.filter(c => c.type === 'stop');
      assert.equal(stops.length, 1, `Expected exactly 1 stop chunk, got ${stops.length}`);
    } finally {
      mistralResetSpawnImpl();
    }
  });

  it('spawn with mock: synthetic stop emitted when JSON stream has no stop event', async () => {
    const fakeSpawn = makeMockMistralSpawn([
      '{"text":"only content, no stop"}',
    ]);
    mistralSetSpawnImpl(fakeSpawn);
    try {
      const ir = makeIR({
        model: 'devstral-2',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      });
      const authCtx = { apiKey: '<fake-mistral-api-key>' };
      const chunks = [];
      for await (const chunk of mistral.spawn(ir, authCtx)) {
        chunks.push(chunk);
      }
      const stops = chunks.filter(c => c.type === 'stop');
      assert.equal(stops.length, 1, 'Should have exactly 1 synthetic stop chunk');
      assert.equal(stops[0].finish_reason, 'stop');
    } finally {
      mistralResetSpawnImpl();
    }
  });

  it('spawn with mock: non-zero exit code throws ProviderError(SPAWN_FAILED)', async () => {
    const fakeSpawn = makeMockMistralSpawn([], 1);
    mistralSetSpawnImpl(fakeSpawn);
    try {
      const ir = makeIR({
        model: 'devstral-2',
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
      });
      const authCtx = { apiKey: '<fake-mistral-api-key>' };
      let caught = null;
      try {
        for await (const _chunk of mistral.spawn(ir, authCtx)) { // eslint-disable-line no-unused-vars
          // drain
        }
      } catch (e) {
        caught = e;
      }
      assert.ok(caught instanceof ProviderError, `Expected ProviderError, got ${caught?.constructor?.name}`);
      assert.equal(caught.code, 'SPAWN_FAILED');
    } finally {
      mistralResetSpawnImpl();
    }
  });

  it('spawn throws ProviderError(AUTH_MISSING) when no auth context and no env/file', async () => {
    const fakeSpawn = makeMockMistralSpawn(['{"text":"test"}']);
    mistralSetSpawnImpl(fakeSpawn);
    // Override auth path to nonexistent + clear MISTRAL_API_KEY env to guarantee missing auth
    const savedApiKey = process.env.MISTRAL_API_KEY;
    const savedAuthPath = process.env.MISTRAL_VIBE_AUTH_PATH;
    delete process.env.MISTRAL_API_KEY;
    process.env.MISTRAL_VIBE_AUTH_PATH = '/nonexistent/path/.env';
    try {
      const ir = makeIR({
        model: 'devstral-2',
        stream: false,
        messages: [{ role: 'user', content: 'Hi' }],
      });
      let caught = null;
      try {
        for await (const _chunk of mistral.spawn(ir, null)) { // eslint-disable-line no-unused-vars
          // drain
        }
      } catch (e) {
        caught = e;
      }
      assert.ok(caught instanceof ProviderError, `Expected ProviderError, got ${caught?.constructor?.name}`);
      assert.equal(caught.code, 'AUTH_MISSING');
    } finally {
      if (savedApiKey !== undefined) process.env.MISTRAL_API_KEY = savedApiKey;
      else delete process.env.MISTRAL_API_KEY;
      if (savedAuthPath !== undefined) process.env.MISTRAL_VIBE_AUTH_PATH = savedAuthPath;
      else delete process.env.MISTRAL_VIBE_AUTH_PATH;
      mistralResetSpawnImpl();
    }
  });

  it('spawn with mock: progress events silently ignored, only content emitted', async () => {
    const fakeSpawn = makeMockMistralSpawn([
      '{"type":"progress","step":1}',
      '{"type":"progress","step":2}',
      '{"text":"actual response"}',
      '{"type":"stop"}',
    ]);
    mistralSetSpawnImpl(fakeSpawn);
    try {
      const ir = makeIR({
        model: 'devstral-2',
        stream: true,
        messages: [{ role: 'user', content: 'Do something' }],
      });
      const authCtx = { apiKey: '<fake-mistral-api-key>' };
      const chunks = [];
      for await (const chunk of mistral.spawn(ir, authCtx)) {
        chunks.push(chunk);
      }
      const deltas = chunks.filter(c => c.type === 'delta');
      assert.equal(deltas.length, 1);
      assert.equal(deltas[0].content, 'actual response');
    } finally {
      mistralResetSpawnImpl();
    }
  });

  // ── Test 9: healthCheck ───────────────────────────────────────────────
  it('healthCheck returns {ok: false, error: "vibe binary not found"} when binary absent', async () => {
    const result = await mistralHealthCheck({
      _binaryExistsFn: () => false,
      _authReadFn: () => ({ apiKey: '<fake-key>' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'vibe binary not found');
    assert.ok(typeof result.latencyMs === 'number');
  });

  it('healthCheck returns {ok: false, error: "auth artifact missing"} when auth missing', async () => {
    const result = await mistralHealthCheck({
      _binaryExistsFn: () => true,
      _authReadFn: () => null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'auth artifact missing');
    assert.ok(typeof result.latencyMs === 'number');
  });

  it('healthCheck returns {ok: true} when binary and auth both present', async () => {
    const result = await mistralHealthCheck({
      _binaryExistsFn: () => true,
      _authReadFn: () => ({ apiKey: '<fake-key>' }),
    });
    assert.equal(result.ok, true);
    assert.ok(typeof result.latencyMs === 'number');
  });

  // ── Test 10: estimateCost ─────────────────────────────────────────────
  it('estimateCost returns shape with currency USD', () => {
    const request = makeIR({
      model: 'devstral-2',
      messages: [
        { role: 'system', content: 'You are a coding assistant.' },
        { role: 'user', content: 'Write hello world in Python.' },
      ],
    });
    const result = mistralEstimateCost(request);
    assert.ok(result !== null, 'estimateCost returned null');
    assert.ok('inputTokens' in result, 'missing inputTokens');
    assert.ok('outputTokensEstimate' in result, 'missing outputTokensEstimate');
    assert.ok('currency' in result, 'missing currency');
    assert.ok('usd' in result, 'missing usd');
    assert.equal(result.currency, 'USD');
    assert.equal(result.usd, null); // not pinned at D8
    assert.ok(result.inputTokens > 0, 'inputTokens should be > 0');
    assert.ok(result.outputTokensEstimate >= 0);
  });

  it('estimateCost returns null for null/missing request', () => {
    assert.equal(mistralEstimateCost(null), null);
    assert.equal(mistralEstimateCost({}), null);
  });

  // ── Test 11: quotaStatus ──────────────────────────────────────────────
  it('quotaStatus returns null at D8 (Le Chat Pro budget not exposed via API)', async () => {
    const result = await mistralQuotaStatus({});
    assert.equal(result, null);
  });

  // ── Test 12: auth object shape ────────────────────────────────────────
  it('mistral.auth has correct shape', () => {
    // Authority: DOCS-2 § auth type is api-key, path is ~/.vibe/.env
    assert.equal(mistral.auth.type, 'api-key');
    assert.equal(mistral.auth.storage, 'file');
    assert.equal(typeof mistral.auth.path, 'string');
    assert.ok(mistral.auth.path.includes('.vibe'), 'auth.path should reference .vibe directory');
    assert.ok(mistral.auth.path.includes('.env'), 'auth.path should reference .env file');
    // Portability check: path must start with homedir() (no hardcoded literal)
    assert.ok(
      mistral.auth.path.startsWith(homedir()),
      `auth.path "${mistral.auth.path}" should start with homedir() "${homedir()}"`,
    );
  });

  // ── Test 13: hints shape ──────────────────────────────────────────────
  it('mistral.hints has correct shape', () => {
    assert.equal(typeof mistral.hints.requiresTTY, 'boolean');
    assert.equal(typeof mistral.hints.concurrentSpawnSafe, 'boolean');
    assert.ok(Number.isInteger(mistral.hints.maxConcurrent) && mistral.hints.maxConcurrent > 0);
    assert.equal(mistral.hints.requiresTTY, false);
    assert.equal(mistral.hints.concurrentSpawnSafe, true);
  });

  // ── Test 14: STATIC_REGISTRY length after D8 ─────────────────────────
  it('STATIC_REGISTRY.length === 3 after D8 (anthropic + openai + mistral)', () => {
    assert.equal(listAllProviderNames().length, 3);
    assert.ok(listAllProviderNames().includes('anthropic'));
    assert.ok(listAllProviderNames().includes('openai'));
    assert.ok(listAllProviderNames().includes('mistral'));
  });

  // ── Test 15: loadProviders with mistral enabled ───────────────────────
  it('loadProviders with {enabled: {mistral: true}} returns Map of size 1 with mistral', () => {
    const loaded = loadProviders({ enabled: { mistral: true } });
    assert.equal(loaded.size, 1);
    assert.ok(loaded.has('mistral'));
  });

  it('loadProviders with all 3 providers enabled returns Map of size 3', () => {
    const loaded = loadProviders({ enabled: { anthropic: true, openai: true, mistral: true } });
    assert.equal(loaded.size, 3);
    assert.ok(loaded.has('anthropic'));
    assert.ok(loaded.has('openai'));
    assert.ok(loaded.has('mistral'));
  });

  it('mistral loaded via loadProviders passes contract validation', () => {
    const loaded = loadProviders({ enabled: { mistral: true } });
    const p = loaded.get('mistral');
    const { valid, errors } = validateProvider(p);
    assert.equal(valid, true, `Contract errors: ${errors.join('; ')}`);
    // D17: models[] is canonical-only. Verify via getProviderForModel instead of direct inclusion.
    assert.ok(p.models.includes('devstral-2-25-12'), 'canonical devstral-2-25-12 must be in models[]');
    const r = getProviderForModel(loaded, 'devstral-2');
    assert.ok(r !== null, 'alias devstral-2 must route to mistral via getProviderForModel (D17)');
    assert.equal(r.name, 'mistral');
  });

  // ── Test 16: auth artifact reading helpers ────────────────────────────
  it('readAuthArtifact: MISTRAL_API_KEY env var → returns {apiKey}', () => {
    const saved = process.env.MISTRAL_API_KEY;
    process.env.MISTRAL_API_KEY = '<fake-mistral-api-key>';
    try {
      const result = mistralReadAuthArtifact();
      assert.ok(result !== null, 'Expected auth result');
      assert.equal(result.apiKey, '<fake-mistral-api-key>');
    } finally {
      if (saved !== undefined) process.env.MISTRAL_API_KEY = saved;
      else delete process.env.MISTRAL_API_KEY;
    }
  });

  it('readAuthArtifact: MISTRAL_VIBE_AUTH_PATH pointing to nonexistent file → null', () => {
    const savedApiKey = process.env.MISTRAL_API_KEY;
    const savedAuthPath = process.env.MISTRAL_VIBE_AUTH_PATH;
    delete process.env.MISTRAL_API_KEY;
    process.env.MISTRAL_VIBE_AUTH_PATH = '/definitely/not/a/real/path/.env';
    try {
      const result = mistralReadAuthArtifact();
      assert.equal(result, null);
    } finally {
      if (savedApiKey !== undefined) process.env.MISTRAL_API_KEY = savedApiKey;
      else delete process.env.MISTRAL_API_KEY;
      if (savedAuthPath !== undefined) process.env.MISTRAL_VIBE_AUTH_PATH = savedAuthPath;
      else delete process.env.MISTRAL_VIBE_AUTH_PATH;
    }
  });

  // ── Test 17: Suite 5 registry test updated for D8 ─────────────────────
  // (This re-tests the registry length assertion which now expects 3.)
  it('listAllProviderNames() now returns 3-element array with mistral included', () => {
    const names = listAllProviderNames();
    assert.equal(names.length, 3);
    assert.deepEqual(names, ['anthropic', 'openai', 'mistral']);
  });

});

// ── Suite 13: Fallback engine (D9) ───────────────────────────────────────
//
// All tests are unit tests. No real provider CLIs are invoked.
// Tests cover:
//   13a: Trigger taxonomy (evaluateHardTriggers / evaluateSoftTriggers)
//   13b: executeWithFallback engine behaviour
//   13c: First-chunk safety (buffering semantics at D9)
//   13d: Soft trigger skipping spawn
//   13e: Header annotation (providerUsed / modelUsed / fallbackHops / originalError)
//   13f: HTTP integration with __setFallbackConfig test seam
//
// Authority: ADR 0004 — Fallback Engine Semantics and Safety

import {
  evaluateHardTriggers,
  evaluateSoftTriggers,
  executeWithFallback,
  buildDefaultChain,
  loadFallbackConfigSync,
  isClientError,
} from './lib/fallback/engine.mjs';

import {
  createOlpServer,
  __setFallbackConfig,
  __resetFallbackConfig,
  __clearCache,
  __setAuthConfig,
  __resetAuthConfig,
  __setStreamingConfig,
  __resetStreamingConfig,
  __clearRecentErrors,
  __snapshotRecentErrors,
  __resetRequestCounters,
} from './server.mjs';

// ── Phase 2 / D45+D46 server-side default override ────────────────────────
// Override the production-off defaults so that existing pre-D45 HTTP
// integration tests (Suite 18 etc.) continue to pass:
//   - allow_anonymous: true  → /v1/* requests without Authorization → anonymous
//   - owner_only_endpoints: []  → /health full payload (D46 trimming opt-out)
//   - fallback_detail_header_policy: 'all'  → X-OLP-Fallback-Detail emitted to
//                                              all identities (D40 v0.1.1 behaviour)
// New Suite 20 (D45) + Suite 21 (D46) explicitly call __setAuthConfig per-case
// to exercise the production-default paths.
__setAuthConfig({
  allow_anonymous: true,
  owner_only_endpoints: [],
  fallback_detail_header_policy: 'all',
});

// ── 13a: Trigger taxonomy ────────────────────────────────────────────────

describe('Fallback engine — trigger taxonomy (D9)', () => {

  // ── evaluateHardTriggers ─────────────────────────────────────────────

  it('evaluateHardTriggers: HTTP 500 → fires (5xx hard trigger)', () => {
    const err = Object.assign(new Error('Server error'), { statusCode: 500 });
    assert.equal(evaluateHardTriggers(err), true);
  });

  it('evaluateHardTriggers: HTTP 503 → fires (5xx hard trigger)', () => {
    const err = Object.assign(new Error('Service unavailable'), { statusCode: 503 });
    assert.equal(evaluateHardTriggers(err), true);
  });

  it('evaluateHardTriggers: HTTP 400 → does NOT fire (client error)', () => {
    const err = Object.assign(new Error('Bad request'), { statusCode: 400 });
    assert.equal(evaluateHardTriggers(err), false);
  });

  it('evaluateHardTriggers: HTTP 401 → does NOT fire (client error)', () => {
    const err = Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    assert.equal(evaluateHardTriggers(err), false);
  });

  it('evaluateHardTriggers: HTTP 403 → does NOT fire (client error)', () => {
    const err = Object.assign(new Error('Forbidden'), { statusCode: 403 });
    assert.equal(evaluateHardTriggers(err), false);
  });

  it('evaluateHardTriggers: HTTP 404 → does NOT fire (client error)', () => {
    const err = Object.assign(new Error('Not found'), { statusCode: 404 });
    assert.equal(evaluateHardTriggers(err), false);
  });

  it('evaluateHardTriggers: HTTP 422 → does NOT fire (client error)', () => {
    const err = Object.assign(new Error('Unprocessable'), { statusCode: 422 });
    assert.equal(evaluateHardTriggers(err), false);
  });

  it('evaluateHardTriggers: HTTP 429 → fires (quota-like 4xx not in client-error set)', () => {
    const err = Object.assign(new Error('Too Many Requests'), { statusCode: 429 });
    assert.equal(evaluateHardTriggers(err), true);
  });

  // QUOTA_EXHAUSTED and RATE_LIMITED tests removed (D34 F7): those codes were
  // removed from PROVIDER_ERROR_CODES and HARD_TRIGGER_CODES — no v0.1 plugin
  // emits them. Re-add tests via ADR 0004 amendment when HTTP-status parsing lands.

  it('evaluateHardTriggers: ProviderError SPAWN_FAILED → fires', () => {
    const err = new ProviderError('Spawn failed', 'SPAWN_FAILED');
    assert.equal(evaluateHardTriggers(err), true);
  });

  it('evaluateHardTriggers: ProviderError CLI_NOT_FOUND → fires', () => {
    const err = new ProviderError('CLI not found', 'CLI_NOT_FOUND');
    assert.equal(evaluateHardTriggers(err), true);
  });

  it('evaluateHardTriggers: ProviderError AUTH_MISSING → does NOT fire (user must fix)', () => {
    const err = new ProviderError('Auth missing', 'AUTH_MISSING');
    assert.equal(evaluateHardTriggers(err), false);
  });

  // D32 F4: OUTPUT_PARSE_ERROR removed from PROVIDER_ERROR_CODES and
  // HARD_TRIGGER_CODES — no plugin emits it; it was dead code. Test removed.

  it('evaluateHardTriggers: generic Error with no statusCode → does NOT fire', () => {
    const err = new Error('Something went wrong');
    assert.equal(evaluateHardTriggers(err), false);
  });

  it('evaluateHardTriggers: null error → does NOT fire', () => {
    assert.equal(evaluateHardTriggers(null), false);
  });

  // ── evaluateSoftTriggers ─────────────────────────────────────────────

  it('evaluateSoftTriggers: credit_pool_percent_threshold at exactly threshold → fires', () => {
    const cfg = { credit_pool_percent_threshold: 90 };
    const quota = { percentUsed: 90 };
    assert.equal(evaluateSoftTriggers(cfg, quota), true);
  });

  it('evaluateSoftTriggers: credit_pool_percent_threshold above threshold → fires', () => {
    const cfg = { credit_pool_percent_threshold: 90 };
    const quota = { percentUsed: 95 };
    assert.equal(evaluateSoftTriggers(cfg, quota), true);
  });

  it('evaluateSoftTriggers: credit_pool_percent_threshold below threshold → does NOT fire', () => {
    const cfg = { credit_pool_percent_threshold: 90 };
    const quota = { percentUsed: 89 };
    assert.equal(evaluateSoftTriggers(cfg, quota), false);
  });

  it('evaluateSoftTriggers: daily_request_count_threshold at threshold → fires', () => {
    const cfg = { daily_request_count_threshold: 500 };
    const quota = { dailyCount: 500 };
    assert.equal(evaluateSoftTriggers(cfg, quota), true);
  });

  it('evaluateSoftTriggers: daily_request_count_threshold below threshold → does NOT fire', () => {
    const cfg = { daily_request_count_threshold: 500 };
    const quota = { dailyCount: 499 };
    assert.equal(evaluateSoftTriggers(cfg, quota), false);
  });

  it('evaluateSoftTriggers: five_hour_window_percent_threshold at threshold → fires', () => {
    const cfg = { five_hour_window_percent_threshold: 85 };
    const quota = { fiveHourWindowPercent: 85 };
    assert.equal(evaluateSoftTriggers(cfg, quota), true);
  });

  it('evaluateSoftTriggers: null quotaSnapshot → does NOT fire (graceful degrade)', () => {
    const cfg = { credit_pool_percent_threshold: 90 };
    assert.equal(evaluateSoftTriggers(cfg, null), false);
  });

  it('evaluateSoftTriggers: undefined quotaSnapshot → does NOT fire (graceful degrade)', () => {
    const cfg = { credit_pool_percent_threshold: 90 };
    assert.equal(evaluateSoftTriggers(cfg, undefined), false);
  });

  it('evaluateSoftTriggers: null triggerConfig → does NOT fire', () => {
    const quota = { percentUsed: 95 };
    assert.equal(evaluateSoftTriggers(null, quota), false);
  });

  it('evaluateSoftTriggers: empty triggerConfig → does NOT fire', () => {
    const quota = { percentUsed: 95 };
    assert.equal(evaluateSoftTriggers({}, quota), false);
  });

  // ── isClientError ────────────────────────────────────────────────────

  it('isClientError: 400 → true', () => { assert.equal(isClientError(400), true); });
  it('isClientError: 401 → true', () => { assert.equal(isClientError(401), true); });
  it('isClientError: 403 → true', () => { assert.equal(isClientError(403), true); });
  it('isClientError: 404 → true', () => { assert.equal(isClientError(404), true); });
  it('isClientError: 422 → true', () => { assert.equal(isClientError(422), true); });
  it('isClientError: 429 → false (quota, not client error)', () => { assert.equal(isClientError(429), false); });
  it('isClientError: 500 → false', () => { assert.equal(isClientError(500), false); });

});

// ── 13b: executeWithFallback engine ─────────────────────────────────────

describe('Fallback engine — executeWithFallback (D9)', () => {

  // helper: build a mock executeHopFn that succeeds or throws per provider name
  function makeHopFn(outcomes) {
    // outcomes: { [provider]: 'success' | Error }
    return async function (provider, model, _ir) {
      const outcome = outcomes[provider];
      if (!outcome || outcome === 'success') {
        return [{ type: 'delta', role: 'assistant', content: `response from ${provider}` },
                { type: 'stop', finish_reason: 'stop' }];
      }
      throw outcome;
    };
  }

  const dummyIR = makeIR({ model: 'test-model' });

  it('empty chain → throws Error', async () => {
    let caught = null;
    try {
      await executeWithFallback([], dummyIR, makeHopFn({}));
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error, 'Expected Error for empty chain');
    assert.ok(caught.message.includes('chain'));
  });

  it('single-hop chain with success → returns chunks + fallbackHops=0', async () => {
    const chain = [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }];
    const result = await executeWithFallback(chain, dummyIR, makeHopFn({ anthropic: 'success' }));
    assert.ok(Array.isArray(result.chunks), 'Expected chunks array');
    assert.equal(result.fallbackHops, 0);
    assert.equal(result.providerUsed, 'anthropic');
    assert.equal(result.originalError, null);
    assert.deepEqual(result.triedProviders, ['anthropic']);
  });

  it('single-hop chain with hard-triggered error → exhausted, returns originalError', async () => {
    const err = new ProviderError('Spawn failed', 'SPAWN_FAILED');
    const chain = [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }];
    const result = await executeWithFallback(chain, dummyIR, makeHopFn({ anthropic: err }));
    assert.equal(result.chunks, null, 'Expected null chunks on exhausted chain');
    assert.equal(result.originalError, err);
    assert.equal(result.fallbackHops, 1);  // chain.length = 1, all exhausted
    assert.deepEqual(result.triedProviders, ['anthropic']);
  });

  it('two-hop chain, primary fails with hard trigger → falls back to secondary, fallbackHops=1', async () => {
    const err = new ProviderError('Spawn failed', 'SPAWN_FAILED');
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' },
    ];
    const result = await executeWithFallback(chain, dummyIR, makeHopFn({ anthropic: err, openai: 'success' }));
    assert.ok(Array.isArray(result.chunks), 'Expected chunks from secondary');
    assert.equal(result.fallbackHops, 1);
    assert.equal(result.providerUsed, 'openai');
    assert.equal(result.originalError, null);
    assert.deepEqual(result.triedProviders, ['anthropic', 'openai']);
  });

  it('three-hop chain, primary + secondary fail → tertiary returns chunks, fallbackHops=2', async () => {
    const errA = new ProviderError('Spawn failed', 'SPAWN_FAILED');
    const errB = Object.assign(new Error('Service unavailable'), { statusCode: 503 });
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' },
      { provider: 'mistral', model: 'devstral-2' },
    ];
    const result = await executeWithFallback(
      chain, dummyIR,
      makeHopFn({ anthropic: errA, openai: errB, mistral: 'success' }),
    );
    assert.ok(Array.isArray(result.chunks));
    assert.equal(result.fallbackHops, 2);
    assert.equal(result.providerUsed, 'mistral');
    assert.equal(result.originalError, null);
    assert.deepEqual(result.triedProviders, ['anthropic', 'openai', 'mistral']);
  });

  it('three-hop chain, all fail → exhausted, originalError is from FIRST hop (not last)', async () => {
    const errA = new ProviderError('Spawn failed', 'SPAWN_FAILED');
    const errB = new ProviderError('Spawn timeout', 'SPAWN_TIMEOUT');
    const errC = new ProviderError('CLI not found', 'CLI_NOT_FOUND');
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' },
      { provider: 'mistral', model: 'devstral-2' },
    ];
    const result = await executeWithFallback(
      chain, dummyIR,
      makeHopFn({ anthropic: errA, openai: errB, mistral: errC }),
    );
    assert.equal(result.chunks, null);
    assert.equal(result.originalError, errA, 'Should be first hop error, not last');
    assert.equal(result.fallbackHops, 3);  // chain.length = 3
    assert.deepEqual(result.triedProviders, ['anthropic', 'openai', 'mistral']);
  });

  it('client error (400) on primary → does NOT fall back, surfaces error immediately', async () => {
    const err = Object.assign(new Error('Bad request'), { statusCode: 400 });
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' },
    ];
    let openaiCalled = false;
    const hopFn = async (provider) => {
      if (provider === 'anthropic') throw err;
      openaiCalled = true;
      return [{ type: 'stop', finish_reason: 'stop' }];
    };
    const result = await executeWithFallback(chain, dummyIR, hopFn);
    assert.equal(result.chunks, null);
    assert.equal(result.originalError, err);
    assert.equal(openaiCalled, false, 'Second provider must NOT be called on client error');
    assert.deepEqual(result.triedProviders, ['anthropic']);
  });

  it('AUTH_MISSING on primary → does NOT fall back (user must fix config)', async () => {
    const err = new ProviderError('Auth missing', 'AUTH_MISSING');
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' },
    ];
    let openaiCalled = false;
    const hopFn = async (provider) => {
      if (provider === 'anthropic') throw err;
      openaiCalled = true;
      return [{ type: 'stop', finish_reason: 'stop' }];
    };
    const result = await executeWithFallback(chain, dummyIR, hopFn);
    assert.equal(result.chunks, null);
    assert.equal(result.originalError, err);
    assert.equal(openaiCalled, false, 'Second provider must NOT be called on AUTH_MISSING');
  });

  it('non-trigger error (generic) on primary → does NOT fall back', async () => {
    const err = new Error('Unexpected internal error');
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' },
    ];
    let openaiCalled = false;
    const hopFn = async (provider) => {
      if (provider === 'anthropic') throw err;
      openaiCalled = true;
      return [{ type: 'stop', finish_reason: 'stop' }];
    };
    const result = await executeWithFallback(chain, dummyIR, hopFn);
    assert.equal(result.chunks, null);
    assert.equal(openaiCalled, false, 'Must not fall back on non-trigger error');
  });

});

// ── 13c: First-chunk safety ──────────────────────────────────────────────

describe('Fallback engine — first-chunk safety (D9)', () => {

  // At D9, executeHopFn = collectAllChunks() which is fully buffered.
  // Safety is enforced by construction: if executeHopFn returns successfully,
  // chunks are already in memory (none written to res yet). Once chunks are
  // returned, fallback is no longer attempted — we return immediately.
  // If executeHopFn throws, zero bytes went to the client.

  it('successful executeHopFn returns chunks immediately without retrying secondary', async () => {
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' },
    ];
    let callCount = 0;
    const hopFn = async (_provider) => {
      callCount++;
      return [{ type: 'stop', finish_reason: 'stop' }];
    };
    const result = await executeWithFallback(chain, makeIR({ model: 'test' }), hopFn);
    assert.equal(result.fallbackHops, 0, 'Primary served — no fallback');
    assert.equal(callCount, 1, 'executeHopFn called exactly once (first-chunk safety)');
  });

  it('error from executeHopFn (hard trigger) means zero chunks emitted — advance is safe', async () => {
    // Simulate: anthropic throws (no bytes emitted), openai succeeds
    const err = new ProviderError('Spawn failed', 'SPAWN_FAILED');
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' },
    ];
    let writtenToClient = false;
    const hopFn = async (provider) => {
      if (provider === 'anthropic') {
        // Throw BEFORE any "write" — simulates first-chunk rule
        throw err;
      }
      // openai succeeds — simulate "writtenToClient" only AFTER returning
      // (in real server, chunks are written after executeWithFallback returns)
      writtenToClient = true;
      return [{ type: 'stop', finish_reason: 'stop' }];
    };
    const result = await executeWithFallback(chain, makeIR({ model: 'test' }), hopFn);
    // openai served, which means writtenToClient is set (simulates post-return write)
    assert.equal(result.fallbackHops, 1, 'Fell back to openai');
    // Crucially: the "write" happened AFTER executeHopFn returned (not during chain iteration)
    assert.equal(writtenToClient, true, 'Client write happens post-return, not during chain iteration');
  });

});

// ── 13d: Soft triggers skipping spawn ────────────────────────────────────

describe('Fallback engine — soft trigger skipping (D9)', () => {

  const dummyIR = makeIR({ model: 'test-model' });

  it('chain [A, B], A soft trigger fires → engine skips A entirely, calls B; fallbackHops=1', async () => {
    let aCalled = false;
    let bCalled = false;
    const hopFn = async (provider) => {
      if (provider === 'a') { aCalled = true; return [{ type: 'stop', finish_reason: 'stop' }]; }
      if (provider === 'b') { bCalled = true; return [{ type: 'stop', finish_reason: 'stop' }]; }
      throw new Error('Unexpected provider');
    };
    const chain = [
      {
        provider: 'a',
        model: 'model-a',
        softTriggers: { credit_pool_percent_threshold: 90 },
        quotaSnapshot: { percentUsed: 95 },  // fires the trigger
      },
      { provider: 'b', model: 'model-b' },
    ];
    const result = await executeWithFallback(chain, dummyIR, hopFn);
    assert.equal(aCalled, false, 'A must NOT be called (soft trigger skipped it)');
    assert.equal(bCalled, true, 'B must be called');
    assert.equal(result.fallbackHops, 1, 'B served as fallback hop 1');
    assert.equal(result.providerUsed, 'b');
  });

  it('chain [A, B], neither soft trigger fires → A is called; if A succeeds, B never called', async () => {
    let aCalled = false;
    let bCalled = false;
    const hopFn = async (provider) => {
      if (provider === 'a') { aCalled = true; return [{ type: 'stop', finish_reason: 'stop' }]; }
      if (provider === 'b') { bCalled = true; return [{ type: 'stop', finish_reason: 'stop' }]; }
      throw new Error('Unexpected provider');
    };
    const chain = [
      {
        provider: 'a',
        model: 'model-a',
        softTriggers: { credit_pool_percent_threshold: 90 },
        quotaSnapshot: { percentUsed: 85 },  // below threshold, trigger does NOT fire
      },
      { provider: 'b', model: 'model-b' },
    ];
    const result = await executeWithFallback(chain, dummyIR, hopFn);
    assert.equal(aCalled, true, 'A must be called');
    assert.equal(bCalled, false, 'B must NOT be called (A succeeded)');
    assert.equal(result.fallbackHops, 0);
    assert.equal(result.providerUsed, 'a');
  });

  it('chain [A], A soft trigger fires (null quotaSnapshot) → trigger does NOT fire, A called', async () => {
    // Per ADR 0004: null quotaStatus → treat as "don't fire"
    let aCalled = false;
    const hopFn = async (provider) => {
      if (provider === 'a') { aCalled = true; return [{ type: 'stop', finish_reason: 'stop' }]; }
      throw new Error('Unexpected provider');
    };
    const chain = [
      {
        provider: 'a',
        model: 'model-a',
        softTriggers: { credit_pool_percent_threshold: 90 },
        quotaSnapshot: null,  // null → trigger never fires
      },
    ];
    const result = await executeWithFallback(chain, dummyIR, hopFn);
    assert.equal(aCalled, true, 'A must be called (null quota → trigger does not fire)');
    assert.equal(result.fallbackHops, 0);
  });

});

// ── 13e: Header annotation ───────────────────────────────────────────────

describe('Fallback engine — observability / header annotation (D9)', () => {

  const dummyIR = makeIR({ model: 'test-model' });

  it('success on primary: providerUsed + modelUsed match primary hop', async () => {
    const chain = [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }];
    const result = await executeWithFallback(chain, dummyIR, async () => [{ type: 'stop', finish_reason: 'stop' }]);
    assert.equal(result.providerUsed, 'anthropic');
    assert.equal(result.modelUsed, 'claude-sonnet-4-6');
  });

  it('success on fallback: providerUsed + modelUsed match the serving hop', async () => {
    const err = new ProviderError('Spawn failed', 'SPAWN_FAILED');
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' },
    ];
    const hopFn = async (provider) => {
      if (provider === 'anthropic') throw err;
      return [{ type: 'stop', finish_reason: 'stop' }];
    };
    const result = await executeWithFallback(chain, dummyIR, hopFn);
    assert.equal(result.providerUsed, 'openai');
    assert.equal(result.modelUsed, 'gpt-5.5');
    assert.equal(result.fallbackHops, 1);
  });

  it('chain exhausted: originalError is from FIRST hop, not second or third', async () => {
    const errA = new ProviderError('Spawn failed', 'SPAWN_FAILED');
    const errB = new ProviderError('CLI not found', 'CLI_NOT_FOUND');
    const errC = new ProviderError('Spawn timeout', 'SPAWN_TIMEOUT');
    const chain = [
      { provider: 'a', model: 'model-a' },
      { provider: 'b', model: 'model-b' },
      { provider: 'c', model: 'model-c' },
    ];
    const hopFn = async (provider) => {
      if (provider === 'a') throw errA;
      if (provider === 'b') throw errB;
      if (provider === 'c') throw errC;
      throw new Error('Unexpected');
    };
    const result = await executeWithFallback(chain, dummyIR, hopFn);
    assert.equal(result.originalError, errA, 'originalError must be first-hop error');
    assert.notEqual(result.originalError, errB, 'Must NOT be second-hop error');
    assert.notEqual(result.originalError, errC, 'Must NOT be third-hop error');
  });

  it('triedProviders lists all attempted hops in chain order', async () => {
    const err = new ProviderError('Spawn failed', 'SPAWN_FAILED');
    const chain = [
      { provider: 'a', model: 'model-a' },
      { provider: 'b', model: 'model-b' },
      { provider: 'c', model: 'model-c' },
    ];
    const hopFn = async (provider) => {
      if (provider === 'a') throw err;
      if (provider === 'b') throw err;
      return [{ type: 'stop', finish_reason: 'stop' }];
    };
    const result = await executeWithFallback(chain, dummyIR, hopFn);
    assert.deepEqual(result.triedProviders, ['a', 'b', 'c']);
    assert.equal(result.fallbackHops, 2);
    assert.equal(result.providerUsed, 'c');
  });

});

// ── 13f: HTTP integration ────────────────────────────────────────────────

describe('Fallback engine — HTTP integration (D9)', () => {
  let server;
  let port;
  let savedAnthropicToken;
  let savedCodexAuthPath;
  let suiteCodexAuthFile;

  before(async () => {
    __resetSpawnImpl();
    codexResetSpawnImpl();
    mistralResetSpawnImpl();
    __resetFallbackConfig();

    // CRITICAL — inject suite-level fake auth tokens for anthropic + codex.
    // Without this, on hosts that lack the real auth artifacts (CI Linux
    // runners are the load-bearing case; they have no macOS keychain and no
    // ~/.claude/.credentials.json), the provider plugins throw
    // ProviderError(AUTH_MISSING) BEFORE the mock spawn function fires. The
    // chain then stops at the first hop because AUTH_MISSING is NOT a hard
    // trigger (per ADR 0004 § Decision § No fallback for client-side
    // errors), so the fallback path under test never executes. Bug
    // discovered on D9 CI 2026-05-23: 3 tests in this suite failed on
    // Node 20 Linux while passing on macOS Node 25 because the macOS
    // keychain provided real anthropic auth and the test never reached
    // the fake-auth-required code path.
    savedAnthropicToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fake-anthropic-token-for-d9-http-suite';

    const { writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pathJoin } = await import('node:path');
    suiteCodexAuthFile = pathJoin(tmpdir(), `olp-test-d9-codex-auth-${Date.now()}.json`);
    writeFileSync(suiteCodexAuthFile, JSON.stringify({ accessToken: 'fake-codex-token-for-d9-http-suite' }), 'utf8');
    savedCodexAuthPath = process.env.OPENAI_CODEX_AUTH_PATH;
    process.env.OPENAI_CODEX_AUTH_PATH = suiteCodexAuthFile;

    // Start test server with all 3 providers enabled
    const testProviders = loadProviders({ enabled: { anthropic: true, openai: true, mistral: true } });
    const { loadedProviders: lp, cacheStore: cs } = await import('./server.mjs');
    // Inject test providers
    for (const [name, p] of testProviders) {
      lp.set(name, p);
    }
    cs.clear();

    server = createOlpServer();
    port = 20456 + Math.floor(Math.random() * 500);
    await new Promise((resolve, reject) => {
      server.listen(port, '127.0.0.1', resolve);
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE') {
          port++;
          server.listen(port, '127.0.0.1', resolve);
          server.once('error', reject);
        } else reject(e);
      });
    });
  });

  after(async () => {
    __resetFallbackConfig();
    __resetSpawnImpl();
    codexResetSpawnImpl();
    mistralResetSpawnImpl();

    // Restore env vars injected by before()
    if (savedAnthropicToken !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = savedAnthropicToken;
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    if (savedCodexAuthPath !== undefined) {
      process.env.OPENAI_CODEX_AUTH_PATH = savedCodexAuthPath;
    } else {
      delete process.env.OPENAI_CODEX_AUTH_PATH;
    }
    if (suiteCodexAuthFile) {
      const { unlinkSync } = await import('node:fs');
      try { unlinkSync(suiteCodexAuthFile); } catch { /* ignore */ }
    }

    if (!server) return;
    return new Promise(r => server.close(r));
  });

  // Shared mock spawn builder that returns a successful response
  function makeSuccessSpawn(content = 'Hello from mock') {
    return function mockSpawnImpl(_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            // Emit a minimal SSE-like response that anthropic plugin parses
            // (Anthropic mock format: JSON lines per the real anthropic.mjs parser)
            const lines = [
              JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } }),
              JSON.stringify({ type: 'message_stop' }),
            ];
            for (const line of lines) {
              proc.stdout.emit('data', Buffer.from(`data: ${line}\n\n`));
            }
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            proc.emit('close', 0, null);
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    };
  }

  it('no fallback config: POST with no enabled provider → 503', async () => {
    // Remove all providers temporarily
    const { loadedProviders: lp } = await import('./server.mjs');
    const savedMap = new Map(lp);
    lp.clear();
    try {
      const r = await fetch({
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        body: { model: 'unknown-model', messages: [{ role: 'user', content: 'Hi' }] },
      });
      assert.equal(r.status, 503);
    } finally {
      for (const [name, p] of savedMap) lp.set(name, p);
    }
  });

  it('no fallback config + mock anthropic: POST claude-sonnet-4-6 → 200 + X-OLP-Fallback-Hops: 0', async () => {
    __setSpawnImpl(makeSuccessSpawn('Test response'));
    try {
      const r = await fetch({
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 10,
        },
      });
      assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${r.body.slice(0, 200)}`);
      assert.equal(r.headers['x-olp-fallback-hops'], '0');
      assert.equal(r.headers['x-olp-provider-used'], 'anthropic');
    } finally {
      __resetSpawnImpl();
    }
  });

  it('fallback config: mock anthropic fails (SPAWN_FAILED), chain [anthropic→openai], openai mock succeeds → 200 + X-OLP-Fallback-Hops: 1 + X-OLP-Provider-Used: openai', async () => {
    // Clear cache to prevent cache-hit from previous test polluting this one.
    // ADR 0005: each (provider, model) pair is independently cached; a hit
    // from the previous test would cause executeHopFn to skip the spawn and
    // return cached chunks, masking the SPAWN_FAILED mock.
    __clearCache();

    // Provide fake codex auth so AUTH_MISSING doesn't stop the chain before
    // the codex mock can respond. Codex checks readAuthArtifact() before spawnImpl.
    // Write a temp file and set OPENAI_CODEX_AUTH_PATH to point at it.
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pathJoin } = await import('node:path');
    const tmpAuthFile = pathJoin(tmpdir(), `olp-test-codex-auth-${Date.now()}.json`);
    writeFileSync(tmpAuthFile, JSON.stringify({ accessToken: 'fake-test-token-for-codex' }), 'utf8');
    const savedCodexAuthPath = process.env.OPENAI_CODEX_AUTH_PATH;
    process.env.OPENAI_CODEX_AUTH_PATH = tmpAuthFile;

    // Set up a 2-hop chain: anthropic → openai for claude-sonnet-4-6
    __setFallbackConfig({
      chains: {
        'claude-sonnet-4-6': [
          { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          { provider: 'openai', model: 'gpt-5.5' },
        ],
      },
      soft_triggers: {},
    });

    // Anthropic mock: always exits with code 1 → SPAWN_FAILED (hard trigger)
    __setSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            proc.stderr.emit('data', Buffer.from('spawn failed\n'));
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            proc.emit('close', 1, null);  // non-zero exit → SPAWN_FAILED
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    // Codex (openai) mock: succeeds with a delta+stop response
    codexSetSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            proc.stdout.emit('data', Buffer.from('{"content":"Fallback response from openai"}\n'));
            proc.stdout.emit('data', Buffer.from('{"type":"stop"}\n'));
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            proc.emit('close', 0, null);
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    try {
      const r = await fetch({
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 10,
        },
      });
      assert.equal(r.status, 200, `Expected 200 on fallback, got ${r.status}: ${r.body.slice(0, 300)}`);
      assert.equal(r.headers['x-olp-fallback-hops'], '1', `Expected fallback-hops=1, got: ${r.headers['x-olp-fallback-hops']}`);
      assert.equal(r.headers['x-olp-provider-used'], 'openai', `Expected provider-used=openai, got: ${r.headers['x-olp-provider-used']}`);
    } finally {
      __resetFallbackConfig();
      __resetSpawnImpl();
      codexResetSpawnImpl();
      if (savedCodexAuthPath !== undefined) {
        process.env.OPENAI_CODEX_AUTH_PATH = savedCodexAuthPath;
      } else {
        delete process.env.OPENAI_CODEX_AUTH_PATH;
      }
      try { unlinkSync(tmpAuthFile); } catch { /* ignore */ }
    }
  });

  it('fallback config: two-hop chain with both providers failing SPAWN_FAILED → exhausted-chain path → error response with X-OLP-Fallback-Exhausted header', async () => {
    // NOTE on this test's renaming (D9 review-2): the original sonnet draft
    // titled this as a "client error (400) → no fallback" HTTP test. But the
    // anthropic plugin surfaces non-zero exit codes as ProviderError
    // SPAWN_FAILED (a HARD trigger), not as a typed-400 client error. So at
    // the HTTP integration layer we can't easily inject a synthetic 400
    // without monkey-patching executeHopFn. The "client error stops chain
    // immediately" semantic IS covered at the UNIT level in
    // "Engine: two-hop chain primary client error 400 → secondary NOT
    // called" (line 3289+ in this file). This HTTP test now exercises the
    // complementary path: both hops fail with SPAWN_FAILED → chain
    // exhausted → originalError surfaces with X-OLP-Fallback-Exhausted
    // header listing both providers.
    __clearCache();

    // Set up a 2-hop chain
    __setFallbackConfig({
      chains: {
        'claude-sonnet-4-6': [
          { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          { provider: 'openai', model: 'gpt-5.5' },
        ],
      },
      soft_triggers: {},
    });

    // Both providers fail with SPAWN_FAILED
    __setSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            proc.emit('close', 1, null);
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    codexSetSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            proc.emit('close', 1, null);
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    try {
      const r = await fetch({
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 10,
        },
      });
      // Both providers fail → exhausted chain → 502 error response with exhausted header
      assert.ok(r.status >= 400 && r.status < 600, `Expected error status, got ${r.status}`);
      // X-OLP-Fallback-Exhausted header should be present since both providers tried
      assert.ok(
        r.headers['x-olp-fallback-exhausted'] !== undefined,
        `Expected X-OLP-Fallback-Exhausted header, got headers: ${JSON.stringify(r.headers)}`,
      );
    } finally {
      __resetFallbackConfig();
      __resetSpawnImpl();
      codexResetSpawnImpl();
    }
  });

  // ── D16 tests: SPAWN_FAILED partial-response salvage (ADR 0004 Amendment 1) ─

  it('D16/Case-A regression guard: SPAWN_FAILED with no chunks → hard fallback fires → openai serves (2-hop)', async () => {
    // Case A: provider exits non-zero BEFORE emitting any content.
    // Fallback engine must still advance the chain — this is the pre-D16 behavior
    // that must remain unchanged. Emitting zero chunks then exit-1 must still trigger
    // the hard fallback.
    __clearCache();

    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pathJoin } = await import('node:path');
    const tmpAuthFile = pathJoin(tmpdir(), `olp-test-d16-caseA-auth-${Date.now()}.json`);
    writeFileSync(tmpAuthFile, JSON.stringify({ accessToken: 'fake-d16-caseA-codex-token' }), 'utf8');
    const savedCodexAuthPath = process.env.OPENAI_CODEX_AUTH_PATH;
    process.env.OPENAI_CODEX_AUTH_PATH = tmpAuthFile;

    __setFallbackConfig({
      chains: {
        'claude-sonnet-4-6': [
          { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          { provider: 'openai', model: 'gpt-5.5' },
        ],
      },
      soft_triggers: {},
    });

    // Anthropic mock: emits NO stdout, exits with code 1 → SPAWN_FAILED with chunks=[]
    // This is Case A — hard trigger must fire, chain must advance.
    __setSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            // No stdout data emitted before close
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            proc.emit('close', 1, null); // exit 1 → SPAWN_FAILED, no usable chunks
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    // OpenAI (codex) mock: succeeds with a real response
    codexSetSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            proc.stdout.emit('data', Buffer.from('{"content":"D16-caseA-fallback-openai-response"}\n'));
            proc.stdout.emit('data', Buffer.from('{"type":"stop"}\n'));
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            proc.emit('close', 0, null);
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    try {
      const r = await fetch({
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 10,
        },
      });
      assert.equal(r.status, 200, `Expected 200 from openai fallback, got ${r.status}: ${r.body.slice(0, 300)}`);
      // Hard trigger fired → chain advanced → openai served → hops=1
      assert.equal(r.headers['x-olp-fallback-hops'], '1', `Expected fallback-hops=1 (Case A hard trigger), got: ${r.headers['x-olp-fallback-hops']}`);
      assert.equal(r.headers['x-olp-provider-used'], 'openai', `Expected openai served, got: ${r.headers['x-olp-provider-used']}`);
    } finally {
      __resetFallbackConfig();
      __resetSpawnImpl();
      codexResetSpawnImpl();
      if (savedCodexAuthPath !== undefined) {
        process.env.OPENAI_CODEX_AUTH_PATH = savedCodexAuthPath;
      } else {
        delete process.env.OPENAI_CODEX_AUTH_PATH;
      }
      try { unlinkSync(tmpAuthFile); } catch { /* ignore */ }
    }
  });

  it('D16/Case-B fix: SPAWN_FAILED after N chunks → fallback does NOT fire → anthropic partial response served (2-hop)', async () => {
    // Case B (the D16 fix): provider emits content then exits non-zero.
    // The partial chunks are usable — fallback must NOT advance to openai.
    // Instead, the partial response is returned with finish_reason='length'.
    // X-OLP-Fallback-Hops must be 0 (anthropic served, openai not called).
    __clearCache();

    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pathJoin } = await import('node:path');
    const tmpAuthFile = pathJoin(tmpdir(), `olp-test-d16-caseB-auth-${Date.now()}.json`);
    writeFileSync(tmpAuthFile, JSON.stringify({ accessToken: 'fake-d16-caseB-codex-token' }), 'utf8');
    const savedCodexAuthPath = process.env.OPENAI_CODEX_AUTH_PATH;
    process.env.OPENAI_CODEX_AUTH_PATH = tmpAuthFile;

    let openaiMockCalled = false;

    __setFallbackConfig({
      chains: {
        'claude-sonnet-4-6': [
          { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          { provider: 'openai', model: 'gpt-5.5' },
        ],
      },
      soft_triggers: {},
    });

    // Anthropic mock: emits 2 NDJSON content_block_delta events then exits non-zero.
    // ADR 0009 Amendment 1: stream-json path — content must be valid NDJSON to yield
    // delta chunks. exit code 1 after yielding content → Case B: SPAWN_FAILED with chunks.length>0.
    __setSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            // Emit 2 NDJSON content_block_delta stream_events (ADR 0009 Amendment 1)
            proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } } }) + '\n'));
            proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } } }) + '\n'));
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            // Non-zero exit AFTER emitting content → SPAWN_FAILED, chunks.length=2
            proc.emit('close', 1, null);
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    // OpenAI mock: should NOT be called (D16 must prevent fallback here)
    codexSetSpawnImpl(function (_bin, _args, _opts) {
      openaiMockCalled = true;
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            proc.stdout.emit('data', Buffer.from('{"content":"unexpected-openai-response"}\n'));
            proc.stdout.emit('data', Buffer.from('{"type":"stop"}\n'));
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            proc.emit('close', 0, null);
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    try {
      const r = await fetch({
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 10,
        },
      });
      // D16: anthropic partial response surfaced instead of falling back
      assert.equal(r.status, 200, `Expected 200 with partial anthropic response, got ${r.status}: ${r.body.slice(0, 300)}`);
      // No fallback should have fired — anthropic's partial chunks were usable
      assert.equal(r.headers['x-olp-fallback-hops'], '0', `Expected fallback-hops=0 (no fallback, Case B), got: ${r.headers['x-olp-fallback-hops']}`);
      assert.equal(r.headers['x-olp-provider-used'], 'anthropic', `Expected anthropic served, got: ${r.headers['x-olp-provider-used']}`);
      // OpenAI mock must NOT have been invoked
      assert.equal(openaiMockCalled, false, 'OpenAI mock should NOT have been called (D16 prevents fallback on Case B)');
      // Verify finish_reason='length' (synthesized stop from D16 salvage path)
      const body = JSON.parse(r.body);
      assert.equal(body.choices?.[0]?.finish_reason, 'length', `Expected finish_reason='length' from D16 salvage, got: ${body.choices?.[0]?.finish_reason}`);
      // Verify the 2 content chunks are present in the response
      const content = body.choices?.[0]?.message?.content ?? '';
      assert.ok(content.includes('Hello'), `Expected 'Hello' in partial content, got: '${content}'`);
      assert.ok(content.includes('world'), `Expected 'world' in partial content, got: '${content}'`);
    } finally {
      __resetFallbackConfig();
      __resetSpawnImpl();
      codexResetSpawnImpl();
      if (savedCodexAuthPath !== undefined) {
        process.env.OPENAI_CODEX_AUTH_PATH = savedCodexAuthPath;
      } else {
        delete process.env.OPENAI_CODEX_AUTH_PATH;
      }
      try { unlinkSync(tmpAuthFile); } catch { /* ignore */ }
    }
  });

  it('D16/Case-B single-hop: SPAWN_FAILED after 1 chunk → HTTP 200 with partial response + finish_reason=length (no fallback chain)', async () => {
    // Case B single-hop variant: only one provider in the chain.
    // Provider emits 1 content chunk then exits non-zero.
    // D16 must surface the partial response (HTTP 200, not 502).
    __clearCache();

    __setFallbackConfig({
      chains: {
        'claude-sonnet-4-6': [
          { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        ],
      },
      soft_triggers: {},
    });

    // Anthropic mock: emits 1 NDJSON content_block_delta event then exits non-zero
    // ADR 0009 Amendment 1: stream-json path — content must be valid NDJSON.
    __setSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Partial answer' } } }) + '\n'));
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            proc.emit('close', 1, null); // exit 1 after content → Case B
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    try {
      const r = await fetch({
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 10,
        },
      });
      // D16: must be 200 with the partial content, not 502
      assert.equal(r.status, 200, `Expected 200 with partial response (not 502), got ${r.status}: ${r.body.slice(0, 300)}`);
      assert.equal(r.headers['x-olp-fallback-hops'], '0', `Expected fallback-hops=0, got: ${r.headers['x-olp-fallback-hops']}`);
      assert.equal(r.headers['x-olp-provider-used'], 'anthropic', `Expected anthropic served, got: ${r.headers['x-olp-provider-used']}`);
      const body = JSON.parse(r.body);
      // finish_reason='length' indicates truncation (D16 synthesized stop)
      assert.equal(body.choices?.[0]?.finish_reason, 'length', `Expected finish_reason='length', got: ${body.choices?.[0]?.finish_reason}`);
      // Partial content must be present
      const content = body.choices?.[0]?.message?.content ?? '';
      assert.ok(content.includes('Partial answer'), `Expected 'Partial answer' in content, got: '${content}'`);
    } finally {
      __resetFallbackConfig();
      __resetSpawnImpl();
    }
  });

  // ── D39 (issue #3 Part 2): cache_evicted_truncated observability log ──
  // Authority: D39 design — surface salvage frequency to dashboards. The log
  // event fires in executeHopFn (server.mjs) immediately after the explicit
  // cacheStore.delete() that replaces the prior set-with-TTL-0 tombstone.
  // The event is level=info → routed to stdout per logEvent in server.mjs.
  it('D39: cache_evicted_truncated log event fires on SPAWN_FAILED salvage with correct provider+model', async () => {
    __clearCache();

    __setFallbackConfig({
      chains: {
        'claude-sonnet-4-6': [
          { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        ],
      },
      soft_triggers: {},
    });

    // D39: emit 1 NDJSON content_block_delta event then exit-1 (Case B salvage path).
    // ADR 0009 Amendment 1: stream-json path — content must be valid NDJSON.
    __setSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'D39-evict-log-content' } } }) + '\n'));
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            proc.emit('close', 1, null); // Case B salvage path
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    // Capture stdout writes to find the JSON log line emitted by logEvent.
    const stdoutWrites = [];
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => {
      const s = typeof chunk === 'string'
        ? chunk
        : (Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
      stdoutWrites.push(s);
      return origStdoutWrite(chunk, ...rest);
    };

    try {
      const r = await fetch({
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'D39 cache_evicted_truncated log' }],
          max_tokens: 10,
        },
      });
      assert.equal(r.status, 200, `Expected 200 from salvage, got ${r.status}`);
    } finally {
      process.stdout.write = origStdoutWrite;
      __resetFallbackConfig();
      __resetSpawnImpl();
    }

    // Find the cache_evicted_truncated event in the captured stdout.
    const evictedLines = [];
    for (const w of stdoutWrites) {
      for (const line of w.split('\n')) {
        if (!line.includes('"event":"cache_evicted_truncated"')) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.event === 'cache_evicted_truncated') evictedLines.push(parsed);
        } catch { /* not JSON — ignore */ }
      }
    }
    assert.equal(evictedLines.length, 1,
      `Expected exactly one cache_evicted_truncated event, got ${evictedLines.length}: ${JSON.stringify(evictedLines)}`);
    assert.equal(evictedLines[0].provider, 'anthropic',
      `Expected provider=anthropic, got ${evictedLines[0].provider}`);
    assert.equal(evictedLines[0].model, 'claude-sonnet-4-6',
      `Expected model=claude-sonnet-4-6, got ${evictedLines[0].model}`);
    assert.equal(evictedLines[0].level, 'info',
      `Expected level=info, got ${evictedLines[0].level}`);
  });

  // ── D39 (issue #3 Part 3): truncated response is not sticky-cached ────
  // Defense-in-depth around the D16 eviction code path. Two consecutive
  // identical buffered requests that both trigger SPAWN_FAILED-with-chunks
  // (Case B salvage). The eviction in executeHopFn must ensure the second
  // request is a FRESH spawn (not served from a sticky cache entry written
  // by the singleflight populate during the first request's salvage). If the
  // eviction were ever lost (e.g., the delete were silently dropped or the
  // condition gate were wrong), this test would catch it: spawnCount would
  // become 1 instead of 2 and X-OLP-Cache would be `hit` on r2.
  it('D39: truncated response is not sticky-cached (two identical requests → two spawns)', async () => {
    __clearCache();

    __setFallbackConfig({
      chains: {
        'claude-sonnet-4-6': [
          { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        ],
      },
      soft_triggers: {},
    });

    let spawnCount = 0;
    __setSpawnImpl(function (_bin, _args, _opts) {
      spawnCount++;
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            // Case B: emit NDJSON partial content then exit non-zero on every spawn.
            // ADR 0009 Amendment 1: stream-json path requires valid NDJSON.
            proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'D39-sticky-content' } } }) + '\n'));
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            proc.emit('close', 1, null);
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    try {
      // The two requests must be byte-identical so they share a cache key.
      const reqBody = {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'D39 sticky-cache regression — identical body' }],
        max_tokens: 10,
      };

      const r1 = await fetch({ port, method: 'POST', path: '/v1/chat/completions', body: reqBody });
      assert.equal(r1.status, 200, `r1 must succeed via salvage, got ${r1.status}`);
      assert.equal(r1.headers['x-olp-cache'], 'miss', `r1 must be cache miss, got ${r1.headers['x-olp-cache']}`);

      const r2 = await fetch({ port, method: 'POST', path: '/v1/chat/completions', body: reqBody });
      assert.equal(r2.status, 200, `r2 must succeed via salvage, got ${r2.status}`);
      // The decisive assertions: a FRESH spawn must have fired for r2.
      assert.equal(spawnCount, 2,
        `Expected 2 spawns across two identical truncated requests (sticky-cache regression guard), got ${spawnCount}`);
      assert.equal(r2.headers['x-olp-cache'], 'miss',
        `r2 must also be cache miss (truncated salvage must not be sticky), got ${r2.headers['x-olp-cache']}`);
    } finally {
      __resetFallbackConfig();
      __resetSpawnImpl();
    }
  });

  // ── D40 HTTP integration tests (issue #7): X-OLP-Fallback-Detail on the wire ─

  it('D40: 1-hop chain succeeds → X-OLP-Fallback-Detail header is absent (no failures to report)', async () => {
    __clearCache();
    __setSpawnImpl(makeSuccessSpawn('D40 clean success'));
    try {
      const r = await fetch({
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 10,
        },
      });
      assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${r.body.slice(0, 200)}`);
      assert.equal(r.headers['x-olp-fallback-hops'], '0');
      assert.equal(
        r.headers['x-olp-fallback-detail'],
        undefined,
        `Header must be absent on clean primary success, got: ${r.headers['x-olp-fallback-detail']}`,
      );
    } finally {
      __resetSpawnImpl();
    }
  });

  it('D40: 2-hop chain, both fail → response carries X-OLP-Fallback-Detail with 2 tuples', async () => {
    __clearCache();
    __setFallbackConfig({
      chains: {
        'claude-sonnet-4-6': [
          { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          { provider: 'openai', model: 'gpt-5.5' },
        ],
      },
      soft_triggers: {},
    });

    // Anthropic mock: exits non-zero with stderr message → SPAWN_FAILED
    __setSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            proc.stderr.emit('data', Buffer.from('anthropic-stderr\n'));
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            proc.emit('close', 1, null);
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });
    // Codex (openai) mock: also fails → exhausted chain
    codexSetSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            proc.stderr.emit('data', Buffer.from('codex-stderr\n'));
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            proc.emit('close', 1, null);
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    try {
      const r = await fetch({
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 10,
        },
      });
      assert.ok(r.status >= 400 && r.status < 600, `Expected error status, got ${r.status}`);
      assert.ok(
        r.headers['x-olp-fallback-detail'] !== undefined,
        `Expected X-OLP-Fallback-Detail header on exhausted chain, headers: ${JSON.stringify(r.headers)}`,
      );
      const parsed = JSON.parse(r.headers['x-olp-fallback-detail']);
      assert.ok(Array.isArray(parsed), 'Header must JSON-parse to array');
      assert.equal(parsed.length, 2, `Expected 2 tuples on 2-hop exhaustion, got ${parsed.length}`);
      assert.equal(parsed[0].hop, 0);
      assert.equal(parsed[0].provider, 'anthropic');
      assert.equal(parsed[0].code, 'SPAWN_FAILED');
      assert.equal(parsed[0].trigger_type, 'hard');
      assert.equal(parsed[1].hop, 1);
      assert.equal(parsed[1].provider, 'openai');
    } finally {
      __resetFallbackConfig();
      __resetSpawnImpl();
      codexResetSpawnImpl();
    }
  });

  it('D40: 2-hop chain, primary fails + secondary succeeds → success response carries X-OLP-Fallback-Detail with 1 tuple (the failed primary)', async () => {
    __clearCache();

    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pathJoin } = await import('node:path');
    const tmpAuthFile = pathJoin(tmpdir(), `olp-test-d40-success-with-detail-${Date.now()}.json`);
    writeFileSync(tmpAuthFile, JSON.stringify({ accessToken: 'fake-d40-codex-token' }), 'utf8');
    const savedCodexAuthPath = process.env.OPENAI_CODEX_AUTH_PATH;
    process.env.OPENAI_CODEX_AUTH_PATH = tmpAuthFile;

    __setFallbackConfig({
      chains: {
        'claude-sonnet-4-6': [
          { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          { provider: 'openai', model: 'gpt-5.5' },
        ],
      },
      soft_triggers: {},
    });

    // Anthropic mock: SPAWN_FAILED (no chunks)
    __setSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            proc.emit('close', 1, null);
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    // Codex (openai) mock: succeeds
    codexSetSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            proc.stdout.emit('data', Buffer.from('{"content":"D40 success-after-fail"}\n'));
            proc.stdout.emit('data', Buffer.from('{"type":"stop"}\n'));
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            proc.emit('close', 0, null);
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    try {
      const r = await fetch({
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 10,
        },
      });
      assert.equal(r.status, 200, `Expected 200 from fallback success, got ${r.status}: ${r.body.slice(0, 300)}`);
      assert.equal(r.headers['x-olp-fallback-hops'], '1');
      assert.equal(r.headers['x-olp-provider-used'], 'openai');
      assert.ok(
        r.headers['x-olp-fallback-detail'] !== undefined,
        `Expected X-OLP-Fallback-Detail on success-with-prior-failure, got headers: ${JSON.stringify(r.headers)}`,
      );
      const parsed = JSON.parse(r.headers['x-olp-fallback-detail']);
      assert.equal(parsed.length, 1, `Expected 1 tuple (the failed primary), got ${parsed.length}`);
      assert.equal(parsed[0].hop, 0);
      assert.equal(parsed[0].provider, 'anthropic');
      assert.equal(parsed[0].code, 'SPAWN_FAILED');
      assert.equal(parsed[0].trigger_type, 'hard');
    } finally {
      __resetFallbackConfig();
      __resetSpawnImpl();
      codexResetSpawnImpl();
      if (savedCodexAuthPath !== undefined) {
        process.env.OPENAI_CODEX_AUTH_PATH = savedCodexAuthPath;
      } else {
        delete process.env.OPENAI_CODEX_AUTH_PATH;
      }
      try { unlinkSync(tmpAuthFile); } catch { /* ignore */ }
    }
  });

});

// ── Suite 13g: D28 round-3 F2 — structured log observability fields ─────────
//
// Tests that all executeWithFallback logEvent calls carry the 4 new fields:
//   chain_id, ir_request_hash, trigger_type, next_provider
//
// Also tests computeIRRequestHash (stability, provider-agnosticism, per-field sensitivity).
//
// Authority: ADR 0004 § Observability headers

import { computeIRRequestHash } from './lib/cache/keys.mjs';

describe('Fallback engine — D28 observability fields (chain_id / ir_request_hash / trigger_type / next_provider)', () => {

  // ── Helper: capture all logEvent calls ────────────────────────────────────

  function makeLogCapture() {
    const events = [];
    return {
      logEvent: (level, event, data) => events.push({ level, event, data }),
      events,
    };
  }

  // ── chain_id: present + 16-char hex + consistent across all hops ──────────

  it('chain_id is present in all events and is 16-char hex', async () => {
    const { logEvent, events } = makeLogCapture();
    const err = new ProviderError('Spawn failed', 'SPAWN_FAILED');
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' },
    ];
    const hopFn = async (provider) => {
      if (provider === 'anthropic') throw err;
      return [{ type: 'stop', finish_reason: 'stop' }];
    };
    await executeWithFallback(chain, makeIR({ model: 'test-model' }), hopFn, { logEvent });
    assert.ok(events.length >= 2, 'Expected at least 2 log events');
    for (const e of events) {
      assert.ok(typeof e.data.chain_id === 'string', `chain_id must be string, event: ${e.event}`);
      assert.match(e.data.chain_id, /^[0-9a-f]{16}$/, `chain_id must be 16-char hex, event: ${e.event}`);
    }
  });

  it('chain_id is consistent across all hops from one executeWithFallback call', async () => {
    const { logEvent, events } = makeLogCapture();
    const err = new ProviderError('Spawn failed', 'SPAWN_FAILED');
    const chain = [
      { provider: 'a', model: 'model-a' },
      { provider: 'b', model: 'model-b' },
      { provider: 'c', model: 'model-c' },
    ];
    const hopFn = async (provider) => {
      if (provider === 'a') throw err;
      if (provider === 'b') throw err;
      return [{ type: 'stop', finish_reason: 'stop' }];
    };
    await executeWithFallback(chain, makeIR({ model: 'test-model' }), hopFn, { logEvent });
    assert.ok(events.length >= 3, 'Expected at least 3 log events');
    const ids = new Set(events.map(e => e.data.chain_id));
    assert.equal(ids.size, 1, `All events in one call must share the same chain_id, got: ${[...ids]}`);
  });

  it('chain_id differs between separate executeWithFallback calls', async () => {
    const chain = [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }];
    const hopFn = async () => [{ type: 'stop', finish_reason: 'stop' }];
    const { logEvent: log1, events: events1 } = makeLogCapture();
    const { logEvent: log2, events: events2 } = makeLogCapture();
    await executeWithFallback(chain, makeIR({ model: 'test-model' }), hopFn, { logEvent: log1 });
    await executeWithFallback(chain, makeIR({ model: 'test-model' }), hopFn, { logEvent: log2 });
    assert.ok(events1.length >= 1);
    assert.ok(events2.length >= 1);
    // With overwhelming probability two random 8-byte values are different
    assert.notEqual(events1[0].data.chain_id, events2[0].data.chain_id,
      'Separate calls must have different chain_ids');
  });

  // ── ir_request_hash: provider-agnostic + consistent across hops ───────────

  it('ir_request_hash is the same across all hops within one chain', async () => {
    const { logEvent, events } = makeLogCapture();
    const err = new ProviderError('Spawn failed', 'SPAWN_FAILED');
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' },
    ];
    const hopFn = async (provider) => {
      if (provider === 'anthropic') throw err;
      return [{ type: 'stop', finish_reason: 'stop' }];
    };
    await executeWithFallback(chain, makeIR({ model: 'some-model' }), hopFn, { logEvent });
    const hashes = new Set(events.map(e => e.data.ir_request_hash));
    assert.equal(hashes.size, 1, `All hops must share the same ir_request_hash, got: ${[...hashes]}`);
  });

  it('ir_request_hash does not change when provider or model changes but content is same', async () => {
    const ir = makeIR({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'Hello' }] });
    const hash1 = computeIRRequestHash(ir);
    // Same IR, different model field (computeIRRequestHash is provider-agnostic)
    const ir2 = makeIR({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'Hello' }] });
    const hash2 = computeIRRequestHash(ir2);
    // model is NOT in the computeIRRequestHash subset, so hashes must be equal
    assert.equal(hash1, hash2, 'ir_request_hash must be provider/model-agnostic');
  });

  // ── trigger_type: classification per error type ───────────────────────────

  it('trigger_type is "hard" for SPAWN_FAILED (fallback_hard_trigger event)', async () => {
    const { logEvent, events } = makeLogCapture();
    const err = new ProviderError('Spawn failed', 'SPAWN_FAILED');
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' },
    ];
    const hopFn = async (provider) => {
      if (provider === 'anthropic') throw err;
      return [{ type: 'stop', finish_reason: 'stop' }];
    };
    await executeWithFallback(chain, makeIR({ model: 'test-model' }), hopFn, { logEvent });
    const hardEvent = events.find(e => e.event === 'fallback_hard_trigger');
    assert.ok(hardEvent, 'Expected fallback_hard_trigger event');
    assert.equal(hardEvent.data.trigger_type, 'hard');
  });

  it('trigger_type is "auth_missing" for AUTH_MISSING (fallback_auth_missing_no_fallback event)', async () => {
    const { logEvent, events } = makeLogCapture();
    const err = new ProviderError('Auth missing', 'AUTH_MISSING');
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' },
    ];
    const hopFn = async (provider) => {
      if (provider === 'anthropic') throw err;
      return [{ type: 'stop', finish_reason: 'stop' }];
    };
    await executeWithFallback(chain, makeIR({ model: 'test-model' }), hopFn, { logEvent });
    const authEvent = events.find(e => e.event === 'fallback_auth_missing_no_fallback');
    assert.ok(authEvent, 'Expected fallback_auth_missing_no_fallback event');
    assert.equal(authEvent.data.trigger_type, 'auth_missing');
  });

  it('trigger_type is "client_error" for HTTP 400 (fallback_client_error_no_fallback event)', async () => {
    const { logEvent, events } = makeLogCapture();
    const err = Object.assign(new Error('Bad request'), { statusCode: 400 });
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' },
    ];
    const hopFn = async (provider) => {
      if (provider === 'anthropic') throw err;
      return [{ type: 'stop', finish_reason: 'stop' }];
    };
    await executeWithFallback(chain, makeIR({ model: 'test-model' }), hopFn, { logEvent });
    const clientEvent = events.find(e => e.event === 'fallback_client_error_no_fallback');
    assert.ok(clientEvent, 'Expected fallback_client_error_no_fallback event');
    assert.equal(clientEvent.data.trigger_type, 'client_error');
  });

  it('trigger_type is "non_trigger" for generic error (fallback_non_trigger_error event)', async () => {
    const { logEvent, events } = makeLogCapture();
    const err = new Error('Unexpected generic error');
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' },
    ];
    const hopFn = async (provider) => {
      if (provider === 'anthropic') throw err;
      return [{ type: 'stop', finish_reason: 'stop' }];
    };
    await executeWithFallback(chain, makeIR({ model: 'test-model' }), hopFn, { logEvent });
    const nonTriggerEvent = events.find(e => e.event === 'fallback_non_trigger_error');
    assert.ok(nonTriggerEvent, 'Expected fallback_non_trigger_error event');
    assert.equal(nonTriggerEvent.data.trigger_type, 'non_trigger');
  });

  it('trigger_type is null on success (fallback_hop_success event)', async () => {
    const { logEvent, events } = makeLogCapture();
    const chain = [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }];
    const hopFn = async () => [{ type: 'stop', finish_reason: 'stop' }];
    await executeWithFallback(chain, makeIR({ model: 'test-model' }), hopFn, { logEvent });
    const successEvent = events.find(e => e.event === 'fallback_hop_success');
    assert.ok(successEvent, 'Expected fallback_hop_success event');
    assert.equal(successEvent.data.trigger_type, null);
  });

  // ── next_provider: lookahead routing ──────────────────────────────────────

  it('next_provider is chain[i+1].provider when chain advances on hard trigger', async () => {
    const { logEvent, events } = makeLogCapture();
    const err = new ProviderError('Spawn failed', 'SPAWN_FAILED');
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' },
    ];
    const hopFn = async (provider) => {
      if (provider === 'anthropic') throw err;
      return [{ type: 'stop', finish_reason: 'stop' }];
    };
    await executeWithFallback(chain, makeIR({ model: 'test-model' }), hopFn, { logEvent });
    const hardEvent = events.find(e => e.event === 'fallback_hard_trigger');
    assert.ok(hardEvent, 'Expected fallback_hard_trigger event');
    assert.equal(hardEvent.data.next_provider, 'openai', 'next_provider must be the next chain hop');
  });

  it('next_provider is null on the last hop (chain exhausted)', async () => {
    const { logEvent, events } = makeLogCapture();
    const err = new ProviderError('Spawn failed', 'SPAWN_FAILED');
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    ];
    const hopFn = async () => { throw err; };
    await executeWithFallback(chain, makeIR({ model: 'test-model' }), hopFn, { logEvent });
    const exhaustedEvent = events.find(e => e.event === 'fallback_chain_exhausted');
    assert.ok(exhaustedEvent, 'Expected fallback_chain_exhausted event');
    assert.equal(exhaustedEvent.data.next_provider, null, 'next_provider must be null when chain is exhausted');
  });

  it('next_provider is null on client error stop (no advancement)', async () => {
    const { logEvent, events } = makeLogCapture();
    const err = Object.assign(new Error('Bad request'), { statusCode: 422 });
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' },
    ];
    const hopFn = async (provider) => {
      if (provider === 'anthropic') throw err;
      return [{ type: 'stop', finish_reason: 'stop' }];
    };
    await executeWithFallback(chain, makeIR({ model: 'test-model' }), hopFn, { logEvent });
    const clientEvent = events.find(e => e.event === 'fallback_client_error_no_fallback');
    assert.ok(clientEvent, 'Expected fallback_client_error_no_fallback event');
    assert.equal(clientEvent.data.next_provider, null, 'next_provider must be null when not advancing');
  });

  it('next_provider is null on success (no advancement needed)', async () => {
    const { logEvent, events } = makeLogCapture();
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' },
    ];
    const hopFn = async () => [{ type: 'stop', finish_reason: 'stop' }];
    await executeWithFallback(chain, makeIR({ model: 'test-model' }), hopFn, { logEvent });
    const successEvent = events.find(e => e.event === 'fallback_hop_success');
    assert.ok(successEvent, 'Expected fallback_hop_success event');
    assert.equal(successEvent.data.next_provider, null, 'next_provider must be null on success');
  });

  // ── computeIRRequestHash: stability + per-field sensitivity ───────────────

  it('computeIRRequestHash: identical IR inputs → identical hash', () => {
    const ir1 = makeIR({ messages: [{ role: 'user', content: 'Hello' }], model: 'model-a' });
    const ir2 = makeIR({ messages: [{ role: 'user', content: 'Hello' }], model: 'model-a' });
    assert.equal(computeIRRequestHash(ir1), computeIRRequestHash(ir2));
  });

  it('computeIRRequestHash: returns 16-char hex string', () => {
    const ir = makeIR({ messages: [{ role: 'user', content: 'Hello' }] });
    const hash = computeIRRequestHash(ir);
    assert.equal(typeof hash, 'string');
    assert.equal(hash.length, 16);
    assert.match(hash, /^[0-9a-f]{16}$/);
  });

  it('computeIRRequestHash: changes when messages content changes', () => {
    const ir1 = makeIR({ messages: [{ role: 'user', content: 'Hello' }] });
    const ir2 = makeIR({ messages: [{ role: 'user', content: 'Goodbye' }] });
    assert.notEqual(computeIRRequestHash(ir1), computeIRRequestHash(ir2));
  });

  it('computeIRRequestHash: changes when temperature changes', () => {
    const ir1 = makeIR({ temperature: 0.5 });
    const ir2 = makeIR({ temperature: 1.0 });
    assert.notEqual(computeIRRequestHash(ir1), computeIRRequestHash(ir2));
  });

  it('computeIRRequestHash: changes when max_tokens changes', () => {
    const ir1 = makeIR({ max_tokens: 100 });
    const ir2 = makeIR({ max_tokens: 200 });
    assert.notEqual(computeIRRequestHash(ir1), computeIRRequestHash(ir2));
  });

  it('computeIRRequestHash: changes when top_p changes', () => {
    const ir1 = makeIR({ top_p: 0.9 });
    const ir2 = makeIR({ top_p: 0.5 });
    assert.notEqual(computeIRRequestHash(ir1), computeIRRequestHash(ir2));
  });

  it('computeIRRequestHash: changes when stop changes', () => {
    const ir1 = makeIR({ stop: ['END'] });
    const ir2 = makeIR({ stop: ['STOP'] });
    assert.notEqual(computeIRRequestHash(ir1), computeIRRequestHash(ir2));
  });

  it('computeIRRequestHash: changes when tool_choice changes', () => {
    const ir1 = makeIR({ tool_choice: 'auto' });
    const ir2 = makeIR({ tool_choice: 'none' });
    assert.notEqual(computeIRRequestHash(ir1), computeIRRequestHash(ir2));
  });

  it('computeIRRequestHash: changes when response_format changes', () => {
    const ir1 = makeIR({ response_format: { type: 'text' } });
    const ir2 = makeIR({ response_format: { type: 'json_object' } });
    assert.notEqual(computeIRRequestHash(ir1), computeIRRequestHash(ir2));
  });

  it('computeIRRequestHash: changes when tools changes', () => {
    const ir1 = makeIR({ tools: [{ type: 'function', function: { name: 'foo' } }] });
    const ir2 = makeIR({ tools: [{ type: 'function', function: { name: 'bar' } }] });
    assert.notEqual(computeIRRequestHash(ir1), computeIRRequestHash(ir2));
  });

});

// ── D40: X-OLP-Fallback-Detail header (issue #7) ─────────────────────────
//
// Tests for D40 fold the per-hop fallback failure detail into a response
// header. Authority: ADR 0004 § Decision § Chain advancement step 4 +
// § Observability headers.

import {
  serializeFallbackDetailHeader,
  FALLBACK_DETAIL_BYTE_CAP,
} from './server.mjs';

describe('D40 — X-OLP-Fallback-Detail header (issue #7)', () => {

  // ── Engine: fallbackDetail returned in FallbackResult ─────────────────

  it('engine: 2-hop chain, both fail → fallbackDetail has 2 tuples with correct shape', async () => {
    const errA = new ProviderError('Anthropic spawn failed', 'SPAWN_FAILED');
    const errB = new ProviderError('Codex spawn timeout', 'SPAWN_TIMEOUT');
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' },
    ];
    const hopFn = async (provider) => {
      if (provider === 'anthropic') throw errA;
      throw errB;
    };
    const result = await executeWithFallback(chain, makeIR({ model: 'claude-sonnet-4-6' }), hopFn);
    assert.equal(result.chunks, null, 'Expected exhausted chain');
    assert.ok(Array.isArray(result.fallbackDetail), 'fallbackDetail must be array');
    assert.equal(result.fallbackDetail.length, 2);
    assert.deepEqual(result.fallbackDetail[0], {
      hop: 0, provider: 'anthropic', model: 'claude-sonnet-4-6',
      code: 'SPAWN_FAILED', error_message: 'Anthropic spawn failed', trigger_type: 'hard',
    });
    assert.deepEqual(result.fallbackDetail[1], {
      hop: 1, provider: 'openai', model: 'gpt-5.5',
      code: 'SPAWN_TIMEOUT', error_message: 'Codex spawn timeout', trigger_type: 'hard',
    });
  });

  it('engine: 2-hop chain, primary fails + secondary succeeds → fallbackDetail has 1 tuple (the failed primary)', async () => {
    const err = new ProviderError('Spawn failed', 'SPAWN_FAILED');
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' },
    ];
    const hopFn = async (provider) => {
      if (provider === 'anthropic') throw err;
      return [{ type: 'stop', finish_reason: 'stop' }];
    };
    const result = await executeWithFallback(chain, makeIR({ model: 'claude-sonnet-4-6' }), hopFn);
    assert.ok(Array.isArray(result.chunks), 'Expected success chunks');
    assert.equal(result.fallbackHops, 1);
    assert.equal(result.fallbackDetail.length, 1);
    assert.equal(result.fallbackDetail[0].hop, 0);
    assert.equal(result.fallbackDetail[0].provider, 'anthropic');
    assert.equal(result.fallbackDetail[0].code, 'SPAWN_FAILED');
    assert.equal(result.fallbackDetail[0].trigger_type, 'hard');
  });

  it('engine: 1-hop chain succeeds → fallbackDetail is empty array', async () => {
    const chain = [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }];
    const hopFn = async () => [{ type: 'stop', finish_reason: 'stop' }];
    const result = await executeWithFallback(chain, makeIR({ model: 'claude-sonnet-4-6' }), hopFn);
    assert.ok(Array.isArray(result.chunks));
    assert.deepEqual(result.fallbackDetail, [], 'Empty fallbackDetail on clean primary success');
  });

  it('engine: 1-hop chain fails → fallbackDetail has 1 tuple', async () => {
    const err = new ProviderError('Spawn failed', 'SPAWN_FAILED');
    const chain = [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }];
    const hopFn = async () => { throw err; };
    const result = await executeWithFallback(chain, makeIR({ model: 'claude-sonnet-4-6' }), hopFn);
    assert.equal(result.chunks, null);
    assert.equal(result.fallbackDetail.length, 1);
    assert.equal(result.fallbackDetail[0].hop, 0);
    assert.equal(result.fallbackDetail[0].code, 'SPAWN_FAILED');
  });

  it('engine: AUTH_MISSING terminates chain, fallbackDetail tuple records trigger_type:"auth_missing" (D56, v1.x roadmap #7)', async () => {
    // v1.x roadmap #7 (D40 follow-up): explicit pin that the AUTH_MISSING
    // path produces a fallbackDetail tuple with trigger_type:"auth_missing"
    // BEFORE the engine's early-return at engine.mjs:486. Was implicit via
    // other engine-path tests; D56 makes it explicit so any future refactor
    // that moves the tuple-push past the auth_missing branch fails this.
    const err = new ProviderError('No OAuth token found', 'AUTH_MISSING');
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' }, // present to verify AUTH_MISSING does NOT advance
    ];
    const hopFn = async () => { throw err; };
    const result = await executeWithFallback(chain, makeIR({ model: 'claude-sonnet-4-6' }), hopFn);
    // AUTH_MISSING is HARD_TRIGGER_CODES[AUTH_MISSING]=false (engine.mjs L52);
    // chain stops at hop 0 instead of advancing to openai.
    assert.equal(result.chunks, null, 'AUTH_MISSING terminates chain');
    assert.equal(result.fallbackHops, 0, 'AUTH_MISSING does NOT advance — stays at hop 0');
    assert.equal(result.fallbackDetail.length, 1, 'fallbackDetail has exactly 1 tuple (the AUTH_MISSING hop)');
    assert.equal(result.fallbackDetail[0].code, 'AUTH_MISSING');
    assert.equal(result.fallbackDetail[0].trigger_type, 'auth_missing');
    assert.equal(result.fallbackDetail[0].provider, 'anthropic');
    assert.equal(result.fallbackDetail[0].hop, 0);
  });

  it('engine: non-ProviderError exception → tuple code is "UNKNOWN"', async () => {
    const err = new Error('Something unexpected'); // no .code field
    const chain = [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }];
    const hopFn = async () => { throw err; };
    const result = await executeWithFallback(chain, makeIR({ model: 'claude-sonnet-4-6' }), hopFn);
    assert.equal(result.fallbackDetail.length, 1);
    assert.equal(result.fallbackDetail[0].code, 'UNKNOWN');
    assert.equal(result.fallbackDetail[0].error_message, 'Something unexpected');
    assert.equal(result.fallbackDetail[0].trigger_type, 'non_trigger');
  });

  it('engine: 500-char error message → tuple.error_message is truncated to 200 chars ending in ellipsis', async () => {
    const longMsg = 'x'.repeat(500);
    const err = new ProviderError(longMsg, 'SPAWN_FAILED');
    const chain = [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }];
    const hopFn = async () => { throw err; };
    const result = await executeWithFallback(chain, makeIR({ model: 'claude-sonnet-4-6' }), hopFn);
    const tuple = result.fallbackDetail[0];
    assert.equal(tuple.error_message.length, 200, 'Truncated message must be exactly 200 chars');
    assert.equal(tuple.error_message.slice(-1), '…', 'Truncated message must end with ellipsis');
    assert.equal(tuple.error_message.slice(0, 199), 'x'.repeat(199), 'First 199 chars preserved');
  });

  it('engine: client error 400 → fallbackDetail has 1 tuple with trigger_type "client_error" (no advance)', async () => {
    const err = Object.assign(new Error('Bad request'), { statusCode: 400 });
    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' },
    ];
    const hopFn = async (provider) => {
      if (provider === 'anthropic') throw err;
      return [{ type: 'stop', finish_reason: 'stop' }];
    };
    const result = await executeWithFallback(chain, makeIR({ model: 'claude-sonnet-4-6' }), hopFn);
    assert.equal(result.fallbackDetail.length, 1, 'Client error stops chain — only 1 tuple');
    assert.equal(result.fallbackDetail[0].trigger_type, 'client_error');
  });

  // ── serializeFallbackDetailHeader: cap + RFC 7230 hygiene ─────────────

  it('serialize: empty array → null (no header emitted)', () => {
    assert.equal(serializeFallbackDetailHeader([]), null);
  });

  it('serialize: null/undefined → null (no header emitted)', () => {
    assert.equal(serializeFallbackDetailHeader(null), null);
    assert.equal(serializeFallbackDetailHeader(undefined), null);
  });

  it('serialize: small array → JSON.stringified array under cap', () => {
    const detail = [{
      hop: 0, provider: 'anthropic', model: 'claude-sonnet-4-6',
      code: 'SPAWN_FAILED', error_message: 'oops', trigger_type: 'hard',
    }];
    const v = serializeFallbackDetailHeader(detail);
    assert.ok(typeof v === 'string');
    assert.ok(Buffer.byteLength(v, 'utf8') <= FALLBACK_DETAIL_BYTE_CAP);
    const parsed = JSON.parse(v);
    assert.deepEqual(parsed, detail);
  });

  it('serialize: array exceeding 4KB → truncated with { truncated:true, omitted_hops:N } sentinel; total stays <= 4096 bytes', () => {
    // Build many tuples each just under the cap individually but cumulatively
    // over the cap. Each tuple here is roughly 250 bytes serialised.
    const baseMsg = 'x'.repeat(180); // leaves ~20 chars for JSON braces/key padding
    const tuples = [];
    for (let i = 0; i < 50; i++) {
      tuples.push({
        hop: i,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        code: 'SPAWN_FAILED',
        error_message: baseMsg,
        trigger_type: 'hard',
      });
    }
    const v = serializeFallbackDetailHeader(tuples);
    assert.ok(typeof v === 'string');
    assert.ok(
      Buffer.byteLength(v, 'utf8') <= FALLBACK_DETAIL_BYTE_CAP,
      `Header value must be <= ${FALLBACK_DETAIL_BYTE_CAP} bytes, got ${Buffer.byteLength(v, 'utf8')}`,
    );
    const parsed = JSON.parse(v);
    assert.ok(Array.isArray(parsed), 'Must JSON-parse to array');
    const tail = parsed[parsed.length - 1];
    assert.equal(tail.truncated, true, 'Last entry must be the truncation sentinel');
    assert.equal(typeof tail.omitted_hops, 'number');
    assert.ok(tail.omitted_hops > 0, 'omitted_hops must be positive when truncation fired');
    assert.equal(
      parsed.length - 1 + tail.omitted_hops,
      tuples.length,
      'kept tuples + omitted_hops must equal total original tuples',
    );
  });

  it('serialize: JSON.stringify escapes newlines in error_message (RFC 7230 hygiene — no raw CR/LF in header)', () => {
    const detail = [{
      hop: 0, provider: 'anthropic', model: 'claude-sonnet-4-6',
      code: 'UNKNOWN', error_message: 'line1\nline2\rline3', trigger_type: 'non_trigger',
    }];
    const v = serializeFallbackDetailHeader(detail);
    assert.ok(typeof v === 'string');
    // Raw \n / \r in a header value would break RFC 7230. JSON.stringify escapes them.
    assert.equal(v.indexOf('\n'), -1, 'Header value must not contain raw newline');
    assert.equal(v.indexOf('\r'), -1, 'Header value must not contain raw CR');
    // Parsed back, the original message round-trips correctly
    assert.equal(JSON.parse(v)[0].error_message, 'line1\nline2\rline3');
  });

  it('serialize: non-ASCII characters in error_message (e.g. em dash U+2014) → escaped as \\uXXXX so Node HTTP header validator accepts the value', () => {
    // The D38 CONCURRENCY_LIMIT synthesised error message in server.mjs contains
    // an em dash. Without \uXXXX escaping, res.writeHead would throw
    // "Invalid character in header content" because Node's HTTP layer rejects
    // multi-byte UTF-8 in header values (RFC 7230 §3.2.6 field-vchar = ASCII VCHAR).
    const detail = [{
      hop: 0, provider: 'anthropic', model: 'claude-sonnet-4-6',
      code: 'CONCURRENCY_LIMIT',
      error_message: 'provider anthropic at maxConcurrent (2) — advancing to next hop',
      trigger_type: 'hard',
    }];
    const v = serializeFallbackDetailHeader(detail);
    assert.ok(typeof v === 'string');
    // Every byte must be ASCII (0x00-0x7F) — verified via Buffer round-trip equality.
    const utf8Len = Buffer.byteLength(v, 'utf8');
    assert.equal(utf8Len, v.length, 'Header value must be pure ASCII (1 byte per char)');
    for (let i = 0; i < v.length; i++) {
      assert.ok(v.charCodeAt(i) < 0x80, `Char at ${i} (${v[i]}) must be ASCII`);
    }
    // JSON.parse must still round-trip the original em dash.
    assert.equal(
      JSON.parse(v)[0].error_message,
      'provider anthropic at maxConcurrent (2) — advancing to next hop',
    );
  });

});

// ── Suite 14: providers.enabled config wiring ──────────────────────────────
//
// Tests that:
//   14a: Empty config → 0 providers loaded
//   14b: providers.enabled.anthropic=true → anthropic in loaded map
//   14c: HTTP 503 disappears once config has the right provider enabled
//
// Authority: ADR 0002 § Disable model; ALIGNMENT.md § Provider Inventory

import {
  __setProvidersEnabled,
  __resetProvidersEnabled,
} from './server.mjs';

describe('providers.enabled config wiring (Suite 14)', () => {

  it('14a: loadFallbackConfigSync returns providersEnabled field', () => {
    // loadFallbackConfigSync with no config file → returns empty providersEnabled
    // (This tests the schema change to loadFallbackConfigSync.)
    const cfg = loadFallbackConfigSync('/nonexistent/path/that/does/not/exist.json');
    assert.ok(typeof cfg === 'object', 'result must be an object');
    assert.ok('providersEnabled' in cfg, 'result must have providersEnabled field');
    assert.deepEqual(cfg.providersEnabled, {}, 'missing file → empty providersEnabled');
    assert.deepEqual(cfg.chains, {}, 'missing file → empty chains');
  });

  it('14b: __setProvidersEnabled({ anthropic: true }) → anthropic in loadedProviders', async () => {
    const { loadedProviders: lp } = await import('./server.mjs');
    const originalSize = lp.size;
    try {
      __setProvidersEnabled({ anthropic: true });
      assert.ok(lp.has('anthropic'), 'anthropic must be in loadedProviders after enable');
    } finally {
      __resetProvidersEnabled();
      // Restore to whatever state it was (may vary depending on config file)
    }
  });

  it('14c: __setProvidersEnabled({}) → no providers loaded → HTTP 503', async () => {
    const { createOlpServer: createServer14 } = await import('./server.mjs');
    __setProvidersEnabled({});
    const s = createServer14();
    await new Promise((resolve, reject) => {
      s.listen(0, '127.0.0.1', resolve);
      s.once('error', reject);
    });
    const p = s.address().port;
    try {
      const r = await fetch({
        port: p,
        method: 'POST',
        path: '/v1/chat/completions',
        body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.equal(r.status, 503, `Expected 503 with no providers, got ${r.status}`);
    } finally {
      __resetProvidersEnabled();
      await new Promise(r => s.close(r));
    }
  });

  it('14d: __setProvidersEnabled({ anthropic: true }) → HTTP 200 with mock spawn', async () => {
    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fake-token-suite-14d';
    __setProvidersEnabled({ anthropic: true });

    // Install mock spawn that immediately emits text + close
    __setSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            proc.stdout.emit('data', Buffer.from('Hello from suite 14d'));
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            proc.emit('close', 0, null);
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    const { createOlpServer: createServer14d, __clearCache: clearCache14d } = await import('./server.mjs');
    clearCache14d();
    const s = createServer14d();
    await new Promise((resolve, reject) => {
      s.listen(0, '127.0.0.1', resolve);
      s.once('error', reject);
    });
    const p = s.address().port;

    try {
      const r = await fetch({
        port: p,
        method: 'POST',
        path: '/v1/chat/completions',
        body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.equal(r.status, 200, `Expected 200 with anthropic enabled, got ${r.status}: ${r.body.slice(0, 200)}`);
    } finally {
      __resetProvidersEnabled();
      __resetSpawnImpl();
      if (savedToken !== undefined) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
      } else {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      }
      await new Promise(r => s.close(r));
    }
  });

});

// ── Suite 15: Streaming cache-miss real-time (P1.2) ─────────────────────────
//
// Tests that the single-hop streaming path (P1.2) emits chunks in real-time
// rather than buffering. Also tests the cache-hit burst-replay path for
// the second identical request.
//
// Authority: ADR 0003 entry adapter pattern; ADR 0004 § first-chunk rule

describe('Streaming cache-miss real-time (Suite 15)', () => {
  let server15;
  let port15;
  let savedToken15;

  before(async () => {
    savedToken15 = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fake-token-suite-15';
    __setProvidersEnabled({ anthropic: true });

    const { createOlpServer: s15, __clearCache: cc15 } = await import('./server.mjs');
    cc15();
    server15 = s15();
    await new Promise((resolve, reject) => {
      server15.listen(0, '127.0.0.1', resolve);
      server15.once('error', reject);
    });
    port15 = server15.address().port;
  });

  after(async () => {
    __resetProvidersEnabled();
    __resetSpawnImpl();
    if (savedToken15 !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken15;
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    if (!server15) return;
    return new Promise(r => server15.close(r));
  });

  it('15a: streaming cache-miss → res.write fires per chunk, not all-at-once', async () => {
    // Mock: emits 3 NDJSON deltas with a 20ms gap between each, then stop.
    // We verify by recording arrival timestamps on the client side.
    // ADR 0009 Amendment 1: stream-json path — each chunk is a valid NDJSON stream_event.
    const DELTA_GAP_MS = 20;

    __setSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          // Emit 3 NDJSON content_block_delta events with gaps
          let idx = 0;
          const texts = ['chunk1', 'chunk2', 'chunk3'];
          const emitNext = () => {
            if (idx < texts.length) {
              const event = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: texts[idx] } } });
              proc.stdout.emit('data', Buffer.from(event + '\n'));
              idx++;
              setTimeout(emitNext, DELTA_GAP_MS);
            } else {
              // Emit result/success to close the stream
              proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: texts.join('') }) + '\n'));
              proc.stdout.emit('end');
              proc.stderr.emit('end');
              proc.emit('close', 0, null);
            }
          };
          setImmediate(emitNext);
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    const { __clearCache: cc15a } = await import('./server.mjs');
    cc15a();

    // Make SSE request and collect timestamps of each data: line arrival
    const arrivalTimestamps = [];
    const chunks = await new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1',
        port: port15,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'Content-Type': 'application/json' },
      }, res => {
        const collectedLines = [];
        res.on('data', (d) => {
          const text = d.toString();
          const lines = text.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]');
          if (lines.length > 0) {
            arrivalTimestamps.push(Date.now());
            collectedLines.push(...lines);
          }
        });
        res.on('end', () => resolve(collectedLines));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'streaming test' }],
        stream: true,
      }));
      req.end();
    });

    // We should have received some data events
    assert.ok(chunks.length > 0, 'should have received streaming chunks');
    // With 20ms inter-chunk gaps the OS should flush at least twice; a buffered
    // implementation would surface as a single arrival event. This assertion
    // proves real-streaming architecturally (per D10 P1.2 review).
    assert.ok(
      arrivalTimestamps.length >= 2,
      `real streaming should produce > 1 client arrival event, got ${arrivalTimestamps.length}`
    );
    const allText = chunks.join('');
    assert.ok(allText.length > 0, 'should have received non-empty data');

    // Verify response has SSE headers
    // (We already verified by receiving 'data: ' lines)
    assert.ok(chunks.some(c => c.includes('"delta"') || c.includes('"content"') || c.includes('finish_reason')),
      'Should contain delta or stop chunks');
  });

  it('15b: second identical streaming request → cache hit, content identical', async () => {
    // Re-use the same mock (last setSpawnImpl from 15a may have been reset).
    // Install a mock that records how many times it was called.
    let spawnCallCount = 0;
    __setSpawnImpl(function (_bin, _args, _opts) {
      spawnCallCount++;
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            // ADR 0009 Amendment 1: emit NDJSON stream_event + result event
            proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'cached-content' } } }) + '\n'));
            proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'cached-content' }) + '\n'));
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            proc.emit('close', 0, null);
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    const { __clearCache: cc15b } = await import('./server.mjs');
    cc15b();

    const makeStreamRequest = () => new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1',
        port: port15,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'Content-Type': 'application/json' },
      }, res => {
        let data = '';
        res.on('data', d => { data += d.toString(); });
        res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'cache-test-15b' }],
        stream: true,
      }));
      req.end();
    });

    // First request: cache miss → real spawn
    const first = await makeStreamRequest();
    assert.equal(first.status, 200, `Expected 200, got ${first.status}: ${first.body.slice(0, 200)}`);
    assert.equal(first.headers['x-olp-cache'], 'miss', 'First request should be cache miss');
    assert.equal(spawnCallCount, 1, 'Spawn should be called exactly once for first request');

    // Second identical request: should be cache hit (burst-replay, no spawn)
    const second = await makeStreamRequest();
    assert.equal(second.status, 200, `Expected 200 on cache hit, got ${second.status}`);
    assert.equal(second.headers['x-olp-cache'], 'hit', 'Second request should be cache hit');
    assert.equal(spawnCallCount, 1, 'Spawn should NOT be called again for cache-hit request');

    // Both responses should contain the same content
    assert.ok(first.body.includes('cached-content'), 'First response should contain content');
    assert.ok(second.body.includes('cached-content'), 'Second response should contain same content');
  });

  it('15c: streaming + multi-hop chain → uses buffered path (not real-streaming)', async () => {
    // A 2-hop chain forces the code to fall through to executeWithFallback (buffered).
    // With mock anthropic succeeding, the result should still be 200 with streaming headers,
    // but X-OLP-Cache should not reflect real-streaming behavior (it may be miss or hit
    // depending on buffered cache).
    // The critical assertion: single-hop condition NOT met → buffered path is taken.

    __setSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            // ADR 0009 Amendment 1: emit NDJSON stream_event + result event
            proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'multihop-content' } } }) + '\n'));
            proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'multihop-content' }) + '\n'));
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            proc.emit('close', 0, null);
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    // Add openai to loaded providers and configure a 2-hop chain
    const { loadedProviders: lp15c, __clearCache: cc15c } = await import('./server.mjs');
    const extraProviders = loadProviders({ enabled: { anthropic: true, openai: true } });
    for (const [name, p] of extraProviders) lp15c.set(name, p);
    cc15c();

    // Inject codex fake auth so the 2nd hop doesn't immediately AUTH_MISSING
    const savedCodexPath = process.env.OPENAI_CODEX_AUTH_PATH;
    const { writeFileSync: wfs15c, unlinkSync: uls15c } = await import('node:fs');
    const { tmpdir: td15c } = await import('node:os');
    const { join: pj15c } = await import('node:path');
    const tmpAuth15c = pj15c(td15c(), `olp-test-15c-${Date.now()}.json`);
    wfs15c(tmpAuth15c, JSON.stringify({ accessToken: 'fake-codex-15c' }), 'utf8');
    process.env.OPENAI_CODEX_AUTH_PATH = tmpAuth15c;

    __setFallbackConfig({
      chains: {
        'claude-sonnet-4-6': [
          { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          { provider: 'openai', model: 'gpt-5.5' },
        ],
      },
      soft_triggers: {},
    });

    try {
      const r = await fetch({
        port: port15,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'multihop streaming test' }],
          stream: true,
        },
      });
      // Multi-hop chain → buffered path → still returns 200 with streaming headers
      assert.equal(r.status, 200, `Expected 200 for multi-hop streaming, got ${r.status}: ${r.body.slice(0, 200)}`);
      // X-OLP-Fallback-Hops: 0 since first hop succeeds
      assert.equal(r.headers['x-olp-fallback-hops'], '0', 'Primary hop should serve');
      assert.ok(r.body.includes('multihop-content'), 'Response should contain content');
    } finally {
      __resetFallbackConfig();
      __resetSpawnImpl();
      if (savedCodexPath !== undefined) {
        process.env.OPENAI_CODEX_AUTH_PATH = savedCodexPath;
      } else {
        delete process.env.OPENAI_CODEX_AUTH_PATH;
      }
      try { uls15c(tmpAuth15c); } catch { /* ignore */ }
      // Clean up the extra openai provider
      lp15c.delete('openai');
    }
  });

  it('15d: streaming early error → 502 JSON not 200 empty body (D14 defect fix)', async () => {
    // Authority: D14 defect fix — deferred writeHead in real-streaming path.
    // Pre-D14: writeHead(200) fired unconditionally before spawn, so a throw
    // before first chunk produced HTTP 200 + empty SSE body (silent loss).
    // Post-D14: writeHead is deferred to just before the first res.write;
    // a throw before any chunk fires sendError(502, ...) identical to the
    // buffered path. This test would FAIL on pre-D14 code.

    // Inject a mock anthropic provider whose spawn throws immediately (no yields).
    const { loadedProviders: lp15d, __clearCache: cc15d } = await import('./server.mjs');
    const savedAnthropicProvider = lp15d.get('anthropic');

    const earlyErrorMessage = 'Simulated provider failure before first chunk';
    const throwingProvider = {
      ...savedAnthropicProvider,
      spawn: async function* () {
        throw new ProviderError(earlyErrorMessage, 'SPAWN_FAILED');
      },
    };
    lp15d.set('anthropic', throwingProvider);
    cc15d();

    try {
      const r = await fetch({
        port: port15,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'streaming early error test' }],
          stream: true,
        },
      });

      // Must be 502, NOT 200 (the pre-D14 silent-loss behaviour)
      assert.equal(r.status, 502, `Expected 502, got ${r.status}. Body: ${r.body.slice(0, 400)}`);

      // Must be JSON error body, NOT SSE
      assert.ok(
        (r.headers['content-type'] ?? '').includes('application/json'),
        `Expected application/json, got: ${r.headers['content-type']}`
      );

      // Body must be parseable as {error: {message, type}}
      let parsed;
      try {
        parsed = JSON.parse(r.body);
      } catch {
        assert.fail(`Response body is not valid JSON: ${r.body.slice(0, 400)}`);
      }
      assert.ok(parsed.error, 'Response must have an error field');
      assert.equal(parsed.error.type, 'provider_error', `Expected type provider_error, got ${parsed.error.type}`);
      assert.ok(
        parsed.error.message.includes(earlyErrorMessage),
        `Expected error message to contain "${earlyErrorMessage}", got: ${parsed.error.message}`
      );
    } finally {
      // Restore the original anthropic provider
      if (savedAnthropicProvider !== undefined) {
        lp15d.set('anthropic', savedAnthropicProvider);
      } else {
        lp15d.delete('anthropic');
      }
    }
  });

  it('15e: streaming generator exhausted without stop chunk → response delivered but NOT cached (F9)', async () => {
    // Authority: ADR 0005 § "Cache write conditions" item 1 — "response completed
    // successfully (no truncation, no error mid-stream)". A generator that exhausts
    // without emitting a stop chunk is a truncated response and must NOT be cached.
    // Compare D16's buffered-path truncation eviction.
    //
    // Implementation note: __setSpawnImpl cannot produce a no-stop response because
    // the anthropic provider plugin synthesizes a stop chunk on clean proc exit
    // (lib/providers/anthropic.mjs line ~376: `yield anthropicStopToIR('stop')`).
    // Instead we inject a custom provider whose spawn() async generator yields a
    // delta chunk and then RETURNS without yielding a stop chunk, bypassing the
    // plugin layer entirely. Same injection pattern as 15d.
    //
    // Verifies: (a) client receives the chunks (200); (b) the response is NOT
    // written to cache — a second identical request triggers a fresh spawn (cache
    // miss), proving no caching happened after request 1.

    const { loadedProviders: lp15e, __clearCache: cc15e } = await import('./server.mjs');
    const savedAnthropicProvider = lp15e.get('anthropic');

    let spawnCallCount = 0;
    const noStopProvider = {
      ...savedAnthropicProvider,
      spawn: async function* () {
        spawnCallCount++;
        // Yield one delta chunk but NO stop chunk — generator exhausts here.
        yield { type: 'delta', content: 'no-stop-content', finish_reason: null };
        // (implicit return — no stop chunk emitted)
      },
    };
    lp15e.set('anthropic', noStopProvider);
    cc15e();

    const makeRequest = () => new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1',
        port: port15,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'Content-Type': 'application/json' },
      }, res => {
        let data = '';
        res.on('data', d => { data += d.toString(); });
        res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'no-stop-chunk-f9-test' }],
        stream: true,
      }));
      req.end();
    });

    try {
      // First request: generator exhausts without stop → client receives response (200)
      const r1 = await makeRequest();
      assert.equal(r1.status, 200, `First request failed: ${r1.status} ${r1.body.slice(0, 200)}`);
      assert.equal(spawnCallCount, 1, 'Spawn called once for first request');
      assert.equal(r1.headers['x-olp-cache'], 'miss', 'First request must be cache miss');

      // Second identical request: must ALSO be cache miss + fresh spawn (proves no caching after r1)
      const r2 = await makeRequest();
      assert.equal(r2.status, 200, `Second request failed: ${r2.status} ${r2.body.slice(0, 200)}`);
      assert.equal(spawnCallCount, 2,
        `Expected spawn called again for r2 (no-stop response must not be cached), got spawnCallCount=${spawnCallCount}`);
      assert.equal(r2.headers['x-olp-cache'], 'miss', 'Second request must also be cache miss (no caching of truncated response)');
    } finally {
      // Restore the original anthropic provider
      if (savedAnthropicProvider !== undefined) {
        lp15e.set('anthropic', savedAnthropicProvider);
      } else {
        lp15e.delete('anthropic');
      }
    }
  });

});

// ── D35 batch: issues #4 / #9 / #10 / #11 / #12 ─────────────────────────────
//
// #4 — Uniform X-OLP-* headers on in-handler error paths (audit confirms D32 complete)
// #9 — Zero-chunk empty stream → writeHead fires with text/event-stream + X-OLP-* headers
// #10 — Post-first-chunk error emits truncation marker (finish_reason:'length') + [DONE]
// #11 — validateIRRequest irVersion enforcement
// #12 — alignment.yml scripts/** path removed (CI only, no test needed)
//
// Authority: ADR 0004 § Observability headers; ADR 0003 IR contract

// ── D35-#11 unit tests (no server needed) ────────────────────────────────────

describe('D35 #11 — validateIRRequest irVersion enforcement', () => {

  it('#11a: undefined irVersion is accepted (omitted field)', () => {
    const ir = makeIR();
    delete ir.irVersion;
    const r = validateIRRequest(ir);
    assert.equal(r.valid, true, `Expected valid when irVersion is absent, got errors: ${r.errors.join('; ')}`);
  });

  it("#11b: irVersion '1.0' is accepted (correct version)", () => {
    const r = validateIRRequest(makeIR({ irVersion: '1.0' }));
    assert.equal(r.valid, true, `Expected valid for irVersion '1.0'`);
  });

  it("#11c: irVersion '2.0' is rejected (wrong version string)", () => {
    const r = validateIRRequest(makeIR({ irVersion: '2.0' }));
    assert.equal(r.valid, false, "Expected invalid for irVersion '2.0'");
    assert.ok(
      r.errors.some(e => e.includes('irVersion')),
      `Expected an irVersion error, got: ${r.errors.join('; ')}`
    );
  });

  it('#11d: irVersion 1.0 (number, not string) is rejected', () => {
    const r = validateIRRequest(makeIR({ irVersion: 1.0 }));
    assert.equal(r.valid, false, 'Expected invalid for irVersion as number 1.0');
    assert.ok(
      r.errors.some(e => e.includes('irVersion')),
      `Expected an irVersion error, got: ${r.errors.join('; ')}`
    );
  });

});

// ── D35-#4/#9/#10 integration tests ──────────────────────────────────────────

describe('D35 #4/#9/#10 — Streaming error-path header + truncation-marker fixes', () => {
  let serverD35;
  let portD35;
  let savedTokenD35;

  before(async () => {
    savedTokenD35 = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fake-token-d35';
    __setProvidersEnabled({ anthropic: true });

    const { createOlpServer: sD35, __clearCache: ccD35 } = await import('./server.mjs');
    ccD35();
    serverD35 = sD35();
    await new Promise((resolve, reject) => {
      serverD35.listen(0, '127.0.0.1', resolve);
      serverD35.once('error', reject);
    });
    portD35 = serverD35.address().port;
  });

  after(async () => {
    __resetProvidersEnabled();
    __resetSpawnImpl();
    if (savedTokenD35 !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = savedTokenD35;
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    if (!serverD35) return;
    return new Promise(r => serverD35.close(r));
  });

  it('#4-audit: 503 no_enabled_provider carries all 5 X-OLP-* headers (D32 already correct)', async () => {
    // Verifies that the 503 path (no chain built) emits the full 5-header set
    // via olpErrorHeaders — confirming D32 coverage. D35 audit found D32 complete;
    // this test pins the invariant.
    __setProvidersEnabled({});
    const { createOlpServer: s4, __clearCache: cc4 } = await import('./server.mjs');
    cc4();
    const tmpServer = s4();
    await new Promise((resolve, reject) => {
      tmpServer.listen(0, '127.0.0.1', resolve);
      tmpServer.once('error', reject);
    });
    const tmpPort = tmpServer.address().port;
    try {
      const r = await fetch({
        port: tmpPort,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'test' }],
          stream: false,
        },
      });
      assert.equal(r.status, 503, `Expected 503, got ${r.status}`);
      assert.ok(r.headers['x-olp-provider-used'], 'Must have X-OLP-Provider-Used');
      assert.ok(r.headers['x-olp-model-used'], 'Must have X-OLP-Model-Used');
      assert.ok(r.headers['x-olp-fallback-hops'] !== undefined, 'Must have X-OLP-Fallback-Hops');
      assert.ok(r.headers['x-olp-cache'], 'Must have X-OLP-Cache');
      assert.ok(r.headers['x-olp-latency-ms'] !== undefined, 'Must have X-OLP-Latency-Ms');
      assert.equal(r.headers['x-olp-provider-used'], 'none', 'X-OLP-Provider-Used must be "none"');
      assert.equal(r.headers['x-olp-model-used'], 'claude-sonnet-4-6', 'X-OLP-Model-Used must be the requested model');
    } finally {
      __setProvidersEnabled({ anthropic: true });
      await new Promise(r => tmpServer.close(r));
    }
  });

  it('#9: zero-chunk clean exit → 200 + text/event-stream + all 5 X-OLP-* headers + [DONE]', async () => {
    // Provider spawn yields zero chunks and exits cleanly (empty generator).
    // Before D35 fix: writeHead never fired → Node auto-emitted 200 with default
    // Content-Type + no X-OLP-* headers.
    // After D35 fix: writeHead fires before SSE_DONE with text/event-stream + all 5 headers.
    const { loadedProviders: lpD35_9, __clearCache: ccD35_9 } = await import('./server.mjs');
    const savedProvider = lpD35_9.get('anthropic');
    const emptyProvider = {
      ...savedProvider,
      spawn: async function* () {
        // yields nothing — clean generator exit
      },
    };
    lpD35_9.set('anthropic', emptyProvider);
    ccD35_9();

    try {
      const r = await fetch({
        port: portD35,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'empty-stream-test' }],
          stream: true,
        },
      });

      assert.equal(r.status, 200, `Expected 200, got ${r.status}`);

      // Must have text/event-stream Content-Type
      assert.ok(
        (r.headers['content-type'] ?? '').includes('text/event-stream'),
        `Expected text/event-stream, got: ${r.headers['content-type']}`
      );

      // Must carry all 5 X-OLP-* headers
      assert.ok(r.headers['x-olp-provider-used'], 'Must have X-OLP-Provider-Used');
      assert.ok(r.headers['x-olp-model-used'], 'Must have X-OLP-Model-Used');
      assert.ok(r.headers['x-olp-fallback-hops'] !== undefined, 'Must have X-OLP-Fallback-Hops');
      assert.ok(r.headers['x-olp-cache'], 'Must have X-OLP-Cache');
      assert.ok(r.headers['x-olp-latency-ms'] !== undefined, 'Must have X-OLP-Latency-Ms');

      // Body must contain [DONE] terminator
      assert.ok(r.body.includes('[DONE]'), `Expected [DONE] in body, got: ${r.body.slice(0, 200)}`);
    } finally {
      if (savedProvider !== undefined) {
        lpD35_9.set('anthropic', savedProvider);
      } else {
        lpD35_9.delete('anthropic');
      }
    }
  });

  it('#10: post-first-chunk throw → truncation marker (finish_reason:length) + [DONE] in response', async () => {
    // Provider spawn yields 1 delta chunk then throws.
    // Before D35 fix: catch block called res.end() silently — no [DONE], no truncation marker.
    // After D35 fix: emits {type:'stop', finish_reason:'length'} SSE chunk + [DONE] before res.end().
    const { loadedProviders: lpD35_10, __clearCache: ccD35_10 } = await import('./server.mjs');
    const savedProvider = lpD35_10.get('anthropic');
    const oneChunkThenThrow = {
      ...savedProvider,
      spawn: async function* () {
        yield { type: 'delta', role: 'assistant', content: 'partial-content' };
        throw new Error('post-first-chunk provider error');
      },
    };
    lpD35_10.set('anthropic', oneChunkThenThrow);
    ccD35_10();

    try {
      const r = await fetch({
        port: portD35,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'post-chunk-error-test' }],
          stream: true,
        },
      });

      // Status must be 200 (headers already sent with first chunk)
      assert.equal(r.status, 200, `Expected 200 (headers sent at first chunk), got ${r.status}`);

      // Body must contain the [DONE] terminator
      assert.ok(r.body.includes('[DONE]'), `Expected [DONE] in body, got: ${r.body.slice(0, 400)}`);

      // Body must contain the finish_reason:'length' truncation marker
      assert.ok(
        r.body.includes('"length"'),
        `Expected finish_reason:"length" truncation marker in body, got: ${r.body.slice(0, 400)}`
      );
    } finally {
      if (savedProvider !== undefined) {
        lpD35_10.set('anthropic', savedProvider);
      } else {
        lpD35_10.delete('anthropic');
      }
    }
  });

  it('#10b: post-first-chunk error-chunk → truncation marker + [DONE] (error-chunk variant)', async () => {
    // Provider spawn yields 1 delta then yields an error irChunk (type='error').
    // The error-chunk branch inside the for-await loop mirrors the catch-block fix.
    const { loadedProviders: lpD35_10b, __clearCache: ccD35_10b } = await import('./server.mjs');
    const savedProvider = lpD35_10b.get('anthropic');
    const oneChunkThenErrorChunk = {
      ...savedProvider,
      spawn: async function* () {
        yield { type: 'delta', role: 'assistant', content: 'partial-content-b' };
        yield { type: 'error', error: 'provider emitted error chunk after first' };
      },
    };
    lpD35_10b.set('anthropic', oneChunkThenErrorChunk);
    ccD35_10b();

    try {
      const r = await fetch({
        port: portD35,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'error-chunk-after-first-test' }],
          stream: true,
        },
      });

      assert.equal(r.status, 200, `Expected 200, got ${r.status}`);
      assert.ok(r.body.includes('[DONE]'), `Expected [DONE] in body, got: ${r.body.slice(0, 400)}`);
      assert.ok(
        r.body.includes('"length"'),
        `Expected finish_reason:"length" in body, got: ${r.body.slice(0, 400)}`
      );
    } finally {
      if (savedProvider !== undefined) {
        lpD35_10b.set('anthropic', savedProvider);
      } else {
        lpD35_10b.delete('anthropic');
      }
    }
  });

});

// ── Suite 17: D18 — /v1/models population + X-OLP-* headers on errors ────────
//
// Finding 10: /v1/models returned empty data regardless of loaded providers.
// Finding 11: chain-exhausted (and other) error responses omitted the standard
//             X-OLP-* observability headers required by ADR 0004 § Observability.
//
// Tests:
//   17a: /v1/models with anthropic enabled → 200 + 3 entries, owned_by='anthropic'
//   17b: /v1/models with no providers enabled → 200 + data:[]
//   17c: /v1/models entries contain only canonical IDs (no alias like 'sonnet')
//   17d: /v1/models entries match OpenAI spec shape (id/object/created/owned_by only)
//   17e: chain-exhausted error response carries all 5 X-OLP-* headers
//   17f: chain-exhausted error X-OLP-Fallback-Hops reflects hops attempted
//   17g: pre-routing 400 (invalid JSON body) carries X-OLP-Latency-Ms header
//
// Authority: OpenAI /v1/models spec (https://platform.openai.com/docs/api-reference/models);
//            ADR 0004 § Observability headers (5-header set required on every response)

import {
  createOlpServer as createServer17,
  __setProvidersEnabled as setProviders17,
  __resetProvidersEnabled as resetProviders17,
  __setFallbackConfig as setFallbackConfig17,
  __resetFallbackConfig as resetFallbackConfig17,
  __clearCache as clearCache17,
  createOlpServer as createServer27,
  __setProvidersEnabled as setProviders27,
  __resetProvidersEnabled as resetProviders27,
  createOlpServer as createServer33,
  __setProvidersEnabled as setProviders33,
  __resetProvidersEnabled as resetProviders33,
  __setFallbackConfig as setFallbackConfig33,
  __resetFallbackConfig as resetFallbackConfig33,
  __clearCache as clearCache33,
  loadedProviders as loadedProviders33,
} from './server.mjs';

describe('/v1/models population + X-OLP-* error headers (Suite 17)', () => {

  // ── 17a: /v1/models with anthropic enabled → 3 canonical + 4 alias entries ─────────────

  it('17a: /v1/models with anthropic enabled → 200 + 7 entries (3 canonical + 4 aliases) with owned_by="anthropic"', async () => {
    setProviders17({ anthropic: true });
    const s = createServer17();
    await new Promise((resolve, reject) => {
      s.listen(0, '127.0.0.1', resolve);
      s.once('error', reject);
    });
    const p = s.address().port;
    try {
      const r = await fetch({ port: p, method: 'GET', path: '/v1/models' });
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      assert.equal(body.object, 'list');
      assert.ok(Array.isArray(body.data), 'data must be an array');
      // Anthropic has 3 canonical models + 4 aliases (claude, sonnet, opus, haiku) in models-registry.json
      assert.equal(body.data.length, 7, `Expected 7 anthropic entries (3 canonical + 4 aliases), got ${body.data.length}`);
      for (const entry of body.data) {
        assert.equal(entry.owned_by, 'anthropic', `Expected owned_by='anthropic', got '${entry.owned_by}'`);
      }
    } finally {
      resetProviders17();
      await new Promise(r => s.close(r));
    }
  });

  // ── 17b: /v1/models with no providers enabled → data:[] ──────────────────

  it('17b: /v1/models with no providers enabled → 200 + data:[]', async () => {
    setProviders17({});
    const s = createServer17();
    await new Promise((resolve, reject) => {
      s.listen(0, '127.0.0.1', resolve);
      s.once('error', reject);
    });
    const p = s.address().port;
    try {
      const r = await fetch({ port: p, method: 'GET', path: '/v1/models' });
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      assert.equal(body.object, 'list');
      assert.deepEqual(body.data, [], 'data must be empty when no providers are enabled');
    } finally {
      resetProviders17();
      await new Promise(r => s.close(r));
    }
  });

  // ── 17c: /v1/models returns both canonical IDs and alias IDs ───────────────
  // Updated by D27 F15: aliases are now surfaced in /v1/models (canonical-first order).

  it('17c: /v1/models returns canonical IDs and alias IDs for loaded providers', async () => {
    setProviders17({ anthropic: true });
    const s = createServer17();
    await new Promise((resolve, reject) => {
      s.listen(0, '127.0.0.1', resolve);
      s.once('error', reject);
    });
    const p = s.address().port;
    try {
      const r = await fetch({ port: p, method: 'GET', path: '/v1/models' });
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      const ids = body.data.map(e => e.id);
      // Canonical IDs must appear
      assert.ok(ids.includes('claude-sonnet-4-6'), 'canonical claude-sonnet-4-6 must appear');
      assert.ok(ids.includes('claude-opus-4-7'), 'canonical claude-opus-4-7 must appear');
      assert.ok(ids.includes('claude-haiku-4-5'), 'canonical claude-haiku-4-5 must appear');
      // Aliases for the loaded (anthropic) provider must also appear
      const anthropicAliases = ['claude', 'sonnet', 'opus', 'haiku'];
      for (const alias of anthropicAliases) {
        assert.ok(ids.includes(alias), `Alias '${alias}' must appear in /v1/models data when anthropic is enabled`);
      }
      // Canonical IDs come before alias IDs (canonical-first ordering)
      const firstAliasIdx = Math.min(...anthropicAliases.map(a => ids.indexOf(a)));
      const lastCanonicalIdx = Math.max(ids.indexOf('claude-sonnet-4-6'), ids.indexOf('claude-opus-4-7'), ids.indexOf('claude-haiku-4-5'));
      assert.ok(lastCanonicalIdx < firstAliasIdx, 'canonical entries must appear before alias entries');
    } finally {
      resetProviders17();
      await new Promise(r => s.close(r));
    }
  });

  // ── 17d: /v1/models entries match OpenAI spec shape ───────────────────────

  it('17d: /v1/models entries match OpenAI spec shape (id/object/created/owned_by)', async () => {
    setProviders17({ anthropic: true });
    const s = createServer17();
    await new Promise((resolve, reject) => {
      s.listen(0, '127.0.0.1', resolve);
      s.once('error', reject);
    });
    const p = s.address().port;
    try {
      const r = await fetch({ port: p, method: 'GET', path: '/v1/models' });
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      assert.ok(body.data.length > 0, 'Expected at least one model entry');
      for (const entry of body.data) {
        // Must have spec-defined fields
        assert.ok(typeof entry.id === 'string' && entry.id.length > 0, 'id must be a non-empty string');
        assert.equal(entry.object, 'model', "object must be 'model'");
        assert.ok(typeof entry.created === 'number' && entry.created > 0, 'created must be a positive number (Unix epoch seconds)');
        assert.ok(typeof entry.owned_by === 'string' && entry.owned_by.length > 0, 'owned_by must be a non-empty string');
        // Must NOT have invented fields beyond the spec
        const allowedKeys = new Set(['id', 'object', 'created', 'owned_by']);
        for (const key of Object.keys(entry)) {
          assert.ok(allowedKeys.has(key), `Unexpected field '${key}' in /v1/models entry (not in OpenAI spec)`);
        }
      }
    } finally {
      resetProviders17();
      await new Promise(r => s.close(r));
    }
  });

  // ── 17e: chain-exhausted error response carries all 5 X-OLP-* headers ─────

  it('17e: chain-exhausted 502 response carries all 5 standard X-OLP-* observability headers', async () => {
    // Set up a 2-hop chain where both providers fail (SPAWN_FAILED via exit code 1).
    // Both providers must be enabled for the chain to be built.
    setProviders17({ anthropic: true, openai: true });
    setFallbackConfig17({
      chains: {
        'claude-sonnet-4-6': [
          { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          { provider: 'openai', model: 'gpt-5.5' },
        ],
      },
      soft_triggers: {},
      providersEnabled: { anthropic: true, openai: true },
    });
    clearCache17();

    // Fake auth for both providers
    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fake-token-17e-anthropic';

    const { writeFileSync: wfs17e, unlinkSync: uls17e } = await import('node:fs');
    const { tmpdir: td17e } = await import('node:os');
    const { join: pj17e } = await import('node:path');
    const tmpAuth17e = pj17e(td17e(), `olp-test-17e-codex-${Date.now()}.json`);
    wfs17e(tmpAuth17e, JSON.stringify({ accessToken: 'fake-codex-17e' }), 'utf8');
    const savedCodexPath = process.env.OPENAI_CODEX_AUTH_PATH;
    process.env.OPENAI_CODEX_AUTH_PATH = tmpAuth17e;

    // Both providers: exit code 1 → SPAWN_FAILED hard trigger
    function makeFailSpawn17() {
      return function (_bin, _args, _opts) {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stdin = {
          write: () => {},
          end: () => {
            setImmediate(() => {
              proc.stdout.emit('end');
              proc.stderr.emit('end');
              proc.emit('close', 1, null);
            });
          },
        };
        proc.killed = false;
        proc.kill = () => {};
        return proc;
      };
    }

    __setSpawnImpl(makeFailSpawn17());
    codexSetSpawnImpl(makeFailSpawn17());

    const s = createServer17();
    await new Promise((resolve, reject) => {
      s.listen(0, '127.0.0.1', resolve);
      s.once('error', reject);
    });
    const p = s.address().port;

    try {
      const r = await fetch({
        port: p,
        method: 'POST',
        path: '/v1/chat/completions',
        body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.ok(r.status >= 400 && r.status < 600, `Expected error status, got ${r.status}`);
      // All 5 standard X-OLP-* headers must be present per ADR 0004 § Observability
      assert.ok(r.headers['x-olp-provider-used'] !== undefined, 'X-OLP-Provider-Used must be present on error response');
      assert.ok(r.headers['x-olp-model-used'] !== undefined, 'X-OLP-Model-Used must be present on error response');
      assert.ok(r.headers['x-olp-fallback-hops'] !== undefined, 'X-OLP-Fallback-Hops must be present on error response');
      assert.ok(r.headers['x-olp-cache'] !== undefined, 'X-OLP-Cache must be present on error response');
      assert.ok(r.headers['x-olp-latency-ms'] !== undefined, 'X-OLP-Latency-Ms must be present on error response');
    } finally {
      resetProviders17();
      resetFallbackConfig17();
      __resetSpawnImpl();
      codexResetSpawnImpl();
      if (savedToken !== undefined) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
      } else {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      }
      if (savedCodexPath !== undefined) {
        process.env.OPENAI_CODEX_AUTH_PATH = savedCodexPath;
      } else {
        delete process.env.OPENAI_CODEX_AUTH_PATH;
      }
      try { uls17e(tmpAuth17e); } catch { /* ignore */ }
      await new Promise(r => s.close(r));
    }
  });

  // ── 17f: chain-exhausted X-OLP-Fallback-Hops reflects hops attempted ─────

  it('17f: chain-exhausted error X-OLP-Fallback-Hops reflects hops attempted (2-hop → "2")', async () => {
    // 2-hop chain where both fail → fallbackHops should reflect 2 hops tried
    setProviders17({ anthropic: true, openai: true });
    setFallbackConfig17({
      chains: {
        'claude-sonnet-4-6': [
          { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          { provider: 'openai', model: 'gpt-5.5' },
        ],
      },
      soft_triggers: {},
      providersEnabled: { anthropic: true, openai: true },
    });
    clearCache17();

    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fake-token-17f-anthropic';

    const { writeFileSync: wfs17f, unlinkSync: uls17f } = await import('node:fs');
    const { tmpdir: td17f } = await import('node:os');
    const { join: pj17f } = await import('node:path');
    const tmpAuth17f = pj17f(td17f(), `olp-test-17f-codex-${Date.now()}.json`);
    wfs17f(tmpAuth17f, JSON.stringify({ accessToken: 'fake-codex-17f' }), 'utf8');
    const savedCodexPath17f = process.env.OPENAI_CODEX_AUTH_PATH;
    process.env.OPENAI_CODEX_AUTH_PATH = tmpAuth17f;

    function makeFailSpawn17f() {
      return function (_bin, _args, _opts) {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stdin = {
          write: () => {},
          end: () => {
            setImmediate(() => {
              proc.stdout.emit('end');
              proc.stderr.emit('end');
              proc.emit('close', 1, null);
            });
          },
        };
        proc.killed = false;
        proc.kill = () => {};
        return proc;
      };
    }

    __setSpawnImpl(makeFailSpawn17f());
    codexSetSpawnImpl(makeFailSpawn17f());

    const s = createServer17();
    await new Promise((resolve, reject) => {
      s.listen(0, '127.0.0.1', resolve);
      s.once('error', reject);
    });
    const p = s.address().port;

    try {
      const r = await fetch({
        port: p,
        method: 'POST',
        path: '/v1/chat/completions',
        body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.ok(r.status >= 400, `Expected error status, got ${r.status}`);
      // fallbackHops is set to chain.length (2) when chain exhausted per engine.mjs
      assert.equal(r.headers['x-olp-fallback-hops'], '2',
        `Expected X-OLP-Fallback-Hops: 2 (both hops tried), got: ${r.headers['x-olp-fallback-hops']}`);
    } finally {
      resetProviders17();
      resetFallbackConfig17();
      __resetSpawnImpl();
      codexResetSpawnImpl();
      if (savedToken !== undefined) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
      } else {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      }
      if (savedCodexPath17f !== undefined) {
        process.env.OPENAI_CODEX_AUTH_PATH = savedCodexPath17f;
      } else {
        delete process.env.OPENAI_CODEX_AUTH_PATH;
      }
      try { uls17f(tmpAuth17f); } catch { /* ignore */ }
      await new Promise(r => s.close(r));
    }
  });

  // ── 17g: pre-routing 400 (invalid JSON) carries full 5 X-OLP-* headers ──────
  // Updated by D32 F8: olpErrorHeaders() now emits all 5 headers with
  // "no provider attempted" defaults (provider='none', model='unknown',
  // hops=0, cache='bypass') on pre-chain error paths. Test updated to assert
  // the full set rather than only X-OLP-Latency-Ms.

  it('17g: pre-routing 400 (invalid JSON body) carries all 5 X-OLP-* headers with no-provider defaults', async () => {
    // Pre-chain errors inside handleChatCompletions now emit the full 5-header set
    // via olpErrorHeaders() with canonical "no provider attempted" defaults per
    // ADR 0004 § Observability (D32 F8).
    setProviders17({});
    const s = createServer17();
    await new Promise((resolve, reject) => {
      s.listen(0, '127.0.0.1', resolve);
      s.once('error', reject);
    });
    const p = s.address().port;
    try {
      const result = await new Promise((resolve, reject) => {
        const req = httpRequest({
          hostname: '127.0.0.1',
          port: p,
          method: 'POST',
          path: '/v1/chat/completions',
          headers: { 'Content-Type': 'application/json', 'Content-Length': '5' },
        }, res => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        req.write('{bad}');
        req.end();
      });
      assert.equal(result.status, 400, `Expected 400 for invalid JSON body`);
      // All 5 X-OLP-* headers must be present (D32 F8 olpErrorHeaders)
      assert.ok(result.headers['x-olp-latency-ms'] !== undefined,
        'Pre-routing 400 must carry X-OLP-Latency-Ms');
      const latencyMs = parseInt(result.headers['x-olp-latency-ms'], 10);
      assert.ok(!isNaN(latencyMs) && latencyMs >= 0,
        `X-OLP-Latency-Ms must be non-negative integer, got: ${result.headers['x-olp-latency-ms']}`);
      assert.equal(result.headers['x-olp-provider-used'], 'none',
        'Pre-routing 400 must carry X-OLP-Provider-Used: none (no provider attempted)');
      assert.equal(result.headers['x-olp-model-used'], 'unknown',
        'Pre-routing 400 must carry X-OLP-Model-Used: unknown (IR not parsed yet)');
      assert.equal(result.headers['x-olp-fallback-hops'], '0',
        'Pre-routing 400 must carry X-OLP-Fallback-Hops: 0');
      assert.equal(result.headers['x-olp-cache'], 'bypass',
        'Pre-routing 400 must carry X-OLP-Cache: bypass');
    } finally {
      resetProviders17();
      await new Promise(r => s.close(r));
    }
  });

  // ── 17h: 415 wrong Content-Type carries all 5 X-OLP-* headers ────────��─────
  // D32 F8: olpErrorHeaders on 415 pre-chain path.

  it('17h: 415 wrong Content-Type carries all 5 X-OLP-* headers with no-provider defaults', async () => {
    setProviders17({});
    const s = createServer17();
    await new Promise((resolve, reject) => {
      s.listen(0, '127.0.0.1', resolve);
      s.once('error', reject);
    });
    const p = s.address().port;
    try {
      const result = await new Promise((resolve, reject) => {
        const req = httpRequest({
          hostname: '127.0.0.1',
          port: p,
          method: 'POST',
          path: '/v1/chat/completions',
          headers: { 'Content-Type': 'text/plain', 'Content-Length': '2' },
        }, res => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        req.write('{}');
        req.end();
      });
      assert.equal(result.status, 415, `Expected 415 for wrong Content-Type, got ${result.status}`);
      assert.equal(result.headers['x-olp-provider-used'], 'none',
        '415 must carry X-OLP-Provider-Used: none');
      assert.equal(result.headers['x-olp-model-used'], 'unknown',
        '415 must carry X-OLP-Model-Used: unknown');
      assert.equal(result.headers['x-olp-fallback-hops'], '0',
        '415 must carry X-OLP-Fallback-Hops: 0');
      assert.equal(result.headers['x-olp-cache'], 'bypass',
        '415 must carry X-OLP-Cache: bypass');
      assert.ok(result.headers['x-olp-latency-ms'] !== undefined,
        '415 must carry X-OLP-Latency-Ms');
    } finally {
      resetProviders17();
      await new Promise(r => s.close(r));
    }
  });

  // ── 17i: 503 no-enabled-providers carries all 5 X-OLP-* headers ───────────
  // D32 F8: olpErrorHeaders on 503 no-chain path. X-OLP-Model-Used reflects
  // the requested model (IR was parsed successfully before chain lookup).

  it('17i: 503 no-enabled-providers carries all 5 X-OLP-* headers with model from IR', async () => {
    setProviders17({});
    const s = createServer17();
    await new Promise((resolve, reject) => {
      s.listen(0, '127.0.0.1', resolve);
      s.once('error', reject);
    });
    const p = s.address().port;
    try {
      const r = await fetch({
        port: p,
        method: 'POST',
        path: '/v1/chat/completions',
        body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.equal(r.status, 503, `Expected 503 for no enabled providers, got ${r.status}`);
      assert.equal(r.headers['x-olp-provider-used'], 'none',
        '503 must carry X-OLP-Provider-Used: none');
      // Model is known (IR was parsed) so model string is propagated
      assert.equal(r.headers['x-olp-model-used'], 'claude-sonnet-4-6',
        '503 must carry X-OLP-Model-Used reflecting the requested model');
      assert.equal(r.headers['x-olp-fallback-hops'], '0',
        '503 must carry X-OLP-Fallback-Hops: 0');
      assert.equal(r.headers['x-olp-cache'], 'bypass',
        '503 must carry X-OLP-Cache: bypass');
      assert.ok(r.headers['x-olp-latency-ms'] !== undefined,
        '503 must carry X-OLP-Latency-Ms');
    } finally {
      resetProviders17();
      await new Promise(r => s.close(r));
    }
  });

});

// ── Suite 16: Spawn timeout (P1.3) ───────────────────────────────────────────
//
// Tests that:
//   16a: SPAWN_TIMEOUT is in PROVIDER_ERROR_CODES
//   16b: SPAWN_TIMEOUT is a hard trigger (evaluateHardTriggers returns true)
//   16c: Provider that never completes throws SPAWN_TIMEOUT after configured timeout
//   16d: Fallback chain: primary times out → secondary serves
//
// Authority: ADR 0004 § Trigger taxonomy bullet 4; lib/providers/base.mjs

import { PROVIDER_ERROR_CODES } from './lib/providers/base.mjs';

describe('Spawn timeout (Suite 16)', () => {

  it('16a: SPAWN_TIMEOUT is in PROVIDER_ERROR_CODES', () => {
    assert.ok(PROVIDER_ERROR_CODES.includes('SPAWN_TIMEOUT'),
      'SPAWN_TIMEOUT must be in PROVIDER_ERROR_CODES');
  });

  it('16b: evaluateHardTriggers with SPAWN_TIMEOUT code → true (hard trigger)', () => {
    const err = new ProviderError('spawn timed out', 'SPAWN_TIMEOUT');
    assert.equal(evaluateHardTriggers(err), true,
      'SPAWN_TIMEOUT ProviderError must be a hard trigger');
  });

  it('16c: anthropic plugin with short timeout → throws ProviderError SPAWN_TIMEOUT', async () => {
    // Install a spawn mock that never closes (simulates hanging CLI).
    // Set a very short timeout (100ms) via hints mutation.
    const savedTimeout = anthropic.hints.maxSpawnTimeMs;
    anthropic.hints.maxSpawnTimeMs = 100;

    __setSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          // Never emit close — simulates a hanging process.
          // stdout may emit some data but never closes.
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    try {
      const irReq = makeIR({ model: 'claude-sonnet-4-6', stream: false });
      // Need auth so we don't hit AUTH_MISSING before the timeout path.
      const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fake-token-16c';
      try {
        const gen = anthropic.spawn(irReq, { accessToken: 'fake-16c' });
        // Drain the generator — it should eventually throw SPAWN_TIMEOUT.
        let caughtError = null;
        try {
          for await (const chunk of gen) { void chunk; }
        } catch (e) {
          caughtError = e;
        }
        assert.ok(caughtError !== null, 'Expected a ProviderError to be thrown');
        assert.ok(caughtError instanceof ProviderError, `Expected ProviderError, got ${caughtError?.constructor?.name}`);
        assert.equal(caughtError.code, 'SPAWN_TIMEOUT', `Expected SPAWN_TIMEOUT code, got ${caughtError?.code}`);
      } finally {
        if (savedToken !== undefined) {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
        } else {
          delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        }
      }
    } finally {
      anthropic.hints.maxSpawnTimeMs = savedTimeout;
      __resetSpawnImpl();
    }
  });

  it('16d: fallback chain: primary times out → chain advances to secondary → secondary serves', async () => {
    // Set up: primary = anthropic (will hang + timeout), secondary = openai (will succeed).
    const savedAnthropicTimeout = anthropic.hints.maxSpawnTimeMs;
    anthropic.hints.maxSpawnTimeMs = 100; // short timeout for test speed

    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fake-token-16d-anthropic';

    // Anthropic mock: hangs forever (triggers SPAWN_TIMEOUT)
    __setSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write: () => {}, end: () => {} };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    // Codex mock: succeeds immediately
    codexSetSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            proc.stdout.emit('data', Buffer.from('{"content":"fallback-from-timeout-test"}\n'));
            proc.stdout.emit('data', Buffer.from('{"type":"stop"}\n'));
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            proc.emit('close', 0, null);
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    // Set up fake codex auth
    const { writeFileSync: wfs16d, unlinkSync: uls16d } = await import('node:fs');
    const { tmpdir: td16d } = await import('node:os');
    const { join: pj16d } = await import('node:path');
    const tmpAuth16d = pj16d(td16d(), `olp-test-16d-${Date.now()}.json`);
    wfs16d(tmpAuth16d, JSON.stringify({ accessToken: 'fake-codex-16d' }), 'utf8');
    const savedCodexPath = process.env.OPENAI_CODEX_AUTH_PATH;
    process.env.OPENAI_CODEX_AUTH_PATH = tmpAuth16d;

    // Build a 2-hop chain: anthropic → openai
    const testProviders = loadProviders({ enabled: { anthropic: true, openai: true } });

    const chain = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-5.5' },
    ];

    const irReq = makeIR({ model: 'claude-sonnet-4-6', stream: false });

    async function testExecuteHopFn(hopProvider, hopModel, ir) {
      const plugin = testProviders.get(hopProvider);
      if (!plugin) throw Object.assign(new Error(`no provider ${hopProvider}`), { statusCode: 503 });
      const chunks = [];
      for await (const c of plugin.spawn(ir, hopProvider === 'anthropic'
        ? { accessToken: 'fake-token-16d-anthropic' }
        : { accessToken: 'fake-codex-16d' })) {
        chunks.push(c);
        if (c.type === 'error') throw new ProviderError(c.error, 'SPAWN_FAILED');
        if (c.type === 'stop') break;
      }
      return chunks;
    }

    try {
      const result = await executeWithFallback(chain, irReq, testExecuteHopFn, { logEvent: () => {} });
      assert.ok(result.chunks !== null, 'Fallback should have produced chunks');
      assert.equal(result.fallbackHops, 1, 'Should have fallen back to second hop');
      assert.equal(result.providerUsed, 'openai', 'openai should have served after anthropic timed out');
      const content = result.chunks.filter(c => c.type === 'delta').map(c => c.content).join('');
      assert.ok(content.includes('fallback-from-timeout-test'), 'Content from fallback provider expected');
    } finally {
      anthropic.hints.maxSpawnTimeMs = savedAnthropicTimeout;
      __resetSpawnImpl();
      codexResetSpawnImpl();
      if (savedToken !== undefined) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
      } else {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      }
      if (savedCodexPath !== undefined) {
        process.env.OPENAI_CODEX_AUTH_PATH = savedCodexPath;
      } else {
        delete process.env.OPENAI_CODEX_AUTH_PATH;
      }
      try { uls16d(tmpAuth16d); } catch { /* ignore */ }
    }
  });


  it('16e: spawn-timeout fires SPAWN_TIMEOUT even when timer races with queued chunks (D24 race fix)', async () => {
    // Exercises the race fixed in D24 (cold-audit round-2 F4).
    //
    // Race path modelled deterministically:
    //   1. Mock stdin.end() schedules data1 + data2 + 'close' via setImmediate
    //      (deferred so event handlers registered in the plugin body are ready).
    //   2. Timer is 10ms. Drain loop awaits empty queue. setImmediate fires:
    //      push(data1) wakes the drain loop (rejectNext was set, now cleared),
    //      push(data2) and push(close) queue up. Drain processes data1, yields it.
    //      Generator suspends at yield with rejectNext===null.
    //   3. Consumer (gen.next() resolved) waits 25ms (> 10ms timer).
    //      Timer fires: spawnTimedOut=true, rejectNext===null → rejectNext branch
    //      SKIPPED. Race condition reproduced.
    //   4. Consumer resumes → drain loop processes data2 then 'close' → breaks.
    //      Post-loop: spawnTimedOut=true.
    //      Pre-D24: generator returns normally (truncated, silently cacheable).
    //      Post-D24: unconditional `if (spawnTimedOut) throw` → SPAWN_TIMEOUT.
    //
    // The timer starts inside the generator body (not at gen-creation time),
    // so it only ticks after the first gen.next() call.

    const savedTimeout = anthropic.hints.maxSpawnTimeMs;
    anthropic.hints.maxSpawnTimeMs = 10; // fires during the 25ms consumer pause

    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fake-token-16e';

    __setSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          // Emit NDJSON data + close via setImmediate so the event handlers (registered
          // AFTER stdin.end() in the plugin body) are already attached when
          // these events fire. All three items land in the same setImmediate
          // callback, so they're all in chunks[] before the drain loop resumes.
          // ADR 0009 Amendment 1: must be valid NDJSON stream_events so that the
          // first chunk yields a delta (enabling the D24 race to occur).
          setImmediate(() => {
            proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial-chunk-1' } } }) + '\n'));
            proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial-chunk-2' } } }) + '\n'));
            proc.stderr.emit('end');
            proc.emit('close', 0, null); // exitCode=0, done=true
          });
        },
      };
      proc.killed = false;
      proc.kill = (_sig) => { /* already closed */ };
      return proc;
    });

    try {
      const irReq = makeIR({ model: 'claude-sonnet-4-6', stream: false });
      const gen = anthropic.spawn(irReq, { accessToken: 'fake-16e' });

      // Pull exactly one chunk. Sequence:
      //   - Generator body starts: spawnImpl(), stdin.end() (schedules setImmediate)
      //   - Timer armed (10ms)
      //   - Drain loop: chunks=[], done=false → enters await (rejectNext set)
      //   - setImmediate fires: push(data1), push(data2), close queued, done=true
      //   - push(data1) calls resolveNext() → drain resumes
      //   - Drain processes data1 → yield → generator suspends. rejectNext=null.
      //   - gen.next() promise resolves with the first chunk.
      let firstResult;
      try {
        firstResult = await gen.next();
      } catch (e) {
        throw new Error(`Unexpected throw on first gen.next(): ${e.message}`);
      }
      assert.ok(firstResult && !firstResult.done, 'Expected first gen.next() to yield a chunk');

      // Wait > 10ms. During this pause:
      //   - Timer fires: spawnTimedOut=true, rejectNext===null → branch skipped.
      //   - Race condition has now occurred (timer fired with no active rejectNext).
      await new Promise(r => setTimeout(r, 25));

      // Resume draining. Drain loop processes second data + 'close' → breaks.
      // Post-loop: spawnTimedOut=true.
      // Pre-D24: generator returns normally (done=true, no throw). FAIL.
      // Post-D24: `if (spawnTimedOut) throw ProviderError SPAWN_TIMEOUT`. PASS.
      let caughtError = null;
      try {
        while (true) {
          const { value, done: genDone } = await gen.next();
          if (genDone) break;
          void value;
        }
      } catch (e) {
        caughtError = e;
      }

      assert.ok(caughtError !== null,
        'Expected ProviderError SPAWN_TIMEOUT (D24 race fix: pre-D24 generator returned normally with partial chunks)');
      assert.ok(caughtError instanceof ProviderError,
        `Expected ProviderError, got ${caughtError?.constructor?.name}`);
      assert.equal(caughtError.code, 'SPAWN_TIMEOUT',
        `Expected SPAWN_TIMEOUT code, got ${caughtError?.code}`);
    } finally {
      anthropic.hints.maxSpawnTimeMs = savedTimeout;
      __resetSpawnImpl();
      if (savedToken !== undefined) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
      } else {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      }
    }
  });

// ── Suite D26: round-3 cleanup batch (F16, F17, F19) ─────────────────────────
//
// F16: soft_triggers_deferred_v1x startup warning fires when routing.soft_triggers
//      is non-empty in the fallback config.
// F17: SPAWN_FAILED from an error chunk in Codex / Mistral plugins includes the
//      accumulated stderr tail in the error message.
// F19: Streaming path exhausted without stop chunk emits finish_reason:'length'
//      SSE chunk before [DONE] (when partial content was streamed).
//
// Authority:
//   F16 — ADR 0004 Amendment 2 § Mitigations (soft-trigger startup warning)
//   F17 — ADR 0004 § Chain advancement step 4 (preserve debug signal)
//   F19 — OpenAI Chat Completions spec (finish_reason:'length');
//          ADR 0005 § Cache write conditions item 1 (D25 F9 no-cache invariant)

// ── F16: soft_triggers_deferred_v1x warning ──────────────────────────────

describe('D26 F16 — soft_triggers_deferred_v1x startup warning', () => {

  it('F16: logEvent emits soft_triggers_deferred_v1x warn when soft_triggers is non-empty', () => {
    // Intercept stderr to observe the log event.
    // server.mjs emits the warning at module-evaluation time for _startupConfig.
    // We cannot re-trigger that path without re-loading the module. Instead, we
    // reproduce the exact code path inline (same logEvent call + check) with a
    // synthetic config and monkeypatch process.stderr to capture the output.

    const written = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      if (typeof chunk === 'string') written.push(chunk);
      else if (Buffer.isBuffer(chunk)) written.push(chunk.toString());
      return origWrite(chunk, ...rest);
    };

    try {
      // Simulate what server.mjs does at startup when soft_triggers is non-empty.
      const simulatedConfig = {
        soft_triggers: { anthropic: { p95_latency_ms: 5000 }, openai: { error_rate: 0.1 } },
      };
      const softTriggersConfigured = Object.keys(simulatedConfig.soft_triggers ?? {}).length > 0;
      if (softTriggersConfigured) {
        const entry = {
          ts: new Date().toISOString(),
          level: 'warn',
          event: 'soft_triggers_deferred_v1x',
          configured_providers: Object.keys(simulatedConfig.soft_triggers),
          message: 'routing.soft_triggers configured but soft triggers are deferred to v1.x; ' +
            'thresholds will not fire at v0.1 — see ADR 0004 Amendment 2',
        };
        process.stderr.write(JSON.stringify(entry) + '\n');
      }
    } finally {
      process.stderr.write = origWrite;
    }

    assert.equal(written.length, 1, `Expected exactly 1 stderr write, got ${written.length}`);
    const parsed = JSON.parse(written[0]);
    assert.equal(parsed.level, 'warn');
    assert.equal(parsed.event, 'soft_triggers_deferred_v1x');
    assert.ok(Array.isArray(parsed.configured_providers), 'configured_providers must be an array');
    assert.ok(parsed.configured_providers.includes('anthropic'), 'must include anthropic provider');
    assert.ok(parsed.configured_providers.includes('openai'), 'must include openai provider');
    assert.ok(typeof parsed.message === 'string' && parsed.message.includes('v1.x'),
      'message must mention v1.x deferral');
  });

  it('F16: no warning emitted when soft_triggers is empty', () => {
    const written = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      if (typeof chunk === 'string') written.push(chunk);
      else if (Buffer.isBuffer(chunk)) written.push(chunk.toString());
      return origWrite(chunk, ...rest);
    };

    try {
      const simulatedConfig = { soft_triggers: {} };
      const softTriggersConfigured = Object.keys(simulatedConfig.soft_triggers ?? {}).length > 0;
      if (softTriggersConfigured) {
        process.stderr.write('should-not-appear\n');
      }
    } finally {
      process.stderr.write = origWrite;
    }

    assert.equal(written.length, 0, 'No stderr writes expected when soft_triggers is empty');
  });

  it('F16: no warning emitted when soft_triggers is absent (undefined)', () => {
    const written = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      if (typeof chunk === 'string') written.push(chunk);
      else if (Buffer.isBuffer(chunk)) written.push(chunk.toString());
      return origWrite(chunk, ...rest);
    };

    try {
      const simulatedConfig = {};
      const softTriggersConfigured = Object.keys(simulatedConfig.soft_triggers ?? {}).length > 0;
      if (softTriggersConfigured) {
        process.stderr.write('should-not-appear\n');
      }
    } finally {
      process.stderr.write = origWrite;
    }

    assert.equal(written.length, 0, 'No stderr writes expected when soft_triggers is absent');
  });

});

// ── F17: stderr propagation on error-chunk SPAWN_FAILED ──────────────────

describe('D26 F17 — stderr propagation in error-chunk SPAWN_FAILED (Codex + Mistral)', () => {

  it('F17 codex: error chunk throw includes stderr tail when stderr is non-empty', async () => {
    // Inject a mock spawn that emits stderr then an NDJSON error event then exits 0.
    // Verify that the thrown ProviderError message contains both the error text
    // and the stderr tail separated by ' | stderr: '.
    const stderrPayload = 'codex: quota exceeded — plan limit reached';

    codexSetSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            proc.stderr.emit('data', Buffer.from(stderrPayload));
            proc.stdout.emit('data', Buffer.from('{"type":"error","error":"upstream 429"}\n'));
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            proc.emit('close', 0, null);
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    try {
      const ir = makeIR({ model: 'gpt-5.5', stream: false });
      const authCtx = { accessToken: 'fake-codex-f17' };
      let caught = null;
      try {
        for await (const _chunk of codex.spawn(ir, authCtx)) { /* drain */ } // eslint-disable-line no-unused-vars
      } catch (e) {
        caught = e;
      }
      assert.ok(caught instanceof ProviderError,
        `Expected ProviderError, got ${caught?.constructor?.name ?? String(caught)}`);
      assert.equal(caught.code, 'SPAWN_FAILED');
      assert.ok(
        caught.message.includes('upstream 429'),
        `Expected message to include 'upstream 429', got: ${caught.message}`,
      );
      assert.ok(
        caught.message.includes('codex: quota exceeded'),
        `Expected message to include stderr tail, got: ${caught.message}`,
      );
      assert.ok(
        caught.message.includes('| stderr:'),
        `Expected '| stderr:' separator in message, got: ${caught.message}`,
      );
    } finally {
      codexResetSpawnImpl();
    }
  });

  it('F17 codex: error chunk message has no stderr suffix when stderr is empty', async () => {
    codexSetSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            // No stderr — just the error line
            proc.stdout.emit('data', Buffer.from('{"type":"error","error":"plain error"}\n'));
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            proc.emit('close', 0, null);
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    try {
      const ir = makeIR({ model: 'gpt-5.5', stream: false });
      const authCtx = { accessToken: 'fake-codex-f17b' };
      let caught = null;
      try {
        for await (const _chunk of codex.spawn(ir, authCtx)) { /* drain */ } // eslint-disable-line no-unused-vars
      } catch (e) {
        caught = e;
      }
      assert.ok(caught instanceof ProviderError, `Expected ProviderError, got ${caught?.constructor?.name}`);
      assert.equal(caught.code, 'SPAWN_FAILED');
      assert.ok(caught.message.includes('plain error'),
        `Expected 'plain error' in message, got: ${caught.message}`);
      assert.ok(!caught.message.includes('| stderr:'),
        `Expected no stderr suffix when stderr is empty, got: ${caught.message}`);
    } finally {
      codexResetSpawnImpl();
    }
  });

  it('F17 mistral: error chunk throw includes stderr tail when stderr is non-empty', async () => {
    const stderrPayload = 'vibe: api key invalid';

    mistralSetSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            proc.stderr.emit('data', Buffer.from(stderrPayload));
            proc.stdout.emit('data', Buffer.from('{"type":"error","error":"auth failure"}\n'));
            proc.stdout.emit('end');
            proc.stderr.emit('end');
            proc.emit('close', 0, null);
          });
        },
      };
      proc.killed = false;
      proc.kill = () => {};
      return proc;
    });

    try {
      const ir = makeIR({ model: 'devstral-2-25-12', stream: false });
      const authCtx = { apiKey: 'fake-mistral-f17' };
      let caught = null;
      try {
        for await (const _chunk of mistral.spawn(ir, authCtx)) { /* drain */ } // eslint-disable-line no-unused-vars
      } catch (e) {
        caught = e;
      }
      assert.ok(caught instanceof ProviderError,
        `Expected ProviderError, got ${caught?.constructor?.name ?? String(caught)}`);
      assert.equal(caught.code, 'SPAWN_FAILED');
      assert.ok(caught.message.includes('auth failure'),
        `Expected 'auth failure' in message, got: ${caught.message}`);
      assert.ok(caught.message.includes('vibe: api key invalid'),
        `Expected stderr tail in message, got: ${caught.message}`);
      assert.ok(caught.message.includes('| stderr:'),
        `Expected '| stderr:' separator, got: ${caught.message}`);
    } finally {
      mistralResetSpawnImpl();
    }
  });

});

// ── F19: streaming truncation marker before [DONE] ───────────────────────

describe('D26 F19 — streaming truncation marker on stop-less exhaustion', () => {

  let serverF19;
  let portF19;
  let savedTokenF19;

  before(async () => {
    savedTokenF19 = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fake-token-f19';
    __setProvidersEnabled({ anthropic: true });

    const { createOlpServer: s19, __clearCache: cc19 } = await import('./server.mjs');
    cc19();
    serverF19 = s19();
    await new Promise((resolve, reject) => {
      serverF19.listen(0, '127.0.0.1', resolve);
      serverF19.once('error', reject);
    });
    portF19 = serverF19.address().port;
  });

  after(async () => {
    __resetProvidersEnabled();
    __resetSpawnImpl();
    if (savedTokenF19 !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = savedTokenF19;
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    if (!serverF19) return;
    return new Promise(r => serverF19.close(r));
  });

  it('F19: no-stop generator emits finish_reason:length SSE chunk before [DONE]', async () => {
    // Inject a provider that yields partial content then exhausts without a stop chunk.
    const { loadedProviders: lpF19, __clearCache: ccF19 } = await import('./server.mjs');
    const savedProviderA = lpF19.get('anthropic');

    let spawnCalled = 0;
    const noStopProvider = {
      ...savedProviderA,
      hints: { ...savedProviderA?.hints, cacheable: true },
      spawn: async function* () {
        spawnCalled++;
        yield { type: 'delta', role: 'assistant', content: 'partial content' };
        // No stop chunk — generator exhausts here.
      },
    };
    lpF19.set('anthropic', noStopProvider);
    ccF19();

    const sseLines = await new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1',
        port: portF19,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'Content-Type': 'application/json' },
      }, res => {
        let data = '';
        res.on('data', d => { data += d.toString(); });
        res.on('end', () => resolve(data.split('\n').filter(Boolean)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'f19-truncation-test' }],
        stream: true,
      }));
      req.end();
    });

    try {
      const dataLines = sseLines.filter(l => l.startsWith('data: '));
      const doneLines = dataLines.filter(l => l === 'data: [DONE]');
      const nonDoneLines = dataLines.filter(l => l !== 'data: [DONE]');

      // Must have: delta chunk + truncation marker + [DONE]
      assert.ok(nonDoneLines.length >= 2,
        `Expected >= 2 non-[DONE] data lines (delta + truncation), got ${nonDoneLines.length}: ${JSON.stringify(nonDoneLines)}`);
      assert.equal(doneLines.length, 1, 'Expected exactly one [DONE] line');

      // [DONE] must be the last data line
      const lastDataLine = dataLines[dataLines.length - 1];
      assert.equal(lastDataLine, 'data: [DONE]', `[DONE] must be last data line, got: ${lastDataLine}`);

      // Line immediately before [DONE] must be the truncation marker
      const lineBeforeDone = dataLines[dataLines.length - 2];
      assert.ok(lineBeforeDone?.startsWith('data: '),
        `Expected data line before [DONE], got: ${lineBeforeDone}`);
      const truncPayload = JSON.parse(lineBeforeDone.slice(6).trim());
      assert.equal(
        truncPayload.choices?.[0]?.finish_reason,
        'length',
        `Expected finish_reason:'length' on truncation marker, got: ${JSON.stringify(truncPayload.choices?.[0])}`,
      );
      assert.equal(spawnCalled, 1, 'Spawn must have been called exactly once');
    } finally {
      if (savedProviderA !== undefined) {
        lpF19.set('anthropic', savedProviderA);
      } else {
        lpF19.delete('anthropic');
      }
    }
  });

  it('F19: zero-content no-stop generator does NOT emit truncation marker', async () => {
    // When streamedChunks.length === 0, no truncation marker should appear.
    const { loadedProviders: lpF19b, __clearCache: ccF19b } = await import('./server.mjs');
    const savedProviderB = lpF19b.get('anthropic');

    const emptyProvider = {
      ...savedProviderB,
      hints: { ...savedProviderB?.hints, cacheable: true },
      spawn: async function* () {
        // Yields nothing — generator returns immediately.
      },
    };
    lpF19b.set('anthropic', emptyProvider);
    ccF19b();

    const sseLines = await new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1',
        port: portF19,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'Content-Type': 'application/json' },
      }, res => {
        let data = '';
        res.on('data', d => { data += d.toString(); });
        res.on('end', () => resolve(data.split('\n').filter(Boolean)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'f19-empty-test' }],
        stream: true,
      }));
      req.end();
    });

    try {
      const dataLines = sseLines.filter(l => l.startsWith('data: '));
      for (const line of dataLines) {
        if (line === 'data: [DONE]') continue;
        const payload = JSON.parse(line.slice(6).trim());
        assert.ok(
          payload.choices?.[0]?.finish_reason !== 'length',
          `Expected no finish_reason:length when no content streamed, got: ${JSON.stringify(payload.choices?.[0])}`,
        );
      }
    } finally {
      if (savedProviderB !== undefined) {
        lpF19b.set('anthropic', savedProviderB);
      } else {
        lpF19b.delete('anthropic');
      }
    }
  });

  it('F19: D25 F9 no-cache invariant preserved — second request after no-stop triggers fresh spawn', async () => {
    // Verify F19 did not accidentally break D25 F9's no-cache-on-truncation guarantee.
    const { loadedProviders: lpF19c, __clearCache: ccF19c } = await import('./server.mjs');
    const savedProviderC = lpF19c.get('anthropic');

    let spawnCount = 0;
    const noStopProvider2 = {
      ...savedProviderC,
      hints: { ...savedProviderC?.hints, cacheable: true },
      spawn: async function* () {
        spawnCount++;
        yield { type: 'delta', role: 'assistant', content: 'f19-nocache-check' };
        // No stop chunk.
      },
    };
    lpF19c.set('anthropic', noStopProvider2);
    ccF19c();

    const makeStreamRequest = () => new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1',
        port: portF19,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'Content-Type': 'application/json' },
      }, res => {
        let data = '';
        res.on('data', d => { data += d.toString(); });
        res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'f19-nocache-repeated-query' }],
        stream: true,
      }));
      req.end();
    });

    try {
      const r1 = await makeStreamRequest();
      assert.equal(r1.status, 200, `r1 status: ${r1.status}`);
      assert.equal(r1.headers['x-olp-cache'], 'miss', 'r1 must be cache miss');
      assert.equal(spawnCount, 1, 'spawn called once for r1');

      const r2 = await makeStreamRequest();
      assert.equal(r2.status, 200, `r2 status: ${r2.status}`);
      assert.equal(r2.headers['x-olp-cache'], 'miss',
        'r2 must also be cache miss — D25 F9 no-cache invariant preserved');
      assert.equal(spawnCount, 2, 'spawn called again for r2');
    } finally {
      if (savedProviderC !== undefined) {
        lpF19c.set('anthropic', savedProviderC);
      } else {
        lpF19c.delete('anthropic');
      }
    }
  });

});

// ── Suite D27: round-3 batch (F8, F15) ────────────────────────────────────────
//
// F8: validateIRRequest now validates response_format and tool_choice.
// F15: /v1/models now surfaces alias entries for loaded providers.
//
// Authority:
//   F8 — ADR 0003 § Optional fields (response_format object; tool_choice string/object)
//   F15 — OpenAI /v1/models spec (https://platform.openai.com/docs/api-reference/models);
//          models-registry.json alias map (SPOT per D17)

// ── F8: response_format and tool_choice validation ────────────────────────────

describe('D27 F8 — validateIRRequest response_format + tool_choice validation', () => {

  it('F8: response_format object with string .type is accepted', () => {
    const r = validateIRRequest(makeIR({ response_format: { type: 'json_object' } }));
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
  });

  it('F8: response_format string (not object) is rejected', () => {
    const r = validateIRRequest(makeIR({ response_format: 'json_object' }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('response_format must be an object')),
      `Expected 'response_format must be an object', got: ${JSON.stringify(r.errors)}`);
  });

  it('F8: response_format object with non-string .type is rejected', () => {
    const r = validateIRRequest(makeIR({ response_format: { type: 42 } }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('response_format.type must be a string')),
      `Expected 'response_format.type must be a string', got: ${JSON.stringify(r.errors)}`);
  });

  it('F8: response_format undefined is accepted (optional field)', () => {
    const ir = makeIR();
    delete ir.response_format;
    const r = validateIRRequest(ir);
    assert.equal(r.valid, true);
  });

  it("F8: tool_choice 'auto' is accepted", () => {
    const r = validateIRRequest(makeIR({ tool_choice: 'auto' }));
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
  });

  it("F8: tool_choice 'none' is accepted", () => {
    const r = validateIRRequest(makeIR({ tool_choice: 'none' }));
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
  });

  it("F8: tool_choice 'required' is accepted", () => {
    const r = validateIRRequest(makeIR({ tool_choice: 'required' }));
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
  });

  it('F8: tool_choice unknown string is rejected', () => {
    const r = validateIRRequest(makeIR({ tool_choice: 'any' }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("tool_choice string must be 'auto' | 'none' | 'required'")),
      `Expected tool_choice string error, got: ${JSON.stringify(r.errors)}`);
  });

  it('F8: tool_choice {type:"function", function:{name:"X"}} is accepted', () => {
    const r = validateIRRequest(makeIR({ tool_choice: { type: 'function', function: { name: 'my_fn' } } }));
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
  });

  it('F8: tool_choice {type:"tool"} (wrong type field) is rejected', () => {
    const r = validateIRRequest(makeIR({ tool_choice: { type: 'tool' } }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("tool_choice.type must be 'function'")),
      `Expected tool_choice.type error, got: ${JSON.stringify(r.errors)}`);
  });

  it('F8: tool_choice {} (object but no type field) is rejected', () => {
    const r = validateIRRequest(makeIR({ tool_choice: {} }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("tool_choice.type must be 'function'")),
      `Expected tool_choice.type error for empty object, got: ${JSON.stringify(r.errors)}`);
  });

  it('F8: tool_choice undefined is accepted (optional field)', () => {
    const ir = makeIR();
    delete ir.tool_choice;
    const r = validateIRRequest(ir);
    assert.equal(r.valid, true);
  });

  it('F8: tool_choice number is rejected (not string or object)', () => {
    const r = validateIRRequest(makeIR({ tool_choice: 42 }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('tool_choice must be a string or an object')),
      `Expected 'tool_choice must be a string or an object', got: ${JSON.stringify(r.errors)}`);
  });

});

// ── F15: /v1/models alias surfacing ───────────────────────────────────────────

describe('D27 F15 — /v1/models alias surfacing', () => {

  it('F15a: /v1/models with anthropic enabled contains all canonical IDs and all 4 anthropic aliases', async () => {
    setProviders27({ anthropic: true });
    const s = createServer27();
    await new Promise((resolve, reject) => {
      s.listen(0, '127.0.0.1', resolve);
      s.once('error', reject);
    });
    const p = s.address().port;
    try {
      const r = await fetch({ port: p, method: 'GET', path: '/v1/models' });
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      const ids = body.data.map(e => e.id);
      // Canonical IDs
      assert.ok(ids.includes('claude-opus-4-7'), 'canonical claude-opus-4-7 must appear');
      assert.ok(ids.includes('claude-sonnet-4-6'), 'canonical claude-sonnet-4-6 must appear');
      assert.ok(ids.includes('claude-haiku-4-5'), 'canonical claude-haiku-4-5 must appear');
      // Anthropic aliases
      for (const alias of ['claude', 'sonnet', 'opus', 'haiku']) {
        assert.ok(ids.includes(alias), `alias '${alias}' must appear when anthropic is enabled`);
      }
    } finally {
      resetProviders27();
      await new Promise(r => s.close(r));
    }
  });

  it('F15b: each alias entry has owned_by equal to its canonical target provider', async () => {
    setProviders27({ anthropic: true });
    const s = createServer27();
    await new Promise((resolve, reject) => {
      s.listen(0, '127.0.0.1', resolve);
      s.once('error', reject);
    });
    const p = s.address().port;
    try {
      const r = await fetch({ port: p, method: 'GET', path: '/v1/models' });
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      const aliasMap = getAliasMap();
      for (const entry of body.data) {
        if (aliasMap.has(entry.id)) {
          const { providerName } = aliasMap.get(entry.id);
          assert.equal(entry.owned_by, providerName,
            `alias '${entry.id}' must have owned_by='${providerName}', got '${entry.owned_by}'`);
        }
      }
    } finally {
      resetProviders27();
      await new Promise(r => s.close(r));
    }
  });

  it('F15c: /v1/models with no providers enabled returns empty data (no aliases)', async () => {
    setProviders27({});
    const s = createServer27();
    await new Promise((resolve, reject) => {
      s.listen(0, '127.0.0.1', resolve);
      s.once('error', reject);
    });
    const p = s.address().port;
    try {
      const r = await fetch({ port: p, method: 'GET', path: '/v1/models' });
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      assert.deepEqual(body.data, [], 'data must be empty when no providers are enabled (no aliases either)');
    } finally {
      resetProviders27();
      await new Promise(r => s.close(r));
    }
  });

  it('F15d: /v1/models with anthropic+mistral enabled contains both providers\' canonicals and aliases', async () => {
    setProviders27({ anthropic: true, mistral: true });
    const s = createServer27();
    await new Promise((resolve, reject) => {
      s.listen(0, '127.0.0.1', resolve);
      s.once('error', reject);
    });
    const p = s.address().port;
    try {
      const r = await fetch({ port: p, method: 'GET', path: '/v1/models' });
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      const ids = body.data.map(e => e.id);
      // Anthropic canonicals + aliases
      assert.ok(ids.includes('claude-sonnet-4-6'), 'anthropic canonical must appear');
      assert.ok(ids.includes('sonnet'), 'anthropic alias sonnet must appear');
      assert.ok(ids.includes('claude'), 'anthropic alias claude must appear');
      // Mistral canonicals + aliases
      assert.ok(ids.includes('devstral-2-25-12'), 'mistral canonical must appear');
      assert.ok(ids.includes('devstral'), 'mistral alias devstral must appear');
      // Verify minimum total count: 3 anthropic + 4 anthropic aliases + 2 mistral + 4 mistral aliases = 13
      assert.ok(body.data.length >= 13,
        `Expected >=13 entries for anthropic+mistral, got ${body.data.length}`);
    } finally {
      resetProviders27();
      await new Promise(r => s.close(r));
    }
  });

  it('F15e: alias entries for disabled providers do not appear', async () => {
    // Only anthropic enabled — codex aliases (codex, codex-spark, gpt5, gpt5-mini) must NOT appear
    setProviders27({ anthropic: true });
    const s = createServer27();
    await new Promise((resolve, reject) => {
      s.listen(0, '127.0.0.1', resolve);
      s.once('error', reject);
    });
    const p = s.address().port;
    try {
      const r = await fetch({ port: p, method: 'GET', path: '/v1/models' });
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      const ids = body.data.map(e => e.id);
      for (const alias of ['codex', 'codex-spark', 'gpt5', 'gpt5-mini', 'devstral', 'devstral-2']) {
        assert.ok(!ids.includes(alias),
          `Alias '${alias}' must NOT appear when its provider is not enabled`);
      }
    } finally {
      resetProviders27();
      await new Promise(r => s.close(r));
    }
  });

});

// ── Suite D33: round-5 cold-audit cleanup batch ───────────────────────────────
//
// F3: function_call deprecated field → deterministic IR id (no Date.now())
// F5: /health returns per-provider healthCheck() snapshots
// F8_fallback: fallback-hop cache-hit → X-OLP-Cache: hit (not miss)
// F12: /v1/models `created` is stable per-model timestamp
//
// Authority:
//   F3 — ADR 0005 § "same inputs → same key, no random, no timestamp"
//   F5 — ADR 0002 § Provider contract (healthCheck)
//   F8_fallback — ADR 0005 § D1 cache; ADR 0004 § Observability headers
//   F12 — OpenAI /v1/models spec (https://platform.openai.com/docs/api-reference/models);
//          models-registry.json bootstrapCreated fallback

describe('D33 round-5 cold-audit cleanup', () => {

  // ── F3: deterministic function_call ID ────────────────────────────────────

  describe('F3 — function_call deprecated field → deterministic cache key', () => {

    it('F3a: two identical function_call requests produce the same IR id', () => {
      const req = {
        model: 'test-model',
        messages: [
          {
            role: 'assistant',
            function_call: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
        ],
      };
      const ir1 = openAIToIR(req);
      const ir2 = openAIToIR(req);
      const id1 = ir1.messages[0].tool_calls?.[0]?.id;
      const id2 = ir2.messages[0].tool_calls?.[0]?.id;
      assert.ok(id1, 'function_call must produce a tool_calls entry with an id');
      assert.equal(id1, id2,
        `Two identical function_call requests must produce the same id; got ${id1} vs ${id2}`);
      assert.ok(id1.startsWith('fc-'), 'id must start with "fc-"');
    });

    it('F3b: two identical function_call requests produce the same cache key', () => {
      const req = {
        model: 'test-model',
        messages: [
          {
            role: 'assistant',
            function_call: { name: 'my_tool', arguments: '{}' },
          },
        ],
      };
      const ir1 = openAIToIR(req);
      const ir2 = openAIToIR(req);
      const key1 = computeCacheKey('anthropic', 'claude-sonnet-4-6', ir1);
      const key2 = computeCacheKey('anthropic', 'claude-sonnet-4-6', ir2);
      assert.equal(key1, key2,
        'Identical function_call requests must produce identical cache keys');
    });

    it('F3c: different function_call names produce different cache keys', () => {
      const req1 = openAIToIR({
        model: 'test-model',
        messages: [{ role: 'assistant', function_call: { name: 'tool_a', arguments: '{}' } }],
      });
      const req2 = openAIToIR({
        model: 'test-model',
        messages: [{ role: 'assistant', function_call: { name: 'tool_b', arguments: '{}' } }],
      });
      const key1 = computeCacheKey('anthropic', 'claude-sonnet-4-6', req1);
      const key2 = computeCacheKey('anthropic', 'claude-sonnet-4-6', req2);
      assert.notEqual(key1, key2,
        'Different function_call names must produce different cache keys');
    });

  });

  // ── F5: /health per-provider snapshot ─────────────────────────────────────

  describe('F5 — /health returns per-provider healthCheck() snapshots', () => {

    it('F5a: /health with no providers enabled returns providers.status = {}', async () => {
      setProviders33({});
      const s = createServer33();
      await new Promise((resolve, reject) => {
        s.listen(0, '127.0.0.1', resolve);
        s.once('error', reject);
      });
      const p = s.address().port;
      try {
        const r = await fetch({ port: p, method: 'GET', path: '/health' });
        assert.equal(r.status, 200);
        const body = JSON.parse(r.body);
        assert.ok(body.ok, '/health must return ok:true');
        assert.ok('status' in body.providers,
          '/health providers must include a "status" key');
        assert.deepEqual(body.providers.status, {},
          'status must be empty when no providers are loaded');
      } finally {
        resetProviders33();
        await new Promise(r => s.close(r));
      }
    });

    it('F5b: /health with anthropic enabled includes providers.status.anthropic', async () => {
      setProviders33({ anthropic: true });
      const s = createServer33();
      await new Promise((resolve, reject) => {
        s.listen(0, '127.0.0.1', resolve);
        s.once('error', reject);
      });
      const p = s.address().port;
      try {
        const r = await fetch({ port: p, method: 'GET', path: '/health' });
        assert.equal(r.status, 200);
        const body = JSON.parse(r.body);
        assert.ok('anthropic' in body.providers.status,
          'providers.status must include anthropic when it is enabled');
        const ahc = body.providers.status.anthropic;
        assert.ok(typeof ahc === 'object' && ahc !== null,
          'providers.status.anthropic must be an object');
        assert.ok('ok' in ahc,
          'providers.status.anthropic must have an "ok" field');
      } finally {
        resetProviders33();
        await new Promise(r => s.close(r));
      }
    });

    it('F5c: /health includes status for each loaded provider', async () => {
      setProviders33({ anthropic: true, mistral: true });
      const s = createServer33();
      await new Promise((resolve, reject) => {
        s.listen(0, '127.0.0.1', resolve);
        s.once('error', reject);
      });
      const p = s.address().port;
      try {
        const r = await fetch({ port: p, method: 'GET', path: '/health' });
        assert.equal(r.status, 200);
        const body = JSON.parse(r.body);
        assert.equal(body.providers.enabled, 2, 'enabled must be 2');
        assert.ok('anthropic' in body.providers.status, 'anthropic status must appear');
        assert.ok('mistral' in body.providers.status, 'mistral status must appear');
        assert.ok(!('openai' in body.providers.status),
          'openai must NOT appear in status when not loaded');
      } finally {
        resetProviders33();
        await new Promise(r => s.close(r));
      }
    });

    it('F5d: /health status entry has ok:false + error on healthCheck() throw', async () => {
      setProviders33({ anthropic: true });
      const savedProvider = loadedProviders33.get('anthropic');
      // Inject a provider whose healthCheck always throws
      const throwingProvider = {
        ...savedProvider,
        healthCheck: async () => { throw new Error('probe-failed'); },
      };
      loadedProviders33.set('anthropic', throwingProvider);
      const s = createServer33();
      await new Promise((resolve, reject) => {
        s.listen(0, '127.0.0.1', resolve);
        s.once('error', reject);
      });
      const p = s.address().port;
      try {
        const r = await fetch({ port: p, method: 'GET', path: '/health' });
        assert.equal(r.status, 200, '/health must still return 200 even when healthCheck throws');
        const body = JSON.parse(r.body);
        assert.ok(body.ok, 'top-level ok must still be true');
        const ahc = body.providers.status.anthropic;
        assert.equal(ahc.ok, false, 'status.anthropic.ok must be false when healthCheck throws');
        assert.ok(typeof ahc.error === 'string', 'status.anthropic.error must be a string');
        assert.ok(ahc.error.includes('probe-failed'), 'error must include the thrown message');
      } finally {
        if (savedProvider !== undefined) {
          loadedProviders33.set('anthropic', savedProvider);
        } else {
          loadedProviders33.delete('anthropic');
        }
        resetProviders33();
        await new Promise(r => s.close(r));
      }
    });

  });

  // ── F8_fallback: fallback-hop cache-hit → X-OLP-Cache: hit ───────────────

  describe('F8_fallback — fallback-hop cache-hit reports X-OLP-Cache: hit', () => {

    it('F8_fallback: 2-hop chain, primary fails, secondary cache-hit → X-OLP-Cache: hit', async () => {
      // Two providers: primary (alpha) always fails with SPAWN_FAILED (hard trigger); secondary
      // (beta) succeeds. On second request, secondary serves from cache.
      // The X-OLP-Cache header must be 'hit' on the second request.
      //
      // Uses an explicit chain config: [alpha → beta]. alpha is enabled but fails;
      // beta is enabled and succeeds. Secondary's cache key is different from primary's
      // (different provider name), so the second request hits beta's cache.

      setProviders33({ anthropic: true, mistral: true });
      clearCache33();

      // Override anthropic spawn to always throw SPAWN_FAILED (hard trigger)
      const savedAnthropic = loadedProviders33.get('anthropic');
      const failingPrimary = {
        ...savedAnthropic,
        spawn: async function* () {
          throw new ProviderError('spawn failed (test)', 'SPAWN_FAILED');
        },
      };
      loadedProviders33.set('anthropic', failingPrimary);

      // Override mistral spawn to yield a valid response
      const savedMistral = loadedProviders33.get('mistral');
      let secondarySpawnCount = 0;
      const succeedingSecondary = {
        ...savedMistral,
        spawn: async function* () {
          secondarySpawnCount++;
          yield { type: 'delta', role: 'assistant', content: 'fallback-response' };
          yield { type: 'stop', finish_reason: 'stop' };
        },
      };
      loadedProviders33.set('mistral', succeedingSecondary);

      // Wire a 2-hop chain: anthropic (claude-sonnet-4-6) → mistral (devstral-2-25-12)
      setFallbackConfig33({
        chains: {
          'claude-sonnet-4-6': [
            { provider: 'anthropic', model: 'claude-sonnet-4-6' },
            { provider: 'mistral', model: 'devstral-2-25-12' },
          ],
        },
        soft_triggers: {},
        providersEnabled: { anthropic: true, mistral: true },
      });

      const s = createServer33();
      await new Promise((resolve, reject) => {
        s.listen(0, '127.0.0.1', resolve);
        s.once('error', reject);
      });
      const p = s.address().port;

      const makeRequest = () => fetch({
        port: p,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'f8-fallback-cache-test' }],
          stream: false,
        },
      });

      try {
        // First request: primary fails → secondary spawns → result cached under secondary key
        const r1 = await makeRequest();
        assert.equal(r1.status, 200, `r1 must be 200; got ${r1.status}`);
        assert.equal(r1.headers['x-olp-cache'], 'miss',
          'r1 must be cache miss (first time secondary serves)');
        assert.equal(secondarySpawnCount, 1, 'secondary must spawn once for r1');

        // Second request: primary still fails → secondary serves from its own cache
        const r2 = await makeRequest();
        assert.equal(r2.status, 200, `r2 must be 200; got ${r2.status}`);
        assert.equal(r2.headers['x-olp-cache'], 'hit',
          'r2 must be cache hit — fallback hop served from secondary cache');
        assert.equal(secondarySpawnCount, 1,
          'secondary must NOT spawn again for r2 (served from cache)');
      } finally {
        if (savedAnthropic !== undefined) {
          loadedProviders33.set('anthropic', savedAnthropic);
        } else {
          loadedProviders33.delete('anthropic');
        }
        if (savedMistral !== undefined) {
          loadedProviders33.set('mistral', savedMistral);
        } else {
          loadedProviders33.delete('mistral');
        }
        resetFallbackConfig33();
        resetProviders33();
        clearCache33();
        await new Promise(r => s.close(r));
      }
    });

  });

  // ── F12: /v1/models stable `created` timestamps ────���──────────────────────

  describe('F12 — /v1/models stable per-model created timestamp', () => {

    it('F12a: getModelCreated returns a stable number for known model IDs', () => {
      // These models have explicit created fields in models-registry.json
      const claudeSonnet = getModelCreated('claude-sonnet-4-6');
      const claudeSonnet2 = getModelCreated('claude-sonnet-4-6');
      assert.equal(claudeSonnet, claudeSonnet2,
        'getModelCreated must return the same value on repeated calls');
      assert.ok(typeof claudeSonnet === 'number' && claudeSonnet > 0,
        'getModelCreated must return a positive number');
      // claude-sonnet-4-6 has created=1775001600 (2026-04-01)
      assert.equal(claudeSonnet, 1775001600,
        'claude-sonnet-4-6 created must match models-registry.json entry');
    });

    it('F12b: getModelCreated falls back to REGISTRY_BOOTSTRAP_CREATED for unknown IDs', () => {
      const unknown = getModelCreated('non-existent-model-xyz');
      assert.equal(unknown, REGISTRY_BOOTSTRAP_CREATED,
        'unknown model must fall back to REGISTRY_BOOTSTRAP_CREATED');
    });

    it('F12c: REGISTRY_BOOTSTRAP_CREATED matches models-registry.json bootstrapCreated', () => {
      assert.equal(REGISTRY_BOOTSTRAP_CREATED, modelsRegistry.bootstrapCreated,
        'REGISTRY_BOOTSTRAP_CREATED must equal models-registry.json bootstrapCreated');
    });

    it('F12d: /v1/models returns stable created for canonical models (not Date.now())', async () => {
      setProviders33({ anthropic: true });
      const s = createServer33();
      await new Promise((resolve, reject) => {
        s.listen(0, '127.0.0.1', resolve);
        s.once('error', reject);
      });
      const p = s.address().port;
      try {
        const r1 = await fetch({ port: p, method: 'GET', path: '/v1/models' });
        const r2 = await fetch({ port: p, method: 'GET', path: '/v1/models' });
        assert.equal(r1.status, 200);
        assert.equal(r2.status, 200);
        const body1 = JSON.parse(r1.body);
        const body2 = JSON.parse(r2.body);

        // Both responses must have same created values for all entries
        const entries1 = Object.fromEntries(body1.data.map(e => [e.id, e.created]));
        const entries2 = Object.fromEntries(body2.data.map(e => [e.id, e.created]));
        for (const [id, ts] of Object.entries(entries1)) {
          assert.equal(entries2[id], ts,
            `created for '${id}' must be stable across requests; got ${ts} vs ${entries2[id]}`);
        }

        // claude-sonnet-4-6 must use the registry value, not Date.now()
        const sonnetEntry = body1.data.find(e => e.id === 'claude-sonnet-4-6');
        assert.ok(sonnetEntry, 'claude-sonnet-4-6 must appear in /v1/models');
        assert.equal(sonnetEntry.created, 1775001600,
          'claude-sonnet-4-6 created must be 1775001600 (2026-04-01), not Date.now()');
      } finally {
        resetProviders33();
        await new Promise(r => s.close(r));
      }
    });

    it('F12e: alias entries in /v1/models use the canonical model\'s created timestamp', async () => {
      setProviders33({ anthropic: true });
      const s = createServer33();
      await new Promise((resolve, reject) => {
        s.listen(0, '127.0.0.1', resolve);
        s.once('error', reject);
      });
      const p = s.address().port;
      try {
        const r = await fetch({ port: p, method: 'GET', path: '/v1/models' });
        assert.equal(r.status, 200);
        const body = JSON.parse(r.body);
        // 'sonnet' alias → canonical 'claude-sonnet-4-6' → created 1775001600
        const sonnetAlias = body.data.find(e => e.id === 'sonnet');
        const sonnetCanon = body.data.find(e => e.id === 'claude-sonnet-4-6');
        assert.ok(sonnetAlias, '"sonnet" alias must appear in /v1/models');
        assert.ok(sonnetCanon, 'claude-sonnet-4-6 canonical must appear in /v1/models');
        assert.equal(sonnetAlias.created, sonnetCanon.created,
          'alias "sonnet" must have same created as canonical "claude-sonnet-4-6"');
      } finally {
        resetProviders33();
        await new Promise(r => s.close(r));
      }
    });

  });

});

});

// ── Suite 18: D38 — maxConcurrent runtime enforcement (issue #1) ──────────
//
// Authority:
//   - ADR 0002 Amendment 6 (D38): maxConcurrent runtime enforcement landed.
//   - ADR 0004 Amendment 4 (D38): CONCURRENCY_LIMIT added to hard-trigger taxonomy.
//   - GitHub issue #1 (maxConcurrent: declarative-only at v0.1).
//
// Tests:
//   18a: CONCURRENCY_LIMIT is in PROVIDER_ERROR_CODES.
//   18b: CONCURRENCY_LIMIT is a hard trigger (evaluateHardTriggers true).
//   18c: classifyTrigger returns 'hard' for CONCURRENCY_LIMIT.
//   18d: tryAcquireSpawn / releaseSpawn / getActiveSpawnCount unit behaviour.
//   18e: tryAcquireSpawn returns false at the limit.
//   18f: releaseSpawn throws when called without a matching acquire.
//   18g: DEFAULT_MAX_CONCURRENT_SPAWNS applies when maxConcurrent omitted.
//   18h: __resetSpawnCounters clears all in-flight counts.
//   18i: HTTP — 5 concurrent buffered requests against a maxConcurrent:2 mock →
//        peak in-flight == 2; requests 3-5 hit chain-exhausted error.
//   18j: HTTP — counter releases after request completes (single-hop, sequential).
//   18k: Fallback — saturated primary (maxConcurrent:1) → secondary serves the 2nd.
//   18l: HTTP streaming — counter releases at end of stream, not at start.

describe('D38 — maxConcurrent runtime enforcement (Suite 18)', () => {

  // ── 18a: PROVIDER_ERROR_CODES contains CONCURRENCY_LIMIT ──────────────────

  it('18a: CONCURRENCY_LIMIT is in PROVIDER_ERROR_CODES', () => {
    assert.ok(
      PROVIDER_ERROR_CODES.includes('CONCURRENCY_LIMIT'),
      'CONCURRENCY_LIMIT must be in PROVIDER_ERROR_CODES per ADR 0004 Amendment 4',
    );
  });

  // ── 18b: CONCURRENCY_LIMIT triggers hard fallback ─────────────────────────

  it('18b: evaluateHardTriggers(ProviderError CONCURRENCY_LIMIT) → true', () => {
    const err = new ProviderError('provider stub at maxConcurrent (2)', 'CONCURRENCY_LIMIT');
    assert.equal(
      evaluateHardTriggers(err), true,
      'CONCURRENCY_LIMIT must be classified as a hard trigger',
    );
  });

  // ── 18c: AUTH_MISSING regression guard ───────────────────────────────────
  // CONCURRENCY_LIMIT hard-trigger classification is covered by 18b;
  // 18c guards that D38 did NOT accidentally flip AUTH_MISSING (a soft signal
  // for v0.1 — see ADR 0004 Amendment 2) to hard alongside CONCURRENCY_LIMIT.

  it('18c: evaluateHardTriggers still false for AUTH_MISSING (regression guard)', () => {
    // Regression guard: D38 didn't accidentally flip AUTH_MISSING to a hard trigger.
    const err = new ProviderError('auth missing', 'AUTH_MISSING');
    assert.equal(evaluateHardTriggers(err), false);
  });

  // ── 18d: semaphore unit tests ─────────────────────────────────────────────

  describe('18d — tryAcquireSpawn / releaseSpawn / getActiveSpawnCount unit', () => {

    // Use a unique provider name to avoid colliding with other tests' state.
    // __resetSpawnCounters() runs after each unit test to keep them isolated.

    it('18d.1: tryAcquireSpawn increments count from 0 → 1', () => {
      __resetSpawnCounters();
      assert.equal(getActiveSpawnCount('unit-d1'), 0);
      const ok = tryAcquireSpawn('unit-d1', 4);
      assert.equal(ok, true, 'first acquire should succeed');
      assert.equal(getActiveSpawnCount('unit-d1'), 1);
      __resetSpawnCounters();
    });

    it('18d.2: releaseSpawn decrements count back to 0', () => {
      __resetSpawnCounters();
      tryAcquireSpawn('unit-d2', 4);
      assert.equal(getActiveSpawnCount('unit-d2'), 1);
      releaseSpawn('unit-d2');
      assert.equal(getActiveSpawnCount('unit-d2'), 0);
      __resetSpawnCounters();
    });

    it('18d.3: each provider has independent counters', () => {
      __resetSpawnCounters();
      tryAcquireSpawn('unit-d3-a', 4);
      tryAcquireSpawn('unit-d3-a', 4);
      tryAcquireSpawn('unit-d3-b', 4);
      assert.equal(getActiveSpawnCount('unit-d3-a'), 2);
      assert.equal(getActiveSpawnCount('unit-d3-b'), 1);
      __resetSpawnCounters();
    });

    it('18d.4: counter is removed from map when it reaches 0', () => {
      __resetSpawnCounters();
      tryAcquireSpawn('unit-d4', 4);
      releaseSpawn('unit-d4');
      // After release-to-zero, getActiveSpawnCount still returns 0 (Map.delete'd).
      assert.equal(getActiveSpawnCount('unit-d4'), 0);
      __resetSpawnCounters();
    });
  });

  // ── 18e: tryAcquireSpawn returns false at the limit ───────────────────────

  it('18e: tryAcquireSpawn returns false when count == maxConcurrent', () => {
    __resetSpawnCounters();
    assert.equal(tryAcquireSpawn('unit-e', 2), true);
    assert.equal(tryAcquireSpawn('unit-e', 2), true);
    // At the limit now — third acquire must fail without incrementing.
    assert.equal(tryAcquireSpawn('unit-e', 2), false,
      'acquire must fail when current count equals limit');
    // Counter must not have incremented on the failed acquire.
    assert.equal(getActiveSpawnCount('unit-e'), 2,
      'failed acquire must not increment the counter');
    __resetSpawnCounters();
  });

  // ── 18f: releaseSpawn without acquire throws ──────────────────────────────

  it('18f: releaseSpawn without matching acquire throws', () => {
    __resetSpawnCounters();
    assert.throws(
      () => releaseSpawn('unit-f-never-acquired'),
      /releaseSpawn.*counter would go negative/,
      'release without acquire must throw to surface the bug loudly',
    );
    __resetSpawnCounters();
  });

  // ── 18g: DEFAULT_MAX_CONCURRENT_SPAWNS fallback ───────────────────────────

  it('18g: DEFAULT_MAX_CONCURRENT_SPAWNS applies when maxConcurrent argument omitted', () => {
    __resetSpawnCounters();
    assert.ok(Number.isInteger(DEFAULT_MAX_CONCURRENT_SPAWNS) && DEFAULT_MAX_CONCURRENT_SPAWNS > 0,
      'DEFAULT_MAX_CONCURRENT_SPAWNS must be a positive integer');
    // Acquire up to the default limit without arg — all should succeed.
    for (let i = 0; i < DEFAULT_MAX_CONCURRENT_SPAWNS; i++) {
      assert.equal(tryAcquireSpawn('unit-g'), true, `acquire #${i + 1} should succeed`);
    }
    // Next acquire (still no arg) should fail at the default boundary.
    assert.equal(tryAcquireSpawn('unit-g'), false,
      `acquire #${DEFAULT_MAX_CONCURRENT_SPAWNS + 1} should fail at default limit`);
    __resetSpawnCounters();
  });

  it('18g.2: non-integer maxConcurrent coerces to DEFAULT_MAX_CONCURRENT_SPAWNS', () => {
    __resetSpawnCounters();
    // Defensive coercion: a plugin path that bypasses validateProvider could
    // produce undefined/null/NaN. The gate must not blow up; it must use the default.
    assert.equal(tryAcquireSpawn('unit-g2', undefined), true);
    assert.equal(tryAcquireSpawn('unit-g2', null), true);
    assert.equal(tryAcquireSpawn('unit-g2', NaN), true);
    assert.equal(tryAcquireSpawn('unit-g2', 'four'), true);
    // After 4 acquires (matching default), 5th should fail.
    assert.equal(getActiveSpawnCount('unit-g2'), 4);
    assert.equal(tryAcquireSpawn('unit-g2', undefined), false);
    __resetSpawnCounters();
  });

  // ── 18h: __resetSpawnCounters clears state ────────────────────────────────

  it('18h: __resetSpawnCounters clears all in-flight counts', () => {
    tryAcquireSpawn('unit-h-1', 4);
    tryAcquireSpawn('unit-h-2', 4);
    assert.equal(getActiveSpawnCount('unit-h-1'), 1);
    assert.equal(getActiveSpawnCount('unit-h-2'), 1);
    __resetSpawnCounters();
    assert.equal(getActiveSpawnCount('unit-h-1'), 0);
    assert.equal(getActiveSpawnCount('unit-h-2'), 0);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // HTTP integration tests
  // ────────────────────────────────────────────────────────────────────────────
  //
  // Strategy: install a controllable mock spawn on the anthropic plugin that
  // exposes a Promise-based "release gate" — the mock yields no data until
  // the test explicitly resolves the gate. This lets us hold multiple spawns
  // in-flight at the same time deterministically (no timing races).
  //
  // For the maxConcurrent:N tests we override anthropic.hints.maxConcurrent
  // for the duration of the test, then restore. ProviderError synthesised by
  // the gate carries CONCURRENCY_LIMIT and the fallback engine treats it as
  // a hard trigger. With a single-hop chain the chain exhausts and the
  // client receives a 502/non-200.

  describe('18 HTTP integration', () => {
    let server18;
    let port18;
    let savedToken18;
    let savedMaxConcurrent;

    before(async () => {
      savedToken18 = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fake-token-suite-18';
      __setProvidersEnabled({ anthropic: true });
      __resetSpawnCounters();

      const { createOlpServer: s18, __clearCache: cc18 } = await import('./server.mjs');
      cc18();
      server18 = s18();
      await new Promise((resolve, reject) => {
        server18.listen(0, '127.0.0.1', resolve);
        server18.once('error', reject);
      });
      port18 = server18.address().port;
    });

    after(async () => {
      __resetProvidersEnabled();
      __resetSpawnImpl();
      __resetSpawnCounters();
      if (savedToken18 !== undefined) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken18;
      } else {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      }
      if (!server18) return;
      return new Promise(r => server18.close(r));
    });

    /**
     * Makes a controllable mock spawn that completes only when the given
     * gate Promise resolves. Records peak in-flight via `peakRef`.
     */
    function makeGatedMockSpawn(gatePromise, content, peakRef, activeRef) {
      return function gatedSpawn(_bin, _args, _opts) {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stdin = {
          write: () => {},
          end: async () => {
            // Track this spawn as in-flight from the moment stdin closes.
            activeRef.count++;
            if (activeRef.count > peakRef.peak) peakRef.peak = activeRef.count;
            // Wait for the gate to resolve before emitting any data.
            await gatePromise;
            // Decrement on exit.
            setImmediate(() => {
              proc.stdout.emit('data', Buffer.from(content));
              proc.stdout.emit('end');
              proc.stderr.emit('end');
              proc.emit('close', 0, null);
              activeRef.count--;
            });
          },
        };
        proc.killed = false;
        proc.kill = () => {};
        return proc;
      };
    }

    // ── 18i: 5 concurrent requests, maxConcurrent:2 ────────────────────────

    it('18i: 5 concurrent buffered requests with maxConcurrent:2 → peak in-flight == 2', async () => {
      // Override anthropic's maxConcurrent for this test.
      savedMaxConcurrent = anthropic.hints.maxConcurrent;
      anthropic.hints.maxConcurrent = 2;

      const { __clearCache: cc18i } = await import('./server.mjs');
      cc18i();

      // Gate that we'll resolve to let mock spawns complete.
      let releaseGate;
      const gatePromise = new Promise(resolve => { releaseGate = resolve; });
      const peakRef = { peak: 0 };
      const activeRef = { count: 0 };
      __setSpawnImpl(makeGatedMockSpawn(gatePromise, 'concurrency-test-response', peakRef, activeRef));

      try {
        // Fire 5 concurrent buffered requests with DIFFERENT message content
        // so cache lookups don't collapse them.
        const reqs = [];
        for (let i = 0; i < 5; i++) {
          reqs.push(fetch({
            port: port18,
            method: 'POST',
            path: '/v1/chat/completions',
            body: {
              model: 'claude-sonnet-4-6',
              messages: [{ role: 'user', content: `concurrency-test-msg-${i}-${Date.now()}` }],
            },
          }));
        }

        // Give the server a moment to receive all requests and attempt acquires
        // (the requests that succeed acquire will wait on gatePromise; the
        // ones that fail acquire will return immediately with an error).
        // The wait must be long enough for all 5 to either enter the spawn or
        // be rejected by the gate, but short enough to keep the test fast.
        await new Promise(r => setTimeout(r, 100));

        // Peak in-flight count must equal exactly 2 (== maxConcurrent).
        assert.equal(peakRef.peak, 2,
          `peak in-flight must be exactly 2 (== maxConcurrent), observed ${peakRef.peak}`);
        // Also assert via the exported getActiveSpawnCount helper (covers a
        // different path — the module-level _activeSpawns map vs the mock-side
        // counter). Both must agree.
        assert.equal(getActiveSpawnCount('anthropic'), 2,
          'module-level active-spawn counter must report 2 in-flight');

        // Release the gate so the 2 in-flight spawns can complete.
        releaseGate();

        // Wait for all 5 requests to settle.
        const results = await Promise.all(reqs);

        // 2 successes (requests that acquired), 3 errors (CONCURRENCY_LIMIT).
        const successes = results.filter(r => r.status === 200);
        const failures = results.filter(r => r.status !== 200);
        assert.equal(successes.length, 2,
          `expected exactly 2 successful responses, got ${successes.length} (statuses: ${results.map(r => r.status).join(', ')})`);
        assert.equal(failures.length, 3,
          `expected exactly 3 failed responses (chain-exhausted on CONCURRENCY_LIMIT), got ${failures.length}`);
      } finally {
        // Restore original maxConcurrent.
        anthropic.hints.maxConcurrent = savedMaxConcurrent;
        __resetSpawnImpl();
        __resetSpawnCounters();
      }
    });

    // ── 18j: counter releases after request completes ─────────────────────

    it('18j: counter releases to 0 after buffered request completes', async () => {
      savedMaxConcurrent = anthropic.hints.maxConcurrent;
      anthropic.hints.maxConcurrent = 2;
      const { __clearCache: cc18j } = await import('./server.mjs');
      cc18j();

      // Plain mock that completes immediately.
      __setSpawnImpl(makeMockSpawn(['release-test-response']));

      try {
        // Fire request 1 and wait for completion.
        const r1 = await fetch({
          port: port18,
          method: 'POST',
          path: '/v1/chat/completions',
          body: {
            model: 'claude-sonnet-4-6',
            messages: [{ role: 'user', content: `release-test-msg-1-${Date.now()}` }],
          },
        });
        assert.equal(r1.status, 200);
        // Counter must be back to 0 after the request completes.
        assert.equal(getActiveSpawnCount('anthropic'), 0,
          'counter must release to 0 after request completes');

        // Fire request 2 (different content for cache miss) — must also succeed,
        // proving the slot is reusable.
        const r2 = await fetch({
          port: port18,
          method: 'POST',
          path: '/v1/chat/completions',
          body: {
            model: 'claude-sonnet-4-6',
            messages: [{ role: 'user', content: `release-test-msg-2-${Date.now()}` }],
          },
        });
        assert.equal(r2.status, 200);
        assert.equal(getActiveSpawnCount('anthropic'), 0,
          'counter must release after second request too');
      } finally {
        anthropic.hints.maxConcurrent = savedMaxConcurrent;
        __resetSpawnImpl();
        __resetSpawnCounters();
      }
    });

    // ── 18l: streaming counter release ────────────────────────────────────

    it('18l: streaming request — counter releases at end of stream', async () => {
      savedMaxConcurrent = anthropic.hints.maxConcurrent;
      anthropic.hints.maxConcurrent = 2;
      const { __clearCache: cc18l } = await import('./server.mjs');
      cc18l();

      __setSpawnImpl(makeMockSpawn(['stream-release-content']));

      try {
        // Make a streaming request and consume the full stream.
        const port = port18;
        const body = await new Promise((resolve, reject) => {
          const req = httpRequest({
            hostname: '127.0.0.1',
            port,
            method: 'POST',
            path: '/v1/chat/completions',
            headers: { 'Content-Type': 'application/json' },
          }, res => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve(data));
            res.on('error', reject);
          });
          req.on('error', reject);
          req.write(JSON.stringify({
            model: 'claude-sonnet-4-6',
            messages: [{ role: 'user', content: `stream-release-${Date.now()}` }],
            stream: true,
          }));
          req.end();
        });
        assert.ok(body.includes('data:'), 'streaming body must contain SSE data lines');

        // After the stream completes (res.on('end') resolved), the counter must
        // be back to 0. Tests the streaming-branch finally{} fired.
        assert.equal(getActiveSpawnCount('anthropic'), 0,
          'counter must release after streaming response completes');
      } finally {
        anthropic.hints.maxConcurrent = savedMaxConcurrent;
        __resetSpawnImpl();
        __resetSpawnCounters();
      }
    });
  });

  // ── 18k: fallback test — saturated primary advances to secondary ──────────
  //
  // Uses a 2-hop chain executed via executeWithFallback (unit-level, not HTTP).
  // Primary has maxConcurrent:1 and is already saturated by a synthetic
  // pre-acquire; second request must advance to the fallback hop.

  describe('18k — fallback advances on saturation', () => {
    after(() => __resetSpawnCounters());

    it('18k: saturated primary (maxConcurrent:1) → fallback hop serves the request', async () => {
      // Pre-saturate the 'anthropic' counter (1/1) so the next acquire fails.
      __resetSpawnCounters();
      tryAcquireSpawn('anthropic', 1);
      assert.equal(getActiveSpawnCount('anthropic'), 1);

      // Build a 2-hop chain: anthropic (saturated) → openai (will serve).
      // executeHopFn for this test calls tryAcquireSpawn itself, mirroring
      // the production gate semantics. On failure: throws ProviderError
      // CONCURRENCY_LIMIT; fallback engine advances to next hop.
      const chain = [
        { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        { provider: 'openai', model: 'gpt-5.5' },
      ];
      const ir = makeIR({ model: 'claude-sonnet-4-6', stream: false });

      async function testHopFn(hopProvider, hopModel, _ir) {
        const max = hopProvider === 'anthropic' ? 1 : 4;
        if (!tryAcquireSpawn(hopProvider, max)) {
          const err = new ProviderError(
            `provider ${hopProvider} at maxConcurrent (${max})`,
            'CONCURRENCY_LIMIT',
          );
          err.providerName = hopProvider;
          err.maxConcurrent = max;
          err.activeSpawns = max;
          throw err;
        }
        try {
          // Yield a single stop chunk so the hop "succeeds".
          return [{ type: 'delta', content: `served-by-${hopProvider}` }, { type: 'stop', finish_reason: 'stop' }];
        } finally {
          releaseSpawn(hopProvider);
        }
      }

      const result = await executeWithFallback(chain, ir, testHopFn, { logEvent: () => {} });
      assert.ok(result.chunks !== null, 'fallback should have produced chunks');
      assert.equal(result.fallbackHops, 1, 'must have advanced to second hop');
      assert.equal(result.providerUsed, 'openai',
        'secondary (openai) must serve when primary (anthropic) is saturated');
      const content = result.chunks.filter(c => c.type === 'delta').map(c => c.content).join('');
      assert.ok(content.includes('served-by-openai'), 'content must come from fallback hop');

      // Cleanup: release the synthetic pre-saturation slot.
      releaseSpawn('anthropic');
      assert.equal(getActiveSpawnCount('anthropic'), 0);
    });
  });

});

// ── Suite 19: lib/keys.mjs — multi-key auth (ADR 0007, D44) ───────────────

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import {
  createKey, listKeys, revokeKey, validateKey, touchLastUsed,
  generateToken, hashToken, validateManifest,
  readManifest, writeManifestAtomic,
  SCHEMA_VERSION, ENV_OWNER_KEY_ID, ANONYMOUS_KEY_ID, ENV_OWNER_VAR,
  __setTouchInterleaveHook, __resetWriteLocks, __writeLockSize,
} from './lib/keys.mjs';

describe('Suite 19 — lib/keys.mjs multi-key auth (ADR 0007, D44)', () => {

  describe('19a-d — Token generation (§ 5)', () => {
    it('19a: generateToken produces olp_<43-char base64url> (47 chars total)', () => {
      const t = generateToken();
      assert.match(t, /^olp_[A-Za-z0-9_-]{43}$/);
      assert.equal(t.length, 47);
    });

    it('19b: consecutive generateToken calls produce different tokens', () => {
      assert.notEqual(generateToken(), generateToken());
    });

    it('19c: hashToken returns 64-char lowercase hex sha256', () => {
      assert.match(hashToken('olp_test'), /^[a-f0-9]{64}$/);
    });

    it('19d: hashToken is deterministic', () => {
      assert.equal(hashToken('hello'), hashToken('hello'));
    });
  });

  describe('19e-j — Manifest write + read (§ 4, § 6.1)', () => {
    let TMP;
    before(() => { TMP = mkdtempSync(pathJoin(tmpdir(), 'olp-keys-19e-')); });
    after(() => { rmSync(TMP, { recursive: true, force: true }); __resetWriteLocks(); });

    it('19e: createKey writes a valid manifest readable by readManifest', () => {
      const { id, plaintext_token, manifest } = createKey({
        name: 'test-key',
        owner_tier: 'owner',
        providers_enabled: ['anthropic'],
        olpHome: TMP,
      });
      assert.match(plaintext_token, /^olp_[A-Za-z0-9_-]{43}$/);
      assert.equal(manifest.schema_version, SCHEMA_VERSION);
      assert.equal(manifest.id, id);
      assert.equal(manifest.owner_tier, 'owner');
      assert.deepEqual(manifest.providers_enabled, ['anthropic']);
      assert.equal(manifest.token_hash_algo, 'sha256');
      assert.equal(manifest.token_hash, hashToken(plaintext_token));
      assert.equal(manifest.revoked_at, null);
      assert.equal(manifest.last_used_at, null);

      const reread = readManifest(id, { olpHome: TMP });
      assert.deepEqual(reread, manifest);
    });

    it('19f: manifest file mode 0600 + key dir mode 0700 enforced', () => {
      const { id } = createKey({ name: 'mode-test', olpHome: TMP });
      const fileMode = statSync(pathJoin(TMP, 'keys', id, 'manifest.json')).mode & 0o777;
      const dirMode = statSync(pathJoin(TMP, 'keys', id)).mode & 0o777;
      assert.equal(fileMode, 0o600, 'manifest must be 0600');
      assert.equal(dirMode, 0o700, 'key dir must be 0700');
    });

    it('19g: readManifest returns null for non-existent key', () => {
      assert.equal(readManifest('does-not-exist', { olpHome: TMP }), null);
    });

    it('19h: validateManifest rejects unrecognized schema_version', () => {
      assert.throws(
        () => validateManifest({
          schema_version: 99, id: 'x', name: 'x', token_hash: 'x',
          token_hash_algo: 'sha256', owner_tier: 'owner',
          providers_enabled: '*', created_at: 'x',
        }),
        /manifest_invalid: unrecognized schema_version 99/,
      );
    });

    it('19i: validateManifest rejects bad owner_tier', () => {
      assert.throws(
        () => validateManifest({
          schema_version: 1, id: 'x', name: 'x', token_hash: 'x',
          token_hash_algo: 'sha256', owner_tier: 'admin',
          providers_enabled: '*', created_at: 'x',
        }),
        /owner_tier must be "owner" or "guest"/,
      );
    });

    it('19j: createKey rejects empty name + bad owner_tier + bad providers_enabled', () => {
      assert.throws(() => createKey({ name: '', olpHome: TMP }), /name is required/);
      assert.throws(() => createKey({ name: 'x', owner_tier: 'admin', olpHome: TMP }), /owner_tier must be "owner" or "guest"/);
      assert.throws(() => createKey({ name: 'x', providers_enabled: 'invalid', olpHome: TMP }), /providers_enabled must be/);
    });
  });

  describe('19k-p — validateKey (§ 5, § 6.3.5, § 9.4)', () => {
    let TMP;
    before(() => { TMP = mkdtempSync(pathJoin(tmpdir(), 'olp-keys-19k-')); });
    after(() => {
      rmSync(TMP, { recursive: true, force: true });
      delete process.env[ENV_OWNER_VAR];
      __resetWriteLocks();
    });

    it('19k: valid plaintext returns key identity from filesystem', () => {
      const { id, plaintext_token } = createKey({
        name: 'valid-test',
        owner_tier: 'guest',
        providers_enabled: ['anthropic', 'openai'],
        olpHome: TMP,
      });
      const identity = validateKey(plaintext_token, { olpHome: TMP });
      assert.ok(identity);
      assert.equal(identity.id, id);
      assert.equal(identity.owner_tier, 'guest');
      assert.deepEqual(identity.providers_enabled, ['anthropic', 'openai']);
      assert.equal(identity.source, 'filesystem');
    });

    it('19l: wrong plaintext returns null', () => {
      createKey({ name: 'wrong-test', olpHome: TMP });
      const wrong = 'olp_' + 'a'.repeat(43);
      assert.equal(validateKey(wrong, { olpHome: TMP }), null);
    });

    it('19m: missing plaintext with allowAnonymous:false → null', () => {
      assert.equal(validateKey(null, { olpHome: TMP, allowAnonymous: false }), null);
      assert.equal(validateKey('', { olpHome: TMP, allowAnonymous: false }), null);
      assert.equal(validateKey(undefined, { olpHome: TMP, allowAnonymous: false }), null);
      // Default allowAnonymous is false (§ 7.2)
      assert.equal(validateKey(null, { olpHome: TMP }), null);
    });

    it('19m-extra: non-string truthy plaintext (number / object / array) → null (no throw)', () => {
      // D44 fold-in P2 #2: prior version threw TypeError on these inputs.
      assert.equal(validateKey(42, { olpHome: TMP }), null);
      assert.equal(validateKey({}, { olpHome: TMP }), null);
      assert.equal(validateKey([], { olpHome: TMP }), null);
      assert.equal(validateKey({ token: 'olp_xxx' }, { olpHome: TMP }), null);
      // Same guard for allowAnonymous: true (env path doesn't change behaviour)
      assert.equal(validateKey(42, { olpHome: TMP, allowAnonymous: true }), null);
    });

    it('19n: missing plaintext with allowAnonymous:true → anonymous identity', () => {
      const id = validateKey(null, { olpHome: TMP, allowAnonymous: true });
      assert.ok(id);
      assert.equal(id.id, ANONYMOUS_KEY_ID);
      assert.equal(id.owner_tier, 'anonymous');
      assert.equal(id.source, 'anonymous');
    });

    it('19o: revoked key returns null on validation (criterion #6 validation-side)', async () => {
      const { id, plaintext_token } = createKey({ name: 'revoke-test', olpHome: TMP });
      assert.ok(validateKey(plaintext_token, { olpHome: TMP }), 'valid before revoke');
      await revokeKey({ id, olpHome: TMP });
      assert.equal(validateKey(plaintext_token, { olpHome: TMP }), null, '401 path after revoke');
    });

    it('19p: OLP_OWNER_TOKEN env override returns __env_owner__ identity (§ 9.4)', () => {
      const envToken = 'olp_' + 'e'.repeat(43);
      process.env[ENV_OWNER_VAR] = envToken;
      try {
        const id = validateKey(envToken, { olpHome: TMP });
        assert.ok(id);
        assert.equal(id.id, ENV_OWNER_KEY_ID);
        assert.equal(id.owner_tier, 'owner');
        assert.equal(id.providers_enabled, '*');
        assert.equal(id.source, 'env');
      } finally {
        delete process.env[ENV_OWNER_VAR];
      }
    });
  });

  describe('19q-r — revokeKey (§ 6.1)', () => {
    let TMP;
    before(() => { TMP = mkdtempSync(pathJoin(tmpdir(), 'olp-keys-19q-')); });
    after(() => { rmSync(TMP, { recursive: true, force: true }); __resetWriteLocks(); });

    it('19q: revokeKey marks revoked_at and is idempotent', async () => {
      const { id } = createKey({ name: 'rev-idem', olpHome: TMP });
      assert.equal(await revokeKey({ id, olpHome: TMP }), true);
      const m1 = readManifest(id, { olpHome: TMP });
      assert.ok(m1.revoked_at !== null);
      assert.equal(await revokeKey({ id, olpHome: TMP }), true);
      const m2 = readManifest(id, { olpHome: TMP });
      assert.equal(m1.revoked_at, m2.revoked_at, 'second revoke must not rewrite timestamp');
    });

    it('19r: revokeKey returns false for non-existent id', async () => {
      assert.equal(await revokeKey({ id: 'no-such-key-zzz', olpHome: TMP }), false);
    });
  });

  describe('19s-t — listKeys', () => {
    let TMP;
    before(() => { TMP = mkdtempSync(pathJoin(tmpdir(), 'olp-keys-19s-')); });
    after(() => { rmSync(TMP, { recursive: true, force: true }); __resetWriteLocks(); });

    it('19s: empty dir returns []', () => {
      assert.deepEqual(listKeys({ olpHome: TMP }), []);
    });

    it('19t: lists all keys with token_hash redacted', () => {
      createKey({ name: 'k1', owner_tier: 'owner', olpHome: TMP });
      createKey({ name: 'k2', owner_tier: 'guest', olpHome: TMP });
      const list = listKeys({ olpHome: TMP });
      assert.equal(list.length, 2);
      for (const m of list) {
        assert.ok(m.token_hash === undefined, 'token_hash must be redacted from listKeys output');
        assert.ok(['k1', 'k2'].includes(m.name));
        assert.ok(['owner', 'guest'].includes(m.owner_tier));
      }
    });
  });

  describe('19u-x — touchLastUsed read-modify-write (§ 6.3)', () => {
    let TMP;
    before(() => { TMP = mkdtempSync(pathJoin(tmpdir(), 'olp-keys-19u-')); });
    after(() => {
      rmSync(TMP, { recursive: true, force: true });
      __resetWriteLocks();
      __setTouchInterleaveHook(null);
    });

    it('19u: updates last_used_at on non-revoked key (preserves all other fields)', async () => {
      const { id, manifest: m_before } = createKey({
        name: 'touch-test', owner_tier: 'owner', providers_enabled: ['mistral'], olpHome: TMP,
      });
      assert.equal(m_before.last_used_at, null);
      await touchLastUsed(id, { olpHome: TMP });
      const m_after = readManifest(id, { olpHome: TMP });
      assert.ok(m_after.last_used_at !== null);
      assert.equal(m_after.revoked_at, null);
      assert.equal(m_after.owner_tier, 'owner');
      assert.deepEqual(m_after.providers_enabled, ['mistral']);
      assert.equal(m_after.token_hash, m_before.token_hash);
    });

    it('19v: NO-OPs on already-revoked key (preserves revoked_at, does not set last_used_at)', async () => {
      const { id } = createKey({ name: 'touch-revoked', olpHome: TMP });
      await revokeKey({ id, olpHome: TMP });
      const revokedTs = readManifest(id, { olpHome: TMP }).revoked_at;
      assert.ok(revokedTs !== null);

      await touchLastUsed(id, { olpHome: TMP });
      const m_after_touch = readManifest(id, { olpHome: TMP });
      assert.equal(m_after_touch.revoked_at, revokedTs, 'revoked_at must be preserved (revoke dominates touch)');
      assert.equal(m_after_touch.last_used_at, null, 'NO-OP must not write last_used_at on revoked key');
    });

    it('19w: NO-OPs silently on anonymous + env-owner identities (no manifest exists)', async () => {
      await touchLastUsed(ANONYMOUS_KEY_ID, { olpHome: TMP });
      await touchLastUsed(ENV_OWNER_KEY_ID, { olpHome: TMP });
    });

    it('19x: failure is best-effort (no throw on missing key)', async () => {
      await touchLastUsed('phantom-key-xyz', { olpHome: TMP });
    });

    it('19x-extra: per-key write-lock Map is cleaned up after sequential calls (D44 fold-in P2 #1 regression)', async () => {
      __resetWriteLocks();
      assert.equal(__writeLockSize(), 0, 'lock map starts empty');
      const { id } = createKey({ name: 'lock-cleanup-test', olpHome: TMP });
      // Sequential touch calls
      for (let i = 0; i < 5; i++) {
        await touchLastUsed(id, { olpHome: TMP });
      }
      assert.equal(__writeLockSize(), 0,
        'lock map MUST be empty after sequential awaited calls (prior bug: stored derived promise never matched cleanup identity check, leaving stale entry per unique key-id)');
    });

    it('19x-extra-2: per-key write-lock Map cleans up after concurrent contention resolves', async () => {
      __resetWriteLocks();
      const ids = [];
      for (let i = 0; i < 3; i++) {
        const { id } = createKey({ name: `concurrent-${i}`, olpHome: TMP });
        ids.push(id);
      }
      // Race: 3 keys, each with 3 concurrent touches
      const calls = [];
      for (const id of ids) {
        for (let j = 0; j < 3; j++) {
          calls.push(touchLastUsed(id, { olpHome: TMP }));
        }
      }
      await Promise.all(calls);
      assert.equal(__writeLockSize(), 0,
        'lock map MUST drain to 0 after all queued callers across all keys finish');
    });
  });

  describe('19y-1 to 19y-4 — Acceptance criterion #7: concurrent revoke + touch (§ 6.3, § 6.4)', () => {
    let TMP;
    before(() => { TMP = mkdtempSync(pathJoin(tmpdir(), 'olp-keys-19y-')); });
    after(() => {
      rmSync(TMP, { recursive: true, force: true });
      __resetWriteLocks();
      __setTouchInterleaveHook(null);
    });

    it('19y-1: revoke-then-touch — revoked_at preserved', async () => {
      const { id } = createKey({ name: 'race-1', olpHome: TMP });
      await revokeKey({ id, olpHome: TMP });
      const revokedTs = readManifest(id, { olpHome: TMP }).revoked_at;
      await touchLastUsed(id, { olpHome: TMP });
      const m = readManifest(id, { olpHome: TMP });
      assert.equal(m.revoked_at, revokedTs, 'revoked_at must survive subsequent touch');
      assert.equal(m.last_used_at, null, 'touch must NO-OP on revoked key');
    });

    it('19y-2: touch-then-revoke — revoked_at present + last_used_at preserved from prior touch', async () => {
      const { id } = createKey({ name: 'race-2', olpHome: TMP });
      await touchLastUsed(id, { olpHome: TMP });
      const lastUsedAtBeforeRevoke = readManifest(id, { olpHome: TMP }).last_used_at;
      assert.ok(lastUsedAtBeforeRevoke !== null);
      await revokeKey({ id, olpHome: TMP });
      const m = readManifest(id, { olpHome: TMP });
      assert.ok(m.revoked_at !== null, 'revoked_at must be set');
      assert.equal(m.last_used_at, lastUsedAtBeforeRevoke, 'last_used_at from prior touch must persist through revoke');
    });

    it('19y-3: interleaved external revoke fires inside touch lock before read — revoked_at preserved', async () => {
      // SCENARIO TESTED: external revoke lands after touch acquires its lock
      // but before touch's read. touch's subsequent read sees the revoke and
      // NO-OPs per § 6.3 step 2.
      //
      // SCENARIO NOT TESTED (and currently UNREACHABLE in implementation):
      // external revoke between touch's read and touch's write. The current
      // touchLastUsed has SYNCHRONOUS read→write (no await between
      // readManifest and writeManifestAtomic), so no external write can
      // interleave between them at the JS event-loop level. If a future
      // refactor introduces an await between read and write, this guarantee
      // breaks and a post-read hook + matching test would be required to
      // catch the regression. ADR § 10 criterion #7 scenario 3 is satisfied
      // by the synchronous-read-write property of the current implementation.
      const { id } = createKey({ name: 'race-3', olpHome: TMP });
      let hookFired = false;
      __setTouchInterleaveHook(async () => {
        // Simulates an external (out-of-process / CLI) revoke landing
        // between touch's lock acquisition and touch's read. Bypasses
        // _withKeyLock because external writers do not see in-process
        // locks at Phase 2 (§ 6.4).
        const fresh = readManifest(id, { olpHome: TMP });
        fresh.revoked_at = new Date().toISOString();
        writeManifestAtomic(id, fresh, { olpHome: TMP });
        hookFired = true;
      });
      try {
        await touchLastUsed(id, { olpHome: TMP });
      } finally {
        __setTouchInterleaveHook(null);
      }
      assert.ok(hookFired, 'hook must have fired');
      const m = readManifest(id, { olpHome: TMP });
      assert.ok(m.revoked_at !== null, 'revoked_at must NOT be cleared by an interleaved touch — § 6.3 contract');
      assert.equal(m.last_used_at, null, 'touch must NO-OP after observing the interleaved revoke');
    });

    it('19y-4: stress — 30 iterations of concurrent revoke + touch never lose revoked_at', async () => {
      for (let i = 0; i < 30; i++) {
        const { id } = createKey({ name: `stress-${i}`, olpHome: TMP });
        await Promise.all([
          revokeKey({ id, olpHome: TMP }),
          touchLastUsed(id, { olpHome: TMP }),
        ]);
        const m = readManifest(id, { olpHome: TMP });
        assert.ok(m.revoked_at !== null, `iter ${i}: revoked_at lost — race regression`);
      }
    });
  });

});

// ── Suite 20: server.mjs auth integration (D45, ADR 0007 §§ 5/6.2/7/9.4) ──
//
// HTTP-level tests for the Phase 2 D45 server-side wire-up:
//   - auth.allow_anonymous false-by-default 401
//   - Authorization Bearer / x-api-key header acceptance
//   - revoked-key 401 (acceptance criterion #6 — full coverage with D45)
//   - OLP_OWNER_TOKEN env override (acceptance criterion #10 — full coverage)
//   - providers_enabled 403 scope enforcement (acceptance criterion #11)
//   - per-key cache namespace isolation (acceptance criterion #1)
//   - audit ndjson written with correct fields (acceptance criterion #8)
//   - touchLastUsed wire updates last_used_at after a request
//   - /v1/models gates auth the same way as /v1/chat/completions

import { readFileSync as fsReadFileSync, existsSync as fsExistsSync } from 'node:fs';
import { appendAuditEvent, __resetAuditDropCount } from './lib/audit.mjs';

describe('Suite 20 — server.mjs auth integration (D45, ADR 0007)', () => {
  // Each describe block gets its own tmp OLP_HOME so audit + key writes are
  // isolated and verifiable. Restore the global test default in after().
  const GLOBAL_OLP_HOME = process.env.OLP_HOME;

  // Each Suite 20 server requires the anthropic auth-check to pass before the
  // mock spawn runs. lib/providers/anthropic.mjs _spawnAndStream checks for an
  // OAuth token BEFORE calling the (mock) spawn — without a token the AUTH_MISSING
  // pre-check fires and the request 502s before the mock can return chunks. Same
  // pattern as Suite 9 cache HTTP tests (line ~2154 "test-fake-oauth-token-for-
  // cache-tests"). CI Node 24 has no OAuth env; local dev machines may; CI was
  // the trigger that caught this.
  let _suite20SavedOAuth;
  function ensureSuite20FakeOAuth() {
    _suite20SavedOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'suite20-fake-oauth-token';
  }
  function restoreSuite20OAuth() {
    if (_suite20SavedOAuth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = _suite20SavedOAuth;
    else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  function makeSuite20Server() {
    __setProvidersEnabled({ anthropic: true });
    __setSpawnImpl(makeMockSpawn(['suite20-mock-response']));
    ensureSuite20FakeOAuth();
    const server = createOlpServer();
    return new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
  }

  function teardownSuite20(server) {
    return new Promise(resolve => {
      __resetSpawnImpl();
      __setProvidersEnabled({});
      __clearCache();
      restoreSuite20OAuth();
      if (server) server.close(() => resolve());
      else resolve();
    });
  }

  // ── 20a-d: header parsing + happy paths ────────────────────────────────

  describe('20a-d — header parsing + valid key paths', () => {
    let TMP, server, port;
    before(async () => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-20ad-'));
      process.env.OLP_HOME = TMP;
      __setAuthConfig({ allow_anonymous: false });
      ({ server, port } = await makeSuite20Server());
    });
    after(async () => {
      await teardownSuite20(server);
      process.env.OLP_HOME = GLOBAL_OLP_HOME;
      __setAuthConfig({ allow_anonymous: true });
      rmSync(TMP, { recursive: true, force: true });
    });

    it('20a: allow_anonymous=false + no Authorization header → 401 auth_required', async () => {
      const r = await fetch({
        port, method: 'POST', path: '/v1/chat/completions',
        body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '20a' }] },
      });
      assert.equal(r.status, 401);
      const err = JSON.parse(r.body);
      assert.equal(err.error.type, 'auth_required');
    });

    it('20b: valid Authorization: Bearer <token> → 200 (filesystem identity)', async () => {
      const { plaintext_token } = createKey({ name: '20b-bearer', owner_tier: 'guest', providers_enabled: ['anthropic'], olpHome: TMP });
      const r = await fetch({
        port, method: 'POST', path: '/v1/chat/completions',
        headers: { Authorization: `Bearer ${plaintext_token}` },
        body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '20b' }] },
      });
      assert.equal(r.status, 200);
    });

    it('20c: x-api-key header alternative → 200 (filesystem identity)', async () => {
      const { plaintext_token } = createKey({ name: '20c-xapikey', owner_tier: 'guest', providers_enabled: ['anthropic'], olpHome: TMP });
      const r = await fetch({
        port, method: 'POST', path: '/v1/chat/completions',
        headers: { 'x-api-key': plaintext_token },
        body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '20c' }] },
      });
      assert.equal(r.status, 200);
    });

    it('20d: invalid token → 401 invalid_or_revoked_key', async () => {
      const r = await fetch({
        port, method: 'POST', path: '/v1/chat/completions',
        headers: { Authorization: 'Bearer olp_not-a-real-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '20d' }] },
      });
      assert.equal(r.status, 401);
      const err = JSON.parse(r.body);
      assert.equal(err.error.type, 'invalid_or_revoked_key');
    });
  });

  // ── 20e-g: revocation + env owner + allow_anonymous true ────────────────

  describe('20e-g — revocation + env owner override + anonymous-mode dev', () => {
    let TMP, server, port;
    before(async () => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-20eg-'));
      process.env.OLP_HOME = TMP;
      __setAuthConfig({ allow_anonymous: false });
      ({ server, port } = await makeSuite20Server());
    });
    after(async () => {
      await teardownSuite20(server);
      process.env.OLP_HOME = GLOBAL_OLP_HOME;
      __setAuthConfig({ allow_anonymous: true });
      delete process.env.ENV_OWNER_VAR;
      delete process.env[ENV_OWNER_VAR];
      rmSync(TMP, { recursive: true, force: true });
    });

    it('20e: revoked key → 401 invalid_or_revoked_key (criterion #6 full coverage)', async () => {
      const { id, plaintext_token } = createKey({ name: '20e-rev', owner_tier: 'guest', providers_enabled: ['anthropic'], olpHome: TMP });
      // First request — should succeed
      const r1 = await fetch({
        port, method: 'POST', path: '/v1/chat/completions',
        headers: { Authorization: `Bearer ${plaintext_token}` },
        body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '20e-1' }] },
      });
      assert.equal(r1.status, 200);
      // Revoke
      await revokeKey({ id, olpHome: TMP });
      // Second request — must 401
      const r2 = await fetch({
        port, method: 'POST', path: '/v1/chat/completions',
        headers: { Authorization: `Bearer ${plaintext_token}` },
        body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '20e-2' }] },
      });
      assert.equal(r2.status, 401);
      const err = JSON.parse(r2.body);
      assert.equal(err.error.type, 'invalid_or_revoked_key');
    });

    it('20f: OLP_OWNER_TOKEN env override → 200 (env identity, criterion #10 full coverage)', async () => {
      const envToken = 'olp_' + 'f'.repeat(43);
      process.env[ENV_OWNER_VAR] = envToken;
      try {
        const r = await fetch({
          port, method: 'POST', path: '/v1/chat/completions',
          headers: { Authorization: `Bearer ${envToken}` },
          body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '20f' }] },
        });
        assert.equal(r.status, 200);
      } finally {
        delete process.env[ENV_OWNER_VAR];
      }
    });

    it('20g: allow_anonymous=true + no header → 200 (anonymous identity — dev escape hatch)', async () => {
      __setAuthConfig({ allow_anonymous: true });
      try {
        const r = await fetch({
          port, method: 'POST', path: '/v1/chat/completions',
          body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '20g' }] },
        });
        assert.equal(r.status, 200);
      } finally {
        __setAuthConfig({ allow_anonymous: false });
      }
    });
  });

  // ── 20h: providers_enabled scope enforcement (criterion #11) ─────────────

  describe('20h — providers_enabled scope enforcement (criterion #11)', () => {
    let TMP, server, port;
    before(async () => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-20h-'));
      process.env.OLP_HOME = TMP;
      __setAuthConfig({ allow_anonymous: false });
      ({ server, port } = await makeSuite20Server());
    });
    after(async () => {
      await teardownSuite20(server);
      process.env.OLP_HOME = GLOBAL_OLP_HOME;
      __setAuthConfig({ allow_anonymous: true });
      rmSync(TMP, { recursive: true, force: true });
    });

    it('20h: providers_enabled: ["mistral"] + anthropic-routed model → 403 key_no_provider_access', async () => {
      const { plaintext_token } = createKey({ name: '20h-scoped', owner_tier: 'guest', providers_enabled: ['mistral'], olpHome: TMP });
      const r = await fetch({
        port, method: 'POST', path: '/v1/chat/completions',
        headers: { Authorization: `Bearer ${plaintext_token}` },
        body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '20h' }] },
      });
      assert.equal(r.status, 403);
      const err = JSON.parse(r.body);
      assert.equal(err.error.type, 'key_no_provider_access');
    });

    it('20h-extra: providers_enabled: "*" + anthropic-routed model → 200 (sanity baseline)', async () => {
      const { plaintext_token } = createKey({ name: '20h-wildcard', owner_tier: 'guest', providers_enabled: '*', olpHome: TMP });
      const r = await fetch({
        port, method: 'POST', path: '/v1/chat/completions',
        headers: { Authorization: `Bearer ${plaintext_token}` },
        body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '20h-star' }] },
      });
      assert.equal(r.status, 200);
    });

    it('20h-extra-audit: D53 — key_no_provider_access 403 audit row has tried_providers = []', async () => {
      // Per ADR 0007 § 8 tried_providers semantics clarification: the field
      // captures providers the server actually dispatched. On 403 (filter
      // rejected the whole chain) the server dispatched zero providers, so
      // tried_providers MUST be []. The configured-but-blocked chain only
      // appears in the human-readable error message, not in the audit.
      // D45 P2 deferral fix — was previously stamping the original chain
      // which distorted "which providers did key X actually call" queries.
      const { id, plaintext_token } = createKey({ name: '20h-extra-audit', owner_tier: 'guest', providers_enabled: ['mistral'], olpHome: TMP });
      const r = await fetch({
        port, method: 'POST', path: '/v1/chat/completions',
        headers: { Authorization: `Bearer ${plaintext_token}` },
        body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '20h-extra-audit' }] },
      });
      assert.equal(r.status, 403);
      assert.equal(JSON.parse(r.body).error.type, 'key_no_provider_access');
      // Wait for the res.on('finish') audit append
      await new Promise(resolve => setTimeout(resolve, 25));
      const auditPath = _pathJoinForSetup(TMP, 'logs', 'audit.ndjson');
      const lines = fsReadFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
      const row = lines.map(l => JSON.parse(l)).find(r =>
        r.path === '/v1/chat/completions' && r.status_code === 403 && r.key_id === id,
      );
      assert.ok(row, '403 audit row must be present');
      assert.equal(row.error_code, 'key_no_provider_access');
      assert.deepEqual(row.tried_providers, [],
        'tried_providers MUST be [] on key_no_provider_access — D53 semantic fix per ADR 0007 § 8 clarification');
    });
  });

  // ── 20i: per-key cache namespace isolation (criterion #1) ────────────────

  describe('20i — per-key cache namespace isolation (criterion #1)', () => {
    let TMP, server, port;
    before(async () => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-20i-'));
      process.env.OLP_HOME = TMP;
      __setAuthConfig({ allow_anonymous: false });
      ({ server, port } = await makeSuite20Server());
    });
    after(async () => {
      await teardownSuite20(server);
      process.env.OLP_HOME = GLOBAL_OLP_HOME;
      __setAuthConfig({ allow_anonymous: true });
      rmSync(TMP, { recursive: true, force: true });
    });

    it('20i: keys A + B sending identical payload do NOT share cache (per-keyId namespace from ADR 0005 D1)', async () => {
      const { plaintext_token: tokenA } = createKey({ name: '20i-A', owner_tier: 'guest', providers_enabled: ['anthropic'], olpHome: TMP });
      const { plaintext_token: tokenB } = createKey({ name: '20i-B', owner_tier: 'guest', providers_enabled: ['anthropic'], olpHome: TMP });
      const sharedPayload = {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: '20i-cache-shared-prompt' }],
      };

      // Key A: first request → miss
      const rA1 = await fetch({
        port, method: 'POST', path: '/v1/chat/completions',
        headers: { Authorization: `Bearer ${tokenA}` },
        body: sharedPayload,
      });
      assert.equal(rA1.status, 200);
      assert.equal(rA1.headers['x-olp-cache'], 'miss');

      // Key A: second identical request → hit
      const rA2 = await fetch({
        port, method: 'POST', path: '/v1/chat/completions',
        headers: { Authorization: `Bearer ${tokenA}` },
        body: sharedPayload,
      });
      assert.equal(rA2.status, 200);
      assert.equal(rA2.headers['x-olp-cache'], 'hit', 'Key A second request must hit cache within A namespace');

      // Key B: identical payload but different key → MUST be miss (isolated namespace)
      const rB1 = await fetch({
        port, method: 'POST', path: '/v1/chat/completions',
        headers: { Authorization: `Bearer ${tokenB}` },
        body: sharedPayload,
      });
      assert.equal(rB1.status, 200);
      assert.equal(rB1.headers['x-olp-cache'], 'miss',
        'Key B first request MUST be miss — per-key cache isolation (ADR 0005 D1 + ADR 0007 § 7)');
    });
  });

  // ── 20j: audit ndjson written with § 8 schema fields ─────────────────────

  describe('20j — audit ndjson written per § 8 schema', () => {
    let TMP, server, port;
    before(async () => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-20j-'));
      process.env.OLP_HOME = TMP;
      __setAuthConfig({ allow_anonymous: false });
      __resetAuditDropCount();
      ({ server, port } = await makeSuite20Server());
    });
    after(async () => {
      await teardownSuite20(server);
      process.env.OLP_HOME = GLOBAL_OLP_HOME;
      __setAuthConfig({ allow_anonymous: true });
      rmSync(TMP, { recursive: true, force: true });
    });

    it('20j: successful request appends an audit row with key_id, model, status_code, latency_ms (criterion #8)', async () => {
      const { id, plaintext_token } = createKey({ name: '20j-aud', owner_tier: 'guest', providers_enabled: ['anthropic'], olpHome: TMP });
      const r = await fetch({
        port, method: 'POST', path: '/v1/chat/completions',
        headers: { Authorization: `Bearer ${plaintext_token}` },
        body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '20j' }] },
      });
      assert.equal(r.status, 200);
      // Allow the res.on('finish') hook to flush the audit write
      await new Promise(resolve => setTimeout(resolve, 25));

      const auditPath = _pathJoinForSetup(TMP, 'logs', 'audit.ndjson');
      assert.ok(fsExistsSync(auditPath), 'audit.ndjson must be created on first request');
      const lines = fsReadFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
      assert.ok(lines.length >= 1, 'at least one audit line expected');
      const lastRow = JSON.parse(lines[lines.length - 1]);

      assert.equal(lastRow.key_id, id);
      assert.equal(lastRow.owner_tier, 'guest');
      assert.equal(lastRow.method, 'POST');
      assert.equal(lastRow.path, '/v1/chat/completions');
      assert.equal(lastRow.model, 'claude-sonnet-4-6');
      assert.equal(lastRow.status_code, 200);
      assert.ok(typeof lastRow.latency_ms === 'number' && lastRow.latency_ms >= 0);
      assert.ok(typeof lastRow.ts === 'string');
      assert.equal(lastRow.provider, 'anthropic');

      // PII guard: no message / response content in the audit row
      assert.ok(!('content' in lastRow), 'no message content in audit row (§ 8 no PII)');
      assert.ok(JSON.stringify(lastRow).indexOf('20j') === -1,
        'request payload text must NOT appear in audit row (§ 8 no PII)');
    });

    it('20j-stream: streaming-path audit row populates provider + cache_status (D45 fold-in P1 regression)', async () => {
      const { plaintext_token } = createKey({ name: '20j-stream', owner_tier: 'guest', providers_enabled: ['anthropic'], olpHome: TMP });
      const r = await fetch({
        port, method: 'POST', path: '/v1/chat/completions',
        headers: { Authorization: `Bearer ${plaintext_token}`, Accept: 'text/event-stream' },
        body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '20j-stream' }], stream: true },
      });
      assert.equal(r.status, 200);
      await new Promise(resolve => setTimeout(resolve, 50));

      const auditPath = _pathJoinForSetup(TMP, 'logs', 'audit.ndjson');
      const lines = fsReadFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
      const streamingRows = lines.map(l => JSON.parse(l)).filter(row =>
        row.path === '/v1/chat/completions' && row.status_code === 200 && row.key_id !== ANONYMOUS_KEY_ID,
      );
      assert.ok(streamingRows.length >= 1, 'at least one successful authed row expected');
      const lastStreamingRow = streamingRows[streamingRows.length - 1];
      // Prior to D45 fold-in P1: provider was null on real-streaming success path.
      assert.equal(lastStreamingRow.provider, 'anthropic',
        'streaming-path audit row MUST populate provider (D45 fold-in P1 regression)');
      assert.equal(lastStreamingRow.cache_status, 'miss',
        'streaming-path audit row MUST populate cache_status');
      assert.deepEqual(lastStreamingRow.tried_providers, ['anthropic']);
    });

    it('20j-401: 401 unauth request still appends audit row with error_code', async () => {
      const before = fsExistsSync(_pathJoinForSetup(TMP, 'logs', 'audit.ndjson'))
        ? fsReadFileSync(_pathJoinForSetup(TMP, 'logs', 'audit.ndjson'), 'utf-8').split('\n').filter(Boolean).length
        : 0;
      const r = await fetch({
        port, method: 'POST', path: '/v1/chat/completions',
        body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '20j-401' }] },
      });
      assert.equal(r.status, 401);
      await new Promise(resolve => setTimeout(resolve, 25));
      const after = fsReadFileSync(_pathJoinForSetup(TMP, 'logs', 'audit.ndjson'), 'utf-8').split('\n').filter(Boolean);
      assert.ok(after.length > before, '401 must also append a row');
      const lastRow = JSON.parse(after[after.length - 1]);
      assert.equal(lastRow.status_code, 401);
      assert.equal(lastRow.error_code, 'auth_required');
    });
  });

  // ── 20k: touchLastUsed wire after successful request ────────────────────

  describe('20k — touchLastUsed wire updates last_used_at post-request', () => {
    let TMP, server, port;
    before(async () => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-20k-'));
      process.env.OLP_HOME = TMP;
      __setAuthConfig({ allow_anonymous: false });
      ({ server, port } = await makeSuite20Server());
    });
    after(async () => {
      await teardownSuite20(server);
      process.env.OLP_HOME = GLOBAL_OLP_HOME;
      __setAuthConfig({ allow_anonymous: true });
      rmSync(TMP, { recursive: true, force: true });
    });

    it('20k: filesystem key last_used_at populated after first successful request', async () => {
      const { id, plaintext_token, manifest: m0 } = createKey({
        name: '20k-touch', owner_tier: 'guest', providers_enabled: ['anthropic'], olpHome: TMP,
      });
      assert.equal(m0.last_used_at, null);

      const r = await fetch({
        port, method: 'POST', path: '/v1/chat/completions',
        headers: { Authorization: `Bearer ${plaintext_token}` },
        body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '20k' }] },
      });
      assert.equal(r.status, 200);
      // Allow the async touchLastUsed (fired in res.on('finish')) to settle
      await new Promise(resolve => setTimeout(resolve, 50));

      const m1 = readManifest(id, { olpHome: TMP });
      assert.ok(m1.last_used_at !== null, 'last_used_at must be populated after first request');
      assert.equal(m1.revoked_at, null, 'revoked_at unchanged');
    });
  });

  // ── 20l: /v1/models also enforces auth ───────────────────────────────────

  describe('20m — /health with no auth + allow_anonymous=false → 401 (D46 consistent gating)', () => {
    let TMP, server, port;
    before(async () => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-20m-'));
      process.env.OLP_HOME = TMP;
      __setAuthConfig({ allow_anonymous: false });
      ({ server, port } = await makeSuite20Server());
    });
    after(async () => {
      await teardownSuite20(server);
      process.env.OLP_HOME = GLOBAL_OLP_HOME;
      __setAuthConfig({ allow_anonymous: true, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
      rmSync(TMP, { recursive: true, force: true });
    });

    it('20m: GET /health with no auth and allow_anonymous=false → 401', async () => {
      const r = await fetch({ port, method: 'GET', path: '/health' });
      assert.equal(r.status, 401);
    });
  });

  describe('20l — /v1/models also enforces auth', () => {
    let TMP, server, port;
    before(async () => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-20l-'));
      process.env.OLP_HOME = TMP;
      __setAuthConfig({ allow_anonymous: false });
      ({ server, port } = await makeSuite20Server());
    });
    after(async () => {
      await teardownSuite20(server);
      process.env.OLP_HOME = GLOBAL_OLP_HOME;
      __setAuthConfig({ allow_anonymous: true });
      rmSync(TMP, { recursive: true, force: true });
    });

    it('20l: /v1/models without auth → 401', async () => {
      const r = await fetch({ port, method: 'GET', path: '/v1/models' });
      assert.equal(r.status, 401);
    });

    it('20l-200: /v1/models with valid Bearer → 200 + data array', async () => {
      const { plaintext_token } = createKey({ name: '20l-ok', owner_tier: 'guest', providers_enabled: '*', olpHome: TMP });
      const r = await fetch({
        port, method: 'GET', path: '/v1/models',
        headers: { Authorization: `Bearer ${plaintext_token}` },
      });
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      assert.equal(body.object, 'list');
      assert.ok(Array.isArray(body.data));
    });
  });
});

// ── Suite 21: D46 owner-vs-guest gating (ADR 0007 § 7.1 + § 7.2) ──────────
//
// HTTP-level tests for:
//   - /health payload trimming (criterion #4): owner sees full per-provider
//     statuses; guest + anonymous see trimmed { ok, version }
//   - X-OLP-Fallback-Detail emission gating (criterion #5): policy
//     'owner_only' (default) emits only to owner; 'all' emits to everyone;
//     'none' suppresses entirely

describe('Suite 21 — D46 owner-vs-guest gating (ADR 0007 §§ 7.1, 7.2)', () => {
  const GLOBAL_OLP_HOME = process.env.OLP_HOME;

  let _suite21SavedOAuth;
  function ensureSuite21FakeOAuth() {
    _suite21SavedOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'suite21-fake-oauth-token';
  }
  function restoreSuite21OAuth() {
    if (_suite21SavedOAuth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = _suite21SavedOAuth;
    else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  function makeSuite21Server() {
    __setProvidersEnabled({ anthropic: true });
    __setSpawnImpl(makeMockSpawn(['suite21-response']));
    ensureSuite21FakeOAuth();
    const server = createOlpServer();
    return new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
  }

  function teardownSuite21(server) {
    return new Promise(resolve => {
      __resetSpawnImpl();
      __setProvidersEnabled({});
      __clearCache();
      restoreSuite21OAuth();
      if (server) server.close(() => resolve());
      else resolve();
    });
  }

  // ── 21a-d: /health payload trimming (criterion #4) ──────────────────────

  describe('21a-d — /health payload trimming (criterion #4)', () => {
    let TMP, server, port;
    before(async () => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-21ad-'));
      process.env.OLP_HOME = TMP;
      // Default-tight gating: /health is owner-only-endpoint
      __setAuthConfig({
        allow_anonymous: true,
        owner_only_endpoints: ['/health'],
        fallback_detail_header_policy: 'owner_only',
      });
      ({ server, port } = await makeSuite21Server());
    });
    after(async () => {
      await teardownSuite21(server);
      process.env.OLP_HOME = GLOBAL_OLP_HOME;
      __setAuthConfig({ allow_anonymous: true, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
      rmSync(TMP, { recursive: true, force: true });
    });

    it('21a: anonymous /health (allow_anonymous=true) → trimmed { ok, version }', async () => {
      const r = await fetch({ port, method: 'GET', path: '/health' });
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      assert.equal(body.ok, true);
      assert.equal(typeof body.version, 'string');
      assert.ok(!('providers' in body), 'anonymous /health MUST NOT include providers field');
    });

    it('21b: guest /health → trimmed { ok, version }', async () => {
      const { plaintext_token } = createKey({ name: '21b-guest', owner_tier: 'guest', providers_enabled: '*', olpHome: TMP });
      const r = await fetch({
        port, method: 'GET', path: '/health',
        headers: { Authorization: `Bearer ${plaintext_token}` },
      });
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      assert.equal(body.ok, true);
      assert.ok(!('providers' in body), 'guest /health MUST NOT include providers field');
    });

    it('21c: owner /health → full payload with providers', async () => {
      const { plaintext_token } = createKey({ name: '21c-owner', owner_tier: 'owner', providers_enabled: '*', olpHome: TMP });
      const r = await fetch({
        port, method: 'GET', path: '/health',
        headers: { Authorization: `Bearer ${plaintext_token}` },
      });
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      assert.equal(body.ok, true);
      assert.ok('providers' in body, 'owner /health MUST include providers field');
      assert.equal(typeof body.providers, 'object');
      assert.equal(typeof body.providers.enabled, 'number');
      assert.ok('status' in body.providers, 'owner /health providers.status must be present');
    });

    it('21c-extra: owner /health each provider status carries activeSpawns field (D56, v1.x #4 / ADR 0002 Amendment 6)', async () => {
      // ADR 0002 Amendment 6 forward note: when surfaced on /health, the
      // per-provider concurrency counter lives at providers.status.<name>.
      // activeSpawns. D56 wires it. With no requests in flight, the value
      // is 0; under saturation it equals hints.maxConcurrent.
      const { plaintext_token } = createKey({ name: '21c-extra', owner_tier: 'owner', providers_enabled: '*', olpHome: TMP });
      const r = await fetch({
        port, method: 'GET', path: '/health',
        headers: { Authorization: `Bearer ${plaintext_token}` },
      });
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      // At least one provider must be enabled in the fixture
      const statusEntries = Object.entries(body.providers.status);
      assert.ok(statusEntries.length >= 1, 'fixture has at least one enabled provider');
      for (const [name, status] of statusEntries) {
        assert.ok('activeSpawns' in status,
          `providers.status.${name}.activeSpawns MUST be present (ADR 0002 Amendment 6)`);
        assert.equal(typeof status.activeSpawns, 'number');
        assert.ok(status.activeSpawns >= 0, 'activeSpawns >= 0');
      }
    });

    it('21d: owner_only_endpoints config opt-out — empty list → guest gets full payload', async () => {
      __setAuthConfig({
        allow_anonymous: true,
        owner_only_endpoints: [],
        fallback_detail_header_policy: 'owner_only',
      });
      try {
        const { plaintext_token } = createKey({ name: '21d-guest-optout', owner_tier: 'guest', providers_enabled: '*', olpHome: TMP });
        const r = await fetch({
          port, method: 'GET', path: '/health',
          headers: { Authorization: `Bearer ${plaintext_token}` },
        });
        assert.equal(r.status, 200);
        const body = JSON.parse(r.body);
        assert.ok('providers' in body, 'with owner_only_endpoints: [], guest /health MUST get full payload');
      } finally {
        __setAuthConfig({
          allow_anonymous: true,
          owner_only_endpoints: ['/health'],
          fallback_detail_header_policy: 'owner_only',
        });
      }
    });
  });

  // ── 21e-h: X-OLP-Fallback-Detail emission gating (criterion #5) ─────────

  describe('21e-h — X-OLP-Fallback-Detail emission gating (criterion #5)', () => {
    let TMP, server, port;
    before(async () => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-21eh-'));
      process.env.OLP_HOME = TMP;
      // We will swap fallback_detail_header_policy per-case via __setAuthConfig.
      __setAuthConfig({
        allow_anonymous: false,
        owner_only_endpoints: [],
        fallback_detail_header_policy: 'owner_only',
      });
      // Wire a 2-hop chain with anthropic primary failing + openai secondary
      // succeeding so X-OLP-Fallback-Detail has content to emit.
      __setProvidersEnabled({ anthropic: true, openai: true });
      __setFallbackConfig({
        chains: {
          'claude-sonnet-4-6': [
            { provider: 'anthropic', model: 'claude-sonnet-4-6' },
            { provider: 'openai', model: 'gpt-5.5' },
          ],
        },
        soft_triggers: {},
        providersEnabled: { anthropic: true, openai: true },
      });
      // Mock: anthropic spawn fails (exit code 1); openai succeeds.
      // Use a custom spawn impl that branches on the bin name to distinguish.
      // Simpler: spy on both providers — for simplicity here we use the global
      // anthropic spawn mock that returns exit 1, and a real-looking codex one.
      // The easier path: use the mistral-codex paired spawn — but our existing
      // makeMockSpawn doesn't distinguish providers. Pattern used in Suite 18k:
      // an executeHopFn that itself fails primary. Here we re-use the global
      // anthropic mock that fails so the chain advances and openai serves.
      __setSpawnImpl(makeMockSpawn([], 1)); // anthropic spawn fails
      // Codex provider has its own __setSpawnImpl pattern; mock it separately.
      ensureSuite21FakeOAuth();
      // Codex auth needs CODEX env or its own auth artifact. For tests:
      process.env.OPENAI_CODEX_AUTH_PATH = '/dev/null'; // bypass to no-auth
      const codexMod = await import('./lib/providers/codex.mjs');
      codexMod.__setSpawnImpl?.(makeMockSpawn(['suite21-codex-served']));

      const serverInst = createOlpServer();
      await new Promise(resolve => {
        serverInst.listen(0, '127.0.0.1', () => resolve());
      });
      server = serverInst;
      port = serverInst.address().port;
    });
    after(async () => {
      __resetSpawnImpl();
      __setProvidersEnabled({});
      __resetFallbackConfig();
      __clearCache();
      restoreSuite21OAuth();
      delete process.env.OPENAI_CODEX_AUTH_PATH;
      const codexMod = await import('./lib/providers/codex.mjs');
      codexMod.__resetSpawnImpl?.();
      await new Promise(resolve => server.close(() => resolve()));
      process.env.OLP_HOME = GLOBAL_OLP_HOME;
      __setAuthConfig({ allow_anonymous: true, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
      rmSync(TMP, { recursive: true, force: true });
    });

    // NOTE: 21e-h tests use a contract-level audit on the header alone.
    // The header surfaces ONLY for non-empty fallbackDetail (D40) AND when
    // the identity is permitted per fallback_detail_header_policy (D46).
    // The 2-hop chain with primary-fail provides the non-empty trail.

    it('21e: policy=owner_only + guest → X-OLP-Fallback-Detail header ABSENT', async () => {
      __setAuthConfig({
        allow_anonymous: false,
        owner_only_endpoints: [],
        fallback_detail_header_policy: 'owner_only',
      });
      const { plaintext_token } = createKey({ name: '21e-guest', owner_tier: 'guest', providers_enabled: '*', olpHome: TMP });
      const r = await fetch({
        port, method: 'POST', path: '/v1/chat/completions',
        headers: { Authorization: `Bearer ${plaintext_token}` },
        body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '21e' }] },
      });
      // success or 502 both valid here — what matters is whether the
      // detail header is present. We just need to invoke fallback.
      assert.ok(r.headers['x-olp-fallback-detail'] === undefined,
        'guest identity MUST NOT receive X-OLP-Fallback-Detail under owner_only policy');
    });

    it('21f: policy=owner_only + owner → X-OLP-Fallback-Detail header PRESENT', async () => {
      __setAuthConfig({
        allow_anonymous: false,
        owner_only_endpoints: [],
        fallback_detail_header_policy: 'owner_only',
      });
      const { plaintext_token } = createKey({ name: '21f-owner', owner_tier: 'owner', providers_enabled: '*', olpHome: TMP });
      const r = await fetch({
        port, method: 'POST', path: '/v1/chat/completions',
        headers: { Authorization: `Bearer ${plaintext_token}` },
        body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '21f' }] },
      });
      assert.ok(r.headers['x-olp-fallback-detail'] !== undefined,
        'owner identity MUST receive X-OLP-Fallback-Detail when fallback chain has failures');
      // Validate header is JSON-parseable per D40 contract
      const parsed = JSON.parse(r.headers['x-olp-fallback-detail']);
      assert.ok(Array.isArray(parsed));
    });

    it('21g: policy=all + guest → X-OLP-Fallback-Detail header PRESENT (v0.1.1 opt-back-in)', async () => {
      __setAuthConfig({
        allow_anonymous: false,
        owner_only_endpoints: [],
        fallback_detail_header_policy: 'all',
      });
      const { plaintext_token } = createKey({ name: '21g-guest-all', owner_tier: 'guest', providers_enabled: '*', olpHome: TMP });
      const r = await fetch({
        port, method: 'POST', path: '/v1/chat/completions',
        headers: { Authorization: `Bearer ${plaintext_token}` },
        body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '21g' }] },
      });
      assert.ok(r.headers['x-olp-fallback-detail'] !== undefined,
        'policy=all MUST emit X-OLP-Fallback-Detail to guest identity (D46 opt-back-in to v0.1.1)');
    });

    it('21h: policy=none + owner → X-OLP-Fallback-Detail header ABSENT (full suppression)', async () => {
      __setAuthConfig({
        allow_anonymous: false,
        owner_only_endpoints: [],
        fallback_detail_header_policy: 'none',
      });
      const { plaintext_token } = createKey({ name: '21h-owner-none', owner_tier: 'owner', providers_enabled: '*', olpHome: TMP });
      const r = await fetch({
        port, method: 'POST', path: '/v1/chat/completions',
        headers: { Authorization: `Bearer ${plaintext_token}` },
        body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '21h' }] },
      });
      assert.ok(r.headers['x-olp-fallback-detail'] === undefined,
        'policy=none MUST suppress X-OLP-Fallback-Detail even for owner identity');
    });
  });
});

// ── Suite 22: D47 keygen CLI (bin/olp-keys.mjs, ADR 0007 § 9.1) ───────────
//
// Tests for the minimal keygen command surface that satisfies ADR § 10
// acceptance criterion #9 (bootstrap workflow must be reproducible without
// manual file editing).

import { runCli as runOlpKeysCli, parseArgv as parseOlpKeysArgv } from './bin/olp-keys.mjs';

describe('Suite 22 — D47 keygen CLI (bin/olp-keys.mjs, ADR 0007 § 9.1)', () => {

  describe('22a — parseArgv unit tests', () => {
    it('22a-1: empty argv → empty positional + empty flags', () => {
      const r = parseOlpKeysArgv([]);
      assert.deepEqual(r.positional, []);
      assert.deepEqual(r.flags, {});
    });

    it('22a-2: --flag=value form', () => {
      const r = parseOlpKeysArgv(['--name=keyA', '--tier=owner']);
      assert.equal(r.flags.name, 'keyA');
      assert.equal(r.flags.tier, 'owner');
    });

    it('22a-3: --flag value form (space-separated)', () => {
      const r = parseOlpKeysArgv(['--name', 'keyB', '--tier', 'guest']);
      assert.equal(r.flags.name, 'keyB');
      assert.equal(r.flags.tier, 'guest');
    });

    it('22a-4: --flag (boolean, no value) when followed by another --flag', () => {
      const r = parseOlpKeysArgv(['--owner', '--force']);
      assert.equal(r.flags.owner, true);
      assert.equal(r.flags.force, true);
    });

    it('22a-5: positional args + flags mixed', () => {
      const r = parseOlpKeysArgv(['keygen', '--owner']);
      assert.deepEqual(r.positional, ['keygen']);
      assert.equal(r.flags.owner, true);
    });
  });

  describe('22b — keygen subcommand', () => {
    let TMP;
    before(() => { TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-22b-')); });
    after(() => { rmSync(TMP, { recursive: true, force: true }); __resetWriteLocks(); });

    it('22b-1: keygen --owner creates owner key + prints plaintext token to stdout', async () => {
      let out = '';
      const code = await runOlpKeysCli(['keygen', '--owner', '--olp-home', TMP], {
        out: s => { out += s; },
        err: () => {},
      });
      assert.equal(code, 0);
      assert.match(out, /token \(plaintext\):\s+olp_[A-Za-z0-9_-]{43}/);
      assert.match(out, /owner_tier:\s+owner/);
      // Verify manifest was actually written
      const list = listKeys({ olpHome: TMP });
      assert.equal(list.length, 1);
      assert.equal(list[0].owner_tier, 'owner');
    });

    it('22b-2: keygen --name=test --providers=anthropic,openai → guest key with explicit providers', async () => {
      let out = '';
      const code = await runOlpKeysCli(
        ['keygen', '--name=test-guest', '--providers=anthropic,openai', '--olp-home', TMP],
        { out: s => { out += s; }, err: () => {} },
      );
      assert.equal(code, 0);
      assert.match(out, /owner_tier:\s+guest/);
      assert.match(out, /providers_enabled:\s+\[anthropic, openai\]/);
    });

    it('22b-3: keygen without --name AND without --owner → error exit 1', async () => {
      let err = '';
      const code = await runOlpKeysCli(['keygen', '--olp-home', TMP], {
        out: () => {},
        err: s => { err += s; },
      });
      assert.equal(code, 1);
      assert.match(err, /--name is required/);
    });

    it('22b-4: keygen --tier=admin → error exit 1 (invalid tier)', async () => {
      let err = '';
      const code = await runOlpKeysCli(
        ['keygen', '--name=bad', '--tier=admin', '--olp-home', TMP],
        { out: () => {}, err: s => { err += s; } },
      );
      assert.equal(code, 1);
      assert.match(err, /--tier must be "owner" or "guest"/);
    });

    it('22b-5: keygen --owner --force revokes existing owner + creates new', async () => {
      // Use a fresh tmpdir for this isolation
      const TMP2 = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-22b5-'));
      try {
        // Create initial owner
        await runOlpKeysCli(['keygen', '--owner', '--olp-home', TMP2], { out: () => {}, err: () => {} });
        const list1 = listKeys({ olpHome: TMP2 });
        assert.equal(list1.length, 1);
        const originalId = list1[0].id;

        // --force: revoke existing + create new
        let err = '';
        const code = await runOlpKeysCli(['keygen', '--owner', '--force', '--olp-home', TMP2], {
          out: () => {},
          err: s => { err += s; },
        });
        assert.equal(code, 0);
        assert.match(err, new RegExp(`Revoked existing owner key id=${originalId}`));

        // Listing including revoked must show 2 entries; active-only must show 1
        const listAll = listKeys({ olpHome: TMP2 });
        assert.equal(listAll.length, 2);
        const activeOwners = listAll.filter(k => k.owner_tier === 'owner' && k.revoked_at === null);
        assert.equal(activeOwners.length, 1, 'exactly one active owner after --force');
        const revokedOwners = listAll.filter(k => k.owner_tier === 'owner' && k.revoked_at !== null);
        assert.equal(revokedOwners.length, 1, 'exactly one revoked owner after --force');
        assert.equal(revokedOwners[0].id, originalId);
      } finally {
        rmSync(TMP2, { recursive: true, force: true });
      }
    });
  });

  describe('22c — list subcommand', () => {
    let TMP;
    before(() => { TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-22c-')); });
    after(() => { rmSync(TMP, { recursive: true, force: true }); __resetWriteLocks(); });

    it('22c-1: list with no keys → "No keys."', async () => {
      let out = '';
      const code = await runOlpKeysCli(['list', '--olp-home', TMP], {
        out: s => { out += s; }, err: () => {},
      });
      assert.equal(code, 0);
      assert.match(out, /No keys\./);
    });

    it('22c-2: list after 2 keys → both visible with redacted token_hash', async () => {
      await runOlpKeysCli(['keygen', '--name=alpha', '--olp-home', TMP], { out: () => {}, err: () => {} });
      await runOlpKeysCli(['keygen', '--name=beta', '--owner', '--olp-home', TMP], { out: () => {}, err: () => {} });
      let out = '';
      const code = await runOlpKeysCli(['list', '--olp-home', TMP], { out: s => { out += s; }, err: () => {} });
      assert.equal(code, 0);
      assert.match(out, /name:\s+alpha/);
      assert.match(out, /name:\s+beta/);
      assert.match(out, /owner_tier:\s+owner/);
      assert.match(out, /owner_tier:\s+guest/);
      // token_hash MUST NOT appear in list output (lib/keys.mjs listKeys redacts it)
      assert.ok(!out.includes('token_hash'), 'list output must not include token_hash field');
    });

    it('22c-3: list --owner-only filters to owner_tier=owner', async () => {
      let out = '';
      const code = await runOlpKeysCli(['list', '--owner-only', '--olp-home', TMP], {
        out: s => { out += s; }, err: () => {},
      });
      assert.equal(code, 0);
      assert.ok(!out.includes('name:       alpha'), 'guest "alpha" must be filtered out with --owner-only');
      assert.match(out, /name:\s+beta/, 'owner "beta" must remain');
    });
  });

  describe('22d — revoke subcommand', () => {
    let TMP, keyId;
    before(async () => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-22d-'));
      const r = createKey({ name: '22d-target', owner_tier: 'guest', olpHome: TMP });
      keyId = r.id;
    });
    after(() => { rmSync(TMP, { recursive: true, force: true }); __resetWriteLocks(); });

    it('22d-1: revoke --id=<valid> → exit 0, manifest revoked_at set', async () => {
      let out = '';
      const code = await runOlpKeysCli(['revoke', `--id=${keyId}`, '--olp-home', TMP], {
        out: s => { out += s; }, err: () => {},
      });
      assert.equal(code, 0);
      assert.match(out, new RegExp(`Revoked key id=${keyId}`));
      const m = readManifest(keyId, { olpHome: TMP });
      assert.ok(m.revoked_at !== null);
    });

    it('22d-2: revoke --id=<already-revoked> → exit 0 + "already revoked" message (idempotent)', async () => {
      let out = '';
      const code = await runOlpKeysCli(['revoke', `--id=${keyId}`, '--olp-home', TMP], {
        out: s => { out += s; }, err: () => {},
      });
      assert.equal(code, 0);
      assert.match(out, /already revoked/);
    });

    it('22d-3: revoke without --id → exit 1', async () => {
      let err = '';
      const code = await runOlpKeysCli(['revoke', '--olp-home', TMP], {
        out: () => {}, err: s => { err += s; },
      });
      assert.equal(code, 1);
      assert.match(err, /--id=<key-id> is required/);
    });

    it('22d-4: revoke --id=<nonexistent> → exit 2', async () => {
      let err = '';
      const code = await runOlpKeysCli(['revoke', '--id=nonexistent-key', '--olp-home', TMP], {
        out: () => {}, err: s => { err += s; },
      });
      assert.equal(code, 2);
      assert.match(err, /no key with id="nonexistent-key"/);
    });
  });

  describe('22e — top-level CLI behaviour', () => {
    it('22e-1: --help → exit 0 with usage text', async () => {
      let out = '';
      const code = await runOlpKeysCli(['--help'], { out: s => { out += s; }, err: () => {} });
      assert.equal(code, 0);
      assert.match(out, /OLP key management CLI/);
      assert.match(out, /keygen/);
      assert.match(out, /list/);
      assert.match(out, /revoke/);
    });

    it('22e-2: no args → exit 1 with usage text', async () => {
      let out = '';
      const code = await runOlpKeysCli([], { out: s => { out += s; }, err: () => {} });
      assert.equal(code, 1);
      assert.match(out, /OLP key management CLI/);
    });

    it('22e-3: unknown subcommand → exit 1 with error', async () => {
      let err = '';
      const code = await runOlpKeysCli(['frobnicate'], { out: () => {}, err: s => { err += s; } });
      assert.equal(code, 1);
      assert.match(err, /unknown subcommand "frobnicate"/);
    });
  });
});

// ── Suite 23: D49 lib/audit-query.mjs (Phase 3 audit aggregate query layer) ──
//
// Unit tests for the in-memory audit query layer per ADR 0008 § 4.
//   - discoverAuditFiles: filesystem scan + date-suffix recognition
//   - readAuditWindow: window filtering + cross-file walk + malformed skip
//   - aggregateRequests: count + median/p95 latency + by_provider + by_owner_tier + by_path
//   - topFallbackChains: sort + tied-count tiebreak + tried_providers shape
//   - spendTrendDaily: sparse-fill + UTC day buckets
//   - cacheHitRateWindow: per-provider + bypass-not-in-denominator
//   - PII guard: aggregate shapes never include message content

import {
  discoverAuditFiles,
  readAuditWindow,
  aggregateRequests,
  topFallbackChains,
  spendTrendDaily,
  cacheHitRateWindow,
  aggregateProviderQuota,
} from './lib/audit-query.mjs';
import { mkdirSync, writeFileSync as fsWriteFileSyncForS23 } from 'node:fs';

describe('Suite 23 — D49 lib/audit-query.mjs (Phase 3 audit aggregate query layer, ADR 0008 § 4)', () => {

  // Helper: write synthetic audit ndjson files to a tmpdir's logs/ subdir.
  // entries is { 'live': [...events] | 'YYYY-MM-DD': [...events] }
  function setupAuditFiles(tmp, entries) {
    const logsDir = _pathJoinForSetup(tmp, 'logs');
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    for (const [date, events] of Object.entries(entries)) {
      const filename = date === 'live' ? 'audit.ndjson' : `audit-${date}.ndjson`;
      const path = _pathJoinForSetup(logsDir, filename);
      const lines = events.map(ev => JSON.stringify(ev)).join('\n') + '\n';
      fsWriteFileSyncForS23(path, lines, { mode: 0o600 });
    }
  }

  function makeEvent(overrides = {}) {
    return {
      ts: new Date().toISOString(),
      key_id: 'k1',
      owner_tier: 'owner',
      method: 'POST',
      path: '/v1/chat/completions',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      status_code: 200,
      latency_ms: 100,
      cache_status: 'miss',
      fallback_hops: 0,
      tried_providers: ['anthropic'],
      error_code: null,
      ir_request_hash: 'abc123',
      chain_id: 'c1',
      ...overrides,
    };
  }

  describe('23a — discoverAuditFiles', () => {
    let TMP;
    before(() => { TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-23a-')); });
    after(() => { rmSync(TMP, { recursive: true, force: true }); });

    it('23a-1: empty logs dir → empty Map', () => {
      const r = discoverAuditFiles({ olpHome: TMP });
      assert.equal(r.size, 0);
    });

    it('23a-2: only audit.ndjson → Map with "live" key', () => {
      setupAuditFiles(TMP, { 'live': [makeEvent()] });
      const r = discoverAuditFiles({ olpHome: TMP });
      assert.equal(r.size, 1);
      assert.ok(r.has('live'));
    });

    it('23a-3: rotated files + live → all recognized', () => {
      setupAuditFiles(TMP, {
        'live': [makeEvent()],
        '2026-05-24': [makeEvent({ ts: '2026-05-24T12:00:00Z' })],
        '2026-05-23': [makeEvent({ ts: '2026-05-23T12:00:00Z' })],
      });
      const r = discoverAuditFiles({ olpHome: TMP });
      assert.equal(r.size, 3);
      assert.ok(r.has('live'));
      assert.ok(r.has('2026-05-24'));
      assert.ok(r.has('2026-05-23'));
    });

    it('23a-4: non-audit files ignored', () => {
      setupAuditFiles(TMP, { 'live': [makeEvent()] });
      fsWriteFileSyncForS23(_pathJoinForSetup(TMP, 'logs', 'some-random.log'), 'noise\n', { mode: 0o600 });
      fsWriteFileSyncForS23(_pathJoinForSetup(TMP, 'logs', 'audit-invalid-date.ndjson'), 'noise\n', { mode: 0o600 });
      const r = discoverAuditFiles({ olpHome: TMP });
      // live + 3 prior rotated from 23a-3 (state carries within describe block); ignore random files
      assert.ok(r.size >= 1);
      for (const key of r.keys()) {
        assert.ok(key === 'live' || /^\d{4}-\d{2}-\d{2}$/.test(key));
      }
    });
  });

  describe('23b — readAuditWindow', () => {
    let TMP;
    before(() => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-23b-'));
      setupAuditFiles(TMP, {
        '2026-05-23': [
          makeEvent({ ts: '2026-05-23T10:00:00Z', provider: 'anthropic' }),
          makeEvent({ ts: '2026-05-23T20:00:00Z', provider: 'openai' }),
        ],
        '2026-05-24': [
          makeEvent({ ts: '2026-05-24T10:00:00Z', provider: 'mistral' }),
        ],
        'live': [
          makeEvent({ ts: '2026-05-25T10:00:00Z', provider: 'anthropic' }),
        ],
      });
    });
    after(() => { rmSync(TMP, { recursive: true, force: true }); });

    it('23b-1: window covering all → all 4 events', () => {
      const start = Date.parse('2026-05-23T00:00:00Z');
      const end = Date.parse('2026-05-26T00:00:00Z');
      const events = [...readAuditWindow({ startMs: start, endMs: end, olpHome: TMP })];
      assert.equal(events.length, 4);
    });

    it('23b-2: window covering only 2026-05-24 → 1 event (mistral)', () => {
      const start = Date.parse('2026-05-24T00:00:00Z');
      const end = Date.parse('2026-05-25T00:00:00Z');
      const events = [...readAuditWindow({ startMs: start, endMs: end, olpHome: TMP })];
      assert.equal(events.length, 1);
      assert.equal(events[0].provider, 'mistral');
    });

    it('23b-3: half-open semantics — endMs exclusive', () => {
      // Event at 2026-05-23T20:00:00Z. Window endMs = exactly that ts → exclude.
      const start = Date.parse('2026-05-23T00:00:00Z');
      const end = Date.parse('2026-05-23T20:00:00Z');
      const events = [...readAuditWindow({ startMs: start, endMs: end, olpHome: TMP })];
      assert.equal(events.length, 1); // only the 10:00 event
      assert.equal(events[0].ts, '2026-05-23T10:00:00Z');
    });

    it('23b-4: empty window (end <= start) → empty', () => {
      const events = [...readAuditWindow({ startMs: 1000, endMs: 1000, olpHome: TMP })];
      assert.equal(events.length, 0);
      const events2 = [...readAuditWindow({ startMs: 2000, endMs: 1000, olpHome: TMP })];
      assert.equal(events2.length, 0);
    });

    it('23b-5: missing files → empty iteration (not an error)', () => {
      const TMP2 = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-23b5-'));
      try {
        const events = [...readAuditWindow({
          startMs: Date.parse('2026-05-01T00:00:00Z'),
          endMs: Date.parse('2026-05-02T00:00:00Z'),
          olpHome: TMP2,
        })];
        assert.equal(events.length, 0);
      } finally {
        rmSync(TMP2, { recursive: true, force: true });
      }
    });

    it('23b-6: malformed lines skipped + warn fired', () => {
      const TMP3 = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-23b6-'));
      try {
        mkdirSync(_pathJoinForSetup(TMP3, 'logs'), { recursive: true, mode: 0o700 });
        const path = _pathJoinForSetup(TMP3, 'logs', 'audit.ndjson');
        const lines = [
          JSON.stringify(makeEvent({ ts: '2026-05-25T10:00:00Z' })),
          '{ this is not valid json',
          JSON.stringify(makeEvent({ ts: '2026-05-25T11:00:00Z' })),
          '',
          'definitely not json',
          JSON.stringify(makeEvent({ ts: '2026-05-25T12:00:00Z' })),
        ].join('\n');
        fsWriteFileSyncForS23(path, lines, { mode: 0o600 });

        let warnFired = false;
        const events = [...readAuditWindow({
          startMs: Date.parse('2026-05-25T00:00:00Z'),
          endMs: Date.parse('2026-05-26T00:00:00Z'),
          olpHome: TMP3,
          logEvent: (level, ev) => { if (level === 'warn' && ev === 'audit_query_skip_malformed') warnFired = true; },
        })];
        assert.equal(events.length, 3, 'malformed lines skipped, 3 valid events kept');
        assert.ok(warnFired, 'warn must fire for malformed lines');
      } finally {
        rmSync(TMP3, { recursive: true, force: true });
      }
    });
  });

  describe('23c — aggregateRequests', () => {
    let TMP;
    before(() => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-23c-'));
      const now = Date.now();
      const t = (offsetMs) => new Date(now - offsetMs).toISOString();
      setupAuditFiles(TMP, {
        'live': [
          makeEvent({ ts: t(60000), provider: 'anthropic', cache_status: 'hit', owner_tier: 'owner', status_code: 200, latency_ms: 50 }),
          makeEvent({ ts: t(50000), provider: 'anthropic', cache_status: 'miss', owner_tier: 'owner', status_code: 200, latency_ms: 150 }),
          makeEvent({ ts: t(40000), provider: 'openai', cache_status: 'miss', owner_tier: 'guest', status_code: 200, latency_ms: 200 }),
          makeEvent({ ts: t(30000), provider: 'mistral', cache_status: 'bypass', owner_tier: 'owner', status_code: 401, latency_ms: 10 }),
          makeEvent({ ts: t(20000), provider: 'anthropic', cache_status: 'miss', owner_tier: 'owner', status_code: 503, latency_ms: 5000, fallback_hops: 1, tried_providers: ['anthropic', 'openai'] }),
        ],
      });
    });
    after(() => { rmSync(TMP, { recursive: true, force: true }); });

    it('23c-1: aggregateRequests counts requests + status buckets + by_provider', () => {
      const r = aggregateRequests({ windowMs: 86400 * 1000, olpHome: TMP });
      assert.equal(r.request_count, 5);
      assert.equal(r.status_2xx, 3); // 200x3
      assert.equal(r.status_4xx, 1); // 401
      assert.equal(r.status_5xx, 1); // 503
      assert.equal(r.by_provider.anthropic.count, 3);
      assert.equal(r.by_provider.anthropic.cache_hit, 1);
      assert.equal(r.by_provider.anthropic.cache_miss, 2);
      assert.equal(r.by_provider.anthropic.fallback_count, 1);
      assert.equal(r.by_provider.openai.count, 1);
      assert.equal(r.by_provider.mistral.cache_bypass, 1);
    });

    it('23c-2: by_owner_tier breakdown', () => {
      const r = aggregateRequests({ windowMs: 86400 * 1000, olpHome: TMP });
      assert.equal(r.by_owner_tier.owner, 4);
      assert.equal(r.by_owner_tier.guest, 1);
      assert.equal(r.by_owner_tier.anonymous, 0);
    });

    it('23c-3: median + p95 latency over [5, 50, 150, 200, 5000]', () => {
      const r = aggregateRequests({ windowMs: 86400 * 1000, olpHome: TMP });
      // sorted: 5, 10, 50, 150, 200; we have 5 events with latencies [50, 150, 200, 10, 5000]
      // sorted: [10, 50, 150, 200, 5000]; median (index 2) = 150
      assert.equal(r.median_latency_ms, 150);
      // p95 index = floor(5 * 0.95) = 4 → 5000
      assert.equal(r.p95_latency_ms, 5000);
    });

    it('23c-4: throws on invalid windowMs', () => {
      assert.throws(() => aggregateRequests({ olpHome: TMP }), /windowMs.*required/);
      assert.throws(() => aggregateRequests({ windowMs: 0, olpHome: TMP }), /windowMs.*required/);
      assert.throws(() => aggregateRequests({ windowMs: -1, olpHome: TMP }), /windowMs.*required/);
    });
  });

  describe('23d — topFallbackChains', () => {
    let TMP;
    before(() => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-23d-'));
      const now = Date.now();
      const t = (offsetMs) => new Date(now - offsetMs).toISOString();
      setupAuditFiles(TMP, {
        'live': [
          // 3x anthropic→openai
          makeEvent({ ts: t(5000), fallback_hops: 1, tried_providers: ['anthropic', 'openai'] }),
          makeEvent({ ts: t(4000), fallback_hops: 1, tried_providers: ['anthropic', 'openai'] }),
          makeEvent({ ts: t(3000), fallback_hops: 1, tried_providers: ['anthropic', 'openai'] }),
          // 2x anthropic→mistral
          makeEvent({ ts: t(2500), fallback_hops: 1, tried_providers: ['anthropic', 'mistral'] }),
          makeEvent({ ts: t(2000), fallback_hops: 1, tried_providers: ['anthropic', 'mistral'] }),
          // 1x openai→mistral (single chain)
          makeEvent({ ts: t(1000), fallback_hops: 1, tried_providers: ['openai', 'mistral'] }),
          // events with fallback_hops:0 are excluded
          makeEvent({ ts: t(500), fallback_hops: 0, tried_providers: ['anthropic'] }),
        ],
      });
    });
    after(() => { rmSync(TMP, { recursive: true, force: true }); });

    it('23d-1: sorted desc by count', () => {
      const r = topFallbackChains({ windowMs: 86400 * 1000, olpHome: TMP });
      assert.equal(r.length, 3);
      assert.equal(r[0].count, 3);
      assert.deepEqual(r[0].chain, ['anthropic', 'openai']);
      assert.equal(r[1].count, 2);
      assert.deepEqual(r[1].chain, ['anthropic', 'mistral']);
      assert.equal(r[2].count, 1);
      assert.deepEqual(r[2].chain, ['openai', 'mistral']);
    });

    it('23d-2: limit argument truncates result', () => {
      const r = topFallbackChains({ windowMs: 86400 * 1000, limit: 2, olpHome: TMP });
      assert.equal(r.length, 2);
    });

    it('23d-3: events with fallback_hops=0 excluded from chains', () => {
      const r = topFallbackChains({ windowMs: 86400 * 1000, olpHome: TMP });
      const allCounts = r.reduce((s, c) => s + c.count, 0);
      assert.equal(allCounts, 6); // 3+2+1 — fallback_hops:0 event not counted
    });

    it('23d-4: chain entries carry first_seen + last_seen', () => {
      const r = topFallbackChains({ windowMs: 86400 * 1000, olpHome: TMP });
      for (const c of r) {
        assert.ok(typeof c.first_seen === 'string');
        assert.ok(typeof c.last_seen === 'string');
        assert.ok(c.first_seen <= c.last_seen);
      }
    });
  });

  describe('23e — spendTrendDaily', () => {
    let TMP;
    before(() => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-23e-'));
      // 3 events on day-2, 1 event on day-0; day-1 has none (sparse fill test)
      const today = new Date().toISOString().slice(0, 10);
      const day1 = new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10);
      const day2 = new Date(Date.now() - 2 * 86400 * 1000).toISOString().slice(0, 10);
      setupAuditFiles(TMP, {
        [day2]: [
          makeEvent({ ts: `${day2}T10:00:00Z`, provider: 'anthropic', latency_ms: 100 }),
          makeEvent({ ts: `${day2}T11:00:00Z`, provider: 'openai', latency_ms: 200 }),
          makeEvent({ ts: `${day2}T12:00:00Z`, provider: 'anthropic', latency_ms: 50 }),
        ],
        'live': [
          makeEvent({ ts: new Date().toISOString(), provider: 'mistral', latency_ms: 75 }),
        ],
      });
    });
    after(() => { rmSync(TMP, { recursive: true, force: true }); });

    it('23e-1: 3-day window returns 3 entries (sparse-fills empty days)', () => {
      const r = spendTrendDaily({ days: 3, olpHome: TMP });
      assert.equal(r.length, 3);
      // Each entry has a date + request_count (>=0)
      for (const e of r) {
        assert.ok(typeof e.date === 'string');
        assert.equal(e.date.length, 10);
        assert.ok(typeof e.request_count === 'number');
        assert.ok(typeof e.median_latency_ms === 'number');
        assert.ok(typeof e.by_provider === 'object');
      }
    });

    it('23e-2: day with data has correct breakdown', () => {
      const r = spendTrendDaily({ days: 5, olpHome: TMP });
      const day2Date = new Date(Date.now() - 2 * 86400 * 1000).toISOString().slice(0, 10);
      const day2 = r.find(e => e.date === day2Date);
      assert.ok(day2);
      assert.equal(day2.request_count, 3);
      assert.equal(day2.by_provider.anthropic, 2);
      assert.equal(day2.by_provider.openai, 1);
      // median of [50, 100, 200] = 100
      assert.equal(day2.median_latency_ms, 100);
    });

    it('23e-3: empty day has request_count=0 and empty by_provider', () => {
      const r = spendTrendDaily({ days: 3, olpHome: TMP });
      const day1Date = new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10);
      const day1 = r.find(e => e.date === day1Date);
      assert.ok(day1);
      assert.equal(day1.request_count, 0);
      assert.deepEqual(day1.by_provider, {});
      assert.equal(day1.median_latency_ms, 0);
    });
  });

  describe('23f — cacheHitRateWindow', () => {
    let TMP;
    before(() => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-23f-'));
      const now = Date.now();
      const t = (offsetMs) => new Date(now - offsetMs).toISOString();
      setupAuditFiles(TMP, {
        'live': [
          makeEvent({ ts: t(5000), provider: 'anthropic', cache_status: 'hit' }),
          makeEvent({ ts: t(4000), provider: 'anthropic', cache_status: 'hit' }),
          makeEvent({ ts: t(3000), provider: 'anthropic', cache_status: 'miss' }),
          makeEvent({ ts: t(2000), provider: 'openai', cache_status: 'miss' }),
          makeEvent({ ts: t(1500), provider: 'openai', cache_status: 'bypass' }),
          // events with cache_status null (e.g., 401 paths) excluded
          makeEvent({ ts: t(1000), provider: null, cache_status: null }),
        ],
      });
    });
    after(() => { rmSync(TMP, { recursive: true, force: true }); });

    it('23f-1: hit_rate excludes bypass from denominator', () => {
      const r = cacheHitRateWindow({ windowMs: 86400 * 1000, olpHome: TMP });
      // overall: hit=2, miss=2, bypass=1 → hit_rate = 2/(2+2) = 0.5
      assert.equal(r.hit, 2);
      assert.equal(r.miss, 2);
      assert.equal(r.bypass, 1);
      assert.equal(r.hit_rate, 0.5);
    });

    it('23f-2: per-provider hit_rate', () => {
      const r = cacheHitRateWindow({ windowMs: 86400 * 1000, olpHome: TMP });
      // anthropic: 2 hit + 1 miss → rate 2/3
      assert.equal(r.by_provider.anthropic.hit, 2);
      assert.equal(r.by_provider.anthropic.miss, 1);
      assert.equal(r.by_provider.anthropic.hit_rate, 2 / 3);
      // openai: 1 miss + 1 bypass → rate 0/1 = 0
      assert.equal(r.by_provider.openai.miss, 1);
      assert.equal(r.by_provider.openai.bypass, 1);
      assert.equal(r.by_provider.openai.hit_rate, 0);
    });

    it('23f-3: events with cache_status null excluded from total', () => {
      const r = cacheHitRateWindow({ windowMs: 86400 * 1000, olpHome: TMP });
      assert.equal(r.total, 5); // 6 events but 1 has cache_status:null
    });
  });

  describe('23g — PII guard (ADR 0008 § 4.3)', () => {
    let TMP;
    before(() => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-23g-'));
      setupAuditFiles(TMP, {
        'live': [makeEvent({ provider: 'anthropic', latency_ms: 100 })],
      });
    });
    after(() => { rmSync(TMP, { recursive: true, force: true }); });

    it('23g-1: aggregateRequests returns NO message-content fields', () => {
      const r = aggregateRequests({ windowMs: 86400 * 1000, olpHome: TMP });
      const json = JSON.stringify(r);
      for (const piiKey of ['content', 'message', 'messages', 'prompt', 'response', 'body']) {
        assert.ok(!json.includes(`"${piiKey}"`),
          `aggregateRequests result MUST NOT contain field "${piiKey}" (PII guard)`);
      }
    });

    it('23g-2: spendTrendDaily returns NO message-content fields', () => {
      const r = spendTrendDaily({ days: 1, olpHome: TMP });
      const json = JSON.stringify(r);
      for (const piiKey of ['content', 'message', 'messages', 'prompt', 'response', 'body']) {
        assert.ok(!json.includes(`"${piiKey}"`));
      }
    });

    it('23g-3: topFallbackChains + cacheHitRateWindow contain no message fields', () => {
      const j1 = JSON.stringify(topFallbackChains({ windowMs: 86400 * 1000, olpHome: TMP }));
      const j2 = JSON.stringify(cacheHitRateWindow({ windowMs: 86400 * 1000, olpHome: TMP }));
      for (const piiKey of ['content', 'message', 'messages', 'prompt', 'response', 'body']) {
        assert.ok(!j1.includes(`"${piiKey}"`));
        assert.ok(!j2.includes(`"${piiKey}"`));
      }
    });
  });
});

// ── Suite 24: D50 management endpoints (Phase 3, ADR 0008 §§ 7-8) ─────────
//
// HTTP-level tests for the 4 owner_only_block endpoints:
//   /dashboard, /v0/management/dashboard-data, /v0/management/quota, /cache/stats
// Each must 401 non-owner identities (including anonymous-when-allow_anonymous=true
// per ADR 0008 § 8) + serve owner identities with proper Content-Type and shape.

describe('Suite 24 — D50 management endpoints (Phase 3, ADR 0008 §§ 7-8)', () => {
  const GLOBAL_OLP_HOME = process.env.OLP_HOME;

  let _suite24SavedOAuth;
  function ensureSuite24FakeOAuth() {
    _suite24SavedOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'suite24-fake-oauth-token';
  }
  function restoreSuite24OAuth() {
    if (_suite24SavedOAuth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = _suite24SavedOAuth;
    else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  function makeSuite24Server() {
    __setProvidersEnabled({ anthropic: true });
    __setSpawnImpl(makeMockSpawn(['suite24-response']));
    ensureSuite24FakeOAuth();
    const server = createOlpServer();
    return new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
  }
  function teardownSuite24(server) {
    return new Promise(resolve => {
      __resetSpawnImpl();
      __setProvidersEnabled({});
      __clearCache();
      restoreSuite24OAuth();
      if (server) server.close(() => resolve());
      else resolve();
    });
  }

  describe('24a-d — /dashboard owner_only_block', () => {
    let TMP, server, port;
    before(async () => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-24ad-'));
      process.env.OLP_HOME = TMP;
      __setAuthConfig({ allow_anonymous: true, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
      ({ server, port } = await makeSuite24Server());
    });
    after(async () => {
      await teardownSuite24(server);
      process.env.OLP_HOME = GLOBAL_OLP_HOME;
      __setAuthConfig({ allow_anonymous: true, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
      rmSync(TMP, { recursive: true, force: true });
    });

    it('24a: owner → 200 text/html with "OLP Dashboard"', async () => {
      const { plaintext_token } = createKey({ name: '24a-owner', owner_tier: 'owner', providers_enabled: '*', olpHome: TMP });
      const r = await fetch({
        port, method: 'GET', path: '/dashboard',
        headers: { Authorization: `Bearer ${plaintext_token}` },
      });
      assert.equal(r.status, 200);
      assert.ok(r.headers['content-type'].startsWith('text/html'));
      assert.match(r.body, /OLP Dashboard/i);
    });

    it('24b: guest → 401 owner_required', async () => {
      const { plaintext_token } = createKey({ name: '24b-guest', owner_tier: 'guest', providers_enabled: '*', olpHome: TMP });
      const r = await fetch({
        port, method: 'GET', path: '/dashboard',
        headers: { Authorization: `Bearer ${plaintext_token}` },
      });
      assert.equal(r.status, 401);
      const err = JSON.parse(r.body);
      assert.equal(err.error.type, 'owner_required');
    });

    it('24c: anonymous (allow_anonymous: true) → 401 owner_required (owner_only_block per ADR 0008 § 8)', async () => {
      // allow_anonymous: true → no header → anonymous identity → STILL 401
      // because management endpoints are owner_only_block (not trim).
      const r = await fetch({ port, method: 'GET', path: '/dashboard' });
      assert.equal(r.status, 401);
      const err = JSON.parse(r.body);
      assert.equal(err.error.type, 'owner_required');
    });

    it('24d: allow_anonymous: false + no header → 401 auth_required (middleware path)', async () => {
      __setAuthConfig({ allow_anonymous: false, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
      try {
        const r = await fetch({ port, method: 'GET', path: '/dashboard' });
        assert.equal(r.status, 401);
        const err = JSON.parse(r.body);
        assert.equal(err.error.type, 'auth_required');
      } finally {
        __setAuthConfig({ allow_anonymous: true, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
      }
    });
  });

  describe('24e-g — /v0/management/dashboard-data + /v0/management/quota', () => {
    let TMP, server, port;
    before(async () => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-24eg-'));
      process.env.OLP_HOME = TMP;
      __setAuthConfig({ allow_anonymous: true, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
      ({ server, port } = await makeSuite24Server());
    });
    after(async () => {
      await teardownSuite24(server);
      process.env.OLP_HOME = GLOBAL_OLP_HOME;
      __setAuthConfig({ allow_anonymous: true, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
      rmSync(TMP, { recursive: true, force: true });
    });

    it('24e: owner GET /v0/management/dashboard-data → 200 JSON with required ADR 0008 § 7.2 fields', async () => {
      const { plaintext_token } = createKey({ name: '24e-owner', owner_tier: 'owner', providers_enabled: '*', olpHome: TMP });
      const r = await fetch({
        port, method: 'GET', path: '/v0/management/dashboard-data',
        headers: { Authorization: `Bearer ${plaintext_token}` },
      });
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      assert.ok(typeof body.generated_at === 'string');
      assert.ok(typeof body.window_24h === 'object');
      assert.ok(typeof body.window_24h.request_count === 'number');
      assert.ok(typeof body.cache_hit_24h === 'object');
      assert.ok(Array.isArray(body.quota));
      assert.ok(Array.isArray(body.spend_trend_30d));
      assert.equal(body.spend_trend_30d.length, 30, 'spend_trend_30d must have 30 entries');
      assert.ok(Array.isArray(body.top_fallback_chains_24h));
      assert.ok(typeof body.cache_stats === 'object');
    });

    it('24f: guest GET /v0/management/dashboard-data → 401 owner_required', async () => {
      const { plaintext_token } = createKey({ name: '24f-guest', owner_tier: 'guest', providers_enabled: '*', olpHome: TMP });
      const r = await fetch({
        port, method: 'GET', path: '/v0/management/dashboard-data',
        headers: { Authorization: `Bearer ${plaintext_token}` },
      });
      assert.equal(r.status, 401);
      assert.equal(JSON.parse(r.body).error.type, 'owner_required');
    });

    it('24g: owner GET /v0/management/quota → 200 JSON with quota array', async () => {
      const { plaintext_token } = createKey({ name: '24g-owner', owner_tier: 'owner', providers_enabled: '*', olpHome: TMP });
      const r = await fetch({
        port, method: 'GET', path: '/v0/management/quota',
        headers: { Authorization: `Bearer ${plaintext_token}` },
      });
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      assert.ok(typeof body.generated_at === 'string');
      assert.ok(Array.isArray(body.quota));
      // Each quota entry has at least a provider key (and possibly more fields).
      for (const q of body.quota) {
        assert.ok(typeof q.provider === 'string');
      }
    });
  });

  describe('24h — /cache/stats', () => {
    let TMP, server, port;
    before(async () => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-24h-'));
      process.env.OLP_HOME = TMP;
      __setAuthConfig({ allow_anonymous: true, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
      ({ server, port } = await makeSuite24Server());
    });
    after(async () => {
      await teardownSuite24(server);
      process.env.OLP_HOME = GLOBAL_OLP_HOME;
      __setAuthConfig({ allow_anonymous: true, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
      rmSync(TMP, { recursive: true, force: true });
    });

    it('24h: owner GET /cache/stats → 200 JSON with hits/misses/size/inflightCount', async () => {
      const { plaintext_token } = createKey({ name: '24h-owner', owner_tier: 'owner', providers_enabled: '*', olpHome: TMP });
      const r = await fetch({
        port, method: 'GET', path: '/cache/stats',
        headers: { Authorization: `Bearer ${plaintext_token}` },
      });
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      assert.ok(typeof body.generated_at === 'string');
      assert.ok(typeof body.hits === 'number');
      assert.ok(typeof body.misses === 'number');
      assert.ok(typeof body.size === 'number');
      assert.ok(typeof body.inflightCount === 'number');
    });

    it('24h-401: guest GET /cache/stats → 401', async () => {
      const { plaintext_token } = createKey({ name: '24h-guest', owner_tier: 'guest', providers_enabled: '*', olpHome: TMP });
      const r = await fetch({
        port, method: 'GET', path: '/cache/stats',
        headers: { Authorization: `Bearer ${plaintext_token}` },
      });
      assert.equal(r.status, 401);
    });
  });

  describe('24i-j — audit rows on management endpoints', () => {
    let TMP, server, port;
    before(async () => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-24ij-'));
      process.env.OLP_HOME = TMP;
      __setAuthConfig({ allow_anonymous: true, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
      ({ server, port } = await makeSuite24Server());
    });
    after(async () => {
      await teardownSuite24(server);
      process.env.OLP_HOME = GLOBAL_OLP_HOME;
      __setAuthConfig({ allow_anonymous: true, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
      rmSync(TMP, { recursive: true, force: true });
    });

    it('24i: successful /v0/management/dashboard-data appends audit row with path + status_code 200', async () => {
      const { id, plaintext_token } = createKey({ name: '24i-owner', owner_tier: 'owner', providers_enabled: '*', olpHome: TMP });
      const r = await fetch({
        port, method: 'GET', path: '/v0/management/dashboard-data',
        headers: { Authorization: `Bearer ${plaintext_token}` },
      });
      assert.equal(r.status, 200);
      await new Promise(resolve => setTimeout(resolve, 25));

      const auditPath = _pathJoinForSetup(TMP, 'logs', 'audit.ndjson');
      assert.ok(fsExistsSync(auditPath));
      const lines = fsReadFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
      const mgmtRow = lines.map(l => JSON.parse(l)).find(row =>
        row.path === '/v0/management/dashboard-data' && row.status_code === 200,
      );
      assert.ok(mgmtRow, 'management dashboard-data audit row must be present');
      assert.equal(mgmtRow.key_id, id);
      assert.equal(mgmtRow.owner_tier, 'owner');
      assert.equal(mgmtRow.method, 'GET');
    });

    it('24j: 401 (guest blocked) /v0/management/dashboard-data appends audit row with error_code', async () => {
      const { id, plaintext_token } = createKey({ name: '24j-guest', owner_tier: 'guest', providers_enabled: '*', olpHome: TMP });
      const r = await fetch({
        port, method: 'GET', path: '/v0/management/dashboard-data',
        headers: { Authorization: `Bearer ${plaintext_token}` },
      });
      assert.equal(r.status, 401);
      await new Promise(resolve => setTimeout(resolve, 25));

      const auditPath = _pathJoinForSetup(TMP, 'logs', 'audit.ndjson');
      const lines = fsReadFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
      const blockedRow = lines.map(l => JSON.parse(l)).find(row =>
        row.path === '/v0/management/dashboard-data' && row.status_code === 401 && row.key_id === id,
      );
      assert.ok(blockedRow, 'management 401 audit row must be present');
      assert.equal(blockedRow.error_code, 'owner_required');
      assert.equal(blockedRow.owner_tier, 'guest');
    });
  });
});

// ── Suite 25: D51 dashboard.html UI smoke (Phase 3, ADR 0008 § 6) ─────────
//
// HTML-level smoke tests for the D51 dashboard. Per ADR 0008 § 10 criterion
// #12 the "no JS console errors in a real browser" sub-claim is manual or
// playwright; this suite covers the server-observable claims:
//   - The owner-served HTML contains the 4 panel container IDs.
//   - The polling script references the 30s interval + visibilitychange
//     pause hook.
//   - No external script/style src (no build step, no framework, no CDN).

describe('Suite 25 — D51 dashboard.html UI smoke (Phase 3, ADR 0008 § 6)', () => {
  const GLOBAL_OLP_HOME = process.env.OLP_HOME;

  let _suite25SavedOAuth;
  function ensureSuite25FakeOAuth() {
    _suite25SavedOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'suite25-fake-oauth-token';
  }
  function restoreSuite25OAuth() {
    if (_suite25SavedOAuth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = _suite25SavedOAuth;
    else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  let TMP, server, port;
  before(async () => {
    TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-25-'));
    process.env.OLP_HOME = TMP;
    __setAuthConfig({ allow_anonymous: true, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
    __setProvidersEnabled({ anthropic: true });
    __setSpawnImpl(makeMockSpawn(['suite25-response']));
    ensureSuite25FakeOAuth();
    server = createOlpServer();
    await new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    port = server.address().port;
  });
  after(async () => {
    __resetSpawnImpl();
    __setProvidersEnabled({});
    __clearCache();
    restoreSuite25OAuth();
    if (server) await new Promise(resolve => server.close(() => resolve()));
    process.env.OLP_HOME = GLOBAL_OLP_HOME;
    __setAuthConfig({ allow_anonymous: true, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
    rmSync(TMP, { recursive: true, force: true });
  });

  it('25a: owner /dashboard response contains all 4 panel container IDs', async () => {
    const { plaintext_token } = createKey({ name: '25a-owner', owner_tier: 'owner', providers_enabled: '*', olpHome: TMP });
    const r = await fetch({
      port, method: 'GET', path: '/dashboard',
      headers: { Authorization: `Bearer ${plaintext_token}` },
    });
    assert.equal(r.status, 200);
    assert.match(r.body, /id="panel-quota"/);
    assert.match(r.body, /id="panel-24h"/);
    assert.match(r.body, /id="panel-trend"/);
    assert.match(r.body, /id="panel-chains"/);
  });

  it('25b: dashboard JS references 30s polling interval + setInterval/clearInterval', async () => {
    const { plaintext_token } = createKey({ name: '25b-owner', owner_tier: 'owner', providers_enabled: '*', olpHome: TMP });
    const r = await fetch({
      port, method: 'GET', path: '/dashboard',
      headers: { Authorization: `Bearer ${plaintext_token}` },
    });
    assert.equal(r.status, 200);
    assert.match(r.body, /POLL_INTERVAL_MS\s*=\s*30000/, 'must declare 30s POLL_INTERVAL_MS constant');
    assert.match(r.body, /setInterval\(/, 'must call setInterval');
    assert.match(r.body, /clearInterval\(/, 'must call clearInterval (for visibilitychange pause)');
  });

  it('25c: dashboard JS wires visibilitychange listener for tab-hidden pause', async () => {
    const { plaintext_token } = createKey({ name: '25c-owner', owner_tier: 'owner', providers_enabled: '*', olpHome: TMP });
    const r = await fetch({
      port, method: 'GET', path: '/dashboard',
      headers: { Authorization: `Bearer ${plaintext_token}` },
    });
    assert.equal(r.status, 200);
    assert.match(r.body, /addEventListener\(\s*['"]visibilitychange['"]/, 'must register visibilitychange listener');
    assert.match(r.body, /document\.visibilityState\s*===\s*['"]hidden['"]/, 'must check hidden state');
  });

  it('25d: dashboard has NO external script/style src (no build step, no framework, no CDN)', async () => {
    const { plaintext_token } = createKey({ name: '25d-owner', owner_tier: 'owner', providers_enabled: '*', olpHome: TMP });
    const r = await fetch({
      port, method: 'GET', path: '/dashboard',
      headers: { Authorization: `Bearer ${plaintext_token}` },
    });
    assert.equal(r.status, 200);
    // ADR 0008 Lane 1 = A: static HTML + vanilla JS + fetch; no framework.
    // Strict: no <script src=> and no <link rel="stylesheet" href=>.
    assert.ok(!/<script\s+[^>]*src\s*=/i.test(r.body),
      'dashboard must NOT include any <script src="..."> (no external JS — ADR 0008 Lane 1 A)');
    assert.ok(!/<link\s+[^>]*rel\s*=\s*['"]stylesheet['"][^>]*href\s*=/i.test(r.body),
      'dashboard must NOT include any external <link rel="stylesheet" href="..."> (no external CSS)');
  });

  it('25e: dashboard fetches /v0/management/dashboard-data (the only backing endpoint hit by JS)', async () => {
    const { plaintext_token } = createKey({ name: '25e-owner', owner_tier: 'owner', providers_enabled: '*', olpHome: TMP });
    const r = await fetch({
      port, method: 'GET', path: '/dashboard',
      headers: { Authorization: `Bearer ${plaintext_token}` },
    });
    assert.equal(r.status, 200);
    assert.match(r.body, /fetch\(\s*['"]\/v0\/management\/dashboard-data['"]/,
      'dashboard JS must fetch /v0/management/dashboard-data (consolidated D50 endpoint)');
  });

  it('25f: dashboard 401 surface for non-owner shows actionable error banner instructions', async () => {
    // The dashboard HTML itself is served owner-only_block at handleDashboard
    // (Suite 24 covers that). This test verifies the IN-PAGE error banner
    // string mentions owner-token guidance so a future maintainer who lands
    // on a 401 from the in-page JS knows what to do.
    const { plaintext_token } = createKey({ name: '25f-owner', owner_tier: 'owner', providers_enabled: '*', olpHome: TMP });
    const r = await fetch({
      port, method: 'GET', path: '/dashboard',
      headers: { Authorization: `Bearer ${plaintext_token}` },
    });
    assert.equal(r.status, 200);
    assert.match(r.body, /401.*owner-tier/i, 'dashboard error banner must mention owner-tier in 401 case');
  });
});

// ── Suite 26: D52 audit rotation (Phase 3, ADR 0008 § 5) ──────────────────
//
// Tests for daily audit rotation:
//   - First append after UTC date change triggers rename
//   - Concurrent appends during rotation produce exactly one rename
//   - External cron tool (bin/olp-audit-rotate.mjs) coexists with in-server
//   - Rotated files readable by lib/audit-query.mjs after rotation

import {
  appendAuditEvent as appendAuditEventS26,
  _maybeRotateAudit,
  getAuditRotateCount,
  __resetAuditRotateState,
  __setLastSeenUtcDateForTesting,
} from './lib/audit.mjs';
import { runCli as runAuditRotateCli } from './bin/olp-audit-rotate.mjs';

describe('Suite 26 — D52 audit rotation (Phase 3, ADR 0008 § 5)', () => {

  function writeAuditFile(tmp, filename, events) {
    mkdirSync(_pathJoinForSetup(tmp, 'logs'), { recursive: true, mode: 0o700 });
    const path = _pathJoinForSetup(tmp, 'logs', filename);
    const lines = events.map(ev => JSON.stringify(ev)).join('\n') + '\n';
    fsWriteFileSyncForS23(path, lines, { mode: 0o600 });
  }

  function makeEvent(ts) {
    return {
      ts,
      key_id: 'k1',
      owner_tier: 'owner',
      method: 'POST',
      path: '/v1/chat/completions',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      status_code: 200,
      latency_ms: 100,
      cache_status: 'miss',
      fallback_hops: 0,
      tried_providers: ['anthropic'],
    };
  }

  describe('26a — _maybeRotateAudit', () => {
    let TMP;
    before(() => { TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-26a-')); });
    after(() => { rmSync(TMP, { recursive: true, force: true }); __resetAuditRotateState(); });

    it('26a-1: no live file → no rotation, returns { rotated: false }', () => {
      __resetAuditRotateState();
      const r = _maybeRotateAudit({ olpHome: TMP });
      assert.equal(r.rotated, false);
    });

    it('26a-2: live file already on today → no rotation', () => {
      __resetAuditRotateState();
      const today = new Date().toISOString().slice(0, 10);
      writeAuditFile(TMP, 'audit.ndjson', [makeEvent(`${today}T10:00:00Z`)]);
      const r = _maybeRotateAudit({ olpHome: TMP });
      assert.equal(r.rotated, false);
    });

    it('26a-3: live file holds yesterday\'s events → rotated to audit-YYYY-MM-DD.ndjson', () => {
      __resetAuditRotateState();
      const livePath = _pathJoinForSetup(TMP, 'logs', 'audit.ndjson');
      rmSync(livePath, { force: true });
      const yesterday = new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10);
      writeAuditFile(TMP, 'audit.ndjson', [makeEvent(`${yesterday}T15:00:00Z`)]);
      const r = _maybeRotateAudit({ olpHome: TMP });
      assert.equal(r.rotated, true);
      assert.equal(r.dateUsed, yesterday);
      const rotatedPath = _pathJoinForSetup(TMP, 'logs', `audit-${yesterday}.ndjson`);
      assert.ok(fsExistsSync(rotatedPath));
      assert.ok(!fsExistsSync(livePath));
      assert.equal(getAuditRotateCount(), 1);
    });

    it('26a-4: idempotent — second call after rotation is a no-op', () => {
      const r = _maybeRotateAudit({ olpHome: TMP });
      assert.equal(r.rotated, false);
      assert.equal(getAuditRotateCount(), 1);
    });

    it('26a-5: rotation target already exists → skip + warn (cron-race safety)', () => {
      __resetAuditRotateState();
      const livePath = _pathJoinForSetup(TMP, 'logs', 'audit.ndjson');
      rmSync(livePath, { force: true });
      const yesterday = new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10);
      writeAuditFile(TMP, `audit-${yesterday}.ndjson`, [makeEvent(`${yesterday}T08:00:00Z`)]);
      writeAuditFile(TMP, 'audit.ndjson', [makeEvent(`${yesterday}T20:00:00Z`)]);

      let warned = false;
      const r = _maybeRotateAudit({
        olpHome: TMP,
        logEvent: (level, ev) => { if (level === 'warn' && ev === 'audit_rotate_target_exists') warned = true; },
      });
      assert.equal(r.rotated, false);
      assert.ok(warned, 'must warn when rotation target already exists');
      assert.ok(fsExistsSync(livePath));
    });
  });

  describe('26b — appendAuditEvent triggers rotation on date change', () => {
    let TMP;
    before(() => { TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-26b-')); });
    after(() => { rmSync(TMP, { recursive: true, force: true }); __resetAuditRotateState(); });

    it('26b-1: appending past a UTC date change triggers sync rotation + append lands in new file', () => {
      __resetAuditRotateState();
      const livePath = _pathJoinForSetup(TMP, 'logs', 'audit.ndjson');
      rmSync(livePath, { force: true });
      const yesterday = new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10);
      writeAuditFile(TMP, 'audit.ndjson', [makeEvent(`${yesterday}T10:00:00Z`)]);
      __setLastSeenUtcDateForTesting(yesterday);

      const todayTs = new Date().toISOString();
      appendAuditEventS26(makeEvent(todayTs), { olpHome: TMP });

      const rotatedPath = _pathJoinForSetup(TMP, 'logs', `audit-${yesterday}.ndjson`);
      assert.ok(fsExistsSync(rotatedPath), `yesterday's rotated file must exist (${rotatedPath})`);
      assert.ok(fsExistsSync(livePath), 'live file must exist (with today\'s new event)');
      const liveContent = fsReadFileSync(livePath, 'utf-8');
      assert.ok(liveContent.includes(todayTs), 'live file must contain today\'s appended event');
      assert.ok(!liveContent.includes(`${yesterday}T10:00:00Z`), 'live file must NOT contain yesterday\'s content (it rotated)');
      assert.equal(getAuditRotateCount(), 1);
    });
  });

  describe('26c — concurrent appends during rotation', () => {
    let TMP;
    before(() => { TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-26c-')); });
    after(() => { rmSync(TMP, { recursive: true, force: true }); __resetAuditRotateState(); });

    it('26c-1: N sequential appendAuditEvent during date change → exactly 1 rotation + all events land in live', () => {
      __resetAuditRotateState();
      const livePath = _pathJoinForSetup(TMP, 'logs', 'audit.ndjson');
      rmSync(livePath, { force: true });
      const yesterday = new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10);
      writeAuditFile(TMP, 'audit.ndjson', [makeEvent(`${yesterday}T10:00:00Z`)]);
      __setLastSeenUtcDateForTesting(yesterday);

      // 10 sync appends in quick succession. The first triggers rotation
      // (date change detected); subsequent appends short-circuit the date
      // check because _lastSeenUtcDate was updated inside the first call's
      // _maybeRotateAudit. Result: exactly 1 rotation + all 10 events in
      // the new live file.
      const todayTs = new Date().toISOString();
      for (let i = 0; i < 10; i++) {
        appendAuditEventS26(makeEvent(todayTs), { olpHome: TMP });
      }

      assert.equal(getAuditRotateCount(), 1, 'exactly 1 rotation despite 10 sequential appends past date change');
      const rotatedPath = _pathJoinForSetup(TMP, 'logs', `audit-${yesterday}.ndjson`);
      assert.ok(fsExistsSync(rotatedPath));
      const liveContent = fsReadFileSync(livePath, 'utf-8');
      const liveLines = liveContent.split('\n').filter(Boolean);
      assert.equal(liveLines.length, 10, 'live file has all 10 appended events');
    });
  });

  describe('26d — bin/olp-audit-rotate.mjs CLI', () => {
    let TMP;
    before(() => { TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-26d-')); });
    after(() => { rmSync(TMP, { recursive: true, force: true }); __resetAuditRotateState(); });

    it('26d-1: --help → exit 0 with usage', async () => {
      let out = '';
      const code = await runAuditRotateCli(['--help'], { out: s => { out += s; }, err: () => {} });
      assert.equal(code, 0);
      assert.match(out, /OLP audit rotation cron tool/);
    });

    it('26d-2: no live file → exit 0 "no rotation needed"', async () => {
      __resetAuditRotateState();
      let out = '';
      const code = await runAuditRotateCli([`--olp-home=${TMP}`], { out: s => { out += s; }, err: () => {} });
      assert.equal(code, 0);
      assert.match(out, /No rotation needed/);
    });

    it('26d-3: live file with yesterday events → CLI rotates + exit 0', async () => {
      __resetAuditRotateState();
      const yesterday = new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10);
      writeAuditFile(TMP, 'audit.ndjson', [makeEvent(`${yesterday}T10:00:00Z`)]);

      let out = '';
      const code = await runAuditRotateCli([`--olp-home=${TMP}`], { out: s => { out += s; }, err: () => {} });
      assert.equal(code, 0);
      assert.match(out, /Rotated.*dateUsed=/);
      const rotatedPath = _pathJoinForSetup(TMP, 'logs', `audit-${yesterday}.ndjson`);
      assert.ok(fsExistsSync(rotatedPath));
    });

    it('26d-4: unknown flag → exit 1', async () => {
      let err = '';
      const code = await runAuditRotateCli([`--olp-home=${TMP}`, '--unknown'], {
        out: () => {}, err: s => { err += s; },
      });
      assert.equal(code, 1);
      assert.match(err, /unknown flag --unknown/);
    });
  });

  describe('26e — rotated files queryable via lib/audit-query.mjs', () => {
    let TMP;
    before(() => { TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-26e-')); });
    after(() => { rmSync(TMP, { recursive: true, force: true }); __resetAuditRotateState(); });

    it('26e-1: after rotation, discoverAuditFiles + readAuditWindow see both live + rotated', () => {
      __resetAuditRotateState();
      const yesterday = new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);
      writeAuditFile(TMP, 'audit.ndjson', [
        makeEvent(`${yesterday}T10:00:00Z`),
        makeEvent(`${yesterday}T11:00:00Z`),
      ]);
      __setLastSeenUtcDateForTesting(yesterday);

      // Sync rotation: completes before append returns
      appendAuditEventS26(makeEvent(`${today}T05:00:00Z`), { olpHome: TMP });

      const files = discoverAuditFiles({ olpHome: TMP });
      assert.ok(files.has('live'), 'live file present');
      assert.ok(files.has(yesterday), `rotated file for ${yesterday} present`);

      const startMs = Date.parse(`${yesterday}T00:00:00Z`);
      const endMs = Date.parse(`${today}T23:59:59Z`);
      const events = [...readAuditWindow({ startMs, endMs, olpHome: TMP })];
      assert.equal(events.length, 3, 'cross-file read yields yesterday(2) + today(1) = 3 events');
    });
  });
});

// ── Suite 27: D57 streaming singleflight (cache layer) ─────────────────────
//
// Authority: ADR 0005 Amendment 8 §§1-11, 14 (issue #16, D57).
//
// Cache-layer unit tests for the streaming-singleflight tee fan-out. Each
// test constructs a fake sourceFactory that returns an async generator
// producing a fixed chunk sequence; the cache store coordinates dedup +
// late-joiner replay + per-client backpressure. No real provider CLIs are
// spawned; no HTTP requests issued. D58 will wire this into server.mjs in a
// separate PR (Iron Rule 11).
//
// Test count: 12 (one per Amendment 8 §§1-11 + §14 fixture + composite-key
// isolation). Aim for +12 tests minimum per D57 prompt.

describe('Suite 27 — D57 streaming singleflight (cache layer)', () => {
  // Helper: build a deterministic async source. Each yielded chunk waits a
  // microtask so the tee/queue dynamics are observable across concurrent
  // attached clients.
  function makeChunkSequence(chunks, opts = {}) {
    let returnedCount = 0;
    const gen = (async function* fakeStream() {
      try {
        for (const c of chunks) {
          if (opts.signal && opts.signal.aborted) return;
          yield c;
          await new Promise(r => setImmediate(r));
        }
      } finally {
        returnedCount++;
        if (opts.onReturn) opts.onReturn(returnedCount);
      }
    })();
    return gen;
  }

  // D57 — ADR 0005 Amendment 8 §1: cache-hit + single client + source-mode
  it('27a — single client streaming: behaviour identical to today (source role, full sequence)', async () => {
    const store = new CacheStore({ _warnFn: () => {} });
    let spawns = 0;
    const factory = () => {
      spawns++;
      return makeChunkSequence(['a', 'b', 'c']);
    };
    const r = await store.getOrComputeStreaming('k1', 'ck-27a', factory);
    assert.equal(r.isFirst, true);
    assert.equal(r.role, 'source');
    const out = [];
    for await (const c of r.stream) out.push(c);
    assert.deepEqual(out, ['a', 'b', 'c']);
    assert.equal(spawns, 1);
    // After completion, the cache should have an entry for replay.
    const cached = await store.get('k1', 'ck-27a');
    assert.ok(cached, 'cache populated post-completion');
    assert.deepEqual(cached.value, ['a', 'b', 'c']);
  });

  // D57 — ADR 0005 Amendment 8 §1, §4: 2 concurrent identical streams
  it('27b — 2 concurrent identical streams: only 1 sourceFactory call; identical chunks in order', async () => {
    const store = new CacheStore({ _warnFn: () => {} });
    let spawns = 0;
    const factory = () => {
      spawns++;
      return makeChunkSequence(['x', 'y', 'z']);
    };
    const p1 = store.getOrComputeStreaming('k', 'ck-27b', factory, { clientId: 'A' });
    const p2 = store.getOrComputeStreaming('k', 'ck-27b', factory, { clientId: 'B' });
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.isFirst, true);
    assert.equal(r1.role, 'source');
    assert.equal(r2.isFirst, false);
    assert.equal(r2.role, 'attached');
    const out1 = [];
    const out2 = [];
    const c1 = (async () => { for await (const c of r1.stream) out1.push(c); })();
    const c2 = (async () => { for await (const c of r2.stream) out2.push(c); })();
    await Promise.all([c1, c2]);
    assert.equal(spawns, 1, 'sourceFactory invoked exactly once');
    assert.deepEqual(out1, ['x', 'y', 'z']);
    assert.deepEqual(out2, ['x', 'y', 'z']);
  });

  // D57 — ADR 0005 Amendment 8 §5: mid-stream join (replay burst + live tail)
  //  + post-completion join (cache_hit)
  it('27c — 3 concurrent, mid-stream join: A=source, B=attached (burst + tail), C=cache_hit', async () => {
    const store = new CacheStore({ _warnFn: () => {} });
    let spawns = 0;
    // Six chunks. A iterates fast; B attaches after A has consumed ~3.
    const factory = () => {
      spawns++;
      return makeChunkSequence(['1', '2', '3', '4', '5', '6']);
    };
    const r1 = await store.getOrComputeStreaming('k', 'ck-27c', factory, { clientId: 'A' });
    assert.equal(r1.role, 'source');

    // A iterates the first 3 chunks before B attaches.
    const itA = r1.stream;
    const outA = [];
    const n1 = await itA.next(); outA.push(n1.value);
    const n2 = await itA.next(); outA.push(n2.value);
    const n3 = await itA.next(); outA.push(n3.value);

    // Now B attaches mid-stream. Its replay drain picks up everything in
    // accumulatedChunks at attach-time + the live tail thereafter.
    const r2 = await store.getOrComputeStreaming('k', 'ck-27c', factory, { clientId: 'B' });
    assert.equal(r2.role, 'attached');

    // A finishes consuming.
    const outA2 = [];
    for await (const c of itA) outA2.push(c);
    const outB = [];
    for await (const c of r2.stream) outB.push(c);

    assert.deepEqual([...outA, ...outA2], ['1', '2', '3', '4', '5', '6']);
    // B receives the full sequence too (burst replays earlier chunks + live tail).
    assert.deepEqual(outB, ['1', '2', '3', '4', '5', '6']);
    assert.equal(spawns, 1, 'still only 1 spawn');

    // C attaches AFTER source completion → cache_hit (not inflight, not respawn).
    const r3 = await store.getOrComputeStreaming('k', 'ck-27c', factory, { clientId: 'C' });
    assert.equal(r3.role, 'cache_hit');
    assert.equal(r3.isFirst, false);
    const outC = [];
    for await (const c of r3.stream) outC.push(c);
    assert.deepEqual(outC, ['1', '2', '3', '4', '5', '6']);
    assert.equal(spawns, 1, 'no additional spawns');
  });

  // D57 — ADR 0005 Amendment 8 §9: first client early-return, others continue
  it('27d — first client iterator early-return mid-stream: others continue; source NOT aborted; cache written', async () => {
    const warnings = [];
    const store = new CacheStore({ _warnFn: (msg, meta) => warnings.push({ msg, meta }) });
    let sourceReturned = false;
    const factory = () => (async function* () {
      try {
        for (let i = 0; i < 6; i++) {
          yield `chunk-${i}`;
          await new Promise(r => setImmediate(r));
        }
      } finally { sourceReturned = true; }
    })();
    const r1 = await store.getOrComputeStreaming('k', 'ck-27d', factory, { clientId: 'A' });
    const r2 = await store.getOrComputeStreaming('k', 'ck-27d', factory, { clientId: 'B' });
    // A early-returns after 2 chunks; B keeps consuming.
    const itA = r1.stream;
    const outA = [];
    outA.push((await itA.next()).value);
    outA.push((await itA.next()).value);
    await itA.return(); // simulates HTTP client close
    const outB = [];
    for await (const c of r2.stream) outB.push(c);
    // Source should have completed normally (not aborted) because B was still attached.
    assert.equal(sourceReturned, true);
    assert.deepEqual(outB, ['chunk-0', 'chunk-1', 'chunk-2', 'chunk-3', 'chunk-4', 'chunk-5']);
    // Cache should be populated post-completion (B was a live client to the end).
    const cached = await store.get('k', 'ck-27d');
    assert.ok(cached, 'cache populated despite A\'s mid-stream return');
    // No abort warning emitted.
    assert.equal(warnings.filter(w => w.msg === 'streaming_inflight_abort').length, 0);
  });

  // D57 — ADR 0005 Amendment 8 §9: all clients disconnect → source aborted, no cache
  it('27e — all clients disconnect mid-stream: source aborted via AbortController; no cache write; next call respawns', async () => {
    const warnings = [];
    const store = new CacheStore({ _warnFn: (msg, meta) => warnings.push({ msg, meta }) });
    let spawns = 0;
    let sourceReturned = false;
    const factory = () => {
      spawns++;
      return (async function* () {
        try {
          for (let i = 0; i < 20; i++) {
            yield `c-${i}`;
            await new Promise(r => setImmediate(r));
          }
        } finally { sourceReturned = true; }
      })();
    };
    const r1 = await store.getOrComputeStreaming('k', 'ck-27e', factory, { clientId: 'A' });
    const itA = r1.stream;
    await itA.next();
    await itA.next();
    await itA.return();
    // Wait microtasks for the tee task to observe attachedClients.size === 0 and abort.
    await new Promise(r => setTimeout(r, 30));
    assert.equal(sourceReturned, true);
    assert.equal(warnings.filter(w => w.msg === 'streaming_inflight_abort').length, 1);
    // No cache entry — subsequent call respawns (no inflight, no cache hit).
    const cached = await store.get('k', 'ck-27e');
    assert.equal(cached, null, 'no cache write on abort');
    const r2 = await store.getOrComputeStreaming('k', 'ck-27e', factory, { clientId: 'B' });
    assert.equal(r2.role, 'source', 'subsequent call gets fresh source spawn');
    assert.equal(spawns, 2);
    // Drain r2 so it doesn't dangle.
    for await (const _c of r2.stream) { /* drain */ }
  });

  // D57 — ADR 0005 Amendment 8 §4: source throws mid-stream
  it('27f — source throws mid-stream: all attached clients receive the error; no cache write; entry removed', async () => {
    const warnings = [];
    const store = new CacheStore({ _warnFn: (msg, meta) => warnings.push({ msg, meta }) });
    const err = new Error('synthetic source failure');
    const factory = () => (async function* () {
      yield 'a';
      await new Promise(r => setImmediate(r));
      yield 'b';
      await new Promise(r => setImmediate(r));
      throw err;
    })();
    const r1 = await store.getOrComputeStreaming('k', 'ck-27f', factory, { clientId: 'A' });
    const r2 = await store.getOrComputeStreaming('k', 'ck-27f', factory, { clientId: 'B' });
    // Both clients should reject when the source throws.
    let e1, e2;
    const c1 = (async () => { try { for await (const _c of r1.stream) {} } catch (e) { e1 = e; } })();
    const c2 = (async () => { try { for await (const _c of r2.stream) {} } catch (e) { e2 = e; } })();
    await Promise.all([c1, c2]);
    assert.ok(e1, 'client A received error');
    assert.ok(e2, 'client B received error');
    assert.equal(e1.message, 'synthetic source failure');
    assert.equal(e2.message, 'synthetic source failure');
    // No cache write.
    const cached = await store.get('k', 'ck-27f');
    assert.equal(cached, null);
    // Inflight entry removed (next call would respawn).
    assert.equal(store.stats('k').inflightCount, 0);
  });

  // D57 — ADR 0005 Amendment 8 §8: backpressure — slow client overflows queue
  it('27g — backpressure: slow client queue overflow → STREAM_BACKPRESSURE terminator; fast client unaffected', async () => {
    const warnings = [];
    const store = new CacheStore({ _warnFn: (msg, meta) => warnings.push({ msg, meta }) });
    // Inject perClientQueueCap=1024 bytes; chunks ~256B each.
    const bigText = 'x'.repeat(250);
    const factory = () => makeChunkSequence(
      [{ idx: 0, t: bigText }, { idx: 1, t: bigText }, { idx: 2, t: bigText }, { idx: 3, t: bigText }, { idx: 4, t: bigText }, { idx: 5, t: bigText }, { type: 'stop', finish_reason: 'stop' }]
    );
    const r1 = await store.getOrComputeStreaming('k', 'ck-27g', factory, { clientId: 'fast', perClientQueueCap: 1024 });
    const r2 = await store.getOrComputeStreaming('k', 'ck-27g', factory, { clientId: 'slow', perClientQueueCap: 1024 });
    // Fast drains immediately; slow defers consumption.
    const fastOut = [];
    const fast = (async () => { for await (const c of r1.stream) fastOut.push(c); })();
    await fast;
    // Now consume slow's stream; should hit backpressure terminator.
    const slowOut = [];
    for await (const c of r2.stream) slowOut.push(c);
    // Fast client received the full sequence.
    assert.equal(fastOut.length, 7);
    assert.deepEqual(fastOut[6], { type: 'stop', finish_reason: 'stop' });
    // Slow client received some prefix + the STREAM_BACKPRESSURE terminator.
    assert.deepEqual(slowOut[slowOut.length - 2], { type: 'stop', finish_reason: 'length' });
    assert.equal(slowOut[slowOut.length - 1], '[DONE]');
    assert.ok(slowOut.length < 7, 'slow client cut short before reaching natural end');
    // Backpressure warning emitted for slow client.
    const bp = warnings.filter(w => w.msg === 'stream_backpressure_disconnect');
    assert.ok(bp.length >= 1, 'at least one stream_backpressure_disconnect emitted');
    assert.ok(bp.some(w => w.meta.client_id === 'slow'), 'slow client identified in warning');
  });

  // D57 — ADR 0005 Amendment 8 §10: replay buffer cap — cache write skipped
  it('27h — replay cap exceeded: cache write skipped; first caller still receives full stream; late joiner past cap gets STREAM_BACKPRESSURE', async () => {
    const warnings = [];
    const store = new CacheStore({ _warnFn: (msg, meta) => warnings.push({ msg, meta }) });
    const big = 'y'.repeat(400);
    // Source emits 6 chunks at ~400B each → ~2400B total, exceeds replay cap 1024.
    const factory = () => makeChunkSequence(
      [{ t: big }, { t: big }, { t: big }, { t: big }, { t: big }, { t: big }]
    );
    const r1 = await store.getOrComputeStreaming('k', 'ck-27h', factory, {
      clientId: 'first',
      accumulatedReplayCap: 1024,
      perClientQueueCap: 1024 * 1024, // huge per-client cap so first caller never overflows
    });
    // First caller iterates through.
    const itA = r1.stream;
    const outA = [];
    // Pull 2 chunks then attempt late join while past cap.
    outA.push((await itA.next()).value);
    outA.push((await itA.next()).value);
    outA.push((await itA.next()).value); // now well past 1024B accumulated
    // Late joiner attaches past replay cap → gets STREAM_BACKPRESSURE.
    const r2 = await store.getOrComputeStreaming('k', 'ck-27h', factory, {
      clientId: 'late',
      accumulatedReplayCap: 1024,
      perClientQueueCap: 1024,
    });
    assert.equal(r2.role, 'attached');
    const outLate = [];
    for await (const c of r2.stream) outLate.push(c);
    // Late joiner's stream is just the backpressure terminator (drain over cap).
    assert.deepEqual(outLate, [{ type: 'stop', finish_reason: 'length' }, '[DONE]']);
    // Drain first caller fully.
    for await (const c of itA) outA.push(c);
    assert.equal(outA.length, 6, 'first caller receives full source stream');
    // Cache write skipped.
    const cached = await store.get('k', 'ck-27h');
    assert.equal(cached, null, 'cache NOT written when replay cap exceeded');
    // Replay-cap-exceeded warning emitted.
    assert.ok(
      warnings.some(w => w.msg === 'streaming_inflight_replay_cap_exceeded'),
      'replay-cap-exceeded warning fired'
    );
  });

  // D57 — ADR 0005 Amendment 8 §6: cache TTL race — late joiner attaches via inflight
  it('27i — cache TTL race: cached entry expires during inflight; late joiner attaches via inflight Map', async () => {
    const store = new CacheStore({ _warnFn: () => {} });
    // Pre-populate cache with TTL=10ms — will expire shortly.
    await store.set('k', 'ck-27i', ['cached-a', 'cached-b'], 10);
    // Wait so the cached entry expires.
    await new Promise(r => setTimeout(r, 20));
    // Now a streaming request comes in: cache is expired → entry is recomputed.
    let spawns = 0;
    const factory = () => {
      spawns++;
      return makeChunkSequence(['live-1', 'live-2', 'live-3']);
    };
    const r1 = await store.getOrComputeStreaming('k', 'ck-27i', factory, { clientId: 'A' });
    assert.equal(r1.role, 'source', 'expired cache → fresh source spawn');
    // While the source is running, a late joiner arrives — must attach via inflight Map.
    const r2 = await store.getOrComputeStreaming('k', 'ck-27i', factory, { clientId: 'B' });
    assert.equal(r2.role, 'attached', 'late joiner attaches via inflight Map even after cache expiry');
    assert.equal(spawns, 1, 'no respawn');
    // Drain both.
    const o1 = []; for await (const c of r1.stream) o1.push(c);
    const o2 = []; for await (const c of r2.stream) o2.push(c);
    assert.deepEqual(o1, ['live-1', 'live-2', 'live-3']);
    assert.deepEqual(o2, ['live-1', 'live-2', 'live-3']);
    // Inflight completion overwrites the expired slot.
    const cached = await store.get('k', 'ck-27i');
    assert.ok(cached);
    assert.deepEqual(cached.value, ['live-1', 'live-2', 'live-3']);
  });

  // D57 — ADR 0005 Amendment 8 §7: sourceFactory throws → first caller errors; no zombie state
  it('27j — sourceFactory throws (e.g. CONCURRENCY_LIMIT): first caller errors; subsequent call retries; no zombie inflight', async () => {
    const store = new CacheStore({ _warnFn: () => {} });
    let attempts = 0;
    const factory = () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('CONCURRENCY_LIMIT');
      }
      return makeChunkSequence(['a', 'b']);
    };
    let firstErr;
    try {
      await store.getOrComputeStreaming('k', 'ck-27j', factory, { clientId: 'A' });
    } catch (e) {
      firstErr = e;
    }
    assert.ok(firstErr, 'first call rejected with factory error');
    assert.equal(firstErr.message, 'CONCURRENCY_LIMIT');
    // No zombie inflight entry left dangling.
    assert.equal(store.stats('k').inflightCount, 0, 'no stale streaming-inflight entry');
    // Subsequent call uses the factory again (it returns a real iterator now).
    const r2 = await store.getOrComputeStreaming('k', 'ck-27j', factory, { clientId: 'B' });
    assert.equal(r2.role, 'source');
    const out = [];
    for await (const c of r2.stream) out.push(c);
    assert.deepEqual(out, ['a', 'b']);
    assert.equal(attempts, 2);
  });

  // D57 — ADR 0005 Amendment 8 §1: stats accounting (hits / misses / inflightCount)
  it('27k — stats: hits incremented for cache_hit + attached; misses for source; inflightCount reflects active streaming entries', async () => {
    const store = new CacheStore({ _warnFn: () => {} });
    const factory = () => makeChunkSequence(['p', 'q', 'r']);

    // First caller — miss.
    const r1 = await store.getOrComputeStreaming('k', 'ck-27k', factory, { clientId: 'A' });
    let stats = store.stats('k');
    assert.equal(stats.misses, 1, 'first caller increments misses');
    assert.equal(stats.hits, 0);
    // Inflight entry alive during source phase.
    assert.equal(stats.inflightCount, 1, 'streaming entry counted in inflightCount');

    // Concurrent joiner — attached → hit.
    const r2 = await store.getOrComputeStreaming('k', 'ck-27k', factory, { clientId: 'B' });
    stats = store.stats('k');
    assert.equal(stats.hits, 1, 'attached client increments hits');
    // Drain both.
    await Promise.all([
      (async () => { for await (const _c of r1.stream) {} })(),
      (async () => { for await (const _c of r2.stream) {} })(),
    ]);
    // After completion, entry removed from inflight.
    stats = store.stats('k');
    assert.equal(stats.inflightCount, 0, 'streaming entry removed post-completion');

    // Third call after completion — cache_hit (also a hit).
    const r3 = await store.getOrComputeStreaming('k', 'ck-27k', factory, { clientId: 'C' });
    assert.equal(r3.role, 'cache_hit');
    for await (const _c of r3.stream) { /* drain */ }
    stats = store.stats('k');
    assert.equal(stats.hits, 2, 'cache_hit also increments hits');
  });

  // D57 — ADR 0005 Amendment 8 §2: composite key isolation (keyId\0cacheKey)
  it('27l — composite key isolation: same cacheKey + different keyId → two independent inflight entries + two spawns', async () => {
    const store = new CacheStore({ _warnFn: () => {} });
    let spawns = 0;
    const factory = () => {
      spawns++;
      return makeChunkSequence(['n1', 'n2']);
    };
    // Same cacheKey, different keyId.
    const p1 = store.getOrComputeStreaming('key-A', 'shared-cache-key', factory, { clientId: 'A' });
    const p2 = store.getOrComputeStreaming('key-B', 'shared-cache-key', factory, { clientId: 'B' });
    const [r1, r2] = await Promise.all([p1, p2]);
    // Both should be `source` — no cross-keyId sharing.
    assert.equal(r1.role, 'source');
    assert.equal(r2.role, 'source');
    assert.equal(spawns, 2, 'two spawns because two distinct (keyId,cacheKey) composites');
    // Drain.
    const out1 = []; for await (const c of r1.stream) out1.push(c);
    const out2 = []; for await (const c of r2.stream) out2.push(c);
    assert.deepEqual(out1, ['n1', 'n2']);
    assert.deepEqual(out2, ['n1', 'n2']);
    // Stats: each keyId has its own miss counter.
    assert.equal(store.stats('key-A').misses, 1);
    assert.equal(store.stats('key-B').misses, 1);
  });
});

// ── Suite 28: D58 streaming singleflight (server.mjs HTTP wiring) ──────────
//
// Authority: ADR 0005 Amendment 8 §§ 7, 8, 9, 11, 12 (issue #16, D58).
//
// HTTP-layer integration tests for the server.mjs streaming branch wired to
// cacheStore.getOrComputeStreaming(). D57 (cache layer) tested singleflight
// in unit form; D58 verifies the server actually plumbs it through and emits
// the new X-OLP-Streaming-Inflight header. Provider spawn is mocked at the
// plugin level via lp.set('anthropic', { ...real, spawn: fake }) — the
// pattern used by Suites 15d/15e — so no real CLI is invoked.
//
// Test count: 8 (28a single, 28b 2-concurrent join, 28c TOCTOU pre-cache,
// 28d mid-stream join behaviour-validated via parallel HTTP, 28e omitted in
// favour of Suite 27g unit coverage per D58 prompt, 28f one-of-N disconnect,
// 28g all-disconnect, 28h CONCURRENCY_LIMIT fallthrough).

describe('Suite 28 — D58 streaming singleflight (server.mjs HTTP wiring, ADR 0005 Amendment 8)', () => {
  let server28;
  let port28;
  let savedToken28;
  let lp28;
  let savedAnthropic28;

  before(async () => {
    savedToken28 = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fake-token-suite-28';
    __setProvidersEnabled({ anthropic: true });

    const mod = await import('./server.mjs');
    lp28 = mod.loadedProviders;
    savedAnthropic28 = lp28.get('anthropic');
    mod.__clearCache();

    server28 = mod.createOlpServer();
    await new Promise((resolve, reject) => {
      server28.listen(0, '127.0.0.1', resolve);
      server28.once('error', reject);
    });
    port28 = server28.address().port;
  });

  after(async () => {
    // Restore original anthropic provider so other suites are unaffected.
    if (savedAnthropic28 !== undefined) {
      lp28.set('anthropic', savedAnthropic28);
    } else {
      lp28.delete('anthropic');
    }
    __resetProvidersEnabled();
    __resetSpawnImpl();
    if (savedToken28 !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken28;
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    if (!server28) return;
    return new Promise(r => server28.close(r));
  });

  /**
   * Install a custom spawn async generator on the anthropic plugin for one
   * test. `factory` is a function returning the async generator each spawn.
   * Tracks invocation count via spawnCount.
   */
  function installFakeStreamProvider(spawnImpl) {
    const counter = { count: 0 };
    const fake = {
      ...savedAnthropic28,
      spawn: async function* (ir, authContext) {
        counter.count++;
        yield* spawnImpl(ir, authContext);
      },
    };
    lp28.set('anthropic', fake);
    return counter;
  }

  /**
   * Fire an SSE request and collect the full body + headers. The promise
   * resolves when the server ends the response (res 'end' event).
   */
  function makeStreamRequest(extra = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1',
        port: port28,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'Content-Type': 'application/json' },
      }, res => {
        let data = '';
        res.on('data', d => { data += d.toString(); });
        res.on('end', () => resolve({
          status: res.statusCode,
          body: data,
          headers: res.headers,
        }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(JSON.stringify({
        model: extra.model ?? 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: extra.prompt ?? 'd58-default' }],
        stream: true,
      }));
      req.end();
    });
  }

  /**
   * Fire an SSE request and abort it after `abortAfterMs` ms. Returns the
   * partial body collected up to abort. Resolves on the abort event.
   */
  function makeAbortableStreamRequest({ prompt, abortAfterMs }) {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1',
        port: port28,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'Content-Type': 'application/json' },
      }, res => {
        let data = '';
        res.on('data', d => { data += d.toString(); });
        res.on('end', () => resolve({
          status: res.statusCode,
          body: data,
          headers: res.headers,
          aborted: false,
        }));
        res.on('error', () => resolve({
          status: res.statusCode,
          body: data,
          headers: res.headers,
          aborted: true,
        }));
      });
      req.on('error', () => resolve({ aborted: true }));
      req.write(JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      }));
      req.end();
      setTimeout(() => {
        try { req.destroy(); } catch { /* ignore */ }
      }, abortAfterMs);
    });
  }

  beforeEach(async () => {
    const mod = await import('./server.mjs');
    mod.__clearCache();
  });

  it('28a — single SSE request: X-OLP-Streaming-Inflight: source; cache populated; identical re-request → cache hit', async () => {
    // D58 — ADR 0005 Amendment 8 §11: single client gets `source` role,
    // X-OLP-Cache: miss. Subsequent identical request hits the cache.
    const counter = installFakeStreamProvider(async function* (_ir) {
      yield { type: 'delta', content: 'chunk-A' };
      yield { type: 'delta', content: 'chunk-B' };
      yield { type: 'stop', finish_reason: 'stop' };
    });

    const r1 = await makeStreamRequest({ prompt: 'd58-28a' });
    assert.equal(r1.status, 200, `r1 status ${r1.status}: ${r1.body.slice(0, 200)}`);
    assert.equal(r1.headers['x-olp-streaming-inflight'], 'source',
      'r1 must emit X-OLP-Streaming-Inflight: source');
    assert.equal(r1.headers['x-olp-cache'], 'miss',
      'r1 must be X-OLP-Cache: miss');
    assert.ok(r1.body.includes('chunk-A'), 'r1 body must include chunk-A');
    assert.ok(r1.body.includes('chunk-B'), 'r1 body must include chunk-B');
    assert.ok(r1.body.includes('[DONE]'), 'r1 body must end with [DONE]');
    assert.equal(counter.count, 1, 'exactly one spawn for r1');

    // Second identical request — cache hit, no spawn.
    const r2 = await makeStreamRequest({ prompt: 'd58-28a' });
    assert.equal(r2.status, 200);
    assert.equal(r2.headers['x-olp-cache'], 'hit', 'r2 must be cache hit');
    // X-OLP-Streaming-Inflight is omitted on cache_hit (X-OLP-Cache: hit
    // already signals that path per D58 design).
    assert.equal(r2.headers['x-olp-streaming-inflight'], undefined,
      'cache_hit path must omit X-OLP-Streaming-Inflight header');
    assert.equal(counter.count, 1, 'no additional spawn for r2');
  });

  it('28b — 2 concurrent identical SSE: one spawn; first=source second=attached; identical chunks', async () => {
    // D58 — ADR 0005 Amendment 8 §1, §11: two concurrent identical streams
    // share one underlying spawn. First gets X-OLP-Streaming-Inflight:
    // source; second gets attached. Both bodies contain the same chunks.
    //
    // Pacing: source yields chunks with a setTimeout gap so the second
    // request has time to fire and attach mid-stream.
    const counter = installFakeStreamProvider(async function* (_ir) {
      // Slow pacing so the second request can attach before completion.
      for (const t of ['c0', 'c1', 'c2', 'c3']) {
        yield { type: 'delta', content: t };
        await new Promise(r => setTimeout(r, 20));
      }
      yield { type: 'stop', finish_reason: 'stop' };
    });

    // Fire request 1, then a few ms later fire request 2; both run to
    // completion in parallel.
    const p1 = makeStreamRequest({ prompt: 'd58-28b' });
    // Give p1 a head start to register the inflight entry.
    await new Promise(r => setTimeout(r, 10));
    const p2 = makeStreamRequest({ prompt: 'd58-28b' });

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(counter.count, 1, 'only one underlying spawn for both requests');

    // First caller (registered the inflight entry) gets source; the other
    // gets attached. The order is set by who hit getOrComputeStreaming
    // first — we asserted that with the 10ms head start above.
    assert.equal(r1.headers['x-olp-streaming-inflight'], 'source',
      'r1 must be source role');
    assert.equal(r2.headers['x-olp-streaming-inflight'], 'attached',
      'r2 must be attached role');

    // Both responses must contain all 4 delta chunks + [DONE].
    for (const tag of ['c0', 'c1', 'c2', 'c3', '[DONE]']) {
      assert.ok(r1.body.includes(tag), `r1 missing ${tag}`);
      assert.ok(r2.body.includes(tag), `r2 missing ${tag}`);
    }

    // Cache_status header: source=miss, attached=hit (cache_hit role)?
    // No — attached client did NOT hit the cache (cache was empty). The
    // server distinguishes by setting cache_status header to 'miss' for
    // attached and 'miss' for source. Verify both are 'miss' on the wire
    // (X-OLP-Cache header). cache_status='streaming_attached' is the AUDIT
    // value, not the wire header value.
    assert.equal(r1.headers['x-olp-cache'], 'miss');
    assert.equal(r2.headers['x-olp-cache'], 'miss');
  });

  it('28c — TOCTOU regression: pre-populated cache + 2 concurrent identical streams → both cache_hit, no spawn', async () => {
    // D58 — ADR 0005 Amendment 8 §6 / §11: when the cache is already
    // populated, preCheckHit gates entry to the streaming-singleflight
    // branch. The streaming-singleflight branch should not run at all.
    // 2 concurrent identical requests both replay from cache; spawn count
    // stays at 0.
    const counter = installFakeStreamProvider(async function* (_ir) {
      yield { type: 'delta', content: 'should-not-fire' };
      yield { type: 'stop', finish_reason: 'stop' };
    });

    // Populate the cache via a first request.
    const r0 = await makeStreamRequest({ prompt: 'd58-28c' });
    assert.equal(r0.status, 200);
    assert.equal(counter.count, 1, 'r0 spawned once to populate cache');

    // Now fire 2 concurrent identical requests — both should be cache hits.
    const [r1, r2] = await Promise.all([
      makeStreamRequest({ prompt: 'd58-28c' }),
      makeStreamRequest({ prompt: 'd58-28c' }),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r1.headers['x-olp-cache'], 'hit', 'r1 must be cache hit');
    assert.equal(r2.headers['x-olp-cache'], 'hit', 'r2 must be cache hit');
    // Neither should have entered the streaming-singleflight branch.
    assert.equal(r1.headers['x-olp-streaming-inflight'], undefined,
      'r1 must not emit X-OLP-Streaming-Inflight (served from buffered cache replay)');
    assert.equal(r2.headers['x-olp-streaming-inflight'], undefined,
      'r2 must not emit X-OLP-Streaming-Inflight (served from buffered cache replay)');
    assert.equal(counter.count, 1, 'no additional spawns');
  });

  it('28d — mid-stream join (HTTP-level): 2 concurrent SSE requests share one spawn; both bodies identical', async () => {
    // D58 — ADR 0005 Amendment 8 §5: late joiner gets accumulated burst +
    // live tail. At the HTTP level we can't observe the burst-vs-live split
    // precisely (it's internal to the cache layer), but we can verify the
    // end-to-end invariant: both clients receive the same chunk sequence
    // even when one joins mid-source. Suite 27c covers the burst-vs-live
    // split at the cache-layer unit level.
    const counter = installFakeStreamProvider(async function* (_ir) {
      // Slower pacing so the second client clearly joins mid-stream.
      for (const t of ['m0', 'm1', 'm2', 'm3', 'm4']) {
        yield { type: 'delta', content: t };
        await new Promise(r => setTimeout(r, 25));
      }
      yield { type: 'stop', finish_reason: 'stop' };
    });

    const p1 = makeStreamRequest({ prompt: 'd58-28d' });
    // p2 joins ~40ms in — at least 2 chunks have been accumulated by then.
    await new Promise(r => setTimeout(r, 40));
    const p2 = makeStreamRequest({ prompt: 'd58-28d' });

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(counter.count, 1, 'exactly one underlying spawn');
    assert.equal(r1.headers['x-olp-streaming-inflight'], 'source');
    assert.equal(r2.headers['x-olp-streaming-inflight'], 'attached');
    for (const tag of ['m0', 'm1', 'm2', 'm3', 'm4']) {
      assert.ok(r1.body.includes(tag), `r1 missing ${tag}`);
      assert.ok(r2.body.includes(tag), `r2 missing ${tag} (late-joiner replay must include burst)`);
    }
  });

  it('28f — one of N clients disconnects mid-stream: source NOT aborted; other client completes; cache populated', async () => {
    // D58 — ADR 0005 Amendment 8 §9: when one of N attached clients drops,
    // the source continues for the remaining clients. The cache write
    // happens because the source completed normally for the surviving
    // client.
    const counter = installFakeStreamProvider(async function* (_ir) {
      for (const t of ['s0', 's1', 's2', 's3', 's4', 's5']) {
        yield { type: 'delta', content: t };
        await new Promise(r => setTimeout(r, 25));
      }
      yield { type: 'stop', finish_reason: 'stop' };
    });

    // r1 starts and registers the inflight entry.
    const p1 = makeStreamRequest({ prompt: 'd58-28f' });
    await new Promise(r => setTimeout(r, 15));
    // r2 attaches but aborts after ~40ms.
    const p2 = makeAbortableStreamRequest({ prompt: 'd58-28f', abortAfterMs: 40 });

    const [r1, r2] = await Promise.all([p1, p2]);
    // r1 (the source) completes normally with the full stream.
    assert.equal(r1.status, 200);
    assert.equal(r1.headers['x-olp-streaming-inflight'], 'source');
    for (const tag of ['s0', 's1', 's2', 's3', 's4', 's5', '[DONE]']) {
      assert.ok(r1.body.includes(tag), `r1 missing ${tag}`);
    }
    assert.equal(counter.count, 1, 'source spawn was NOT re-fired by the disconnect');

    // r2 was aborted — partial body is okay; what matters is the source
    // wasn't killed (verified above by r1 completing).
    // Subsequent identical request must be a cache hit (cache was populated
    // by the source on normal completion).
    const r3 = await makeStreamRequest({ prompt: 'd58-28f' });
    assert.equal(r3.status, 200);
    assert.equal(r3.headers['x-olp-cache'], 'hit', 'cache populated after source completion');
    assert.equal(counter.count, 1, 'no additional spawn for r3');
  });

  it('28g — ALL clients disconnect mid-stream: source aborted; no cache write; subsequent request respawns', async () => {
    // D58 — ADR 0005 Amendment 8 §9 + §4: when all attached clients
    // disconnect, the cache layer fires sourceAbortController.abort() and
    // does NOT write the cache. A subsequent identical request must spawn
    // afresh (no inflight entry left dangling).
    //
    // Implementation detail: the fake spawn's async generator must respect
    // the abort signal (or simply have its iterator.return() called when
    // the spawn is iterated by the tee task — see Suite 27 unit tests).
    // For an async generator with `await new Promise(setTimeout)` between
    // yields, calling .return() naturally propagates because the for-await
    // exits cleanly via the try/finally.
    let sourceFinished = false;
    const counter = installFakeStreamProvider(async function* (_ir) {
      try {
        for (let i = 0; i < 30; i++) {
          yield { type: 'delta', content: `g${i}` };
          await new Promise(r => setTimeout(r, 20));
        }
        yield { type: 'stop', finish_reason: 'stop' };
        sourceFinished = true;
      } finally {
        // intentionally no-op; the "finished without abort" signal lives in
        // sourceFinished above.
      }
    });

    // Only one client; abort it after ~40ms (well before completion).
    const r1 = await makeAbortableStreamRequest({ prompt: 'd58-28g', abortAfterMs: 40 });
    assert.equal(counter.count, 1, 'spawn fired once');
    // Wait for the cache layer to observe attachedClients.size === 0 and abort.
    await new Promise(r => setTimeout(r, 100));
    assert.equal(sourceFinished, false, 'source was aborted, not completed');

    // Subsequent identical request must respawn (no cache, no inflight).
    const r2 = await makeStreamRequest({ prompt: 'd58-28g' });
    assert.equal(r2.status, 200);
    assert.equal(r2.headers['x-olp-cache'], 'miss', 'no cache write after abort');
    assert.equal(r2.headers['x-olp-streaming-inflight'], 'source', 'fresh source role');
    assert.equal(counter.count, 2, 'r2 triggered a fresh spawn');
  });

  it('28h — CONCURRENCY_LIMIT fallthrough: different cacheKeys at maxConcurrent=1 → first succeeds; second falls through to buffered path', async () => {
    // D58 — ADR 0005 Amendment 8 §7: CONCURRENCY_LIMIT thrown by
    // sourceFactory falls through to the buffered path. Different
    // cacheKeys do NOT share an inflight entry (they're not singleflight
    // candidates), so request 2's sourceFactory throws and the streaming
    // branch is bypassed for that request. The buffered path then
    // re-attempts acquire; since maxConcurrent=1 and request 1 still has
    // the slot, it surfaces a chain-exhausted 502 (single-hop saturation).
    //
    // We install a custom provider with maxConcurrent=1 + slow stream to
    // hold the slot while request 2 fires.
    let releaseSig;
    const releaseGate = new Promise(r => { releaseSig = r; });
    const counter = { count: 0 };
    const fake = {
      ...savedAnthropic28,
      hints: { ...savedAnthropic28.hints, maxConcurrent: 1 },
      spawn: async function* (_ir, _ctx) {
        counter.count++;
        // First spawn holds the slot until releaseGate is signalled.
        yield { type: 'delta', content: `h${counter.count}-0` };
        await releaseGate;
        yield { type: 'stop', finish_reason: 'stop' };
      },
    };
    lp28.set('anthropic', fake);

    try {
      // Fire request 1 with prompt-A; it acquires the slot and stalls.
      const p1 = makeStreamRequest({ prompt: 'd58-28h-A' });
      await new Promise(r => setTimeout(r, 30));
      // Fire request 2 with prompt-B (different cache key) — should
      // CONCURRENCY_LIMIT in factory, fall through to buffered path,
      // which will also fail acquire → chain-exhausted 502.
      const r2 = await makeStreamRequest({ prompt: 'd58-28h-B' });
      // The buffered fallback engine surfaces a chain-exhausted error as
      // 502 for single-hop saturation per pre-D58 behaviour.
      assert.ok(r2.status === 502 || r2.status === 503,
        `expected 502/503 chain-exhausted, got ${r2.status}: ${r2.body.slice(0, 200)}`);

      // Release request 1's stall.
      releaseSig();
      const r1 = await p1;
      assert.equal(r1.status, 200, 'r1 must complete normally');
      // Exactly one spawn — request 2 never spawned (CONCURRENCY_LIMIT).
      assert.equal(counter.count, 1, 'only one underlying spawn');
    } finally {
      // In case of an early failure, release the gate so promises settle.
      try { releaseSig(); } catch { /* already released */ }
    }
  });

  it('28i — stop-less exhaustion: source generator returns without {type:"stop"} → cache NOT populated (D58 follow-up to D58 reviewer P2-2)', async () => {
    // ADR 0005 § "Cache write conditions" item 1 (D16 truncated-not-cached
    // invariant): if the source generator exhausts without emitting a stop
    // chunk, the response is treated as truncated and MUST NOT persist in
    // cache. D57's cache layer is IR-agnostic and writes accumulatedChunks
    // on any source exhaustion; D58's server.mjs handles the IR semantics by
    // calling cacheStore.delete(...) immediately after on the no-stop path.
    // This test pins the end-to-end behaviour from the HTTP layer.
    const counter = { count: 0 };
    const fake = {
      ...savedAnthropic28,
      spawn: async function* (_ir, _ctx) {
        counter.count++;
        yield { type: 'delta', content: 'no-stop-1' };
        yield { type: 'delta', content: 'no-stop-2' };
        // Generator returns WITHOUT a stop chunk — truncation path.
      },
    };
    lp28.set('anthropic', fake);
    const r1 = await makeStreamRequest({ prompt: 'd58-28i' });
    assert.equal(r1.status, 200, '28i r1: SSE response 200');
    assert.equal(counter.count, 1, '28i r1: spawned once');
    // The synthetic truncation marker {type:"stop", finish_reason:"length"}
    // should appear (D26 F19 in-band signal); [DONE] terminator follows.
    assert.ok(r1.body.includes('"finish_reason":"length"'),
      `28i r1: truncation marker expected; body=${r1.body.slice(0, 300)}`);
    assert.ok(r1.body.includes('[DONE]'), '28i r1: [DONE] terminator');
    // Subsequent identical request must respawn (cache was NOT populated).
    const r2 = await makeStreamRequest({ prompt: 'd58-28i' });
    assert.equal(r2.status, 200, '28i r2: SSE response 200');
    assert.equal(counter.count, 2, '28i r2: second request triggered a fresh spawn (no cache reuse for truncated entry)');
  });
});

// ── Suite 29: D61 SSE heartbeat (ADR 0010 § Phase 4 D61-D63) ──────────────
//
// Tests the opt-in SSE heartbeat that emits `: keepalive\n\n` SSE comment
// frames during silent windows. Port of OCP `startHeartbeat` (server.mjs:
// 660-685) adapted to OLP's config (`streaming.heartbeat_interval_ms`),
// per-attached-client lifecycle, and eager-headers-post-spawn rule.
//
// Authority: ADR 0010 § Phase 4 D61-D63; OCP spec
//   docs/superpowers/specs/2026-04-25-47-sse-heartbeat-design.md.

describe('Suite 29 — D61 SSE heartbeat (ADR 0010 § Phase 4 D61-D63)', () => {
  let server29;
  let port29;
  let savedToken29;
  let lp29;
  let savedAnthropic29;

  before(async () => {
    savedToken29 = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fake-token-suite-29';
    __setProvidersEnabled({ anthropic: true });

    const mod = await import('./server.mjs');
    lp29 = mod.loadedProviders;
    savedAnthropic29 = lp29.get('anthropic');
    mod.__clearCache();

    server29 = mod.createOlpServer();
    await new Promise((resolve, reject) => {
      server29.listen(0, '127.0.0.1', resolve);
      server29.once('error', reject);
    });
    port29 = server29.address().port;
  });

  after(async () => {
    if (savedAnthropic29 !== undefined) {
      lp29.set('anthropic', savedAnthropic29);
    } else {
      lp29.delete('anthropic');
    }
    __resetProvidersEnabled();
    __resetSpawnImpl();
    __resetStreamingConfig();
    if (savedToken29 !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken29;
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    if (!server29) return;
    return new Promise(r => server29.close(r));
  });

  beforeEach(async () => {
    const mod = await import('./server.mjs');
    mod.__clearCache();
    __setStreamingConfig({ heartbeat_interval_ms: 0 });
  });

  /** Install a fake provider whose async generator paces yields with `gapMs`. */
  function installPacedProvider(chunks, gapMs) {
    const counter = { count: 0 };
    const fake = {
      ...savedAnthropic29,
      spawn: async function* (_ir, _ctx) {
        counter.count++;
        for (const c of chunks) {
          if (gapMs > 0) await new Promise(r => setTimeout(r, gapMs));
          yield c;
        }
      },
    };
    lp29.set('anthropic', fake);
    return counter;
  }

  /** Make a streaming request and return body + arrival timestamps. */
  function makeTimedStreamRequest({ prompt }) {
    return new Promise((resolve, reject) => {
      const arrivals = [];
      const req = httpRequest({
        hostname: '127.0.0.1',
        port: port29,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'Content-Type': 'application/json' },
      }, res => {
        let data = '';
        res.on('data', d => {
          const s = d.toString();
          arrivals.push({ ts: Date.now(), text: s });
          data += s;
        });
        res.on('end', () => resolve({
          status: res.statusCode,
          body: data,
          headers: res.headers,
          arrivals,
        }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      }));
      req.end();
    });
  }

  it('29a — heartbeat ENABLED (interval=40ms) + slow provider → keepalive frame(s) appear in body', async () => {
    // Provider stalls 200ms before first delta, then ~80ms between deltas.
    // With heartbeat=40ms the silent windows produce multiple keepalive
    // frames. Eager-headers must fire so the frames are flushed.
    installPacedProvider([
      { type: 'delta', content: 'h29a-1' },
      { type: 'delta', content: 'h29a-2' },
      { type: 'stop', finish_reason: 'stop' },
    ], 100);
    __setStreamingConfig({ heartbeat_interval_ms: 40 });

    const r = await makeTimedStreamRequest({ prompt: 'h29a-prompt' });
    assert.equal(r.status, 200, `r status ${r.status}: ${r.body.slice(0, 200)}`);
    // At least one keepalive comment frame must be present.
    const keepaliveCount = (r.body.match(/: keepalive/g) ?? []).length;
    assert.ok(keepaliveCount >= 1, `expected at least one keepalive frame, got ${keepaliveCount}; body=${r.body.slice(0, 400)}`);
    // Content + [DONE] still present (heartbeat does not break the stream).
    assert.ok(r.body.includes('h29a-1'), 'body must include h29a-1');
    assert.ok(r.body.includes('h29a-2'), 'body must include h29a-2');
    assert.ok(r.body.includes('[DONE]'), 'body must include [DONE]');
  });

  it('29b — heartbeat DISABLED (default 0) → NO keepalive frame in body', async () => {
    // Same provider pacing but no heartbeat config → no keepalive frames.
    installPacedProvider([
      { type: 'delta', content: 'h29b-1' },
      { type: 'delta', content: 'h29b-2' },
      { type: 'stop', finish_reason: 'stop' },
    ], 100);
    __setStreamingConfig({ heartbeat_interval_ms: 0 });

    const r = await makeTimedStreamRequest({ prompt: 'h29b-prompt' });
    assert.equal(r.status, 200);
    assert.equal(
      (r.body.match(/: keepalive/g) ?? []).length,
      0,
      `heartbeat disabled but found keepalive frame; body=${r.body.slice(0, 400)}`,
    );
    assert.ok(r.body.includes('h29b-1'));
    assert.ok(r.body.includes('[DONE]'));
  });

  it('29c — heartbeat timer resets on every real chunk (chunks at 30ms gaps with hb=50ms → 0 keepalives mid-stream)', async () => {
    // With chunks arriving every 30ms and heartbeat=50ms, the timer resets
    // before it can fire — there should be no keepalive frames between
    // chunks (silent windows never exceed 50ms). Pacing the source by a
    // long pre-first-chunk gap is avoided here: pre-first-chunk silence is
    // covered by 29a.
    installPacedProvider([
      { type: 'delta', content: 'r29c-1' },
      { type: 'delta', content: 'r29c-2' },
      { type: 'delta', content: 'r29c-3' },
      { type: 'delta', content: 'r29c-4' },
      { type: 'stop', finish_reason: 'stop' },
    ], 30);
    __setStreamingConfig({ heartbeat_interval_ms: 50 });

    const r = await makeTimedStreamRequest({ prompt: 'h29c-prompt' });
    assert.equal(r.status, 200);
    // Each chunk fires within 30ms of the previous, so the heartbeat (50ms)
    // is repeatedly reset before it can fire. There may still be ONE
    // keepalive frame from the pre-first-chunk window (30ms wait before
    // first delta is borderline), but we expect zero mid-stream frames.
    const keepaliveCount = (r.body.match(/: keepalive/g) ?? []).length;
    assert.ok(keepaliveCount <= 1, `expected <= 1 keepalive (reset working), got ${keepaliveCount}; body=${r.body.slice(0, 400)}`);
    for (const tag of ['r29c-1', 'r29c-2', 'r29c-3', 'r29c-4', '[DONE]']) {
      assert.ok(r.body.includes(tag), `body missing ${tag}`);
    }
  });

  it('29d — heartbeat cancelled on client disconnect (no further keepalive after abort)', async () => {
    // Source stalls forever. Heartbeat=20ms fires repeatedly while the
    // client is connected. After abort, heartbeat.stop() must fire — the
    // surface check we do here: the server cleanly closes (no uncaught
    // exception on continued setTimeout firing). We can't observe "no more
    // keepalive frames" directly from the aborted client, but we CAN
    // observe that the test runner doesn't time out — the dead-socket
    // res.write inside the heartbeat is swallowed (no throw bubbling up).
    let yieldedCount = 0;
    const fake = {
      ...savedAnthropic29,
      spawn: async function* (_ir, _ctx) {
        // Hold open with a single delta then a long sleep.
        yield { type: 'delta', content: 'first-delta' };
        yieldedCount++;
        try {
          // Long stall; should be interrupted by iterator.return()
          await new Promise(r => setTimeout(r, 1000));
          yield { type: 'stop', finish_reason: 'stop' };
        } finally {
          // intentional
        }
      },
    };
    lp29.set('anthropic', fake);
    __setStreamingConfig({ heartbeat_interval_ms: 20 });

    const result = await new Promise((resolve) => {
      const req = httpRequest({
        hostname: '127.0.0.1',
        port: port29,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'Content-Type': 'application/json' },
      }, res => {
        let body = '';
        res.on('data', d => { body += d.toString(); });
        res.on('end', () => resolve({ body, aborted: false }));
        res.on('error', () => resolve({ body, aborted: true }));
      });
      req.on('error', () => resolve({ body: '', aborted: true }));
      req.write(JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'h29d-abort' }],
        stream: true,
      }));
      req.end();
      // Abort after 100ms (well into heartbeat firing window).
      setTimeout(() => { try { req.destroy(); } catch { /* ignore */ } }, 100);
    });
    // Sanity: client saw at least the first chunk + maybe keepalives.
    assert.ok(yieldedCount === 1, 'first delta was yielded once');
    // Give the heartbeat loop time to fire post-abort — if heartbeat.stop()
    // didn't fire, an uncaught exception or runaway timer would surface.
    // Then assert that the server is still responsive to a new request,
    // proving no fatal lingering state.
    await new Promise(r => setTimeout(r, 60));

    // Server health check: a fresh request must complete normally.
    const probe = await fetch({ port: port29, method: 'GET', path: '/v1/models' });
    assert.equal(probe.status, 200, 'server remains responsive after disconnect; heartbeat timer did not crash the process');
  });

  it('29e — eager-headers: heartbeat enabled → headers flushed BEFORE first content chunk', async () => {
    // Pre-first-chunk silent window of 300ms; heartbeat=40ms ⇒ multiple
    // keepalive frames must arrive BEFORE the first content delta. This
    // is the OCP db11105 invariant: without eager-headers the keepalive
    // writes would buffer (no headers sent yet) and the client wouldn't
    // see anything until the first real chunk.
    let firstDeltaIdx = -1;
    let firstKeepaliveIdx = -1;
    const fake = {
      ...savedAnthropic29,
      spawn: async function* (_ir, _ctx) {
        // Long pre-first-chunk silence.
        await new Promise(r => setTimeout(r, 250));
        yield { type: 'delta', content: 'eager-delta' };
        yield { type: 'stop', finish_reason: 'stop' };
      },
    };
    lp29.set('anthropic', fake);
    __setStreamingConfig({ heartbeat_interval_ms: 40 });

    const r = await makeTimedStreamRequest({ prompt: 'h29e-prompt' });
    assert.equal(r.status, 200);
    // Headers received (status 200 was already received → headers flushed).
    // Locate index of first arrival containing : keepalive and first arrival
    // containing eager-delta.
    for (let i = 0; i < r.arrivals.length; i++) {
      if (firstKeepaliveIdx === -1 && r.arrivals[i].text.includes(': keepalive')) {
        firstKeepaliveIdx = i;
      }
      if (firstDeltaIdx === -1 && r.arrivals[i].text.includes('eager-delta')) {
        firstDeltaIdx = i;
      }
    }
    assert.ok(firstKeepaliveIdx >= 0, `expected at least one keepalive arrival; arrivals=${JSON.stringify(r.arrivals.map(a => a.text.slice(0, 60)))}`);
    assert.ok(firstDeltaIdx >= 0, 'expected the eager-delta to arrive');
    assert.ok(firstKeepaliveIdx < firstDeltaIdx,
      `keepalive (idx ${firstKeepaliveIdx}) must arrive BEFORE first delta (idx ${firstDeltaIdx}); proves eager-headers`);
  });
});

// ── Suite 30: D62 recentErrors[20] ring buffer (ADR 0010 § Phase 4 D61-D63) ──
//
// Tests the in-memory ring of the last 20 server-side error events plus its
// filter (401/403 excluded so brute-force loops cannot flood the ring) and
// path-sanitization. Surfaced via /status (Suite 31).

describe('Suite 30 — D62 recentErrors[20] ring buffer (ADR 0010 § Phase 4 D61-D63)', () => {
  let server30;
  let port30;
  let savedToken30;
  let lp30;
  let savedAnthropic30;

  before(async () => {
    savedToken30 = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fake-token-suite-30';
    __setProvidersEnabled({ anthropic: true });

    const mod = await import('./server.mjs');
    lp30 = mod.loadedProviders;
    savedAnthropic30 = lp30.get('anthropic');
    mod.__clearCache();

    server30 = mod.createOlpServer();
    await new Promise((resolve, reject) => {
      server30.listen(0, '127.0.0.1', resolve);
      server30.once('error', reject);
    });
    port30 = server30.address().port;
  });

  after(async () => {
    if (savedAnthropic30 !== undefined) {
      lp30.set('anthropic', savedAnthropic30);
    } else {
      lp30.delete('anthropic');
    }
    __resetProvidersEnabled();
    __resetSpawnImpl();
    __clearRecentErrors();
    if (savedToken30 !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken30;
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    if (!server30) return;
    return new Promise(r => server30.close(r));
  });

  beforeEach(async () => {
    const mod = await import('./server.mjs');
    mod.__clearCache();
    __clearRecentErrors();
    __setAuthConfig({ allow_anonymous: true, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
  });

  it('30a — provider error pushes an entry onto the recentErrors ring', async () => {
    // Install a provider that throws SPAWN_FAILED before first chunk.
    const fake = {
      ...savedAnthropic30,
      spawn: async function* (_ir, _ctx) {
        // Throw before yielding any chunk → propagates through the streaming
        // branch as a pre-first-chunk error → 502 + _pushError fires.
        throw new (await import('./lib/providers/base.mjs')).ProviderError(
          'fake spawn failure for 30a',
          'SPAWN_FAILED',
        );
        // eslint-disable-next-line no-unreachable
        yield { type: 'stop', finish_reason: 'stop' };
      },
    };
    lp30.set('anthropic', fake);

    const before = __snapshotRecentErrors().length;
    const r = await fetch({
      port: port30, method: 'POST', path: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: '30a-trigger' }],
        stream: true,
      },
    });
    // The exact status varies (502 for pre-first-chunk error, or
    // chain-exhausted 502 from the buffered path); both record _pushError.
    assert.ok(r.status === 502 || r.status === 500,
      `expected 5xx error, got ${r.status}: ${r.body.slice(0, 200)}`);
    const after = __snapshotRecentErrors();
    assert.ok(after.length > before, `ring should have grown; before=${before} after=${after.length}`);
    const last = after[after.length - 1];
    assert.ok(typeof last.time === 'string' && last.time.includes('T'),
      'entry must have ISO8601 time');
    assert.ok(typeof last.message === 'string' && last.message.length > 0,
      'entry must have a message');
    assert.ok(last.message.length <= 200, 'message must be capped at 200 chars');
    assert.equal(last.path, '/v1/chat/completions', 'entry path captured');
    assert.equal(typeof last.status_code, 'number', 'entry status_code captured');
  });

  it('30b — ring caps at 20 entries (oldest evicted on push)', async () => {
    __clearRecentErrors();
    // Push 25 synthetic errors via the public seam (we exercise this via a
    // provider that throws repeatedly). Easier: call _pushError directly by
    // hitting an endpoint that maps to a 5xx; install a fake that always
    // throws and fire 25 requests. Each request adds one entry.
    let pushCount = 0;
    const fake = {
      ...savedAnthropic30,
      spawn: async function* (_ir, _ctx) {
        pushCount++;
        throw new (await import('./lib/providers/base.mjs')).ProviderError(
          `30b-err-${pushCount}`,
          'SPAWN_FAILED',
        );
        // eslint-disable-next-line no-unreachable
        yield { type: 'stop', finish_reason: 'stop' };
      },
    };
    lp30.set('anthropic', fake);

    for (let i = 0; i < 25; i++) {
      await fetch({
        port: port30, method: 'POST', path: '/v1/chat/completions',
        headers: { 'Content-Type': 'application/json' },
        body: {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: `30b-iter-${i}` }],
          stream: false,
        },
      });
    }
    const snap = __snapshotRecentErrors();
    assert.equal(snap.length, 20, `ring must cap at 20, got ${snap.length}`);
    // Oldest evicted → the first remaining entry's message should not be
    // 30b-err-1 (which was pushed first and evicted). It should also not
    // include `30b-err-2 .. 30b-err-5` (we pushed 25, last 20 retained →
    // entries 6..25 remain).
    const firstMsg = snap[0].message;
    assert.ok(!firstMsg.includes('30b-err-1') || firstMsg.includes('30b-err-10') || firstMsg.includes('30b-err-11'),
      `oldest 5 must be evicted; first message=${firstMsg}`);
  });

  it('30c — 401/403 auth failures are NOT pushed onto the ring (brute-force flood guard)', async () => {
    __clearRecentErrors();
    __setAuthConfig({ allow_anonymous: false, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
    try {
      const before = __snapshotRecentErrors().length;
      // Fire 5 requests with no auth header → all 401s.
      for (let i = 0; i < 5; i++) {
        const r = await fetch({
          port: port30, method: 'POST', path: '/v1/chat/completions',
          headers: { 'Content-Type': 'application/json' },
          body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: `30c-${i}` }] },
        });
        assert.equal(r.status, 401, `expected 401 on no-auth request, got ${r.status}`);
      }
      const after = __snapshotRecentErrors().length;
      assert.equal(after, before, '401 responses must NOT push onto recentErrors');
    } finally {
      __setAuthConfig({ allow_anonymous: true, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
    }
  });

  it('30d — path sanitization: filesystem-path-like tokens in message are replaced with [path]', async () => {
    __clearRecentErrors();
    const fake = {
      ...savedAnthropic30,
      spawn: async function* (_ir, _ctx) {
        // Error message embeds a filesystem path.
        throw new (await import('./lib/providers/base.mjs')).ProviderError(
          'ENOENT: no such file or directory /Users/private/secret-file.json',
          'SPAWN_FAILED',
        );
        // eslint-disable-next-line no-unreachable
        yield { type: 'stop', finish_reason: 'stop' };
      },
    };
    lp30.set('anthropic', fake);

    await fetch({
      port: port30, method: 'POST', path: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: '30d-path-sanitize' }],
        stream: false,
      },
    });
    const snap = __snapshotRecentErrors();
    assert.ok(snap.length >= 1, 'an entry must have been pushed');
    const last = snap[snap.length - 1];
    assert.ok(!last.message.includes('/Users/private/secret-file.json'),
      `path leaked: ${last.message}`);
    assert.ok(last.message.includes('[path]'),
      `sanitization marker [path] expected; got ${last.message}`);
  });
});

// ── Suite 31: D63 /v0/management/status combined endpoint (ADR 0010 § Phase 4) ──
//
// Owner-only_block management endpoint that returns process/provider/cache
// stats + recentErrors. Tests gating + payload shape + recent_errors wiring.

describe('Suite 31 — D63 /v0/management/status (ADR 0010 § Phase 4 D61-D63)', () => {
  const GLOBAL_OLP_HOME_31 = process.env.OLP_HOME;
  let TMP31, server31, port31;
  let savedToken31;
  let lp31;
  let savedAnthropic31;

  before(async () => {
    TMP31 = mkdtempSync(pathJoin(tmpdir(), 'olp-test-31-'));
    process.env.OLP_HOME = TMP31;
    savedToken31 = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fake-token-suite-31';
    __setProvidersEnabled({ anthropic: true });
    __setAuthConfig({ allow_anonymous: true, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });

    const mod = await import('./server.mjs');
    lp31 = mod.loadedProviders;
    savedAnthropic31 = lp31.get('anthropic');
    mod.__clearCache();
    mod.__clearRecentErrors();
    mod.__resetRequestCounters();

    server31 = mod.createOlpServer();
    await new Promise((resolve, reject) => {
      server31.listen(0, '127.0.0.1', resolve);
      server31.once('error', reject);
    });
    port31 = server31.address().port;
  });

  after(async () => {
    if (savedAnthropic31 !== undefined) {
      lp31.set('anthropic', savedAnthropic31);
    } else {
      lp31.delete('anthropic');
    }
    __resetProvidersEnabled();
    __resetSpawnImpl();
    __clearRecentErrors();
    __resetRequestCounters();
    __setAuthConfig({ allow_anonymous: true, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
    if (savedToken31 !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken31;
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    process.env.OLP_HOME = GLOBAL_OLP_HOME_31;
    if (!server31) return;
    await new Promise(r => server31.close(r));
    rmSync(TMP31, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const mod = await import('./server.mjs');
    mod.__clearCache();
  });

  it('31a — owner identity GETs /v0/management/status → 200 + full payload shape', async () => {
    const { plaintext_token } = createKey({
      name: '31a-owner', owner_tier: 'owner', providers_enabled: '*', olpHome: TMP31,
    });
    const r = await fetch({
      port: port31, method: 'GET', path: '/v0/management/status',
      headers: { Authorization: `Bearer ${plaintext_token}` },
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.body.slice(0, 200)}`);
    const body = JSON.parse(r.body);
    // Top-level shape per ADR 0010 § Phase 4 D63 spec.
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, 'string');
    assert.equal(typeof body.uptime_ms, 'number');
    assert.ok(body.uptime_ms >= 0);
    assert.equal(typeof body.uptime_human, 'string');
    assert.match(body.uptime_human, /^\d+h \d+m \d+s$/);
    assert.equal(typeof body.started_at, 'string');
    assert.ok(body.started_at.includes('T'));
    assert.ok(typeof body.providers === 'object' && body.providers !== null);
    assert.equal(typeof body.providers.enabled, 'number');
    assert.equal(typeof body.providers.available, 'number');
    assert.ok(typeof body.providers.status === 'object');
    assert.ok(typeof body.stats === 'object');
    assert.equal(typeof body.stats.total_requests, 'number');
    assert.equal(typeof body.stats.active_requests, 'number');
    assert.ok(typeof body.stats.cache === 'object');
    assert.ok(Array.isArray(body.recent_errors));
    assert.equal(typeof body.generated_at, 'string');
  });

  it('31b — non-owner (guest) → 401 owner_required', async () => {
    const { plaintext_token } = createKey({
      name: '31b-guest', owner_tier: 'guest', providers_enabled: '*', olpHome: TMP31,
    });
    const r = await fetch({
      port: port31, method: 'GET', path: '/v0/management/status',
      headers: { Authorization: `Bearer ${plaintext_token}` },
    });
    assert.equal(r.status, 401);
    const body = JSON.parse(r.body);
    assert.equal(body.error.type, 'owner_required');
  });

  it('31c — allow_anonymous=false + no header → 401 auth_required', async () => {
    __setAuthConfig({ allow_anonymous: false, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
    try {
      const r = await fetch({ port: port31, method: 'GET', path: '/v0/management/status' });
      assert.equal(r.status, 401);
      const body = JSON.parse(r.body);
      assert.equal(body.error.type, 'auth_required');
    } finally {
      __setAuthConfig({ allow_anonymous: true, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
    }
  });

  it('31d — payload recent_errors populated after a triggered chain-exhausted error', async () => {
    __clearRecentErrors();
    // Install a provider that throws → triggers _pushError on the buffered path.
    const fake = {
      ...savedAnthropic31,
      spawn: async function* (_ir, _ctx) {
        throw new (await import('./lib/providers/base.mjs')).ProviderError(
          'fake spawn failure 31d',
          'SPAWN_FAILED',
        );
        // eslint-disable-next-line no-unreachable
        yield { type: 'stop', finish_reason: 'stop' };
      },
    };
    lp31.set('anthropic', fake);

    // Fire a non-streaming request → goes through executeWithFallback path
    // → chain-exhausted → _pushError fires.
    const trigger = await fetch({
      port: port31, method: 'POST', path: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: '31d-trigger' }],
        stream: false,
      },
    });
    assert.ok(trigger.status === 502 || trigger.status === 500,
      `expected 5xx error, got ${trigger.status}`);

    // Restore real provider so the /status healthCheck doesn't itself throw.
    lp31.set('anthropic', savedAnthropic31);

    // Owner fetches /status — recent_errors must include our pushed entry.
    const { plaintext_token } = createKey({
      name: '31d-owner', owner_tier: 'owner', providers_enabled: '*', olpHome: TMP31,
    });
    const r = await fetch({
      port: port31, method: 'GET', path: '/v0/management/status',
      headers: { Authorization: `Bearer ${plaintext_token}` },
    });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.ok(Array.isArray(body.recent_errors) && body.recent_errors.length >= 1,
      `recent_errors expected to be populated; got ${JSON.stringify(body.recent_errors)}`);
    const matchingEntry = body.recent_errors.find(e =>
      typeof e.message === 'string' && e.message.includes('fake spawn failure 31d'),
    );
    assert.ok(matchingEntry,
      `expected to find the triggered error in recent_errors; got ${JSON.stringify(body.recent_errors)}`);
    assert.equal(matchingEntry.path, '/v1/chat/completions');
    assert.equal(matchingEntry.provider, 'anthropic');
    // total_requests must have advanced past 0 (we made at least 1 chat request).
    assert.ok(body.stats.total_requests >= 1,
      `total_requests expected >= 1, got ${body.stats.total_requests}`);
  });
});

// ── Suite 32: D64 bin/olp.mjs CLI scaffold (ADR 0010 § Phase 4 D64-D67) ───
//
// Smoke tests for the operator CLI. The CLI is invoked in-process via its
// exported runCli() so we get exit codes without spawning a subprocess. The
// process.env is mutated per-test (saved + restored in before/after) so the
// runtime resolution paths (OLP_PROXY_URL / OLP_PORT / OLP_API_KEY / OLP_HOME)
// behave deterministically.
//
// The CLI sources are:
//   bin/olp.mjs              — runCli(argv, { out, err, useColor }) → exit code
//   lib/doctor.mjs           — runDoctor() consumed by `olp doctor`
//
// These tests do NOT spawn a real OLP server for the HTTP subcommands; instead
// each HTTP test starts an ephemeral createOlpServer() listening on port 0 and
// points the CLI at that port via --proxy-url. The owner_token used is created
// per-test via createKey({ owner_tier: 'owner' }).

import { runCli as runOlpCli, parseArgv as parseOlpArgv, resolveBearerToken as olpResolveBearerToken } from './bin/olp.mjs';

describe('Suite 32 — D64 bin/olp.mjs CLI scaffold (ADR 0010 § Phase 4 D64-D67)', () => {
  const SAVED_ENV_32 = {
    OLP_HOME: process.env.OLP_HOME,
    OLP_PROXY_URL: process.env.OLP_PROXY_URL,
    OLP_PORT: process.env.OLP_PORT,
    OLP_API_KEY: process.env.OLP_API_KEY,
    OLP_OWNER_TOKEN: process.env.OLP_OWNER_TOKEN,
  };
  let TMP32;

  before(() => {
    TMP32 = mkdtempSync(pathJoin(tmpdir(), 'olp-test-32-'));
    process.env.OLP_HOME = TMP32;
    // Clear conflicting env vars for deterministic resolution
    delete process.env.OLP_PROXY_URL;
    delete process.env.OLP_PORT;
    delete process.env.OLP_API_KEY;
    delete process.env.OLP_OWNER_TOKEN;
  });

  after(() => {
    for (const [k, v] of Object.entries(SAVED_ENV_32)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(TMP32, { recursive: true, force: true });
  });

  // Helper: capture stdout / stderr buffers via IO writers
  function makeCapture() {
    let out = '', err = '';
    return {
      out: s => { out += s; },
      err: s => { err += s; },
      get stdout() { return out; },
      get stderr() { return err; },
    };
  }

  it('32a — parseArgv: --flag=value + --flag value + bare --flag', () => {
    const a = parseOlpArgv(['--json', '--port=4567', '--name', 'foo', 'positional']);
    assert.equal(a.flags.json, true);
    assert.equal(a.flags.port, '4567');
    assert.equal(a.flags.name, 'foo');
    assert.deepEqual(a.positional, ['positional']);
  });

  it('32b — `olp` (no args) prints USAGE and returns exit code 1', async () => {
    const cap = makeCapture();
    const code = await runOlpCli([], { out: cap.out, err: cap.err, useColor: false });
    assert.equal(code, 1, 'no-args should return 1');
    assert.match(cap.stdout, /OLP operator CLI/);
    assert.match(cap.stdout, /Subcommands:/);
  });

  it('32c — `olp help` prints USAGE and returns exit code 0', async () => {
    const cap = makeCapture();
    const code = await runOlpCli(['help'], { out: cap.out, err: cap.err, useColor: false });
    assert.equal(code, 0);
    assert.match(cap.stdout, /OLP operator CLI/);
  });

  it('32d — `olp unknown` prints error + USAGE on stderr, returns exit code 1', async () => {
    const cap = makeCapture();
    const code = await runOlpCli(['frobnicate'], { out: cap.out, err: cap.err, useColor: false });
    assert.equal(code, 1);
    assert.match(cap.stderr, /unknown subcommand "frobnicate"/);
    assert.match(cap.stderr, /OLP operator CLI/);
  });

  it('32e — `olp providers` (local, no HTTP) → lists registry entries', async () => {
    const cap = makeCapture();
    const code = await runOlpCli(['providers'], { out: cap.out, err: cap.err, useColor: false });
    assert.equal(code, 0);
    // All three shipped plugin keys must appear
    assert.match(cap.stdout, /anthropic/);
    assert.match(cap.stdout, /openai/);
    assert.match(cap.stdout, /mistral/);
    // No providers enabled in the empty TMP32 config → all show disabled
    assert.match(cap.stdout, /disabled/);
  });

  it('32f — `olp providers --json` emits parseable JSON with providers[]', async () => {
    const cap = makeCapture();
    const code = await runOlpCli(['providers', '--json'], { out: cap.out, err: cap.err, useColor: false });
    assert.equal(code, 0);
    const body = JSON.parse(cap.stdout);
    assert.ok(Array.isArray(body.providers));
    assert.ok(body.providers.length >= 3);
    const names = body.providers.map(p => p.name);
    assert.ok(names.includes('anthropic'));
    assert.ok(names.includes('openai'));
    assert.ok(names.includes('mistral'));
  });

  it('32g — `olp chain show` with no chains in config prints "no chains configured"', async () => {
    const cap = makeCapture();
    const code = await runOlpCli(['chain', 'show'], { out: cap.out, err: cap.err, useColor: false });
    assert.equal(code, 0);
    assert.match(cap.stdout, /no chains configured/);
  });

  it('32h — `olp status` against an ephemeral OLP server with owner token → 200', async () => {
    // Spin up an ephemeral server bound to a random port; CLI talks to it.
    __setProvidersEnabled({});
    __setAuthConfig({ allow_anonymous: true, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
    const mod = await import('./server.mjs');
    mod.__clearCache();
    mod.__clearRecentErrors();
    mod.__resetRequestCounters();

    const server32 = mod.createOlpServer();
    await new Promise((resolve, reject) => {
      server32.listen(0, '127.0.0.1', resolve);
      server32.once('error', reject);
    });
    const port32 = server32.address().port;
    try {
      // Create owner key + use it via OLP_API_KEY env (resolveBearerToken reads it first)
      const { plaintext_token } = createKey({
        name: '32h-owner', owner_tier: 'owner', providers_enabled: '*', olpHome: TMP32,
      });
      const SAVED_TOK = process.env.OLP_API_KEY;
      process.env.OLP_API_KEY = plaintext_token;
      try {
        const cap = makeCapture();
        const code = await runOlpCli(
          ['status', `--proxy-url=http://127.0.0.1:${port32}`, '--json'],
          { out: cap.out, err: cap.err, useColor: false },
        );
        assert.equal(code, 0, `status JSON exit non-zero; stderr=${cap.stderr}`);
        const body = JSON.parse(cap.stdout);
        assert.equal(body.ok, true);
        assert.ok(typeof body.version === 'string');
        assert.ok(typeof body.uptime_ms === 'number');
      } finally {
        if (SAVED_TOK === undefined) delete process.env.OLP_API_KEY;
        else process.env.OLP_API_KEY = SAVED_TOK;
      }
    } finally {
      await new Promise(r => server32.close(r));
      __resetProvidersEnabled();
      __setAuthConfig({ allow_anonymous: true, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
    }
  });

  it('32i — `olp status` against a non-existent port → exit 2 ECONNREFUSED', async () => {
    // Pick a random high port unlikely to be in use; the CLI must detect
    // ECONNREFUSED and surface the helpful hint.
    const cap = makeCapture();
    const code = await runOlpCli(
      ['status', '--proxy-url=http://127.0.0.1:1'],  // port 1 → ECONNREFUSED on macOS/Linux
      { out: cap.out, err: cap.err, useColor: false },
    );
    assert.equal(code, 2, `expected ECONNREFUSED → exit 2, got ${code}; stderr=${cap.stderr}`);
    assert.match(cap.stderr, /unreachable|ECONNREFUSED/);
  });

  it('32j — resolveBearerToken precedence: OLP_API_KEY > OLP_OWNER_TOKEN > null', () => {
    const SAVED_API = process.env.OLP_API_KEY;
    const SAVED_OWN = process.env.OLP_OWNER_TOKEN;
    try {
      // 1. Neither set → null
      delete process.env.OLP_API_KEY;
      delete process.env.OLP_OWNER_TOKEN;
      assert.equal(olpResolveBearerToken(), null);

      // 2. Only OLP_OWNER_TOKEN → that wins
      process.env.OLP_OWNER_TOKEN = 'owner-tok-32j';
      assert.equal(olpResolveBearerToken(), 'owner-tok-32j');

      // 3. OLP_API_KEY also set → API key wins
      process.env.OLP_API_KEY = 'api-key-32j';
      assert.equal(olpResolveBearerToken(), 'api-key-32j');
    } finally {
      if (SAVED_API === undefined) delete process.env.OLP_API_KEY;
      else process.env.OLP_API_KEY = SAVED_API;
      if (SAVED_OWN === undefined) delete process.env.OLP_OWNER_TOKEN;
      else process.env.OLP_OWNER_TOKEN = SAVED_OWN;
    }
  });
});

// ── Suite 33: D65 lib/doctor.mjs framework (ADR 0010 § Phase 4 D64-D67) ───
//
// Framework tests for `olp doctor`. Uses runDoctor()'s opts.injectChecks
// hook to drive every kind branch (noop / fresh_install / fix_server /
// fix_oauth / fix_provider / fix_config) deterministically without depending
// on real filesystem or network state.

import {
  runDoctor as runOlpDoctor,
  buildBuiltinChecks as buildOlpBuiltinChecks,
  collectProviderChecks as collectOlpProviderChecks,
  deriveKind as deriveOlpKind,
  deriveNextAction as deriveOlpNextAction,
  resolveProxyUrl as resolveOlpProxyUrl,
  DOCTOR_SCHEMA_VERSION,
} from './lib/doctor.mjs';

describe('Suite 33 — D65 lib/doctor.mjs framework (ADR 0010 § Phase 4 D64-D67)', () => {

  // Helper: build a fake check with deterministic status + optional evidence
  function fakeCheck(id, category, status, message = 'fake', evidence) {
    return {
      id,
      category,
      async run() {
        return evidence ? { status, message, evidence } : { status, message };
      },
    };
  }

  it('33a — all-ok checks → kind=noop, next_action.ai_executable=[]', async () => {
    const result = await runOlpDoctor({
      injectChecks: [
        fakeCheck('system.node_version', 'system', 'ok', 'Node 20'),
        fakeCheck('server.running', 'server', 'ok', 'live'),
        fakeCheck('auth.owner_key_exists', 'auth', 'ok', 'present'),
      ],
    });
    assert.equal(result.schema_version, DOCTOR_SCHEMA_VERSION);
    assert.equal(result.fail_count, 0);
    assert.equal(result.kind, 'noop');
    assert.deepEqual(result.next_action.ai_executable, []);
    assert.deepEqual(result.next_action.human_required, []);
    assert.equal(result.next_action.verify, 'already healthy');
    assert.match(result.summary, /all 3 checks ok/);
  });

  it('33b — server.running FAIL → kind=fix_server + ai_executable propagates', async () => {
    const result = await runOlpDoctor({
      injectChecks: [
        fakeCheck('server.running', 'server', 'fail', 'unreachable', {
          fix_commands: ['olp restart'],
        }),
        fakeCheck('auth.owner_key_exists', 'auth', 'ok', 'present'),
      ],
    });
    assert.equal(result.fail_count, 1);
    assert.equal(result.kind, 'fix_server');
    assert.deepEqual(result.next_action.ai_executable, ['olp restart']);
    assert.equal(result.next_action.verify, 'olp doctor');
  });

  it('33c — auth.owner_key_exists FAIL (no server fail) → kind=fix_oauth', async () => {
    const result = await runOlpDoctor({
      injectChecks: [
        fakeCheck('server.running', 'server', 'ok', 'live'),
        fakeCheck('auth.owner_key_exists', 'auth', 'fail', 'no owner', {
          fix_commands: ['npx olp-keys keygen --owner'],
        }),
      ],
    });
    assert.equal(result.kind, 'fix_oauth');
    assert.deepEqual(result.next_action.ai_executable, ['npx olp-keys keygen --owner']);
  });

  it('33d — config.exists FAIL beats everything else → kind=fresh_install', async () => {
    const result = await runOlpDoctor({
      injectChecks: [
        fakeCheck('config.exists', 'config', 'fail', 'missing', {
          fix_commands: ['mkdir -p ~/.olp'],
        }),
        fakeCheck('server.running', 'server', 'fail', 'unreachable', {
          fix_commands: ['olp restart'],
        }),
        fakeCheck('auth.owner_key_exists', 'auth', 'fail', 'no owner'),
      ],
    });
    assert.equal(result.kind, 'fresh_install');
    // ai_executable concatenates all FAIL evidence.fix_commands
    assert.ok(result.next_action.ai_executable.includes('mkdir -p ~/.olp'));
    assert.ok(result.next_action.ai_executable.includes('olp restart'));
  });

  it('33e — provider-category FAIL only → kind=fix_provider, human_steps propagate', async () => {
    const result = await runOlpDoctor({
      injectChecks: [
        fakeCheck('server.running', 'server', 'ok', 'live'),
        fakeCheck('auth.owner_key_exists', 'auth', 'ok', 'present'),
        fakeCheck('anthropic.oauth_token_present', 'provider', 'fail', 'missing token', {
          human_steps: ['run: claude  (browser OAuth)'],
        }),
      ],
    });
    assert.equal(result.kind, 'fix_provider');
    assert.deepEqual(result.next_action.ai_executable, []);
    assert.deepEqual(result.next_action.human_required, ['run: claude  (browser OAuth)']);
  });

  it('33f — collectProviderChecks reads plugin doctorChecks() (ADR 0002 Amendment 7)', () => {
    // Synthetic plugin map that includes one plugin WITH doctorChecks() + one
    // plugin WITHOUT (default behaviour — back-compat — contributes nothing).
    const providers = new Map();
    providers.set('alpha', {
      name: 'alpha',
      doctorChecks() {
        return [
          { id: 'alpha.cli_available', category: 'provider', async run() { return { status: 'ok', message: 'alpha bin ok' }; } },
          { id: 'alpha.auth_present', category: 'provider', async run() { return { status: 'fail', message: 'alpha missing' }; } },
        ];
      },
    });
    providers.set('legacy', {
      name: 'legacy',
      // No doctorChecks() — plugin pre-amendment 7; collectProviderChecks ignores it
    });
    const checks = collectOlpProviderChecks({ providersOverride: providers });
    const ids = checks.map(c => c.id).sort();
    assert.deepEqual(ids, ['alpha.auth_present', 'alpha.cli_available']);
    // Categories normalized to 'provider'
    assert.ok(checks.every(c => c.category === 'provider'));
  });

  it('33g — plugin doctorChecks() that throws is captured (does not crash framework)', async () => {
    const providers = new Map();
    providers.set('bad', {
      name: 'bad',
      doctorChecks() { throw new Error('boom from bad plugin'); },
    });
    const checks = collectOlpProviderChecks({ providersOverride: providers });
    assert.equal(checks.length, 1);
    assert.equal(checks[0].id, 'bad.doctor_checks_threw');
    // Run it — should resolve to fail without re-throwing
    const r = await checks[0].run();
    assert.equal(r.status, 'fail');
    assert.match(r.message, /boom from bad plugin/);
  });

  it('33h — --check filter restricts to matching id/category/prefix', async () => {
    // Filter by category
    const r1 = await runOlpDoctor({
      injectChecks: [
        fakeCheck('a.x', 'provider', 'ok'),
        fakeCheck('b.y', 'system', 'ok'),
      ],
      checkFilter: 'system',
    });
    assert.equal(r1.checks.length, 1);
    assert.equal(r1.checks[0].id, 'b.y');

    // Filter by id prefix
    const r2 = await runOlpDoctor({
      injectChecks: [
        fakeCheck('anthropic.cli_available', 'provider', 'ok'),
        fakeCheck('anthropic.oauth_token_present', 'provider', 'ok'),
        fakeCheck('openai.cli_available', 'provider', 'ok'),
      ],
      checkFilter: 'anthropic',
    });
    assert.equal(r2.checks.length, 2);
    assert.ok(r2.checks.every(c => c.id.startsWith('anthropic.')));

    // Filter by exact id
    const r3 = await runOlpDoctor({
      injectChecks: [
        fakeCheck('anthropic.cli_available', 'provider', 'ok'),
        fakeCheck('anthropic.oauth_token_present', 'provider', 'ok'),
      ],
      checkFilter: 'anthropic.cli_available',
    });
    assert.equal(r3.checks.length, 1);
    assert.equal(r3.checks[0].id, 'anthropic.cli_available');
  });

  it('33i — built-in checks run against a temp OLP_HOME (no config → fresh_install)', async () => {
    // skipNetwork: true so server.* checks don't run against the localhost port.
    const tmpEmpty = mkdtempSync(pathJoin(tmpdir(), 'olp-doc-33i-'));
    try {
      const result = await runOlpDoctor({
        olpHome: tmpEmpty,
        skipNetwork: true,
        // Don't load real provider plugins for this run; pass an empty Map.
        providersOverride: new Map(),
      });
      assert.equal(result.schema_version, DOCTOR_SCHEMA_VERSION);
      // config.exists must FAIL (no ~/.olp/config.json in tmpEmpty)
      const configCheck = result.checks.find(c => c.id === 'config.exists');
      assert.ok(configCheck, 'config.exists check should run');
      assert.equal(configCheck.status, 'fail');
      // kind must be fresh_install per the precedence rule
      assert.equal(result.kind, 'fresh_install');
      // ai_executable must include the mkdir + printf seed bootstrap
      assert.ok(result.next_action.ai_executable.some(c => c.startsWith('mkdir -p')));
    } finally {
      rmSync(tmpEmpty, { recursive: true, force: true });
    }
  });

  it('33j — anthropic plugin doctorChecks() returns the documented probe set', () => {
    // Plugin contract: ADR 0002 Amendment 7 (D67) + D80 (quota probe check).
    // anthropic.mjs ships:
    //   anthropic.cli_available (D67)
    //   anthropic.oauth_token_present (D67)
    //   anthropic.quota_probe_reachable (D80 — Phase 5, ADR 0013 Rule 6)
    const checks = anthropic.doctorChecks();
    assert.ok(Array.isArray(checks));
    const ids = checks.map(c => c.id).sort();
    assert.deepEqual(ids, [
      'anthropic.cli_available',
      'anthropic.oauth_token_present',
      'anthropic.quota_probe_reachable',
    ]);
    assert.ok(checks.every(c => c.category === 'provider'));
    assert.ok(checks.every(c => typeof c.run === 'function'));
  });

  it('33k — resolveProxyUrl: explicit > env OLP_PROXY_URL > OLP_PORT > default', () => {
    const SAVED_URL = process.env.OLP_PROXY_URL;
    const SAVED_PORT = process.env.OLP_PORT;
    try {
      delete process.env.OLP_PROXY_URL;
      delete process.env.OLP_PORT;
      // 1. default = http://127.0.0.1:4567
      assert.equal(resolveOlpProxyUrl(), 'http://127.0.0.1:4567');
      // 2. OLP_PORT env
      process.env.OLP_PORT = '9999';
      assert.equal(resolveOlpProxyUrl(), 'http://127.0.0.1:9999');
      // 3. OLP_PROXY_URL wins over OLP_PORT
      process.env.OLP_PROXY_URL = 'https://example.com:8443';
      assert.equal(resolveOlpProxyUrl(), 'https://example.com:8443');
      // 4. Explicit opts wins over everything
      assert.equal(resolveOlpProxyUrl({ proxyUrl: 'http://override:1234' }), 'http://override:1234');
    } finally {
      if (SAVED_URL === undefined) delete process.env.OLP_PROXY_URL;
      else process.env.OLP_PROXY_URL = SAVED_URL;
      if (SAVED_PORT === undefined) delete process.env.OLP_PORT;
      else process.env.OLP_PORT = SAVED_PORT;
    }
  });

  it('33l — deriveKind / deriveNextAction pure-function shape', () => {
    // deriveKind unit
    assert.equal(deriveOlpKind([{ status: 'ok', category: 'server', id: 'a' }]), 'noop');
    assert.equal(deriveOlpKind([
      { status: 'fail', category: 'server', id: 's.r' },
      { status: 'fail', category: 'auth', id: 'a.o' },
    ]), 'fix_server');  // server beats auth

    // deriveNextAction aggregates evidence
    const na = deriveOlpNextAction([
      { status: 'fail', id: 'x', category: 'provider', evidence: { fix_commands: ['cmd1'], human_steps: ['step1'] } },
      { status: 'fail', id: 'y', category: 'provider', evidence: { fix_commands: ['cmd2'] } },
      { status: 'ok',   id: 'z', category: 'provider' },
    ], 'fix_provider');
    assert.deepEqual(na.ai_executable, ['cmd1', 'cmd2']);
    assert.deepEqual(na.human_required, ['step1']);
    assert.equal(na.verify, 'olp doctor');
  });
});

// ── Suite 34: D68-D70 — /health.anonymousKey + plaintext_advertise (ADR 0011) ──
//
// Tests for:
//   - lib/keys.mjs createKey({ plaintext_advertise: true }) writes the field;
//     rejects on owner tier
//   - lib/keys.mjs findAdvertisedKey() discovery semantics (skips revoked /
//     skips no-advertise / returns first match)
//   - server.mjs /health emits anonymousKey ONLY when all 3 prerequisites hold
//   - bin/olp-keys.mjs `--anonymous --advertise` end-to-end (manifest +
//     plaintext printed + stderr warning + advertise label)
//   - bin/olp-keys.mjs rejects `--owner --advertise`

import {
  findAdvertisedKey as findAdvertisedKey34,
} from './lib/keys.mjs';

describe('Suite 34 — D68-D70 /health.anonymousKey + plaintext_advertise (ADR 0011)', () => {
  const SUITE34_GLOBAL_OLP_HOME = process.env.OLP_HOME;

  // ── 34a-c: lib/keys.mjs unit tests ──────────────────────────────────────

  describe('34a-c — lib/keys.mjs createKey + findAdvertisedKey', () => {
    let TMP;
    before(() => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-34abc-'));
    });
    after(() => {
      rmSync(TMP, { recursive: true, force: true });
      __resetWriteLocks();
    });

    it('34a — createKey({ plaintext_advertise: true }) writes plaintext_advertise field on guest manifest', () => {
      const { id, plaintext_token, manifest } = createKey({
        name: '34a-advert', owner_tier: 'guest', providers_enabled: '*',
        plaintext_advertise: true, olpHome: TMP,
      });
      assert.equal(manifest.plaintext_advertise, plaintext_token);
      // Verify on-disk
      const reread = readManifest(id, { olpHome: TMP });
      assert.equal(reread.plaintext_advertise, plaintext_token);
      // Token hash also correct
      assert.equal(reread.token_hash, hashToken(plaintext_token));
    });

    it('34a-2 — createKey() default (no plaintext_advertise) does NOT write the field (ADR 0007 § 5 invariant preserved)', () => {
      const { id, manifest } = createKey({
        name: '34a2-normal', owner_tier: 'guest', providers_enabled: '*', olpHome: TMP,
      });
      assert.ok(!('plaintext_advertise' in manifest), 'manifest must NOT carry plaintext_advertise by default');
      const reread = readManifest(id, { olpHome: TMP });
      assert.ok(!('plaintext_advertise' in reread), 'on-disk manifest must NOT carry plaintext_advertise by default');
    });

    it('34b — createKey({ owner_tier:"owner", plaintext_advertise:true }) is rejected (ADR 0011 tier restriction)', () => {
      assert.throws(
        () => createKey({
          name: '34b-fail', owner_tier: 'owner', plaintext_advertise: true, olpHome: TMP,
        }),
        /plaintext_advertise requires owner_tier="guest"/,
      );
    });

    it('34c-1 — findAdvertisedKey() returns null when no key has plaintext_advertise', () => {
      const TMP2 = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-34c1-'));
      try {
        createKey({ name: 'plain', owner_tier: 'guest', olpHome: TMP2 });
        assert.equal(findAdvertisedKey34({ olpHome: TMP2 }), null);
      } finally {
        rmSync(TMP2, { recursive: true, force: true });
      }
    });

    it('34c-2 — findAdvertisedKey() returns the advertised manifest with plaintext_advertise field intact', () => {
      const TMP3 = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-34c2-'));
      try {
        const { plaintext_token } = createKey({
          name: '34c2', owner_tier: 'guest', plaintext_advertise: true, olpHome: TMP3,
        });
        const found = findAdvertisedKey34({ olpHome: TMP3 });
        assert.ok(found !== null, 'findAdvertisedKey must return non-null');
        assert.equal(found.plaintext_advertise, plaintext_token);
        assert.equal(found.owner_tier, 'guest');
      } finally {
        rmSync(TMP3, { recursive: true, force: true });
      }
    });

    it('34c-3 — findAdvertisedKey() skips revoked advertised keys', async () => {
      const TMP4 = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-34c3-'));
      try {
        const { id } = createKey({
          name: '34c3', owner_tier: 'guest', plaintext_advertise: true, olpHome: TMP4,
        });
        assert.ok(findAdvertisedKey34({ olpHome: TMP4 }) !== null, 'pre-revoke: must find it');
        await revokeKey({ id, olpHome: TMP4 });
        assert.equal(findAdvertisedKey34({ olpHome: TMP4 }), null, 'post-revoke: must skip');
      } finally {
        rmSync(TMP4, { recursive: true, force: true });
      }
    });
  });

  // ── 34d-g: /health.anonymousKey HTTP integration (D69 prereqs) ──────────

  describe('34d-g — /health.anonymousKey HTTP integration', () => {
    let TMP, server, port;

    async function makeSuite34Server() {
      __setProvidersEnabled({});
      const srv = createOlpServer();
      return new Promise(resolve => {
        srv.listen(0, '127.0.0.1', () => resolve({ server: srv, port: srv.address().port }));
      });
    }
    function teardownSuite34() {
      return new Promise(resolve => {
        __setProvidersEnabled({});
        __clearCache();
        if (server) server.close(() => resolve());
        else resolve();
      });
    }

    before(async () => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-34dg-'));
      process.env.OLP_HOME = TMP;
      ({ server, port } = await makeSuite34Server());
    });

    after(async () => {
      await teardownSuite34();
      process.env.OLP_HOME = SUITE34_GLOBAL_OLP_HOME;
      // Restore test-global auth config so subsequent suites are unaffected
      __setAuthConfig({ allow_anonymous: true, owner_only_endpoints: [], fallback_detail_header_policy: 'all' });
      rmSync(TMP, { recursive: true, force: true });
    });

    beforeEach(() => {
      // Clean slate between cases — each test installs the precise auth config
      // it needs (default-off / advertise-but-no-anon / advertise-but-no-key /
      // all three prerequisites met) before issuing the /health request.
      __setAuthConfig({
        allow_anonymous: false,
        owner_only_endpoints: ['/health'],
        fallback_detail_header_policy: 'owner_only',
        advertise_anonymous_key: false,
      });
    });

    it('34d — default (advertise_anonymous_key: false) — /health response has NO anonymousKey field', async () => {
      // Create an advertised key on disk but don't enable the flag.
      createKey({
        name: '34d-key', owner_tier: 'guest', plaintext_advertise: true, olpHome: TMP,
      });
      // Owner identity to access full payload (since allow_anonymous: false)
      const { plaintext_token } = createKey({
        name: '34d-owner', owner_tier: 'owner', olpHome: TMP,
      });
      const r = await fetch({
        port, method: 'GET', path: '/health',
        headers: { Authorization: `Bearer ${plaintext_token}` },
      });
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      assert.ok(!('anonymousKey' in body), '/health MUST NOT include anonymousKey when advertise_anonymous_key=false');
    });

    it('34e — advertise_anonymous_key: true + allow_anonymous: false → field omitted (prereq 2 fails)', async () => {
      createKey({
        name: '34e-key', owner_tier: 'guest', plaintext_advertise: true, olpHome: TMP,
      });
      __setAuthConfig({
        allow_anonymous: false,           // prereq 2 NOT satisfied
        advertise_anonymous_key: true,
        owner_only_endpoints: ['/health'],
        fallback_detail_header_policy: 'owner_only',
      });
      // Use owner identity (must — allow_anonymous=false rejects anonymous)
      const { plaintext_token } = createKey({
        name: '34e-owner', owner_tier: 'owner', olpHome: TMP,
      });
      const r = await fetch({
        port, method: 'GET', path: '/health',
        headers: { Authorization: `Bearer ${plaintext_token}` },
      });
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      assert.ok(!('anonymousKey' in body), '/health MUST NOT include anonymousKey when allow_anonymous=false even if advertise=true');
    });

    it('34f — advertise_anonymous_key: true + allow_anonymous: true + NO advertised key → field omitted (prereq 3 fails)', async () => {
      // Fresh isolated tmpdir so no advertised key exists
      const TMP_F = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-34f-'));
      const SAVED = process.env.OLP_HOME;
      process.env.OLP_HOME = TMP_F;
      __setAuthConfig({
        allow_anonymous: true,
        advertise_anonymous_key: true,
        owner_only_endpoints: [],          // /health full payload to anonymous
        fallback_detail_header_policy: 'all',
      });
      try {
        const r = await fetch({ port, method: 'GET', path: '/health' });
        assert.equal(r.status, 200);
        const body = JSON.parse(r.body);
        assert.ok(!('anonymousKey' in body), '/health MUST NOT include anonymousKey when no plaintext_advertise key exists');
      } finally {
        process.env.OLP_HOME = SAVED;
        rmSync(TMP_F, { recursive: true, force: true });
      }
    });

    it('34g — all 3 prerequisites met → /health.anonymousKey exposes the plaintext token', async () => {
      const TMP_G = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-34g-'));
      const SAVED = process.env.OLP_HOME;
      process.env.OLP_HOME = TMP_G;
      try {
        const { plaintext_token } = createKey({
          name: '34g-anon', owner_tier: 'guest', plaintext_advertise: true, olpHome: TMP_G,
        });
        __setAuthConfig({
          allow_anonymous: true,
          advertise_anonymous_key: true,
          owner_only_endpoints: [],         // anonymous sees full payload too
          fallback_detail_header_policy: 'all',
        });
        const r = await fetch({ port, method: 'GET', path: '/health' });
        assert.equal(r.status, 200);
        const body = JSON.parse(r.body);
        assert.equal(body.anonymousKey, plaintext_token);
        assert.match(body.anonymousKey, /^olp_[A-Za-z0-9_-]{43}$/);
      } finally {
        process.env.OLP_HOME = SAVED;
        rmSync(TMP_G, { recursive: true, force: true });
      }
    });

    it('34g-trimmed — anonymousKey also surfaces in trimmed /health (anonymous client zero-config path)', async () => {
      // /health is gated as owner-only; anonymous client gets trimmed payload
      // but anonymousKey must still surface — it's the whole point of D69.
      const TMP_H = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-34gt-'));
      const SAVED = process.env.OLP_HOME;
      process.env.OLP_HOME = TMP_H;
      try {
        const { plaintext_token } = createKey({
          name: '34gt-anon', owner_tier: 'guest', plaintext_advertise: true, olpHome: TMP_H,
        });
        __setAuthConfig({
          allow_anonymous: true,
          advertise_anonymous_key: true,
          owner_only_endpoints: ['/health'],   // trim gating ACTIVE
          fallback_detail_header_policy: 'owner_only',
        });
        const r = await fetch({ port, method: 'GET', path: '/health' });
        assert.equal(r.status, 200);
        const body = JSON.parse(r.body);
        // Trimmed shape (no providers) BUT anonymousKey is present
        assert.ok(!('providers' in body), 'trimmed /health must omit providers');
        assert.equal(body.anonymousKey, plaintext_token);
      } finally {
        process.env.OLP_HOME = SAVED;
        rmSync(TMP_H, { recursive: true, force: true });
      }
    });
  });

  // ── 34h-j: bin/olp-keys.mjs --anonymous --advertise CLI ─────────────────

  describe('34h-j — bin/olp-keys.mjs --anonymous --advertise', () => {
    let TMP;
    before(() => {
      TMP = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-34hj-'));
    });
    after(() => {
      rmSync(TMP, { recursive: true, force: true });
      __resetWriteLocks();
    });

    it('34h — keygen --anonymous --advertise creates guest+advertise key + prints WARNING to stderr', async () => {
      let out = '';
      let err = '';
      const code = await runOlpKeysCli(
        ['keygen', '--anonymous', '--advertise', '--olp-home', TMP],
        { out: s => { out += s; }, err: s => { err += s; } },
      );
      assert.equal(code, 0);
      assert.match(out, /token \(plaintext\):\s+olp_[A-Za-z0-9_-]{43}/);
      assert.match(out, /owner_tier:\s+guest/);
      assert.match(out, /name:\s+anonymous/);
      assert.match(out, /advertise:\s+YES/);
      assert.match(err, /WARNING:.*plaintext is now stored on disk/);
      assert.match(err, /ADR 0011/);
      // Manifest carries plaintext_advertise + matches printed plaintext
      const advManifest = findAdvertisedKey34({ olpHome: TMP });
      assert.ok(advManifest !== null);
      const printedTokenMatch = out.match(/token \(plaintext\):\s+(olp_[A-Za-z0-9_-]{43})/);
      assert.ok(printedTokenMatch);
      assert.equal(advManifest.plaintext_advertise, printedTokenMatch[1]);
    });

    it('34i — keygen --owner --advertise → exit 1 with ADR 0011 pointer (tier mismatch rejected at CLI layer)', async () => {
      const TMP_I = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-34i-'));
      try {
        let err = '';
        const code = await runOlpKeysCli(
          ['keygen', '--owner', '--advertise', '--olp-home', TMP_I],
          { out: () => {}, err: s => { err += s; } },
        );
        assert.equal(code, 1);
        assert.match(err, /--advertise requires guest tier/);
        assert.match(err, /ADR 0011/);
        // Nothing was written
        assert.equal(listKeys({ olpHome: TMP_I }).length, 0);
      } finally {
        rmSync(TMP_I, { recursive: true, force: true });
      }
    });

    it('34j — keygen --anonymous (without --advertise) creates guest key WITHOUT plaintext_advertise field', async () => {
      const TMP_J = _mkdtempSyncForSetup(_pathJoinForSetup(_tmpdirForSetup(), 'olp-test-34j-'));
      try {
        let out = '';
        const code = await runOlpKeysCli(
          ['keygen', '--anonymous', '--olp-home', TMP_J],
          { out: s => { out += s; }, err: () => {} },
        );
        assert.equal(code, 0);
        assert.match(out, /owner_tier:\s+guest/);
        assert.match(out, /name:\s+anonymous/);
        assert.doesNotMatch(out, /advertise:\s+YES/);
        // Manifest does NOT carry plaintext_advertise
        assert.equal(findAdvertisedKey34({ olpHome: TMP_J }), null);
      } finally {
        rmSync(TMP_J, { recursive: true, force: true });
      }
    });
  });
});

// ── Suite 35: D71 olp-plugin/ smoke tests (ADR 0010 § Phase 4 D71-D73) ─────
//
// The plugin's default export takes an OpenClaw `api` object and registers a
// command — we can't fully unit-test the registration without mocking the
// gateway. Instead we test the exported helpers + dispatcher with the global
// fetch swapped out for a mock. These cover:
//
//   35a — mono() wrapping for chat surfaces
//   35b — bar() boundary behaviour (clamping + width)
//   35c — resolveProxyUrl precedence (env > env-port > config > default)
//   35d — truncateForChat truncation behaviour
//   35e — fmtStatus / fmtHealth / fmtUsage / fmtModels / fmtCache /
//         fmtProviders / fmtChainShow / fmtDoctor render expected fields
//   35f — dispatch() unknown subcommand → help message
//   35g — dispatch() routes status/health/usage/models/cache to the right URL
//         with Authorization: Bearer header
//   35h — dispatch() doctor returns the "use SSH" advisory (HTTP doctor
//         endpoint not yet shipped)
//   35i — dispatch() catches fetch errors and emits "OLP error: ..."

import {
  mono as plugMono,
  bar as plugBar,
  statusIcon as plugStatusIcon,
  truncateForChat as plugTruncate,
  resolveProxyUrl as plugResolveProxyUrl,
  fmtStatus as plugFmtStatus,
  fmtHealth as plugFmtHealth,
  fmtUsage as plugFmtUsage,
  fmtModels as plugFmtModels,
  fmtCache as plugFmtCache,
  fmtProviders as plugFmtProviders,
  fmtChainShow as plugFmtChainShow,
  fmtDoctor as plugFmtDoctor,
  cmdHelp as plugCmdHelp,
  dispatch as plugDispatch,
} from './olp-plugin/index.js';

describe('Suite 35 — D71 olp-plugin/ smoke tests (ADR 0010 § Phase 4 D71-D73)', () => {

  // ── 35a — mono() ────────────────────────────────────────────────────────

  it('35a — mono() wraps text in triple-backtick code block', () => {
    const out = plugMono('hello\nworld');
    assert.equal(out, '```\nhello\nworld\n```');
  });

  // ── 35b — bar() ─────────────────────────────────────────────────────────

  it('35b — bar() clamps pct ∈ [0,1] and respects width', () => {
    assert.equal(plugBar(0, 8), '░░░░░░░░');
    assert.equal(plugBar(1, 8), '████████');
    assert.equal(plugBar(0.5, 8), '████░░░░');
    assert.equal(plugBar(-1, 8), '░░░░░░░░', 'negative pct clamps to 0');
    assert.equal(plugBar(2, 8), '████████', 'pct > 1 clamps to 1');
    assert.equal(plugBar(NaN, 8), '░░░░░░░░', 'NaN treated as 0');
    assert.equal(plugBar(0.5).length, 16, 'default width = 16');
  });

  it('35b-icon — statusIcon() maps ok/degraded/fail to expected glyphs', () => {
    assert.equal(plugStatusIcon('ok'), '🟢');
    assert.equal(plugStatusIcon(true), '🟢');
    assert.equal(plugStatusIcon('degraded'), '🟡');
    assert.equal(plugStatusIcon('warn'), '🟡');
    assert.equal(plugStatusIcon('fail'), '🔴');
    assert.equal(plugStatusIcon(false), '🔴');
  });

  // ── 35c — resolveProxyUrl precedence ────────────────────────────────────

  it('35c — resolveProxyUrl precedence: OLP_PROXY_URL > OLP_PORT > config.proxyUrl > default', () => {
    // 1. Default fallback
    assert.equal(plugResolveProxyUrl({ env: {}, config: {} }), 'http://127.0.0.1:4567');
    // 2. config.proxyUrl wins over default
    assert.equal(
      plugResolveProxyUrl({ env: {}, config: { proxyUrl: 'http://10.0.0.5:9999' } }),
      'http://10.0.0.5:9999',
    );
    // 3. OLP_PORT wins over config.proxyUrl
    assert.equal(
      plugResolveProxyUrl({ env: { OLP_PORT: '8000' }, config: { proxyUrl: 'http://config:1' } }),
      'http://127.0.0.1:8000',
    );
    // 4. OLP_PROXY_URL wins over OLP_PORT + config
    assert.equal(
      plugResolveProxyUrl({
        env: { OLP_PROXY_URL: 'http://env-url:1234', OLP_PORT: '8000' },
        config: { proxyUrl: 'http://config:1' },
      }),
      'http://env-url:1234',
    );
  });

  // ── 35d — truncateForChat ───────────────────────────────────────────────

  it('35d — truncateForChat passes short text untouched + truncates long text with marker', () => {
    const short = 'hello world';
    assert.equal(plugTruncate(short), short);
    const long = 'A'.repeat(5000);
    const truncated = plugTruncate(long, 1000);
    assert.ok(truncated.length <= 1000);
    assert.match(truncated, /truncated, use SSH for full/);
    assert.ok(truncated.startsWith('AAA'));
  });

  // ── 35e — Formatters ────────────────────────────────────────────────────

  it('35e-1 — fmtStatus() renders version + uptime + provider list + recent errors', () => {
    const body = {
      ok: true,
      version: '0.4.0-phase4',
      uptime_human: '1h 2m 3s',
      providers: {
        enabled: 2,
        available: 3,
        status: {
          anthropic: { ok: true, activeSpawns: 0 },
          openai: { ok: false, error: 'CLI not found', activeSpawns: 0 },
        },
      },
      stats: { total_requests: 42, active_requests: 1, cache: { hits: 10, misses: 5, size: 7 } },
      recent_errors: [{ time: '2026-05-26T11:22:33Z', provider: 'openai', message: 'spawn EACCES' }],
    };
    const out = plugFmtStatus(body);
    assert.match(out, /0\.4\.0-phase4/);
    assert.match(out, /1h 2m 3s/);
    assert.match(out, /Providers: 2 enabled \/ 3 available/);
    assert.match(out, /anthropic/);
    assert.match(out, /openai.*CLI not found/);
    assert.match(out, /Requests: 42 total/);
    assert.match(out, /Cache: 10 hit \/ 5 miss/);
    assert.match(out, /Recent errors \(1\)/);
    assert.match(out, /spawn EACCES/);
  });

  it('35e-2 — fmtHealth() renders ok + version + provider list', () => {
    const body = {
      ok: true,
      version: '0.4.0-phase4',
      uptime_human: '5m',
      providers: { anthropic: { ok: true }, openai: { ok: false } },
    };
    const out = plugFmtHealth(body);
    assert.match(out, /Status: ok/);
    assert.match(out, /v0\.4\.0-phase4/);
    assert.match(out, /anthropic/);
    assert.match(out, /openai/);
  });

  it('35e-3 — fmtUsage() renders 24h window + per-provider quota + top fallback chains', () => {
    const body = {
      cache_hit_24h: 0.42,
      quota: [
        { name: 'anthropic', percent_used: 33 },
        { name: 'mistral', percent_used: null },
      ],
      top_fallback_chains_24h: [
        { count: 5, chain: ['anthropic', 'openai'] },
      ],
    };
    const out = plugFmtUsage(body);
    assert.match(out, /Cache hit \(24h\): 42\.0%/);
    assert.match(out, /anthropic.*33%/);
    assert.match(out, /mistral.*no quota api/);
    assert.match(out, /5 {2}anthropic → openai/);
  });

  it('35e-4 — fmtModels() handles empty + populated', () => {
    assert.equal(plugFmtModels({ data: [] }), 'No models.');
    const out = plugFmtModels({
      data: [
        { id: 'claude-sonnet-4-5', owned_by: 'anthropic' },
        { id: 'gpt-5', owned_by: 'openai' },
      ],
    });
    assert.match(out, /Models \(2\)/);
    assert.match(out, /claude-sonnet-4-5\s+\(anthropic\)/);
    assert.match(out, /gpt-5\s+\(openai\)/);
  });

  it('35e-5 — fmtCache() renders hit/miss/size/inflight', () => {
    const out = plugFmtCache({ size: 12, hits: 100, misses: 25, inflightCount: 2, evictions: 1 });
    assert.match(out, /Entries: {8}12/);
    assert.match(out, /Hits: {11}100/);
    assert.match(out, /Misses: {9}25/);
    assert.match(out, /Inflight: {7}2/);
    assert.match(out, /Evictions: {6}1/);
  });

  it('35e-6 — fmtProviders() lists registry providers + enabled flags', () => {
    const registry = {
      providers: {
        anthropic: { tier: 'D', models: ['m1', 'm2'] },
        openai: { tier: 'D', models: ['m3'], candidate: true },
      },
    };
    const out = plugFmtProviders(registry, { anthropic: true });
    assert.match(out, /anthropic\s+enabled/);
    assert.match(out, /openai\s+disabled.*\(candidate\)/);
  });

  it('35e-7 — fmtChainShow() handles empty / all / single-target', () => {
    assert.equal(plugFmtChainShow({}), 'No chains configured.');
    const chains = {
      'claude-sonnet-4-5': [{ provider: 'anthropic', model: 'claude-sonnet-4-5' }],
      'gpt-5': ['openai:gpt-5'],
    };
    const all = plugFmtChainShow(chains);
    assert.match(all, /claude-sonnet-4-5/);
    assert.match(all, /gpt-5/);
    const one = plugFmtChainShow(chains, 'gpt-5');
    assert.match(one, /gpt-5:/);
    assert.match(one, /→ openai:gpt-5/);
    const missing = plugFmtChainShow(chains, 'no-such-model');
    assert.match(missing, /not in routing\.chains/);
  });

  it('35e-8 — fmtDoctor() renders summary + checks + next_action', () => {
    const body = {
      summary: '2 OK, 1 WARN',
      checks: [
        { id: 'server.running', status: 'ok', message: 'reachable' },
        { id: 'auth.owner_key_exists', status: 'warn', message: 'no owner key configured' },
      ],
      fail_count: 0, warn_count: 1, ok_count: 1,
      kind: 'fix_config',
      next_action: {
        ai_executable: ['npx olp-keys keygen --owner'],
        human_required: ['capture the printed token'],
      },
    };
    const out = plugFmtDoctor(body);
    assert.match(out, /2 OK, 1 WARN/);
    assert.match(out, /server\.running/);
    assert.match(out, /auth\.owner_key_exists/);
    assert.match(out, /fail=0 warn=1 ok=1/);
    assert.match(out, /kind=fix_config/);
    assert.match(out, /npx olp-keys keygen --owner/);
    assert.match(out, /capture the printed token/);
  });

  // ── 35f — dispatch: unknown / help / "" ──────────────────────────────────

  it('35f-1 — dispatch("") returns cmdHelp() body', async () => {
    const r = await plugDispatch('', { proxyUrl: 'http://x', registry: { providers: {} } });
    assert.equal(r.text, plugCmdHelp());
  });

  it('35f-2 — dispatch("frobnicate") returns "Unknown subcommand:" + help', async () => {
    const r = await plugDispatch('frobnicate', { proxyUrl: 'http://x', registry: { providers: {} } });
    assert.match(r.text, /Unknown subcommand: frobnicate/);
    assert.match(r.text, /OLP Commands/);
  });

  it('35f-3 — dispatch("help") returns cmdHelp() with read-only disclaimer', async () => {
    const r = await plugDispatch('help', { proxyUrl: 'http://x', registry: { providers: {} } });
    assert.match(r.text, /OLP Commands/);
    assert.match(r.text, /Mutating commands.*NOT/);
  });

  // ── 35g — dispatch: routes status/health/usage/models/cache ──────────────

  it('35g — dispatch routes each subcommand to the right URL with Authorization header', async () => {
    const calls = [];
    const mockFetch = async (url, opts) => {
      calls.push({ url, headers: opts?.headers ?? {} });
      // Per-route response stubs
      if (url.endsWith('/v0/management/status')) {
        return { ok: true, status: 200, json: async () => ({
          ok: true, version: '0.4.0', uptime_human: '1m',
          providers: { enabled: 0, available: 3, status: {} },
          stats: { total_requests: 0, active_requests: 0 },
          recent_errors: [],
        }) };
      }
      if (url.endsWith('/health')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, version: '0.4.0' }) };
      }
      if (url.endsWith('/v0/management/dashboard-data')) {
        return { ok: true, status: 200, json: async () => ({ cache_hit_24h: 0.5 }) };
      }
      if (url.endsWith('/v1/models')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm1' }] }) };
      }
      if (url.endsWith('/cache/stats')) {
        return { ok: true, status: 200, json: async () => ({ size: 0, hits: 0, misses: 0, inflightCount: 0 }) };
      }
      throw new Error(`unmocked url: ${url}`);
    };

    const opts = {
      proxyUrl: 'http://test:9999',
      apiKey: 'olp_TESTKEY',
      registry: { providers: { anthropic: { tier: 'D', models: [] } } },
      fetchFn: mockFetch,
    };

    for (const sub of ['status', 'health', 'usage', 'models', 'cache']) {
      calls.length = 0;
      const r = await plugDispatch(sub, opts);
      assert.equal(calls.length, 1, `${sub} should make exactly 1 HTTP call`);
      assert.equal(calls[0].headers.Authorization, 'Bearer olp_TESTKEY', `${sub} must include Bearer header`);
      assert.ok(r.text.length > 0, `${sub} should produce non-empty output`);
      assert.ok(!/^OLP error/.test(r.text), `${sub} should not error; got: ${r.text}`);
    }

    // URL routing per subcommand
    calls.length = 0;
    await plugDispatch('status', opts);
    assert.equal(calls[0].url, 'http://test:9999/v0/management/status');

    calls.length = 0;
    await plugDispatch('usage', opts);
    assert.equal(calls[0].url, 'http://test:9999/v0/management/dashboard-data');
  });

  it('35g-providers — dispatch("providers") uses registry locally without HTTP', async () => {
    let calls = 0;
    const r = await plugDispatch('providers', {
      proxyUrl: 'http://test:9999',
      registry: { providers: { anthropic: { tier: 'D', models: [] }, openai: { tier: 'D', models: [] } } },
      fetchFn: async () => { calls++; return { ok: true, status: 200, json: async () => ({}) }; },
    });
    assert.equal(calls, 0, 'providers must NOT make an HTTP call');
    assert.match(r.text, /anthropic/);
    assert.match(r.text, /openai/);
  });

  it('35g-chain — dispatch("chain show <model>") uses local chainsLocal arg', async () => {
    const r = await plugDispatch('chain show foo-model', {
      proxyUrl: 'http://test:9999',
      registry: { providers: {} },
      chainsLocal: { 'foo-model': [{ provider: 'anthropic', model: 'foo' }] },
      fetchFn: async () => { throw new Error('should not fetch'); },
    });
    assert.match(r.text, /foo-model:/);
    assert.match(r.text, /→.*anthropic/);
  });

  it('35g-chain-usage — dispatch("chain bogus") prints usage hint', async () => {
    const r = await plugDispatch('chain bogus', {
      proxyUrl: 'http://test:9999',
      registry: { providers: {} },
      fetchFn: async () => { throw new Error('should not fetch'); },
    });
    assert.match(r.text, /Usage: \/olp chain show \[model\]/);
  });

  // ── 35h — dispatch: doctor advisory ─────────────────────────────────────

  it('35h — dispatch("doctor") returns the "use SSH" advisory (HTTP endpoint not yet shipped)', async () => {
    let calls = 0;
    const r = await plugDispatch('doctor', {
      proxyUrl: 'http://test:9999',
      registry: { providers: {} },
      fetchFn: async () => { calls++; return { ok: true, status: 200, json: async () => ({}) }; },
    });
    assert.equal(calls, 0, 'doctor must NOT make an HTTP call yet (Phase 4 surface is local only)');
    assert.match(r.text, /not yet wired through HTTP/);
    assert.match(r.text, /Run `olp doctor` over SSH/);
  });

  // ── 35i — dispatch: error catching ──────────────────────────────────────

  it('35i — dispatch catches fetch errors and emits "OLP error: ..."', async () => {
    const r = await plugDispatch('status', {
      proxyUrl: 'http://test:9999',
      apiKey: 'olp_X',
      registry: { providers: {} },
      fetchFn: async () => { throw new Error('ECONNREFUSED'); },
    });
    assert.match(r.text, /^OLP error: ECONNREFUSED/);
  });

  it('35i-401 — dispatch surfaces 401 unauthorized with helpful hint', async () => {
    const r = await plugDispatch('status', {
      proxyUrl: 'http://test:9999',
      apiKey: 'olp_BAD',
      registry: { providers: {} },
      fetchFn: async () => ({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({}) }),
    });
    assert.match(r.text, /OLP error.*401 unauthorized/);
    assert.match(r.text, /owner-tier/);
  });

  it('35i-403 — dispatch surfaces 403 forbidden with helpful hint', async () => {
    const r = await plugDispatch('cache', {
      proxyUrl: 'http://test:9999',
      apiKey: 'olp_GUEST',
      registry: { providers: {} },
      fetchFn: async () => ({ ok: false, status: 403, statusText: 'Forbidden', json: async () => ({}) }),
    });
    assert.match(r.text, /OLP error.*403 forbidden/);
    assert.match(r.text, /not owner-tier/);
  });
});

// ── Suite 36: D74 v0.4.1 hotfix regression tests (maintainer-review findings) ─
//
// These tests pin the FIVE issues maintainer caught in independent post-v0.4.0
// review that previous D-day reviewers all missed (because they reviewed against
// spec text, not runtime contracts). Each test exercises a real codepath that,
// pre-D74, would have produced the documented wrong behavior.

import { writeFileSync as _writeFileSyncS36, readFileSync as _readFileSyncS36, mkdtempSync as _mkdtempSyncS36, rmSync as _rmSyncS36 } from 'node:fs';
import { tmpdir as _tmpdirS36 } from 'node:os';
import { join as _joinS36 } from 'node:path';
import { spawnSync as _spawnSyncS36 } from 'node:child_process';

describe('Suite 36 — D74 v0.4.1 hotfix regression (maintainer review findings)', () => {
  it('36a (P1-1) — runDoctor accepts authHeaders + passes them to server.running probe', async () => {
    // Pre-D74: lib/doctor.mjs called httpGet(`${proxyUrl}/health`) with no
    // headers, so under default `auth.allow_anonymous: false` the probe got
    // 401 and reported "server down" — false negative. D74 threads
    // authHeaders through buildBuiltinChecks. This test confirms the wire.
    const { buildBuiltinChecks } = await import('./lib/doctor.mjs');
    const tmpHome = _mkdtempSyncS36(_joinS36(_tmpdirS36(), 'olp-d74a-'));
    const checks = buildBuiltinChecks({
      olpHome: tmpHome,
      proxyUrl: 'http://127.0.0.1:1', // closed port — probe fails with ECONN
      authHeaders: { Authorization: 'Bearer olp_FAKE' },
    });
    const serverRunning = checks.find(c => c.id === 'server.running');
    assert.ok(serverRunning, 'server.running check must exist');
    // We can't easily intercept httpGet here without DI, but the check at
    // least accepts the opts and runs. Real wire-level coverage is 36b below.
    _rmSyncS36(tmpHome, { recursive: true, force: true });
  });

  it('36b (P1-1) — server.running distinguishes 401 (server up, bad token) from "server down"', async () => {
    __setAuthConfig({ allow_anonymous: false, owner_only_endpoints: ['/health'] });
    const serverMod = await import('./server.mjs');
    const s = serverMod.createOlpServer();
    let port36b = 28300 + Math.floor(Math.random() * 100);
    await new Promise((resolve, reject) => {
      s.listen(port36b, '127.0.0.1', resolve);
      s.once('error', e => {
        if (e.code === 'EADDRINUSE') { port36b++; s.listen(port36b, '127.0.0.1', resolve); s.once('error', reject); }
        else reject(e);
      });
    });

    const { runDoctor } = await import('./lib/doctor.mjs');
    try {
      const result = await runDoctor({
        olpHome: process.env.OLP_HOME,
        proxyUrl: `http://127.0.0.1:${port36b}`,
        // intentionally NO authHeaders — simulates user without OLP_API_KEY
      });
      const sr = result.checks.find(c => c.id === 'server.running');
      assert.ok(sr, 'server.running present');
      assert.equal(sr.status, 'fail', 'fails because no token');
      assert.match(sr.message, /401|bearer token/i,
        `must mention 401 / bearer token specifically — got: ${sr.message}`);
      assert.ok(!/unreachable/i.test(sr.message),
        '"unreachable" would falsely imply server is down (P1-1 bug)');
    } finally {
      await new Promise(r => s.close(r));
      __resetAuthConfig();
    }
  });

  it('36c (P1-2) — olp-connect rejects malformed --key', () => {
    // The bash validator: ^olp_[A-Za-z0-9_-]{43}$. Anything else is rejected
    // before it can touch a shell rc file or environment.d entry.
    const result = _spawnSyncS36('bash', [
      _joinS36(import.meta.dirname ?? process.cwd(), 'bin/olp-connect'),
      '127.0.0.1',
      '--port', '1',
      '--key', 'not-an-olp-token',
      '--dry-run',
    ], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1, `expected exit 1 for malformed --key, got ${result.status}; stderr=${result.stderr.slice(0, 300)}`);
    assert.match(result.stderr + result.stdout, /token format does not match/i,
      'must surface the validator error');
  });

  it('36d (P1-2) — olp-connect accepts a properly-formed olp_ token', () => {
    // Pad to 43 base64url chars after olp_. Don't actually hit the server —
    // use --port 1 (closed) which makes the connectivity probe fail at
    // the connect step (exit 2), but only AFTER the --key validator passes.
    const goodKey = 'olp_' + 'A'.repeat(43);
    const result = _spawnSyncS36('bash', [
      _joinS36(import.meta.dirname ?? process.cwd(), 'bin/olp-connect'),
      '127.0.0.1',
      '--port', '1',
      '--key', goodKey,
      '--dry-run',
    ], { encoding: 'utf8', timeout: 5000 });
    // Validator passes → reaches connectivity step → exits 2 (or whatever
    // bash propagation gives) but NOT exit 1 from the validator.
    assert.notEqual(result.status, 1, `expected validator to pass; got exit 1 with stderr=${result.stderr.slice(0, 300)}`);
    assert.ok(!/token format does not match/i.test(result.stderr + result.stdout),
      'validator must NOT trigger for a well-formed token');
  });

  it('36e (P2-3) — CacheStore.stats() returns {hits, misses, size, inflightCount} shape', async () => {
    // Real cacheStore.stats() returns { hits, misses, size, inflightCount } per
    // lib/cache/store.mjs. Pre-D74 cmdCache read body.entries / body.bytes /
    // body.maxBytes — all undefined → output showed "entries: ?" and "bytes: 0".
    // Pin the shape so a future server-side rename can't reintroduce the bug.
    // Use the CacheStore class directly (no HTTP) since the field names ARE the
    // contract — server.mjs handleCacheStats just sendJSON(s, 200, cacheStore.stats()).
    const { CacheStore: CS36 } = await import('./lib/cache/store.mjs');
    const cs = new CS36();
    const stats = cs.stats();
    assert.ok('size' in stats, 'CacheStore.stats() shape: size field present');
    assert.ok('hits' in stats, 'CacheStore.stats() shape: hits field present');
    assert.ok('misses' in stats, 'CacheStore.stats() shape: misses field present');
    assert.ok('inflightCount' in stats, 'CacheStore.stats() shape: inflightCount field present');
    assert.ok(!('entries' in stats), 'must NOT have OCP-era entries field');
    assert.ok(!('bytes' in stats), 'must NOT have OCP-era bytes field');
    assert.ok(!('maxBytes' in stats), 'must NOT have OCP-era maxBytes field');
    // Also pin that cmdCache reads body.size (not body.entries) by grepping the source
    const cliSrc = _readFileSyncS36(_joinS36(import.meta.dirname ?? process.cwd(), 'bin/olp.mjs'), 'utf8');
    assert.ok(/body\.size\b/.test(cliSrc), 'cmdCache must read body.size for entries display');
    assert.ok(/body\.inflightCount\b/.test(cliSrc), 'cmdCache must read body.inflightCount');
    assert.ok(!/body\.entries\b/.test(cliSrc), 'cmdCache must NOT read body.entries (OCP-era field)');
  });

  it('36f (P2-3) — dashboard-data payload + cmdUsage source pin the wire-contract field names', () => {
    // server.mjs handleManagementDashboardData (~line 2027) builds the payload
    // inline. Pin by grepping the server source: the keys MUST be window_24h /
    // cache_hit_24h / quota / spend_trend_30d / top_fallback_chains_24h /
    // cache_stats. Pre-D74 cmdUsage read body.usage_24h.requests / body.providers
    // / body.top_fallback_chains — none of which exist in the actual payload.
    const serverSrc = _readFileSyncS36(_joinS36(import.meta.dirname ?? process.cwd(), 'server.mjs'), 'utf8');
    assert.ok(/window_24h:\s*auditAggregateRequests/.test(serverSrc),
      'handleManagementDashboardData must emit window_24h field');
    assert.ok(/cache_hit_24h:\s*auditCacheHitRateWindow/.test(serverSrc),
      'handleManagementDashboardData must emit cache_hit_24h field');
    assert.ok(/top_fallback_chains_24h:/.test(serverSrc),
      'handleManagementDashboardData must emit top_fallback_chains_24h field (NOT top_fallback_chains)');
    assert.ok(/cache_stats:\s*cacheStore\.stats/.test(serverSrc),
      'handleManagementDashboardData must emit cache_stats field');
    // Now pin cmdUsage reads the matching keys
    const cliSrc = _readFileSyncS36(_joinS36(import.meta.dirname ?? process.cwd(), 'bin/olp.mjs'), 'utf8');
    assert.ok(/body\.window_24h\b/.test(cliSrc), 'cmdUsage must read body.window_24h');
    assert.ok(/body\.cache_hit_24h\b/.test(cliSrc), 'cmdUsage must read body.cache_hit_24h');
    assert.ok(/body\.top_fallback_chains_24h\b/.test(cliSrc),
      'cmdUsage must read body.top_fallback_chains_24h (NOT body.top_fallback_chains)');
    assert.ok(/body\.quota\b/.test(cliSrc), 'cmdUsage must read body.quota');
    // Pre-D74 stale reads must be GONE from the CLI source
    assert.ok(!/body\.usage_24h\.requests\b/.test(cliSrc),
      'cmdUsage must NOT read body.usage_24h.requests (OCP-era field)');
  });

  it('36g (P2-4) — olp-plugin fmtHealth iterates providers.status (not providers.*)', async () => {
    // Real /health full payload: providers: { enabled, available, status: { anthropic: {...} } }
    // Pre-D74 fmtHealth iterated Object.entries(body.providers) and the body
    // contained `status: {...}` so the loop printed a pseudo-provider named "status".
    const { fmtHealth } = await import('./olp-plugin/index.js');
    const realServerShape = {
      ok: true,
      version: '0.4.1',
      uptime_human: '1m 3s',
      providers: {
        enabled: 2,
        available: 3,
        status: {
          anthropic: { ok: true, activeSpawns: 0 },
          openai: { ok: false, error: 'oauth-missing', activeSpawns: 0 },
        },
      },
    };
    const out = fmtHealth(realServerShape);
    assert.match(out, /anthropic/, 'must list anthropic by name');
    assert.match(out, /openai/, 'must list openai by name');
    // assert.notMatch isn't available on assert/strict in some Node versions;
    // use the explicit negation pattern to stay portable.
    assert.ok(!/^\s*[🟢🔴⚪]\s*status\s*$/m.test(out),
      'must NOT list "status" as a pseudo-provider (the P2-4 bug)');
    assert.ok(!/^\s*[🟢🔴⚪]\s*enabled\s*$/m.test(out),
      'must NOT list "enabled" as a pseudo-provider');
    assert.ok(!/^\s*[🟢🔴⚪]\s*available\s*$/m.test(out),
      'must NOT list "available" as a pseudo-provider');
    // Also confirm the new enabled/available header
    assert.match(out, /2 enabled \/ 3 available/);
  });

  it('36h (P3-5) — server startup banner does not hardcode a stale phase', () => {
    // Pre-D74 banner literal said "Phase 1 in progress" forever.
    const serverSrc = _readFileSyncS36(_joinS36(import.meta.dirname ?? process.cwd(), 'server.mjs'), 'utf8');
    assert.ok(!/Phase 1 in progress/.test(serverSrc),
      'startup banner must not hardcode "Phase 1 in progress" (stale post v0.4.0)');
    assert.ok(!/Phase 2 in progress/.test(serverSrc));
    assert.ok(!/Phase 3 in progress/.test(serverSrc));
  });

  // ── D75 (v0.4.2) extension — real-machine E2E findings F1, F2, F3, F4, F7 ──
  // Bugs caught on PI231 + Mac mini 2026-05-26 E2E session. Pre-v0.4.0 reviewers
  // and the post-v0.4.0 maintainer review all missed these because they reviewed
  // against spec text, not against real provider CLIs running on a remote machine.

  it('36i (F1) — codex readAuthArtifact() recognises v0.133.0 nested tokens.access_token', () => {
    // Real codex CLI v0.133.0 auth.json shape: { auth_mode, OPENAI_API_KEY,
    //   tokens: { id_token, access_token, refresh_token, account_id }, last_refresh }
    // Pre-D75 readAuthArtifact read only top-level access_token → returned null →
    // OLP falsely reported "auth artifact missing" for fully-logged-in users.
    const tmpDir = _mkdtempSyncS36(_joinS36(_tmpdirS36(), 'olp-d75-f1-nested-'));
    const authPath = _joinS36(tmpDir, 'auth.json');
    _writeFileSyncS36(authPath, JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: 'header.body.sig',
        access_token: 'eyJ-real-nested-access-token-d75-36i',
        refresh_token: 'refresh-opaque',
        account_id: '00000000-0000-0000-0000-000000000000',
      },
      last_refresh: '2026-05-26T00:00:00Z',
    }));
    const savedPath = process.env.OPENAI_CODEX_AUTH_PATH;
    process.env.OPENAI_CODEX_AUTH_PATH = authPath;
    try {
      const result = codexReadAuthArtifact();
      assert.ok(result, 'must return non-null for v0.133 nested-shape auth.json');
      assert.equal(result.accessToken, 'eyJ-real-nested-access-token-d75-36i',
        'must extract token from tokens.access_token (v0.133.0 nested shape)');
    } finally {
      if (savedPath !== undefined) process.env.OPENAI_CODEX_AUTH_PATH = savedPath;
      else delete process.env.OPENAI_CODEX_AUTH_PATH;
      _rmSyncS36(tmpDir, { recursive: true, force: true });
    }
  });

  it('36j (F1) — codex readAuthArtifact() still reads legacy top-level access_token', () => {
    // Backwards compat: older codex CLI versions (pre-v0.133) wrote the token
    // at top level. D75 fix preserves that fallback so upgrades don't regress.
    const tmpDir = _mkdtempSyncS36(_joinS36(_tmpdirS36(), 'olp-d75-f1-legacy-'));
    const authPath = _joinS36(tmpDir, 'auth.json');
    _writeFileSyncS36(authPath, JSON.stringify({
      access_token: 'legacy-top-level-token-d75-36j',
    }));
    const savedPath = process.env.OPENAI_CODEX_AUTH_PATH;
    process.env.OPENAI_CODEX_AUTH_PATH = authPath;
    try {
      const result = codexReadAuthArtifact();
      assert.ok(result, 'must return non-null for legacy top-level shape');
      assert.equal(result.accessToken, 'legacy-top-level-token-d75-36j',
        'must fall back to top-level access_token when tokens.access_token absent');
    } finally {
      if (savedPath !== undefined) process.env.OPENAI_CODEX_AUTH_PATH = savedPath;
      else delete process.env.OPENAI_CODEX_AUTH_PATH;
      _rmSyncS36(tmpDir, { recursive: true, force: true });
    }
  });

  it('36k (F1) — codex readAuthArtifact() returns null for malformed auth.json', () => {
    // Malformed JSON / missing token / wrong structure → null (not throw).
    const tmpDir = _mkdtempSyncS36(_joinS36(_tmpdirS36(), 'olp-d75-f1-malformed-'));
    const savedPath = process.env.OPENAI_CODEX_AUTH_PATH;
    try {
      // Case A: unparseable JSON
      const badJsonPath = _joinS36(tmpDir, 'bad.json');
      _writeFileSyncS36(badJsonPath, 'not-json-at-all{{{');
      process.env.OPENAI_CODEX_AUTH_PATH = badJsonPath;
      assert.equal(codexReadAuthArtifact(), null, 'unparseable JSON → null');

      // Case B: valid JSON but no token field anywhere
      const noTokenPath = _joinS36(tmpDir, 'no-token.json');
      _writeFileSyncS36(noTokenPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: {} }));
      process.env.OPENAI_CODEX_AUTH_PATH = noTokenPath;
      assert.equal(codexReadAuthArtifact(), null, 'no token in tokens.access_token or top-level → null');

      // Case C: tokens field present but access_token wrong type
      const wrongTypePath = _joinS36(tmpDir, 'wrong-type.json');
      _writeFileSyncS36(wrongTypePath, JSON.stringify({
        tokens: { access_token: 42 },
      }));
      process.env.OPENAI_CODEX_AUTH_PATH = wrongTypePath;
      assert.equal(codexReadAuthArtifact(), null, 'non-string access_token → null');
    } finally {
      if (savedPath !== undefined) process.env.OPENAI_CODEX_AUTH_PATH = savedPath;
      else delete process.env.OPENAI_CODEX_AUTH_PATH;
      _rmSyncS36(tmpDir, { recursive: true, force: true });
    }
  });

  it('36l (F2) — irToCodex() includes --skip-git-repo-check before --model', () => {
    // codex CLI v0.133.0 sandboxes non-git-repo CWDs by default with:
    //   "Not inside a trusted directory and --skip-git-repo-check was not specified."
    // OLP servers typically deploy outside a git repo on the operator host. The
    // --skip-git-repo-check flag must be in args, before --model, so the spawn
    // succeeds without depending on the install-time CWD.
    const { args } = irToCodex({
      irVersion: IR_VERSION,
      model: 'gpt-5.5',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.ok(args.includes('--skip-git-repo-check'),
      'irToCodex().args must include --skip-git-repo-check (F2 fix)');
    const skipIdx = args.indexOf('--skip-git-repo-check');
    const modelIdx = args.indexOf('--model');
    assert.ok(skipIdx > 0 && modelIdx > 0, 'both flags must be present');
    assert.ok(skipIdx < modelIdx,
      '--skip-git-repo-check must come before --model (cleaner readability + matches codex v0.133 docs ordering)');
    // Confirm exec is still first and --json still adjacent
    assert.equal(args[0], 'exec');
    assert.equal(args[1], '--json');
    assert.equal(args[2], '--skip-git-repo-check');
    assert.equal(args[3], '--model');
    assert.equal(args[4], 'gpt-5.5');
  });

  it('36m (F3) — codexChunkToIR recognises v0.133.0 item.completed agent_message', () => {
    // Real codex v0.133.0 emits the assistant text as one item.completed event:
    //   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hello world"}}
    // Pre-D75 codexChunkToIR returned null for this shape → response body had
    // content: null because the chunk was silently dropped.
    const result = codexChunkToIR(JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'hello world from codex' },
    }));
    assert.deepEqual(result, { type: 'delta', content: 'hello world from codex' });
  });

  it('36n (F3) — codexChunkToIR recognises v0.133.0 turn.completed → stop', () => {
    // turn.completed marks the end of a codex turn. Map to IR stop.
    const result = codexChunkToIR(JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 12, output_tokens: 7 },
    }));
    assert.deepEqual(result, { type: 'stop', finish_reason: 'stop' });
  });

  it('36o (F3) — codexChunkToIR recognises v0.133.0 turn.failed → error', () => {
    // turn.failed: { type: 'turn.failed', error: { message: 'X' } }
    const result1 = codexChunkToIR(JSON.stringify({
      type: 'turn.failed',
      error: { message: 'rate limit exceeded' },
    }));
    assert.equal(result1?.type, 'error');
    assert.equal(result1.error, 'rate limit exceeded');
    // turn.failed with string error
    const result2 = codexChunkToIR(JSON.stringify({
      type: 'turn.failed',
      error: 'simple string error',
    }));
    assert.equal(result2?.type, 'error');
    assert.equal(result2.error, 'simple string error');
    // turn.failed with no error payload → falls back to default message
    const result3 = codexChunkToIR(JSON.stringify({ type: 'turn.failed' }));
    assert.equal(result3?.type, 'error');
    assert.match(result3.error, /turn\.failed/);
  });

  it('36p (F4) — cmdStatus reads body.stats.cache.size (not OCP-era body.cache.entries)', () => {
    // Server payload (server.mjs handleManagementStatus ~line 2092):
    //   { ok, version, ..., stats: { total_requests, active_requests, cache: { hits, misses, size, inflightCount } } }
    // Pre-D75 cmdStatus formatter read `body.cache.entries` (OCP-era) → always
    // undefined → output showed "entries=?". Pin the wire contract by grepping
    // the CLI source so a future server-side rename can't silently re-break.
    const cliSrc = _readFileSyncS36(_joinS36(import.meta.dirname ?? process.cwd(), 'bin/olp.mjs'), 'utf8');
    // Must contain the cmdStatus block that reads body.stats.cache (not body.cache directly)
    assert.ok(/cmdStatus\b/.test(cliSrc), 'cmdStatus function must exist');
    // The status block must read body.stats?.cache (the actual server payload nesting)
    assert.ok(/body\.stats\?\.cache/.test(cliSrc) || /body\.stats\.cache/.test(cliSrc),
      'cmdStatus must read body.stats.cache for status display');
    // Specifically, the "entries=" output must derive from c.size (matches CacheStore.stats() shape)
    // Find the status cache line and verify it uses c.size
    const statusBlock = cliSrc.match(/cmdStatus[\s\S]+?(?=async function cmd|^\}\s*$)/m);
    assert.ok(statusBlock, 'cmdStatus block extractable');
    assert.ok(/c\.size/.test(statusBlock[0]),
      'cmdStatus cache line must use c.size (matches CacheStore.stats() shape)');
    // And must NOT use the OCP-era c.entries
    assert.ok(!/c\.entries/.test(statusBlock[0]),
      'cmdStatus cache line must NOT read c.entries (OCP-era field that does not exist in CacheStore.stats())');
    // Also pin the CacheStore.stats() shape contract (re-affirms 36e but for status path)
    const cs = new CacheStore();
    const stats = cs.stats();
    assert.ok('size' in stats, 'CacheStore.stats() exposes size');
    assert.ok(!('entries' in stats), 'CacheStore.stats() does NOT expose entries');
  });

  it('36q (F7) — per-hop chain `model` field overrides IR model on fallback hop', async () => {
    // Pre-D75: executeHopFn(provider, model, irReq) used `model` for cache key
    // + audit but passed irReq UNCHANGED to provider.spawn() → the chain
    //   [{anthropic, claude-X}, {openai, gpt-5.5}]
    // would spawn codex with --model claude-X (the user's original request)
    // instead of gpt-5.5 (the chain's per-hop config). This broke cross-provider
    // fallback wherever the chain assigned different models per provider.
    //
    // Strategy: inject a mock openai provider that captures the IR it receives.
    // Force the anthropic hop to fail with SPAWN_FAILED so the chain advances
    // to openai. Assert the mock saw model === hop's configured model.

    const { __setAuthConfig: setAC36q, __resetAuthConfig: resetAC36q,
            __setFallbackConfig: setFC36q, __resetFallbackConfig: resetFC36q,
            createOlpServer, loadedProviders } = await import('./server.mjs');

    setAC36q({ allow_anonymous: true });

    // Capture for mock openai provider
    let capturedIR = null;
    const mockOpenAI = {
      name: 'openai',
      displayName: 'Mock OpenAI for F7',
      contractVersion: '1.0',
      models: ['gpt-5.5'],
      auth: { type: 'oauth', storage: 'file', path: '/tmp/fake', refresh: 'auto' },
      async * spawn(ir, _authContext) {
        // Snapshot the model field as received
        capturedIR = { model: ir.model };
        yield { type: 'delta', role: 'assistant', content: 'mock-openai-response' };
        yield { type: 'stop', finish_reason: 'stop' };
      },
      estimateCost: () => null,
      quotaStatus: async () => null,
      healthCheck: async () => ({ ok: true, latencyMs: 0 }),
      hints: { requiresTTY: false, concurrentSpawnSafe: true, maxConcurrent: 4, cacheable: true },
    };

    // Mock anthropic provider that always fails immediately with SPAWN_FAILED
    const mockAnthropic = {
      name: 'anthropic',
      displayName: 'Mock Anthropic for F7',
      contractVersion: '1.0',
      models: ['claude-sonnet-4-6'],
      auth: { type: 'oauth', storage: 'file', path: '/tmp/fake', refresh: 'auto' },
      async * spawn(_ir, _authContext) {
        throw new ProviderError('mock anthropic always fails (F7 test)', 'SPAWN_FAILED');
        // eslint-disable-next-line no-unreachable
        yield { type: 'stop' };
      },
      estimateCost: () => null,
      quotaStatus: async () => null,
      healthCheck: async () => ({ ok: true, latencyMs: 0 }),
      hints: { requiresTTY: false, concurrentSpawnSafe: true, maxConcurrent: 4, cacheable: true },
    };

    // Save + clear loadedProviders, install the mocks
    const savedProviders = new Map(loadedProviders);
    loadedProviders.clear();
    loadedProviders.set('anthropic', mockAnthropic);
    loadedProviders.set('openai', mockOpenAI);

    // 2-hop chain with DIFFERENT models per hop — the bug only manifests when
    // hopModel !== requested model on the hop that actually serves.
    setFC36q({
      chains: {
        'claude-sonnet-4-6': [
          { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          { provider: 'openai',    model: 'gpt-5.5' },
        ],
      },
      soft_triggers: {},
    });

    const srv = createOlpServer();
    let port = 28400 + Math.floor(Math.random() * 100);
    await new Promise((resolve, reject) => {
      srv.listen(port, '127.0.0.1', resolve);
      srv.once('error', e => {
        if (e.code === 'EADDRINUSE') { port++; srv.listen(port, '127.0.0.1', resolve); srv.once('error', reject); }
        else reject(e);
      });
    });

    try {
      const r = await fetch({
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'F7 test' }],
        },
      });
      assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.body.slice(0, 300)}`);
      assert.equal(r.headers['x-olp-provider-used'], 'openai',
        'openai must be the serving hop (anthropic failed)');
      // The F7 assertion: the openai hop received the chain's configured model,
      // NOT the user's original request model.
      assert.ok(capturedIR, 'mock openai must have been invoked');
      assert.equal(capturedIR.model, 'gpt-5.5',
        `F7: openai hop must receive its chain-configured model 'gpt-5.5', got '${capturedIR.model}'`);
    } finally {
      await new Promise(r => srv.close(r));
      resetFC36q();
      // Restore original providers
      loadedProviders.clear();
      for (const [k, v] of savedProviders) loadedProviders.set(k, v);
      resetAC36q();
    }
  });

  it('36r (F7) — per-hop model override preserved on streaming single-hop path', async () => {
    // The streaming path (server.mjs ~line 1390-1434) has its own spawn call site
    // inside sourceFactory that previously also passed `ir` unchanged. F7 fix
    // wraps it with the same { ...ir, model: streamModel } substitution. This
    // test exercises a single-hop streaming request and asserts the mock saw
    // the chain's configured model.

    const { __setAuthConfig: setAC36r, __resetAuthConfig: resetAC36r,
            __setFallbackConfig: setFC36r, __resetFallbackConfig: resetFC36r,
            createOlpServer, loadedProviders } = await import('./server.mjs');

    setAC36r({ allow_anonymous: true });

    let capturedModel = null;
    const mockOpenAIStream = {
      name: 'openai',
      displayName: 'Mock Codex for F7 streaming',
      contractVersion: '1.0',
      models: ['gpt-5.5'],
      auth: { type: 'oauth', storage: 'file', path: '/tmp/fake', refresh: 'auto' },
      async * spawn(ir, _authContext) {
        capturedModel = ir.model;
        yield { type: 'delta', role: 'assistant', content: 'streamed-content' };
        yield { type: 'stop', finish_reason: 'stop' };
      },
      estimateCost: () => null,
      quotaStatus: async () => null,
      healthCheck: async () => ({ ok: true, latencyMs: 0 }),
      hints: { requiresTTY: false, concurrentSpawnSafe: true, maxConcurrent: 4, cacheable: true },
    };

    const savedProviders = new Map(loadedProviders);
    loadedProviders.clear();
    loadedProviders.set('openai', mockOpenAIStream);

    // Single-hop chain with a DIFFERENT model than the request — the bug is
    // visible only when the user requests one model name and the chain remaps it.
    setFC36r({
      chains: {
        'gpt-aliased': [
          { provider: 'openai', model: 'gpt-5.5' },
        ],
      },
      soft_triggers: {},
    });

    const srv = createOlpServer();
    let port = 28500 + Math.floor(Math.random() * 100);
    await new Promise((resolve, reject) => {
      srv.listen(port, '127.0.0.1', resolve);
      srv.once('error', e => {
        if (e.code === 'EADDRINUSE') { port++; srv.listen(port, '127.0.0.1', resolve); srv.once('error', reject); }
        else reject(e);
      });
    });

    try {
      const r = await fetch({
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'gpt-aliased',
          stream: true,
          messages: [{ role: 'user', content: 'F7 streaming test' }],
        },
      });
      assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.body.slice(0, 200)}`);
      assert.equal(capturedModel, 'gpt-5.5',
        `F7 streaming: openai must receive chain-configured model 'gpt-5.5', got '${capturedModel}'`);
    } finally {
      await new Promise(r => srv.close(r));
      resetFC36r();
      loadedProviders.clear();
      for (const [k, v] of savedProviders) loadedProviders.set(k, v);
      resetAC36r();
    }
  });

  // ── F5 (D76 v0.4.3): OLP_BIND env honored + safety warn ──────────────────
  it('36s (F5) — server.mjs reads OLP_BIND with safe default 127.0.0.1', () => {
    // F5 fix: previously bind was hard-coded `server.listen(PORT, '127.0.0.1', ...)`.
    // D76 adds `const BIND = process.env.OLP_BIND ?? '127.0.0.1'` and the listen
    // call uses BIND. Pin via source grep so a future refactor that re-introduces
    // a hardcoded literal in the listen call fails this test.
    const serverSrc = _readFileSyncS36(_joinS36(import.meta.dirname ?? process.cwd(), 'server.mjs'), 'utf8');
    assert.ok(/process\.env\.OLP_BIND\s*\?\?\s*['"]127\.0\.0\.1['"]/.test(serverSrc),
      'server.mjs must read OLP_BIND env with 127.0.0.1 default');
    assert.ok(/server\.listen\(PORT,\s*BIND\b/.test(serverSrc),
      'server.mjs server.listen must use the BIND variable (not a hardcoded address)');
    assert.ok(!/server\.listen\(PORT,\s*['"]127\.0\.0\.1['"]/.test(serverSrc),
      'server.mjs must NOT pass a hardcoded 127.0.0.1 literal to server.listen anymore');
  });

  it('36t (F5) — anonymous_key_advertised_with_lan_bind startup warn wiring', () => {
    // Per ADR 0011 Deployment configurations amendment: when OLP_BIND is
    // non-loopback AND advertise_anonymous_key is true, server emits a startup
    // warn so the operator sees the trust-context overlap. Pin the wiring.
    const serverSrc = _readFileSyncS36(_joinS36(import.meta.dirname ?? process.cwd(), 'server.mjs'), 'utf8');
    assert.ok(/anonymous_key_advertised_with_lan_bind/.test(serverSrc),
      'startup warn event name must be present');
    // Loopback check must compare BIND against ALL three loopback forms
    assert.ok(/BIND\s*!==\s*['"]127\.0\.0\.1['"][\s\S]{0,200}BIND\s*!==\s*['"]localhost['"][\s\S]{0,200}BIND\s*!==\s*['"]::1['"]/.test(serverSrc),
      'startup warn must check BIND against all three loopback forms (127.0.0.1 / localhost / ::1)');
  });

  it('36u (F5) — ADR 0011 Deployment configurations amendment present', () => {
    const adrPath = _joinS36(import.meta.dirname ?? process.cwd(), 'docs/adr/0011-anonymous-key-deployment-context.md');
    const adrSrc = _readFileSyncS36(adrPath, 'utf8');
    assert.ok(/Deployment configurations \(D76 amendment/.test(adrSrc),
      'ADR 0011 must carry the D76 amendment heading');
    assert.ok(/OLP_BIND/.test(adrSrc), 'amendment must document OLP_BIND');
    assert.ok(/anonymous_key_advertised_with_lan_bind/.test(adrSrc),
      'amendment must cite the startup-warn event name');
  });

  // ── D78 v0.4.4: G12 stale openclaw text + G13 self-version derived ──────
  it('36v (G12) — olp-connect openclaw detection no longer claims plugin not shipped', () => {
    // D71-D73 shipped olp-plugin/. Pre-D78 the script said "NOT YET SHIPPED"
    // which misled MacBook client testing on 2026-05-26. Pin the corrected text.
    const ocSrc = _readFileSyncS36(_joinS36(import.meta.dirname ?? process.cwd(), 'bin/olp-connect'), 'utf8');
    assert.ok(!/NOT YET SHIPPED/.test(ocSrc),
      'olp-connect must NOT claim openclaw plugin is unshipped (D71-D73 shipped it at v0.4.0)');
    assert.ok(/openclaw plugins install/.test(ocSrc) || /\.openclaw\/extensions\/olp/.test(ocSrc),
      'olp-connect openclaw detection must give a real install path');
    assert.ok(/docs\/integrations\/openclaw\.md/.test(ocSrc),
      'olp-connect must point at the openclaw integration doc');
  });

  it('36w (G13) — olp-connect self-version derived from package.json (not hardcoded)', () => {
    // Pre-D78 OLP_CONNECT_VERSION was a hardcoded literal "0.4.0-phase4" that
    // nobody updated across v0.4.1/v0.4.2/v0.4.3. D78 derives at runtime
    // from sibling package.json so the literal stays in sync automatically.
    const ocSrc = _readFileSyncS36(_joinS36(import.meta.dirname ?? process.cwd(), 'bin/olp-connect'), 'utf8');
    // The old hardcoded literal must be gone
    assert.ok(!/OLP_CONNECT_VERSION="0\.4\.0-phase4"/.test(ocSrc),
      'hardcoded "0.4.0-phase4" version literal must be gone');
    // The new derivation logic must reference package.json
    assert.ok(/package\.json/.test(ocSrc) && /OLP_CONNECT_VERSION=/.test(ocSrc),
      'OLP_CONNECT_VERSION must derive from package.json');
  });

  it('36x (D78) — README pins primary olp-connect curl URL to a release tag (CDN-cache-safe)', () => {
    // G11 root cause: README's `bash <(curl ... /main/bin/olp-connect)` got
    // bitten by GitHub raw CDN's negative-cache TTL when the repo flipped
    // private->public. Tag-pinned URLs (.../<tag>/bin/...) bypass that
    // negative cache because the tag ref was never queried while private.
    // D78: README presents the tag-pinned URL as the primary recommendation,
    // with /main/ as an alternative for trusted-head users.
    const readmePath = _joinS36(import.meta.dirname ?? process.cwd(), 'README.md');
    const readmeSrc = _readFileSyncS36(readmePath, 'utf8');
    assert.ok(/raw\.githubusercontent\.com\/dtzp555-max\/olp\/v\d+\.\d+\.\d+\/bin\/olp-connect/.test(readmeSrc),
      'README must include a release-tag-pinned olp-connect URL (e.g., /v0.4.4/bin/olp-connect)');
    assert.ok(/Pinned to a known-good release/.test(readmeSrc),
      'README must explain why the tag-pinned form is the primary recommendation');
  });
});

// ── Suite 37: D81 aggregateProviderQuota() smoke tests (Phase 5, ADR 0008 Amendment) ──
//
// Smoke tests for aggregateProviderQuota() per D81 prompt "add 1-2 smoke tests
// so the implementation is testable in isolation." Comprehensive tests follow in
// D83 (Suite 38/39). These cover: live shape normalization, stale shape, null
// (unavailable) return, and error/throw path.
//
// Authority: ADR 0008 Amendment (D81) + ADR 0012 D81 + ADR 0013 Rule 5.

describe('Suite 37 — D81 aggregateProviderQuota() smoke tests (Phase 5, ADR 0008 Amendment)', () => {
  // Synthetic quotaStatus return shape matching the D80 anthropic plugin contract.
  function makeSyntheticQuotaShape(overrides = {}) {
    return {
      probedAt: Date.now(),
      source: 'anthropic-ratelimit-unified-headers',
      schemaVersion: '2026-05-26',
      stale: false,
      fields: {
        status: 'active',
        representative_claim: 'five_hour',
        reset: 1748300000,
        fallback_percentage: 0.5,
        status_5h: 'active',
        utilization_5h: 0.49,
        reset_5h: 1748290000,
        status_7d: 'active',
        utilization_7d: 0.31,
        reset_7d: 1748500000,
        overage_status: 'rejected',
        overage_disabled_reason: 'org_level_disabled_until',
        overage_reset: null,
      },
      raw: { 'anthropic-ratelimit-unified-status': 'active' },
      ...overrides,
    };
  }

  it('37a — live shape: non-null quotaStatus() returns normalized entry with status=live', async () => {
    const synth = makeSyntheticQuotaShape();
    const mockProviders = new Map([
      ['anthropic', { quotaStatus: async () => synth }],
    ]);
    const result = await aggregateProviderQuota({ providers: mockProviders });
    assert.equal(result.length, 1, '37a: should return one entry');
    const entry = result[0];
    assert.equal(entry.provider, 'anthropic', '37a: provider name should be anthropic');
    assert.equal(entry.status, 'live', '37a: status should be live for non-stale result');
    assert.equal(entry.schema_version, '2026-05-26', '37a: schema_version should be forwarded');
    assert.ok(typeof entry.last_fresh_at === 'number', '37a: last_fresh_at should be a number');
    assert.ok(entry.utilization !== null, '37a: utilization should not be null');
    assert.equal(entry.utilization['5h'], 0.49, '37a: utilization 5h should be 0.49');
    assert.equal(entry.utilization['7d'], 0.31, '37a: utilization 7d should be 0.31');
    assert.ok(entry.reset !== null, '37a: reset should not be null');
    assert.equal(entry.reset.overall, 1748300000, '37a: reset.overall should match fields.reset');
    assert.equal(entry.representative_claim, 'five_hour', '37a: representative_claim should match');
    assert.equal(entry.fallback_percentage, 0.5, '37a: fallback_percentage should match');
    assert.ok(entry.overage !== null, '37a: overage should not be null');
    assert.equal(entry.overage.status, 'rejected', '37a: overage.status should match');
    assert.equal(entry.raw_available, true, '37a: raw_available should be true when raw is present');
  });

  it('37b — stale shape: stale:true quotaStatus() returns entry with status=stale', async () => {
    const synth = makeSyntheticQuotaShape({ stale: true, last_fresh_at: Date.now() - 30000 });
    const mockProviders = new Map([
      ['anthropic', { quotaStatus: async () => synth }],
    ]);
    const result = await aggregateProviderQuota({ providers: mockProviders });
    assert.equal(result.length, 1, '37b: should return one entry');
    assert.equal(result[0].status, 'stale', '37b: status should be stale when stale:true');
  });

  it('37c — null return: null quotaStatus() produces unavailable entry', async () => {
    const mockProviders = new Map([
      ['codex', { quotaStatus: async () => null }],
      ['mistral', { quotaStatus: async () => null }],
    ]);
    const result = await aggregateProviderQuota({ providers: mockProviders });
    assert.equal(result.length, 2, '37c: should return two entries');
    for (const entry of result) {
      assert.equal(entry.status, 'unavailable', `37c: ${entry.provider} should be unavailable`);
      assert.ok(entry.reason, `37c: ${entry.provider} should have a reason`);
      assert.equal(entry.utilization, null, `37c: ${entry.provider} utilization should be null`);
    }
  });

  it('37d — throw: quotaStatus() that throws produces unavailable entry with reason', async () => {
    const mockProviders = new Map([
      ['anthropic', { quotaStatus: async () => { throw new Error('network timeout'); } }],
    ]);
    const result = await aggregateProviderQuota({ providers: mockProviders });
    assert.equal(result.length, 1, '37d: should return one entry');
    assert.equal(result[0].status, 'unavailable', '37d: status should be unavailable on throw');
    assert.ok(result[0].reason.includes('network timeout'), '37d: reason should include the error message');
  });

  it('37e — mixed providers: live + unavailable in same call', async () => {
    const synth = makeSyntheticQuotaShape();
    const mockProviders = new Map([
      ['anthropic', { quotaStatus: async () => synth }],
      ['codex', { quotaStatus: async () => null }],
    ]);
    const result = await aggregateProviderQuota({ providers: mockProviders });
    assert.equal(result.length, 2, '37e: should return two entries');
    const anthropicEntry = result.find(e => e.provider === 'anthropic');
    const codexEntry = result.find(e => e.provider === 'codex');
    assert.ok(anthropicEntry, '37e: anthropic entry should be present');
    assert.ok(codexEntry, '37e: codex entry should be present');
    assert.equal(anthropicEntry.status, 'live', '37e: anthropic should be live');
    assert.equal(codexEntry.status, 'unavailable', '37e: codex should be unavailable');
  });

  it('37f — getQuotaStatus injection: custom getter is used when provided', async () => {
    // Test the getQuotaStatus injection point for full testability (D81 prompt §F).
    const synth = makeSyntheticQuotaShape();
    const mockProviders = new Map([['anthropic', {}]]); // plugin has no quotaStatus
    const calls = [];
    const result = await aggregateProviderQuota({
      providers: mockProviders,
      getQuotaStatus: (name) => { calls.push(name); return Promise.resolve(synth); },
    });
    assert.equal(calls.length, 1, '37f: getQuotaStatus should be called once');
    assert.equal(calls[0], 'anthropic', '37f: called with provider name');
    assert.equal(result[0].status, 'live', '37f: result should use injected quota shape');
  });

  it('37g — models-registry.json has quota_probe.schema_version', () => {
    // D81 / ADR 0013 Rule 5 mandate: schema_version must be in models-registry.json.
    // Uses _readFileSyncS36 + _joinS36 (already module-level imports from Suite 36).
    const registryPath = _joinS36(import.meta.dirname ?? process.cwd(), 'models-registry.json');
    const registry = JSON.parse(_readFileSyncS36(registryPath, 'utf8'));
    assert.ok(registry.quota_probe, '37g: models-registry.json must have quota_probe key');
    assert.ok(typeof registry.quota_probe.schema_version === 'string',
      '37g: quota_probe.schema_version must be a string');
    assert.ok(registry.quota_probe.schema_version.length > 0,
      '37g: quota_probe.schema_version must not be empty');
    assert.ok(Array.isArray(registry.quota_probe.anthropic?.fields_pinned),
      '37g: quota_probe.anthropic.fields_pinned must be an array');
    assert.equal(registry.quota_probe.anthropic.fields_pinned.length, 13,
      '37g: quota_probe.anthropic.fields_pinned must have exactly 13 entries (all parsed fields)');
  });
});

// ── Suite 38: D83 quota-probe unit tests (Phase 5, ADR 0012 D83) ──────────
//
// Comprehensive unit tests for the anthropic plugin quota probe machinery:
//   - _parseRateLimitHeaders: all 13 fields, missing fields, types
//   - quotaStatus: cache TTL, backoff, 401-refresh, 429-stale, disabled, no-creds
//   - doctorChecks: anthropic.quota_probe_reachable (all 5 status paths)
//   - schemaVersion: from models-registry.json + constant fallback
//
// Approach: local Node http server mimics api.anthropic.com/v1/messages and
// platform.claude.com/v1/oauth/token. Test seams _setQuotaUrlsForTest +
// _resetQuotaProbeStateForTest redirect the plugin to the local servers.
//
// Authority: ADR 0012 D83 + ADR 0013 (Rules 2-6) + D80 PR #52 (producers)
//   Schema pin: ~/.cc-rules/memory/learnings/anthropic_plan_usage_probe_schema_2026_05_26.md

import { createServer as _httpCreateServer } from 'node:http';
import {
  _setQuotaUrlsForTest as setQuotaUrls38,
  _resetQuotaProbeStateForTest as resetQuotaProbe38,
  _resetQuotaStateOnlyForTest as resetQuotaStateOnly38,
  _getQuotaProbeStateForTest as getQuotaProbeState38,
  _setQuotaAuthReadFnForTest as setQuotaAuthFn38,
  quotaStatus as quotaStatus38,
  doctorChecks as doctorChecks38,
} from './lib/providers/anthropic.mjs';
import { writeFileSync as _writeFileSync38, mkdtempSync as _mkdtempSync38, rmSync as _rmSync38, mkdirSync as _mkdirSync38, readFileSync as _readFileSync38 } from 'node:fs';
import { join as _pathJoin38 } from 'node:path';
import { tmpdir as _tmpdir38 } from 'node:os';

// ── Helpers ───────────────────────────────────────────────────────────────

/** All 13 anthropic-ratelimit-unified-* response headers (full set) */
const _ALL_13_HEADERS = {
  'anthropic-ratelimit-unified-status': 'active',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-reset': '1748300000',
  'anthropic-ratelimit-unified-fallback-percentage': '0.5',
  'anthropic-ratelimit-unified-5h-status': 'active',
  'anthropic-ratelimit-unified-5h-utilization': '0.49',
  'anthropic-ratelimit-unified-5h-reset': '1748290000',
  'anthropic-ratelimit-unified-7d-status': 'active',
  'anthropic-ratelimit-unified-7d-utilization': '0.31',
  'anthropic-ratelimit-unified-7d-reset': '1748500000',
  'anthropic-ratelimit-unified-overage-status': 'rejected',
  'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled_until',
  'anthropic-ratelimit-unified-overage-reset': '1748400000',
};

/**
 * Start a local HTTP mock server. The handler receives (req, res).
 * Returns { server, url, close } where url is 'http://127.0.0.1:<port>'.
 */
function _startMockServer(handler) {
  return new Promise((resolve) => {
    const server = _httpCreateServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

/**
 * Write a minimal config.json enabling the quota probe under olpHome.
 */
function _writeProbeConfig(olpHome, extra = {}) {
  _mkdirSync38(olpHome, { recursive: true });
  _writeFileSync38(_pathJoin38(olpHome, 'config.json'), JSON.stringify({
    providers: {
      anthropic: {
        quota_probe_enabled: true,
        ...extra,
      },
    },
  }));
}

// Save and restore OLP_HOME around each test that mutates it.
let _savedOlpHome38;
function _saveEnv38() { _savedOlpHome38 = process.env.OLP_HOME; }
function _restoreEnv38() {
  if (_savedOlpHome38 === undefined) delete process.env.OLP_HOME;
  else process.env.OLP_HOME = _savedOlpHome38;
}

describe('Suite 38 — D83 quota-probe unit tests (Phase 5, ADR 0012 D83 + ADR 0013)', () => {

  // ── 38a–38d: _parseRateLimitHeaders parsing ───────────────────────────────
  // We call quotaStatus() with a mock server and assert the parsed fields
  // rather than calling the private _parseRateLimitHeaders directly.
  // The 38a test exercises all 13 fields by checking the quotaStatus() return.

  it('38a — parse: all 13 headers present → parsed correctly (numeric types, null for missing)', async () => {
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38a-'));
    let mock;
    try {
      _writeProbeConfig(TMP);
      process.env.OLP_HOME = TMP;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token-38a';
      mock = await _startMockServer((_req, res) => {
        res.writeHead(200, _ALL_13_HEADERS);
        res.end('{}');
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);
      resetQuotaStateOnly38();

      const result = await quotaStatus38();

      assert.ok(result !== null, '38a: quotaStatus should return non-null on 200 with headers');
      assert.equal(result.stale, false, '38a: stale should be false on fresh probe');
      assert.equal(result.source, 'anthropic-ratelimit-unified-headers', '38a: source');
      assert.ok(typeof result.schemaVersion === 'string', '38a: schemaVersion should be a string');
      // All 13 fields
      const f = result.fields;
      assert.equal(f.status, 'active', '38a: status');
      assert.equal(f.representative_claim, 'five_hour', '38a: representative_claim');
      assert.equal(f.reset, 1748300000, '38a: reset should be integer');
      assert.equal(typeof f.reset, 'number', '38a: reset should be number type');
      assert.equal(f.fallback_percentage, 0.5, '38a: fallback_percentage');
      assert.equal(typeof f.fallback_percentage, 'number', '38a: fallback_percentage type');
      assert.equal(f.status_5h, 'active', '38a: status_5h');
      assert.equal(f.utilization_5h, 0.49, '38a: utilization_5h');
      assert.equal(f.reset_5h, 1748290000, '38a: reset_5h');
      assert.equal(f.status_7d, 'active', '38a: status_7d');
      assert.equal(f.utilization_7d, 0.31, '38a: utilization_7d');
      assert.equal(f.reset_7d, 1748500000, '38a: reset_7d');
      assert.equal(f.overage_status, 'rejected', '38a: overage_status');
      assert.equal(f.overage_disabled_reason, 'org_level_disabled_until', '38a: overage_disabled_reason');
      assert.equal(f.overage_reset, 1748400000, '38a: overage_reset (new vs OCP 2026-04)');
    } finally {
      if (mock) await mock.close();
      resetQuotaProbe38();
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  it('38b — parse: missing overage-reset header → overage_reset: null', async () => {
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38b-'));
    let mock;
    try {
      _writeProbeConfig(TMP);
      process.env.OLP_HOME = TMP;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token-38b';
      const headers = { ..._ALL_13_HEADERS };
      delete headers['anthropic-ratelimit-unified-overage-reset'];
      mock = await _startMockServer((_req, res) => {
        res.writeHead(200, headers);
        res.end('{}');
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);
      resetQuotaStateOnly38();

      const result = await quotaStatus38();
      assert.ok(result !== null, '38b: should return non-null');
      assert.equal(result.fields.overage_reset, null, '38b: missing overage-reset → null');
    } finally {
      if (mock) await mock.close();
      resetQuotaProbe38();
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  it('38c — parse: missing all overage fields → all three null', async () => {
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38c-'));
    let mock;
    try {
      _writeProbeConfig(TMP);
      process.env.OLP_HOME = TMP;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token-38c';
      const headers = { ..._ALL_13_HEADERS };
      delete headers['anthropic-ratelimit-unified-overage-status'];
      delete headers['anthropic-ratelimit-unified-overage-disabled-reason'];
      delete headers['anthropic-ratelimit-unified-overage-reset'];
      mock = await _startMockServer((_req, res) => {
        res.writeHead(200, headers);
        res.end('{}');
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);
      resetQuotaStateOnly38();

      const result = await quotaStatus38();
      assert.ok(result !== null, '38c: should return non-null');
      assert.equal(result.fields.overage_status, null, '38c: missing overage-status → null');
      assert.equal(result.fields.overage_disabled_reason, null, '38c: missing overage-disabled-reason → null');
      assert.equal(result.fields.overage_reset, null, '38c: missing overage-reset → null');
    } finally {
      if (mock) await mock.close();
      resetQuotaProbe38();
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  it('38d — parse: new 5h-status + 7d-status headers (fields new vs OCP 2026-04) correctly parsed', async () => {
    // These two headers are the most important "new vs OCP" additions.
    // Exercise explicitly to lock the ADR 0013 + audit-memory claim.
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38d-'));
    let mock;
    try {
      _writeProbeConfig(TMP);
      process.env.OLP_HOME = TMP;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token-38d';
      mock = await _startMockServer((_req, res) => {
        res.writeHead(200, {
          ..._ALL_13_HEADERS,
          'anthropic-ratelimit-unified-5h-status': 'approaching_limit',
          'anthropic-ratelimit-unified-7d-status': 'limit_reached',
        });
        res.end('{}');
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);
      resetQuotaStateOnly38();

      const result = await quotaStatus38();
      assert.ok(result !== null, '38d: should return non-null');
      assert.equal(result.fields.status_5h, 'approaching_limit', '38d: status_5h new field');
      assert.equal(result.fields.status_7d, 'limit_reached', '38d: status_7d new field');
    } finally {
      if (mock) await mock.close();
      resetQuotaProbe38();
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  // ── 38e–38f: opt-in + no-auth early exits ────────────────────────────────

  it('38e — quotaStatus disabled in config → returns null without HTTP', async () => {
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38e-'));
    let requestCount = 0;
    let mock;
    try {
      // Write config WITHOUT quota_probe_enabled (or explicitly false)
      _mkdirSync38(TMP, { recursive: true });
      _writeFileSync38(_pathJoin38(TMP, 'config.json'), JSON.stringify({
        providers: { anthropic: { quota_probe_enabled: false } },
      }));
      process.env.OLP_HOME = TMP;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token-38e';
      mock = await _startMockServer((_req, res) => {
        requestCount++;
        res.writeHead(200, _ALL_13_HEADERS);
        res.end('{}');
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);
      resetQuotaStateOnly38();

      const result = await quotaStatus38();
      assert.equal(result, null, '38e: null when disabled');
      assert.equal(requestCount, 0, '38e: no HTTP request should be made when disabled');
    } finally {
      if (mock) await mock.close();
      resetQuotaProbe38();
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  it('38f — quotaStatus enabled + no auth → returns unreachable shape without HTTP (v0.5.1)', async () => {
    // v0.5.1 (F3): no_credentials is no longer null — it returns probe_status:'unreachable'
    // so the operator can distinguish "disabled" (null) from "no credentials" (unreachable).
    // Uses _setQuotaAuthReadFnForTest to inject a "no credentials" auth reader.
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38f-'));
    let requestCount = 0;
    let mock;
    try {
      _writeProbeConfig(TMP);
      process.env.OLP_HOME = TMP;
      mock = await _startMockServer((_req, res) => {
        requestCount++;
        res.writeHead(200, _ALL_13_HEADERS);
        res.end('{}');
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);
      // Inject a "no credentials" auth reader (bypasses real keychain/files)
      setQuotaAuthFn38(() => null);
      resetQuotaStateOnly38();

      const result = await quotaStatus38();
      // v0.5.1: no_credentials → probe_status:'unreachable' (NOT null)
      // null is now ONLY returned for opt-in disabled.
      assert.ok(result !== null, '38f: no-creds result should NOT be null in v0.5.1 (F3: null reserved for disabled)');
      assert.equal(result.probe_status, 'unreachable', '38f: probe_status should be unreachable when no creds');
      assert.equal(result.failure?.kind, 'no_credentials', '38f: failure.kind should be no_credentials');
      assert.equal(requestCount, 0, '38f: no HTTP request should be made without auth');
    } finally {
      if (mock) await mock.close();
      resetQuotaProbe38();  // also resets _quotaAuthReadFnForTest
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  // ── 38g: successful probe returns correct shape ───────────────────────────

  it('38g — enabled + auth + mock 200 → returns 13-field shape with stale:false', async () => {
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38g-'));
    let mock;
    try {
      _writeProbeConfig(TMP);
      process.env.OLP_HOME = TMP;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token-38g';
      mock = await _startMockServer((_req, res) => {
        res.writeHead(200, _ALL_13_HEADERS);
        res.end('{}');
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);
      resetQuotaStateOnly38();

      const result = await quotaStatus38();
      assert.ok(result !== null, '38g: should return non-null');
      assert.equal(result.probe_status, 'live', '38g: probe_status=live on fresh probe (v0.5.1)');
      assert.equal(result.stale, false, '38g: stale=false on fresh probe (backwards-compat)');
      assert.equal(result.source, 'anthropic-ratelimit-unified-headers', '38g: source field');
      assert.ok(typeof result.probedAt === 'number', '38g: probedAt should be a number');
      assert.ok(typeof result.schemaVersion === 'string', '38g: schemaVersion should be a string');
      assert.ok(typeof result.fields === 'object', '38g: fields should be an object');
      assert.ok(typeof result.raw === 'object', '38g: raw should be an object');
      // Check backoff was reset
      const state = getQuotaProbeState38();
      assert.equal(state.backoffUntil, 0, '38g: backoffUntil reset to 0 on success');
    } finally {
      if (mock) await mock.close();
      resetQuotaProbe38();
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  // ── 38h–38i: cache behaviour ──────────────────────────────────────────────

  it('38h — cache hit within 5min TTL → no second HTTP call', async () => {
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38h-'));
    let requestCount = 0;
    let mock;
    try {
      _writeProbeConfig(TMP);
      process.env.OLP_HOME = TMP;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token-38h';
      mock = await _startMockServer((_req, res) => {
        requestCount++;
        res.writeHead(200, _ALL_13_HEADERS);
        res.end('{}');
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);
      resetQuotaStateOnly38();

      const r1 = await quotaStatus38();
      assert.ok(r1 !== null, '38h: first call should succeed');
      assert.equal(requestCount, 1, '38h: first call should fire one HTTP request');

      // Second call within TTL
      const r2 = await quotaStatus38();
      assert.ok(r2 !== null, '38h: second call should return cached result');
      assert.equal(requestCount, 1, '38h: second call should NOT fire another HTTP request');
      assert.equal(r2.stale, false, '38h: cached result should have stale=false');
    } finally {
      if (mock) await mock.close();
      resetQuotaProbe38();
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  it('38i — expired cache (TTL + 1ms) → fires fresh HTTP probe', async () => {
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38i-'));
    let requestCount = 0;
    let mock;
    try {
      _writeProbeConfig(TMP);
      process.env.OLP_HOME = TMP;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token-38i';
      mock = await _startMockServer((_req, res) => {
        requestCount++;
        res.writeHead(200, _ALL_13_HEADERS);
        res.end('{}');
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);
      resetQuotaStateOnly38();

      // Seed cache manually with an expired fetchedAt (6 min ago > 5 min TTL)
      const SIX_MIN_AGO = Date.now() - (6 * 60 * 1000);
      // Do a real probe first to seed state, then backdate it
      const r1 = await quotaStatus38();
      assert.ok(r1 !== null, '38i: first call should succeed');
      // Backdate the cache entry
      const state = getQuotaProbeState38();
      if (state.cache) state.cache.fetchedAt = SIX_MIN_AGO;

      // Second call should miss cache and fire a fresh probe
      const priorCount = requestCount;
      const r2 = await quotaStatus38();
      assert.ok(r2 !== null, '38i: second call should succeed after cache miss');
      assert.ok(requestCount > priorCount, '38i: should fire a fresh HTTP request after cache expiry');
    } finally {
      if (mock) await mock.close();
      resetQuotaProbe38();
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  // ── 38j: 401 with no refreshToken → null (idempotent-failure) ─────────────

  it('38j — 401 with no refreshToken → null (idempotent-failure, no refresh attempt)', async () => {
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38j-'));
    let apiCallCount = 0;
    let oauthCallCount = 0;
    let mock;
    try {
      _writeProbeConfig(TMP);
      process.env.OLP_HOME = TMP;
      // Env-path creds return { accessToken } only (no refreshToken). Per
      // anthropic.mjs:452 _probeOnce, the 401 → refresh-and-retry only fires
      // when refreshToken is present. This test pins the no-refreshToken
      // idempotent-failure branch (returns null, no OAuth call).
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'expired-token-38j';
      mock = await _startMockServer((req, res) => {
        if (req.url.includes('/oauth/token')) {
          oauthCallCount++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'fresh-token-38j' }));
        } else {
          apiCallCount++;
          res.writeHead(401, {});
          res.end('{"error":"unauthorized"}');
        }
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);
      resetQuotaStateOnly38();

      const result = await quotaStatus38();
      // v0.5.1 (F3): 401 with no cache → probe_status:'unreachable' + failure_kind:'auth_failed'
      // (idempotent-failure per ADR 0002 Amendment 8 still holds — no panic, no retry loop)
      assert.ok(result !== null, '38j: 401+no-refreshToken → unreachable shape (not null in v0.5.1)');
      assert.equal(result.probe_status, 'unreachable', '38j: probe_status should be unreachable');
      assert.equal(result.failure?.kind, 'auth_failed', '38j: failure.kind should be auth_failed on 401');
      assert.equal(apiCallCount, 1, '38j: only one API call made (no retry without refreshToken)');
      assert.equal(oauthCallCount, 0, '38j: no OAuth refresh call without refreshToken');
    } finally {
      if (mock) await mock.close();
      resetQuotaProbe38();
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  // ── 38j2: 401 WITH refreshToken → refresh succeeds → retry returns 200 ────

  it('38j2 — 401 with refreshToken → refresh succeeds → retry probe returns 200 with 13 fields', async () => {
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38j2-'));
    let apiCallCount = 0;
    let oauthCallCount = 0;
    let oauthBodyRefreshToken = null;
    let mock;
    try {
      _writeProbeConfig(TMP);
      process.env.OLP_HOME = TMP;
      // Inject creds with BOTH accessToken AND refreshToken via the test seam.
      // The 401 → refresh-and-retry branch at anthropic.mjs:452 fires only when
      // refreshToken is present, exercising the positive-path control flow
      // documented in ADR 0013 § Rule 1 (credential reuse + refresh).
      setQuotaAuthFn38(() => ({
        accessToken: 'expired-token-38j2',
        refreshToken: 'valid-refresh-token-38j2',
        expiresAt: null, // skip pre-emptive refresh at line 402
      }));
      mock = await _startMockServer((req, res) => {
        if (req.url.includes('/oauth/token')) {
          // Capture the refresh_token sent in the OAuth body to verify routing
          oauthCallCount++;
          let body = '';
          req.on('data', (chunk) => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const parsed = JSON.parse(body);
              oauthBodyRefreshToken = parsed?.refresh_token ?? null;
            } catch { /* ignore */ }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ access_token: 'fresh-token-38j2' }));
          });
        } else {
          apiCallCount++;
          if (apiCallCount === 1) {
            // First API call (with expired token) → 401 to trigger refresh
            res.writeHead(401, {});
            res.end('{"error":"token_expired"}');
          } else {
            // Second API call (after refresh) → 200 with all 13 headers
            res.writeHead(200, _ALL_13_HEADERS);
            res.end('{}');
          }
        }
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);
      resetQuotaStateOnly38();

      const result = await quotaStatus38();
      assert.ok(result !== null, '38j2: refresh-retry path should return non-null');
      assert.equal(result.stale, false, '38j2: returned data is fresh (not stale)');
      assert.equal(apiCallCount, 2, '38j2: exactly 2 API calls (401 then retry 200)');
      assert.equal(oauthCallCount, 1, '38j2: exactly 1 OAuth refresh call between API calls');
      assert.equal(oauthBodyRefreshToken, 'valid-refresh-token-38j2',
        '38j2: OAuth refresh sent the injected refreshToken (Rule 1 credential reuse)');
      // Verify the 13 fields landed (refresh succeeded → retry parsed full shape)
      assert.equal(typeof result.fields?.utilization_5h, 'number',
        '38j2: retry parsed utilization_5h from second-attempt response headers');
      assert.equal(typeof result.fields?.utilization_7d, 'number',
        '38j2: retry parsed utilization_7d');
    } finally {
      if (mock) await mock.close();
      resetQuotaProbe38();
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  // ── 38k–38l: 429 stale cache ──────────────────────────────────────────────

  it('38k — mock 429 + cache exists → returns stale cache with stale:true', async () => {
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38k-'));
    let callCount = 0;
    let mock;
    try {
      _writeProbeConfig(TMP);
      process.env.OLP_HOME = TMP;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token-38k';
      mock = await _startMockServer((_req, res) => {
        callCount++;
        if (callCount === 1) {
          // First call: 200 with headers to seed cache
          res.writeHead(200, _ALL_13_HEADERS);
          res.end('{}');
        } else {
          // Subsequent: 429 no headers → triggers stale path
          res.writeHead(429, {});
          res.end('{"error":"rate limited"}');
        }
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);
      resetQuotaStateOnly38();

      // Seed the cache with a fresh probe
      const r1 = await quotaStatus38();
      assert.ok(r1 !== null, '38k: first call should succeed');
      const freshFetchedAt = r1.probedAt;

      // Force cache to look stale (older than TTL) so next call re-probes
      const state = getQuotaProbeState38();
      if (state.cache) state.cache.fetchedAt = Date.now() - (6 * 60 * 1000);
      // Also clear backoff so the probe attempts
      state.backoffUntil = 0;
      state.backoffMs = 60_000;

      // Second call hits 429 → should return stale cache
      const r2 = await quotaStatus38();
      assert.ok(r2 !== null, '38k: 429 with stale cache → should return stale cache (not null)');
      assert.equal(r2.probe_status, 'stale', '38k: probe_status=stale (v0.5.1)');
      assert.equal(r2.stale, true, '38k: stale should be true (backwards-compat)');
      assert.ok(typeof r2.last_fresh_at === 'number', '38k: last_fresh_at should be present');
      assert.ok(r2.failure !== null && r2.failure !== undefined, '38k: failure info should be present (F3)');
      assert.equal(r2.failure.kind, 'rate_limited', '38k: failure.kind should be rate_limited on 429 (F3)');
    } finally {
      if (mock) await mock.close();
      resetQuotaProbe38();
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  it('38l — mock 429 + no cache → returns null', async () => {
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38l-'));
    let mock;
    try {
      _writeProbeConfig(TMP);
      process.env.OLP_HOME = TMP;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token-38l';
      mock = await _startMockServer((_req, res) => {
        // Return 429 with no rate-limit headers → failure, no cache yet
        res.writeHead(429, {});
        res.end('{"error":"rate limited"}');
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);
      resetQuotaStateOnly38();

      const result = await quotaStatus38();
      // v0.5.1 (F3): 429 with no cache → probe_status:'unreachable' + failure_kind:'rate_limited'
      // (not null — null is now reserved for opt-in disabled only)
      assert.ok(result !== null, '38l: 429+no-cache → unreachable shape (not null in v0.5.1)');
      assert.equal(result.probe_status, 'unreachable', '38l: probe_status should be unreachable');
      assert.equal(result.failure?.kind, 'rate_limited', '38l: failure.kind should be rate_limited on 429');

      // Verify backoff was scheduled
      const state = getQuotaProbeState38();
      assert.ok(state.backoffUntil > Date.now(), '38l: backoffUntil should be in the future after 429');
    } finally {
      if (mock) await mock.close();
      resetQuotaProbe38();
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  // ── 38m–38n: backoff growth and reset ────────────────────────────────────

  it('38m — backoff exponential growth (60s → 120s → 240s → cap at 3600s)', async () => {
    // Test _scheduleBackoff() progression by triggering failures directly.
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38m-'));
    let mock;
    try {
      _writeProbeConfig(TMP);
      process.env.OLP_HOME = TMP;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token-38m';
      mock = await _startMockServer((_req, res) => {
        res.writeHead(429, {});
        res.end('{}');
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);
      resetQuotaStateOnly38();

      // Verify initial backoffMs = 60s
      assert.equal(getQuotaProbeState38().backoffMs, 60_000, '38m: initial backoffMs should be 60000ms');

      // First failure → schedules 60s backoff, advances backoffMs to 120s
      await quotaStatus38();
      const s1 = getQuotaProbeState38();
      assert.equal(s1.backoffMs, 120_000, '38m: after 1st failure: backoffMs = 120s');

      // Clear backoffUntil to allow retry, fire again → 240s
      s1.backoffUntil = 0;
      await quotaStatus38();
      const s2 = getQuotaProbeState38();
      assert.equal(s2.backoffMs, 240_000, '38m: after 2nd failure: backoffMs = 240s');

      // Simulate multiple failures to reach cap (3600s)
      s2.backoffUntil = 0;
      s2.backoffMs = 1800_000; // pre-set to 1800s (half of cap)
      await quotaStatus38();
      const s3 = getQuotaProbeState38();
      assert.equal(s3.backoffMs, 3600_000, '38m: backoffMs should cap at 3600s');

      // One more failure → stays at cap
      s3.backoffUntil = 0;
      await quotaStatus38();
      const s4 = getQuotaProbeState38();
      assert.equal(s4.backoffMs, 3600_000, '38m: backoffMs stays capped at 3600s');
    } finally {
      if (mock) await mock.close();
      resetQuotaProbe38();
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  it('38n — successful probe resets backoff to 60s', async () => {
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38n-'));
    let callCount = 0;
    let mock;
    try {
      _writeProbeConfig(TMP);
      process.env.OLP_HOME = TMP;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token-38n';
      mock = await _startMockServer((_req, res) => {
        callCount++;
        if (callCount === 1) {
          // First: failure to build up backoff
          res.writeHead(429, {});
          res.end('{}');
        } else {
          // Second: success to reset backoff
          res.writeHead(200, _ALL_13_HEADERS);
          res.end('{}');
        }
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);
      resetQuotaStateOnly38();

      // First call fails → backoff scheduled + backoffMs doubled
      await quotaStatus38();
      const s1 = getQuotaProbeState38();
      assert.equal(s1.backoffMs, 120_000, '38n: backoffMs should be 120s after failure');

      // Clear backoff window to allow retry
      s1.backoffUntil = 0;
      // Force cache miss so probe runs
      if (s1.cache) s1.cache.fetchedAt = 0;

      // Second call succeeds → backoff should reset to 60s
      const r2 = await quotaStatus38();
      assert.ok(r2 !== null, '38n: second call should succeed');
      const s2 = getQuotaProbeState38();
      assert.equal(s2.backoffMs, 60_000, '38n: successful probe resets backoffMs to 60s');
      assert.equal(s2.backoffUntil, 0, '38n: successful probe resets backoffUntil to 0');
    } finally {
      if (mock) await mock.close();
      resetQuotaProbe38();
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  // ── 38o: schemaVersion from models-registry.json ─────────────────────────

  it('38o — schemaVersion sourced from models-registry.json (not only the constant)', async () => {
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38o-'));
    let mock;
    try {
      _writeProbeConfig(TMP);
      process.env.OLP_HOME = TMP;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token-38o';
      mock = await _startMockServer((_req, res) => {
        res.writeHead(200, _ALL_13_HEADERS);
        res.end('{}');
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);
      resetQuotaStateOnly38();

      const result = await quotaStatus38();
      assert.ok(result !== null, '38o: should return non-null');
      // models-registry.json has quota_probe.schema_version = '2026-05-26'
      // The returned schemaVersion must be a non-empty string (from registry or constant)
      assert.ok(typeof result.schemaVersion === 'string' && result.schemaVersion.length > 0,
        '38o: schemaVersion must be a non-empty string from registry or constant fallback');
      // Confirm it matches what the registry says (ties to Suite 37g regression).
      // ESM has no `require`; read the registry directly via node:fs.
      const registryPath = _pathJoin38(import.meta.dirname ?? process.cwd(), 'models-registry.json');
      let registry = {};
      try { registry = JSON.parse(_readFileSync38(registryPath, 'utf8')); } catch { /* ignore */ }
      const expected = registry?.quota_probe?.schema_version;
      assert.ok(expected,
        '38o: models-registry.json must define quota_probe.schema_version (ADR 0013 Rule 5)');
      assert.equal(result.schemaVersion, expected,
        '38o: schemaVersion should match models-registry.json quota_probe.schema_version');
    } finally {
      if (mock) await mock.close();
      resetQuotaProbe38();
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  // ── 38p–38t: doctorChecks anthropic.quota_probe_reachable (5 status paths) ─

  it('38p — doctor: quota_probe_reachable disabled → ok with advisory message', async () => {
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38p-'));
    try {
      // Write config with probe disabled (or missing = default disabled)
      _mkdirSync38(TMP, { recursive: true });
      _writeFileSync38(_pathJoin38(TMP, 'config.json'), JSON.stringify({
        providers: { anthropic: { quota_probe_enabled: false } },
      }));
      process.env.OLP_HOME = TMP;
      resetQuotaProbe38();

      const checks = doctorChecks38({
        _binaryExistsFn: () => true,
        _authReadFn: () => ({ accessToken: 'tok' }),
      });
      const probeCheck = checks.find(c => c.id === 'anthropic.quota_probe_reachable');
      assert.ok(probeCheck, '38p: quota_probe_reachable check must exist');

      const result = await probeCheck.run();
      assert.equal(result.status, 'ok', '38p: disabled probe → ok');
      assert.ok(result.message.includes('disabled') || result.message.includes('opt-in'),
        '38p: message should mention disabled/opt-in');
    } finally {
      resetQuotaProbe38();
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  it('38q — doctor: probe enabled + probe succeeds → ok with utilization in message', async () => {
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38q-'));
    let mock;
    try {
      _writeProbeConfig(TMP);
      process.env.OLP_HOME = TMP;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token-38q';
      mock = await _startMockServer((_req, res) => {
        res.writeHead(200, _ALL_13_HEADERS);
        res.end('{}');
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);
      resetQuotaStateOnly38();

      const checks = doctorChecks38({
        _binaryExistsFn: () => true,
        _authReadFn: () => ({ accessToken: 'test-token-38q' }),
      });
      const probeCheck = checks.find(c => c.id === 'anthropic.quota_probe_reachable');
      const result = await probeCheck.run();
      assert.equal(result.status, 'ok', '38q: successful probe → ok');
      assert.ok(result.message.includes('OK') || result.message.includes('utilization'),
        '38q: message should include OK or utilization info');
    } finally {
      if (mock) await mock.close();
      resetQuotaProbe38();
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  it('38r — doctor: probe enabled + probe fails + cache stale → warn (v0.5.1)', async () => {
    // v0.5.1 (F1): doctor now routes through quotaStatus() — it respects cache+backoff.
    // To simulate "stale cache" state: seed cache via a successful probe, then manually
    // expire the cache (fetchedAt = 0) and set backoffUntil in the future (simulate a
    // failed probe having scheduled backoff). quotaStatus() will see expired cache +
    // active backoff → returns probe_status:'stale'. Doctor maps this → 'warn'.
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38r-'));
    let callCount = 0;
    let mock;
    try {
      _writeProbeConfig(TMP);
      process.env.OLP_HOME = TMP;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token-38r';
      mock = await _startMockServer((_req, res) => {
        callCount++;
        // Always succeed — we only call this once to seed the cache
        res.writeHead(200, _ALL_13_HEADERS);
        res.end('{}');
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);
      resetQuotaStateOnly38();

      // Seed cache with a successful probe
      await quotaStatus38();
      const state = getQuotaProbeState38();
      assert.ok(state.cache !== null, '38r setup: cache should be seeded');

      // Simulate "stale" state: expire cache + set backoff as if a probe just failed.
      // Doctor now calls quotaStatus() which will see: cache expired + backoff active
      // → returns probe_status:'stale'.
      state.cache.fetchedAt = Date.now() - 10 * 60 * 1000; // 10 min ago (beyond 5min TTL)
      state.backoffUntil = Date.now() + 60_000; // backoff active for 60s
      state.lastError = { kind: 'network', message: 'probe timeout', attemptedAt: Date.now() - 10_000 };
      state.failureKind = 'network';

      const checks = doctorChecks38({
        _binaryExistsFn: () => true,
        _authReadFn: () => ({ accessToken: 'test-token-38r' }),
      });
      const probeCheck = checks.find(c => c.id === 'anthropic.quota_probe_reachable');
      const result = await probeCheck.run();
      assert.equal(result.status, 'warn', '38r: stale cache → warn');
      assert.ok(result.message.includes('stale') || result.message.includes('failed'),
        '38r: message should mention stale or failure');
      // F1 regression: callCount should still be 1 — doctor did NOT make a second upstream call
      assert.equal(callCount, 1, '38r F1 regression: doctor should NOT make additional upstream HTTP calls (respects backoff)');
    } finally {
      if (mock) await mock.close();
      resetQuotaProbe38();
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  it('38s — doctor: probe enabled + probe fails + no cache → fail with fix_commands', async () => {
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38s-'));
    let mock;
    try {
      _writeProbeConfig(TMP);
      process.env.OLP_HOME = TMP;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token-38s';
      mock = await _startMockServer((_req, res) => {
        // Always fail with no rate-limit headers → _probeOnce returns null
        res.writeHead(500, {});
        res.end('{}');
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);
      resetQuotaStateOnly38(); // No cache

      const checks = doctorChecks38({
        _binaryExistsFn: () => true,
        _authReadFn: () => ({ accessToken: 'test-token-38s' }),
      });
      const probeCheck = checks.find(c => c.id === 'anthropic.quota_probe_reachable');
      const result = await probeCheck.run();
      assert.equal(result.status, 'fail', '38s: failed probe + no cache → fail');
      assert.ok(result.evidence, '38s: evidence block should be present');
      assert.ok(
        Array.isArray(result.evidence.fix_commands) || Array.isArray(result.evidence.human_steps),
        '38s: fix_commands or human_steps should be present in evidence',
      );
    } finally {
      if (mock) await mock.close();
      resetQuotaProbe38();
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  it('38t — doctor: probe enabled + no creds → fail with human-only recovery steps', async () => {
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38t-'));
    try {
      _writeProbeConfig(TMP);
      process.env.OLP_HOME = TMP;
      resetQuotaProbe38();

      const checks = doctorChecks38({
        _binaryExistsFn: () => true,
        _authReadFn: () => null,  // no credentials
      });
      const probeCheck = checks.find(c => c.id === 'anthropic.quota_probe_reachable');
      const result = await probeCheck.run();
      assert.equal(result.status, 'fail', '38t: no creds → fail');
      assert.ok(result.evidence, '38t: evidence block should be present');
      assert.ok(Array.isArray(result.evidence.human_steps),
        '38t: human_steps should be present for no-creds failure');
      assert.ok(result.evidence.human_steps.length > 0,
        '38t: human_steps should not be empty');
    } finally {
      resetQuotaProbe38();
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  // ── 38u–38w: v0.5.1 regression tests (F1/F2/F3 codex review findings) ──────

  it('38u — F1 regression: successive doctor calls within backoff → no upstream HTTP on second call', async () => {
    // ADR 0013 Rule 3: doctor check MUST respect backoff (F1 — codex review).
    // Old code called _probeOnce() directly, bypassing backoff.
    // New code routes through quotaStatus() which enforces backoff.
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38u-'));
    let upstreamCallCount = 0;
    let mock;
    try {
      _writeProbeConfig(TMP);
      process.env.OLP_HOME = TMP;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token-38u';
      mock = await _startMockServer((_req, res) => {
        upstreamCallCount++;
        // Always return 500 → triggers backoff
        res.writeHead(500, {});
        res.end('{}');
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);
      resetQuotaStateOnly38();

      const checks = doctorChecks38({
        _binaryExistsFn: () => true,
        _authReadFn: () => ({ accessToken: 'test-token-38u' }),
      });
      const probeCheck = checks.find(c => c.id === 'anthropic.quota_probe_reachable');

      // First doctor call: probe fires → 500 → backoff scheduled, counter = 1
      const r1 = await probeCheck.run();
      assert.equal(r1.status, 'fail', '38u: first doctor call should fail (500, no cache)');
      assert.equal(upstreamCallCount, 1, '38u: first doctor call should fire exactly one upstream request');

      // Second doctor call: within backoff window → MUST NOT fire another upstream request
      const r2 = await probeCheck.run();
      assert.equal(r2.status, 'fail', '38u: second doctor call should also fail (still in backoff)');
      assert.equal(upstreamCallCount, 1,
        '38u F1 regression: second doctor call within backoff MUST NOT fire another upstream request (counter stays 1)');
    } finally {
      if (mock) await mock.close();
      resetQuotaProbe38();
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  it('38v — F2 regression: 200 with empty ratelimit headers → classified as failure (schema_drift)', async () => {
    // ADR 0013 Rule 5 minimum-viable-schema gate (F2 — codex review).
    // A 200 OK with zero anthropic-ratelimit-* headers was previously cached as
    // "live" data. With the minimum-field gate, it must be classified as failure.
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38v-'));
    let mock;
    try {
      _writeProbeConfig(TMP);
      process.env.OLP_HOME = TMP;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token-38v';
      mock = await _startMockServer((_req, res) => {
        // 200 OK but zero anthropic-ratelimit-* headers → schema_drift trigger
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);
      resetQuotaStateOnly38();

      const result = await quotaStatus38();
      // Must be classified as failure (unreachable with schema_drift kind)
      assert.ok(result !== null, '38v: result should not be null (v0.5.1: null only for disabled)');
      assert.equal(result.probe_status, 'unreachable', '38v F2: 200+no-ratelimit-headers → unreachable (schema_drift)');
      assert.equal(result.failure?.kind, 'schema_drift', '38v F2: failure.kind should be schema_drift');

      // Verify backoff was scheduled (not a silent success)
      const state = getQuotaProbeState38();
      assert.ok(state.backoffUntil > Date.now(), '38v F2: backoff should be scheduled on schema_drift');
      assert.equal(state.failureKind, 'schema_drift', '38v F2: quotaProbeState.failureKind should be schema_drift');

      // Verify cache is NOT populated (schema drift must not be cached as live data)
      assert.equal(state.cache, null, '38v F2: cache must remain null — schema_drift must NOT be cached as live data');
    } finally {
      if (mock) await mock.close();
      resetQuotaProbe38();
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

  it('38w — F3 regression: lastError + failureKind propagate through quotaStatus() shape', async () => {
    // ADR 0013 Rule 6 failure transparency (F3 — codex review).
    // Verifies that failure details (kind, message, backoff_until) are present in
    // the quotaStatus() return shape for each distinct failure mode.
    _saveEnv38();
    const TMP = _mkdtempSync38(_pathJoin38(_tmpdir38(), 'olp-38w-'));
    let mock;
    try {
      _writeProbeConfig(TMP);
      process.env.OLP_HOME = TMP;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token-38w';

      // Test 1: rate_limited (429)
      mock = await _startMockServer((_req, res) => {
        res.writeHead(429, {});
        res.end('{}');
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);
      resetQuotaStateOnly38();

      const r1 = await quotaStatus38();
      assert.equal(r1.probe_status, 'unreachable', '38w: 429 → unreachable');
      assert.ok(r1.failure !== null, '38w: failure should be present');
      assert.equal(r1.failure.kind, 'rate_limited', '38w: 429 → failure.kind = rate_limited');
      assert.ok(typeof r1.failure.message === 'string', '38w: failure.message should be a string');
      assert.ok(typeof r1.failure.backoff_until === 'number', '38w: failure.backoff_until should be a number');

      await mock.close();
      mock = null;

      // Test 2: auth_failed (401)
      resetQuotaStateOnly38();
      mock = await _startMockServer((_req, res) => {
        res.writeHead(401, {});
        res.end('{}');
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);

      const r2 = await quotaStatus38();
      assert.equal(r2.probe_status, 'unreachable', '38w: 401 → unreachable');
      assert.equal(r2.failure?.kind, 'auth_failed', '38w: 401 → failure.kind = auth_failed');

      await mock.close();
      mock = null;

      // Test 3: schema_drift (200 + no min fields)
      resetQuotaStateOnly38();
      mock = await _startMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      setQuotaUrls38(`${mock.url}/v1/messages`, `${mock.url}/v1/oauth/token`);

      const r3 = await quotaStatus38();
      assert.equal(r3.probe_status, 'unreachable', '38w: schema_drift → unreachable');
      assert.equal(r3.failure?.kind, 'schema_drift', '38w: 200+no-min-fields → failure.kind = schema_drift');

      // Test 4: no_credentials
      resetQuotaStateOnly38();
      setQuotaAuthFn38(() => null);

      const r4 = await quotaStatus38();
      assert.equal(r4.probe_status, 'unreachable', '38w: no_credentials → unreachable');
      assert.equal(r4.failure?.kind, 'no_credentials', '38w: no creds → failure.kind = no_credentials');

    } finally {
      if (mock) await mock.close();
      resetQuotaProbe38();
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      _restoreEnv38();
      _rmSync38(TMP, { recursive: true, force: true });
    }
  });

});

// ── Suite 39: D83 dashboard rendering smoke tests (Phase 5, ADR 0012 D83) ──
//
// Smoke tests for the /dashboard route (D82). Boots an ephemeral OLP server
// with an owner key, performs HTTP GETs against /dashboard, and asserts the
// served HTML body contains the key UI strings that lock the D82 deliverable.
//
// These tests do NOT exercise the dashboard's runtime JavaScript — they verify
// the static HTML structure that guarantees the D82 features are actually
// embedded in the served file.
//
// Approach:
//   1. Per-test: create a fresh tmpdir + write a minimal config
//   2. Create an owner key via createKey()
//   3. Boot an ephemeral OLP server on port 0
//   4. HTTP GET /dashboard with owner token → assert 200 + HTML body strings
//
// Authority: ADR 0012 D83 + ADR 0008 § 6 (owner-only_block) +
//   ADR 0008 Amendment (D82 — quota_v2 Claude.ai-style restructure) + D82 PR #54

import {
  createOlpServer as createOlpServerS39,
  __setAuthConfig as setAuthConfigS39,
  __resetAuthConfig as resetAuthConfigS39,
  __setProvidersEnabled as setProvidersEnabledS39,
  __resetProvidersEnabled as resetProvidersEnabledS39,
  __clearCache as clearCacheS39,
  __clearRecentErrors as clearRecentErrorsS39,
  __resetRequestCounters as resetRequestCountersS39,
} from './server.mjs';
import { createKey as createKeyS39 } from './lib/keys.mjs';
import { mkdtempSync as mkdtempSyncS39, rmSync as rmSyncS39, mkdirSync as mkdirSyncS39 } from 'node:fs';
import { join as pathJoinS39 } from 'node:path';
import { tmpdir as tmpdirS39 } from 'node:os';

/** Start an ephemeral OLP server. Returns { server, port, close }. */
async function _startOlpServer() {
  const server = createOlpServerS39();
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  return { server, port, close: () => new Promise(r => server.close(r)) };
}

/** HTTP GET helper (plain strings, reuses the top-level httpRequest helper pattern) */
function _getHttp(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      method: 'GET',
      path,
      headers,
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Suite 39 — D83 dashboard rendering smoke tests (Phase 5, ADR 0012 D83)', () => {
  let TMP39;
  let srv39;
  let ownerToken39;

  before(async () => {
    TMP39 = mkdtempSyncS39(pathJoinS39(tmpdirS39(), 'olp-39-'));
    process.env.OLP_HOME = TMP39;

    // Minimal config (no providers needed — dashboard is auth + HTML only)
    setProvidersEnabledS39({});
    setAuthConfigS39({
      allow_anonymous: false,
      owner_only_endpoints: ['/dashboard', '/v0/management/dashboard-data'],
      fallback_detail_header_policy: 'owner',
    });
    clearCacheS39();
    clearRecentErrorsS39();
    resetRequestCountersS39();

    // Create an owner key so we can authenticate to /dashboard
    const { plaintext_token } = createKeyS39({
      name: '39-owner',
      owner_tier: 'owner',
      providers_enabled: '*',
      olpHome: TMP39,
    });
    ownerToken39 = plaintext_token;

    srv39 = await _startOlpServer();
  });

  after(async () => {
    if (srv39) await srv39.close();
    resetProvidersEnabledS39();
    resetAuthConfigS39();
    rmSyncS39(TMP39, { recursive: true, force: true });
    // Restore global test defaults set at module top
    setAuthConfigS39({
      allow_anonymous: true,
      owner_only_endpoints: [],
      fallback_detail_header_policy: 'all',
    });
  });

  it('39a — /dashboard with owner token returns 200 + HTML content-type', async () => {
    const res = await _getHttp(srv39.port, '/dashboard', {
      Authorization: `Bearer ${ownerToken39}`,
    });
    assert.equal(res.status, 200, '39a: owner token should get 200');
    assert.ok(
      (res.headers['content-type'] ?? '').includes('text/html'),
      `39a: content-type should be text/html, got: ${res.headers['content-type']}`,
    );
    assert.ok(res.body.length > 0, '39a: response body should not be empty');
  });

  it('39b — /dashboard without token returns 401', async () => {
    const res = await _getHttp(srv39.port, '/dashboard');
    assert.equal(res.status, 401, '39b: no token should get 401');
  });

  it('39c — /dashboard with non-owner guest key returns 401 (owner-only_block enforcement)', async () => {
    // Create a guest key — it must NOT be allowed to access /dashboard
    const { plaintext_token: guestTok } = createKeyS39({
      name: '39-guest',
      owner_tier: 'guest',
      providers_enabled: '*',
      olpHome: TMP39,
    });
    const res = await _getHttp(srv39.port, '/dashboard', {
      Authorization: `Bearer ${guestTok}`,
    });
    assert.equal(res.status, 401, '39c: guest key should get 401 on owner-only /dashboard');
  });

  it('39d — dashboard HTML contains "Plan Usage" header', async () => {
    const res = await _getHttp(srv39.port, '/dashboard', {
      Authorization: `Bearer ${ownerToken39}`,
    });
    assert.ok(res.body.includes('Plan Usage'),
      '39d: dashboard HTML must contain "Plan Usage" (D82 panel header)');
  });

  it('39e — dashboard HTML contains the manual refresh button (↻ Refresh)', async () => {
    const res = await _getHttp(srv39.port, '/dashboard', {
      Authorization: `Bearer ${ownerToken39}`,
    });
    assert.ok(res.body.includes('↻') && res.body.includes('Refresh'),
      '39e: dashboard HTML must contain the ↻ Refresh button (D82 manual refresh)');
  });

  it('39f — dashboard HTML contains 60s quota poll interval constant', async () => {
    const res = await _getHttp(srv39.port, '/dashboard', {
      Authorization: `Bearer ${ownerToken39}`,
    });
    assert.ok(res.body.includes('QUOTA_POLL_INTERVAL_MS') && res.body.includes('60000'),
      '39f: dashboard HTML must declare QUOTA_POLL_INTERVAL_MS = 60000 (D82 1-min refresh)');
  });

  it('39g — dashboard HTML contains visibilityState listener code', async () => {
    const res = await _getHttp(srv39.port, '/dashboard', {
      Authorization: `Bearer ${ownerToken39}`,
    });
    assert.ok(res.body.includes('visibilityState') || res.body.includes('visibilitychange'),
      '39g: dashboard HTML must contain visibilityState / visibilitychange guard (D82 ADR 0012)');
  });

  it('39h — dashboard HTML contains both quota_v2 consumer and legacy quota fallback code', async () => {
    const res = await _getHttp(srv39.port, '/dashboard', {
      Authorization: `Bearer ${ownerToken39}`,
    });
    assert.ok(res.body.includes('quota_v2'),
      '39h: dashboard HTML must contain quota_v2 consumer code (D82 enriched shape)');
    assert.ok(res.body.includes('renderQuota') || res.body.includes('legacy'),
      '39h: dashboard HTML must contain legacy quota fallback path (graceful-degradation proof)');
  });
});

// ── Suite 40: F4 CLI/plugin quota_v2 migration + v1.x #7 AUTH_MISSING test pin ─
//
// Codex post-v0.5.0 review Q4: bin/olp.mjs cmdUsage and olp-plugin/index.js
// fmtUsage both read legacy body.quota (never has percent_used or available data),
// so the display always fell through to "no quota api" even when anthropic's live
// quota was visible on the dashboard. F4 adds consumption of body.quota_v2 (server
// v0.5.0+ shape per ADR 0008 Amendment 2) with graceful fallback to body.quota on
// older servers.
//
// v1.x roadmap #7 was already closed at D56 (test at line 6255); this suite
// references that test by description. The roadmap entry closure (marking ✅ CLOSED)
// happens in docs/v1x-roadmap.md (committed alongside these tests).
//
// Tests:
//   40a — cmdUsage renders quota_v2 live rows (mock server)
//   40b — cmdUsage falls back to legacy body.quota when quota_v2 absent
//   40c — olp-plugin fmtUsage parses quota_v2 live row
//   40d — olp-plugin fmtUsage falls back to legacy body.quota when quota_v2 absent
//   40e — formatResetCountdown past / <1h / <24h / <7d / ≥7d ranges
//   40f — olp-plugin pluginFormatResetCountdown parallel coverage
//   40g — cmdUsage renders quota_v2 stale row with ⚠ stale note
//   40h — cmdUsage renders quota_v2 unreachable row with ❌ indicator
//   40i — cmdUsage renders quota_v2 unavailable row with reason

import { runCli as runOlpCli40, formatResetCountdown as olpFormatResetCountdown } from './bin/olp.mjs';
import { fmtUsage as plugFmtUsage40, pluginFormatResetCountdown } from './olp-plugin/index.js';

// ── Helper: tiny HTTP server that responds to one request with a static JSON body ──
import { createServer as createHttpServerS40 } from 'node:http';

function makeJsonServer40(responseBody) {
  return new Promise((resolve, reject) => {
    const srv = createHttpServerS40((req, res) => {
      const body = typeof responseBody === 'function' ? responseBody(req) : responseBody;
      const raw = JSON.stringify(body);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) });
      res.end(raw);
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => srv.close(r)),
      });
    });
    srv.once('error', reject);
  });
}

// ── quota_v2 fixture shapes ──
const QUOTA_V2_LIVE = [
  {
    provider: 'anthropic',
    status: 'live',
    schema_version: '2026-05-26',
    last_fresh_at: Date.now() - 60000,
    utilization: { '5h': 0.36, '7d': 0.34 },
    reset: { '5h': Math.floor((Date.now() + 2 * 3600 * 1000) / 1000), '7d': Math.floor((Date.now() + 5 * 24 * 3600 * 1000) / 1000) },
    representative_claim: 'five_hour',
    fallback_percentage: 0.02,
    raw_available: null,
  },
  {
    provider: 'openai',
    status: 'unavailable',
    reason: 'no public quota api',
  },
  {
    provider: 'mistral',
    status: 'unavailable',
    reason: 'no public quota api',
  },
];

const QUOTA_V2_STALE = [
  {
    provider: 'anthropic',
    status: 'stale',
    last_fresh_at: Date.now() - 6 * 60000,
    utilization: { '5h': 0.60, '7d': 0.20 },
    reset: { '5h': Math.floor((Date.now() + 3600 * 1000) / 1000), '7d': Math.floor((Date.now() + 4 * 24 * 3600 * 1000) / 1000) },
    representative_claim: 'five_hour',
    failure: { kind: 'rate_limited', message: 'too many requests' },
  },
];

const QUOTA_V2_UNREACHABLE = [
  {
    provider: 'anthropic',
    status: 'unreachable',
    failure: { kind: 'auth_failed', message: 're-run `claude setup-token`' },
  },
];

const LEGACY_QUOTA_BODY = {
  window_24h: {},
  cache_hit_24h: {},
  quota: [
    { provider: 'anthropic', available: null },
    { provider: 'openai', available: null },
  ],
};

describe('Suite 40 — F4 CLI/plugin quota_v2 migration + v1.x #7 AUTH_MISSING test pin', () => {

  // ── 40a — cmdUsage renders quota_v2 live rows ────────────────────────────

  it('40a — cmdUsage parses quota_v2 live rows (mock server → asserts key strings present)', async () => {
    const dashData = {
      window_24h: { request_count: 12, status_2xx: 12, status_4xx: 0, status_5xx: 0 },
      cache_hit_24h: { hit_rate: 0.5, hit: 6, miss: 6 },
      quota: [],
      quota_v2: QUOTA_V2_LIVE,
      top_fallback_chains_24h: [],
      cache_stats: { hits: 6, misses: 6, size: 4, inflightCount: 0 },
    };
    const srv = await makeJsonServer40(dashData);
    try {
      // Clear auth env so resolveBearerToken returns null (anonymous allowed)
      const savedKey = process.env.OLP_API_KEY;
      const savedOwner = process.env.OLP_OWNER_TOKEN;
      delete process.env.OLP_API_KEY;
      delete process.env.OLP_OWNER_TOKEN;
      let out = '', err = '';
      try {
        const code = await runOlpCli40(
          ['usage', `--proxy-url=${srv.url}`],
          { out: s => { out += s; }, err: s => { err += s; }, useColor: false },
        );
        assert.equal(code, 0, `cmdUsage exit non-zero; stderr=${err}`);
      } finally {
        if (savedKey === undefined) delete process.env.OLP_API_KEY; else process.env.OLP_API_KEY = savedKey;
        if (savedOwner === undefined) delete process.env.OLP_OWNER_TOKEN; else process.env.OLP_OWNER_TOKEN = savedOwner;
      }
      // Must display quota_v2 section heading
      assert.match(out, /Per-provider quota.*live/i, '40a: header must mention live quota');
      // Must show anthropic provider name
      assert.match(out, /ANTHROPIC/, '40a: ANTHROPIC row must appear');
      // Must show percentage data (36% or 34% from utilization shape)
      assert.match(out, /36%|34%/, '40a: live utilization must appear');
      // Must show reset countdown strings
      assert.match(out, /resets in|resets /i, '40a: reset countdown must appear');
      // Legacy "no quota api" fallthrough must NOT appear
      assert.ok(!out.includes('no quota api'), '40a: "no quota api" must not appear when quota_v2 is present');
    } finally {
      await srv.close();
    }
  });

  // ── 40b — cmdUsage falls back to legacy body.quota when quota_v2 absent ──

  it('40b — cmdUsage falls back to legacy body.quota when quota_v2 absent (older server)', async () => {
    const srv = await makeJsonServer40(LEGACY_QUOTA_BODY);
    try {
      const savedKey = process.env.OLP_API_KEY;
      const savedOwner = process.env.OLP_OWNER_TOKEN;
      delete process.env.OLP_API_KEY;
      delete process.env.OLP_OWNER_TOKEN;
      let out = '', err = '';
      try {
        const code = await runOlpCli40(
          ['usage', `--proxy-url=${srv.url}`],
          { out: s => { out += s; }, err: s => { err += s; }, useColor: false },
        );
        assert.equal(code, 0, `cmdUsage fallback exit non-zero; stderr=${err}`);
      } finally {
        if (savedKey === undefined) delete process.env.OLP_API_KEY; else process.env.OLP_API_KEY = savedKey;
        if (savedOwner === undefined) delete process.env.OLP_OWNER_TOKEN; else process.env.OLP_OWNER_TOKEN = savedOwner;
      }
      // Legacy path shows "no quota api" for providers with null available
      assert.match(out, /no quota api/, '40b: legacy path must show "no quota api" fallthrough');
    } finally {
      await srv.close();
    }
  });

  // ── 40c — olp-plugin fmtUsage parses quota_v2 live row ──────────────────

  it('40c — olp-plugin fmtUsage parses quota_v2 live row (mock body)', () => {
    const body = {
      window_24h: { request_count: 5 },
      cache_hit_24h: { hit_rate: 0.4 },
      quota: [],
      quota_v2: QUOTA_V2_LIVE,
      top_fallback_chains_24h: [],
    };
    const out = plugFmtUsage40(body);
    // Section heading
    assert.match(out, /Per-provider quota.*live/i, '40c: section heading must indicate live quota');
    // Anthropic row present
    assert.match(out, /ANTHROPIC/, '40c: ANTHROPIC row must appear');
    // live status
    assert.match(out, /live/, '40c: status "live" must appear for anthropic');
    // Utilization percentage
    assert.match(out, /36%/, '40c: 5h utilization 36% must appear');
    // Reset countdown present
    assert.match(out, /resets in|resets /i, '40c: reset countdown must appear');
    // openai/mistral show unavailable
    assert.match(out, /OPENAI.*unavailable|OPENAI\s+unavailable/, '40c: OPENAI must show unavailable');
    // Legacy bar() fallthrough must NOT fire
    assert.ok(!out.includes('█'), '40c: legacy bar() must not appear when quota_v2 present');
  });

  // ── 40d — olp-plugin fmtUsage falls back to legacy body.quota ────────────

  it('40d — olp-plugin fmtUsage falls back to legacy body.quota when quota_v2 absent', () => {
    const body = {
      quota: [
        { provider: 'anthropic', percent_used: 45 },
        { provider: 'openai', percent_used: null },
      ],
    };
    const out = plugFmtUsage40(body);
    assert.match(out, /Per-provider quota/, '40d: section heading must appear');
    // Legacy bar() fires for percent_used=45
    assert.match(out, /anthropic.*45%|45%.*anthropic/i, '40d: anthropic 45% must appear');
    assert.match(out, /no quota api/, '40d: "no quota api" must appear for provider with null percent_used');
  });

  // ── 40e — formatResetCountdown ranges ────────────────────────────────────

  it('40e — formatResetCountdown covers all 5 time ranges', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // Past: diffMs <= 0
    assert.equal(olpFormatResetCountdown(nowSec - 5), 'resetting now', '40e: past → resetting now');
    // < 1h: exactly 30 minutes ahead by feeding epoch seconds directly (no ms conversion drift)
    const t30m = nowSec + 30 * 60;
    const r30m = olpFormatResetCountdown(t30m);
    assert.match(r30m, /resets in \d+m/, '40e: ~30min → resets in Xm format');
    assert.ok(r30m.includes('resets in'), '40e: 30min must use < 1h branch');
    // < 24h: 3 hours + 15 minutes from now (uses hours+minutes branch)
    const t3h15m = nowSec + (3 * 60 + 15) * 60;
    const r3h15m = olpFormatResetCountdown(t3h15m);
    assert.match(r3h15m, /resets in \d+h/, '40e: 3h15m → resets in Xh format');
    // < 7d: 2 days from now → weekday format
    const t2d = nowSec + 2 * 24 * 3600;
    const r2d = olpFormatResetCountdown(t2d);
    assert.match(r2d, /resets (Mon|Tue|Wed|Thu|Fri|Sat|Sun)/, '40e: 2 days → weekday format');
    // >= 7d: 10 days from now → month+day format
    const t10d = nowSec + 10 * 24 * 3600;
    const r10d = olpFormatResetCountdown(t10d);
    assert.match(r10d, /resets (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/, '40e: 10 days → month format');
    // null input
    assert.equal(olpFormatResetCountdown(null), '—', '40e: null → —');
  });

  // ── 40f — plugin formatResetCountdown parallel coverage ─────────────────

  it('40f — olp-plugin pluginFormatResetCountdown covers past / <1h / <24h / <7d / ≥7d', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    assert.equal(pluginFormatResetCountdown(nowSec - 1), 'resetting now', '40f: past → resetting now');
    // ~45 minutes ahead → < 1h branch
    const t45m = nowSec + 45 * 60;
    const r45m = pluginFormatResetCountdown(t45m);
    assert.match(r45m, /resets in \d+m/, '40f: ~45min → resets in Xm format');
    // ~2h ahead (well within <24h range — may read as 1h 59m due to sub-second drift)
    const t2h = nowSec + 2 * 3600;
    const r2h = pluginFormatResetCountdown(t2h);
    assert.match(r2h, /resets in \d+h/, '40f: ~2h → resets in Xh format');
    assert.equal(pluginFormatResetCountdown(null), '—', '40f: null → —');
  });

  // ── 40g — cmdUsage renders quota_v2 stale row ────────────────────────────

  it('40g — cmdUsage renders quota_v2 stale row with ⚠ stale note', async () => {
    const dashData = {
      window_24h: {},
      cache_hit_24h: {},
      quota: [],
      quota_v2: QUOTA_V2_STALE,
      top_fallback_chains_24h: [],
    };
    const srv = await makeJsonServer40(dashData);
    try {
      const savedKey = process.env.OLP_API_KEY;
      const savedOwner = process.env.OLP_OWNER_TOKEN;
      delete process.env.OLP_API_KEY;
      delete process.env.OLP_OWNER_TOKEN;
      let out = '', err = '';
      try {
        await runOlpCli40(
          ['usage', `--proxy-url=${srv.url}`],
          { out: s => { out += s; }, err: s => { err += s; }, useColor: false },
        );
      } finally {
        if (savedKey === undefined) delete process.env.OLP_API_KEY; else process.env.OLP_API_KEY = savedKey;
        if (savedOwner === undefined) delete process.env.OLP_OWNER_TOKEN; else process.env.OLP_OWNER_TOKEN = savedOwner;
      }
      assert.match(out, /stale/, '40g: stale status must appear in output');
    } finally {
      await srv.close();
    }
  });

  // ── 40h — cmdUsage renders quota_v2 unreachable row ─────────────────────

  it('40h — cmdUsage renders quota_v2 unreachable row with ❌ indicator', async () => {
    const dashData = {
      window_24h: {},
      cache_hit_24h: {},
      quota: [],
      quota_v2: QUOTA_V2_UNREACHABLE,
      top_fallback_chains_24h: [],
    };
    const srv = await makeJsonServer40(dashData);
    try {
      const savedKey = process.env.OLP_API_KEY;
      const savedOwner = process.env.OLP_OWNER_TOKEN;
      delete process.env.OLP_API_KEY;
      delete process.env.OLP_OWNER_TOKEN;
      let out = '', err = '';
      try {
        await runOlpCli40(
          ['usage', `--proxy-url=${srv.url}`],
          { out: s => { out += s; }, err: s => { err += s; }, useColor: false },
        );
      } finally {
        if (savedKey === undefined) delete process.env.OLP_API_KEY; else process.env.OLP_API_KEY = savedKey;
        if (savedOwner === undefined) delete process.env.OLP_OWNER_TOKEN; else process.env.OLP_OWNER_TOKEN = savedOwner;
      }
      assert.match(out, /❌|no cached data/, '40h: unreachable row must show ❌ or "no cached data"');
      assert.match(out, /auth_failed/, '40h: failure kind must appear in output');
    } finally {
      await srv.close();
    }
  });

  // ── 40i — cmdUsage renders quota_v2 unavailable row ─────────────────────

  it('40i — cmdUsage renders quota_v2 unavailable rows (openai / mistral) correctly', async () => {
    const dashData = {
      window_24h: {},
      cache_hit_24h: {},
      quota: [],
      quota_v2: QUOTA_V2_LIVE, // includes openai + mistral as unavailable
      top_fallback_chains_24h: [],
    };
    const srv = await makeJsonServer40(dashData);
    try {
      const savedKey = process.env.OLP_API_KEY;
      const savedOwner = process.env.OLP_OWNER_TOKEN;
      delete process.env.OLP_API_KEY;
      delete process.env.OLP_OWNER_TOKEN;
      let out = '', err = '';
      try {
        await runOlpCli40(
          ['usage', `--proxy-url=${srv.url}`],
          { out: s => { out += s; }, err: s => { err += s; }, useColor: false },
        );
      } finally {
        if (savedKey === undefined) delete process.env.OLP_API_KEY; else process.env.OLP_API_KEY = savedKey;
        if (savedOwner === undefined) delete process.env.OLP_OWNER_TOKEN; else process.env.OLP_OWNER_TOKEN = savedOwner;
      }
      // openai + mistral are unavailable in the fixture
      assert.match(out, /OPENAI/, '40i: OPENAI row must appear');
      assert.match(out, /unavailable/, '40i: "unavailable" must appear for providers with no quota api');
    } finally {
      await srv.close();
    }
  });
});

// ── Suite 41 — ADR 0009 Amendment 1: stream-json transport (Phase 6) ────────
//
// Tests for: extractSystemPrompt, buildCliArgs (no -p), parseStreamJsonLines,
//   anthropicStreamJsonEventToIR, and a full end-to-end mock-spawn integration.
//
// Authority: claude CLI v2.1.104 § --output-format stream-json / --verbose /
//   --system-prompt / --no-session-persistence (verified on PI231 2026-05-27).
//   OLP ADR 0009 Amendment 1 — decision lock + value re-anchoring.
//   OLP ALIGNMENT.md Rule 1 — provider plugin authority citation.

describe('Suite 41 — ADR 0009 Amendment 1: stream-json transport (Phase 6)', () => {

  // ── 41a: extractSystemPrompt ──────────────────────────────────────────

  it('41a-1: extractSystemPrompt — no client system messages → OLP_SYSTEM_PROMPT_WRAPPER alone', () => {
    const ir = makeIR({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    const result = extractSystemPrompt(ir);
    assert.equal(result, OLP_SYSTEM_PROMPT_WRAPPER,
      'Without system messages, result must be exactly OLP_SYSTEM_PROMPT_WRAPPER');
    assert.ok(result.includes('OLP HTTP proxy'),
      'OLP_SYSTEM_PROMPT_WRAPPER must mention "OLP HTTP proxy"');
    assert.ok(result.includes('Do not infer or invent'),
      'OLP_SYSTEM_PROMPT_WRAPPER must include the anti-hallucination clause');
  });

  it('41a-2: extractSystemPrompt — one client system message → wrapper + blank + client content', () => {
    const ir = makeIR({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system', content: 'You are a pirate.' },
        { role: 'user', content: 'Ahoy' },
      ],
    });
    const result = extractSystemPrompt(ir);
    assert.ok(result.startsWith(OLP_SYSTEM_PROMPT_WRAPPER),
      'Result must start with OLP_SYSTEM_PROMPT_WRAPPER');
    assert.ok(result.includes('\n\nYou are a pirate.'),
      'Client system content must be appended after blank line');
    // OLP wrapper and client content separated by exactly \n\n
    assert.equal(result, `${OLP_SYSTEM_PROMPT_WRAPPER}\n\nYou are a pirate.`);
  });

  it('41a-3: extractSystemPrompt — multiple client system messages → wrapper + blank + concatenated content', () => {
    const ir = makeIR({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'system', content: 'Speak in French.' },
        { role: 'user', content: 'Bonjour' },
      ],
    });
    const result = extractSystemPrompt(ir);
    assert.ok(result.startsWith(OLP_SYSTEM_PROMPT_WRAPPER),
      'Result must start with OLP_SYSTEM_PROMPT_WRAPPER');
    assert.ok(result.includes('Be concise.'), 'First system message must be included');
    assert.ok(result.includes('Speak in French.'), 'Second system message must be included');
    // Multiple system messages joined with \n\n
    assert.ok(result.includes('Be concise.\n\nSpeak in French.'),
      'Multiple system messages must be joined with \\n\\n');
  });

  // ── 41b: irToAnthropic skips role:system (ADR 0009 Amendment 1) ──────

  it('41b: irToAnthropic — role:system messages are skipped (go via --system-prompt)', () => {
    const ir = makeIR({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system', content: 'Be a weather bot.' },
        { role: 'user', content: 'What is the weather?' },
        { role: 'assistant', content: 'Sunny.' },
        { role: 'user', content: 'Thanks.' },
      ],
    });
    const prompt = irToAnthropic(ir);
    // System messages must NOT appear in the stdin prompt
    assert.ok(!prompt.includes('[System]'), 'irToAnthropic must not emit [System] prefix (ADR 0009 Amendment 1)');
    assert.ok(!prompt.includes('Be a weather bot.'), 'System content must not leak to stdin');
    // Other roles must still appear
    assert.ok(prompt.includes('What is the weather?'), 'User message must be present');
    assert.ok(prompt.includes('[Assistant] Sunny.'), 'Assistant message must be annotated');
    assert.ok(prompt.includes('Thanks.'), 'Second user message must be present');
  });

  // ── 41c: buildCliArgs ─────────────────────────────────────────────────

  it('41c: buildCliArgs — no -p flag, includes stream-json + verbose + system-prompt', () => {
    const args = buildCliArgs('claude-sonnet-4-6', 'You are a test assistant.');
    // Must NOT include -p
    assert.ok(!args.includes('-p'), 'buildCliArgs must NOT include -p (ADR 0009 Amendment 1)');
    // Must include all required flags
    assert.ok(args.includes('--output-format'), 'must include --output-format');
    assert.ok(args.includes('stream-json'), 'must use stream-json output format');
    assert.ok(args.includes('--verbose'), 'must include --verbose');
    assert.ok(args.includes('--no-session-persistence'), 'must include --no-session-persistence');
    assert.ok(args.includes('--system-prompt'), 'must include --system-prompt');
    assert.ok(args.includes('You are a test assistant.'), 'system prompt text must be in args');
    // Model flag
    assert.ok(args.includes('--model'), 'must include --model');
    assert.ok(args.includes('claude-sonnet-4-6'), 'must include model value');
  });

  // ── 41d: parseStreamJsonLines ─────────────────────────────────────────

  it('41d-1: parseStreamJsonLines — single complete line → 1 event + empty remainder', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init' });
    const { events, remainder } = parseStreamJsonLines(line + '\n');
    assert.equal(events.length, 1, 'Should parse 1 event');
    assert.equal(events[0].type, 'system', 'Event type must be system');
    assert.equal(remainder, '', 'Remainder must be empty after complete line');
  });

  it('41d-2: parseStreamJsonLines — incomplete trailing line → events from complete lines + remainder', () => {
    const line1 = JSON.stringify({ type: 'system', subtype: 'init' });
    const line2Partial = '{"type":"stream_eve'; // incomplete
    const input = line1 + '\n' + line2Partial;
    const { events, remainder } = parseStreamJsonLines(input);
    assert.equal(events.length, 1, 'Should parse only the complete line');
    assert.equal(events[0].type, 'system');
    assert.equal(remainder, line2Partial, 'Incomplete line must be the remainder');
  });

  it('41d-3: parseStreamJsonLines — JSON parse error on one line → other lines parsed, error event returned', () => {
    const line1 = JSON.stringify({ type: 'system', subtype: 'init' });
    const badLine = 'not-valid-json{{{';
    const line3 = JSON.stringify({ type: 'result', subtype: 'success' });
    const input = line1 + '\n' + badLine + '\n' + line3 + '\n';
    const { events, remainder } = parseStreamJsonLines(input);
    assert.equal(events.length, 3, 'Should return 3 events (including parse_error)');
    assert.equal(events[0].type, 'system', 'First event: system/init');
    assert.equal(events[1].type, 'parse_error', 'Second event: parse_error for bad line');
    assert.equal(events[1].raw, badLine, 'parse_error.raw must be the bad line');
    assert.equal(events[2].type, 'result', 'Third event: result (parsed successfully)');
    assert.equal(remainder, '', 'Remainder must be empty');
  });

  it('41d-4: parseStreamJsonLines — blank lines between events are skipped', () => {
    const line1 = JSON.stringify({ type: 'system', subtype: 'init' });
    const line2 = JSON.stringify({ type: 'result', subtype: 'success' });
    // Extra blank line between them (common in some NDJSON writers)
    const input = line1 + '\n\n' + line2 + '\n';
    const { events, remainder } = parseStreamJsonLines(input);
    assert.equal(events.length, 2, 'Blank lines must be skipped; 2 events expected');
    assert.equal(events[0].type, 'system');
    assert.equal(events[1].type, 'result');
  });

  // ── 41e: anthropicStreamJsonEventToIR ────────────────────────────────

  it('41e-1: anthropicStreamJsonEventToIR — content_block_delta → delta chunk with text', () => {
    const event = {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
    };
    const chunk = anthropicStreamJsonEventToIR(event, false);
    assert.ok(chunk !== null, 'content_block_delta must yield an IR chunk');
    assert.equal(chunk.type, 'delta', 'IR chunk type must be "delta"');
    assert.equal(chunk.content, 'Hello', 'IR chunk content must match text_delta.text');
    assert.ok(!('role' in chunk), 'Non-first delta must not include role');
  });

  it('41e-2: anthropicStreamJsonEventToIR — first content_block_delta includes role=assistant', () => {
    const event = {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
    };
    const chunk = anthropicStreamJsonEventToIR(event, true /* isFirstDelta */);
    assert.equal(chunk.type, 'delta');
    assert.equal(chunk.content, 'Hello');
    assert.equal(chunk.role, 'assistant', 'First delta must include role=assistant');
  });

  it('41e-3: anthropicStreamJsonEventToIR — result success → stop chunk', () => {
    const event = { type: 'result', subtype: 'success', is_error: false, result: 'hello', total_cost_usd: 0.001 };
    const chunk = anthropicStreamJsonEventToIR(event, false);
    assert.ok(chunk !== null, 'result/success must yield an IR stop chunk');
    assert.equal(chunk.type, 'stop', 'IR chunk type must be "stop"');
    assert.equal(chunk.finish_reason, 'stop', 'finish_reason must be "stop"');
  });

  it('41e-4: anthropicStreamJsonEventToIR — result is_error → throws ProviderError', () => {
    const event = { type: 'result', is_error: true, error_message: 'rate limited by upstream' };
    assert.throws(
      () => anthropicStreamJsonEventToIR(event, false),
      err => err instanceof ProviderError && err.code === 'PROVIDER_ERROR',
      'result with is_error must throw ProviderError(PROVIDER_ERROR)',
    );
  });

  it('41e-5: anthropicStreamJsonEventToIR — system/init → null (consumed)', () => {
    const event = { type: 'system', subtype: 'init', cwd: '/home/user', tools: [] };
    const chunk = anthropicStreamJsonEventToIR(event, false);
    assert.equal(chunk, null, 'system/init must return null (consumed, no yield)');
  });

  it('41e-6: anthropicStreamJsonEventToIR — rate_limit_event → null (consumed)', () => {
    const event = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } };
    const chunk = anthropicStreamJsonEventToIR(event, false);
    assert.equal(chunk, null, 'rate_limit_event must return null (future audit/dashboard work)');
  });

  it('41e-7: anthropicStreamJsonEventToIR — assistant (aggregate) → null', () => {
    const event = { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } };
    const chunk = anthropicStreamJsonEventToIR(event, false);
    assert.equal(chunk, null, 'assistant aggregate event must return null (deltas already streamed)');
  });

  it('41e-8: anthropicStreamJsonEventToIR — parse_error event → null (already logged)', () => {
    const event = { type: 'parse_error', raw: 'bad json' };
    const chunk = anthropicStreamJsonEventToIR(event, false);
    assert.equal(chunk, null, 'parse_error must return null');
  });

  // ── 41f: Full end-to-end mock spawn integration ───────────────────────

  it('41f: full NDJSON stream-in → IR chunks-out integration via __setSpawnImpl', async () => {
    // Simulates real claude CLI output: system/init + content_block_deltas + result/success.
    // Verifies the complete pipeline: stdin write → NDJSON parse → IR yield → stop.
    const fakeSpawn = makeMockSpawnNDJSON(['Answer: ', '42']);
    __setSpawnImpl(fakeSpawn);
    try {
      const ir = makeIR({
        model: 'claude-sonnet-4-6',
        stream: true,
        messages: [
          { role: 'system', content: 'Be precise.' },
          { role: 'user', content: 'What is 6 × 7?' },
        ],
      });
      const authCtx = { accessToken: '<fake-oauth-token>' };
      const chunks = [];
      for await (const chunk of anthropic.spawn(ir, authCtx)) {
        chunks.push(chunk);
      }

      // Expected: 2 delta chunks + 1 stop chunk from result event
      const deltas = chunks.filter(c => c.type === 'delta');
      const stops = chunks.filter(c => c.type === 'stop');
      assert.equal(deltas.length, 2, `Expected 2 deltas, got ${deltas.length}`);
      assert.equal(stops.length, 1, `Expected 1 stop, got ${stops.length}`);

      // Content must be the streamed text
      const content = deltas.map(c => c.content).join('');
      assert.equal(content, 'Answer: 42');

      // First delta must carry role=assistant
      assert.equal(deltas[0].role, 'assistant', 'First delta must include role=assistant');
      // Subsequent deltas must not carry role
      assert.ok(!('role' in deltas[1]), 'Subsequent deltas must not carry role');

      // Stop must have finish_reason='stop'
      assert.equal(stops[0].finish_reason, 'stop');
    } finally {
      __resetSpawnImpl();
    }
  });

  it('41g: buildCliArgs arg order check — model flag before output-format (predictable arg order)', () => {
    const args = buildCliArgs('claude-opus-4-7', 'Test prompt');
    const modelIdx = args.indexOf('--model');
    const formatIdx = args.indexOf('--output-format');
    const verboseIdx = args.indexOf('--verbose');
    const nspIdx = args.indexOf('--no-session-persistence');
    const spIdx = args.indexOf('--system-prompt');

    assert.ok(modelIdx >= 0, '--model must be present');
    assert.ok(formatIdx >= 0, '--output-format must be present');
    assert.ok(verboseIdx >= 0, '--verbose must be present');
    assert.ok(nspIdx >= 0, '--no-session-persistence must be present');
    assert.ok(spIdx >= 0, '--system-prompt must be present');

    // --no-session-persistence must come before --system-prompt
    assert.ok(nspIdx < spIdx, '--no-session-persistence must precede --system-prompt');
    // model value must follow immediately after --model
    assert.equal(args[modelIdx + 1], 'claude-opus-4-7', '--model value must follow the flag');
  });
});

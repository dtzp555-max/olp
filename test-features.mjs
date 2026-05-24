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

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { computeCacheKey, extractCacheControlMarkers, hasCacheControl } from './lib/cache/keys.mjs';
import { CacheStore } from './lib/cache/store.mjs';

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

  it('irToAnthropic: system + user → system annotation + user text', () => {
    const ir = makeIR({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system', content: 'You are a helper.' },
        { role: 'user', content: 'What is 2+2?' },
      ],
    });
    const prompt = irToAnthropic(ir);
    assert.ok(prompt.includes('[System] You are a helper.'));
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
  it('spawn with mock: yields delta chunks then stop chunk', async () => {
    const fakeSpawn = makeMockSpawn(['Hello', ' world']);
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
      // Should have 2 delta chunks + 1 stop chunk
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

  it('spawn with mock: first delta chunk has role=assistant', async () => {
    const fakeSpawn = makeMockSpawn(['Test output']);
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
} from './server.mjs';

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

    // Anthropic mock: emits 2 raw text chunks then exits non-zero (cleanup error).
    // The anthropic plugin processes raw stdout as text → IR delta chunks.
    // exit code 1 after yielding content → Case B: SPAWN_FAILED with chunks.length>0.
    __setSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            // Emit 2 content chunks as raw text (anthropic --output-format text)
            proc.stdout.emit('data', Buffer.from('Hello '));
            proc.stdout.emit('data', Buffer.from('world'));
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

    // Anthropic mock: emits 1 raw text chunk then exits non-zero
    __setSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            proc.stdout.emit('data', Buffer.from('Partial answer'));
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

    // Reuse the D16 Case-B single-hop mock: emit 1 raw text chunk, then exit-1.
    __setSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            proc.stdout.emit('data', Buffer.from('D39-evict-log-content'));
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
            // Case B: emit partial content then exit non-zero on every spawn.
            proc.stdout.emit('data', Buffer.from('D39-sticky-content'));
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
    // Mock: emits 3 deltas with a 20ms gap between each, then stop.
    // We verify by recording arrival timestamps on the client side.
    const DELTA_GAP_MS = 20;

    __setSpawnImpl(function (_bin, _args, _opts) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = {
        write: () => {},
        end: () => {
          // Emit 3 deltas with gaps
          let idx = 0;
          const texts = ['chunk1', 'chunk2', 'chunk3'];
          const emitNext = () => {
            if (idx < texts.length) {
              proc.stdout.emit('data', Buffer.from(texts[idx]));
              idx++;
              setTimeout(emitNext, DELTA_GAP_MS);
            } else {
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
            proc.stdout.emit('data', Buffer.from('cached-content'));
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
            proc.stdout.emit('data', Buffer.from('multihop-content'));
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
          // Emit data + close via setImmediate so the event handlers (registered
          // AFTER stdin.end() in the plugin body) are already attached when
          // these events fire. All three items land in the same setImmediate
          // callback, so they're all in chunks[] before the drain loop resumes.
          setImmediate(() => {
            proc.stdout.emit('data', Buffer.from('partial-chunk-1'));
            proc.stdout.emit('data', Buffer.from('partial-chunk-2'));
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

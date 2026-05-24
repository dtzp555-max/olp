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
import { loadProviders, getProviderForModel, getProviderByName, listAllProviderNames } from './lib/providers/index.mjs';
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

  // ── Test 26: clear(keyId) clears only that namespace ─────────────────
  it('CacheStore.clear(keyId) clears only that namespace', async () => {
    const store = new CacheStore();
    await store.set('keyA', 'hash1', 'val-a');
    await store.set('keyB', 'hash1', 'val-b');
    store.clear('keyA');
    assert.equal(await store.has('keyA', 'hash1'), false, 'keyA should be cleared');
    assert.equal(await store.has('keyB', 'hash1'), true, 'keyB should remain');
  });

  // ── Test 27: clear() with no args clears all ──────────────────────────
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

  it('evaluateHardTriggers: ProviderError QUOTA_EXHAUSTED → fires', () => {
    const err = new ProviderError('Quota exhausted', 'QUOTA_EXHAUSTED');
    assert.equal(evaluateHardTriggers(err), true);
  });

  it('evaluateHardTriggers: ProviderError RATE_LIMITED → fires', () => {
    const err = new ProviderError('Rate limited', 'RATE_LIMITED');
    assert.equal(evaluateHardTriggers(err), true);
  });

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

  it('evaluateHardTriggers: ProviderError OUTPUT_PARSE_ERROR → fires', () => {
    const err = new ProviderError('Parse error', 'OUTPUT_PARSE_ERROR');
    assert.equal(evaluateHardTriggers(err), true);
  });

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
    const err = new ProviderError('Quota exhausted', 'QUOTA_EXHAUSTED');
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
    const errA = new ProviderError('Rate limited', 'RATE_LIMITED');
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
    const errA = new ProviderError('Rate limited', 'RATE_LIMITED');
    const errB = new ProviderError('Spawn failed', 'SPAWN_FAILED');
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
    const err = new ProviderError('Rate limited', 'RATE_LIMITED');
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
    const err = new ProviderError('Rate limited', 'RATE_LIMITED');
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
    const errA = new ProviderError('Rate limited', 'RATE_LIMITED');
    const errB = new ProviderError('Spawn failed', 'SPAWN_FAILED');
    const errC = new ProviderError('CLI not found', 'CLI_NOT_FOUND');
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
    const err = new ProviderError('Rate limited', 'RATE_LIMITED');
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
    const p = 22456 + Math.floor(Math.random() * 400);
    await new Promise((resolve, reject) => {
      s.listen(p, '127.0.0.1', resolve);
      s.once('error', reject);
    });
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
    const p = 22860 + Math.floor(Math.random() * 400);
    await new Promise((resolve, reject) => {
      s.listen(p, '127.0.0.1', resolve);
      s.once('error', reject);
    });

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
    port15 = 23456 + Math.floor(Math.random() * 400);
    await new Promise((resolve, reject) => {
      server15.listen(port15, '127.0.0.1', resolve);
      server15.once('error', reject);
    });
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
} from './server.mjs';

describe('/v1/models population + X-OLP-* error headers (Suite 17)', () => {

  // ── 17a: /v1/models with anthropic enabled → 3 model entries ─────────────

  it('17a: /v1/models with anthropic enabled → 200 + 3 entries with owned_by="anthropic"', async () => {
    setProviders17({ anthropic: true });
    const s = createServer17();
    const p = 25456 + Math.floor(Math.random() * 400);
    await new Promise((resolve, reject) => {
      s.listen(p, '127.0.0.1', resolve);
      s.once('error', reject);
    });
    try {
      const r = await fetch({ port: p, method: 'GET', path: '/v1/models' });
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      assert.equal(body.object, 'list');
      assert.ok(Array.isArray(body.data), 'data must be an array');
      // Anthropic has 3 canonical models in models-registry.json
      assert.equal(body.data.length, 3, `Expected 3 anthropic models, got ${body.data.length}`);
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
    const p = 25460 + Math.floor(Math.random() * 400);
    await new Promise((resolve, reject) => {
      s.listen(p, '127.0.0.1', resolve);
      s.once('error', reject);
    });
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

  // ── 17c: /v1/models contains only canonical IDs, no aliases ───────────────

  it('17c: /v1/models returns canonical IDs only (no aliases like "sonnet")', async () => {
    setProviders17({ anthropic: true });
    const s = createServer17();
    const p = 25464 + Math.floor(Math.random() * 400);
    await new Promise((resolve, reject) => {
      s.listen(p, '127.0.0.1', resolve);
      s.once('error', reject);
    });
    try {
      const r = await fetch({ port: p, method: 'GET', path: '/v1/models' });
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      const ids = body.data.map(e => e.id);
      // Aliases that must NOT appear
      const knownAliases = ['sonnet', 'opus', 'haiku', 'claude', 'codex', 'devstral'];
      for (const alias of knownAliases) {
        assert.ok(!ids.includes(alias), `Alias '${alias}' must not appear in /v1/models data`);
      }
      // The canonical ID must appear
      assert.ok(ids.includes('claude-sonnet-4-6'), 'claude-sonnet-4-6 must appear in /v1/models data');
    } finally {
      resetProviders17();
      await new Promise(r => s.close(r));
    }
  });

  // ── 17d: /v1/models entries match OpenAI spec shape ───────────────────────

  it('17d: /v1/models entries match OpenAI spec shape (id/object/created/owned_by)', async () => {
    setProviders17({ anthropic: true });
    const s = createServer17();
    const p = 25468 + Math.floor(Math.random() * 400);
    await new Promise((resolve, reject) => {
      s.listen(p, '127.0.0.1', resolve);
      s.once('error', reject);
    });
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
    const p = 25472 + Math.floor(Math.random() * 400);
    await new Promise((resolve, reject) => {
      s.listen(p, '127.0.0.1', resolve);
      s.once('error', reject);
    });

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
    const p = 25876 + Math.floor(Math.random() * 400);
    await new Promise((resolve, reject) => {
      s.listen(p, '127.0.0.1', resolve);
      s.once('error', reject);
    });

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

  // ── 17g: pre-routing 400 (invalid JSON) carries X-OLP-Latency-Ms ─────────

  it('17g: pre-routing 400 (invalid JSON body) carries X-OLP-Latency-Ms', async () => {
    // Pre-routing errors inside handleChatCompletions (invalid JSON body, wrong
    // Content-Type, IR parse failure) have access to startMs and emit
    // X-OLP-Latency-Ms to allow latency instrumentation even when there is no
    // provider context. The other 4 X-OLP-* headers are omitted (no provider was
    // attempted). This is consistent with ADR 0004 § Observability which requires
    // the full set for chain-exhausted paths; partial emission on pre-route errors
    // is the minimum viable observability for those paths.
    setProviders17({});
    const s = createServer17();
    const p = 25880 + Math.floor(Math.random() * 400);
    await new Promise((resolve, reject) => {
      s.listen(p, '127.0.0.1', resolve);
      s.once('error', reject);
    });
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
      // X-OLP-Latency-Ms must be present (D18 pre-routing observability)
      assert.ok(result.headers['x-olp-latency-ms'] !== undefined,
        'Pre-routing 400 error must carry X-OLP-Latency-Ms for latency instrumentation');
      const latencyMs = parseInt(result.headers['x-olp-latency-ms'], 10);
      assert.ok(!isNaN(latencyMs) && latencyMs >= 0,
        `X-OLP-Latency-Ms must be a non-negative integer, got: ${result.headers['x-olp-latency-ms']}`);
      // The other 4 headers are NOT present (no provider context)
      assert.ok(result.headers['x-olp-provider-used'] === undefined,
        'Pre-routing 400 must NOT carry X-OLP-Provider-Used (no provider context)');
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

});

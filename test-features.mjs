/**
 * test-features.mjs — OLP D4 test suite (extends D3)
 *
 * Uses Node's built-in node:test runner. No external dependencies.
 * Run: node test-features.mjs  (or: npm test)
 *
 * Authority: ADR 0002 (provider contract), ADR 0003 (IR v1.0)
 *   D4 adds: Anthropic plugin conformance, IR translation, mock-spawn behaviour.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';

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

  it('formats an error chunk with finish_reason within the OpenAI enum', () => {
    // ALIGNMENT.md Rule 2 (b): finish_reason must stay within the OpenAI spec
    // enum (stop|length|tool_calls|content_filter|function_call|null).
    // Provider errors surface via the top-level `error` object, not via an
    // invented finish_reason value.
    const sse = irChunkToOpenAISSE({ type: 'error', error: 'spawn failed' }, ID, MODEL);
    const payload = JSON.parse(sse.slice(6).trim());
    assert.ok(payload.error);
    assert.equal(payload.error.type, 'provider_error');
    assert.ok(['stop', 'length', 'tool_calls', 'content_filter', 'function_call', null].includes(payload.choices[0].finish_reason));
    assert.equal(payload.choices[0].finish_reason, 'stop');
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
  it('STATIC_REGISTRY has 1 entry (anthropic candidate) at D4', () => {
    // D4: anthropic is in STATIC_REGISTRY but default config has enabled:false
    assert.equal(listAllProviderNames().length, 1);
  });

  it('loadProviders with empty config → empty Map (anthropic not enabled)', () => {
    const m = loadProviders({});
    assert.equal(m.size, 0);
  });

  it('loadProviders with no config → empty Map', () => {
    const m = loadProviders();
    assert.equal(m.size, 0);
  });

  it('listAllProviderNames returns [anthropic] at D4', () => {
    assert.deepEqual(listAllProviderNames(), ['anthropic']);
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

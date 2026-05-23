/**
 * test-features.mjs — OLP D3 test suite
 *
 * Uses Node's built-in node:test runner. No external dependencies.
 * Run: node test-features.mjs  (or: npm test)
 *
 * Authority: ADR 0002 (provider contract), ADR 0003 (IR v1.0)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';

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
import { loadProviders, getProviderForModel, listAllProviderNames } from './lib/providers/index.mjs';

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

/** Minimal valid provider stub that satisfies the v1.0 contract */
function makeProvider(overrides = {}) {
  return {
    name: 'stub',
    displayName: 'Stub Provider',
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
  it('empty STATIC_REGISTRY → loadProviders returns empty Map', () => {
    const m = loadProviders({});
    assert.equal(m.size, 0);
  });

  it('loadProviders with no config → empty Map', () => {
    const m = loadProviders();
    assert.equal(m.size, 0);
  });

  it('listAllProviderNames returns empty array at D3', () => {
    assert.deepEqual(listAllProviderNames(), []);
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
});

// ── Suite 6: HTTP integration tests ──────────────────────────────────────

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

/**
 * lib/providers/anthropic.mjs — Anthropic Claude provider plugin
 *
 * Authority: OLP ALIGNMENT.md § Authority 1 — anthropic plugin governed by
 *   `claude -p` from `@anthropic-ai/claude-code`.
 *   OCP server.mjs inherits cli.js 2.1.89 audit pin at fork (per ALIGNMENT.md
 *   § Provider authority pins).
 *
 * Spawn pattern ported from:
 *   OCP server.mjs:384-414  (buildCliArgs — -p / --model / --output-format / --no-session-persistence)
 *   OCP server.mjs:480-607  (spawnClaudeProcess — env cleanup, spawn, stdin write)
 *   OCP server.mjs:422-468  (messagesToPrompt — text serialization)
 *
 * Auth reading ported from:
 *   OCP server.mjs:864-888  (getOAuthCredentials — env → .credentials.json → keychain)
 *   OCP server.mjs:531-534  (env cleanup: delete ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL,
 *                             ANTHROPIC_AUTH_TOKEN before spawn)
 *
 * Contract version: 1.0 (ADR 0002 § "Provider contract (v1.0 interface)" + D4 contractVersion fold-in)
 *
 * Status at D4: CANDIDATE. Not yet Enabled per ALIGNMENT.md § Provider Inventory.
 * The plugin is present in STATIC_REGISTRY but enabled: false is the default config.
 * POST /v1/chat/completions continues to return 503 until D5 flips the enabled flag
 * in ~/.olp/config.json after E2E audit passes.
 *
 * Lossy translations (per ADR 0003 § "Lossy-translation documentation requirement"):
 *   - `response_format: json_object` — Anthropic `claude -p` does not natively honor this
 *     field; a system-prompt augmentation is injected ("Reply with valid JSON only.").
 *   - `top_p` — not mapped to a `claude -p` flag; dropped silently. `claude -p` does not
 *     expose --top-p.
 *   - `tool_choice: "required"` — not a `claude -p` flag; dropped.
 *   - Request-level `tools[]` — `claude -p --output-format text` is a text-in/text-out
 *     CLI and does not consume structured tool definitions on the wire. The array is
 *     silently dropped; if a caller wants tool-use they should pre-prompt the model
 *     about the tools in the system message. ALIGNMENT.md Rule 2 forbids inventing
 *     a wire format Anthropic's CLI does not accept.
 *   - Assistant-message `tool_calls` and `tool_call_id` (IR messages representing prior
 *     turns where the assistant invoked a tool) — same reason as above; dropped.
 *     If a multi-turn conversation includes tool-call history, the textual content is
 *     preserved but the structured call metadata is lost.
 *
 * Quota status: null at D4. Anthropic does not expose a programmatic quota endpoint.
 *   TODO(2026-06-16): one-shot audit per ALIGNMENT.md § One-shot Triggered Audits.
 *   After 2026-06-15 Agent SDK Credit billing split takes effect, re-evaluate whether
 *   a programmatic credit-pool balance API exists and pin it here if found.
 */

import { spawn as defaultSpawn } from 'node:child_process';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ProviderError, PROVIDER_ERROR_CODES } from './base.mjs';

// ── Binary resolution ─────────────────────────────────────────────────────
// OLP_CLAUDE_BIN env takes priority, then falls back to 'claude' from PATH.
// Ported from OCP server.mjs:87-123 (resolveClaude) — simplified for plugin
// scope (OCP's multi-path nvm/fnm/asdf resolution is omitted; OLP plugins
// use the simpler env-override-first pattern and rely on PATH for the rest).
//
// OCP server.mjs:88: if (process.env.CLAUDE_BIN) { ... return process.env.CLAUDE_BIN; }
// OLP uses OLP_CLAUDE_BIN to avoid colliding with OCP's CLAUDE_BIN if both are
// installed on the same machine.
function resolveClaudeBin() {
  return process.env.OLP_CLAUDE_BIN || 'claude';
}

// ── Auth artifact reading ─────────────────────────────────────────────────
// Ported from OCP server.mjs:864-888 (getOAuthCredentials).
// Priority order (matching OCP exactly):
//   1. CLAUDE_CODE_OAUTH_TOKEN env var — explicit override, highest precedence
//   2. ~/.claude/.credentials.json (Linux file-based path)
//   3. macOS keychain via `security find-generic-password`
//      Both label formats tried: "claude-code-credentials" and "Claude Code-credentials"
//
// Returns { accessToken, refreshToken?, expiresAt? } or null.
// Throws nothing — null means "not found, try next".
export function readAuthArtifact() {
  // 1. Env var — OCP server.mjs:866-868
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { accessToken: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  }

  // 2. Linux/cross-platform file-based credentials — OCP server.mjs:871-875
  // Note: OCP uses ~/.claude/.credentials.json (dot-prefix), not ~/.claude/credentials.json.
  // This matches the actual path Claude Code writes to.
  try {
    const credPath = join(homedir(), '.claude', '.credentials.json');
    const raw = readFileSync(credPath, 'utf8');
    const creds = JSON.parse(raw);
    if (creds?.claudeAiOauth?.accessToken) return creds.claudeAiOauth;
  } catch { /* fall through */ }

  // 3. macOS keychain — OCP server.mjs:877-885
  // Only attempted on darwin to avoid shell-out overhead on other platforms.
  if (process.platform === 'darwin') {
    for (const label of ['claude-code-credentials', 'Claude Code-credentials']) {
      try {
        const raw = execFileSync('security', [
          'find-generic-password', '-s', label, '-w',
        ], { encoding: 'utf8', timeout: 5000 }).trim();
        const creds = JSON.parse(raw);
        if (creds?.claudeAiOauth?.accessToken) return creds.claudeAiOauth;
      } catch { /* try next */ }
    }
  }

  return null;
}

// ── IR → prompt text serialization ───────────────────────────────────────
// OCP server.mjs:422-468 (messagesToPrompt) — no session management in OLP;
// we always pass the full serialized messages as stdin to `claude -p`.
//
// `claude -p` reads its prompt from stdin when no prompt argument is given.
// OCP server.mjs:542 confirms: `proc.stdin.write(prompt); proc.stdin.end();`
// The format OCP uses is: system → "[System] <text>", assistant → "[Assistant] <text>",
// user → raw text. We port the same format.
//
// ADR 0003 § Translation direction model: the plugin owns irToNative.
export function irToAnthropic(irRequest) {
  const parts = [];

  for (const msg of irRequest.messages) {
    const text = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content);

    if (msg.role === 'system') {
      parts.push(`[System] ${text}`);
    } else if (msg.role === 'assistant') {
      parts.push(`[Assistant] ${text}`);
    } else if (msg.role === 'tool') {
      // Tool result — pass as annotated user turn so the model knows it's a tool response.
      const nameAnnotation = msg.name ? ` (${msg.name})` : '';
      parts.push(`[Tool Result${nameAnnotation}] ${text}`);
    } else {
      // user
      parts.push(text);
    }
  }

  // Lossy: response_format json_object → system-prompt augmentation.
  // ADR 0003 § Lossy-translation documentation requirement.
  if (irRequest.response_format?.type === 'json_object') {
    parts.unshift('[System] Reply with valid JSON only. Do not include any prose outside the JSON structure.');
  }

  return parts.join('\n\n');
}

// ── Anthropic SSE chunk → IR ResponseChunk ────────────────────────────────
// `claude -p --output-format text` emits raw text to stdout (not NDJSON/SSE).
// This matches OCP server.mjs:735-748: each `proc.stdout.on('data', d => ...)` chunk
// is raw text content — no JSON envelope. The plugin converts raw text chunks to
// IR delta chunks, and produces a synthetic stop chunk at close.
//
// For streaming: each text chunk → IRResponseChunk { type: 'delta', content: <text> }
// For non-streaming: the full accumulated stdout → single text → emit delta + stop.
//
// `claude -p --output-format json` would emit a JSON envelope, but OCP uses `text`
// (OCP server.mjs:385: "--output-format", "text"), so we port the same.
export function anthropicChunkToIR(rawText, isFirstChunk = false) {
  return {
    type: 'delta',
    ...(isFirstChunk && { role: 'assistant' }),
    content: rawText,
  };
}

// Synthesize the stop chunk (called at proc.on('close', ...) with code 0).
export function anthropicStopToIR(finishReason = 'stop') {
  return {
    type: 'stop',
    finish_reason: finishReason,
  };
}

// ── CLI args builder ──────────────────────────────────────────────────────
// Ported from OCP server.mjs:384-414 (buildCliArgs), stripped of session
// management (OLP is stateless per AGENTS.md § "No conversation state").
//
// OCP server.mjs:385: const args = ["-p", "--model", cliModel, "--output-format", "text"];
// OCP server.mjs:392: args.push("--no-session-persistence");  // when no sessionInfo
// OCP server.mjs:395-400: --dangerously-skip-permissions or --allowedTools
//
// OLP variant: always --no-session-persistence (stateless). No permissions flags at D4.
function buildCliArgs(model) {
  return [
    '-p',
    '--model', model,
    '--output-format', 'text',
    '--no-session-persistence',
  ];
}

// ── Env cleanup ───────────────────────────────────────────────────────────
// OCP server.mjs:531-534: deletes ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL,
// ANTHROPIC_AUTH_TOKEN before spawn to prevent env-level override collisions
// with the OAuth token the CLI manages internally.
// OCP server.mjs:530: const env = { ...process.env };
function buildSpawnEnv() {
  const env = { ...process.env };
  // OCP server.mjs:531: delete env.CLAUDECODE;
  delete env.CLAUDECODE;
  // OCP server.mjs:532: delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  // OCP server.mjs:533: delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_BASE_URL;
  // OCP server.mjs:534: delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

// ── Spawn function (core) ─────────────────────────────────────────────────
// Returns an AsyncIterator<IRResponseChunk> per ADR 0002 § Provider contract.
// `spawnImpl` is swappable for tests (dependency injection, no real binary needed).
//
// OCP server.mjs:542: const proc = spawn(CLAUDE, cliArgs, { env, stdio: ["pipe", "pipe", "pipe"] });
// OCP server.mjs:586-587: proc.stdin.write(prompt); proc.stdin.end();
async function* _spawnAndStream(irRequest, authContext, spawnImpl) {
  const auth = authContext ?? readAuthArtifact();
  if (!auth?.accessToken) {
    throw new ProviderError(
      'No Anthropic OAuth token found. Run `claude auth login` or set CLAUDE_CODE_OAUTH_TOKEN.',
      'AUTH_MISSING',
    );
  }

  const bin = resolveClaudeBin();
  const args = buildCliArgs(irRequest.model);
  const env = buildSpawnEnv();

  // Inject OAuth token so the CLI can authenticate.
  // OCP server.mjs:864-888: the token is read from keychain/.credentials.json/env
  // and passed as CLAUDE_CODE_OAUTH_TOKEN for the spawn invocation.
  // We set it explicitly here so the plugin is self-contained.
  env.CLAUDE_CODE_OAUTH_TOKEN = auth.accessToken;

  const prompt = irToAnthropic(irRequest);

  // OCP server.mjs:542: spawn(CLAUDE, cliArgs, { env, stdio: ["pipe", "pipe", "pipe"] })
  const proc = spawnImpl(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });

  // OCP server.mjs:586-587: proc.stdin.write(prompt); proc.stdin.end();
  proc.stdin.write(prompt);
  proc.stdin.end();

  // Yield IR chunks as they arrive from stdout.
  let isFirstChunk = true;
  let accumulatedStderr = '';

  // Convert proc events to an async generator using a push-buffer + signal approach.
  const chunks = [];
  let done = false;
  let exitCode = null;
  let exitSignal = null;
  let resolveNext = null;
  // timeout: tracks a pending rejectNext for spawn timeout
  let rejectNext = null;

  function push(item) {
    chunks.push(item);
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      rejectNext = null;
      r();
    }
  }

  proc.stdout.on('data', (d) => {
    const text = d.toString();
    push({ type: 'data', text });
  });

  proc.stderr.on('data', (d) => {
    accumulatedStderr += d.toString();
  });

  proc.on('error', (err) => {
    push({ type: 'error', err });
  });

  proc.on('close', (code, signal) => {
    exitCode = code;
    exitSignal = signal;
    done = true;
    push({ type: 'close' });
  });

  // ADR 0004 § Trigger taxonomy bullet 4: spawn timeout is a hard trigger.
  // maxSpawnTimeMs: from hints field so tests can lower it without changing the plugin.
  // Default: 600 000 ms (10 minutes) — reasonable for long Claude outputs.
  const maxSpawnTimeMs = anthropic.hints?.maxSpawnTimeMs ?? 600_000;

  // Overall wall-clock deadline — fires if the process hasn't closed in time.
  let spawnTimedOut = false;
  const spawnDeadlineTimer = setTimeout(() => {
    spawnTimedOut = true;
    // Kill the process and wake up the drain loop via a rejection.
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    if (rejectNext) {
      const r = rejectNext;
      rejectNext = null;
      resolveNext = null;
      r(new ProviderError(
        `claude spawn timed out after ${maxSpawnTimeMs}ms`,
        'SPAWN_TIMEOUT',
      ));
    }
  }, maxSpawnTimeMs);

  // Drain the chunk buffer
  try {
    while (true) {
      if (chunks.length === 0) {
        if (done) break;
        if (spawnTimedOut) {
          throw new ProviderError(
            `claude spawn timed out after ${maxSpawnTimeMs}ms`,
            'SPAWN_TIMEOUT',
          );
        }
        // Wait for the next event (or timeout rejection)
        await new Promise((resolve, reject) => {
          resolveNext = resolve;
          rejectNext = reject;
        });
        continue;
      }

      const item = chunks.shift();

      if (item.type === 'error') {
        throw new ProviderError(`claude spawn error: ${item.err.message}`, 'SPAWN_FAILED');
      }

      if (item.type === 'close') {
        break;
      }

      if (item.type === 'data') {
        yield anthropicChunkToIR(item.text, isFirstChunk);
        isFirstChunk = false;
      }
    }
  } finally {
    clearTimeout(spawnDeadlineTimer);
  }

  // Process close
  if (exitCode !== 0 && !spawnTimedOut) {
    const errMsg = accumulatedStderr.slice(0, 300) || `claude exit ${exitCode}`;
    // Map known exit patterns to IR error chunk, then throw
    throw new ProviderError(errMsg, 'SPAWN_FAILED');
  }

  // Normal exit: emit stop chunk
  if (!spawnTimedOut) {
    yield anthropicStopToIR('stop');
  }
}

// ── spawn (public, contract method) ──────────────────────────────────────
// The public spawn method conforms to ADR 0002 § Provider contract:
//   spawn: async (irRequest, authContext) => AsyncIterator<ResponseChunk>
//
// The `_spawnImpl` field is the injection point for tests.
// Tests set `anthropic._spawnImpl = mockSpawn` before calling `anthropic.spawn()`.
let _spawnImpl = defaultSpawn;

export async function* spawn(irRequest, authContext) {
  yield* _spawnAndStream(irRequest, authContext, _spawnImpl);
}

// Test hook: allows tests to inject a mock spawn without importing child_process.
// Set anthropic._spawnImpl = mockFn before calling spawn(); reset after.
export { _spawnImpl };
export function __setSpawnImpl(impl) { _spawnImpl = impl; }
export function __resetSpawnImpl() { _spawnImpl = defaultSpawn; }

// ── estimateCost ──────────────────────────────────────────────────────────
// Best-effort token estimation using the chars/4 heuristic.
// Basis: OpenAI Cookbook "How to count tokens" rule-of-thumb: ~4 characters per token
// for English prose. This is approximate; actual tokenization differs per model.
// Reference: https://cookbook.openai.com/examples/how_to_count_tokens_with_tiktoken
//
// usd: null at D4 — Anthropic per-million-token rates not yet pinned.
// TODO: populate usd once rates are confirmed post-2026-06-15 billing-split audit.
export function estimateCost(request) {
  if (!request?.messages) return null;

  let inputChars = 0;
  for (const msg of request.messages) {
    const text = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content);
    inputChars += text.length;
  }

  // Rough output estimate: assume response is ~50% of input length.
  const outputCharsEstimate = Math.ceil(inputChars * 0.5);

  return {
    inputTokens: Math.ceil(inputChars / 4),
    outputTokensEstimate: Math.ceil(outputCharsEstimate / 4),
    currency: 'USD',
    usd: null, // not pinned at D4
  };
}

// ── quotaStatus ───────────────────────────────────────────────────────────
// Returns null at D4. Anthropic does not expose a programmatic quota endpoint.
// TODO(2026-06-16 one-shot audit per ALIGNMENT.md § One-shot Triggered Audits):
// After the 2026-06-15 Agent SDK Credit billing-split takes effect, check whether
// the Agent SDK Credit pool exposes a balance/usage API endpoint. If it does,
// implement here and update this comment with the endpoint URL + version pin.
export async function quotaStatus(_authContext) {
  return null;
}

// ── healthCheck ───────────────────────────────────────────────────────────
// Does NOT spawn a real claude -p request (deferred to D5 E2E audit).
// Checks: (1) binary exists, (2) auth artifact exists.
// Ported from OCP server.mjs:363-377 (checkAuth) — simplified to existence
// checks only; no live execution (per D4 spec constraint).
export async function healthCheck({ _binaryExistsFn, _authReadFn } = {}) {
  const t0 = Date.now();

  // 1. Binary check
  const binaryExists = _binaryExistsFn ?? _defaultBinaryExists;
  if (!binaryExists()) {
    return { ok: false, latencyMs: Date.now() - t0, error: 'claude binary not found' };
  }

  // 2. Auth artifact check
  const authRead = _authReadFn ?? readAuthArtifact;
  const auth = authRead();
  if (!auth?.accessToken) {
    return { ok: false, latencyMs: Date.now() - t0, error: 'auth artifact missing' };
  }

  return { ok: true, latencyMs: Date.now() - t0 };
}

function _defaultBinaryExists() {
  const bin = resolveClaudeBin();
  if (bin !== 'claude') {
    // Explicit path given — check directly
    return existsSync(bin);
  }
  // 'claude' from PATH — use which
  try {
    execSync('which claude', { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

// ── Provider export ───────────────────────────────────────────────────────
// Conforms to ADR 0002 § "Provider contract (v1.0 interface)" including D4
// contractVersion fold-in per reviewer F3.

import modelsRegistryRaw from '../../models-registry.json' with { type: 'json' };

const _registryModels = (modelsRegistryRaw?.providers?.anthropic?.models ?? []).map(m => m.id);

const anthropic = {
  name: 'anthropic',
  displayName: 'Anthropic Claude',
  contractVersion: '1.0',
  models: _registryModels,
  auth: {
    type: 'oauth',
    storage: 'keychain',
    // Portable path via os.homedir() per hygiene requirement
    path: join(homedir(), '.claude', '.credentials.json'),
    refresh: 'auto',
  },
  spawn,
  estimateCost,
  quotaStatus,
  healthCheck,
  hints: {
    requiresTTY: false,
    concurrentSpawnSafe: true,
    maxConcurrent: 4,
    // ADR 0004 § Trigger taxonomy bullet 4: spawn timeout is a hard trigger.
    // 600_000ms = 10 minutes. Tests can lower this by mutating anthropic.hints.maxSpawnTimeMs.
    maxSpawnTimeMs: 600_000,
  },
};

export default anthropic;

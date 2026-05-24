/**
 * lib/providers/codex.mjs — OpenAI Codex provider plugin
 *
 * Authority: OLP ALIGNMENT.md § Authority 1 — openai plugin governed by
 *   `codex exec --json` from `@openai/codex` CLI.
 *
 * Governing ADRs:
 *   ADR 0002 — Plugin architecture, Provider contract v1.0
 *   ADR 0003 — IR design, lossy-translation documentation requirement
 *   ADR 0006 — OpenAI Codex classified Tier D (permissive, Candidate eligible)
 *              Authority pin: Codex GitHub Discussion #8338 (maintainer
 *              confirmed permissive OSS-project posture; not a formal ToS
 *              blessing — see ADR 0006 § Classification table, row "OpenAI Codex").
 *
 * Status at D6: CANDIDATE. Not yet Enabled per ALIGNMENT.md § Provider Inventory.
 * The plugin is present in STATIC_REGISTRY but enabled: false is the default.
 * POST /v1/chat/completions returns 503 until D7 E2E audit passes and the
 * enabled flag is flipped in ~/.olp/config.json.
 *
 * ── Authority pin (D6) ──────────────────────────────────────────────────────
 *
 * Primary authority: Codex CLI reference page
 *   URL: https://developers.openai.com/codex/cli/reference
 *   Sections used:
 *     § "codex exec [flags] PROMPT" — exec subcommand syntax
 *     § "--json / --experimental-json" — NDJSON output flag
 *     § "--model, -m" — model override flag
 *     § "codex e [flags] PROMPT" — short-form alias
 *
 * Secondary authority (features page):
 *   URL: https://developers.openai.com/codex/cli/features
 *   Sections used:
 *     § "Supported Models" — gpt-5.5 as recommended frontier model,
 *       GPT-5.3-Codex-Spark as research-preview fast model
 *     § "Automation" — exec subcommand described for scripting
 *
 * Auth authority:
 *   URL: https://developers.openai.com/codex/cli/reference
 *   § "Authentication" — credentials stored in $CODEX_HOME (default: ~/.codex/)
 *   The exact auth.json field names (access_token, etc.) are not pinned by D6
 *   docs — see Assumption A4 below.
 *
 * ── Lossy translations (per ADR 0003 § Lossy-translation documentation) ────
 *
 *   - `top_p` — not mapped to a `codex exec` flag; dropped silently.
 *     The Codex CLI reference (§ flag list) does not expose --top-p.
 *     ALIGNMENT.md Rule 2 forbids inventing a flag not in the docs.
 *
 *   - `temperature` — not mapped; Codex CLI reference does not expose
 *     --temperature at the exec subcommand level. Dropped silently.
 *
 *   - `stop` (stop sequences) — not a `codex exec` flag; dropped.
 *
 *   - `max_tokens` — not a `codex exec` flag; dropped silently. The CLI
 *     does not expose a --max-tokens flag per the reference.
 *
 *   - `tools[]` + `tool_choice` — `codex exec --json` is a text-in / NDJSON-out
 *     CLI; structured tool definitions are not passed on the wire. Dropped.
 *     If a caller wants tool use, pre-prompt the model via system message.
 *     ALIGNMENT.md Rule 2 applies.
 *
 *   - Assistant-message `tool_calls` / `tool_call_id` (prior-turn metadata) —
 *     same reason as `tools[]`; structured metadata dropped, textual content
 *     preserved in prompt serialization.
 *
 *   - `response_format: json_object` — Codex CLI does not natively honor this
 *     field. A system-prompt augmentation is injected ("Reply with valid JSON
 *     only."), mirroring the Anthropic plugin's approach (ADR 0003 § Lossy).
 *
 * ── Codex NDJSON event type assumptions (D6) ────────────────────────────────
 *
 * The Codex CLI reference (§ "--json") states: "Outputs newline-delimited JSON
 * events rather than formatted text, enabling machine-readable progress
 * tracking." It does not enumerate specific event type schemas. D6 therefore
 * defines a defensive parsing convention (see codexChunkToIR) that:
 *   - Treats any line with a `content` string field as a delta event
 *   - Treats any line with `type === 'stop'` or `done === true` as a stop event
 *   - Treats any line with `error` field or `type === 'error'` as an error event
 *   - Silently ignores other events (progress, tool_call, shell, etc.)
 * D7 E2E will observe real events and correct this convention if wrong.
 *
 * ── Canonical Codex docs URLs (authority per ALIGNMENT.md Authority 1) ─────
 *   Reference: https://developers.openai.com/codex/cli/reference
 *   Features:  https://developers.openai.com/codex/cli/features
 *   Auth:      https://developers.openai.com/codex/auth/   (canonical for auth.json)
 *   Models:    https://developers.openai.com/codex/models  (canonical for accepted --model IDs)
 *
 * ── D6 spec assumptions (revised after D6 review-2) ─────────────────────────
 *
 * A1 (command shape — CONFIRMED): `codex exec --json --model <model> PROMPT`.
 *    Reference § "codex exec" states: "Use '-' to pipe the prompt from stdin."
 *    Stdin path uses `args.push('-')` followed by `proc.stdin.write(prompt)`.
 *    Earlier D6 draft used "no positional + write stdin" — corrected here per
 *    reviewer round-2 finding citing the canonical reference page.
 *
 * A2 (auth file — CONFIRMED): `~/.codex/auth.json` is the documented auth
 *    artifact path. Per https://developers.openai.com/codex/auth/ : "Codex
 *    caches login details locally in a plaintext file at ~/.codex/auth.json
 *    or in your OS-specific credential store." $CODEX_HOME env overrides the
 *    base dir. OPENAI_CODEX_AUTH_PATH overrides the full path for testing.
 *
 * A3 (access token field — UNPINNED, D7 will probe): Auth doc does not
 *    enumerate the JSON field name. Defensive try-order: `access_token`,
 *    `token`, `accessToken`. D7 captures the real auth.json after `codex login`
 *    and pins the field name; the others can be removed.
 *
 * A4 (NDJSON delta events — UNPINNED, D7 will probe): Reference docs say
 *    "Outputs newline-delimited JSON events" without enumerating event schemas.
 *    Defensive 4-shape parser: `content` field → delta, `type:'stop'` or
 *    `done:true` → stop, `type:'error'` or `error` field → error, anything else
 *    ignored. D7 captures real stdout and corrects codexChunkToIR if events
 *    use different field names.
 *
 * A5 (env override — CONFIRMED NOT APPLICABLE): The auth doc mentions
 *    `OPENAI_API_KEY` only as input to `codex login --with-api-key`
 *    (login-time, not runtime). The plugin does NOT inject any access-token
 *    env var into the spawn env. `codex exec` reads its auth artifact directly
 *    from $CODEX_HOME/auth.json or the OS credential store.
 *
 * ── Known D7 follow-ups (not bugs at D6, but to verify) ─────────────────────
 * - OS credential store / keyring path. Per auth doc, credentials may live in
 *   an OS-specific credential store rather than auth.json. The Anthropic plugin
 *   supports macOS keychain via `security find-generic-password`; the Codex
 *   equivalent is unknown without a real install. D7 will inspect the live
 *   `codex login` artifact and add keyring support if needed.
 * - Exact `access_token` field name (A3).
 * - Real NDJSON event schema (A4).
 */

import { spawn as defaultSpawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ProviderError } from './base.mjs';

// ── Binary resolution ─────────────────────────────────────────────────────
// OLP_CODEX_BIN env takes priority, then falls back to 'codex' from PATH.
// Mirrors the OLP_CLAUDE_BIN pattern in anthropic.mjs (same env-override-first
// approach). Using OLP_CODEX_BIN to avoid colliding with any system-level
// CODEX_BIN if other tools use that name.
function resolveCodexBin() {
  return process.env.OLP_CODEX_BIN || 'codex';
}

// ── Auth artifact reading ─────────────────────────────────────────────────
// Reads the Codex auth artifact from disk.
//
// Auth authority: Codex CLI reference § "Authentication"
//   "Credentials are stored in $CODEX_HOME (typically ~/.codex/)"
//   CODEX_HOME default: ~/.codex/
//
// Priority order:
//   1. OPENAI_CODEX_AUTH_PATH env override — testing convenience + custom install
//   2. $CODEX_HOME/auth.json where CODEX_HOME = process.env.CODEX_HOME ?? ~/.codex/
//
// D6 assumption A2: auth file is named auth.json (unconfirmed — D7 will pin).
// D6 assumption A3: access token field is `access_token` or `token` (unconfirmed).
//
// Returns { accessToken: string } or null (never throws).
export function readAuthArtifact() {
  // 1. Explicit test override — always takes precedence.
  const authPathOverride = process.env.OPENAI_CODEX_AUTH_PATH;
  if (authPathOverride) {
    try {
      const raw = readFileSync(authPathOverride, 'utf8');
      const creds = JSON.parse(raw);
      const token = creds?.access_token ?? creds?.token ?? creds?.accessToken;
      if (token && typeof token === 'string') return { accessToken: token };
    } catch { /* fall through */ }
    return null; // explicit path set but file missing / malformed
  }

  // 2. $CODEX_HOME/auth.json (default: ~/.codex/auth.json)
  // Codex CLI reference § "Authentication": credentials in $CODEX_HOME (default ~/.codex/).
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const authPath = join(codexHome, 'auth.json');
  try {
    const raw = readFileSync(authPath, 'utf8');
    const creds = JSON.parse(raw);
    // D6 assumption A3: try common OAuth field names in precedence order.
    const token = creds?.access_token ?? creds?.token ?? creds?.accessToken;
    if (token && typeof token === 'string') return { accessToken: token };
  } catch { /* file missing or malformed */ }

  return null;
}

// ── IR → prompt text serialization ───────────────────────────────────────
// Translates an IR request into the { args, prompt } shape that spawn() needs.
//
// Authority: Codex CLI reference § "codex exec [flags] PROMPT"
//   Prompt is the final positional argument to `codex exec`.
//   Multi-line or large prompts: passed via stdin when prompt contains newlines
//   (D6 assumption A1 — stdin fallback unconfirmed; D7 will verify).
//
// Message serialization mirrors anthropic.mjs's irToAnthropic() pattern:
//   system → "[System] <text>", assistant → "[Assistant] <text>",
//   tool → "[Tool Result] <text>", user → plain text.
//
// ADR 0003 § Translation direction model: the plugin owns irToNative.
export function irToCodex(irRequest) {
  const parts = [];

  for (const msg of irRequest.messages) {
    const text = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content);

    if (msg.role === 'system') {
      // System prompt — annotate so the model understands context.
      parts.push(`[System] ${text}`);
    } else if (msg.role === 'assistant') {
      // Prior assistant turn — preserve for conversation context.
      // tool_calls / tool_call_id metadata dropped (lossy — see file header).
      parts.push(`[Assistant] ${text}`);
    } else if (msg.role === 'tool') {
      // Tool result turn — annotate with name if available.
      // Structured tool_call_id dropped (lossy — see file header).
      const nameAnnotation = msg.name ? ` (${msg.name})` : '';
      parts.push(`[Tool Result${nameAnnotation}] ${text}`);
    } else {
      // user role — plain text, no annotation.
      parts.push(text);
    }
  }

  // Lossy: response_format json_object → system-prompt augmentation.
  // Codex CLI does not natively honor response_format; inject a system message
  // to request JSON output. ADR 0003 § Lossy-translation documentation.
  if (irRequest.response_format?.type === 'json_object') {
    parts.unshift('[System] Reply with valid JSON only. Do not include any prose outside the JSON structure.');
  }

  const prompt = parts.join('\n\n');

  // Authority: Codex CLI reference § "codex exec [flags] PROMPT"
  //   https://developers.openai.com/codex/cli/reference
  //   --json / --experimental-json: "Print newline-delimited JSON events instead
  //     of formatted text"
  //   --model, -m: "Override the configured model for this run." Accepts the
  //     model string (e.g., gpt-5.5, gpt-5.4, gpt-5.3-codex).
  //   PROMPT: "Initial instruction for the task. Use '-' to pipe the prompt
  //     from stdin."
  const args = [
    'exec',
    '--json',
    '--model', irRequest.model,
  ];

  // Prompt passing strategy:
  // Short prompts (no newlines) → final argv positional per CLI synopsis.
  // Multi-line prompts → pipe via stdin using the documented `-` positional
  // (reference: "Use '-' to pipe the prompt from stdin."). The earlier D6
  // draft assumed stdin worked with no positional; codex-d6 review caught
  // that the documented stdin trigger is the literal `-` positional.
  const useStdin = prompt.includes('\n');

  if (useStdin) {
    args.push('-');
  } else {
    args.push(prompt);
  }

  return { args, prompt, useStdin };
}

// ── Codex NDJSON chunk → IR ResponseChunk ────────────────────────────────
// Parses one NDJSON line emitted by `codex exec --json` into an IR ResponseChunk.
//
// D6 assumption A4 (event schema — unconfirmed, D7 will pin from real output):
//   Content/delta event: line with a `content` string field
//     → { type: 'delta', content: <string> }
//   Stop event: line with type === 'stop' OR done === true
//     → { type: 'stop', finish_reason: 'stop' }
//   Error event: line with type === 'error' OR error field present
//     → { type: 'error', error: <string> }
//   Other (progress, shell_exec, tool_call, etc.) → null (caller skips)
//
// Returns null for lines that should be silently ignored (progress events, etc.).
export function codexChunkToIR(rawNDJSONLine) {
  if (!rawNDJSONLine || !rawNDJSONLine.trim()) return null;

  let event;
  try {
    event = JSON.parse(rawNDJSONLine.trim());
  } catch {
    // Malformed JSON line — skip silently (alignment with Rule 2: don't invent)
    return null;
  }

  if (!event || typeof event !== 'object') return null;

  // Error event: type === 'error' or error field present
  if (event.type === 'error' || (event.error && typeof event.error === 'string')) {
    const errMsg = event.error ?? event.message ?? 'codex error';
    return { type: 'error', error: errMsg };
  }

  // Stop event: type === 'stop' or done === true
  if (event.type === 'stop' || event.done === true) {
    return { type: 'stop', finish_reason: 'stop' };
  }

  // Delta/content event: has a content string field
  if (typeof event.content === 'string') {
    return { type: 'delta', content: event.content };
  }

  // delta field (alternative shape): { type: 'delta', delta: '...' }
  if (event.type === 'delta' && typeof event.delta === 'string') {
    return { type: 'delta', content: event.delta };
  }

  // Output_text event shape (possible alternative): { type: 'output_text', text: '...' }
  if (typeof event.text === 'string') {
    return { type: 'delta', content: event.text };
  }

  // All other event types (progress, shell_exec, tool_call, etc.) → ignore
  return null;
}

// ── CLI args builder + env setup ──────────────────────────────────────────
// Builds the spawn environment. We do NOT inject the auth token as an env var
// because the Codex CLI manages OAuth state in its own auth.json file
// (CLI reference § "Authentication"). We simply ensure env is clean.
function buildSpawnEnv() {
  const env = { ...process.env };
  // Propagate CODEX_HOME if set (auth path resolution uses it).
  // Clean up any conflicting OpenAI env vars that might override CLI behavior.
  // No specific deletions confirmed needed at D6; conservative cleanup mirrors
  // anthropic.mjs pattern.
  return env;
}

// ── Spawn function (core) ─────────────────────────────────────────────────
// Returns an AsyncIterator<IRResponseChunk> per ADR 0002 § Provider contract.
//
// Spawn pattern:
//   1. Resolve binary via OLP_CODEX_BIN env or PATH 'codex'
//   2. Build args via irToCodex() → ['exec', '--json', '--model', <model>, <prompt>?]
//   3. Spawn with stdio: ['pipe', 'pipe', 'pipe']
//   4. If useStdin: write prompt to proc.stdin, end stdin
//   5. Parse each stdout line as NDJSON via codexChunkToIR()
//   6. On non-zero exit: throw ProviderError('SPAWN_FAILED')
//   7. On normal exit: emit stop chunk if not already emitted
//
// Authority: Codex CLI reference § "codex exec [flags] PROMPT"
//   § "--json": NDJSON event stream on stdout
async function* _spawnAndStream(irRequest, authContext, spawnImpl) {
  const auth = authContext ?? readAuthArtifact();
  if (!auth?.accessToken) {
    throw new ProviderError(
      'No OpenAI Codex auth token found. Run `codex login` or set OPENAI_CODEX_AUTH_PATH.',
      'AUTH_MISSING',
    );
  }

  const bin = resolveCodexBin();
  const { args, prompt, useStdin } = irToCodex(irRequest);
  const env = buildSpawnEnv();

  // Authority: Codex CLI reference § "Authentication"
  //   CODEX_HOME propagated from env for auth file resolution.
  //   No explicit token injection: Codex CLI reads its own auth.json
  //   (contrast with Anthropic plugin which injects CLAUDE_CODE_OAUTH_TOKEN).

  const proc = spawnImpl(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });

  // Write prompt via stdin for multi-line prompts (D6 assumption A1)
  if (useStdin) {
    proc.stdin.write(prompt);
  }
  proc.stdin.end();

  // Yield IR chunks as they arrive — push-buffer + signal pattern
  // (mirrors anthropic.mjs _spawnAndStream, same approach).
  const chunks = [];
  let done = false;
  let exitCode = null;
  let accumulatedStderr = '';
  let stopEmitted = false;
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

  // Buffer stdout by line for NDJSON parsing.
  // Codex --json emits one JSON object per line (NDJSON convention).
  let stdoutBuf = '';
  proc.stdout.on('data', (d) => {
    stdoutBuf += d.toString();
    // Split on newlines; incomplete last segment stays in buffer.
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop(); // last segment (possibly incomplete)
    for (const line of lines) {
      if (line.trim()) {
        push({ type: 'ndjson_line', line });
      }
    }
  });

  proc.stdout.on('end', () => {
    // Flush any remaining buffered content (line without trailing newline)
    if (stdoutBuf.trim()) {
      push({ type: 'ndjson_line', line: stdoutBuf.trim() });
      stdoutBuf = '';
    }
  });

  proc.stderr.on('data', (d) => {
    accumulatedStderr += d.toString();
  });

  proc.on('error', (err) => {
    push({ type: 'error', err });
  });

  proc.on('close', (code, _signal) => {
    exitCode = code;
    done = true;
    push({ type: 'close' });
  });

  // ADR 0004 § Trigger taxonomy bullet 4: spawn timeout is a hard trigger.
  // maxSpawnTimeMs: from hints field so tests can lower it without changing the plugin.
  // Default: 600 000 ms (10 minutes) — reasonable for long Codex outputs.
  const maxSpawnTimeMs = codex.hints?.maxSpawnTimeMs ?? 600_000;

  let spawnTimedOut = false;
  const spawnDeadlineTimer = setTimeout(() => {
    spawnTimedOut = true;
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    if (rejectNext) {
      const r = rejectNext;
      rejectNext = null;
      resolveNext = null;
      r(new ProviderError(
        `codex spawn timed out after ${maxSpawnTimeMs}ms`,
        'SPAWN_TIMEOUT',
      ));
    }
  }, maxSpawnTimeMs);

  // Drain the chunk buffer
  let isFirstChunk = true;
  try {
    while (true) {
      if (chunks.length === 0) {
        if (done) break;
        if (spawnTimedOut) {
          throw new ProviderError(
            `codex spawn timed out after ${maxSpawnTimeMs}ms`,
            'SPAWN_TIMEOUT',
          );
        }
        await new Promise((resolve, reject) => {
          resolveNext = resolve;
          rejectNext = reject;
        });
        continue;
      }

      const item = chunks.shift();

      if (item.type === 'error') {
        throw new ProviderError(`codex spawn error: ${item.err.message}`, 'SPAWN_FAILED');
      }

      if (item.type === 'close') {
        break;
      }

      if (item.type === 'ndjson_line') {
        const irChunk = codexChunkToIR(item.line);
        if (irChunk === null) continue; // ignored event type (progress, etc.)

        if (irChunk.type === 'error') {
          throw new ProviderError(irChunk.error, 'SPAWN_FAILED');
        }

        if (irChunk.type === 'stop') {
          stopEmitted = true;
          yield irChunk;
          continue;
        }

        if (irChunk.type === 'delta') {
          // Add role to first delta chunk (matching anthropic.mjs pattern)
          if (isFirstChunk) {
            yield { type: 'delta', role: 'assistant', content: irChunk.content };
            isFirstChunk = false;
          } else {
            yield irChunk;
          }
        }
      }
    }
  } finally {
    clearTimeout(spawnDeadlineTimer);
  }

  // Process close
  if (exitCode !== 0 && !spawnTimedOut) {
    const errMsg = accumulatedStderr.slice(0, 300) || `codex exit ${exitCode}`;
    throw new ProviderError(errMsg, 'SPAWN_FAILED');
  }

  // Normal exit: emit stop chunk if the NDJSON stream didn't already emit one.
  if (!spawnTimedOut && !stopEmitted) {
    yield { type: 'stop', finish_reason: 'stop' };
  }
}

// ── spawn (public, contract method) ──────────────────────────────────────
// Public spawn conforms to ADR 0002 § Provider contract:
//   spawn: async (irRequest, authContext) => AsyncIterator<ResponseChunk>
let _spawnImpl = defaultSpawn;

export async function* spawn(irRequest, authContext) {
  yield* _spawnAndStream(irRequest, authContext, _spawnImpl);
}

// Test hook: inject mock spawn without importing child_process.
export { _spawnImpl };
export function __setSpawnImpl(impl) { _spawnImpl = impl; }
export function __resetSpawnImpl() { _spawnImpl = defaultSpawn; }

// ── estimateCost ──────────────────────────────────────────────────────────
// Best-effort token estimation using chars/4 heuristic.
// Basis: OpenAI Cookbook "How to count tokens" rule-of-thumb: ~4 chars/token.
// Reference: https://cookbook.openai.com/examples/how_to_count_tokens_with_tiktoken
//
// usd: null at D6 — ChatGPT plan token-cost rates not yet pinned for Codex.
// TODO: populate usd once rates are confirmed post-D7 E2E billing audit.
export function estimateCost(request) {
  if (!request?.messages) return null;

  let inputChars = 0;
  for (const msg of request.messages) {
    const text = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content);
    inputChars += text.length;
  }

  const outputCharsEstimate = Math.ceil(inputChars * 0.5);

  return {
    inputTokens: Math.ceil(inputChars / 4),
    outputTokensEstimate: Math.ceil(outputCharsEstimate / 4),
    currency: 'USD',
    usd: null, // not pinned at D6
  };
}

// ── quotaStatus ───────────────────────────────────────────────────────────
// Returns null at D6. ChatGPT plan limits are not exposed via a programmatic
// endpoint accessible from the CLI tier. If an API endpoint surfaces, pin it
// here with a docs URL (per ALIGNMENT.md Rule 1 authority-first requirement).
export async function quotaStatus(_authContext) {
  return null;
}

// ── healthCheck ───────────────────────────────────────────────────────────
// Does NOT spawn a real `codex exec` request (gated to D7 E2E).
// Checks: (1) `codex` binary exists on PATH, (2) auth artifact exists.
// Mirrors anthropic.mjs healthCheck pattern with injectable test overrides.
export async function healthCheck({ _binaryExistsFn, _authReadFn } = {}) {
  const t0 = Date.now();

  // 1. Binary check
  const binaryExists = _binaryExistsFn ?? _defaultBinaryExists;
  if (!binaryExists()) {
    return { ok: false, latencyMs: Date.now() - t0, error: 'codex binary not found' };
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
  const bin = resolveCodexBin();
  if (bin !== 'codex') {
    // Explicit path given — check directly
    return existsSync(bin);
  }
  // 'codex' from PATH — use which
  try {
    execSync('which codex', { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

// ── Provider export ───────────────────────────────────────────────────────
// Conforms to ADR 0002 § "Provider contract (v1.0 interface)" + contractVersion.

import modelsRegistryRaw from '../../models-registry.json' with { type: 'json' };

const _registryModels = (modelsRegistryRaw?.providers?.openai?.models ?? []).map(m => m.id);

const codex = {
  name: 'openai',
  displayName: 'OpenAI Codex',
  contractVersion: '1.0',
  models: _registryModels,
  auth: {
    type: 'oauth',
    storage: 'file',
    // Auth authority: Codex CLI reference § "Authentication"
    // "Credentials stored in $CODEX_HOME (typically ~/.codex/)"
    // D6 assumption A2: auth file named auth.json (D7 will confirm).
    path: join(homedir(), '.codex', 'auth.json'),
    refresh: 'auto',
  },
  spawn,
  estimateCost,
  quotaStatus,
  healthCheck,
  hints: {
    requiresTTY: false,         // codex exec runs headless (per CLI reference § exec)
    concurrentSpawnSafe: true,  // each invocation is independent
    maxConcurrent: 4,           // conservative default, same as anthropic
    // ADR 0004 § Trigger taxonomy bullet 4: spawn timeout is a hard trigger.
    // 600_000ms = 10 minutes. Tests can lower this by mutating codex.hints.maxSpawnTimeMs.
    maxSpawnTimeMs: 600_000,
  },
};

export default codex;

/**
 * lib/providers/mistral.mjs — Mistral Vibe provider plugin
 *
 * Authority: OLP ALIGNMENT.md § Authority 1 — mistral plugin governed by
 *   `vibe --prompt` from the official Mistral Vibe CLI.
 *
 * Governing ADRs:
 *   ADR 0002 — Plugin architecture, Provider contract v1.0
 *   ADR 0003 — IR design, lossy-translation documentation requirement
 *   ADR 0006 — Mistral Vibe classified Tier D (permissive, Candidate eligible)
 *              ADR 0006 classification table row:
 *              "Usage Policy contains no anti-third-party / anti-automation
 *              clauses. Vibe is the official Mistral CLI; Le Chat Pro
 *              subscription explicitly includes Vibe."
 *
 * Status at D8: CANDIDATE. Not yet Enabled per ALIGNMENT.md § Provider Inventory.
 * The plugin is present in STATIC_REGISTRY but enabled: false is the default config.
 * POST /v1/chat/completions returns 503 until a D-later E2E audit passes and the
 * enabled flag is flipped in ~/.olp/config.json.
 *
 * ── Canonical Mistral Vibe docs URLs (authority per ALIGNMENT.md Authority 1) ────
 *
 * The following URLs were WebFetched at D8 and verified reachable (2026-05-23):
 *
 *  [DOCS-1] Terminal quickstart (command syntax):
 *    https://docs.mistral.ai/mistral-vibe/terminal/quickstart
 *    REACHABLE. Key citation: "vibe --prompt "Analyze the codebase" --max-turns 5
 *    --max-price 1.0 --output json" — the --prompt flag triggers programmatic
 *    (non-interactive) mode; --output selects output format (text, json, streaming).
 *
 *  [DOCS-2] Terminal configuration (auth + config):
 *    https://docs.mistral.ai/mistral-vibe/terminal/configuration
 *    REACHABLE. Key citations:
 *    — Auth file: "~/.vibe/.env" (API key stored here on first run)
 *    — Env var: "export MISTRAL_API_KEY=your_mistral_api_key"
 *    — Override home dir: "VIBE_HOME" env var changes the default ~/.vibe/ base
 *    — Precedence: "Environment variables take precedence over the .env file
 *      if both are set."
 *    — Load: "Mistral Vibe automatically loads API keys from ~/.vibe/.env on
 *      startup."
 *    — Config files: "./.vibe/config.toml" (project-local) and
 *      "~/.vibe/config.toml" (user global) — separate from .env
 *
 *  [DOCS-3] Introduction / configuration:
 *    https://docs.mistral.ai/mistral-vibe/introduction/configuration
 *    REACHABLE. Confirms: same MISTRAL_API_KEY env var name; same ~/.vibe/.env
 *    path. Config.toml has model selection via "/config" command inside Vibe
 *    (not a CLI flag enumerated here).
 *
 *  [DOCS-4] DeepWiki CLI commands reference:
 *    https://deepwiki.com/mistralai/mistral-vibe/9.3-cli-commands-reference
 *    REACHABLE. Key citations:
 *    — "--prompt" triggers run_programmatic() mode (non-interactive exit).
 *    — "--continue", "--resume <id>" for session management (not used by OLP —
 *      OLP is stateless).
 *    — Output format options confirmed: text (default), json, streaming.
 *      NOTE: DeepWiki does not enumerate the full JSON event schema for --output json.
 *      D-later E2E will probe and pin the real JSON shape.
 *
 *  [DOCS-5] Devstral 2 launch announcement (model IDs):
 *    https://mistral.ai/news/devstral-2-vibe-cli
 *    REACHABLE. Key citations:
 *    — "Devstral 2 (123B)" — 123B-parameter dense transformer, 256K context window.
 *    — "Devstral Small 2 (24B)" — consumer-grade GPU / CPU-only config.
 *    — Pricing: Devstral 2 $0.40/$2.00 per million tokens (input/output);
 *      Devstral Small 2 $0.10/$0.30 per million tokens.
 *    NOTE: The announcement does not provide the exact CLI model identifier strings
 *    (e.g., "devstral-2" vs "devstral-2-2506"). D-later E2E will probe
 *    `vibe --model` to confirm the exact IDs. OLP uses "devstral-2" and
 *    "devstral-small-2" as best-effort IDs from the naming convention observed
 *    across other Mistral model pages and the Mistral La Plateforme API.
 *
 *  [DOCS-6] Le Chat Pro plan (Vibe inclusion):
 *    https://help.mistral.ai/en/articles/347532
 *    REACHABLE. Key citation: "Mistral Vibe is included in every Le Chat Pro
 *    subscription." Pro subscribers receive a monthly Vibe budget; additional
 *    usage available as pay-as-you-go if enabled.
 *
 *  [DOCS-7] Mistral Usage Policy (ToS audit for ADR 0006 Tier D):
 *    https://legal.mistral.ai/terms/usage-policy
 *    REACHABLE. Result: "No explicit anti-third-party clauses, anti-automation
 *    language, or restrictions on using Vibe CLI through proxies or wrapper
 *    tools. Policy focuses on prohibited content (illegal content, CSAM,
 *    fraud) not technical access patterns." This confirms ADR 0006 Tier D
 *    classification at D8.
 *
 *  [DOCS-MAIN] Main Vibe overview:
 *    https://docs.mistral.ai/mistral-vibe/overview
 *    Reachable as of 2026-05-23 (review-2 verified). The original D8 draft
 *    asserted 404 at the root URL https://docs.mistral.ai/mistral-vibe/ which
 *    was either transient or a path-normalization mismatch; the /overview
 *    sub-path is canonical. Same model-name listings as DOCS-5.
 *
 *  [DOCS-8] Canonical Mistral models registry (CRITICAL — caught by D8 review-2):
 *    https://docs.mistral.ai/getting-started/models/models_overview
 *    Pin for date-stamped canonical model IDs:
 *      - devstral-2-25-12 (primary; 123B, 262144 ctx)
 *      - devstral-small-2-25-12 (primary; 24B, 262144 ctx)
 *    The original D8 draft used short forms (devstral-2, devstral-small-2) as
 *    primary IDs because the launch announcement (DOCS-5) named the models
 *    that way. The canonical model registry is the load-bearing source for
 *    `--model` flag values (where applicable) and OpenAI-compat client routing.
 *    Per ALIGNMENT.md Rule 2, registry now uses canonical IDs as primary;
 *    short forms (devstral-2, devstral-small-2, devstral, devstral-small) are
 *    aliases routed via plugin's models[] array.
 *
 * ── D8 spec assumptions ───────────────────────────────────────────────────
 *
 * A1 (command shape — CONFIRMED):
 *   Name: vibe_command_shape
 *   Status: CONFIRMED
 *   Basis: DOCS-1 citation: "vibe --prompt "PROMPT" --output json"
 *   Spawn shape used: `vibe --prompt "PROMPT" --output json`
 *   D-later verify: Confirm `--output json` emits per-line JSON objects (NDJSON
 *   shape), not a single wrapped JSON object. If it is a single JSON blob,
 *   switch to `--output streaming` for line-by-line chunks.
 *
 * A2 (auth env var — CONFIRMED):
 *   Name: auth_env_var
 *   Status: CONFIRMED
 *   Basis: DOCS-2 and DOCS-3: "export MISTRAL_API_KEY=your_mistral_api_key".
 *   OLP injects MISTRAL_API_KEY into spawn env, similar to how anthropic.mjs
 *   injects CLAUDE_CODE_OAUTH_TOKEN. D-later verify that the vibe CLI respects
 *   MISTRAL_API_KEY from the environment (vs. only reading ~/.vibe/.env).
 *
 * A3 (auth file path — CONFIRMED):
 *   Name: auth_file_path
 *   Status: CONFIRMED
 *   Basis: DOCS-2: "~/.vibe/.env" is where the key is stored.
 *   VIBE_HOME env var overrides the ~/.vibe/ base directory.
 *   OLP reads MISTRAL_API_KEY from this file as a fallback after the env var.
 *
 * A4 (JSON output event schema — UNPINNED-D-later-verifies):
 *   Name: json_output_schema
 *   Status: UNPINNED-D-later-verifies
 *   Basis: DOCS-1 confirms "--output json" exists. DeepWiki (DOCS-4) does not
 *   enumerate the event schema. OLP uses a defensive 4-shape parser:
 *   — { "text": "..." } or { "content": "..." } → delta
 *   — { "type": "stop" } or { "done": true } → stop
 *   — { "type": "error" } or { "error": "..." } → error
 *   — anything else → ignored
 *   D-later E2E will capture real `vibe --output json` stdout and pin the
 *   actual field names; mismatched fields will be corrected then.
 *
 * A5 (model flag — UNPINNED-D-later-verifies):
 *   Name: model_flag
 *   Status: UNPINNED-D-later-verifies
 *   Basis: DOCS-3 mentions model selection via "/config" inside the interactive
 *   Vibe UI. The quickstart (DOCS-1) does not show a `--model` CLI flag for
 *   programmatic mode. OLP does NOT pass `--model` in the spawn args at D8
 *   because no CLI reference confirms this flag exists on the `vibe` command
 *   (per ALIGNMENT.md Rule 2: "if the underlying authority does not perform
 *   the operation, the PR must state this explicitly").
 *   D-later E2E: run `vibe --help` to enumerate all flags; if --model exists
 *   and the flag name is confirmed, add it to spawn args with the model ID.
 *
 * A6 (exact model IDs — UNPINNED-D-later-verifies):
 *   Name: model_ids
 *   Status: UNPINNED-D-later-verifies
 *   Basis: DOCS-5 names "Devstral 2" and "Devstral Small 2" but does not
 *   provide CLI identifier strings. OLP uses "devstral-2" and "devstral-small-2"
 *   as best-effort IDs based on Mistral's naming convention for other models
 *   (devstral-v0.1, codestral-latest, etc.). D-later E2E: confirm IDs from
 *   `vibe --help` or Mistral API model list; update models-registry.json.
 *
 * A7 (streaming vs json output mode — UNPINNED-D-later-verifies):
 *   Name: output_mode_choice
 *   Status: UNPINNED-D-later-verifies
 *   Basis: DOCS-1 shows "--output json" and "--output streaming" as separate
 *   options. It is not documented whether "json" emits NDJSON (line-per-event)
 *   or a single JSON blob at end. OLP uses "--output json" at D8 and parses
 *   defensively. D-later: if json is a single blob, switch to "--output streaming"
 *   for streaming support, and update mistralChunkToIR accordingly.
 *
 * A8 (stdin prompt passing — UNPINNED-D-later-verifies):
 *   Name: prompt_passing_via_arg_vs_stdin
 *   Status: UNPINNED-D-later-verifies
 *   Basis: DOCS-1 uses `--prompt "TEXT"` as a CLI flag. OLP passes the prompt
 *   as the value to the --prompt flag. It is not documented whether vibe
 *   supports reading the prompt from stdin (via `-` or similar). For multi-line
 *   prompts, OLP serializes the entire IR message thread as a single string
 *   passed directly to --prompt. D-later E2E: test multi-line prompts and
 *   confirm the flag handles newlines correctly.
 *
 * ── Known D-later follow-ups ──────────────────────────────────────────────
 *
 * DL-1: Run `vibe --help` to enumerate all flags; pin --model if it exists.
 * DL-2: Capture real `vibe --output json` stdout; update mistralChunkToIR
 *       with the actual JSON event field names.
 * DL-3: Confirm whether MISTRAL_API_KEY env var is read at spawn time (not
 *       just at interactive setup time).
 * DL-4: Confirm the exact model identifier strings ("devstral-2",
 *       "devstral-small-2", or some versioned variant like "devstral-2-2506").
 * DL-5: Test multi-line prompt behaviour with --prompt flag; consider stdin
 *       path if flag has length limits.
 * DL-6: Confirm "--output streaming" NDJSON schema vs "--output json" single-
 *       blob behaviour; choose the correct mode for streaming support.
 * DL-7: If quota/budget API surfaces in Le Chat Pro, pin the endpoint here
 *       and implement quotaStatus() (currently returns null).
 *
 * ── Lossy translations (per ADR 0003 § Lossy-translation documentation) ───
 *
 *   - `top_p` — not mapped to a `vibe --prompt` flag; dropped silently.
 *     DOCS-1 flag list does not include --top-p. ALIGNMENT.md Rule 2.
 *
 *   - `temperature` — not mapped; Vibe CLI docs do not expose --temperature
 *     for programmatic mode. Dropped silently.
 *
 *   - `stop` (stop sequences) — not a `vibe --prompt` flag; dropped.
 *
 *   - `max_tokens` — not a `vibe --prompt` flag at D8 (DOCS-1 shows --max-turns
 *     for iteration count, not token limit). Dropped silently. D-later: verify
 *     whether --max-tokens exists.
 *
 *   - `tools[]` + `tool_choice` — `vibe --prompt --output json` is a text-in /
 *     JSON-out CLI; structured tool definitions are not passed on the wire.
 *     Dropped. If a caller wants tool use, pre-prompt the model via system msg.
 *     ALIGNMENT.md Rule 2 applies.
 *
 *   - Assistant-message `tool_calls` / `tool_call_id` — same reason as above;
 *     structured metadata dropped, textual content preserved.
 *
 *   - `response_format: json_object` — Vibe CLI does not natively honor this
 *     field. A system-prompt augmentation is injected ("Reply with valid JSON
 *     only."), mirroring the Anthropic and Codex plugin approach.
 */

import { spawn as defaultSpawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ProviderError } from './base.mjs';

// ── Binary resolution ─────────────────────────────────────────────────────
// OLP_VIBE_BIN env takes priority, then falls back to 'vibe' from PATH.
// Mirrors the OLP_CLAUDE_BIN / OLP_CODEX_BIN env-override-first pattern in
// anthropic.mjs and codex.mjs.
function resolveVibeBin() {
  return process.env.OLP_VIBE_BIN || 'vibe';
}

// ── Auth artifact reading ─────────────────────────────────────────────────
// Authority: DOCS-2 (https://docs.mistral.ai/mistral-vibe/terminal/configuration)
//   Auth file: "~/.vibe/.env"
//   Env var: MISTRAL_API_KEY
//   Precedence: env var > .env file (DOCS-2: "Environment variables take
//     precedence over the .env file if both are set.")
//   VIBE_HOME override: if VIBE_HOME is set, the .env is at $VIBE_HOME/.env
//     (DOCS-2: "VIBE_HOME environment variable to a custom path")
//
// Priority order:
//   1. MISTRAL_API_KEY env var directly — highest precedence per DOCS-2
//   2. MISTRAL_VIBE_AUTH_PATH env var — test/custom-install override
//   3. $VIBE_HOME/.env or ~/.vibe/.env — default per DOCS-2
//
// Returns { apiKey: string } or null (never throws).
export function readAuthArtifact() {
  // 1. Direct env var — DOCS-2: highest precedence
  if (process.env.MISTRAL_API_KEY) {
    return { apiKey: process.env.MISTRAL_API_KEY };
  }

  // 2. Explicit test/custom path override
  const authPathOverride = process.env.MISTRAL_VIBE_AUTH_PATH;
  if (authPathOverride) {
    try {
      const raw = readFileSync(authPathOverride, 'utf8');
      const key = _extractKeyFromDotenv(raw);
      if (key) return { apiKey: key };
    } catch { /* fall through */ }
    return null; // explicit path set but file missing/malformed
  }

  // 3. $VIBE_HOME/.env or ~/.vibe/.env (DOCS-2)
  // D8 assumption A3: path is ~/.vibe/.env. D-later E2E will confirm.
  const vibeHome = process.env.VIBE_HOME ?? join(homedir(), '.vibe');
  const envPath = join(vibeHome, '.env');
  try {
    const raw = readFileSync(envPath, 'utf8');
    const key = _extractKeyFromDotenv(raw);
    if (key) return { apiKey: key };
  } catch { /* file missing or malformed */ }

  return null;
}

/**
 * Extracts MISTRAL_API_KEY from a dotenv-format string.
 * Handles: MISTRAL_API_KEY=value, MISTRAL_API_KEY="value", with optional
 * leading/trailing whitespace or comments.
 *
 * @param {string} raw — raw file contents
 * @returns {string|null}
 */
function _extractKeyFromDotenv(raw) {
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eqIdx = trimmed.indexOf('=');
    const key = trimmed.slice(0, eqIdx).trim();
    if (key !== 'MISTRAL_API_KEY') continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) return value;
  }
  return null;
}

// ── IR → prompt text serialization ───────────────────────────────────────
// Translates an IR request into the { args, prompt } shape that spawn() needs.
//
// Authority: DOCS-1 (https://docs.mistral.ai/mistral-vibe/terminal/quickstart)
//   "vibe --prompt "PROMPT" --output json" — prompt is passed as --prompt flag value.
//
// Message serialization mirrors anthropic.mjs/codex.mjs pattern:
//   system → "[System] <text>", assistant → "[Assistant] <text>",
//   tool → "[Tool Result] <text>", user → plain text.
//
// ADR 0003 § Translation direction model: the plugin owns irToNative.
export function irToMistral(irRequest) {
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
  // Vibe CLI does not natively honor response_format; inject a system message
  // to request JSON output. ADR 0003 § Lossy-translation documentation.
  if (irRequest.response_format?.type === 'json_object') {
    parts.unshift('[System] Reply with valid JSON only. Do not include any prose outside the JSON structure.');
  }

  const prompt = parts.join('\n\n');

  // Authority: DOCS-1 § "Output Format Options" enumerates three modes:
  //   text      (default) — human-readable text
  //   json      — "All messages as JSON at the end" (single blob, NOT NDJSON)
  //   streaming — "Newline-delimited JSON per message" (this is the NDJSON form)
  //
  // OLP needs per-event chunks for IR translation, so we use `--output streaming`.
  // D8 review-2 caught the original draft using `--output json`, which docs
  // explicitly state emits a single blob at the end — incompatible with the
  // line-buffered stdout parser in this plugin. Streaming mode is the correct
  // selection per ALIGNMENT.md Rule 3 (Match the Implementation).
  //
  // A5 (model flag, CONFIRMED-NOT-APPLICABLE): vibe CLI has no --model flag
  // (DeepWiki full flag enumeration confirms). Model selection happens via
  // ~/.vibe/config.toml. The IR's `model` field is used by OLP for routing
  // only; Vibe will use whatever model is configured at the user level.
  const args = [
    '--prompt', prompt,
    '--output', 'streaming',
  ];

  return { args, prompt };
}

// ── Mistral JSON output chunk → IR ResponseChunk ─────────────────────────
// Parses one JSON line (or object) emitted by `vibe --output json`.
//
// D8 assumption A4 (event schema — UNPINNED, D-later will pin from real output):
//   Content/delta event: line with a `text` or `content` string field
//     → { type: 'delta', content: <string> }
//   Stop event: line with type === 'stop' OR done === true
//     → { type: 'stop', finish_reason: 'stop' }
//   Error event: line with type === 'error' OR error field present
//     → { type: 'error', error: <string> }
//   Other events → null (caller skips)
//
// Returns null for lines that should be silently ignored.
// D-later: update based on real `vibe --output json` stdout capture.
export function mistralChunkToIR(rawLine) {
  if (!rawLine || !rawLine.trim()) return null;

  let event;
  try {
    event = JSON.parse(rawLine.trim());
  } catch {
    // Malformed JSON line — skip silently (ALIGNMENT.md Rule 2: don't invent)
    return null; // D-later: verify A4
  }

  if (!event || typeof event !== 'object') return null;

  // Error event: type === 'error' or error field present
  if (event.type === 'error' || (event.error && typeof event.error === 'string')) {
    const errMsg = event.error ?? event.message ?? 'vibe error';
    return { type: 'error', error: errMsg };
  }

  // Stop event: type === 'stop' or done === true
  if (event.type === 'stop' || event.done === true) {
    return { type: 'stop', finish_reason: 'stop' };
  }

  // D8 assumption A4: try multiple field names for delta content.
  // Prefer 'text' (from Mistral API streaming convention), fall back to 'content'.

  // text field — used in Mistral La Plateforme streaming events
  if (typeof event.text === 'string') {
    return { type: 'delta', content: event.text }; // D-later: verify A4
  }

  // content field — used in OpenAI-compat / alternative Vibe shapes
  if (typeof event.content === 'string') {
    return { type: 'delta', content: event.content }; // D-later: verify A4
  }

  // delta field shape: { type: 'delta', delta: '...' }
  if (event.type === 'delta' && typeof event.delta === 'string') {
    return { type: 'delta', content: event.delta }; // D-later: verify A4
  }

  // choices[0].delta.content — OpenAI streaming shape (Vibe may use this)
  // D-later: verify if Vibe --output json uses OpenAI-compat streaming shape
  const choiceDelta = event?.choices?.[0]?.delta?.content;
  if (typeof choiceDelta === 'string') {
    return { type: 'delta', content: choiceDelta }; // D-later: verify A4
  }

  // finish_reason in choices[0] → stop event (OpenAI streaming shape)
  // D-later: verify A4
  const finishReason = event?.choices?.[0]?.finish_reason;
  if (finishReason === 'stop' || finishReason === 'length') {
    return { type: 'stop', finish_reason: finishReason };
  }

  // All other event types (progress, metadata, etc.) → ignore
  return null;
}

// ── Spawn env setup ───────────────────────────────────────────────────────
// Builds the spawn environment with MISTRAL_API_KEY injected.
//
// Authority: DOCS-2: "export MISTRAL_API_KEY=your_mistral_api_key"
// D8 assumption A2: MISTRAL_API_KEY is read at spawn time. D-later will confirm.
function buildSpawnEnv(apiKey) {
  const env = { ...process.env };
  // Inject the API key so vibe CLI can authenticate at spawn time.
  // D8 assumption A2: vibe reads MISTRAL_API_KEY from env. D-later: verify.
  env.MISTRAL_API_KEY = apiKey;
  return env;
}

// ── Spawn function (core) ─────────────────────────────────────────────────
// Returns an AsyncIterator<IRResponseChunk> per ADR 0002 § Provider contract.
//
// Spawn pattern:
//   1. Resolve binary via OLP_VIBE_BIN env or PATH 'vibe'
//   2. Build args via irToMistral() → ['--prompt', <prompt>, '--output', 'json']
//   3. Spawn with stdio: ['pipe', 'pipe', 'pipe']
//   4. Parse stdout line-by-line via mistralChunkToIR()
//      (assumption A7: '--output json' emits NDJSON lines — D-later verify)
//   5. On non-zero exit: throw ProviderError('SPAWN_FAILED')
//   6. On normal exit: emit stop chunk if not already emitted
//
// Authority: DOCS-1 § "--prompt" + "--output json"
async function* _spawnAndStream(irRequest, authContext, spawnImpl) {
  const auth = authContext ?? readAuthArtifact();
  if (!auth?.apiKey) {
    throw new ProviderError(
      'No Mistral API key found. Set MISTRAL_API_KEY env var, or run `vibe --setup` to configure ~/.vibe/.env.',
      'AUTH_MISSING',
    );
  }

  const bin = resolveVibeBin();
  const { args } = irToMistral(irRequest);
  const env = buildSpawnEnv(auth.apiKey);

  const proc = spawnImpl(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });

  // Close stdin immediately — vibe --prompt reads from args, not stdin.
  proc.stdin.end();

  // Push-buffer + signal approach (mirrors anthropic.mjs and codex.mjs pattern).
  const chunks = [];
  let done = false;
  let exitCode = null;
  let accumulatedStderr = '';
  let stopEmitted = false;
  let resolveNext = null;
  let isFirstChunk = true;

  function push(item) {
    chunks.push(item);
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  }

  // Buffer stdout by line for JSON parsing.
  // Assumption A7: '--output json' emits one JSON object per line (NDJSON).
  // D-later: if '--output json' emits a single JSON blob, switch to '--output streaming'.
  let stdoutBuf = '';
  proc.stdout.on('data', (d) => {
    stdoutBuf += d.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop(); // keep incomplete last segment
    for (const line of lines) {
      if (line.trim()) {
        push({ type: 'json_line', line });
      }
    }
  });

  proc.stdout.on('end', () => {
    // Flush remaining buffer content (line without trailing newline)
    if (stdoutBuf.trim()) {
      push({ type: 'json_line', line: stdoutBuf.trim() });
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

  // Drain the chunk buffer
  while (true) {
    if (chunks.length === 0) {
      if (done) break;
      await new Promise((resolve) => { resolveNext = resolve; });
      continue;
    }

    const item = chunks.shift();

    if (item.type === 'error') {
      throw new ProviderError(`vibe spawn error: ${item.err.message}`, 'SPAWN_FAILED');
    }

    if (item.type === 'close') {
      break;
    }

    if (item.type === 'json_line') {
      const irChunk = mistralChunkToIR(item.line);
      if (irChunk === null) continue; // ignored event type

      if (irChunk.type === 'error') {
        throw new ProviderError(irChunk.error, 'SPAWN_FAILED');
      }

      if (irChunk.type === 'stop') {
        stopEmitted = true;
        yield irChunk;
        continue;
      }

      if (irChunk.type === 'delta') {
        // Add role to first delta chunk (matching anthropic.mjs / codex.mjs pattern)
        if (isFirstChunk) {
          yield { type: 'delta', role: 'assistant', content: irChunk.content };
          isFirstChunk = false;
        } else {
          yield irChunk;
        }
      }
    }
  }

  // Process close
  if (exitCode !== 0) {
    const errMsg = accumulatedStderr.slice(0, 300) || `vibe exit ${exitCode}`;
    throw new ProviderError(errMsg, 'SPAWN_FAILED');
  }

  // Normal exit: emit stop chunk if the JSON stream didn't already emit one.
  if (!stopEmitted) {
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
// Mirror anthropic.mjs and codex.mjs export pattern.
export { _spawnImpl };
export function __setSpawnImpl(fn) { _spawnImpl = fn; }
export function __resetSpawnImpl() { _spawnImpl = defaultSpawn; }

// ── estimateCost ──────────────────────────────────────────────────────────
// Best-effort token estimation using chars/4 heuristic.
// Basis: OpenAI Cookbook "How to count tokens" rule-of-thumb: ~4 chars/token.
// Reference: https://cookbook.openai.com/examples/how_to_count_tokens_with_tiktoken
//
// usd: null at D8 — Le Chat Pro Vibe budget rates not pinned.
// DOCS-5 lists API rates ($0.40/$2.00 for Devstral 2), but the Le Chat Pro
// Vibe budget is a separate quota mechanism not tied to per-token API pricing.
// D-later: pin Le Chat Pro Vibe token rates and populate usd.
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
    usd: null, // not pinned at D8 — D-later: verify Le Chat Pro Vibe token rates
  };
}

// ── quotaStatus ───────────────────────────────────────────────────────────
// Returns null at D8. Le Chat Pro Vibe monthly budget is not exposed via a
// programmatic endpoint accessible from the CLI tier.
// DOCS-6: "Pro subscribers receive a monthly Vibe budget" — no API to query
// the remaining balance. D-later: check if Mistral adds a quota API.
export async function quotaStatus(_authContext) {
  return null;
}

// ── healthCheck ───────────────────────────────────────────────────────────
// Does NOT spawn a real `vibe --prompt` request (gated to D-later E2E).
// Checks: (1) `vibe` binary exists on PATH, (2) auth artifact exists.
// Mirrors anthropic.mjs and codex.mjs healthCheck pattern with injectable
// test overrides.
export async function healthCheck({ _binaryExistsFn, _authReadFn } = {}) {
  const t0 = Date.now();

  // 1. Binary check
  const binaryExists = _binaryExistsFn ?? _defaultBinaryExists;
  if (!binaryExists()) {
    return { ok: false, latencyMs: Date.now() - t0, error: 'vibe binary not found' };
  }

  // 2. Auth artifact check
  const authRead = _authReadFn ?? readAuthArtifact;
  const auth = authRead();
  if (!auth?.apiKey) {
    return { ok: false, latencyMs: Date.now() - t0, error: 'auth artifact missing' };
  }

  return { ok: true, latencyMs: Date.now() - t0 };
}

function _defaultBinaryExists() {
  const bin = resolveVibeBin();
  if (bin !== 'vibe') {
    // Explicit path given — check directly
    return existsSync(bin);
  }
  // 'vibe' from PATH — use which
  try {
    execSync('which vibe', { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

// ── Provider export ───────────────────────────────────────────────────────
// Conforms to ADR 0002 § "Provider contract (v1.0 interface)" + contractVersion.

import modelsRegistryRaw from '../../models-registry.json' with { type: 'json' };

// Build the `models` array from BOTH canonical date-stamped IDs and the
// short-form aliases per registry. ADR 0002 says `models: string[]` is "models
// this provider serves" — an alias that resolves to a real model is itself
// served. Including both makes getProviderForModel() naively route either form:
//   model: "devstral-2-25-12" → mistral
//   model: "devstral-2"       → mistral (via alias)
//   model: "devstral"         → mistral (via alias)
// Phase-2 fallback engine + dashboard will use canonical IDs internally.
const _registryEntry = modelsRegistryRaw?.providers?.mistral ?? {};
const _registryModels = [
  ...(_registryEntry.models ?? []).map(m => m.id),
  ...Object.keys(_registryEntry.aliases ?? {}),
];

const mistral = {
  name: 'mistral',
  displayName: 'Mistral Vibe',
  contractVersion: '1.0',
  models: _registryModels,
  auth: {
    type: 'api-key',
    storage: 'file',
    // Auth authority: DOCS-2 (https://docs.mistral.ai/mistral-vibe/terminal/configuration)
    // "Mistral Vibe automatically loads API keys from ~/.vibe/.env on startup."
    // D8 assumption A3: path is ~/.vibe/.env. VIBE_HOME override changes base dir.
    path: join(homedir(), '.vibe', '.env'),
    refresh: 'manual',
  },
  spawn,
  estimateCost,
  quotaStatus,
  healthCheck,
  hints: {
    requiresTTY: false,         // vibe --prompt runs headless per DOCS-1 programmatic mode
    concurrentSpawnSafe: true,  // each invocation is independent
    maxConcurrent: 4,           // conservative default matching anthropic + codex
  },
};

export default mistral;

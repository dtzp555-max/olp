/**
 * lib/providers/anthropic.mjs — Anthropic Claude provider plugin
 *
 * Authority: OLP ALIGNMENT.md § Authority 1 — anthropic plugin governed by
 *   `claude -p` from `@anthropic-ai/claude-code`.
 *   OCP server.mjs inherits cli.js 2.1.89 audit pin at fork (per ALIGNMENT.md
 *   § Provider authority pins).
 *   D26 round-3 F18 observation: @anthropic-ai/claude-code v2.1.89 confirmed
 *   present at D4 implementation (captured at D4 implementation per ALIGNMENT.md
 *   Rule 5 — the circular ALIGNMENT.md ↔ plugin header citation is resolved by
 *   this in-plugin record of the OLP-side observation).
 *   D36 #15: See docs/provider-audits/anthropic.md for the version-capture
 *   artifact (single living document — captured 2026-05-24; re-capture at every
 *   plugin touch or annual audit). The artifact records the live `claude --version`
 *   today (v2.1.132) versus the plugin pin (v2.1.89, D4) and verifies that the
 *   load-bearing flags (-p, --output-format, --no-session-persistence, --model,
 *   --debug) are all still present and semantically unchanged in the current binary.
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
 * Quota status: D80 (Phase 5) — live plan-usage probe via POST /v1/messages.
 *   Authority: ALIGNMENT.md Class-specific Exception §1 + ADR 0002 Amendment 8
 *   (direct-API READ-ONLY exemption, three constraints: READ-ONLY, subscription-scope,
 *   idempotent-failure) + ADR 0013 (OAuth READ-ONLY consumption rules) +
 *   ADR 0012 D80 (Phase 5 charter).
 *   Schema pin: ~/.cc-rules/memory/learnings/anthropic_plan_usage_probe_schema_2026_05_26.md
 *   Port source: OCP server.mjs:842-1109.
 *   All 13 anthropic-ratelimit-unified-* fields parsed (including 3 fields new since
 *   OCP's 2026-04 capture: 5h-status, 7d-status, overage-reset).
 *   Opt-in: ~/.olp/config.json providers.anthropic.quota_probe_enabled must be true.
 *   Cache TTL: 5min. Refresh backoff: 60s–3600s exponential.
 */

import { spawn as defaultSpawn } from 'node:child_process';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as https from 'node:https';
import { ProviderError } from './base.mjs';

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

// ── Quota probe constants + state ────────────────────────────────────────
// Port of OCP server.mjs:852-862 — module-level cache + backoff state.
// ADR 0013 Rule 3: 5min TTL, 60s-3600s exponential backoff.
//
// Authority: ADR 0002 Amendment 8 + ADR 0013 + ADR 0012 D80 + audit memory
//   ~/.cc-rules/memory/learnings/anthropic_plan_usage_probe_schema_2026_05_26.md
//   Port source: OCP server.mjs:842-1109
//
// OAuth client_id: Claude Code's IdP-registered ID (per audit memory § OAuth refresh).
// Configurable via CLAUDE_CODE_OAUTH_CLIENT_ID env var (binary supports this override
// per `strings` output 2026-05-26).
const QUOTA_OAUTH_CLIENT_ID =
  process.env.CLAUDE_CODE_OAUTH_CLIENT_ID ?? '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const QUOTA_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const QUOTA_API_URL = 'https://api.anthropic.com/v1/messages';
const QUOTA_CACHE_TTL_MS = 5 * 60 * 1000;       // 5 minutes (OCP USAGE_CACHE_TTL)
const QUOTA_BACKOFF_MIN_MS = 60 * 1000;           // 60s  (OCP OAUTH_REFRESH_MIN_BACKOFF)
const QUOTA_BACKOFF_MAX_MS = 60 * 60 * 1000;      // 3600s (OCP OAUTH_REFRESH_MAX_BACKOFF)
// Local constant is the safety net (ADR 0013 Rule 5 + D81 reviewer nit #4 fold-in).
// The live value is read from models-registry.json at module load via _resolveSchemaVersion().
// If the registry field is absent or fails to load, this constant takes over.
const QUOTA_SCHEMA_VERSION = '2026-05-26';

/**
 * Read quota_probe.schema_version from models-registry.json (D81).
 * ADR 0013 Rule 5: schema_version lives in models-registry.json so downstream
 * consumers can detect schema drift by bumping that field on drift events.
 * Local QUOTA_SCHEMA_VERSION constant is the fallback if the registry field
 * is absent or the import is unavailable.
 *
 * @returns {string} schema_version string (e.g. '2026-05-26')
 */
function _resolveSchemaVersion() {
  try {
    // models-registry.json is imported at the bottom of this file as
    // modelsRegistryRaw; reference it here via a lazy try/catch so that if
    // the import hasn't resolved yet (edge case: circular import during tests)
    // we gracefully fall through to the constant.
    const registryVersion = modelsRegistryRaw?.quota_probe?.schema_version;
    if (typeof registryVersion === 'string' && registryVersion.length > 0) {
      return registryVersion;
    }
  } catch { /* fall through to constant */ }
  return QUOTA_SCHEMA_VERSION;
}

// Module-level probe state — one instance per process (not per request).
// Ported from OCP server.mjs:852 (usageCache) + 862 (oauthRefreshBackoff).
const quotaProbeState = {
  cache: null,          // { fetchedAt: <ms>, data: <quotaShape> } when fresh; null when not
  backoffUntil: 0,      // ms epoch: when next refresh attempt is allowed
  backoffMs: QUOTA_BACKOFF_MIN_MS, // current backoff window; doubled on failure, reset on success
};

// ── Config reader: providers.<name>.<field> ───────────────────────────────
// Reads ~/.olp/config.json and returns providers.<name> config object.
// Never throws. Returns {} on any error.
// OLP_HOME env respected (same as lib/keys.mjs _resolveOlpHome).
function _readProviderConfig(providerName) {
  try {
    const olpHome = process.env.OLP_HOME ?? join(homedir(), '.olp');
    const cfgPath = join(olpHome, 'config.json');
    if (!existsSync(cfgPath)) return {};
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    if (cfg && typeof cfg === 'object' && cfg.providers && typeof cfg.providers === 'object') {
      const p = cfg.providers[providerName];
      return (p && typeof p === 'object') ? p : {};
    }
    return {};
  } catch {
    return {};
  }
}

// ── Parse anthropic-ratelimit-unified-* headers (all 13 fields) ───────────
// ADR 0013 Rule 2: body discarded; only headers parsed.
// Schema: ~/.cc-rules/memory/learnings/anthropic_plan_usage_probe_schema_2026_05_26.md
// Port of OCP server.mjs:1013-1082 (parseRateLimitHeaders) — OLP version parses
// all 13 fields (OCP parsed 9; 3 new: 5h-status, 7d-status, overage-reset).
//
// Returns the canonical 13-field shape. Missing fields → null (not 0 or "unknown")
// so consumers can detect "field not present" vs "field present but zero".
// Exception: numeric string fields → number; "overage-reset" only fires on active
// overage per audit memory so null is the correct default.
function _parseRateLimitHeaders(headers) {
  // helpers
  const str = (k) => {
    const v = headers[k.toLowerCase()];
    return (v !== undefined && v !== null) ? String(v) : null;
  };
  const num = (k) => {
    const v = str(k);
    if (v === null) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  };
  const int = (k) => {
    const v = str(k);
    if (v === null) return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  };

  return {
    // Overall / representative
    status:                 str('anthropic-ratelimit-unified-status'),
    representative_claim:   str('anthropic-ratelimit-unified-representative-claim'),
    reset:                  int('anthropic-ratelimit-unified-reset'),
    fallback_percentage:    num('anthropic-ratelimit-unified-fallback-percentage'),

    // 5-hour window
    status_5h:              str('anthropic-ratelimit-unified-5h-status'),     // NEW vs OCP 2026-04
    utilization_5h:         num('anthropic-ratelimit-unified-5h-utilization'),
    reset_5h:               int('anthropic-ratelimit-unified-5h-reset'),

    // 7-day window
    status_7d:              str('anthropic-ratelimit-unified-7d-status'),     // NEW vs OCP 2026-04
    utilization_7d:         num('anthropic-ratelimit-unified-7d-utilization'),
    reset_7d:               int('anthropic-ratelimit-unified-7d-reset'),

    // Overage
    overage_status:         str('anthropic-ratelimit-unified-overage-status'),
    overage_disabled_reason: str('anthropic-ratelimit-unified-overage-disabled-reason'),
    overage_reset:          int('anthropic-ratelimit-unified-overage-reset'), // NEW vs OCP 2026-04
  };
}

// ── OAuth token refresh ───────────────────────────────────────────────────
// ADR 0013 Rule 3: max one refresh per backoff window; backoff 60s→3600s.
// Port of OCP server.mjs:890-941 (refreshOAuthToken) — adapted for Node.js
// built-in https (no fetch dependency) + shared quotaProbeState backoff.
//
// Returns new access_token string on success, null on failure.
// NEVER throws (idempotent-failure per ADR 0002 Amendment 8 constraint 3).
async function _refreshAccessToken(refreshToken) {
  const now = Date.now();
  if (now < quotaProbeState.backoffUntil) {
    return null; // still in backoff window
  }
  return new Promise((resolve) => {
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: QUOTA_OAUTH_CLIENT_ID,
      scope: 'user:inference user:profile',
    });
    const url = new URL(QUOTA_OAUTH_TOKEN_URL);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const data = JSON.parse(raw);
            // Reset backoff on success
            quotaProbeState.backoffMs = QUOTA_BACKOFF_MIN_MS;
            quotaProbeState.backoffUntil = 0;
            resolve(data.access_token ?? null);
          } catch {
            _scheduleBackoff();
            resolve(null);
          }
        } else {
          _scheduleBackoff();
          resolve(null);
        }
      });
    });
    req.on('error', () => {
      _scheduleBackoff();
      resolve(null);
    });
    req.setTimeout(10_000, () => {
      req.destroy();
      _scheduleBackoff();
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

// Helper: advance backoff exponentially (doubles currentMs, caps at MAX).
function _scheduleBackoff() {
  quotaProbeState.backoffUntil = Date.now() + quotaProbeState.backoffMs;
  quotaProbeState.backoffMs = Math.min(quotaProbeState.backoffMs * 2, QUOTA_BACKOFF_MAX_MS);
}

// ── Probe: POST /v1/messages, parse response headers ─────────────────────
// ADR 0013 Rule 2: READ-ONLY, max_tokens:1, body discarded, headers-only.
// Only permitted endpoint: POST /v1/messages (ADR 0013 Rule 2 per-endpoint containment).
// NOT: /api/oauth/usage (hallucinated endpoint — see alignment.yml blacklist).
//
// Port of OCP server.mjs:943-1011 (fetchUsageFromApi) using Node.js built-in https
// (no third-party fetch wrapper — consistent with server.mjs zero-external-deps policy).
//
// Returns { fields: {...13}, raw: {...headers} } on success.
// Returns null on any failure (idempotent-failure per ADR 0002 Amendment 8 §3).
async function _probeOnce(creds) {
  const { accessToken, refreshToken, expiresAt } = creds;
  let token = accessToken;

  // Pre-emptive refresh if token looks expired (5min buffer, same as Claude Code).
  if (expiresAt && Date.now() + 300_000 >= expiresAt && refreshToken) {
    const newToken = await _refreshAccessToken(refreshToken);
    if (newToken) token = newToken;
  }

  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1,
    messages: [{ role: 'user', content: '.' }],
  });

  const doRequest = (bearerToken) => new Promise((resolve, reject) => {
    const url = new URL(QUOTA_API_URL);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      // Drain and discard the response body — ADR 0013 Rule 2: headers-only.
      res.on('data', () => {});
      res.on('end', () => {
        // Collect all response headers as a plain object (lowercased keys).
        const hdrs = {};
        for (const [k, v] of Object.entries(res.headers)) {
          hdrs[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
        }
        resolve({ statusCode: res.statusCode, headers: hdrs });
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => {
      req.destroy(new Error('probe timeout'));
    });
    req.write(body);
    req.end();
  });

  try {
    let result = await doRequest(token);

    // 401/403 → try single refresh-and-retry (port of OCP server.mjs:984-990)
    if ((result.statusCode === 401 || result.statusCode === 403) && refreshToken) {
      const newToken = await _refreshAccessToken(refreshToken);
      if (newToken) {
        token = newToken;
        result = await doRequest(token);
      }
    }

    const { statusCode, headers } = result;

    // Extract ratelimit headers from the response
    const rlHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      if (k.startsWith('anthropic-ratelimit')) {
        rlHeaders[k] = v;
      }
    }

    // Non-2xx AND no ratelimit headers → treat as failure
    if (statusCode >= 400 && Object.keys(rlHeaders).length === 0) {
      // Schedule backoff on failure
      _scheduleBackoff();
      return null;
    }

    // Success (or non-2xx with headers present — headers still valid quota data)
    // Reset backoff on successful probe
    quotaProbeState.backoffMs = QUOTA_BACKOFF_MIN_MS;
    quotaProbeState.backoffUntil = 0;

    const fields = _parseRateLimitHeaders(rlHeaders);
    return { fields, raw: rlHeaders };

  } catch {
    _scheduleBackoff();
    return null;
  }
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

  // D24 round-2 F4 fix: if the timer fired while the drain loop was processing
  // queued items, rejectNext was null at fire-time so the rejection was skipped.
  // The post-loop SPAWN_FAILED + yield-stop guards both check !spawnTimedOut, so
  // the generator would otherwise return normally with partial chunks despite the
  // timeout. This unconditional throw closes the race — SPAWN_TIMEOUT always
  // surfaces as a hard trigger to the fallback engine regardless of which path
  // the timer fire took. Note: any partial chunks already yielded are discarded
  // by the caller. SPAWN_TIMEOUT is intentionally excluded from D16 salvage —
  // see ADR 0004 Amendment 1 § "Why SPAWN_TIMEOUT is excluded from salvage".
  if (spawnTimedOut) {
    throw new ProviderError(
      `claude spawn timed out after ${maxSpawnTimeMs}ms`,
      'SPAWN_TIMEOUT',
    );
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
// D80 (Phase 5) — live plan-usage probe.
//
// Authority: ALIGNMENT.md Class-specific Exception §1
//            ADR 0002 Amendment 8 (READ-ONLY / subscription-scope / idempotent-failure)
//            ADR 0013 (credential reuse, READ-ONLY wire, cache + backoff, opt-in, failure transparency)
//            ADR 0012 D80 (Phase 5 charter)
// Schema pin: ~/.cc-rules/memory/learnings/anthropic_plan_usage_probe_schema_2026_05_26.md
// Port source: OCP server.mjs:842-1109 (usageCache, refreshOAuthToken, fetchUsageFromApi,
//              parseRateLimitHeaders, handleUsage)
//
// ADR 0013 Rule 4 (opt-in): returns null unless config.providers.anthropic.quota_probe_enabled
// is explicitly true in ~/.olp/config.json.
//
// Return shape (when enabled + successful):
//   {
//     probedAt: <unix-ms>,
//     source: 'anthropic-ratelimit-unified-headers',
//     schemaVersion: '2026-05-26',
//     stale: false,
//     fields: { ...13 fields... },
//     raw: { ...response-headers-object... }
//   }
// Returns null when: disabled, no credentials, probe failure with no stale cache.
// Returns { ...shape, stale: true, last_fresh_at } when probe failed but cache exists.
export async function quotaStatus(_authContext) {
  // ADR 0013 Rule 4 — opt-in check
  const providerCfg = _readProviderConfig('anthropic');
  if (providerCfg.quota_probe_enabled !== true) {
    return null;
  }

  const now = Date.now();

  // Cache hit: return cached value if within TTL (ADR 0013 Rule 3)
  if (quotaProbeState.cache !== null &&
      (now - quotaProbeState.cache.fetchedAt) < QUOTA_CACHE_TTL_MS) {
    return quotaProbeState.cache.data;
  }

  // Backoff check: still in exponential backoff window — return stale cache or null
  if (now < quotaProbeState.backoffUntil) {
    if (quotaProbeState.cache !== null) {
      // Return stale cache marked as stale (ADR 0013 Rule 3)
      return {
        ...quotaProbeState.cache.data,
        stale: true,
        last_fresh_at: quotaProbeState.cache.fetchedAt,
      };
    }
    return null; // no stale cache
  }

  // Read auth artifact (ADR 0013 Rule 1 — same credentials as spawn path)
  const creds = readAuthArtifact();
  if (!creds?.accessToken) {
    // No credentials at all — return stale cache or null; do not hammer API with 401s
    return null;
  }

  // Perform the probe
  const probeResult = await _probeOnce(creds);

  if (probeResult !== null) {
    // Success: cache the result, reset backoff
    const shape = {
      probedAt: now,
      source: 'anthropic-ratelimit-unified-headers',
      // D81: schema_version sourced from models-registry.json with QUOTA_SCHEMA_VERSION
      // as fallback per ADR 0013 Rule 5 + D81 ADR 0008 Amendment requirement.
      schemaVersion: _resolveSchemaVersion(),
      stale: false,
      fields: probeResult.fields,
      raw: probeResult.raw,
    };
    quotaProbeState.cache = { fetchedAt: now, data: shape };
    return shape;
  }

  // Probe failed: _probeOnce already called _scheduleBackoff().
  // Return stale cache if present, else null.
  if (quotaProbeState.cache !== null) {
    return {
      ...quotaProbeState.cache.data,
      stale: true,
      last_fresh_at: quotaProbeState.cache.fetchedAt,
    };
  }
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

// ── doctorChecks (ADR 0002 Amendment 7, D67; quota probe check D80) ──────
// Per-plugin probe templates consumed by `olp doctor`. Each check returns
// { status, message, evidence? } where evidence.fix_commands[] flow into the
// next_action.ai_executable[] block and evidence.human_steps[] into
// next_action.human_required[].
//
// Probes:
//   anthropic.cli_available         — `claude --version` resolves on PATH (or via OLP_CLAUDE_BIN)
//   anthropic.oauth_token_present   — `readAuthArtifact()` returns a non-empty accessToken
//   anthropic.quota_probe_reachable — D80 (Phase 5): probe reachable check when quota_probe_enabled.
//                                     Only runs if quota_probe_enabled: true in config.
//                                     ADR 0013 Rule 6 + ADR 0002 Amendment 8.
//
// The first two probes share the existing test seams (binaryExists / readAuthArtifact)
// so the suite can stub them deterministically without spawning the real binary.
export function doctorChecks({ _binaryExistsFn, _authReadFn } = {}) {
  const binaryExists = _binaryExistsFn ?? _defaultBinaryExists;
  const authRead = _authReadFn ?? readAuthArtifact;
  return [
    {
      id: 'anthropic.cli_available',
      category: 'provider',
      async run() {
        if (binaryExists()) {
          return { status: 'ok', message: '`claude` binary resolved on PATH' };
        }
        return {
          status: 'fail',
          message: '`claude` binary not found on PATH (and OLP_CLAUDE_BIN unset/invalid)',
          evidence: {
            fix_commands: [
              'npm install -g @anthropic-ai/claude-code',
            ],
            reference: 'https://docs.anthropic.com/en/docs/claude-code/setup',
          },
        };
      },
    },
    {
      id: 'anthropic.oauth_token_present',
      category: 'provider',
      async run() {
        const auth = authRead();
        if (auth?.accessToken) {
          return { status: 'ok', message: 'OAuth credential present (.credentials.json / env / keychain)' };
        }
        return {
          status: 'fail',
          message: 'Anthropic OAuth credential missing — none of ANTHROPIC_OAUTH_TOKEN env, ~/.claude/.credentials.json, or login keychain returned a token',
          evidence: {
            human_steps: [
              'run: claude  (the first interactive launch prompts for browser OAuth login)',
            ],
            reference: 'https://docs.anthropic.com/en/docs/claude-code/setup#authentication',
          },
        };
      },
    },
    {
      id: 'anthropic.quota_probe_reachable',
      category: 'provider',
      // D80 / ADR 0013 Rule 6 — failure transparency for olp doctor.
      // Only runs if quota_probe_enabled: true in ~/.olp/config.json.
      // Status mapping:
      //   ok   → probe returned fresh data
      //   warn → stale cache returned (probe failed but cache present)
      //   fail → no cache AND probe failed; fix_commands recipe provided
      async run() {
        const providerCfg = _readProviderConfig('anthropic');
        if (providerCfg.quota_probe_enabled !== true) {
          return { status: 'ok', message: 'quota probe disabled (opt-in via config.providers.anthropic.quota_probe_enabled)' };
        }

        // Attempt a fresh probe (bypassing module-level cache for doctor diagnostics)
        const auth = authRead();
        if (!auth?.accessToken) {
          return {
            status: 'fail',
            message: 'quota probe enabled but no OAuth credential — probe cannot run',
            evidence: {
              human_steps: [
                'run: claude  (first interactive launch prompts browser OAuth login)',
              ],
              reference: 'https://docs.anthropic.com/en/docs/claude-code/setup#authentication',
            },
          };
        }

        const result = await _probeOnce(auth);
        if (result !== null) {
          const util5h = result.fields.utilization_5h;
          const util7d = result.fields.utilization_7d;
          const msg = `quota probe OK — 5h utilization: ${util5h !== null ? `${Math.round(util5h * 100)}%` : 'n/a'}, 7d utilization: ${util7d !== null ? `${Math.round(util7d * 100)}%` : 'n/a'}`;
          return { status: 'ok', message: msg };
        }

        // Probe failed — check if stale cache exists
        if (quotaProbeState.cache !== null) {
          const ageMin = Math.round((Date.now() - quotaProbeState.cache.fetchedAt) / 60_000);
          return {
            status: 'warn',
            message: `quota probe failed (returning stale cache from ${ageMin}min ago); check network or token expiry`,
            evidence: {
              fix_commands: [
                'olp doctor  # re-run after verifying OAuth credentials are valid',
              ],
              human_steps: [
                'run: claude  (if token may have expired, re-login)',
              ],
            },
          };
        }

        // No cache at all — hard failure
        return {
          status: 'fail',
          message: 'quota probe failed and no cached data available; check OAuth credentials and network access to api.anthropic.com',
          evidence: {
            fix_commands: [
              'node -e "const { readAuthArtifact } = await import(\'./lib/providers/anthropic.mjs\'); console.log(JSON.stringify(readAuthArtifact()?.accessToken ? \'token_present\' : \'no_token\'))"',
            ],
            human_steps: [
              'verify network access: curl -s -o /dev/null -w "%{http_code}" https://api.anthropic.com/v1/messages',
              'if OAuth token is expired: run: claude  (re-login)',
              'to disable probe: set providers.anthropic.quota_probe_enabled = false in ~/.olp/config.json',
            ],
          },
        };
      },
    },
  ];
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
  // ADR 0002 Amendment 7 (D67): OPTIONAL doctorChecks() — consumed by `olp doctor`.
  doctorChecks: () => doctorChecks(),
  hints: {
    requiresTTY: false,
    concurrentSpawnSafe: true,
    maxConcurrent: 4,
    // ADR 0004 § Trigger taxonomy bullet 4: spawn timeout is a hard trigger.
    // 600_000ms = 10 minutes. Tests can lower this by mutating anthropic.hints.maxSpawnTimeMs.
    maxSpawnTimeMs: 600_000,
    // ADR 0002 Amendment 3 (D23): explicitly cacheable (default true; named here for
    // readability and as a model for future plugins that may need cacheable: false).
    cacheable: true,
  },
};

export default anthropic;

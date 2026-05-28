/**
 * lib/providers/anthropic.mjs — Anthropic Claude provider plugin
 *
 * Authority: OLP ALIGNMENT.md § Authority 1 — anthropic plugin governed by
 *   `claude` CLI from `@anthropic-ai/claude-code`.
 *   D36 #15: See docs/provider-audits/anthropic.md for the version-capture
 *   artifact (single living document; re-capture at every plugin touch or annual
 *   audit).
 *
 * ADR 0009 Amendment 1 (2026-05-27) — stream-json transport replaces -p text:
 *   The spawn mode was changed from `claude -p --output-format text` to
 *   `claude --output-format stream-json --verbose --no-session-persistence
 *   --system-prompt <OLP_SYSTEM_PROMPT_WRAPPER>`.
 *
 *   Authorities (all verified live on PI231, claude CLI v2.1.104, 2026-05-27):
 *     - claude CLI v2.1.104 § --output-format stream-json  (NDJSON event stream)
 *     - claude CLI v2.1.104 § --verbose  (required companion; without it stream-json
 *       produces only the final result event)
 *     - claude CLI v2.1.104 § --system-prompt  (full replacement of default system
 *       prompt; suppresses env-block + tool descriptions injected by claude CLI)
 *     - claude CLI v2.1.104 § --no-session-persistence  (stateless per-spawn)
 *     - OLP ADR 0009 Amendment 1 — decision lock + value re-anchoring
 *     - OLP ALIGNMENT.md Rule 1 — provider plugin authority citation
 *
 *   Four orthogonal values delivered:
 *     1. Hallucination fix: model no longer claims server cwd / OS / tool names.
 *     2. ~64% per-request cost reduction: empirical Sonnet 4.6 $0.0216 → $0.0078,
 *        from ~30% input-token reduction (16,601 → 10,700 tokens).
 *     3. NDJSON observability: rate_limit_event + usage + cache stats per request.
 *     4. Possible 30-60 day bridge for Anthropic 2026-06-15 billing split.
 *
 *   Version pin guidance (ADR 0009 Amendment 1 § "Caveats" point 4):
 *     stream-json without -p confirmed on v2.1.104. Future versions may tighten
 *     this; the plugin emits a server-log warning if `claude --version` falls
 *     outside v2.1.100–v2.1.149. Hard failure is NOT required; warn is sufficient.
 *
 * Spawn pattern ported from:
 *   OCP server.mjs:384-414  (buildCliArgs)
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
 * Lossy translations (per ADR 0003 § "Lossy-translation documentation requirement"):
 *   - `response_format: json_object` — `--system-prompt` augmented with JSON instruction.
 *   - `top_p` — not mapped; dropped silently. `claude` does not expose --top-p.
 *   - `tool_choice: "required"` — not a `claude` flag; dropped.
 *   - Request-level `tools[]` — stream-json mode does not consume structured tool defs
 *     on the wire. Array silently dropped; caller should pre-prompt in system message.
 *     ALIGNMENT.md Rule 2 forbids inventing a wire format Anthropic's CLI doesn't accept.
 *   - Assistant-message `tool_calls` and `tool_call_id` — same reason; dropped.
 *     Textual content preserved, structured call metadata lost.
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
import * as http from 'node:http';
import { ProviderError } from './base.mjs';
// Phase 7 PR-B (ADR 0014 § PR-B): sandbox spawn wrap.
// wrapSpawn() is transparent (returns inputs unchanged) when sandbox is inactive.
// Authority: @anthropic-ai/sandbox-runtime v0.0.52, ADR 0014 § PR-B,
//   ADR 0009 Amendment 1 § unchanged spawn args — only the spawn execution is wrapped.
import { wrapSpawn } from '../sandbox/manager.mjs';

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

// ── OLP system prompt wrapper (ADR 0009 Amendment 1) ─────────────────────
// Injected via `--system-prompt` flag to replace claude CLI's default system
// prompt (which normally includes cwd, OS, tool descriptions, and git status —
// all irrelevant and potentially misleading when the model is accessed via the
// OLP HTTP proxy).
//
// Authority: claude CLI v2.1.104 § --system-prompt (full default-prompt
// replacement verified on PI231 2026-05-27).
// ADR 0009 Amendment 1 § "OLP system prompt wrapper".
export const OLP_SYSTEM_PROMPT_WRAPPER = `You are accessed via the OLP HTTP proxy. You do NOT have access to any local filesystem, working directory, shell, git status, or machine environment. Do not infer or invent such information from any context you observe. Respond only based on the conversation provided.`;

/**
 * Construct the full system-prompt string to pass via --system-prompt.
 *
 * Always starts with OLP_SYSTEM_PROMPT_WRAPPER. If the IR request contains
 * role:system messages, their content is appended after a blank line
 * (concatenated with "\n\n" if multiple).
 *
 * ADR 0009 Amendment 1 § "OLP system prompt wrapper".
 *
 * @param {object} irRequest
 * @returns {string} system prompt string (never null)
 */
export function extractSystemPrompt(irRequest) {
  const systemMessages = (irRequest.messages ?? []).filter(m => m.role === 'system');
  if (systemMessages.length === 0) {
    return OLP_SYSTEM_PROMPT_WRAPPER;
  }
  const clientContent = systemMessages.map(m =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
  ).join('\n\n');
  return `${OLP_SYSTEM_PROMPT_WRAPPER}\n\n${clientContent}`;
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
const QUOTA_OAUTH_TOKEN_URL_DEFAULT = 'https://platform.claude.com/v1/oauth/token';
const QUOTA_API_URL_DEFAULT = 'https://api.anthropic.com/v1/messages';
const QUOTA_CACHE_TTL_MS = 5 * 60 * 1000;       // 5 minutes (OCP USAGE_CACHE_TTL)
const QUOTA_BACKOFF_MIN_MS = 60 * 1000;           // 60s  (OCP OAUTH_REFRESH_MIN_BACKOFF)
const QUOTA_BACKOFF_MAX_MS = 60 * 60 * 1000;      // 3600s (OCP OAUTH_REFRESH_MAX_BACKOFF)
// Local constant is the safety net (ADR 0013 Rule 5 + D81 reviewer nit #4 fold-in).
// The live value is read from models-registry.json at module load via _resolveSchemaVersion().
// If the registry field is absent or fails to load, this constant takes over.
const QUOTA_SCHEMA_VERSION = '2026-05-26';

// ── Test seams for quota probe (D83) ─────────────────────────────────────
// These variables allow tests to redirect HTTP requests to a local mock server
// without modifying production logic. In production, they always hold the
// DEFAULT values. _setQuotaUrlsForTest() / _resetQuotaProbeStateForTest() are
// the ONLY permitted mutations — production code must never call them.
//
// The _quotaHttpMod seam switches from https to http so test mock servers can
// be plain HTTP servers on ephemeral ports (no TLS cert management in tests).
//
// ADR 0012 D83: test seam discipline — injected via export, not monkey-patch.
let _quotaApiUrl = QUOTA_API_URL_DEFAULT;
let _quotaOauthTokenUrl = QUOTA_OAUTH_TOKEN_URL_DEFAULT;
let _quotaHttpMod = https;  // switched to http by _setQuotaUrlsForTest when protocol is http:

export function _setQuotaUrlsForTest(apiUrl, oauthUrl) {
  _quotaApiUrl = apiUrl;
  _quotaOauthTokenUrl = oauthUrl ?? _quotaOauthTokenUrl;
  // Auto-detect protocol: if test URL is http, use http module (no TLS)
  const proto = new URL(apiUrl).protocol;
  _quotaHttpMod = proto === 'http:' ? http : https;
}

export function _resetQuotaProbeStateForTest() {
  // Resets probe runtime state (cache + backoff), restores production URLs,
  // and clears the auth-read override. Call in test finally blocks.
  _quotaApiUrl = QUOTA_API_URL_DEFAULT;
  _quotaOauthTokenUrl = QUOTA_OAUTH_TOKEN_URL_DEFAULT;
  _quotaHttpMod = https;
  _quotaAuthReadFnForTest = null;
  quotaProbeState.cache = null;
  quotaProbeState.backoffUntil = 0;
  quotaProbeState.backoffMs = QUOTA_BACKOFF_MIN_MS;
  // v0.5.1 (F3): reset failure-tracking fields
  quotaProbeState.lastError = null;
  quotaProbeState.failureKind = null;
}

// Convenience: reset state only, leaving URL overrides in place.
// Useful when a test sets URLs first, then wants a clean cache/backoff.
export function _resetQuotaStateOnlyForTest() {
  quotaProbeState.cache = null;
  quotaProbeState.backoffUntil = 0;
  quotaProbeState.backoffMs = QUOTA_BACKOFF_MIN_MS;
  // v0.5.1 (F3): reset failure-tracking fields
  quotaProbeState.lastError = null;
  quotaProbeState.failureKind = null;
}

// Returns a direct reference to the internal quotaProbeState object.
// Tests MUST NOT store this reference across calls — the object is stable
// but its properties are mutated by the probe machinery. Direct mutation
// (e.g. state.backoffUntil = 0) is safe ONLY in test contexts where a
// controlled probe sequence is being driven. Production code never mutates
// this object from outside this module.
export function _getQuotaProbeStateForTest() {
  return quotaProbeState;
}

// Optional override for readAuthArtifact used by quotaStatus() and doctorChecks().
// When non-null, replaces readAuthArtifact() for probe calls. Reset to null via
// _resetQuotaProbeStateForTest() or explicitly by assigning null.
// This seam prevents real credential files from interfering with unit tests.
let _quotaAuthReadFnForTest = null;
export function _setQuotaAuthReadFnForTest(fn) { _quotaAuthReadFnForTest = fn; }

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
// v0.5.1: added lastError + failureKind for F3 failure-transparency (ADR 0013 Rule 6).
const quotaProbeState = {
  cache: null,          // { fetchedAt: <ms>, data: <quotaShape> } when fresh; null when not
  backoffUntil: 0,      // ms epoch: when next refresh attempt is allowed
  backoffMs: QUOTA_BACKOFF_MIN_MS, // current backoff window; doubled on failure, reset on success
  // v0.5.1 (F3 — ADR 0013 Rule 6 failure transparency):
  lastError: null,      // { kind, message, statusCode?, attemptedAt } | null
  failureKind: null,    // 'no_credentials'|'auth_failed'|'rate_limited'|'schema_drift'|'network'|'other' | null
                        // Note: 'opt_in_off' is NOT in this enum — when the probe is opted out
                        // quotaStatus() returns the literal null BEFORE any state mutation, so
                        // failureKind is never produced for the disabled case. Consumers
                        // (audit-query, doctor) distinguish opt-in-off by quotaStatus() === null.
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
    const url = new URL(_quotaOauthTokenUrl);
    const options = {
      hostname: url.hostname,
      port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = _quotaHttpMod.request(options, (res) => {
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
    const url = new URL(_quotaApiUrl);
    const options = {
      hostname: url.hostname,
      port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80),
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
    const req = _quotaHttpMod.request(options, (res) => {
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
    // Classify failure kind for F3 (ADR 0013 Rule 6 failure transparency).
    if (statusCode >= 400 && Object.keys(rlHeaders).length === 0) {
      const now = Date.now();
      const kind = (statusCode === 401 || statusCode === 403) ? 'auth_failed'
        : statusCode === 429 ? 'rate_limited'
        : 'other';
      quotaProbeState.lastError = { kind, message: `HTTP ${statusCode}`, statusCode, attemptedAt: now };
      quotaProbeState.failureKind = kind;
      _scheduleBackoff();
      return null;
    }

    // v0.5.1 F2 (ADR 0013 Rule 5 minimum-viable-schema gate):
    // Require at least these 4 load-bearing fields (5h-utilization, 5h-reset,
    // 7d-utilization, 7d-reset). A 200 OK with zero ratelimit headers (or with
    // headers but missing these 4) is treated as schema-drift and classified as
    // failure. The other 9 fields are tolerated as missing.
    //
    // Authority: ADR 0013 Rule 5 + codex review finding F2 (v0.5.1 hotfix).
    const MIN_FIELDS = [
      'anthropic-ratelimit-unified-5h-utilization',
      'anthropic-ratelimit-unified-5h-reset',
      'anthropic-ratelimit-unified-7d-utilization',
      'anthropic-ratelimit-unified-7d-reset',
    ];
    const missingMinFields = MIN_FIELDS.filter(f => rlHeaders[f] == null);
    if (missingMinFields.length > 0) {
      const now = Date.now();
      const msg = `schema_drift: missing minimum-viable fields: ${missingMinFields.join(', ')}`;
      quotaProbeState.lastError = { kind: 'schema_drift', message: msg, statusCode, attemptedAt: now };
      quotaProbeState.failureKind = 'schema_drift';
      _scheduleBackoff();
      return null;
    }

    // Success (or non-2xx with headers present and passing min-field gate —
    // headers still valid quota data). Reset backoff on successful probe.
    quotaProbeState.backoffMs = QUOTA_BACKOFF_MIN_MS;
    quotaProbeState.backoffUntil = 0;
    quotaProbeState.lastError = null;
    quotaProbeState.failureKind = null;

    const fields = _parseRateLimitHeaders(rlHeaders);
    return { fields, raw: rlHeaders };

  } catch (err) {
    const now = Date.now();
    const msg = err?.message ?? String(err);
    quotaProbeState.lastError = { kind: 'network', message: msg, attemptedAt: now };
    quotaProbeState.failureKind = 'network';
    _scheduleBackoff();
    return null;
  }
}

// ── IR → prompt text serialization ───────────────────────────────────────
// OCP server.mjs:422-468 (messagesToPrompt) — no session management in OLP;
// we always pass the full serialized messages as stdin to `claude` (no -p).
//
// ADR 0009 Amendment 1: role:system messages are now extracted by
// `extractSystemPrompt()` and injected via `--system-prompt` flag (which fully
// replaces claude CLI's default prompt). They are SKIPPED here to avoid
// double-injection. All other roles (user, assistant, tool) are serialized to
// text as before and written to stdin.
//
// `claude` reads its prompt from stdin when --output-format stream-json is used
// without a prompt argument.
//
// ADR 0003 § Translation direction model: the plugin owns irToNative.
export function irToAnthropic(irRequest) {
  const parts = [];

  for (const msg of irRequest.messages) {
    // ADR 0009 Amendment 1: system messages routed via --system-prompt flag;
    // skip here to avoid double-injection into the stdin prompt.
    if (msg.role === 'system') continue;

    const text = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content);

    if (msg.role === 'assistant') {
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
  // Note: this injects a [System] annotation into the stdin prompt (legacy path).
  // A future ADR 0009 follow-up may route this via extractSystemPrompt() instead.
  // ADR 0003 § Lossy-translation documentation requirement.
  if (irRequest.response_format?.type === 'json_object') {
    parts.unshift('[System] Reply with valid JSON only. Do not include any prose outside the JSON structure.');
  }

  return parts.join('\n\n');
}

// ── Anthropic raw-text chunk → IR ResponseChunk (LEGACY) ─────────────────
// @legacy: Used by the former `claude -p --output-format text` spawn path.
//   ADR 0009 Amendment 1 replaced that path with stream-json NDJSON parsing.
//   This function is kept exported for backward-compatibility with any tests
//   that still exercise the old text-chunk path directly. New code uses
//   `anthropicStreamJsonEventToIR()` instead.
//
// Authority: OCP server.mjs:735-748 (raw text chunk pattern).
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

// ── NDJSON line buffer parser ─────────────────────────────────────────────
// Splits a buffered string on newlines. Returns complete JSON-parsed events
// plus the trailing incomplete line as `remainder` for the next data chunk.
//
// ADR 0009 Amendment 1 — stream-json NDJSON event handling.
// Authority: claude CLI v2.1.104 § --output-format stream-json (each event is
//   emitted as a newline-terminated JSON object on stdout).
//
// @param {string} buffered — accumulated stdout string (may be partial last line)
// @returns {{ events: Array<object|{type:'parse_error',raw:string}>, remainder: string }}
export function parseStreamJsonLines(buffered) {
  const lines = buffered.split('\n');
  const remainder = lines.pop(); // last element is the incomplete trailing line
  const events = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue; // skip blank lines between events
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // ADR 0009 Amendment 1: log + skip bad lines, don't abort the stream.
      console.error('[anthropic] NDJSON parse error on line:', trimmed.slice(0, 120));
      events.push({ type: 'parse_error', raw: trimmed });
    }
  }
  return { events, remainder: remainder ?? '' };
}

// ── NDJSON event → IR ResponseChunk ──────────────────────────────────────
// Maps claude CLI stream-json NDJSON events to IR chunks per ADR 0009 Amendment 1.
//
// ADR 0009 Amendment 1 § "NDJSON event handling" table:
//
//   system/init              → null (consumed; no yield)
//   stream_event/content_block_delta/text_delta → { type:'delta', content }
//   assistant                → null (aggregate message; already captured by deltas)
//   result/success           → { type:'stop', finish_reason:'stop' }
//   result/is_error          → throws ProviderError
//   rate_limit_event         → null (logged; future audit integration)
//   control_request          → null (log + skip)
//   parse_error              → null (log + skip)
//   other/unknown            → null (log + skip; future-proof)
//
// Authority: claude CLI v2.1.104 § --output-format stream-json (observed event
//   shapes on PI231 2026-05-27 live transcript, retained in cc-mem).
//
// @param {object} event — parsed NDJSON event object
// @param {boolean} isFirstDelta — true if no content_block_delta has been yielded yet
// @returns {object|null} IR chunk or null (consumed event)
export function anthropicStreamJsonEventToIR(event, isFirstDelta = false) {
  const t = event?.type;

  // system/* — first-event init plus any other system meta (api_retry, etc.)
  // emitted during error paths. None map to IR chunks; all consumed silently.
  // Originally we matched only `subtype === 'init'`, which caused noisy
  // "unknown stream_json event type: system" logs during 401 cascades when
  // claude emits other system subtypes. (Observed PI231 2026-05-28.)
  if (t === 'system') {
    return null;
  }

  // user — claude echoes the user-message back as a confirmation event in
  // some stream-json modes (analogous to --replay-user-messages). Always
  // consumed; never an IR chunk.
  if (t === 'user') {
    return null;
  }

  // stream_event — contains nested event with content_block_delta
  if (t === 'stream_event') {
    const inner = event.event ?? event; // some versions nest under .event
    if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
      const chunk = {
        type: 'delta',
        content: inner.delta.text ?? '',
      };
      if (isFirstDelta) chunk.role = 'assistant';
      return chunk;
    }
    // Other stream_event sub-types (content_block_start, message_delta, etc.)
    return null;
  }

  // assistant — aggregated message. Two cases:
  //   (a) Streaming via content_block_delta WAS happening → this aggregate is a duplicate, return null
  //   (b) claude emitted ONLY the aggregate (no content_block_delta) → must extract content here,
  //       otherwise the response body is empty
  //
  // Empirically (PI231 v2.1.104, 2026-05-27 live transcripts): when running without `-p`
  // and without --include-partial-messages, claude emits ONLY the aggregate `assistant`
  // event for fast/short responses — no content_block_delta events. The reviewer brief's
  // "fall back" branch (track whether ANY content_block_delta was seen; if not, use
  // assistant.message.content text) is load-bearing for these responses.
  //
  // isFirstDelta=true means no delta has been emitted yet → fall back to extract here.
  // isFirstDelta=false means deltas were already streamed → this is a duplicate, ignore.
  if (t === 'assistant') {
    if (isFirstDelta) {
      const blocks = event.message?.content;
      if (Array.isArray(blocks)) {
        const text = blocks
          .filter(b => b && b.type === 'text' && typeof b.text === 'string')
          .map(b => b.text)
          .join('');
        if (text) {
          return {
            type: 'delta',
            content: text,
            role: 'assistant',
            model: event.message?.model,
          };
        }
      }
    }
    return null;
  }

  // result — terminal event
  if (t === 'result') {
    if (event.is_error === true) {
      throw new ProviderError(
        event.error_message ?? event.result ?? 'claude returned is_error',
        'PROVIDER_ERROR',
      );
    }
    // success or other subtype — treat as stop
    return { type: 'stop', finish_reason: 'stop' };
  }

  // rate_limit_event — future: forward to audit/dashboard layer
  if (t === 'rate_limit_event') {
    // ADR 0009 Amendment 1: rate_limit events logged for future observability work.
    // Not yielded as IR chunks (no current consumer).
    return null;
  }

  // control_request — per Anthropic stream-json docs
  if (t === 'control_request') {
    console.error('[anthropic] stream_json control_request event (ignored):', JSON.stringify(event).slice(0, 120));
    return null;
  }

  // parse_error — generated by parseStreamJsonLines on bad lines
  if (t === 'parse_error') {
    return null; // already logged by parseStreamJsonLines
  }

  // Unknown event type — log + skip; future-proof for new claude CLI events
  if (t !== undefined) {
    console.error('[anthropic] unknown stream_json event type:', t);
  }
  return null;
}

// ── CLI args builder ──────────────────────────────────────────────────────
// ADR 0009 Amendment 1 — replaces the former `-p --output-format text` spawn
// with `--output-format stream-json --verbose --no-session-persistence
// --system-prompt <text>`.
//
// Authority (all verified live on PI231, claude CLI v2.1.104, 2026-05-27):
//   - claude CLI v2.1.104 § --output-format stream-json — NDJSON event stream
//   - claude CLI v2.1.104 § --verbose — required for per-token streaming events
//     (without --verbose, only the final result event is emitted)
//   - claude CLI v2.1.104 § --no-session-persistence — stateless per-spawn
//   - claude CLI v2.1.104 § --system-prompt — full default-prompt replacement
//     (suppresses cwd / OS / tool descriptions from the claude CLI default prompt)
//
// NOTE: No `-p` flag. ADR 0009 Amendment 1 § "Locked decision" — Transport A
// (stream-json without -p) confirmed working on v2.1.104. If the `result` event
// is not emitted (e.g. version drift), proc.on('close') emits a synthetic stop.
//
// @param {string} model — model ID to pass via --model
// @param {string} systemPrompt — full system prompt text (from extractSystemPrompt)
// @returns {string[]} CLI argument array
export function buildCliArgs(model, systemPrompt) {
  return [
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--system-prompt', systemPrompt,
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
// ADR 0009 Amendment 1: uses NDJSON stream-json output path (no -p).
// stdout is line-buffered via parseStreamJsonLines; each parsed event is
// dispatched through anthropicStreamJsonEventToIR. The `result` event emits the
// stop chunk; proc.on('close') is the safety net if `result` is never emitted.
//
// OCP server.mjs:542: const proc = spawn(CLAUDE, cliArgs, { env, stdio: [...] });
async function* _spawnAndStream(irRequest, authContext, spawnImpl) {
  const auth = authContext ?? readAuthArtifact();
  if (!auth?.accessToken) {
    throw new ProviderError(
      'No Anthropic OAuth token found. Run `claude auth login` or set CLAUDE_CODE_OAUTH_TOKEN.',
      'AUTH_MISSING',
    );
  }

  const bin = resolveClaudeBin();
  const env = buildSpawnEnv();

  // OAuth credential strategy:
  //
  // Previously this plugin set env.CLAUDE_CODE_OAUTH_TOKEN to the accessToken
  // value read from ~/.claude/.credentials.json (or keychain). That worked at
  // call time but defeated the CLI's built-in auto-refresh: when env var is
  // present, claude reads it directly and never touches credentials.json, so
  // expired access tokens were never swapped using the refreshToken sitting
  // right there in the file. The result was a hard 401 cascade every few
  // hours (access token TTL ≈ 8h) requiring manual keychain → PI231 copy.
  //
  // 2026-05-28 spike: with credentials.json present and CLAUDE_CODE_OAUTH_TOKEN
  // unset, the CLI detects expired accessToken, calls the OAuth token endpoint
  // with refreshToken, persists the new accessToken/expiresAt back to
  // credentials.json, and proceeds. Tested on PI231 v2.1.104 with simulated
  // expiry; the file's expiresAt advanced from "1 min ago" to "8 hours from
  // now" in a single spawn cycle.
  //
  // So: DO NOT inject env.CLAUDE_CODE_OAUTH_TOKEN here. buildSpawnEnv already
  // forwards process.env (minus ANTHROPIC_*), so if the operator explicitly
  // set CLAUDE_CODE_OAUTH_TOKEN at OLP boot time, it's still honored — that
  // path is for users who can't rely on file/keychain (e.g. ephemeral CI).
  //
  // The readAuthArtifact() call above is now a preflight check only — verify
  // creds exist before spawn — but the value is NOT forwarded to the CLI.
  //
  // Authority:
  //   - claude CLI v2.1.104 reads ~/.claude/.credentials.json + refreshes via
  //     refreshToken (empirically verified PI231 2026-05-28; no public doc cite)
  //   - OCP server.mjs:864-888 was the historical source of the env-injection
  //     pattern, kept here for OAuth artifact discovery but no longer for env
  //     forwarding

  // ADR 0009 Amendment 1: system prompt extracted from IR messages,
  // prepended with OLP_SYSTEM_PROMPT_WRAPPER, passed via --system-prompt.
  const systemPrompt = extractSystemPrompt(irRequest);
  const args = buildCliArgs(irRequest.model, systemPrompt);

  // stdin: serialized user/assistant/tool messages (system skipped — goes via --system-prompt)
  const prompt = irToAnthropic(irRequest);

  // Phase 7 PR-B (ADR 0014 § PR-B): wrap spawn in sandbox-runtime if active.
  // wrapSpawn() is transparent when sandbox is inactive (returns inputs unchanged).
  // Per-spawn ephemeral cwd (UUID) is created inside wrapSpawn to prevent cross-
  // request contamination. Allowed domains are the Anthropic API domains only.
  //
  // ADR 0009 Amendment 1 § unchanged spawn args: only the spawn execution is
  // wrapped — bin/args/env/NDJSON parsing are all unchanged from pre-PR-B.
  //
  // Authority: @anthropic-ai/sandbox-runtime v0.0.52 wrapWithSandbox() API,
  //   ADR 0014 § PR-B, spike-anthropic.mjs (PI231 2026-05-28).
  const wrapped = await wrapSpawn({
    bin,
    args,
    env,
    cwd: undefined, // let manager assign ephemeral cwd
    allowedDomains: ['api.anthropic.com', 'statsig.anthropic.com'],
  });

  // OCP server.mjs:542: spawn(CLAUDE, cliArgs, { env, stdio: ["pipe", "pipe", "pipe"] })
  const proc = spawnImpl(wrapped.bin, wrapped.args, {
    env: wrapped.env,
    ...(wrapped.cwd ? { cwd: wrapped.cwd } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // OCP server.mjs:586-587: proc.stdin.write(prompt); proc.stdin.end();
  proc.stdin.write(prompt);
  proc.stdin.end();

  // Yield IR chunks as they arrive from stdout.
  let isFirstChunk = true;
  let accumulatedStderr = '';
  // NDJSON line buffer — accumulates partial lines across data events
  let lineBuffer = '';
  // Track whether a result event was seen — prevents double-stop emission
  // (result event yields stop; if close arrives after the break, no synthetic stop needed)
  let resultEventSeen = false;

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

  // ADR 0009 Amendment 1: NDJSON line-buffered stdout parsing
  proc.stdout.on('data', (d) => {
    lineBuffer += d.toString();
    const { events, remainder } = parseStreamJsonLines(lineBuffer);
    lineBuffer = remainder;
    for (const event of events) {
      push({ type: 'event', event });
    }
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

      // ADR 0009 Amendment 1: NDJSON events dispatched through IR mapper
      if (item.type === 'event') {
        let irChunk;
        try {
          irChunk = anthropicStreamJsonEventToIR(item.event, isFirstChunk);
        } catch (e) {
          // anthropicStreamJsonEventToIR throws ProviderError on result.is_error
          throw e;
        }
        if (irChunk !== null) {
          yield irChunk;
          if (irChunk.type === 'delta') isFirstChunk = false;
          if (irChunk.type === 'stop') {
            resultEventSeen = true;
            break; // result event = terminal; don't emit synthetic stop
          }
        }
        // null = consumed event (system/init, rate_limit_event, etc.) — continue
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

  // Process close — safety net if no `result` event was emitted
  // (e.g. version drift where stream-json is not supported without -p).
  // Only throw on non-zero exit; zero exit with no result → emit synthetic stop.
  if (exitCode !== 0 && !spawnTimedOut) {
    const errMsg = accumulatedStderr.slice(0, 300) || `claude exit ${exitCode}`;
    throw new ProviderError(errMsg, 'SPAWN_FAILED');
  }

  // Normal exit AND no `result` event seen — emit synthetic stop as fallback.
  // ADR 0009 Amendment 1: if result event was seen, resultEventSeen is true and
  // the stop was already yielded before the break; don't duplicate it.
  // This path fires when close happens without a prior result event (e.g. very old
  // claude versions, partial output, or version drift where stream-json changes).
  if (!spawnTimedOut && !resultEventSeen) {
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
// ADR 0013 Rule 4 (opt-in): returns null ONLY when quota_probe_enabled is false.
// All other failure paths return a structured failure shape instead of null.
//
// v0.5.1 return contract (F1+F3 — ADR 0013 Rules 3+6 + codex review):
//
//   null          → ONLY when quota_probe_enabled: false (opt-in off)
//
//   { probe_status: 'live', probedAt, source, schemaVersion,
//     stale: false, fields, raw }
//                 → probe succeeded recently (within QUOTA_CACHE_TTL_MS)
//
//   { probe_status: 'stale', ...cachedShape, stale: true, last_fresh_at,
//     failure: { kind, message, backoff_until } }
//                 → probe failed but cache exists (backoff active)
//
//   { probe_status: 'unreachable', source, schemaVersion,
//     failure: { kind, message, backoff_until? } }
//                 → probe failed AND no cache (includes no_credentials case when
//                   creds absent after opt-in, also in-backoff-no-cache)
//
// Backwards-compat note: stale:false shape gains probe_status:'live' (additive).
// stale:true shape gains probe_status:'stale' (additive). 'unreachable' replaces
// the prior null for failure cases (breaking only if caller checked null for
// "disabled" — now null strictly means disabled only).
export async function quotaStatus(_authContext) {
  // ADR 0013 Rule 4 — opt-in check; null means "disabled", not "failed"
  const providerCfg = _readProviderConfig('anthropic');
  if (providerCfg.quota_probe_enabled !== true) {
    return null;
  }

  const schemaVersion = _resolveSchemaVersion();
  const now = Date.now();

  // Cache hit: return cached value if within TTL (ADR 0013 Rule 3)
  if (quotaProbeState.cache !== null &&
      (now - quotaProbeState.cache.fetchedAt) < QUOTA_CACHE_TTL_MS) {
    // Cache is fresh — return probe_status:'live' shape
    return { ...quotaProbeState.cache.data, probe_status: 'live' };
  }

  // Backoff check: still in exponential backoff window — return stale cache or unreachable
  if (now < quotaProbeState.backoffUntil) {
    const failureInfo = {
      kind: quotaProbeState.failureKind ?? 'other',
      message: quotaProbeState.lastError?.message ?? 'probe failed (in backoff)',
      backoff_until: quotaProbeState.backoffUntil,
    };
    if (quotaProbeState.cache !== null) {
      // Return stale cache marked as stale (ADR 0013 Rule 3)
      return {
        ...quotaProbeState.cache.data,
        probe_status: 'stale',
        stale: true,
        last_fresh_at: quotaProbeState.cache.fetchedAt,
        failure: failureInfo,
      };
    }
    // In backoff but no cache — unreachable
    return {
      probe_status: 'unreachable',
      source: 'anthropic-ratelimit-unified-headers',
      schemaVersion,
      failure: failureInfo,
    };
  }

  // Read auth artifact (ADR 0013 Rule 1 — same credentials as spawn path).
  // _quotaAuthReadFnForTest allows tests to inject a mock without real credential files.
  const _authReadFn = _quotaAuthReadFnForTest ?? readAuthArtifact;
  const creds = _authReadFn();
  if (!creds?.accessToken) {
    // No credentials — set failureKind so doctor/aggregator can distinguish this
    quotaProbeState.lastError = { kind: 'no_credentials', message: 'no OAuth credential found', attemptedAt: now };
    quotaProbeState.failureKind = 'no_credentials';
    if (quotaProbeState.cache !== null) {
      // Stale cache still available — return it with failure info
      return {
        ...quotaProbeState.cache.data,
        probe_status: 'stale',
        stale: true,
        last_fresh_at: quotaProbeState.cache.fetchedAt,
        failure: { kind: 'no_credentials', message: 'no OAuth credential found' },
      };
    }
    return {
      probe_status: 'unreachable',
      source: 'anthropic-ratelimit-unified-headers',
      schemaVersion,
      failure: { kind: 'no_credentials', message: 'no OAuth credential found' },
    };
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
      schemaVersion,
      probe_status: 'live',
      stale: false,
      fields: probeResult.fields,
      raw: probeResult.raw,
    };
    quotaProbeState.cache = { fetchedAt: now, data: shape };
    return shape;
  }

  // Probe failed: _probeOnce already called _scheduleBackoff() and set lastError/failureKind.
  const failureInfo = {
    kind: quotaProbeState.failureKind ?? 'other',
    message: quotaProbeState.lastError?.message ?? 'probe failed',
    backoff_until: quotaProbeState.backoffUntil,
  };

  if (quotaProbeState.cache !== null) {
    return {
      ...quotaProbeState.cache.data,
      probe_status: 'stale',
      stale: true,
      last_fresh_at: quotaProbeState.cache.fetchedAt,
      failure: failureInfo,
    };
  }
  // No cache — return unreachable shape (F3: operator can distinguish failure modes)
  return {
    probe_status: 'unreachable',
    source: 'anthropic-ratelimit-unified-headers',
    schemaVersion,
    failure: failureInfo,
  };
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
      // v0.5.1 (F1 — ADR 0013 Rule 3 + codex review):
      // Routes through quotaStatus() so it respects cache + backoff.
      // Bypassing _probeOnce() directly (old code) allowed successive `olp doctor`
      // invocations to each hit upstream even when backoffUntil was in the future.
      //
      // Status mapping based on quotaStatus() probe_status:
      //   null (opt-in off)       → ok + advisory
      //   probe_status: 'live'    → ok + utilization data in message
      //   probe_status: 'stale'   → warn + age info + failure kind in message
      //   probe_status: 'unreachable' (no_credentials) → fail + human_steps (re-login)
      //   probe_status: 'unreachable' (auth_failed/rate_limited/schema_drift/network/other)
      //                           → fail + human_steps + fix_commands
      async run() {
        // Inject the test auth override so tests can seed the quotaAuthReadFn.
        // In production _quotaAuthReadFnForTest is null so quotaStatus() reads
        // credentials normally. Tests can set it via _setQuotaAuthReadFnForTest.
        if (authRead !== readAuthArtifact) {
          _quotaAuthReadFnForTest = authRead;
        }
        try {
          const result = await quotaStatus(null);

          // null → opt-in off
          if (result === null) {
            return { status: 'ok', message: 'quota probe disabled (opt-in via config.providers.anthropic.quota_probe_enabled)' };
          }

          const probeStatus = result.probe_status;

          if (probeStatus === 'live') {
            const util5h = result.fields?.utilization_5h;
            const util7d = result.fields?.utilization_7d;
            const msg = `quota probe OK — 5h utilization: ${util5h !== null && util5h !== undefined ? `${Math.round(util5h * 100)}%` : 'n/a'}, 7d utilization: ${util7d !== null && util7d !== undefined ? `${Math.round(util7d * 100)}%` : 'n/a'}`;
            return { status: 'ok', message: msg };
          }

          if (probeStatus === 'stale') {
            const ageMin = result.last_fresh_at
              ? Math.round((Date.now() - result.last_fresh_at) / 60_000)
              : null;
            const failKind = result.failure?.kind ?? 'other';
            const ageStr = ageMin !== null ? ` from ${ageMin}min ago` : '';
            return {
              status: 'warn',
              message: `quota probe failed (${failKind}); returning stale cache${ageStr}; check network or token expiry`,
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

          // probe_status === 'unreachable' — distinguish failure kind
          const failKind = result.failure?.kind ?? 'other';
          const failMsg = result.failure?.message ?? 'probe failed';

          if (failKind === 'no_credentials') {
            return {
              status: 'fail',
              message: `quota probe enabled but no OAuth credential — ${failMsg}`,
              evidence: {
                human_steps: [
                  'run: claude  (first interactive launch prompts browser OAuth login)',
                ],
                reference: 'https://docs.anthropic.com/en/docs/claude-code/setup#authentication',
              },
            };
          }

          if (failKind === 'auth_failed') {
            return {
              status: 'fail',
              message: `quota probe auth failure (${failMsg}); OAuth token may be expired`,
              evidence: {
                human_steps: [
                  'if OAuth token is expired: run: claude  (re-login)',
                  'to disable probe: set providers.anthropic.quota_probe_enabled = false in ~/.olp/config.json',
                ],
                reference: 'https://docs.anthropic.com/en/docs/claude-code/setup#authentication',
              },
            };
          }

          if (failKind === 'schema_drift') {
            return {
              status: 'fail',
              message: `quota probe schema drift detected (${failMsg}); schema may have changed`,
              evidence: {
                human_steps: [
                  'check for OLP updates: the anthropic-ratelimit-unified-* header schema may have changed',
                  'file an issue if the schema has genuinely drifted (ADR 0013 Rule 5)',
                ],
                fix_commands: [
                  'node -e "const {_getQuotaProbeStateForTest: s}=await import(\'./lib/providers/anthropic.mjs\');console.log(JSON.stringify(s().lastError))"',
                ],
              },
            };
          }

          // rate_limited / network / other
          return {
            status: 'fail',
            message: `quota probe failed and no cached data available (${failKind}: ${failMsg})`,
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
        } finally {
          // Restore auth override so this doctor run does not permanently affect
          // the module-level state beyond this call.
          if (authRead !== readAuthArtifact) {
            _quotaAuthReadFnForTest = null;
          }
        }
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

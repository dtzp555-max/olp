/**
 * lib/fallback/engine.mjs — OLP Fallback Engine
 *
 * Authority: ADR 0004 — Fallback Engine Semantics and Safety
 *
 * Implements:
 *   - Trigger taxonomy (Hard / Soft per ADR 0004 § Decision § Trigger taxonomy)
 *   - Chain advancement one-at-a-time (ADR 0004 § Decision § Chain advancement)
 *   - First-chunk safety rule (ADR 0004 § Decision § Fallback safety)
 *   - Observability return values for header annotation (ADR 0004 § Decision § Observability headers)
 *   - No fallback for client-side errors (ADR 0004 § Decision § No fallback for client-side errors)
 *
 * Sealed at D9. Do NOT modify without an ADR 0004 amendment.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ProviderError } from '../providers/base.mjs';
import { getProviderForModel } from '../providers/index.mjs';

// ── Hard-trigger evaluation ────────────────────────────────────────────────

/**
 * Maps ProviderError codes to hard-trigger decisions.
 * Per ADR 0004 § Decision § Trigger taxonomy — Hard triggers:
 *   - QUOTA_EXHAUSTED     → hard trigger
 *   - RATE_LIMITED        → hard trigger
 *   - SPAWN_FAILED        → hard trigger (provider CLI failed)
 *   - CLI_NOT_FOUND       → hard trigger (binary missing)
 *   - AUTH_MISSING        → NOT a hard trigger (user-config failure; user must fix)
 *   - OUTPUT_PARSE_ERROR  → hard trigger
 *
 * @type {Record<string, boolean>}
 */
const HARD_TRIGGER_CODES = {
  QUOTA_EXHAUSTED: true,
  RATE_LIMITED: true,
  SPAWN_FAILED: true,
  CLI_NOT_FOUND: true,
  AUTH_MISSING: false,   // user config problem — never fall over (ADR 0004 § Decision)
  OUTPUT_PARSE_ERROR: true,
  SPAWN_TIMEOUT: true,   // ADR 0004 § Trigger taxonomy bullet 4: spawn timeout is a hard trigger
};

/**
 * HTTP status codes that are client errors and MUST NOT trigger fallback.
 * Per ADR 0004 § Decision § "No fallback for client-side errors":
 *   HTTP 400, 401, 403, 404, 422 from a provider are NOT fallback triggers.
 *
 * @type {Set<number>}
 */
const CLIENT_ERROR_STATUSES = new Set([400, 401, 403, 404, 422]);

/**
 * Returns true if `status` is a client-side error that must NOT trigger fallback.
 * Exported for tests.
 *
 * @param {number} status
 * @returns {boolean}
 */
export function isClientError(status) {
  return CLIENT_ERROR_STATUSES.has(status);
}

/**
 * Evaluates whether an error from a provider qualifies as a Hard trigger.
 *
 * Per ADR 0004 § Decision § Trigger taxonomy — Hard triggers:
 *   HTTP 5xx and quota-exhaustion 4xx (surfaced via ProviderError codes)
 *   trigger mandatory chain advancement.
 *
 * Per ADR 0004 § Decision § "No fallback for client-side errors":
 *   Client-side HTTP errors (400/401/403/404/422) are NOT hard triggers.
 *   AUTH_MISSING is also not a hard trigger (user must fix their config).
 *
 * @param {Error} error — the error thrown by executeHopFn
 * @param {object} [_providerHints] — reserved for future hints-based logic
 * @returns {boolean} — true if this error should trigger chain advancement
 */
export function evaluateHardTriggers(error, _providerHints = {}) {
  if (!error) return false;

  // ProviderError with a code: map via HARD_TRIGGER_CODES lookup.
  // AUTH_MISSING is explicitly false in the table — do not fall over.
  if (error instanceof ProviderError && error.code) {
    return HARD_TRIGGER_CODES[error.code] === true;
  }

  // HTTP status code present on the error object.
  const status = error.statusCode ?? error.status ?? null;
  if (status !== null && typeof status === 'number') {
    // Client-side errors: never fall over (ADR 0004 § No fallback for client-side errors)
    if (CLIENT_ERROR_STATUSES.has(status)) {
      return false;
    }
    // 5xx: always a hard trigger (ADR 0004 § Hard triggers: HTTP 5xx from provider)
    if (status >= 500) {
      return true;
    }
    // Non-client 4xx (e.g. 429 / 529): hard trigger (quota exhaustion semantics)
    if (status >= 400) {
      return true;
    }
  }

  // Unknown error type — conservative default: do NOT trigger fallback.
  // Per ADR 0004 § Alternatives considered (a): "any error" fallback was rejected.
  return false;
}

// ── Soft-trigger evaluation ────────────────────────────────────────────────

/**
 * Evaluates whether a chain hop's soft triggers fire against the current
 * quota snapshot for that provider.
 *
 * Per ADR 0004 § Decision § Trigger taxonomy — Soft triggers:
 *   - credit_pool_percent_threshold:       fires when percentUsed >= threshold
 *   - daily_request_count_threshold:       fires when dailyCount >= threshold
 *   - five_hour_window_percent_threshold:  fires when fiveHourWindowPercent >= threshold
 *
 * Per ADR 0004 § Consequences/Negative (Mitigations):
 *   null quotaStatus → treat as "don't fire" — degrade gracefully.
 *
 * @param {object|null|undefined} triggerConfig — per-hop soft-trigger config, e.g.
 *   { credit_pool_percent_threshold: 90, daily_request_count_threshold: 1000 }
 * @param {object|null|undefined} quotaSnapshot — from provider.quotaStatus(), e.g.
 *   { percentUsed: 95, dailyCount: 500, fiveHourWindowPercent: 80 }
 *   May be null if the provider cannot retrieve quota.
 * @returns {boolean} — true if any configured soft trigger fires
 */
export function evaluateSoftTriggers(triggerConfig, quotaSnapshot) {
  // No trigger config at all → soft triggers never fire
  if (!triggerConfig || typeof triggerConfig !== 'object') return false;

  // Per ADR 0004 § Consequences/Negative: null quotaStatus → don't fire
  if (quotaSnapshot == null) return false;

  // credit_pool_percent_threshold: fires when percentUsed >= threshold
  if (
    triggerConfig.credit_pool_percent_threshold !== undefined &&
    quotaSnapshot.percentUsed !== undefined &&
    quotaSnapshot.percentUsed !== null &&
    quotaSnapshot.percentUsed >= triggerConfig.credit_pool_percent_threshold
  ) {
    return true;
  }

  // daily_request_count_threshold: fires when dailyCount >= threshold
  if (
    triggerConfig.daily_request_count_threshold !== undefined &&
    quotaSnapshot.dailyCount !== undefined &&
    quotaSnapshot.dailyCount !== null &&
    quotaSnapshot.dailyCount >= triggerConfig.daily_request_count_threshold
  ) {
    return true;
  }

  // five_hour_window_percent_threshold: fires when fiveHourWindowPercent >= threshold
  if (
    triggerConfig.five_hour_window_percent_threshold !== undefined &&
    quotaSnapshot.fiveHourWindowPercent !== undefined &&
    quotaSnapshot.fiveHourWindowPercent !== null &&
    quotaSnapshot.fiveHourWindowPercent >= triggerConfig.five_hour_window_percent_threshold
  ) {
    return true;
  }

  return false;
}

// ── Fallback engine ────────────────────────────────────────────────────────

/**
 * @typedef {Object} ChainHop
 * @property {string} provider — provider name (e.g. 'anthropic')
 * @property {string} model — model string for this hop
 * @property {object} [softTriggers] — optional soft-trigger config for this hop
 * @property {object|null} [quotaSnapshot] — optional pre-fetched quota snapshot
 */

/**
 * @typedef {Object} FallbackResult
 * @property {Array<object>|null} chunks — IR chunk array on success; null if exhausted
 * @property {string} providerUsed — provider name that served the request (or first that failed)
 * @property {string} modelUsed — model string that served (or first that failed)
 * @property {number} fallbackHops — chain index of the serving hop (0=primary, 1=first fallback, etc.)
 * @property {Error|null} originalError — first-hop error if exhausted; null on success
 * @property {string[]} triedProviders — all providers tried, in chain order
 */

/**
 * Executes a provider chain with fallback semantics.
 *
 * Per ADR 0004 § Decision § Chain advancement (one-at-a-time):
 *   1. Try each hop in order.
 *   2. Before calling executeHopFn: evaluate soft triggers. If fired, skip this hop.
 *   3. On error: check for client error / AUTH_MISSING (stop immediately).
 *      Otherwise evaluate hard triggers. If hard-triggered, advance to next hop.
 *   4. If chain exhausted: return first-hop's originalError (not last).
 *
 * Per ADR 0004 § Decision § Fallback safety — first-chunk rule:
 *   At D9, executeHopFn is collectAllChunks() — fully buffered before return.
 *   An exception from executeHopFn means zero bytes were written to the client.
 *   First-chunk safety is trivially satisfied by the buffering pattern.
 *
 * @param {ChainHop[]} chain — ordered list of hops
 * @param {object} irRequest — IR request object (ADR 0003)
 * @param {function} executeHopFn — async (provider, model, ir) => IR chunk array; throws on failure
 * @param {object} [options]
 * @param {function} [options.logEvent] — optional structured logger (level, event, data)
 * @returns {Promise<FallbackResult>}
 */
export async function executeWithFallback(chain, irRequest, executeHopFn, options = {}) {
  const { logEvent = () => {} } = options;

  if (!Array.isArray(chain) || chain.length === 0) {
    throw new Error('executeWithFallback: chain must be a non-empty array');
  }

  const triedProviders = [];
  let originalError = null;  // Per ADR 0004: first-hop error is the canonical signal
  let firstErrorRecorded = false;

  for (let i = 0; i < chain.length; i++) {
    const hop = chain[i];
    const { provider, model, softTriggers = null, quotaSnapshot = null } = hop;

    // ── Soft-trigger check (BEFORE spawn) ──────────────────────────────
    // Per ADR 0004 § Decision: soft triggers evaluated before spawn;
    // if fired, advance without attempting this provider at all.
    //
    // Note on `triedProviders` semantics (D9 review-2 finding): we push the
    // provider name onto triedProviders even when soft-skipped (no spawn).
    // ADR 0004 § Observability headers describes X-OLP-Fallback-Exhausted as
    // "tried" providers; per ADR 0004 § Soft triggers a soft-fired hop is
    // counted as tried-and-skipped (the proxy advances to the next chain
    // entry without attempting the primary at all). The header therefore
    // includes soft-skipped hops. A future enhancement could split into
    // `triedProviders` + `softSkippedProviders` for finer-grained debug
    // visibility; D9 keeps them unified per ADR-0004 spec.
    if (evaluateSoftTriggers(softTriggers, quotaSnapshot)) {
      logEvent('info', 'fallback_soft_trigger', {
        hop: i,
        provider,
        model,
        reason: 'soft_trigger_fired',
      });
      triedProviders.push(provider);

      // Record a synthetic originalError for the first fired soft trigger.
      // `code: 'SOFT_TRIGGER'` is a fallback-engine-internal marker, NOT a
      // member of PROVIDER_ERROR_CODES (base.mjs) — those are provider
      // plugin error codes. Downstream consumers inspecting originalError.code
      // should treat 'SOFT_TRIGGER' as engine-synthetic. D9 review-2 noted
      // this; documented here so future readers do not try to add SOFT_TRIGGER
      // to the PROVIDER_ERROR_CODES closed enum.
      if (!firstErrorRecorded) {
        originalError = Object.assign(
          new Error(`Soft trigger fired for provider ${provider}: quota threshold exceeded`),
          { code: 'SOFT_TRIGGER', provider },
        );
        firstErrorRecorded = true;
      }
      continue;
    }

    // ── Execute hop ────────────────────────────────────────────────────
    triedProviders.push(provider);
    try {
      const chunks = await executeHopFn(provider, model, irRequest);

      // Per ADR 0004 § Fallback safety — first-chunk rule:
      //   executeHopFn returned successfully = chunks buffered = no client writes
      //   blocked = safe to return. Any retry attempt after this point would be
      //   post-first-chunk and is therefore forbidden. We return immediately.
      logEvent('info', 'fallback_hop_success', { hop: i, provider, model });
      return {
        chunks,
        providerUsed: provider,
        modelUsed: model,
        fallbackHops: i,
        originalError: null,
        triedProviders,
      };
    } catch (err) {
      // Record FIRST hop error as the canonical signal
      // Per ADR 0004 § Chain advancement step 4: return first error, not last.
      if (!firstErrorRecorded) {
        originalError = err;
        firstErrorRecorded = true;
      }

      logEvent('warn', 'fallback_hop_error', {
        hop: i,
        provider,
        model,
        error: err.message,
        code: err.code ?? null,
      });

      // ── Client error: stop immediately ─────────────────────────────
      // Per ADR 0004 § "No fallback for client-side errors"
      const status = err.statusCode ?? err.status ?? null;
      if (status !== null && CLIENT_ERROR_STATUSES.has(status)) {
        logEvent('warn', 'fallback_client_error_no_fallback', { hop: i, provider, status });
        return {
          chunks: null,
          providerUsed: provider,
          modelUsed: model,
          fallbackHops: i,
          originalError: err,
          triedProviders,
        };
      }

      // ── AUTH_MISSING: stop immediately ─────────────────────────────
      // Per ADR 0004 § Decision: AUTH_MISSING = HARD_TRIGGER_CODES[AUTH_MISSING]=false.
      // Silently masking it by trying next provider prevents user from discovering
      // the misconfiguration.
      if (err instanceof ProviderError && err.code === 'AUTH_MISSING') {
        logEvent('warn', 'fallback_auth_missing_no_fallback', { hop: i, provider });
        return {
          chunks: null,
          providerUsed: provider,
          modelUsed: model,
          fallbackHops: i,
          originalError: err,
          triedProviders,
        };
      }

      // ── Hard-trigger check: advance chain ──────────────────────────
      // Per ADR 0004 § Decision § Fallback safety — first-chunk rule:
      //   At D9, executeHopFn threw, so zero chunks were emitted.
      //   Fallback is eligible if the error is a hard trigger.
      if (evaluateHardTriggers(err)) {
        logEvent('info', 'fallback_hard_trigger', {
          hop: i,
          provider,
          model,
          error: err.message,
          code: err.code ?? null,
          advance_to_hop: i + 1,
        });
        continue;  // advance to next hop
      }

      // ── Non-trigger error: surface immediately ──────────────────────
      // Per ADR 0004 § Alternatives considered (a): "any error" fallback rejected.
      logEvent('warn', 'fallback_non_trigger_error', {
        hop: i,
        provider,
        error: err.message,
        code: err.code ?? null,
      });
      return {
        chunks: null,
        providerUsed: provider,
        modelUsed: model,
        fallbackHops: i,
        originalError: err,
        triedProviders,
      };
    }
  }

  // Chain exhausted
  // Per ADR 0004 § Decision § Chain advancement step 4:
  //   "return A's original error (not B's, not C's)"
  logEvent('error', 'fallback_chain_exhausted', {
    chain: chain.map(h => h.provider),
    triedProviders,
  });

  return {
    chunks: null,
    providerUsed: chain[0].provider,
    modelUsed: chain[0].model,
    fallbackHops: chain.length,
    originalError,
    triedProviders,
  };
}

// ── Chain builder ──────────────────────────────────────────────────────────

/**
 * Builds the execution chain for a given model string from config.
 *
 * Per D9 implementation notes:
 *   - If fallbackChainConfig has an explicit entry for this model, use it.
 *   - Otherwise, use a single-hop chain with the first matched provider (no fallback).
 *   - v0.1 ships with empty chain config; fallback activates only when the user
 *     populates ~/.olp/config.json's routing.chains.
 *
 * @param {string} modelString — user-requested model string
 * @param {Map<string, object>} loadedProviders — name → provider plugin
 * @param {object} [fallbackChainConfig] — routing.chains from config.json
 * @param {object} [softTriggerConfig] — routing.soft_triggers from config.json
 * @returns {ChainHop[]|null} — ordered chain, or null if no provider found for model
 */
export function buildDefaultChain(
  modelString,
  loadedProviders,
  fallbackChainConfig = {},
  softTriggerConfig = {},
) {
  // Check for explicit chain in config for this model
  const explicitChain = fallbackChainConfig[modelString];
  if (explicitChain && Array.isArray(explicitChain) && explicitChain.length > 0) {
    return explicitChain.map(hop => ({
      provider: hop.provider,
      model: hop.model ?? modelString,
      softTriggers: softTriggerConfig[hop.provider] ?? null,
      // quotaSnapshot stays null at v0.1 — soft triggers deferred to v1.x per
      // ADR 0004 Amendment 2. evaluateSoftTriggers correctly short-circuits to
      // false when quotaSnapshot is null. The polling path is not wired in v0.1.
      quotaSnapshot: null,
    }));
  }

  // No explicit chain: use getProviderForModel (SPOT for alias-aware routing).
  // D17 Finding 13 fix: replaced the duplicated inline scan loop with this
  // single call so alias resolution and provider lookup live in one place.
  // result.canonicalModel carries the canonical ID even when user passed an
  // alias. The canonical ID flows into: cache key (computeCacheKey arg),
  // X-OLP-Model-Used header, and structured log events — so identical requests
  // differing only in alias-vs-canonical now hit the same cache entry.
  // provider.spawn continues to receive irRequest.model (the user's original
  // input); each provider CLI accepts its own aliases natively per its docs,
  // so no in-IR rewrite is needed for spawn correctness.
  const match = getProviderForModel(loadedProviders, modelString);
  if (match) {
    return [{
      provider: match.name,
      model: match.canonicalModel,
      softTriggers: softTriggerConfig[match.name] ?? null,
      // quotaSnapshot stays null at v0.1 — soft triggers deferred to v1.x per
      // ADR 0004 Amendment 2. evaluateSoftTriggers correctly short-circuits to
      // false when quotaSnapshot is null. The polling path is not wired in v0.1.
      quotaSnapshot: null,
    }];
  }

  // No provider found for this model
  return null;
}

// ── Config loader ──────────────────────────────────────────────────────────

/**
 * Default path for the OLP config file.
 * @returns {string}
 */
function defaultConfigPath() {
  return join(homedir(), '.olp', 'config.json');
}

/**
 * Loads the full OLP config from ~/.olp/config.json (or the given path).
 *
 * Per D9 implementation notes:
 *   v0.1 ships with no config file. Fallback engine is wired but single-hop
 *   until the user populates routing.chains.
 *
 * Per ADR 0002 § Disable model: providers.enabled is the toggle that transitions
 *   a Candidate provider to Enabled. Missing entries default to false (disabled).
 *
 * Returns empty config (no chains, no soft triggers, no enabled providers) if the
 * file is absent, unreadable, or malformed.
 *
 * @param {string} [configPath] — override path (for testing — do NOT write to ~/.olp/config.json in tests)
 * @returns {{ chains: object, soft_triggers: object, providersEnabled: Record<string, boolean> }}
 */
export function loadFallbackConfigSync(configPath) {
  try {
    const path = configPath ?? defaultConfigPath();
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    const routing = parsed?.routing ?? {};
    const providers = parsed?.providers ?? {};
    return {
      chains: routing.chains ?? {},
      soft_triggers: routing.soft_triggers ?? {},
      providersEnabled: providers.enabled ?? {},
    };
  } catch {
    // File absent, unreadable, or malformed → no fallback config (single-hop mode)
    // Empty providersEnabled → all providers disabled → 503 per ALIGNMENT.md v0.1 posture.
    return { chains: {}, soft_triggers: {}, providersEnabled: {} };
  }
}

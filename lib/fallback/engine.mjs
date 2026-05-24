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

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ProviderError } from '../providers/base.mjs';
import { getProviderForModel } from '../providers/index.mjs';
import { computeIRRequestHash } from '../cache/keys.mjs';

// ── Hard-trigger evaluation ────────────────────────────────────────────────

/**
 * Maps ProviderError codes to hard-trigger decisions.
 *
 * v0.1 live codes (per ADR 0004 Amendment 3 (D34 F7) + Amendment 4 (D38)):
 *   - SPAWN_FAILED       → hard trigger (provider CLI failed)
 *   - CLI_NOT_FOUND      → hard trigger (binary missing)
 *   - AUTH_MISSING       → NOT a hard trigger (user-config failure; user must fix)
 *   - SPAWN_TIMEOUT      → hard trigger (per ADR 0004 § Trigger taxonomy bullet 4)
 *   - CONCURRENCY_LIMIT  → hard trigger (D38 / issue #1, ADR 0004 Amendment 4):
 *                          synthesized by server.mjs when a provider is at its
 *                          hints.maxConcurrent in-flight limit. The chain
 *                          advances immediately to the next hop instead of
 *                          queueing — design rationale per ADR 0004 Amendment 4.
 *
 * QUOTA_EXHAUSTED and RATE_LIMITED removed (D34 F7 / ADR 0004 Amendment 3):
 *   no v0.1 plugin parses underlying-API HTTP status codes, so these codes
 *   are never emitted at v0.1. Re-add via ADR 0004 amendment when a plugin
 *   gains HTTP-status parsing capability.
 * OUTPUT_PARSE_ERROR removed earlier (D32 F4): no plugin emits it; dead code.
 *
 * @type {Record<string, boolean>}
 */
const HARD_TRIGGER_CODES = {
  SPAWN_FAILED: true,
  CLI_NOT_FOUND: true,
  AUTH_MISSING: false,      // user config problem — never fall over (ADR 0004 § Decision)
  SPAWN_TIMEOUT: true,      // ADR 0004 § Trigger taxonomy bullet 4: spawn timeout is a hard trigger
  CONCURRENCY_LIMIT: true,  // ADR 0004 Amendment 4 (D38, issue #1): saturation → advance chain
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
 * Classifies a thrown error into one of the trigger taxonomy categories
 * per ADR 0004 § Trigger taxonomy (D28 round-3 F2). Used in log events
 * so operators can pivot on the classification bucket.
 *
 * Note: 'soft' is not currently returnable from this function. Soft triggers
 * are evaluated before spawn via evaluateSoftTriggers() and are deferred to
 * v1.x (D22 Amendment 2). The 'soft' variant is listed in the JSDoc return
 * type for forward-compatibility only.
 *
 * @param {Error|null|undefined} error
 * @returns {'hard' | 'soft' | 'auth_missing' | 'client_error' | 'non_trigger' | null}
 */
function classifyTrigger(error) {
  if (!error) return null;
  if (error instanceof ProviderError && error.code) {
    if (error.code === 'AUTH_MISSING') return 'auth_missing';
    if (HARD_TRIGGER_CODES[error.code] === true) return 'hard';
    return 'non_trigger';
  }
  const status = error.statusCode ?? error.status ?? null;
  if (status !== null && typeof status === 'number') {
    if (CLIENT_ERROR_STATUSES.has(status)) return 'client_error';
    if (status >= 500) return 'hard';
    if (status >= 400) return 'hard';  // quota-exhaustion 4xx (e.g. 429, 529)
  }
  return 'non_trigger';
}

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
  // NOTE (ADR 0004 Amendment 3, D34 F7): these HTTP-status branches are
  // forward-compat reserved code. v0.1 plugins never attach statusCode to
  // thrown errors — they throw ProviderError with codes (SPAWN_FAILED,
  // SPAWN_TIMEOUT, CLI_NOT_FOUND, AUTH_MISSING) and never surface underlying-API
  // HTTP status. When a future plugin gains HTTP-status parsing, it will attach
  // statusCode to the thrown error and these branches will activate. Until then,
  // this path is unreachable in production. Left in place as intent signal.
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
 * @typedef {Object} FallbackDetailTuple — per-hop failure detail tuple emitted in X-OLP-Fallback-Detail.
 * D40 (issue #7) — Option A (ungated v0.1). Shapes reuse D28 log event fields so future readers
 * can grep both surfaces consistently.
 * @property {number} hop — 0-indexed hop number
 * @property {string} provider — provider name at this hop
 * @property {string} model — model string at this hop (from chain hop, which carries IR model)
 * @property {string} code — ProviderError code, or 'UNKNOWN' for non-ProviderError exceptions
 * @property {string} error_message — error message, truncated to 200 chars
 * @property {string} trigger_type — classifyTrigger() output: 'hard' | 'auth_missing' | 'client_error' | 'non_trigger' | 'soft' for engine-synthesized soft skips
 */

/**
 * @typedef {Object} FallbackResult
 * @property {Array<object>|null} chunks — IR chunk array on success; null if exhausted
 * @property {string} providerUsed — provider name that served the request (or first that failed)
 * @property {string} modelUsed — model string that served (or first that failed)
 * @property {number} fallbackHops — chain index of the serving hop (0=primary, 1=first fallback, etc.)
 * @property {Error|null} originalError — first-hop error if exhausted; null on success
 * @property {string[]} triedProviders — all providers tried, in chain order
 * @property {FallbackDetailTuple[]} fallbackDetail — per-hop failure tuples (D40, issue #7).
 *   On success, contains the failing hops before the serving hop (may be empty).
 *   On exhausted/non-trigger/client-error/auth-missing return paths, contains every failed hop.
 *   Server.mjs emits X-OLP-Fallback-Detail when this array is non-empty.
 */

/**
 * Truncates an error message to at most 200 characters. If truncation occurs,
 * the result ends with a single-character ellipsis (U+2026 '…') to signal
 * the cut. Used to keep X-OLP-Fallback-Detail tuples readable in dashboards.
 *
 * D40 (issue #7) — see ADR 0004 § Observability headers.
 *
 * @param {unknown} message
 * @returns {string}
 */
function truncateErrorMessage(message) {
  const s = typeof message === 'string' ? message : String(message ?? '');
  if (s.length <= 200) return s;
  return s.slice(0, 199) + '…';
}

/**
 * Builds the per-hop failure tuple emitted in X-OLP-Fallback-Detail.
 * Field shapes reuse D28's structured log event values so the header and
 * the log line are pivotable on the same keys.
 *
 * D40 (issue #7) — see ADR 0004 § Observability headers.
 *
 * @param {number} hop
 * @param {string} provider
 * @param {string} model
 * @param {Error} err
 * @param {'hard'|'soft'|'auth_missing'|'client_error'|'non_trigger'|null} triggerType
 * @returns {FallbackDetailTuple}
 */
function makeFallbackDetailTuple(hop, provider, model, err, triggerType) {
  let code;
  if (err instanceof ProviderError && err.code) {
    code = err.code;
  } else if (typeof err?.code === 'string') {
    // Carries err.code from soft-trigger synthesized errors (code: 'SOFT_TRIGGER')
    // or any custom error class that uses string codes. Non-string err.code
    // falls through to 'UNKNOWN' so a numeric Node errno (e.g. ECONNREFUSED's
    // numeric system errno) does not get mis-typed.
    code = err.code;
  } else {
    code = 'UNKNOWN';
  }
  return {
    hop,
    provider,
    model,
    code,
    error_message: truncateErrorMessage(err?.message),
    trigger_type: triggerType ?? 'non_trigger',
  };
}

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

  // D28 round-3 F2: per-request fingerprints for log correlation.
  // chain_id is unique per executeWithFallback invocation; ir_request_hash
  // is provider-agnostic so it groups all hops from the same logical request.
  const chainId = randomBytes(8).toString('hex');  // 16-char hex
  const irRequestHash = computeIRRequestHash(irRequest);

  const triedProviders = [];
  let originalError = null;  // Per ADR 0004: first-hop error is the canonical signal
  let firstErrorRecorded = false;

  // D40 (issue #7) — per-hop failure tuples for X-OLP-Fallback-Detail.
  // Reuses D28 log event field shapes; emitted by server.mjs on any response
  // where this array is non-empty. ADR 0004 § Observability headers.
  /** @type {FallbackDetailTuple[]} */
  const fallbackDetail = [];

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
        chain_id: chainId,
        hop: i,
        provider,
        model,
        trigger_type: 'soft',
        ir_request_hash: irRequestHash,
        next_provider: chain[i + 1]?.provider ?? null,
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
      const softErr = Object.assign(
        new Error(`Soft trigger fired for provider ${provider}: quota threshold exceeded`),
        { code: 'SOFT_TRIGGER', provider },
      );
      if (!firstErrorRecorded) {
        originalError = softErr;
        firstErrorRecorded = true;
      }
      // D40: record soft-skipped hop in fallbackDetail. trigger_type='soft' lets
      // downstream readers distinguish a skipped hop from a spawned-and-failed one.
      fallbackDetail.push(makeFallbackDetailTuple(i, provider, model, softErr, 'soft'));
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
      logEvent('info', 'fallback_hop_success', {
        chain_id: chainId,
        hop: i,
        provider,
        model,
        trigger_type: null,
        ir_request_hash: irRequestHash,
        next_provider: null,
      });
      return {
        chunks,
        providerUsed: provider,
        modelUsed: model,
        fallbackHops: i,
        originalError: null,
        triedProviders,
        fallbackDetail,  // D40: failing hops that came BEFORE this success
      };
    } catch (err) {
      // Record FIRST hop error as the canonical signal
      // Per ADR 0004 § Chain advancement step 4: return first error, not last.
      if (!firstErrorRecorded) {
        originalError = err;
        firstErrorRecorded = true;
      }

      // D40 (issue #7): classify once and record the per-hop tuple. The same
      // trigger_type value flows into the log event below (consistency between
      // logs and X-OLP-Fallback-Detail).
      const errTriggerType = classifyTrigger(err);
      fallbackDetail.push(makeFallbackDetailTuple(i, provider, model, err, errTriggerType));

      logEvent('warn', 'fallback_hop_error', {
        chain_id: chainId,
        hop: i,
        provider,
        model,
        error: err.message,
        code: err.code ?? null,
        trigger_type: errTriggerType,
        ir_request_hash: irRequestHash,
        next_provider: chain[i + 1]?.provider ?? null,
      });

      // ── Client error: stop immediately ─────────────────────────────
      // Per ADR 0004 § "No fallback for client-side errors"
      const status = err.statusCode ?? err.status ?? null;
      if (status !== null && CLIENT_ERROR_STATUSES.has(status)) {
        logEvent('warn', 'fallback_client_error_no_fallback', {
          chain_id: chainId,
          hop: i,
          provider,
          status,
          trigger_type: 'client_error',
          ir_request_hash: irRequestHash,
          next_provider: null,
        });
        return {
          chunks: null,
          providerUsed: provider,
          modelUsed: model,
          fallbackHops: i,
          originalError: err,
          triedProviders,
          fallbackDetail,  // D40
        };
      }

      // ── AUTH_MISSING: stop immediately ─────────────────────────────
      // Per ADR 0004 § Decision: AUTH_MISSING = HARD_TRIGGER_CODES[AUTH_MISSING]=false.
      // Silently masking it by trying next provider prevents user from discovering
      // the misconfiguration.
      if (err instanceof ProviderError && err.code === 'AUTH_MISSING') {
        logEvent('warn', 'fallback_auth_missing_no_fallback', {
          chain_id: chainId,
          hop: i,
          provider,
          trigger_type: 'auth_missing',
          ir_request_hash: irRequestHash,
          next_provider: null,
        });
        return {
          chunks: null,
          providerUsed: provider,
          modelUsed: model,
          fallbackHops: i,
          originalError: err,
          triedProviders,
          fallbackDetail,  // D40
        };
      }

      // ── Hard-trigger check: advance chain ──────────────────────────
      // Per ADR 0004 § Decision § Fallback safety — first-chunk rule:
      //   At D9, executeHopFn threw, so zero chunks were emitted.
      //   Fallback is eligible if the error is a hard trigger.
      if (evaluateHardTriggers(err)) {
        logEvent('info', 'fallback_hard_trigger', {
          chain_id: chainId,
          hop: i,
          provider,
          model,
          error: err.message,
          code: err.code ?? null,
          advance_to_hop: i + 1,
          trigger_type: errTriggerType,
          ir_request_hash: irRequestHash,
          next_provider: chain[i + 1]?.provider ?? null,
        });
        continue;  // advance to next hop
      }

      // ── Non-trigger error: surface immediately ──────────────────────
      // Per ADR 0004 § Alternatives considered (a): "any error" fallback rejected.
      logEvent('warn', 'fallback_non_trigger_error', {
        chain_id: chainId,
        hop: i,
        provider,
        error: err.message,
        code: err.code ?? null,
        trigger_type: errTriggerType,
        ir_request_hash: irRequestHash,
        next_provider: null,
      });
      return {
        chunks: null,
        providerUsed: provider,
        modelUsed: model,
        fallbackHops: i,
        originalError: err,
        triedProviders,
        fallbackDetail,  // D40
      };
    }
  }

  // Chain exhausted
  // Per ADR 0004 § Decision § Chain advancement step 4:
  //   "return A's original error (not B's, not C's)"
  logEvent('error', 'fallback_chain_exhausted', {
    chain_id: chainId,
    chain: chain.map(h => h.provider),
    triedProviders,
    trigger_type: null,
    ir_request_hash: irRequestHash,
    next_provider: null,
  });

  // D41 (issue #8): providerUsed on chain-exhausted reflects **chain origin**
  // (the configured primary), not necessarily the first hop where spawn() was
  // actually called. At v0.1 the two are equivalent because soft triggers are
  // deferred (ADR 0004 Amendment 2) — every hop in the chain is attempted in
  // order. When soft triggers are reactivated in v1.x, the semantic ambiguity
  // surfaces: a soft-skipped hop 0 followed by hard-failed hops 1+N would
  // report providerUsed=chain[0] even though hop 0 was never spawned. The v0.1
  // contract is chain-origin (option b); v1.x may switch to first-attempted-
  // hop (option a) as part of the soft-trigger reactivation work. See ADR 0004
  // Amendment 6 for the documented semantics.
  return {
    chunks: null,
    providerUsed: chain[0].provider,
    modelUsed: chain[0].model,
    fallbackHops: chain.length,
    originalError,
    triedProviders,
    fallbackDetail,  // D40 (issue #7): per-hop failure tuples; every attempted hop on exhaustion
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

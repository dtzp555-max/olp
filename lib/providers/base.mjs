/**
 * lib/providers/base.mjs — Provider contract definition and shared helpers
 *
 * Authority: ADR 0002 § "Provider contract (v1.0 interface)"
 *
 * This module does NOT implement the Provider contract itself.
 * Provider plugins compose the helpers exported here; they do not inherit
 * from a base class (per ADR 0002 § Consequences/Mitigations: "compose helpers,
 * do not inherit").
 */

// ── Contract typedef ──────────────────────────────────────────────────────

/**
 * @typedef {Object} ProviderAuth
 * @property {string} type       - e.g. 'subscription', 'api-key', 'oauth'
 * @property {string} storage    - e.g. 'cli-managed', 'env', 'keychain'
 * @property {string} path       - artifact location hint
 * @property {string|null} refresh - refresh mechanism or null if not applicable
 */

/**
 * @typedef {Object} ProviderHints
 * @property {boolean} requiresTTY
 * @property {boolean} concurrentSpawnSafe
 * @property {number} maxConcurrent
 */

/**
 * @typedef {Object} ProviderContractV1
 * @property {string} name               - unique lowercase key
 * @property {string} displayName        - human-readable name
 * @property {string[]} models           - model strings this provider serves
 * @property {ProviderAuth} auth
 * @property {function} spawn            - async (irRequest, authContext) => AsyncIterator<IRResponseChunk>
 * @property {function} estimateCost     - (request) => {inputTokens, outputTokensEstimate, currency, usd}|null
 * @property {function} quotaStatus      - async (authContext) => {available, percentUsed, resetsAt, pool}|null
 * @property {function} healthCheck      - async () => {ok: boolean, latencyMs: number, error?: string}
 * @property {ProviderHints} hints
 */

// ── Contract validator ────────────────────────────────────────────────────

/**
 * Validates that a plugin object satisfies the v1.0 Provider contract.
 * Per ADR 0002 § "Loading model", the registry calls this at startup for
 * every registered provider; an invalid provider throws rather than silently
 * degrading.
 *
 * @param {*} p
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateProvider(p) {
  const errors = [];

  if (!p || typeof p !== 'object') {
    errors.push('provider must be an object');
    return { valid: false, errors };
  }

  if (typeof p.name !== 'string' || p.name.trim() === '') {
    errors.push('name must be a non-empty string');
  } else if (!/^[a-z][a-z0-9_-]*$/.test(p.name)) {
    errors.push('name must be lowercase alphanumeric (with _ or -) starting with a letter');
  }

  if (typeof p.displayName !== 'string' || p.displayName.trim() === '') {
    errors.push('displayName must be a non-empty string');
  }

  if (!Array.isArray(p.models)) {
    errors.push('models must be an array of strings');
  } else if (p.models.some(m => typeof m !== 'string')) {
    errors.push('every entry in models must be a string');
  }

  if (!p.auth || typeof p.auth !== 'object') {
    errors.push('auth must be an object with { type, storage, path, refresh }');
  } else {
    if (typeof p.auth.type !== 'string') errors.push('auth.type must be a string');
    if (typeof p.auth.storage !== 'string') errors.push('auth.storage must be a string');
    if (typeof p.auth.path !== 'string') errors.push('auth.path must be a string');
    if (p.auth.refresh !== null && typeof p.auth.refresh !== 'string') {
      errors.push('auth.refresh must be a string or null');
    }
  }

  if (typeof p.spawn !== 'function') {
    errors.push('spawn must be a function');
  }

  if (typeof p.estimateCost !== 'function') {
    errors.push('estimateCost must be a function');
  }

  if (typeof p.quotaStatus !== 'function') {
    errors.push('quotaStatus must be a function');
  }

  if (typeof p.healthCheck !== 'function') {
    errors.push('healthCheck must be a function');
  }

  if (!p.hints || typeof p.hints !== 'object') {
    errors.push('hints must be an object with { requiresTTY, concurrentSpawnSafe, maxConcurrent }');
  } else {
    if (typeof p.hints.requiresTTY !== 'boolean') errors.push('hints.requiresTTY must be a boolean');
    if (typeof p.hints.concurrentSpawnSafe !== 'boolean') errors.push('hints.concurrentSpawnSafe must be a boolean');
    if (typeof p.hints.maxConcurrent !== 'number' || !Number.isInteger(p.hints.maxConcurrent) || p.hints.maxConcurrent < 0) {
      errors.push('hints.maxConcurrent must be a non-negative integer');
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Error class ───────────────────────────────────────────────────────────

/** Error codes surfaced by provider plugins */
export const PROVIDER_ERROR_CODES = /** @type {const} */ ([
  'AUTH_MISSING',
  'QUOTA_EXHAUSTED',
  'RATE_LIMITED',
  'CLI_NOT_FOUND',
  'SPAWN_FAILED',
  'OUTPUT_PARSE_ERROR',
]);

export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {typeof PROVIDER_ERROR_CODES[number]} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────

/**
 * Wraps a promise with a timeout. Rejects with a ProviderError if the promise
 * does not settle within `ms` milliseconds.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {typeof PROVIDER_ERROR_CODES[number]} errorCode
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, errorCode) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ProviderError(`Operation timed out after ${ms}ms`, errorCode));
    }, ms);
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Merges two AsyncIterators into a single ordered stream.
 * Items from whichever source yields first are emitted first.
 * Useful when a provider plugin wants to interleave two internal streams.
 *
 * Not used at D3 (no providers yet) but provided as infrastructure so
 * provider authors don't each implement their own fan-in.
 *
 * @template T
 * @param {AsyncIterator<T>} iter1
 * @param {AsyncIterator<T>} iter2
 * @returns {AsyncGenerator<T>}
 */
export async function* mergeStreams(iter1, iter2) {
  // Convert each iterator to a pull-based promise queue
  const done1 = { done: true };
  const done2 = { done: true };

  let p1 = iter1.next();
  let p2 = iter2.next();

  while (true) {
    const winner = await Promise.race([
      p1.then(r => ({ r, which: 1 })),
      p2.then(r => ({ r, which: 2 })),
    ]);

    if (winner.which === 1) {
      if (winner.r.done) {
        // iter1 exhausted — drain iter2
        for await (const v of { [Symbol.asyncIterator]: () => iter2 }) yield v;
        return;
      }
      yield winner.r.value;
      p1 = iter1.next();
    } else {
      if (winner.r.done) {
        // iter2 exhausted — drain iter1
        for await (const v of { [Symbol.asyncIterator]: () => iter1 }) yield v;
        return;
      }
      yield winner.r.value;
      p2 = iter2.next();
    }
  }
}

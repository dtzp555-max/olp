/**
 * lib/cache/store.mjs — In-process cache store with per-key isolation + singleflight
 *
 * Authority: ADR 0005 § D1 (per-key isolation) + D4 (singleflight)
 *
 * This module implements the OLP response cache. At D5 the backing store is
 * an in-memory Map (not file-backed). File backing lands in a later Phase.
 * The architecture mirrors OCP v3.13.0 (D1+D4) generalized to OLP's
 * (provider, model) keyed cache key space.
 *
 * D1 — Per-key isolation:
 *   Outer Map: keyId → inner Map
 *   Inner Map: cacheKey (SHA-256 hex) → CacheEntry
 *
 *   keyId is the OLP API key identifier (Phase 2 multi-key). At D5, the server
 *   passes '__anonymous__' as keyId for all requests.
 *
 * D4 — Singleflight:
 *   Concurrent requests with the same (keyId, cacheKey) share one compute
 *   invocation. The first caller triggers computeFn(); subsequent callers
 *   await the same Promise. After completion, all callers receive the same
 *   value, and the result is cached for future callers.
 *
 * D2/D3 are placeholders at D5:
 *   D2 (cache_control bypass) — checked in server.mjs before entering getOrCompute.
 *   D3 (chunked stream replay with timing fidelity) — at D5 the cache stores
 *       full collected chunks and replays them sequentially without timing.
 *       Full D3 (timing-accurate replay) lands in a later Phase.
 *
 * Per OCP learning (MEMORY.md learnings/concurrency_dedup_test_signals.md):
 *   Singleflight is verified by observing that N concurrent requests for the
 *   same key return within ~0ms of each other (not by counting spawn log lines).
 *   The content-hash for the cache key must NOT include randomUUID or any
 *   per-request random component — only the semantic content that affects output.
 */

// ── Types ─────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CacheEntry
 * @property {*} value - the cached response (IR chunk array for streaming, response object for non-streaming)
 * @property {number} createdAt - epoch ms (Date.now()) when the entry was created
 * @property {number} ttlMs - time-to-live in milliseconds
 */

/**
 * @typedef {Object} CacheStats
 * @property {number} hits
 * @property {number} misses
 * @property {number} size
 * @property {number} inflightCount
 */

// ── CacheStore ────────────────────────────────────────────────────────────

export class CacheStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxEntriesPerKey=1000]   — evict oldest entries when exceeded
   * @param {number} [opts.maxAgeMs=86400000]        — default TTL: 24 hours
   * @param {() => number} [opts._nowFn=Date.now]   — injectable for TTL testing
   */
  constructor(opts = {}) {
    this._maxEntriesPerKey = opts.maxEntriesPerKey ?? 1000;
    this._maxAgeMs = opts.maxAgeMs ?? 24 * 60 * 60 * 1000; // 24 hours
    this._nowFn = opts._nowFn ?? (() => Date.now());

    // D1 per-key isolation: keyId → Map<cacheKey, CacheEntry>
    /** @type {Map<string, Map<string, CacheEntry>>} */
    this._store = new Map();

    // D4 singleflight: `${keyId}:${cacheKey}` → Promise<value>
    /** @type {Map<string, Promise<*>>} */
    this._inflight = new Map();

    // Stats per keyId
    /** @type {Map<string, { hits: number, misses: number }>} */
    this._stats = new Map();
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  /**
   * Returns or creates the inner Map for a given keyId.
   * @param {string} keyId
   * @returns {Map<string, CacheEntry>}
   */
  _getNamespace(keyId) {
    if (!this._store.has(keyId)) {
      this._store.set(keyId, new Map());
    }
    return this._store.get(keyId);
  }

  /**
   * Returns or creates the stats object for a given keyId.
   * @param {string} keyId
   * @returns {{ hits: number, misses: number }}
   */
  _getStats(keyId) {
    if (!this._stats.has(keyId)) {
      this._stats.set(keyId, { hits: 0, misses: 0 });
    }
    return this._stats.get(keyId);
  }

  /**
   * Returns true if entry has not yet expired.
   * @param {CacheEntry} entry
   * @returns {boolean}
   */
  _isAlive(entry) {
    const age = this._nowFn() - entry.createdAt;
    return age < entry.ttlMs;
  }

  /**
   * Evicts oldest entries in a namespace when it exceeds maxEntriesPerKey.
   * @param {Map<string, CacheEntry>} ns
   */
  _evictIfNeeded(ns) {
    if (ns.size <= this._maxEntriesPerKey) return;

    // Collect entries sorted by createdAt ascending (oldest first)
    const entries = [...ns.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    const toEvict = ns.size - this._maxEntriesPerKey;
    for (let i = 0; i < toEvict; i++) {
      ns.delete(entries[i][0]);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Retrieves a cached entry. Returns null on miss or TTL expiry.
   * Updates stats.
   *
   * @param {string} keyId - OLP API key namespace (use '__anonymous__' at D5)
   * @param {string} cacheKey - SHA-256 hex from computeCacheKey()
   * @returns {Promise<CacheEntry|null>}
   */
  async get(keyId, cacheKey) {
    const ns = this._getNamespace(keyId);
    const entry = ns.get(cacheKey);

    if (!entry) {
      this._getStats(keyId).misses++;
      return null;
    }

    if (!this._isAlive(entry)) {
      ns.delete(cacheKey);
      this._getStats(keyId).misses++;
      return null;
    }

    this._getStats(keyId).hits++;
    return entry;
  }

  /**
   * Stores a value in the cache.
   *
   * @param {string} keyId
   * @param {string} cacheKey
   * @param {*} value
   * @param {number} [ttlMs] - overrides default maxAgeMs
   * @returns {Promise<void>}
   */
  async set(keyId, cacheKey, value, ttlMs) {
    const ns = this._getNamespace(keyId);
    const entry = {
      value,
      createdAt: this._nowFn(),
      ttlMs: ttlMs ?? this._maxAgeMs,
    };
    ns.set(cacheKey, entry);
    this._evictIfNeeded(ns);
  }

  /**
   * Returns true if a valid (non-expired) entry exists for (keyId, cacheKey).
   *
   * Stats side-effect: this method calls get(), which increments hit/miss
   * counters. Callers that need to peek WITHOUT touching stats should use
   * peek() instead. Server-side cache-status reporting MUST use peek() to
   * avoid double-counting when getOrCompute() is called immediately after.
   *
   * @param {string} keyId
   * @param {string} cacheKey
   * @returns {Promise<boolean>}
   */
  async has(keyId, cacheKey) {
    const entry = await this.get(keyId, cacheKey);
    return entry !== null;
  }

  /**
   * Stats-neutral cache peek. Returns true if a valid entry exists without
   * incrementing hit/miss counters. Use this from server.mjs for pre-check
   * cache-status reporting; the subsequent getOrCompute() call is the one
   * that increments the canonical stats counter at the semantic boundary.
   *
   * Fixes the codex-flagged double-count bug where has() + getOrCompute()
   * both incremented the same counter on the same logical request.
   *
   * @param {string} keyId
   * @param {string} cacheKey
   * @returns {Promise<boolean>}
   */
  async peek(keyId, cacheKey) {
    const ns = this._getNamespace(keyId);
    const entry = ns.get(cacheKey);
    if (!entry) return false;
    if (!this._isAlive(entry)) {
      ns.delete(cacheKey);
      return false;
    }
    return true;
  }

  /**
   * D4 singleflight: get from cache or compute exactly once for concurrent callers.
   *
   * - Cache hit: return cached value immediately (no computeFn invocation).
   * - Inflight hit: await the existing inflight Promise (singleflight — computeFn
   *   runs exactly once for N concurrent callers with the same key).
   * - Miss: register inflight promise, invoke computeFn(), cache the result,
   *   release the inflight promise, return the value.
   * - On computeFn error: release the inflight promise (so subsequent calls retry),
   *   rethrow the error to all awaiting callers.
   *
   * Per OCP MEMORY.md learning (concurrency_dedup_test_signals.md):
   *   Singleflight is verified by timing: N concurrent calls return within ~ms
   *   of each other, and computeFn is called exactly once.
   *
   * @param {string} keyId
   * @param {string} cacheKey
   * @param {() => Promise<*>} computeFn - async function producing the value
   * @param {number} [ttlMs]
   * @returns {Promise<*>}
   */
  async getOrCompute(keyId, cacheKey, computeFn, ttlMs) {
    // 1. Cache hit — return immediately, no singleflight overhead
    const ns = this._getNamespace(keyId);
    const existing = ns.get(cacheKey);
    if (existing && this._isAlive(existing)) {
      this._getStats(keyId).hits++;
      return existing.value;
    }

    // 2. Inflight hit — singleflight: await the in-progress compute
    const inflightKey = `${keyId}:${cacheKey}`;
    const inFlight = this._inflight.get(inflightKey);
    if (inFlight) {
      // Another caller is already computing this key. Await their result.
      // The first caller will cache the result; we return the same value.
      return inFlight;
    }

    // 3. Miss — we are the first caller; register inflight promise
    const computePromise = (async () => {
      try {
        const value = await computeFn();
        // Cache the result so future calls are cache hits
        await this.set(keyId, cacheKey, value, ttlMs);
        this._getStats(keyId).misses++;
        return value;
      } finally {
        // Always release the inflight slot, even on error
        this._inflight.delete(inflightKey);
      }
    })();

    this._inflight.set(inflightKey, computePromise);

    return computePromise;
  }

  /**
   * Returns stats for a specific keyId, or aggregate stats across all keyIds.
   *
   * @param {string} [keyId] - if omitted, returns aggregate across all keys
   * @returns {CacheStats}
   */
  stats(keyId) {
    if (keyId !== undefined) {
      const s = this._stats.get(keyId) ?? { hits: 0, misses: 0 };
      const ns = this._store.get(keyId);
      const size = ns ? ns.size : 0;
      return {
        hits: s.hits,
        misses: s.misses,
        size,
        inflightCount: this._inflight.size,
      };
    }

    // Aggregate
    let totalHits = 0;
    let totalMisses = 0;
    let totalSize = 0;
    for (const s of this._stats.values()) {
      totalHits += s.hits;
      totalMisses += s.misses;
    }
    for (const ns of this._store.values()) {
      totalSize += ns.size;
    }
    return {
      hits: totalHits,
      misses: totalMisses,
      size: totalSize,
      inflightCount: this._inflight.size,
    };
  }

  /**
   * Clears cache entries (and stats) for a specific keyId, or ALL entries.
   *
   * @param {string} [keyId] - if omitted, clears all namespaces
   */
  clear(keyId) {
    if (keyId !== undefined) {
      this._store.delete(keyId);
      this._stats.delete(keyId);
      // Also remove any inflight entries for this keyId
      for (const k of this._inflight.keys()) {
        if (k.startsWith(`${keyId}:`)) {
          this._inflight.delete(k);
        }
      }
    } else {
      this._store.clear();
      this._stats.clear();
      this._inflight.clear();
    }
  }
}

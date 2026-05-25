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

// ── D57 — ADR 0005 Amendment 8 streaming-singleflight shapes ──────────────

/**
 * @typedef {Object} StreamingInflightEntry
 * @property {string} compositeKey            - `${keyId}\0${cacheKey}`
 * @property {AsyncIterator<*>|null} source   - underlying source iterator (null while factory pending)
 * @property {AbortController} sourceAbortController - propagates "all clients gone" to the source
 * @property {Array<*>} accumulatedChunks     - late-joiner replay buffer (bounded by §10)
 * @property {number} accumulatedByteSize     - running byte size of accumulatedChunks
 * @property {boolean} accumulatedReplayCapExceeded - true once §10 cap hit; cache write will skip
 * @property {Set<AttachedClient>} attachedClients - all live clients tee'ing this source
 * @property {boolean} factoryPending         - true while sourceFactory() is awaited
 * @property {Array<{ resolve: function, reject: function }>} pendingJoiners - late joiners arriving during factoryPending
 * @property {boolean} sourceDone             - source iterator exhausted normally
 * @property {Error|null} sourceError         - non-null if source threw
 * @property {boolean} sourceAborted          - true if AbortController fired
 * @property {number} ttlMs                   - TTL to use when writing the completed accumulated chunks to cache
 */

/**
 * @typedef {Object} AttachedClient
 * @property {string} id                      - request id / correlator
 * @property {Array<*>} queue                 - per-client tee buffer
 * @property {number} queueByteSize           - running byte size sum
 * @property {boolean} yieldedAccumulated     - true after late-joiner replay drained
 * @property {boolean} done                   - terminal sentinel hit
 * @property {boolean} backpressured          - true once STREAM_BACKPRESSURE terminator scheduled
 * @property {Error|null} error               - non-null if source threw or replay-drain over-cap
 * @property {((chunk: { value: *, done: boolean }) => void)|null} resolveNext - pending pull promise resolver
 * @property {((err: Error) => void)|null} rejectNext - pending pull promise rejecter
 */

// ADR 0005 Amendment 8 §14 — implementation defaults. Per-call overrides flow
// via the `opts` argument to getOrComputeStreaming (used by tests to exercise
// caps cheaply without producing megabytes of fixture data).
export const PER_CLIENT_QUEUE_CAP_DEFAULT = 1 * 1024 * 1024;
export const ACCUMULATED_REPLAY_CAP_DEFAULT = 10 * 1024 * 1024;

/**
 * Returns an approximate byte size for a chunk. The tee + cap math uses
 * JSON.stringify length as the serialization yardstick (matches the cache
 * store's existing size accounting via Buffer.byteLength(JSON.stringify(...))).
 * Non-stringifiable values (circular, etc.) fall back to 0 — the tee continues
 * but the size accounting under-estimates that chunk. In practice IR chunks
 * are always JSON-safe.
 *
 * @param {*} chunk
 * @returns {number}
 */
function _chunkByteSize(chunk) {
  try {
    return Buffer.byteLength(JSON.stringify(chunk) ?? '', 'utf8');
  } catch {
    return 0;
  }
}

/**
 * Synthesises a STREAM_BACKPRESSURE terminator stream (ADR 0005 Amendment 8 §8):
 * yields `{ type: 'stop', finish_reason: 'length' }` then a `[DONE]` sentinel
 * then ends. Used both for late-joiner-too-late and per-client overflow paths.
 *
 * @returns {AsyncGenerator<*>}
 */
async function* _backpressureTerminator() {
  yield { type: 'stop', finish_reason: 'length' };
  yield '[DONE]';
}

// ── CacheStore ────────────────────────────────────────────────────────────

export class CacheStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxEntriesPerKey=1000]   — evict oldest entries when exceeded
   * @param {number} [opts.maxAgeMs=86400000]        — default TTL: 24 hours
   * @param {number} [opts.maxEntryBytes=10485760]   — max serialized size per entry (default 10 MB).
   *   Entries whose JSON.stringify serialization exceeds this limit are not persisted.
   *   ADR 0005 § "Cache write conditions" item 4 (D23). Cache is for hot-path repeat
   *   requests, not bulk archive. Configurable so tests can exercise the cap cheaply.
   * @param {() => number} [opts._nowFn=Date.now]   — injectable for TTL testing
   * @param {(msg: string, meta?: object) => void} [opts._warnFn] — injectable for warn testing
   */
  constructor(opts = {}) {
    this._maxEntriesPerKey = opts.maxEntriesPerKey ?? 1000;
    this._maxAgeMs = opts.maxAgeMs ?? 24 * 60 * 60 * 1000; // 24 hours
    // ADR 0005 § "Cache write conditions" item 4 (D23): default 10 MB = 10 * 1024 * 1024 bytes.
    this._maxEntryBytes = opts.maxEntryBytes ?? 10 * 1024 * 1024;
    this._nowFn = opts._nowFn ?? (() => Date.now());
    // Injectable warn function for testing (defaults to console.warn).
    this._warnFn = opts._warnFn ?? ((msg, meta) => console.warn(msg, meta ?? ''));

    // D1 per-key isolation: keyId → Map<cacheKey, CacheEntry>
    /** @type {Map<string, Map<string, CacheEntry>>} */
    this._store = new Map();

    // D4 singleflight: `${keyId}:${cacheKey}` → Promise<value>
    /** @type {Map<string, Promise<*>>} */
    this._inflight = new Map();

    // D57 — ADR 0005 Amendment 8: streaming singleflight per-(keyId,cacheKey)
    // inflight Map. Composite key uses `\0` separator per §2 (avoids colliding
    // with keyId or cacheKey content). The check + insert against this Map is
    // synchronous in getOrComputeStreaming (no `await` between read & write),
    // mirroring D38 `tryAcquireSpawn` atomicity.
    /** @type {Map<string, StreamingInflightEntry>} */
    this._streamingInflight = new Map();

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
   * ADR 0005 § "Cache write conditions" item 4 (D23): if the serialized size of `value`
   * exceeds `maxEntryBytes`, the entry is NOT persisted. A `cache_skip_oversize` warn
   * event is logged. The caller still receives the value (this method returns undefined
   * either way); only persistent caching is skipped.
   *
   * @param {string} keyId
   * @param {string} cacheKey
   * @param {*} value
   * @param {number} [ttlMs] - overrides default maxAgeMs
   * @returns {Promise<void>}
   */
  async set(keyId, cacheKey, value, ttlMs) {
    // ADR 0005 § "Cache write conditions" item 4 (D23): size cap check.
    const byteLength = Buffer.byteLength(JSON.stringify(value));
    if (byteLength > this._maxEntryBytes) {
      this._warnFn('cache_skip_oversize', {
        byteLength,
        maxEntryBytes: this._maxEntryBytes,
        keyId,
        cacheKey,
      });
      return; // Do not persist; caller still receives the value from computeFn.
    }

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
   *
   * D57 — ADR 0005 Amendment 8 / issue #16 resolved at the cache layer:
   * the sibling `getOrComputeStreaming` method below provides tee-fan-out +
   * per-client backpressure for the streaming path. Server-side wiring lands
   * separately in D58.
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
   * D57 — ADR 0005 Amendment 8 (issue #16): streaming singleflight + tee-fan-out.
   *
   * Streaming-path sibling of `getOrCompute`. Coordinates concurrent identical
   * streaming requests so only one source spawn occurs, all attached clients
   * receive identical chunk sequences in order, late joiners are replayed from
   * an accumulated buffer, slow clients are disconnected with a synthetic
   * STREAM_BACKPRESSURE terminator instead of stalling the source, and the
   * source is aborted when all clients disconnect.
   *
   * The Map check + insert against `_streamingInflight` is synchronous — no
   * `await` between read and write — matching the D38 `tryAcquireSpawn`
   * atomicity invariant and collapsing the original TOCTOU window in
   * `server.mjs:782` (peek + spawn). See §1 + §6.
   *
   * Three outcomes (Amendment 8 §1):
   *   - **cache_hit**: cached entry exists and is alive → returns
   *     `{ stream: <async iterator over cached chunks>, isFirst: false,
   *        role: 'cache_hit' }`. No spawn. `hits` incremented.
   *   - **attached**: inflight entry exists in `_streamingInflight` → attaches
   *     a new AttachedClient. Late-joiner replay (§5) drains accumulated
   *     chunks synchronously; if drain would exceed `perClientQueueCap` the
   *     client receives a STREAM_BACKPRESSURE synthesised stream instead.
   *     `isFirst: false`, `role: 'attached'`. `hits` incremented (sharing a
   *     spawn is functionally a "cache-like" benefit; documented choice).
   *   - **source**: no cache hit, no inflight entry → the cache layer takes
   *     the inflight lock synchronously (placeholder entry inserted), then
   *     `await sourceFactory()`. If the factory throws (e.g.
   *     CONCURRENCY_LIMIT) the placeholder is removed and the error
   *     propagates. On success the source is wired up, the tee task starts,
   *     `isFirst: true`, `role: 'source'`. `misses` incremented.
   *
   * **`role` enum** (returned at attach-time):
   *   - `source` — first caller; entry created. Lifetime-end may upgrade to
   *     `solo` (no joiners ever attached) at the server (D58); the cache
   *     layer reports `source` at attach-time and does not flip mid-stream.
   *   - `attached` — joined an existing inflight entry.
   *   - `cache_hit` — served from cache; no entry created.
   *
   * **Amendment 8 §11 header values**: the X-OLP-Streaming-Inflight header
   * (D58) uses `source | attached | solo`. The cache layer's `cache_hit` is
   * the "served from cache without inflight" case; D58 chooses whether to
   * emit `solo` or omit the header for that path. The cache layer reports
   * `cache_hit` as a distinct role so the server can disambiguate.
   *
   * **§14 defaults**: `PER_CLIENT_QUEUE_CAP = 1 MB`, `ACCUMULATED_REPLAY_CAP
   * = 10 MB`. Both overridable via `opts` for cheap test exercise of the cap
   * paths.
   *
   * @param {string} keyId
   * @param {string} cacheKey
   * @param {() => Promise<AsyncIterator<*>>|AsyncIterator<*>} sourceFactory
   *   Invoked exactly once per inflight lifetime (only on first caller).
   *   Returns the source async iterator. May throw (e.g. CONCURRENCY_LIMIT
   *   from `tryAcquireSpawn`); on throw, the inflight entry is removed and
   *   the error propagates to the first caller. Late joiners that attached
   *   while the factory was pending are rejected with the same error.
   * @param {object} [opts]
   * @param {string} [opts.clientId]              - correlator id (defaults to incrementing counter)
   * @param {number} [opts.ttlMs]                 - TTL for completed accumulated-chunks cache write
   * @param {number} [opts.perClientQueueCap]     - override §14 default (1 MB)
   * @param {number} [opts.accumulatedReplayCap]  - override §14 default (10 MB)
   * @returns {Promise<{ stream: AsyncGenerator<*>, isFirst: boolean, role: 'source'|'attached'|'cache_hit' }>}
   */
  async getOrComputeStreaming(keyId, cacheKey, sourceFactory, opts = {}) {
    const compositeKey = `${keyId}\0${cacheKey}`;
    const perClientQueueCap = opts.perClientQueueCap ?? PER_CLIENT_QUEUE_CAP_DEFAULT;
    const accumulatedReplayCap = opts.accumulatedReplayCap ?? ACCUMULATED_REPLAY_CAP_DEFAULT;
    const ttlMs = opts.ttlMs;
    const clientId = opts.clientId ?? `c-${this._nowFn()}-${Math.floor(Math.random() * 1e9).toString(36)}`;

    // ── (A) Inflight Map check FIRST (Amendment 8 §6 — TTL race) ───────────
    // Late joiners that arrive after a cache entry has expired but during an
    // active source spawn must still attach via the inflight Map rather than
    // re-spawn. The synchronous Map.get + (if hit) Map preservation here
    // satisfies the no-`await`-between-check-and-decision invariant.
    const inflightEntry = this._streamingInflight.get(compositeKey);
    if (inflightEntry) {
      // Hits-as-share decision (documented at method header): sharing a spawn
      // is a cache-like benefit; increment hits for consistency with
      // cache_hit accounting and to expose the singleflight win in stats().
      this._getStats(keyId).hits++;
      const stream = this._attachClient(inflightEntry, {
        clientId,
        perClientQueueCap,
      });
      return { stream, isFirst: false, role: 'attached' };
    }

    // ── (B) Cache hit check (no inflight) ──────────────────────────────────
    // Replays cached chunks via a synthetic async iterator. No source spawn.
    const ns = this._getNamespace(keyId);
    const existing = ns.get(cacheKey);
    if (existing && this._isAlive(existing)) {
      this._getStats(keyId).hits++;
      const cachedChunks = Array.isArray(existing.value) ? existing.value : [existing.value];
      const stream = (async function* cacheReplay() {
        for (const chunk of cachedChunks) {
          yield chunk;
        }
      })();
      return { stream, isFirst: false, role: 'cache_hit' };
    }

    // ── (C) Miss + no inflight: take the lock synchronously, then await ───
    // The placeholder entry is inserted BEFORE invoking sourceFactory so that
    // late joiners arriving while the factory is awaited see the inflight
    // entry and attach (they're parked in `pendingJoiners` until the factory
    // resolves or rejects). If the factory throws, the placeholder is
    // removed and the error propagates to the first caller AND all parked
    // joiners. This preserves the §1 invariant: the Map insert is atomic
    // from later joiners' perspective.
    const entry = /** @type {StreamingInflightEntry} */ ({
      compositeKey,
      source: null,
      sourceAbortController: new AbortController(),
      accumulatedChunks: [],
      accumulatedByteSize: 0,
      accumulatedReplayCapExceeded: false,
      attachedClients: new Set(),
      factoryPending: true,
      pendingJoiners: [],
      sourceDone: false,
      sourceError: null,
      sourceAborted: false,
      ttlMs,
    });
    this._streamingInflight.set(compositeKey, entry);
    this._getStats(keyId).misses++;

    // Attach the first caller synchronously so any subsequent joiners during
    // the factory await see the same set/topology as the first caller.
    const firstStream = this._attachClient(entry, {
      clientId,
      perClientQueueCap,
    });

    let sourceIter;
    try {
      const factoryResult = sourceFactory();
      sourceIter = factoryResult && typeof factoryResult.then === 'function'
        ? await factoryResult
        : factoryResult;
    } catch (err) {
      // Factory rejected — remove placeholder and reject first caller + any
      // late joiners that arrived during the await.
      this._streamingInflight.delete(compositeKey);
      for (const client of entry.attachedClients) {
        if (client.rejectNext) {
          client.rejectNext(err);
          client.resolveNext = null;
          client.rejectNext = null;
        }
        client.error = err;
        client.done = true;
      }
      throw err;
    }

    entry.source = sourceIter;
    entry.factoryPending = false;

    // Kick off the tee task. It runs detached; lifetime is bounded by the
    // source iterator's completion / error / abort.
    this._teeStreamingSource(keyId, cacheKey, entry, {
      accumulatedReplayCap,
    });

    return { stream: firstStream, isFirst: true, role: 'source' };
  }

  /**
   * D57 — ADR 0005 Amendment 8 §3 + §5: attach a new client to an inflight
   * entry. Synchronously drains the accumulated replay buffer into the
   * client's queue (§5). If the drain would exceed `perClientQueueCap`, the
   * client receives a STREAM_BACKPRESSURE synthesised stream INSTEAD of the
   * normal tee — the source continues for the other clients.
   *
   * Returns the async iterator the caller will consume.
   *
   * @private
   */
  _attachClient(entry, { clientId, perClientQueueCap }) {
    // Late-joiner replay drain cap check (§5 + §10): a late joiner cannot
    // catch up if either
    //   (a) the accumulated buffer alone would overflow the per-client cap
    //       (burst > PER_CLIENT_QUEUE_CAP), or
    //   (b) the replay buffer is already truncated (§10 cap was hit and
    //       further source chunks were not appended to accumulatedChunks),
    //       so even a successful drain would give the joiner a partial view
    //       that disagrees with later live chunks.
    // Either condition → STREAM_BACKPRESSURE synthetic terminator. The
    // source / other clients are unaffected.
    if (
      entry.accumulatedByteSize > perClientQueueCap
      || entry.accumulatedReplayCapExceeded
    ) {
      this._warnFn('stream_backpressure_disconnect', {
        client_id: clientId,
        queue_byte_size: entry.accumulatedByteSize,
        per_client_cap: perClientQueueCap,
        composite_key: entry.compositeKey,
        reason: entry.accumulatedReplayCapExceeded
          ? 'replay_cap_truncated'
          : 'replay_drain_over_cap',
      });
      return _backpressureTerminator();
    }

    /** @type {AttachedClient} */
    const client = {
      id: clientId,
      queue: [],
      queueByteSize: 0,
      yieldedAccumulated: false,
      done: false,
      backpressured: false,
      error: null,
      resolveNext: null,
      rejectNext: null,
      // Per-client cap is captured here so the tee task can apply it
      // without re-plumbing opts; documented as an internal field.
      __perClientQueueCap__: perClientQueueCap,
    };

    // Synchronous replay drain — push every accumulated chunk into the
    // client's queue at attach-time. From this point on the tee task pushes
    // live chunks.
    for (const chunk of entry.accumulatedChunks) {
      client.queue.push(chunk);
      client.queueByteSize += _chunkByteSize(chunk);
    }
    client.yieldedAccumulated = true;
    entry.attachedClients.add(client);

    // TODO(D58 — ADR 0005 Amendment 8 §11): emit `streaming_inflight_join`
    // event from the server-layer wrapper, which has provider/model context.
    // Cache layer alone does not have provider/model identity (sourceFactory
    // is a closure), so the join event lives at the consumer of `role:
    // 'attached'` in server.mjs. D57 reviewer P2-3 follow-up.

    // If source already completed before this attach (last-second join)
    // mark the client as terminal-after-drain so the iterator returns
    // cleanly once the replay queue is drained.
    if (entry.sourceDone) {
      client.done = true;
    } else if (entry.sourceError) {
      client.error = entry.sourceError;
      client.done = true;
    }

    // Per-client AbortController for client-side cancellation (HTTP close).
    // The async iterator's return() removes the client from attachedClients;
    // if the entry's attachedClients size hits zero, the tee task aborts the
    // source. The teardown logic lives in the iterator below.
    const store = this;
    const iterator = (async function* clientStream() {
      try {
        while (true) {
          // Drain queue chunks first.
          if (client.queue.length > 0) {
            const next = client.queue.shift();
            client.queueByteSize -= _chunkByteSize(next);
            yield next;
            continue;
          }
          // Backpressure-terminated client: yield the synthetic terminator.
          if (client.backpressured) {
            yield { type: 'stop', finish_reason: 'length' };
            yield '[DONE]';
            client.done = true;
            return;
          }
          // Source already errored.
          if (client.error) {
            throw client.error;
          }
          // Source already completed and no more queued chunks.
          if (client.done) {
            return;
          }
          // Block until the tee task pushes the next chunk (or signals
          // source-done / source-error / backpressure).
          await new Promise((resolve, reject) => {
            client.resolveNext = resolve;
            client.rejectNext = reject;
          });
          client.resolveNext = null;
          client.rejectNext = null;
        }
      } finally {
        // Iterator return() fired (HTTP close, break, or normal return) —
        // remove client and possibly trigger source abort.
        if (entry.attachedClients.has(client)) {
          entry.attachedClients.delete(client);
        }
        // If we're the last client AND the source is still running, fire
        // the AbortController so the source iterator's return() / cleanup
        // can reap any underlying resources.
        if (
          entry.attachedClients.size === 0
          && !entry.sourceDone
          && !entry.sourceError
          && !entry.sourceAborted
          && !entry.factoryPending
        ) {
          entry.sourceAborted = true;
          try {
            entry.sourceAbortController.abort();
          } catch {
            // best-effort
          }
          // Tee task observes attachedClients.size === 0 + sourceAborted on
          // its next loop iteration and exits without a cache write.
          store._streamingInflight.delete(entry.compositeKey);
          store._warnFn('streaming_inflight_abort', {
            composite_key: entry.compositeKey,
            accumulated_chunk_count: entry.accumulatedChunks.length,
          });
        }
      }
    })();

    return iterator;
  }

  /**
   * D57 — ADR 0005 Amendment 8 §4: tee fan-out task. One reader pulls from
   * `entry.source`; on each chunk, pushes to `accumulatedChunks` (bounded by
   * §10) and to every attached client's queue (per-client cap from §8).
   *
   * On source completion: writes accumulated chunks to cache if (a) cap not
   * exceeded and (b) `set()`'s own `maxEntryBytes` cap admits it. Resolves
   * all clients to drain-out state. Removes entry.
   *
   * On source error: rejects all clients via their `rejectNext`. No cache
   * write. Removes entry.
   *
   * Source-abort short-circuit: if `attachedClients.size === 0` after a push,
   * fires `sourceAbortController.abort()`, exits without cache write.
   *
   * @private
   */
  _teeStreamingSource(keyId, cacheKey, entry, { accumulatedReplayCap }) {
    const store = this;
    (async () => {
      try {
        for (;;) {
          // Pre-check: if all clients have already gone away before we even
          // pull the next chunk, abort the source and bail out. (The
          // per-client iterator's finally-block sets sourceAborted=true and
          // removes the entry; we just need to stop pulling.)
          if (entry.attachedClients.size === 0 && !entry.factoryPending) {
            if (!entry.sourceAborted) {
              entry.sourceAborted = true;
              try { entry.sourceAbortController.abort(); } catch { /* best-effort */ }
            }
            // Try to call return() on the source so the underlying generator
            // cleans up. Best-effort; not all iterators implement it.
            try {
              if (entry.source && typeof entry.source.return === 'function') {
                await entry.source.return();
              }
            } catch { /* best-effort */ }
            return;
          }

          const result = await entry.source.next();
          if (result.done) break;
          const chunk = result.value;
          const size = _chunkByteSize(chunk);

          // §10 — replay buffer cap. Past the cap we stop accumulating (so
          // future late joiners can still see the chunks they need to
          // catch up to live), but we mark the entry not-cacheable so the
          // §4 completion path skips the cache write.
          if (!entry.accumulatedReplayCapExceeded) {
            if (entry.accumulatedByteSize + size > accumulatedReplayCap) {
              entry.accumulatedReplayCapExceeded = true;
              store._warnFn('streaming_inflight_replay_cap_exceeded', {
                composite_key: entry.compositeKey,
                accumulated_byte_size: entry.accumulatedByteSize,
                chunk_size: size,
                accumulated_replay_cap: accumulatedReplayCap,
              });
              // Continue accumulating up to this chunk so existing late
              // joiners' drain decision was based on the size they saw at
              // attach-time. We do NOT push this chunk to accumulatedChunks
              // (it would corrupt the "<= cap at attach-time" invariant for
              // future joiners). Future joiners arriving past this point
              // see accumulatedByteSize already > cap and get the
              // backpressure terminator at attach-time per §5.
            } else {
              entry.accumulatedChunks.push(chunk);
              entry.accumulatedByteSize += size;
            }
          }

          // Fan out to each client synchronously (no await inside the for-
          // each-client loop). Disconnecting a client is mutation-during-
          // iteration; we snapshot the set first.
          const clientsSnapshot = [...entry.attachedClients];
          for (const client of clientsSnapshot) {
            // Per-client backpressure (§8). If the push would exceed the
            // per-client cap, disconnect this client only.
            if (client.queueByteSize + size > client.__perClientQueueCap__) {
              client.backpressured = true;
              store._warnFn('stream_backpressure_disconnect', {
                client_id: client.id,
                queue_byte_size: client.queueByteSize,
                per_client_cap: client.__perClientQueueCap__,
                composite_key: entry.compositeKey,
                reason: 'queue_overflow',
              });
              // Remove from set so future fan-out skips this client.
              entry.attachedClients.delete(client);
              // Wake the client's pull-promise so it can yield the synthetic
              // STREAM_BACKPRESSURE terminator.
              if (client.resolveNext) {
                const r = client.resolveNext;
                client.resolveNext = null;
                client.rejectNext = null;
                r({ value: undefined, done: false });
              }
              continue;
            }
            client.queue.push(chunk);
            client.queueByteSize += size;
            if (client.resolveNext) {
              const r = client.resolveNext;
              client.resolveNext = null;
              client.rejectNext = null;
              r({ value: undefined, done: false });
            }
          }

          // If the fan-out emptied the attached set (all over-cap), the
          // top-of-loop pre-check will fire on the next iteration and abort.
        }

        // Source iterator returned normally.
        entry.sourceDone = true;
        const cacheWritten =
          !entry.accumulatedReplayCapExceeded
          && entry.accumulatedChunks.length > 0;
        if (cacheWritten) {
          // ADR 0005 Amendment 8 §4: write accumulated chunks to cache via
          // the standard set() path (which itself applies the D23
          // maxEntryBytes cap — separate from the §10 replay cap).
          await store.set(keyId, cacheKey, entry.accumulatedChunks, entry.ttlMs);
        }
        store._warnFn('streaming_inflight_source_done', {
          composite_key: entry.compositeKey,
          attached_count: entry.attachedClients.size,
          accumulated_chunk_count: entry.accumulatedChunks.length,
          cache_written: cacheWritten,
        });
        // Wake every remaining attached client so they drain their queue and
        // observe `done = true`.
        for (const client of [...entry.attachedClients]) {
          client.done = true;
          if (client.resolveNext) {
            const r = client.resolveNext;
            client.resolveNext = null;
            client.rejectNext = null;
            r({ value: undefined, done: true });
          }
        }
        store._streamingInflight.delete(entry.compositeKey);
      } catch (err) {
        // Source threw mid-stream. Reject every attached client.
        entry.sourceError = err;
        for (const client of [...entry.attachedClients]) {
          client.error = err;
          client.done = true;
          if (client.rejectNext) {
            const rej = client.rejectNext;
            client.resolveNext = null;
            client.rejectNext = null;
            rej(err);
          }
        }
        store._streamingInflight.delete(entry.compositeKey);
      }
    })();
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
      // D57 — ADR 0005 Amendment 8 §1: inflightCount aggregates both the
      // buffered-path singleflight Map and the streaming-path inflight Map
      // so stats() reflects all active dedup-coordination entries.
      return {
        hits: s.hits,
        misses: s.misses,
        size,
        inflightCount: this._inflight.size + this._streamingInflight.size,
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
      // D57 — see per-keyId branch above; streaming entries counted alongside buffered.
      inflightCount: this._inflight.size + this._streamingInflight.size,
    };
  }

  /**
   * Removes a specific (keyId, cacheKey) entry immediately.
   *
   * ADR 0005 § "Cache write conditions" item 1 (D39, issue #3 Part 1):
   *   D16 truncation-eviction previously used `set(..., ttlMs=0)` to leave a
   *   tombstone that the next `get`/`peek` would lazily purge. That pattern
   *   left dead entries in the namespace Map until next access, accruing
   *   memory if no follow-up read ever fires. `delete(keyId, cacheKey)` makes
   *   the eviction explicit and immediate.
   *
   * Memory hygiene: if the per-keyId namespace becomes empty after delete,
   * the namespace Map entry itself is removed (mirrors the pattern in D38
   * `_activeSpawns` so empty namespaces don't accumulate in `_store`).
   *
   * Stats: this method does NOT touch hit/miss counters — it is an eviction
   * primitive, not a read. Aggregate `size` reported by `stats()` reflects
   * the removal on the next call.
   *
   * @param {string} keyId
   * @param {string} cacheKey
   * @returns {boolean} true if the entry was present and removed; false if absent.
   */
  delete(keyId, cacheKey) {
    const ns = this._store.get(keyId);
    if (!ns) return false;
    const had = ns.delete(cacheKey);
    // Memory hygiene: drop empty namespace Map entries.
    if (had && ns.size === 0) {
      this._store.delete(keyId);
    }
    return had;
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
      // D57 — also clear streaming inflight entries scoped to this keyId.
      // Composite key uses `\0` separator (see _streamingInflight init).
      for (const k of this._streamingInflight.keys()) {
        if (k.startsWith(`${keyId}\0`)) {
          this._streamingInflight.delete(k);
        }
      }
    } else {
      this._store.clear();
      this._stats.clear();
      this._inflight.clear();
      this._streamingInflight.clear();
    }
  }
}

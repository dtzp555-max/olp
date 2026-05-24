# ADR 0004 — Fallback Engine Semantics and Safety

- **Date:** 2026-05-23
- **Status:** Accepted (bootstrap)
- **Authors:** project maintainer (with AI drafting assistance)
- **Related:** OLP v0.1 spec §4.3; ADR 0001 (project founding — fallback is OLP's core value proposition); ADR 0002 (plugin architecture); ADR 0003 (IR — fallback replays IR across chain hops)

## Amendments

### Amendment 5 — 2026-05-24: `X-OLP-Fallback-Detail` header shipped as ungated v0.1 (D40, issue #7)

- **Finding:** Step 4 of § Decision § Chain advancement (below) promised "per-provider failure detail in a debug header `X-OLP-Fallback-Detail` (JSON, owner-only — gated behind a config flag for non-owner keys)." From D9 through D39 the engine logged per-hop failure events via `fallback_hop_error` / `fallback_hard_trigger` / `fallback_client_error_no_fallback` / `fallback_auth_missing_no_fallback` / `fallback_non_trigger_error` (D28 added the `chain_id` / `trigger_type` / `ir_request_hash` / `next_provider` correlation fields), but the per-hop failure trail was not surfaced on the response. GitHub issue #7 tracked the gap.
- **Change (D40):**
  - `lib/fallback/engine.mjs#executeWithFallback` now collects per-hop failure tuples in a new `fallbackDetail` array on the returned `FallbackResult`. Tuple shape reuses D28 log-event field shapes so logs and the header pivot on the same keys:
    `{ hop, provider, model, code, error_message, trigger_type }`. `code` is the `ProviderError` code, or any string `err.code` (including the engine-synthetic `SOFT_TRIGGER`), or `'UNKNOWN'` for non-`ProviderError` exceptions. `error_message` is truncated to 200 chars (single-character ellipsis `…` appended on truncation). `trigger_type` is the same classification surfaced in the D28 log events.
  - `server.mjs` emits the new header `X-OLP-Fallback-Detail: <JSON-stringified array>` on any response where `fallbackDetail` is non-empty — i.e., chain-exhausted, non-trigger-error, client-error, AUTH_MISSING, and success-with-prior-failure paths. Header is absent on clean primary success (semantically: no failure trail to report).
  - 4KB UTF-8 byte cap on the header value: if the serialised array exceeds 4096 bytes, tail tuples are dropped one at a time and a `{ truncated: true, omitted_hops: N }` sentinel is appended such that the total fits under the cap.
  - Non-ASCII characters in tuple fields (e.g. the em dash in the synthesised `CONCURRENCY_LIMIT` error message) are escaped as `\uXXXX` to satisfy RFC 7230 §3.2.6 `field-vchar` (Node's HTTP header validator rejects multi-byte UTF-8). `JSON.parse` round-trips the escaped form correctly.
- **Gating — Option A (ungated v0.1):** The original promise specified owner-only gating. Per the maintainer decision recorded in issue #7, v0.1 ships the header **ungated**: the failure detail is surfaced on every response regardless of API key identity. Rationale: OLP v0.1 is single-tenant family-scale (per ALIGNMENT.md § What this project is); no PII risk in error details. **Phase 2 will re-introduce owner-vs-non-owner gating when `lib/keys.mjs` lands** — this is an explicit follow-up tracked in AGENTS.md § Key files to know and in the lib/keys.mjs Phase 2 planning. Until then, the header is informational on every response and operators should not assume per-key visibility differs.
- **Authority:** § Decision § Chain advancement step 4 (original promise — D40 fulfils it); D18 (5 standard X-OLP-* headers; D40 builds on this convention); D28 (per-hop structured log fields; D40 reuses the field shapes); GitHub issue #7 — closed by this commit.
- **Tests (test-features.mjs):** New describe block "D40 — X-OLP-Fallback-Detail header (issue #7)" covers: engine-level tuple shape on 2-hop/exhausted, 2-hop/success-with-prior-failure, 1-hop/success (empty array), 1-hop/fail, non-ProviderError-yields-`UNKNOWN`, 500-char-message → 200-char-with-ellipsis, client error → 1 tuple + `client_error` trigger type; serialiser-level empty/null → null, small-array round-trip, >4KB cap with `{truncated:true,omitted_hops:N}` sentinel, RFC 7230 newline/CR escaping, and non-ASCII escaping (em dash regression guard for the D38 `CONCURRENCY_LIMIT` synthesised message); HTTP integration covers clean-1-hop-success (header absent), 2-hop-exhausted (2 tuples on the wire), and 2-hop-success-with-prior-failure (1 tuple on the wire). Test count 452 → 468 (16 new tests).
- **v1.x re-evaluation triggers:**
  - When `lib/keys.mjs` lands (Phase 2), re-introduce owner-vs-non-owner gating. Update this amendment + § Observability headers below + AGENTS.md.
  - If a future debug-header field becomes useful (e.g., `attempts`, `cache_eviction_count`, `last_chunk_index`), add to the tuple schema documented above + bump this amendment + extend the test schema assertions.
- **Procedural mechanism:** CC 开发铁律 v1.6 § 10.x (D40 issue #7 implementation; fresh-context opus reviewer to follow per Iron Rule 10).

### Amendment 4 — 2026-05-24: Add `CONCURRENCY_LIMIT` to v0.1 hard-trigger code taxonomy (D38, issue #1)

- **Finding:** ADR 0002 Amendment 1 (2026-05-23) ratified `hints.maxConcurrent` into the Provider contract as **declarative-only at v0.1** — no runtime enforcement. GitHub issue #1 tracked the gap. D38 lands runtime enforcement (see ADR 0002 Amendment 6 for the implementation details and design rationale). Once a saturation event occurs, the orchestration layer must communicate "this hop is at capacity — advance the chain" to the fallback engine using a code that fits the existing hard-trigger taxonomy in `evaluateHardTriggers`.
- **Change (D38):** Add `CONCURRENCY_LIMIT` to both:
  - `PROVIDER_ERROR_CODES` in `lib/providers/base.mjs` (closed enum used by `ProviderError`).
  - `HARD_TRIGGER_CODES` in `lib/fallback/engine.mjs` — value `true` so `evaluateHardTriggers(ProviderError CONCURRENCY_LIMIT)` returns `true` and `classifyTrigger` returns `'hard'`. The chain advances to the next hop. The synthesised error carries diagnostic fields (`providerName`, `maxConcurrent`, `activeSpawns`) which surface in the existing `fallback_hard_trigger` log event via the `error.message` field.
- **v0.1 live hard-trigger codes after this amendment (5 codes):** `SPAWN_FAILED`, `CLI_NOT_FOUND`, `SPAWN_TIMEOUT`, `CONCURRENCY_LIMIT`, plus the explicit non-trigger `AUTH_MISSING:false`. Pre-D38 list (per Amendment 3) was 4 codes (`SPAWN_FAILED`, `CLI_NOT_FOUND`, `SPAWN_TIMEOUT` as triggers + `AUTH_MISSING:false`).
- **Synthesis vs. plugin-thrown:** Unlike the other live hard-trigger codes, `CONCURRENCY_LIMIT` is **NOT thrown by provider plugins themselves**. It is synthesised by `server.mjs handleChatCompletions` when `tryAcquireSpawn(provider, hints.maxConcurrent)` returns false. The code lives in `PROVIDER_ERROR_CODES` for type consistency with the closed enum that `HARD_TRIGGER_CODES` keys on; the orchestration layer is the only callsite that throws it. A future provider plugin that gains its own internal concurrency limit (e.g., a CLI that returns a specific exit code on rate-limit) could thrown this code too; the enum is forward-compatible.
- **Design choice — immediate-advancement vs. queue+timeout:** Re-stating from ADR 0002 Amendment 6 because this ADR governs the trigger taxonomy that surfaces the decision to the user: saturation is treated as a **hard trigger** (chain advances immediately) rather than as a **soft trigger** (would gate before spawn but would not advance after spawn attempt) or as a queueable condition (would block + timeout). The hard-trigger framing matches "the primary hop refused to serve this request; advance" semantics. Queue+timeout would require a NEW trigger category outside the existing taxonomy (hard / soft / deterministic-deferred / cost-aware-deferred) and is deferred per ADR 0002 Amendment 6 rationale.
- **First-chunk safety:** `tryAcquireSpawn` runs **before** `provider.spawn(...)` and before any bytes are written to the response. A `CONCURRENCY_LIMIT` rejection therefore satisfies the first-chunk rule trivially — zero bytes have been emitted to the client. Fallback is safe.
- **Authority:** ADR 0002 Amendment 6 (runtime enforcement implementation); GitHub issue #1 (tracking).
- **Tests:** Suite 18 in `test-features.mjs` — see ADR 0002 Amendment 6 § Tests for the full list. Specifically for this ADR: tests 18a (PROVIDER_ERROR_CODES membership), 18b (`evaluateHardTriggers(CONCURRENCY_LIMIT) === true`), 18c (AUTH_MISSING regression guard — D38 did not flip it), 18k (chain advances to fallback hop on saturated primary).
- **v1.x re-evaluation triggers:**
  - If a future plugin gains a CLI-level concurrency response that should NOT be a hard trigger (e.g., "soft limit hit, retry after backoff") — file a follow-up to add a new code (e.g., `CONCURRENCY_BACKOFF`) rather than reclassifying `CONCURRENCY_LIMIT`.
  - If queue+timeout becomes desirable (real usage shows fail-fast advancement is too aggressive for certain workloads), file an amendment to this ADR adding queue semantics as a NEW trigger category — do not reclassify CONCURRENCY_LIMIT into the existing taxonomy.
- **Procedural mechanism:** CC 开发铁律 v1.6 § 10.x (D38 issue #1 implementation; fresh-context opus reviewer to follow per Iron Rule 10).

### Amendment 3 — 2026-05-24: Narrow v0.1 hard-trigger code taxonomy (D34 F7)

- **Finding:** Round-6 cold-audit F7 (P2) — `PROVIDER_ERROR_CODES` in `lib/providers/base.mjs` and `HARD_TRIGGER_CODES` in `lib/fallback/engine.mjs` both listed `QUOTA_EXHAUSTED` and `RATE_LIMITED` as live hard-trigger codes. No v0.1 plugin emits either code. The Anthropic, Codex, and Mistral plugins all use `claude -p`, `codex exec --json`, and `vibe --prompt` respectively — none parse the underlying-API HTTP response status code or surface a structured quota/rate error; they only throw `SPAWN_FAILED`, `SPAWN_TIMEOUT`, `CLI_NOT_FOUND`, or `AUTH_MISSING`. The two `Hard triggers` bullets in § Trigger taxonomy ("HTTP 5xx from provider's underlying API" and "HTTP 4xx quota exhaustion") are therefore unreachable through the `ProviderError` code path at v0.1.
- **Also found:** `evaluateHardTriggers` in `engine.mjs` has HTTP `statusCode` branches (`>= 500` and `>= 400`) that are also unreachable at v0.1 — plugins never attach `statusCode` to thrown errors. These branches are left in place as forward-compatible intent-signal code (option (b) per D34 discussion), with a prominent comment. Removing them would require corresponding ADR revision; keeping them preserves the design intent for when a future plugin gains HTTP-status parsing.
- **Change (D34 F7):**
  - `QUOTA_EXHAUSTED` and `RATE_LIMITED` removed from `PROVIDER_ERROR_CODES` (base.mjs) and `HARD_TRIGGER_CODES` (engine.mjs). Dead code removal.
  - A comment block added in `evaluateHardTriggers` labeling the HTTP-status branches as "forward-compat reserved — v0.1 plugins never attach statusCode."
  - Test coverage: the two unit tests for `evaluateHardTriggers: ProviderError QUOTA_EXHAUSTED/RATE_LIMITED → fires` are removed (tombstoned with a removal comment). All other hard-trigger tests that used these codes as convenient test vectors are rewritten to use `SPAWN_FAILED` / `SPAWN_TIMEOUT`.
- **v0.1 live hard-trigger codes after this amendment:** `SPAWN_FAILED`, `CLI_NOT_FOUND`, `SPAWN_TIMEOUT`. `AUTH_MISSING` remains in the table as an explicit `false` entry (deliberate non-trigger per ADR 0004 § "No fallback for client-side errors" analogue). **Subsequently extended by Amendment 4 (D38) — `CONCURRENCY_LIMIT` added as a 4th true entry; the v0.1 live-codes list as of D38 is `SPAWN_FAILED`, `CLI_NOT_FOUND`, `SPAWN_TIMEOUT`, `CONCURRENCY_LIMIT` plus the explicit `AUTH_MISSING:false` non-trigger entry.**
- **v1.x re-activation path:** When a plugin gains HTTP-status parsing (e.g., an Anthropic plugin variant that makes direct Messages API calls rather than spawning `claude -p`), add the plugin-layer HTTP parsing, re-add `QUOTA_EXHAUSTED` and `RATE_LIMITED` to both tables, and amend this entry. The `evaluateHardTriggers` HTTP-status branches will then activate naturally with no further engine changes.
- **Procedural mechanism:** CC 开发铁律 v1.6 § 10.x (Round-6 Cold Audit).

### Amendment 1 — 2026-05-24: Buffered-path SPAWN_FAILED with usable chunks must NOT trigger fallback (D16)

- **Finding:** Cold-audit Finding 17 (P2 fallback correctness) — Hard triggers bullet 3 in the Decision section below reads: "Provider CLI exit code ≠ 0 **with no usable response chunks streamed**." The qualifier "with no usable response chunks streamed" is load-bearing. Pre-D16 code in `server.mjs` `collectAllChunks` had no catch block: if the provider generator threw `ProviderError(SPAWN_FAILED)` after yielding N>0 IR delta/stop chunks, the throw propagated out of the `for await` loop, discarding the accumulated chunks. The fallback engine then treated SPAWN_FAILED as a hard trigger unconditionally, advanced the chain, and served the next provider's response. The original provider's actual partial output — content the user had already paid for — was silently dropped.

- **Clarification — "usable response chunks streamed":** A chunks array has usable chunks if `chunks.length > 0` where the counted chunks are IR delta or stop chunks (i.e., `type === 'delta'` or `type === 'stop'`). Chunks of `type === 'error'` are excluded from this count — they are failure signals, not usable content. In the buffered path (`collectAllChunks` in `server.mjs`), `type === 'error'` chunks cause an immediate throw before being pushed to the array (see existing code), so in practice `chunks.length > 0` after the loop implies the array contains only delta/stop chunks and the count correctly reflects usable content. The N=1 boundary is intentional: even a single non-empty delta chunk represents content the provider has committed and the user has paid for in quota; dropping it to serve an alternate provider's response is strict waste and potentially misleading (the second provider may produce different content for the same prompt).

- **Behavior change (D16):** In the buffered path (`collectAllChunks` in `server.mjs`), when the provider generator throws `ProviderError` with `code === 'SPAWN_FAILED'` after yielding one or more chunks:
  - If `chunks.length > 0`: synthesize a final stop chunk `{ type: 'stop', finish_reason: 'length' }`, push it to the chunks array, log a `warn` event `spawn_failed_after_usable_chunks`, and **return the chunks** (do not re-throw). The fallback engine sees a successful return value and does not advance the chain. The client receives the partial response with `finish_reason: 'length'`. `X-OLP-Fallback-Hops: 0` is emitted.
  - If `chunks.length === 0`: the SPAWN_FAILED error propagates as before. The fallback engine fires the hard trigger and advances the chain (Case A — correct behavior unchanged).
  - Any other error code (not SPAWN_FAILED): always re-thrown, behavior unchanged.
  - **Cache behavior:** truncated responses (those produced by the SPAWN_FAILED salvage path) are NOT persistently cached. ADR 0005 § "Cache write conditions" item 1 requires "response completed successfully (no truncation, no error mid-stream)"; a salvaged partial response does not meet this condition. In `executeHopFn`, the salvaged result is written through `cacheStore.getOrCompute` normally so that concurrent inflight callers (D4 singleflight) share the spawn and all receive the partial response — then the entry is immediately evicted via `cacheStore.set(keyId, hopCacheKey, result, ttlMs=0)`, which causes `_isAlive` to treat the entry as expired on the next read. The write-then-evict pattern preserves D4 singleflight during the truncation event (the right behavior — concurrent callers should share the partial spawn rather than each triggering their own) while ensuring future fresh callers re-spawn the provider rather than serving cached truncated content. The salvage path uses a non-enumerable `__truncated` marker on the returned chunks array to signal the eviction; the marker does not appear in `JSON.stringify` or in any client-visible surface.

- **finish_reason choice:** The synthesized stop chunk uses `finish_reason: 'length'` because: (a) it is in the OpenAI spec enum (`stop | length | tool_calls | content_filter | function_call | null`); (b) it semantically maps to "output was truncated due to resource constraints," which is the closest available enum value to "truncated because the provider process exited non-zero during cleanup after streaming output"; (c) `null` is inferior — some clients retry on `null` finish_reason expecting additional chunks, which would cause spurious re-requests; (d) `stop` would be misleading — it implies the model naturally terminated at a sentence boundary, which is false. Using `length` correctly signals to the client that the output was cut short and they may wish to re-request or continue.

- **Streaming path note:** The D10 real-streaming branch (single-hop, `server.mjs` lines 401–510) already handles the analogous case correctly via ADR 0004's first-chunk rule: once `firstChunkEmitted === true`, any subsequent error truncates the response with `res.end()` (no re-throw, no fallback). This amendment applies specifically to the **buffered path** (`collectAllChunks` + multi-hop fallback chains). The streaming path is not changed by D16.

#### D39 follow-up — explicit eviction primitive + observability log (2026-05-24, issue #3 Parts 1+2)

The original D16 cache-eviction implementation used `cacheStore.set(keyId, hopCacheKey, result, ttlMs=0)` to tombstone the just-written truncated entry. The TTL=0 entry survived in the per-keyId namespace `Map` until the next `get`/`peek` lazily purged it via the `_isAlive` check. D39 Part 1 replaces this with an explicit `cacheStore.delete(keyId, cacheKey)` primitive that (a) removes the entry from the namespace `Map` immediately, (b) removes the empty namespace `Map` entry from the outer store when it becomes empty (memory hygiene matching the D38 `_activeSpawns` pattern), and (c) returns `boolean` for caller inspection. D39 Part 2 adds a `cache_evicted_truncated` `info`-level log event with `{ provider, model }` fields immediately after the eviction, giving dashboards visibility into salvage frequency. Neither change alters the salvage semantics established by this Amendment — they are observability + memory-hygiene polish. Test coverage: 3 unit tests on `CacheStore.delete` (present-returns-true, absent-returns-false, empty-namespace-cleanup), 1 HTTP integration test asserting the log event fires with the correct fields, and 1 defense-in-depth regression test asserting two consecutive identical truncated requests both result in fresh spawns (no sticky cache).

#### Why SPAWN_TIMEOUT is excluded from salvage (D39 Part 4, issue #3 Part 4)

D16's salvage path is gated on `code === 'SPAWN_FAILED'`. SPAWN_TIMEOUT is **not** salvaged even when partial chunks have accumulated in the buffered path — the timeout error propagates from `collectAllChunks` as-is, the fallback engine fires the SPAWN_TIMEOUT hard trigger, and the chain advances to the next hop. This asymmetry is intentional and is the maintainer's design choice. The four-point rationale:

1. **SPAWN_FAILED is a terminal signal from this hop.** The provider crashed mid-stream; nothing more is coming from it. Salvaging the partial chunks is strictly better than discarding them (partial > nothing). Advancing the chain in this case offers no advantage: the same input may crash the next hop the same way (when the failure is input-dependent), and even when the next hop succeeds, the salvaged chunks were already paid for in quota — discarding them would be strict waste.

2. **SPAWN_TIMEOUT is a deadline signal, not a terminal signal.** It indicates the provider was slow (deadline exceeded per `hints.maxSpawnTimeMs`, which the plugin enforces — see the unconditional post-loop `if (spawnTimedOut) throw SPAWN_TIMEOUT` in each provider plugin, e.g. `lib/providers/anthropic.mjs`). The next hop is a *different provider* with different model-speed characteristics, so its full response is plausibly available sooner than the original hop's continuation would have been. Fallback advancement on timeout is more likely to give the user a complete response than salvaging partial-from-slow.

3. **The "user paid for partial" framing applies only to SPAWN_FAILED.** The D16 reviewer's "user paid for partial content, dropping it is strict waste" captures SPAWN_FAILED correctly: the deadline was honored, the provider died mid-stream, the chunks are real consumed quota. For SPAWN_TIMEOUT the user actually paid for "result within time T" — a partial result delivered *at* time T is not what was paid for. The fallback engine's "full result soon after time T" via a different provider is closer to the contract.

4. **Code-level inspection confirms the asymmetry (verified post-D38, D39 Part 4).** `collectAllChunks` in `server.mjs` matches only `spawnErr instanceof ProviderError && spawnErr.code === 'SPAWN_FAILED' && chunks.length > 0` for the salvage branch. SPAWN_TIMEOUT propagates through the same catch block via the unconditional re-throw, hits `evaluateHardTriggers` as a hard trigger (per Amendment 3: SPAWN_FAILED, CLI_NOT_FOUND, SPAWN_TIMEOUT; per Amendment 4: CONCURRENCY_LIMIT), and advances the chain. This asymmetry is not an oversight; it is the design.

**Hard-trigger taxonomy completeness:** The v0.1 hard-trigger code set is enumerated in Amendment 3 (D34 F7) and extended in Amendment 4 (D38, CONCURRENCY_LIMIT). Of those four codes, only SPAWN_FAILED participates in the salvage path. CLI_NOT_FOUND fires before any spawn output is possible (no partial chunks ever exist). CONCURRENCY_LIMIT fires before `provider.spawn(...)` is called (per Amendment 4 § First-chunk safety — zero bytes emitted at rejection moment). SPAWN_TIMEOUT can in principle accumulate partial chunks but is excluded from salvage per the rationale above.

**v1.x re-evaluation trigger:** If real usage shows users want partial-on-timeout for very long deadlines (e.g., a 5-minute `maxSpawnTimeMs` where the user would rather have whatever streamed in 5 minutes than re-pay quota on a different provider that may take its own 5 minutes), this asymmetry is queued as a future-design question. A v1.x amendment would need to: (a) make salvage-on-timeout opt-in per chain or per provider (default-off preserves v0.1 semantics), (b) extend `collectAllChunks` catch matching to a broader code set, (c) add tests parallel to the D16 Case A/Case B/single-hop trio for the SPAWN_TIMEOUT path. Not a v0.1 issue.

- **Procedural mechanism:** CC 开发铁律 v1.6 § 10.x (Cold Audit). Diff-review reviewers on earlier passes focused on the first-chunk rule for the real-streaming path; the buffered path has its own truncation-vs-fallback decision point, which the cold-audit pass on 2026-05-23 identified as Finding 17.

### Amendment 2 — 2026-05-24: Soft triggers deferred to v1.x (D22)

- **Finding:** Cold-audit round-2 Finding 2 (P2 — feature surface implemented but data ingestion not wired). The § Trigger taxonomy in the Decision section below lists soft triggers as a live, configurable feature category. However, `evaluateSoftTriggers` in `lib/fallback/engine.mjs` is inert at v0.1 because: (a) `buildDefaultChain` hardcodes `quotaSnapshot: null` on every hop; (b) no call site for `provider.quotaStatus()` exists in production code paths (`server.mjs` or `lib/fallback/engine.mjs`); (c) `evaluateSoftTriggers` correctly short-circuits to `false` when `quotaSnapshot == null`. A user populating `routing.soft_triggers` in `~/.olp/config.json` gets zero runtime effect at v0.1.

- **Decision:** Defer soft triggers to v1.x — re-classify them alongside Deterministic-deferred and Cost-aware-deferred in the trigger taxonomy. The evaluation code (`evaluateSoftTriggers` in `lib/fallback/engine.mjs`) stays in place: it is small, well-tested via unit tests that inject quota snapshots directly, and architecturally correct. v1.x reactivation requires only wiring the data ingestion path, not rewriting the evaluation logic. Configured `routing.soft_triggers` thresholds in `~/.olp/config.json` have no runtime effect at v0.1 and are silently ignored.

- **Rationale:** At v0.1, wiring `quotaStatus()` polling requires: per-hop async I/O before each spawn decision, error handling for providers that do not implement the optional `quotaStatus()` method, a caching layer to avoid re-polling on every request, and a latency budget for a pre-spawn network call. No current provider has a reliable quota endpoint (`claude -p` does not expose quota; `codex exec --json` does not; `vibe --prompt` does not). Implementation cost is high; value at v0.1 is zero. The inert-but-correct state is the conservative call.

- **Effect on § Trigger taxonomy:** The soft triggers entry in the table below is updated to mark soft triggers as deferred to v1.x, alongside Deterministic-deferred and Cost-aware-deferred. The architectural text describing the soft trigger design (the three threshold types) is retained — it remains the correct v1.x design — with an inline deferral note appended.

- **What v1.x reactivation looks like:** A single ADR amendment + three code changes: (a) wire `await provider.quotaStatus(authContext)` in `buildDefaultChain` or per-hop in `executeWithFallback`, (b) populate `chainHop.quotaSnapshot` from the polling result, (c) add integration tests verifying the production path produces non-null snapshots that drive evaluation. The `evaluateSoftTriggers` function in `engine.mjs` does not change.

- **Procedural mechanism:** CC 开发铁律 v1.6 § 10.x (Round-2 Cold Audit). Diff-review reviewers on D5/D9 focused on evaluation correctness; nobody traced the production data path end-to-end to verify `quotaSnapshot` was ever populated. Round-2 cold audit caught it.

## Context

A multi-provider proxy is only valuable if it fails over gracefully. Per spec §1, OLP's core value proposition is "your IDEs and family clients keep working as long as *any* of your subscriptions has quota left." If Anthropic returns 529 (overloaded), or OpenAI returns 429 with `insufficient_quota`, or `claude -p` exits non-zero, the client should not see an error; the client should see the next provider in the chain transparently take over.

Naive fallback is dangerous. The most-natural-looking implementation — "any error, retry next provider" — is catastrophic for any request with side effects. Consider a `/v1/chat/completions` request whose first response chunk contained `{"role": "assistant", "tool_calls": [{"name": "write_file", "arguments": "..."}]}`, and the client's agent loop has already begun executing that tool call when the SSE stream breaks. If OLP retries against the next provider, the second provider's response may contain a *different* tool call — and now the client agent has executed two different write_file operations from what looks to them like one request. This is exactly the "duplicate write" failure mode that makes naive retry a foot-gun in any HTTP system with non-idempotent operations.

The structural answer is **fallback only on idempotent failures**: if the response has not started streaming back to the client, fallback is safe. If the response has started, the request is not retried — the client sees the truncation and decides what to do (an IDE agent loop typically has its own retry logic with awareness of partial state; OLP cannot reason about that).

The second axis of fallback design is **trigger taxonomy**. Not every provider response is a fallback signal. Anthropic 401 (auth failure) is a fallback signal only if it persistently fails — otherwise it's a configuration problem the user needs to fix, not a quota problem the proxy should hide. Anthropic 429 with no body might be a transient burst limit; OpenAI 429 with `insufficient_quota` is a hard out-of-credit signal. The fallback engine has to distinguish these.

The third axis is **chain advancement**. Spec §4.3 calls for one-provider-at-a-time advancement: if the chain is `[anthropic, openai, mistral]` and Anthropic fails, advance to OpenAI; if OpenAI also fails, advance to Mistral; if Mistral also fails, return the *original* error (not Mistral's, not the cascade) with `X-OLP-Fallback-Exhausted` listing tried providers. This preserves the client's ability to debug — the first failure is the load-bearing signal, not the last one.

The fourth axis is **observability**. Every fallback hop must be loggable and counted. `X-OLP-Fallback-Hops: 0` on a successful primary serve; `X-OLP-Fallback-Hops: 1` on first-fallback success; `X-OLP-Provider-Used: openai` so the client knows which subscription consumed the quota. These headers are user-facing instrumentation, not internal-debug; they are spec'd in §4.7.

## Decision

Per spec §4.3, the OLP fallback engine implements the following:

**Trigger taxonomy.**

- **Hard triggers (mandatory, non-configurable).**
  - HTTP 5xx from provider's underlying API (after spawned CLI surfaces them)
  - HTTP 4xx that semantically indicate quota exhaustion (Anthropic 529 overloaded, OpenAI 429 with `insufficient_quota` body, Anthropic post-2026-06-15 credit-pool-exhausted indicator if a body discriminator exists)
  - Provider CLI exit code ≠ 0 with no usable response chunks streamed
  - Provider CLI spawn timeout (configurable per-provider via `hints.maxSpawnTimeMs`)

- **Soft triggers (configurable per chain).**
  - `credit_pool_percent_threshold` — fall back before hitting Anthropic's 100% Agent SDK Credit consumption, e.g., at 90% (per spec §4.3 example config)
  - `daily_request_count_threshold` — fall back after N requests on the primary today
  - `five_hour_window_percent_threshold` — fall back based on rolling 5h window quota usage
  - Soft triggers are evaluated *before* spawn. If a soft trigger fires for the primary, the proxy advances to the next chain entry without attempting the primary at all.
  - **📋 Deferred to v1.x (Amendment 2)** — evaluation surface is implemented in `lib/fallback/engine.mjs#evaluateSoftTriggers` and unit-tested, but the production data ingestion path (`quotaStatus()` polling per hop) is deferred to v1.x. Configured `routing.soft_triggers` thresholds in `~/.olp/config.json` have no runtime effect at v0.1.

- **Deterministic triggers (deferred to v1.x).** Time-of-day routing, request-content routing ("code requests prefer Codex"). Out of scope for v0.1; tracked in spec §8 future work.

- **Cost-aware triggers (deferred to v1.x).** Per spec §4.3 + §8, fully cost-aware automatic fallback is deferred until provider cost-reporting is reliably retrievable. v0.1 ships without this.

**Fallback safety — first-chunk rule.** A request is eligible for fallback **only** if no response chunk has been emitted to the client. Specifically:

```js
if (responseChunksEmitted === 0 && triggerMatches(error)) {
  advanceChainAndRetry();
} else {
  surfaceErrorToClient();  // client sees truncation; client decides
}
```

This is non-negotiable for v1.0. Post-first-chunk truncations are surfaced to the client with the same error semantics OpenAI uses for streaming interruptions. Tool-using clients (agent loops) typically have their own handling for partial responses; OLP cannot second-guess that handling.

**Chain advancement — one at a time.** Given a chain `[A, B, C]`:
1. Try A. If A succeeds, return; emit `X-OLP-Fallback-Hops: 0`, `X-OLP-Provider-Used: A`.
2. If A's failure matches a hard or soft trigger AND no chunks emitted: try B. If B succeeds, return; emit `X-OLP-Fallback-Hops: 1`, `X-OLP-Provider-Used: B`.
3. If B also fails: try C. Same logic.
4. If all of A, B, C fail: return **A's original error** (not B's, not C's) with `X-OLP-Fallback-Exhausted: A,B,C` listing the chain order, and per-provider failure detail in a debug header `X-OLP-Fallback-Detail` (JSON, ungated at v0.1 per Amendment 5 / D40, issue #7; owner-vs-non-owner gating planned for Phase 2 when `lib/keys.mjs` lands). The header is also emitted on success-with-prior-failure paths (e.g., A fails + B succeeds → response carries the 1-tuple failure trail for A). See § Observability headers below for the tuple schema and cap behaviour.

**Observability headers (per spec §4.7).**
- `X-OLP-Provider-Used: <provider-name>`
- `X-OLP-Model-Used: <provider-native-model-id>`
- `X-OLP-Fallback-Hops: <integer ≥ 0>`
- `X-OLP-Cache: hit | miss | bypass`
- `X-OLP-Latency-Ms: <integer>`
- `X-OLP-Fallback-Exhausted: <comma-separated provider list>` — emitted only when multiple providers were tried (D18; chain-exhaustion path).
- `X-OLP-Fallback-Detail: <JSON array>` — **shipped as IMPLEMENTED at v0.1, ungated** per Amendment 5 (D40, issue #7). Emitted on any response where at least one prior hop failed before the chain resolved or exhausted; absent on clean primary success.
  - **Tuple schema (per failed hop):** `{ hop: <0-indexed integer>, provider: <string>, model: <string>, code: <ProviderError.code or 'UNKNOWN'>, error_message: <string truncated to 200 chars with U+2026 ellipsis on truncation>, trigger_type: 'hard' | 'soft' | 'auth_missing' | 'client_error' | 'non_trigger' }`. Field shapes reuse D28's per-hop log event keys.
  - **4KB UTF-8 byte cap:** if the JSON-stringified array exceeds 4096 bytes, tail tuples are dropped and a `{ truncated: true, omitted_hops: <count> }` sentinel is appended so the total fits under the cap.
  - **RFC 7230 hygiene:** all non-ASCII code points are escaped as `\uXXXX` so the header value is pure ASCII (Node's HTTP header validator rejects multi-byte UTF-8). `JSON.parse` still round-trips the escaped form to the original Unicode.
  - **Phase 2 follow-up:** owner-vs-non-owner gating is planned for when `lib/keys.mjs` lands. Until then, the header is informational on every response. See Amendment 5 for the full rationale and the gating re-introduction trigger.

Each fallback hop emits a structured log event with: timestamp, chain id, hop index, failed provider, trigger type, IR request hash, downstream provider that was tried next.

**No fallback for client-side errors.** HTTP 400, 401 (auth misconfigured), 403, 404, 422 from a provider are *not* fallback triggers. They indicate the request itself is malformed or the user's auth is wrong, and silently masking that by trying the next provider would prevent the user from ever discovering the misconfiguration. These errors are surfaced to the client immediately with provider attribution.

## Consequences

**Positive**
- The first-chunk rule eliminates the duplicate-side-effect failure mode at the architectural level. There is no configuration knob, no per-provider override, no "we'll try to be smart about it" — the rule is binary and the safety guarantee is binary.
- The trigger taxonomy is enumerated and bounded. A reviewer reading a PR that proposes a new trigger has a clean checkpoint: "is this hard, soft, deterministic, or cost-aware? cite the spec §4.3 category." Triggers outside the four categories require an ADR amendment.
- Chain advancement returning the *original* error (not the cascade) makes debugging tractable. The user sees what their primary provider said, not a confusing tail-end "Mistral failed" message that obscures the actual problem.
- Observability headers are surface-level. Clients (and the maintainer running `curl -i`) can immediately see which provider served a request and whether fallback fired, without enabling debug logging.

**Negative**
- Some failures *don't* fall back. Post-first-chunk truncations surface to the client as truncations. This is the correct behavior, but it means OLP cannot achieve "literally never fails as long as one provider is alive" — clients still see truncations when a provider dies mid-response. This is a property of the safety guarantee, not a bug.
- The credit-pool-percent-threshold soft trigger requires per-provider quota retrievability. Per spec §4.2, `quotaStatus` may return null if a provider doesn't expose it. Soft triggers gracefully degrade (treat null as "don't fire") but the value proposition is weaker for providers without retrievable quota.
- The trigger configuration is per-chain, not global. A user with three chains has three places to tune thresholds. The dashboard surface (spec §4.6) makes this navigable; raw `config.json` editing is the source of truth.

**Mitigations**
- The first-chunk rule applies at the byte level (any data written to the response stream blocks fallback), not at the semantic level (where it would require parsing). Implementation is a single boolean flag tracking whether anything has been written; the rule is auditable in a few lines of code.
- Provider plugins that cannot retrieve quota (`quotaStatus` returns null) are documented in their plugin header and in `docs/provider-caveats.md` (📋 planned — not yet authored; until it exists, this information lives in the plugin header comment). Soft triggers configured against such providers issue a startup warning so the user knows the trigger will never fire.
- The deferred trigger types (deterministic, cost-aware) are tracked in spec §8 with explicit Q-tags. Adding them later is an ADR amendment plus a contract addition to the trigger taxonomy, not a redesign.

## Alternatives considered

**(a) Full retry-on-any-error.** Any non-2xx response triggers fallback. Rejected: this is the duplicate-side-effect foot-gun, and it also masks client-side errors (a malformed request would silently parade through every provider in the chain before being surfaced). The safety guarantee OLP is making would be impossible to make.

**(b) No fallback at all — pure routing only.** OLP picks one provider per request based on chain config but does not retry on failure. Rejected: this defeats the spec §1 value proposition. The whole reason for OLP's existence is "as long as *any* subscription has quota left, things work." No-fallback gives the user a manually-coordinated multi-provider setup, which they could have built with environment-variable swapping in their IDE.

**(c) Semantic retry — try to detect when retry is safe.** Inspect the in-flight request, the partial response, and the failure mode; if the partial response is reasoning-only (no tool calls emitted yet), retry; if tool calls have been emitted, do not retry. Rejected for v1.0 as too ambitious. Distinguishing "safe to retry" requires parsing the partial IR response, identifying side-effecting tool calls (which means OLP has to know which tools are side-effecting — it cannot), and reasoning about idempotency at the application layer. v1.0 ships with the conservative first-chunk rule; semantic retry is a candidate for a future ADR if real failure modes justify the complexity.

**(d) Retry-after-N-seconds before fallback.** When a provider transiently fails (e.g., Anthropic 529), wait N seconds and retry the same provider before advancing the chain. Rejected as a separate concern from this ADR. Per-provider retry-with-backoff before chain advancement is a useful refinement, but it's an enhancement to the "try A" step of chain advancement, not a change to the chain advancement rules. Tracked as future work; v1.0 has a single attempt per chain hop.

**(e) Parallel fan-out — issue requests to all providers in the chain simultaneously, race them.** Rejected: this consumes quota on all providers regardless of which one's response is used, which directly violates the spec §1 value proposition (minimize quota consumption). Quota is the constraint OLP exists to manage; spending it speculatively is the wrong shape.

## Sources

- OLP v0.1 spec §4.3 (Fallback engine, including trigger types, fallback safety, example config)
- OLP v0.1 spec §4.7 (Observability — response headers)
- OLP v0.1 spec §8 Q-B, Q-E (Open questions about provider-specific quota and rate-limit-window awareness)
- OCP architecture context (`~/ocp/server.mjs` does no fallback — it forwards to one Anthropic endpoint; the absence of fallback handling in OCP is informative about what greenfield design OLP needs)

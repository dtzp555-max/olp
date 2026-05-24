# ADR 0004 — Fallback Engine Semantics and Safety

- **Date:** 2026-05-23
- **Status:** Accepted (bootstrap)
- **Authors:** project maintainer (with AI drafting assistance)
- **Related:** OLP v0.1 spec §4.3; ADR 0001 (project founding — fallback is OLP's core value proposition); ADR 0002 (plugin architecture); ADR 0003 (IR — fallback replays IR across chain hops)

## Amendments

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

- **Procedural mechanism:** CC 开发铁律 v1.6 § 10.x (Cold Audit). Diff-review reviewers on earlier passes focused on the first-chunk rule for the real-streaming path; the buffered path has its own truncation-vs-fallback decision point, which the cold-audit pass on 2026-05-23 identified as Finding 17.

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
4. If all of A, B, C fail: return **A's original error** (not B's, not C's) with `X-OLP-Fallback-Exhausted: A,B,C` listing the chain order, and per-provider failure detail in a debug header `X-OLP-Fallback-Detail` (JSON, owner-only — gated behind a config flag for non-owner keys).

**Observability headers (per spec §4.7).**
- `X-OLP-Provider-Used: <provider-name>`
- `X-OLP-Model-Used: <provider-native-model-id>`
- `X-OLP-Fallback-Hops: <integer ≥ 0>`
- `X-OLP-Cache: hit | miss | bypass`
- `X-OLP-Latency-Ms: <integer>`

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

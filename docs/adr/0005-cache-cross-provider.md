# ADR 0005 — Cache Layer Cross-Provider Design

- **Date:** 2026-05-23
- **Status:** Accepted (bootstrap)
- **Authors:** project maintainer (with AI drafting assistance)
- **Related:** OLP v0.1 spec §4.4; ADR 0002 (plugin architecture); ADR 0003 (IR — cache keys are computed over IR shape); ADR 0004 (fallback — cross-provider cache misses are correct on fallback)

## Amendments

### Amendment 4 — 2026-05-24: Clarify D2 cache_control detection surface (F10)

- **Finding:** Round-3 cold-audit F10 (P3 detection-surface drift) — § D2 reads as if detection happens on the IR ("If THE IR REQUEST contains Anthropic cache_control markers AND..."), but `openai-to-ir.mjs` strips `cache_control` markers from messages per ADR 0003's whitelist policy. Actual v1.0 detection happens on the raw OpenAI request body at the entry surface in `server.mjs`.
- **Clarification:** At v1.0, `cache_control` marker detection for the D2 bypass uses the raw OpenAI request body's `messages` array, NOT the IR. This is because the IR (per ADR 0003) does not carry `cache_control` as a field — markers are an OpenAI-vendor-specific request annotation that the IR consciously does not surface. The bypass logic in `server.mjs`'s `executeHopFn` correctly consults `body.messages` directly via `extractCacheControlMarkers(body?.messages ?? [])`.
- **Cache key implication:** The cache key's `cache_control` slot (added by D15 Amendment 2) is structurally always `null` at v1.0 because it is computed via `extractCacheControlMarkers(ir.messages)` which always returns `[]`. This is forward-compatible: if a future ADR 0003 amendment adds `cache_control` to the IR field set, the slot will start carrying meaningful data without a cache-key schema change. The slot stays as documented; no v1.0 cache-key revision needed.
- **No code change:** F10 is a docs-only clarification. The bypass behavior is correct; the cache key slot's nullness is intentional given v1.0 IR design.
- **Procedural mechanism:** CC 开发铁律 v1.6 § 10.x (Round-3 Cold Audit).

### Amendment 5 — 2026-05-24: Acknowledge claude -p --output-format text wire limitation for D2 (D31 F11)

- **Finding:** Round-3 cold-audit F11 (P3 ADR-claim vs implementation drift) — § D2 promises "Anthropic's own prompt cache is consulted at the provider" as part of the bypass rationale, but this is structurally impossible at v0.1. The Anthropic plugin uses `claude -p --output-format text`, a plain-text wire surface that has no Messages-API field for `cache_control` markers. The markers are also stripped at IR construction (`openai-to-ir.mjs` whitelists fields and drops `cache_control`) per the ADR 0003 IR whitelist policy documented in Amendment 4 (D27 F10).
- **Clarification:** § D2's actual effect at v0.1 is OLP-cache-bypass only — when the request contains Anthropic `cache_control` markers AND the active hop is Anthropic, OLP does NOT write to its response cache, leaving the request to spawn fresh. The "Anthropic's own prompt cache is consulted at the provider" delegation half is NOT live at v0.1 because the wire surface (`claude -p --output-format text`) does not carry `cache_control` markers to the Anthropic backend. The OLP-cache-bypass half IS correct and working.
- **Forward path (deferred to v1.x):** For full delegation (actually forwarding `cache_control` markers to Anthropic's prompt-cache infrastructure), the Anthropic plugin would need to switch from `claude -p --output-format text` to either `--output-format json` (NDJSON wire with structured event envelopes that could carry `cache_control` in the request construction) or a direct Anthropic Messages API spawn. Both options are substantial parser rewrites. No user has reported needing the delegation behavior at v0.1; the OLP-cache-bypass half (no double-caching) is the practically valuable behavior.
- **No code change:** F11 is a docs-only clarification. The bypass behavior is correct; the wire limitation is an honest-spec acknowledgment. An inline reference to this amendment is added to § D2 below.
- **Procedural mechanism:** CC 开发铁律 v1.6 § 10.x (Round-3 Cold Audit caught it as F11).

### Amendment 3 — 2026-05-24: Implement § "Cache write conditions" items 3 and 4 (D23)

- **Finding:** Cold-audit round-2 Finding 3 (P2 cache-condition drift) — § "Cache write conditions" items 3 and 4 were documented in this ADR but never wired in code. Zero matches for `cacheable` / `10485760` / any size-cap pattern in `lib/` or `server.mjs`. The invariants existed only in prose.
- **Change:** D23 implements both items:
  - **Item 3 — `hints.cacheable`:** Checked in `executeHopFn` (`server.mjs`) before calling `cacheStore.getOrCompute`. If `hopProviderPlugin.hints?.cacheable === false`, the hop calls `collectAllChunks()` directly and returns without touching the cache. A `cache_opted_out` debug event is logged. The `cacheable` field is added to the Provider contract hints in ADR 0002 Amendment 3 (same D23 co-merge).
  - **Item 4 — size cap:** Enforced inside `cacheStore.set()` (`lib/cache/store.mjs`). The `CacheStore` constructor accepts `maxEntryBytes` (default `10 * 1024 * 1024` = 10,485,760 bytes). On each `set()` call, `Buffer.byteLength(JSON.stringify(value))` is computed; if the result exceeds `maxEntryBytes`, the entry is not persisted. A `cache_skip_oversize` warn event is logged with `{ byteLength, maxEntryBytes, keyId, cacheKey }`. `getOrCompute` applies the same check: after `computeFn()` returns, the size check runs before writing to the cache; the value is still returned to the caller (data is never dropped, only caching is skipped).
- **Enforcement placement decision:** The `cacheable` opt-out is enforced at `executeHopFn` (`server.mjs`) rather than inside `CacheStore` because: (a) `CacheStore` is a generic store with no awareness of the Provider contract; injecting provider-plugin knowledge into the store layer would violate the boundary defined by ADR 0002 § "Boundary with `server.mjs`"; (b) the opt-out is a routing-level policy ("don't use the cache for this provider") — the natural enforcement point is the caller that knows both the provider plugin and the cache store.
- **Size-cap vs. D16 truncation-eviction interaction:** No interaction. D16's truncation eviction calls `cacheStore.set(keyId, key, result, 0)` (TTL=0) to expire a truncated entry that was already written. The D23 size check is evaluated on every `set()` call, including D16's eviction-by-overwrite. However, a truncated entry is almost always small (it's the partial chunks from a failed spawn, not a large complete response), so the size cap never fires on D16's eviction path in practice. If it did, the overwrite would be silently skipped (entry stays at its prior TTL), which is strictly better than persisting the truncated data — so the interaction is harmless.
- **Procedural mechanism:** CC 开发铁律 v1.6 § 10.x (Round-2 Cold Audit caught it as Finding 3).

### Amendment 2 — 2026-05-24: Expand cache key composition to include `max_tokens`, `top_p`, `stop`, `tool_choice` (D15)

- **Finding:** Cold-audit Finding 7 (P2 cache correctness) — the v1.0 cache key composition listed in § "Cache key composition (v1.0)" omitted four IR fields that materially affect model output: `max_tokens` (output length truncation), `top_p` (sampling distribution), `stop` (stop sequences that terminate generation), and `tool_choice` (`'auto' | 'none' | 'required' | {type, function:{name}}` — fundamentally changes whether/which tool the model calls). Two requests identical except for one of these four fields produce different model outputs but collided on the same cache key under v1.0. Consequence: a request with `max_tokens: 100` could receive a cached response originally generated by a `max_tokens: 4000` request — wrong content (truncated or unexpectedly extended).
- **Change:** Expand cache key composition to include `max_tokens`, `top_p`, `stop`, and `tool_choice` in addition to the existing seven fields. The four new fields are appended after the existing set so that the ordering of existing fields is stable (pre-D15 cache entries are invalidated on first request — a forced miss — but the schema is forward-compatible). Field serialization follows the existing `?? null` null-coalescing pattern: a request with `max_tokens: undefined` serializes as `null` and is treated as equivalent to an absent field; `max_tokens: 100` serializes as `100`. This is consistent with how `temperature` and `response_format` are handled.
- **Rationale:** ADR 0005's own stated invariant — "different output → different cache entry" — requires that any IR field affecting output be included in the cache key. The original v1.0 key composition was correct for the seven named fields but provided incomplete coverage of ADR 0003's IR field set. The four omitted fields are all defined in ADR 0003 § Optional fields and are all sourced directly from the OpenAI `/v1/chat/completions` spec parameters that affect generation.
- **Forward-looking note:** Future IR field additions (e.g., `seed`, `frequency_penalty`, `presence_penalty`, `logit_bias`, `logprobs`, `n`) must be evaluated for cache-key inclusion at the time they are added to the IR. The default is to **include** the field in the cache key unless an explicit rationale documents why omitting it is safe (e.g., the field has no effect on the provider's output for any value, or it is a purely client-side metadata field). This evaluation must appear in the amending ADR per ALIGNMENT.md Rule 2(c) spirit.
- **Note on null-coalescing collisions:** The `?? null` serialization pattern treats `field: undefined`, `field: null`, and `field: []` (for array fields such as `tools`) as equivalent cache keys. This is intentional — semantically these all mean "field absent or empty." In practice, `tools: []` (explicit empty array) and `tools` omitted (undefined) both mean "no tools available" and produce identical model output, so they correctly share a cache entry. If a future provider distinguishes empty-array from absent (e.g., `tools: []` explicitly meaning "tools disabled" vs `tools` omitted meaning "tools not specified"), the serialization for that field must be revisited and this amendment will need revision.
- **Procedural mechanism:** CC 开发铁律 v1.6 § 10.x (Cold Audit caught it). This follows the calibration-loop precedent established by D11 / Amendment 1 of ADR 0002: the diff-review pass that approved the original ADR 0005 did not cross-reference all ADR 0003 optional fields; the cold-audit pass on 2026-05-23 caught the gap as Finding 7.

## Context

OCP shipped a four-layer cache hardening (D1+D2+D3+D4) in v3.13.0 (2026-05-07 per the MEMORY.md entry). The four layers:
- **D1 — per-key isolation:** each OCP API key has its own cache namespace, so one user's cache doesn't leak to another's.
- **D2 — `cache_control` bypass:** Anthropic prompt-caching markers in the request bypass OLP's response cache (the prompt cache lives at Anthropic's side; double-caching would shadow Anthropic's TTLs).
- **D3 — chunked stream replay:** SSE streams are replayed from cache without re-spawning the CLI, preserving the chunking pattern the client expects.
- **D4 — singleflight:** concurrent identical requests share one spawn; all callers receive the same response.

All four are valuable in OLP. None of the four translate directly because OCP's cache key was Anthropic-specific in composition:

```
ocp_cache_key = sha256({ messages, tools, temperature, response_format, cache_control })
```

OCP never had a `provider` field in the key because there was only one provider. OLP serves multiple providers, and multiple models per provider. A cache hit between `anthropic/claude-sonnet-4-6` and `openai/gpt-5-codex` would be catastrophic: identical prompts produce *different* outputs on different models, and even on the same model from different providers the response style and tool-calling conventions diverge enough that a cross-provider cache hit is just a wrong answer wearing a correct cache key.

The simple fix is to include `provider` and `model` in the cache key. That's structurally correct but has a non-obvious consequence: when a fallback chain advances from `anthropic/sonnet` to `openai/codex`, the cache lookup against the new provider misses — even if the *prompt* is identical to a previous successful Anthropic serve. This is the right behavior (different model = different output = different cache entry), but it's worth naming explicitly so future readers don't try to "fix" the cache to share entries across providers.

A second design point: OLP's cache key is computed over the **IR** (per ADR 0003), not over the raw OpenAI request shape. This matters because OpenAI shape evolves (new fields, deprecated fields) and we don't want every entry-surface change to invalidate every cache entry. IR is OLP-owned and changes only via amendment ADR, so cache-key stability is governed by OLP's own release cadence, not OpenAI's.

The third design point: `cache_control` (D2) is Anthropic-specific in v1.0. Other providers may grow their own prompt-cache markers over time (OpenAI has prompt caching but the marker semantics differ; Mistral has none as of 2026-05). Per spec §4.4, OLP honors Anthropic `cache_control` markers as bypass signals when the routing target is Anthropic; for non-Anthropic targets, the bypass markers are noop'd (logged once per request at debug level so users can see they were ignored). Future providers' prompt-cache markers extend the bypass logic per-provider; the bypass mechanism is provider-pluggable, not Anthropic-specific.

## Decision

Per spec §4.4, OLP's cache layer:

**Cache key composition (v1.0).** (amended 2026-05-24, see Amendment 2)
```
key = sha256(JSON.stringify({
  provider,           // e.g., 'anthropic', 'openai', 'mistral'
  model,              // the actual model that served the request (provider-native form)
  messages,           // IR messages[] — normalized form, not OpenAI raw
  tools,              // IR tools[] if present, null otherwise
  temperature,        // included if non-default
  response_format,    // included if present
  cache_control,      // Anthropic prompt-caching markers (the markers themselves; the bypass logic is separate)
  // Added by Amendment 2 (D15) — fields from ADR 0003 § Optional fields that affect output:
  max_tokens,         // output length truncation; null if absent
  top_p,              // sampling distribution; null if absent
  stop,               // stop sequences; null if absent
  tool_choice,        // 'auto' | 'none' | 'required' | {type, function:{name}}; null if absent
}))
```

**Per-model isolation.** Cache entries are keyed on `(provider, model)` pair. `anthropic/claude-sonnet-4-6` and `openai/gpt-5-codex` produce distinct cache entries for identical IR messages. There is no cross-model cache sharing in v1.0; this is intentional and correct.

**D1 — per-key isolation (ported from OCP v3.13.0).** Each OLP API key has an independent cache namespace. Designed file-backed layout (target for Phase 2 storage adapter):
```
~/.olp/cache/<olp-key-id>/<hash-prefix>/<hash>.json
```
The `<olp-key-id>` segment ensures per-key isolation; the `<hash-prefix>` is the first two hex chars of the key for filesystem-fanout sanity at high cache counts.

> **Implementation note (as of 2026-05-24):** The v0.1 implementation in `lib/cache/store.mjs` uses an in-memory `Map` as the backing store — no files are written to `~/.olp/cache/`. The file-backed layout described above is the designed shape; it transitions in via a Phase 2 storage adapter. Per-key isolation and singleflight (D4) are live; file persistence is not.

**D2 — `cache_control` bypass (ported, scope-expanded).** If the IR request contains Anthropic `cache_control` markers AND the active provider in the current chain hop is Anthropic, the OLP response cache is bypassed (Anthropic's own prompt cache is consulted at the provider). *(Wire-limitation note: at v0.1 the "Anthropic's own prompt cache is consulted at the provider" half is not live — the Anthropic plugin's `claude -p --output-format text` wire surface does not carry `cache_control` markers to the provider backend; the effective behavior is OLP-cache-bypass only. See Amendment 5 (D31 F11) for the full clarification and forward path.)* If the active provider is not Anthropic, the `cache_control` markers are stripped from the IR before provider translation (so they don't get passed to providers that wouldn't understand them) and a debug log entry is emitted. Future provider-specific bypass markers extend this rule by adding their own provider-conditional bypass logic.

**D3 — chunked stream replay (ported).** When a cache hit occurs on a `stream: true` request, the cached response is replayed as SSE chunks with the same chunking granularity as the original spawn. This requires storing the chunk boundaries (not just the concatenated content) in the cache entry. Cache entry format includes a `chunks[]` array, each with `delta` and `timestamp` relative to spawn start; replay throttles to the original timing pattern (configurable: real-time replay vs. burst-replay; default burst-replay because real-time replay adds latency without value for cached requests).

**D4 — singleflight (ported).** Concurrent requests with identical cache keys share one spawn. The first request triggers the spawn; subsequent identical requests block on a per-key promise until the first completes, then all read the same response. Per the OCP MEMORY.md learning (`learnings/concurrency_dedup_test_signals.md`), singleflight is verified by observing that N concurrent requests return within milliseconds of each other when the cache key matches.

**Cross-provider fallback cache behavior (new for OLP).** When a request falls back from `anthropic/sonnet` to `openai/codex`, the cache lookup against the new `(openai, codex)` key likely misses. This is correct: even if Anthropic had served the same prompt successfully yesterday, the codex response is a different output and warrants its own cache entry. There is no "cache hit on any provider's prior serve" mode; that would defeat the per-model isolation invariant.

**Cache write conditions.** A response is cached if and only if:
1. The response completed successfully (no truncation, no error mid-stream).
2. The request did not include `cache_control` bypass markers for the active provider.
3. The provider's `hints.cacheable` flag is not `false` (a provider plugin can opt out of caching entirely for, e.g., real-time use cases — none do in v1.0).
4. The response is below a size cap (default 10 MB; configurable). Cache is for hot-path repeat requests, not bulk archive.

## Consequences

**Positive**
- Cross-model contamination is impossible. The `(provider, model)` prefix on every cache key means `claude/sonnet` and `codex/gpt-5` cannot collide even on identical prompts. The cache invariant is auditable in one line of code.
- All four OCP cache hardening layers (D1+D2+D3+D4) port to OLP, preserving the operational properties OCP achieved in v3.13.0. The OCP MEMORY.md learnings about cache-related pitfalls (e.g., not hashing the randomUUID-included full JSON; using content-only sha256) carry over.
- Fallback to a different provider correctly misses cache. The user's quota is consumed on the new provider, but the new provider's response is now cached for future identical requests on the new (provider, model) pair.
- IR-based cache keys (per ADR 0003) decouple cache stability from OpenAI's entry-surface evolution. A new OpenAI field that doesn't change semantics (e.g., a cosmetic field rename) does not invalidate existing cache entries.

**Negative**
- Cache hit rate is lower than OCP's single-provider rate by construction. Per-model isolation means the cache is partitioned N-ways across N (provider, model) pairs. For the maintainer's typical usage (~70% claude, ~25% codex, ~5% other), the most-used pair retains high hit rate; less-used pairs have effectively cold caches. This is the right behavior, not a bug.
- The D3 chunked-replay format adds complexity to cache entries (storing chunk boundaries, not just concatenated content). Cache entries are larger than they would be with naive content storage. Disk usage scales with chunks count; for typical claude responses this is modest, but it is real.
- `cache_control` markers being silently stripped for non-Anthropic providers is a subtle behavior. Users who configure aggressive Anthropic prompt caching and then fall over to OpenAI will get full-cost OpenAI responses without prompt caching, even on prompts they marked as cacheable. The debug log entry mitigates surprise; the README's caveats section names this explicitly.

**Mitigations**
- Cache hit rate is monitored via `/cache/stats` (per spec §4.6), broken down by `(provider, model)` pair. Low hit rates on specific pairs are visible to the maintainer and can inform chain configuration (e.g., "this pair has 2% hit rate; is it worth being in this chain?").
- Cache entry size cap (default 10 MB) prevents pathological growth from the chunked-replay format. Sizes above cap are not cached; logged once.
- The non-Anthropic-provider behavior for `cache_control` markers is tested in `test-features.mjs` to verify the bypass is correctly noop'd, the markers are stripped before provider translation, and the debug log is emitted. The marker-strip behavior is the structural counter-measure against accidentally passing Anthropic-specific markers to providers that wouldn't understand them.

## Alternatives considered

**(a) Model-agnostic caching (cache key includes provider but not model).** A cache hit on `anthropic/claude-sonnet-4-6` for a prompt could serve a request for `anthropic/claude-opus-4-7` if the prompt is identical. Rejected: this is cross-model contamination, and the outputs are simply different. The cache becomes a source of wrong answers.

**(b) Cache disable on fallback paths.** Skip cache lookup entirely for any request that's reached fallback hop ≥ 1. Rejected: this would mean every fallback serve is a fresh spawn even if the new provider has served the same prompt before. Per-model isolation already gives the right behavior here (the fallback hop's cache lookup is against the new (provider, model) and is a miss only if that pair hasn't served before).

**(c) Cross-provider canonicalization — cache a "model-tier" key (e.g., 'sonnet-equivalent') rather than (provider, model).** Anthropic/sonnet, openai/codex, and mistral/devstral could all share a cache entry tagged "sonnet-equivalent". Rejected on two grounds: (1) cross-model output equivalence is false — the outputs *differ*, even if the inputs are equivalent; (2) defining "sonnet-equivalent" is a capability-routing problem (spec §1 non-mission explicitly excludes capability routing). The cache should reflect real outputs, not assumed equivalence classes.

**(d) Don't port D3 (chunked stream replay) — replay cache hits as a single chunk.** Simplifies cache entries; loses the chunking-pattern fidelity OCP achieved in v3.13.0. Rejected: some clients (notably OpenClaw and Continue) make UX decisions based on chunking pattern (e.g., "is this thinking, or is this output?"); collapsing to a single chunk breaks those decisions even though the content is correct. D3's complexity earns its keep.

**(e) Defer caching to a future ADR — ship v1.0 without cache.** Rejected: the OCP cache layer is one of the most successful structural decisions in OCP's history, and the post-2026-06-15 cost picture makes caching *more* valuable, not less (every cache hit is a credit not consumed). Caching is in scope for v1.0.

## Sources

- OLP v0.1 spec §4.4 (Cache layer — inherited from OCP, generalized)
- OCP v3.13.0 release context — MEMORY.md entry 2026-05-07 (Mac → OCP v3.13.0 cache layer hardening shipped)
- OCP `learnings/concurrency_dedup_test_signals.md` — informs D4 (singleflight) test methodology
- OCP `keys.mjs` `cacheHash` / `getCachedResponse` / `setCachedResponse` / `clearCache` — the implementation OLP ports

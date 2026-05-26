# OLP v1.x Roadmap — Deferred Work Tracker

**Purpose.** Single landing page for every Phase-1 deferral that an actual v1.x sprint must pick up. Each entry cross-references its ratifying ADR, its GitHub issue (if any), and the load-bearing code anchor so a future maintainer can resume without spelunking the commit history.

**Status:** Living document. Add new entries at the top. Each item should answer:
1. **What** is deferred?
2. **Why** was it deferred (link the ratifying ADR amendment).
3. **Where** does the work live in the tree today (file + anchor).
4. **When** does it need to land (trigger: load profile, security event, governance amendment).

**Reading order for a v1.x sprint kickoff.** As of 2026-05-26, #1 (streaming SF, D57+D58), #2 (multi-key auth, Phase 2), #4 and #7 (closed in D56), and #8 (dashboard enrichment, D82 Phase 5) are CLOSED. Remaining v1.x scope: #3 (soft trigger reactivation), #5 (provider cacheKeyFields mask), #6 (streaming SPAWN_FAILED salvage — unbundled from #1 at #1 close). All three remaining items have explicit "trigger to start" gates that have not fired.

---

## #1 — Streaming-path singleflight + TOCTOU close — ✅ **SHIPPED (D57 + D58, 2026-05-25)**

- **Status.** Closed. Trigger (b) fired 2026-05-25 — maintainer "go" after v0.3.1. Shipped across three D-days:
  - **D57** (PR #36) — cache layer: `cacheStore.getOrComputeStreaming(keyId, cacheKey, sourceFactory, opts) → { stream, isFirst, role }` with `_streamingInflight` Map, tee fan-out, late-joiner replay buffer, per-client backpressure (`PER_CLIENT_QUEUE_CAP=1MB`), replay cap (`ACCUMULATED_REPLAY_CAP=10MB`), AbortController propagation, synchronous Map check+insert (closes TOCTOU). Suite 27 = 12 unit tests.
  - **D58** (PR #37) — server.mjs wiring: streaming branch swap; `tryAcquireSpawn`/`releaseSpawn` moved inside `sourceFactory` closure (D38 §7 coordination); `CONCURRENCY_LIMIT` fallthrough preserved; `X-OLP-Streaming-Inflight: source | attached` header; `cache_status: 'streaming_attached'` audit value + audit-query gauge reconciliation; `res.on('close') → stream.return()` for client disconnect; D16 truncated-not-cached invariant preserved via `cacheStore.delete` on stop-less exhaustion. Suite 28 = 8 HTTP integration tests.
  - **D59** (this commit) — docs polish: README known-limitations entry inverted; this roadmap entry closed; issue #16 closed.
- **Design authority.** [`docs/adr/0005-cache-cross-provider.md` Amendment 8](./adr/0005-cache-cross-provider.md) — implemented per spec §§1–14 across D57+D58.
- **Tracking issue.** GitHub issue [#16](https://github.com/dtzp555-max/olp/issues/16) — CLOSED at D59 with refs to D57+D58 PRs.
- **Final test count delta.** 603 (v0.3.1) → 623 (v0.3.2/v0.4.0). +20 tests across the SF arc.
- **Deferred sub-items** (left here as future-work pointers, NOT blocking #1 closure):
  - `X-OLP-Streaming-Inflight: solo` value not emitted on the wire (Amendment 8 §11). It's observable only post-stream via the `streaming_inflight_source_done` log event's `attached_count: 0`. Future ADR amendment may expose via HTTP trailer.
  - `streaming_inflight_join` log event from `_attachClient` cache-layer path (carries no provider/model context). D58 emits the event from the server-layer wrapper instead; cache-layer emission would need a provider/model plumb (TODO marker at `lib/cache/store.mjs:~620`).
  - `isFirst` field returned by `getOrComputeStreaming` is currently unused by server.mjs (`role` supersedes). Could be removed in a future cache-layer API cleanup.

## #2 — Multi-key auth (`lib/keys.mjs`) — **PHASE 2 ACTIVE (no longer deferred)**

- **Status.** Phase 2 active as of 2026-05-25. Design ratified at D43-B. This entry stays for cross-reference but is no longer a v1.x deferral; implementation D-days D44+ execute within Phase 2.
- **What.** Per-API-key identity, namespace scoping for the cache, ownership tier (owner vs guest) for header gating, and audit log of which key issued which request. Detailed scope in ADR 0007.
- **Design ADR (ratified).** [`docs/adr/0007-multi-key-auth.md`](./adr/0007-multi-key-auth.md) — Option 2 (filesystem manifest) + opaque token, with explicit forward path to Option 3 hybrid (SQLite-indexed mirror) when Phase 3+ Dashboard / SQL-aggregate quota work justifies. Migratable, manifest-as-SPOT.
- **Tracking.** Not a GitHub issue. Tracked here + via ADR 0007 acceptance criteria (§ 10) which drive the D44+ test surface.
- **Resolves.**
  - `X-OLP-Fallback-Detail` owner-only gating (D40 / ADR 0004 Amendment 5 — currently ungated; Phase 2 re-gates per ADR 0007 § 7).
  - `/health` per-key visibility (currently anonymous-only — owner / guest / anonymous tiers per ADR 0007 § 7).
- **Code anchors today (unchanged at ADR ratification; replaced by D44+ implementation).**
  - `lib/cache/store.mjs:77-79` per-keyId namespace Map — wire is in place.
  - `lib/cache/store.mjs:287` singleflight composition `${keyId}:${cacheKey}` — wire is in place.
  - `server.mjs:502, :531` — the two `keyId='__anonymous__'` call sites to replace.
  - `server.mjs:392` — `/health` handler entry (Phase 2 gate).
  - `server.mjs:1072, :1101` — `X-OLP-Fallback-Detail` header-write paths (Phase 2 gate).
- **Trigger (already fired).** Maintainer opened Phase 2 sprint 2026-05-25.

## #3 — Soft trigger reactivation (ADR 0004 Amendment 2)

- **What.** Per-provider `quotaStatus` polling, `softThreshold` comparisons, soft-skip advancement when quota approaches limit. Currently `evaluateSoftTriggers` always returns `false` because `quotaSnapshot` is never populated.
- **Why deferred.** v0.1 hard triggers (SPAWN_FAILED / CLI_NOT_FOUND / SPAWN_TIMEOUT / CONCURRENCY_LIMIT) are sufficient for fallback advancement at personal/family scale. Soft triggers require persistent quota snapshots and a polling mechanism, which adds operational surface (timer drift, snapshot staleness, observability burden).
- **Design ADR.** [`docs/adr/0004-fallback-engine.md` Amendment 2](./adr/0004-fallback-engine.md) — explicit v1.x deferral with mitigations (startup warning if user configures soft thresholds without runtime enforcement).
- **Tracking.** Not a GitHub issue. Tracked here + via the startup warning in `server.mjs` (the `_softTriggersConfigured` warn emission).
- **Blocks.**
  - Issue #8 (`X-OLP-Provider-Used` chain-origin semantics) — Option A (track `firstAttemptedProvider`) becomes preferable once soft triggers can fire. See ADR 0004 Amendment 6 § v1.x re-evaluation.
  - `X-OLP-Fallback-Detail` `trigger_type: 'soft'` path — currently dead code, becomes live with this work.
- **Code anchors today.**
  - `lib/fallback/engine.mjs` `evaluateSoftTriggers` (returns false unconditionally at v0.1).
  - `lib/providers/base.mjs` `Provider.quotaStatus` contract (declared but unused at v0.1).
- **Trigger to start.** First quota-rate-limit event in the wild — at which point the operator would want pre-emptive advancement rather than spawn-then-fail.

## #4 — `/health` `activeSpawns` integration

- **What.** Surface D38 `getActiveSpawnCount(providerName)` per-provider on the `/health` endpoint at the path `providers.status.<name>.activeSpawns`.
- **Why deferred.** D38 (issue #1) shipped the runtime enforcement and exported `getActiveSpawnCount`; `/health` integration was scoped out as forward-looking polish.
- **Design ADR.** [`docs/adr/0002-plugin-architecture.md` Amendment 6](./adr/0002-plugin-architecture.md) — names the target path explicitly: "`/health` integration deferred — when surfaced there will land at `providers.status.<name>.activeSpawns`; not wired at D38."
- **Tracking.** Not a GitHub issue. Tracked here.
- **Code anchors today.**
  - `lib/providers/index.mjs` exports `getActiveSpawnCount` already.
  - `server.mjs handleHealth` — extension point for the new field.
- **Trigger to start.** First time the maintainer wants per-provider concurrency visibility for capacity planning.

## #5 — Provider-level `cacheKeyFields` (per-plugin mask)

- **What.** Per-plugin declaration of which IR fields are actually consumed by the underlying CLI invocation, used by `computeCacheKey` to skip fields that the plugin drops at spawn. Reduces spurious-miss rate from the v0.1 conservative-posture trade-off (Amendment 7).
- **Why deferred.** At personal/family scale the extra spawn cost from spurious misses is negligible. The contract extension adds complexity (per-plugin field set + plumbing through `buildDefaultChain` → `executeHopFn` → `computeCacheKey`).
- **Design ADR.** [`docs/adr/0005-cache-cross-provider.md` Amendment 7 § Forward path](./adr/0005-cache-cross-provider.md).
- **Tracking.** Not a GitHub issue. Tracked here.
- **Code anchors today.**
  - Plugin file headers — each lists its "fields dropped at spawn" table for human reference; the v1.x amendment makes that table machine-readable.
  - `lib/cache/keys.mjs computeCacheKey` — would accept `pluginCacheKeyMask` parameter.
- **Trigger to start.** First time spurious-miss rate becomes a measurable load factor.

## #6 — Streaming-path SPAWN_FAILED salvage

- **What.** Currently the streaming branch does NOT participate in D16 salvage (the salvage-on-SPAWN_FAILED + chunks pattern that the buffered path uses). Streaming SPAWN_FAILED mid-stream → the truncation marker (D35 #10) fires, but no salvage logic captures partial chunks for downstream cache reuse.
- **Why deferred.** Less impactful than #1 — at most one client benefits per spawn event, and the buffered path already provides salvage for the bulk of requests. Streaming is the minority path.
- **Status update post-#1 close (2026-05-25).** #1 was originally bundled with #6 in the design ADR (Amendment 8). The tee architecture as implemented does NOT carry salvage semantics — D57's tee writes `accumulatedChunks` to cache only on normal source completion (stop chunk seen); on SPAWN_FAILED mid-stream the cache layer rejects all clients with the error and does NOT persist partial chunks. D58 preserves D16's truncated-not-cached invariant via server-layer `cacheStore.delete` on stop-less exhaustion. #6 therefore remains independently deferrable.
- **Design ADR.** Not yet ratified. The unbundling from #1 means #6 now needs its own ADR amendment when triggered.
- **Tracking.** Not a GitHub issue. Tracked here.
- **Trigger to start.** First report of streaming-path SPAWN_FAILED mid-stream where partial-chunk salvage would have helped a downstream caller. Practically unlikely at family scale.

## #8 — Dashboard enrichment: per-provider subscription quota + reset times + 1-min refresh + manual refresh (D78 follow-up) — ✅ **CLOSED (D82, v0.5.0)**

- **Status.** Closed at D82 (Phase 5). `dashboard.html` restructured to Claude.ai-style per-provider rows rendering `quota_v2`. Closed by PR on branch `d82-dashboard-ui-claude-ai-style`; ships with v0.5.0. 60s quota auto-refresh + manual refresh button + visibilityState guard implemented. Graceful fallback to legacy `quota` field when server runs a pre-D81 build.
- **What.** Phase 3 dashboard (D51 `dashboard.html`, v0.3.0) shows: per-provider quota (currently always "n/a — no quota api"), last-24h request count + cache hit + fallback rate, 30d request-count sparkline, top fallback chains. **Maintainer request 2026-05-26 post-D78**: extend to show what each enabled provider's subscription is actually consuming, with reset times visible, refresh once per minute (current 30s is OK but maintainer specified 1min target), and a manual refresh button. Reference design: Claude.ai's own `claude.ai/settings/usage` page — current session bar with "Resets in 1hr 6min", weekly all-models bar with "Resets Sun 9:00 PM", per-model bar (Sonnet only), additional features (routine runs), usage credits + monthly spend limit + auto-reload toggle.
- **Why deferred.** v0.3.0/v0.4.x ships the dashboard frame but `provider.quotaStatus()` returns `null` in all three v0.1 plugins (anthropic / openai / mistral). The ratifying spec in ADR 0004 Amendment 2 punts `quotaStatus()` to v1.x ("soft trigger reactivation") — this dashboard ask is the **operator-facing reason** that work would land.
- **What this requires.** Per-provider plugin work + dashboard.html UI work + audit-query.mjs aggregation:
  1. **`lib/providers/anthropic.mjs quotaStatus()`** — discover where the maintainer's Claude.ai subscription quota state is exposed. Candidates: (a) `claude` CLI command (e.g., `claude usage`) if Anthropic adds one — currently absent; (b) parsing the `claude-code` output for rate-limit error messages and caching state from headers; (c) hitting `api.anthropic.com/v1/.../usage` directly via the OAuth refresh token — not a documented endpoint, primary-source risk. ADR 0002 Rule 1 / Rule 5 require an authority citation before any implementation. Likely path: **wait until Anthropic publishes a documented endpoint**, OR derive from audit-side request counts only (no real quota truth, just "you sent N requests in the current 5h window").
  2. **`lib/providers/openai.mjs quotaStatus()`** — codex CLI doesn't expose ChatGPT-subscription quota state. OpenAI rate-limit headers per request might be parseable but ADR 0004 Amendment 2 explicitly says no plugin parses HTTP status at v0.1.
  3. **`lib/providers/mistral.mjs quotaStatus()`** — Le Chat Pro has `/v1/usage` endpoint per Mistral docs (verify).
  4. **`dashboard.html` UI restructure** to a Claude.ai-style layout: rows of (label, bar, "Resets in X" / "Resets at <day-of-week> <time>", percent). Add a manual refresh button + change auto-poll from 30s → 60s. Optionally a usage-credits / per-key spend display if Phase 5 ships per-key cost weights.
  5. **`lib/audit-query.mjs`** — extend `aggregateRequests` / `spendTrendDaily` to compute "in the current rolling window" (since session/week start) per provider. Today's aggregates are wall-clock windows; subscription resets are per-account-anchored. Need a way to model session windows (e.g., "Anthropic 5h-from-first-request-since-last-reset").
- **Reference (maintainer 2026-05-26).** Screenshot of `claude.ai/settings/usage` shared inline. Key panels: Plan usage limits (current session + resets-in), Weekly limits (All models / Sonnet only / per-feature breakdown, each with resets-on), Additional features (Daily included routine runs N / 15), Usage credits (toggle + spent vs monthly limit + auto-reload + buy-credits link).
- **Tracking.** Not yet a GitHub issue. Track here + cross-reference ADR 0004 Amendment 2 (soft trigger reactivation — same `quotaStatus()` data-source work) when this becomes Phase 5 scope.
- **Code anchors today.**
  - `dashboard.html` — current 4 panels; needs restructure to Claude.ai-style row layout
  - `lib/providers/anthropic.mjs` / `openai.mjs` / `mistral.mjs` — `quotaStatus()` returns null today
  - `lib/audit-query.mjs` — current `aggregateRequests` is wall-clock-window; needs session-window variant
- **Trigger to start.** ANY of: (a) Anthropic publishes a documented `claude usage` CLI or `api.anthropic.com/v1/usage` endpoint, (b) maintainer hits real "I want to see quota right now" pain often enough to design without per-provider truth (audit-derived only), (c) Phase 5 multi-tenant adds per-key spend limits and the dashboard needs to surface those.

## #7 — AUTH_MISSING tuple path test coverage (D40 follow-up)

- **What.** Dedicated test in `test-features.mjs` Suite D40 that asserts the `fallbackDetail` tuple records the AUTH_MISSING path with `trigger_type: 'auth_missing'`. D40 reviewer flagged this as the last gap in the engine-path matrix; code is structurally correct, just lacks an explicit pin.
- **Why deferred.** Low priority — the AUTH_MISSING early-return branch has the tuple push BEFORE it (verified in D40 reviewer pass), so coverage is implicit via the other engine-path tests. A 3-line dedicated test would make the pin explicit.
- **Design.** No ADR needed. ~5-line test addition.
- **Tracking.** Not a GitHub issue. Tracked here.
- **Trigger to start.** Next routine test-suite hardening pass, OR when AUTH_MISSING handling is changed for any reason.

---

## Adding a new entry

When a future D-day defers work, the deferring commit should:

1. **Always** update this file with a new entry at the top.
2. **Always** name the ratifying ADR amendment (or note "no ADR yet — future work needs one").
3. **Always** name the load-bearing code anchor (`file:line` form preferred over symbolic names — the symbolic name can drift).
4. **Always** name a concrete trigger to start the work — vague triggers ("when needed") let entries rot.
5. If the deferral has a GitHub issue, keep it OPEN and reference it here. If it does NOT, leave a note explaining why (e.g., "tracked here only — no external governance event filed").

The maintainer's session-startup discipline should grep this file at sprint kickoff. If an entry's "trigger to start" condition is met, it leaves this page and becomes a sprint item.

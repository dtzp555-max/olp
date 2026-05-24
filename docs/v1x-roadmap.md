# OLP v1.x Roadmap — Deferred Work Tracker

**Purpose.** Single landing page for every Phase-1 deferral that an actual v1.x sprint must pick up. Each entry cross-references its ratifying ADR, its GitHub issue (if any), and the load-bearing code anchor so a future maintainer can resume without spelunking the commit history.

**Status:** Living document. Add new entries at the top. Each item should answer:
1. **What** is deferred?
2. **Why** was it deferred (link the ratifying ADR amendment).
3. **Where** does the work live in the tree today (file + anchor).
4. **When** does it need to land (trigger: load profile, security event, governance amendment).

**Reading order for a v1.x sprint kickoff.** Items #1–#3 are the most architecturally consequential and should be designed in dependency order: #2 (multi-key auth) blocks header gating in #1 and observability ownership in #4. #1 (streaming SF) blocks #5 (soft trigger reactivation) only if soft triggers are wired on streaming requests.

---

## #1 — Streaming-path singleflight + TOCTOU close

- **What.** `cacheStore.getOrComputeStreaming(keyId, cacheKey, sourceFactory)` API replacing the current `peek + spawn` pattern in `server.mjs`. Per-(keyId, cacheKey) inflight Map with tee fan-out, bounded per-client backpressure queues, late-joiner replay buffer, AbortController propagation on all-disconnect.
- **Why deferred.** Personal/family-scale single-tenant load — N concurrent identical streaming requests is an edge case that has not been reported. Each concurrent caller receives the correct response; the waste is N CLI processes instead of one.
- **Design ADR (ratified).** [`docs/adr/0005-cache-cross-provider.md` Amendment 8](./adr/0005-cache-cross-provider.md) — full design including the inflight Map shape, tee policy, late-joiner replay, backpressure cap, D38 semaphore coordination, abort policy, cache TTL race handling, observability event set, and X-OLP-Streaming-Inflight header. Implementation acceptance criteria are in Amendment 8 §13.
- **Tracking issue.** GitHub issue [#16](https://github.com/dtzp555-max/olp/issues/16) — STAYS OPEN as v1.x tracker. Sibling: the closed-but-not-implemented Amendment 6 deferral (D34 F1).
- **Code anchors today.**
  - `server.mjs` lines ~782 (`preCheckHit = await cacheStore.peek(...)`) and ~811–817 (streaming branch entry) — these are the lines the new API replaces.
  - `lib/cache/store.mjs` `getOrCompute` — sibling API; the new one mirrors its shape on the streaming path.
- **Trigger to start.** Any of: (a) report of N>1 concurrent identical streaming requests in the wild, (b) v1.x sprint planning kickoff with the maintainer explicitly opening this scope, (c) downstream feature requiring tee-streaming primitive (e.g., browser-side observer attaching to an existing stream).
- **Estimated effort.** Design ADR ratified (Amendment 8) = 30 min done. Implementation = 200–400 lines + 15-20 tests + fresh-context reviewer pass. ~3-4 hours of subagent runtime with full Iron Rule 10 discipline.

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
- **Design ADR.** Not yet ratified. Coordinated with #1 because the tee architecture changes the salvage semantics (multiple clients may want different finish_reason interpretations on source-mid-stream-failure).
- **Tracking.** Not a GitHub issue. Tracked here.
- **Trigger to start.** Bundled with #1 implementation work (the inflight tee architecture changes the salvage semantics, so designing them together is cheaper than serializing).

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

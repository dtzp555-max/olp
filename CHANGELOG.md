# Changelog

All notable changes to OLP land here. Per `CLAUDE.md` release_kit overlay, this file is the source of truth for GitHub release notes.

## Unreleased

### D43-B — ADR 0007 multi-key auth design draft (design-only, no code change)

Phase 2 mainline design ADR. Ratifies the storage / token / manifest / atomic-write / owner-gating / bootstrap / Node-baseline decisions ahead of D44+ implementation D-days. Pure design doc — no `.mjs` / no tests / 4 files touched.

- `docs/adr/0007-multi-key-auth.md` (new, ~270 lines): 13 sections covering Context / Decision (Option 2 + opaque key) / Storage layout (`~/.olp/keys/<key-id>/manifest.json` + `~/.olp/logs/audit.ndjson`) / Manifest schema (schema_version, token_hash, owner_tier, providers_enabled) / Token format (`olp_<32-byte base64url>`, SHA-256 hash) / Atomic write & audit append (manifest lifecycle-only atomic via tmpfile+fsync+rename; audit per-request append, warn + 1 retry, no memory buffer at Phase 2) / Owner-vs-guest-vs-anonymous gating (config.json `auth.allow_anonymous` default false, no env auto-detection) / Audit ndjson schema (no PII) / Bootstrap & recovery (minimal keygen command surface + `OLP_OWNER_TOKEN` env override with stable `__env_owner__` keyId) / Acceptance criteria (11 test surfaces for D44+) / Node baseline (Option 1 SQLite port rejection rationale citing `engines >=18` + CI 20/24 vs `node:sqlite` v22.5.0/RC) / Out of scope (Dashboard, quota enforcement, audit query, file locking deferred to Phase 3+) / Future forward (Option 3 hybrid migration trigger + preconditions).
- `docs/adr/README.md` index: added ADR 0007 row with one-paragraph summary.
- `docs/v1x-roadmap.md` #2: marked **PHASE 2 ACTIVE (no longer deferred)**; "Design ADR (NOT YET RATIFIED)" → "Design ADR (ratified) → ADR 0007"; trigger updated to "already fired 2026-05-25"; code anchors pinned to exact line numbers (cache/store.mjs:77-79/:287, server.mjs:502/:531/:392/:1072/:1101).
- `CHANGELOG.md` Unreleased: this entry.
- **Fold-in (fresh-context opus reviewer findings, 2 P2 + 3 P3, all polish):** § 6.2 step 1 — pin audit serialization timing to after status_code + latency_ms are known (resolves §10 #2 testability gap); new § 6.3.5 — explicit "no in-process validation cache at Phase 2" rule (resolves §10 #6 implicit-contract gap); § 6.1 — document deliberate omission of directory fsync after rename (single-process trade-off); § 9.4 — token-collision policy between `OLP_OWNER_TOKEN` and filesystem keys declared undefined behaviour; §10 #4 — test rephrased to assert against config-driven `owner_only_endpoints` rather than hardcoded payload shape.
- **Test count:** 468 → 468 (design-only, no test change).
- **Authority:** Phase 2 kickoff handoff (`~/.cc-rules/memory/handoffs/2026-05-25-phase-2-kickoff.md` in cc-rules `d9da966`); OLP v0.1 spec § 4.5 (planning authority for `~/.olp/` layout); OCP `keys.mjs` (prior-art for opaque-key + per-key isolation model); Node `node:sqlite` docs (https://nodejs.org/api/sqlite.html — Option 1 rejection rationale per ADR 0007 § 11); CC 开发铁律 v1.6 § 10 — fresh-context opus reviewer required for design ADR per Iron Rule 10.

### D43-A — Phase 2 doc alignment (no code change)

Phase 1 was closed at v0.1.1; this commit aligns documentation surfaces to the Phase 2 reality before D43-B (ADR 0007 draft) lands. Pure doc cleanup; no `.mjs` or test changes.

- `CLAUDE.md release_kit.current_phase` Phase 1 → Phase 2; `current_pre_release_identifier` `0.1.0-bootstrap` → `0.2.0-phase2`.
- `README.md` status header + Implementation Status + Phase plan rewritten to reflect actually-shipped reality (v0.1.0 + v0.1.1 bundled the three Tier-D plugins + cache + fallback into a single Phase 1 milestone, not one phase per plugin as the original v0.1 spec planned). `lib/keys.mjs` row + "Multi-key auth not yet implemented" note updated to "Phase 2 active per ADR 0007 (drafting at D43-B)".
- `AGENTS.md` § Key files to know — `lib/keys.mjs` 📋 marker updated to "Phase 2 active per ADR 0007 (drafting at D43-B)"; Implementation-status-note paragraph dated 2026-05-25 + reflects Phase 1 close + Phase 2 active scope.
- `ALIGNMENT.md` § Provider Inventory — added one-paragraph "Note on phase terminology" clarifying that "Phase" in the Provider Inventory tables + § One-shot Triggered Audits "OpenAI Codex ToS formal pin" refers to the original per-plugin enablement plan, orthogonal to the milestone phase numbering in README. Fold-in for D43-A reviewer P2 finding; no governance-text change, no Speculative-Candidate plugin reclassification.
- **Test count:** 468 → 468 (no test change).
- **Authority:** `CLAUDE.md release_kit overlay phase_rolling_mode` — under Unreleased; Phase 2 kickoff handoff at `~/.cc-rules/memory/handoffs/2026-05-25-phase-2-kickoff.md`; ADR 0007 forthcoming at D43-B.

## v0.1.1 — 2026-05-25

### Phase 1 cleanup — pre-Phase-2 batch (D35–D42, closes 16 of 17 issues)

**Overview.** v0.1.1 closes the post-v0.1.0 cleanup batch covering all 17 pre-Phase-2 issues raised during the 6-round cold-audit cycle on the Phase 1 deliverable. 8 D-day commits (D35–D42) shipped between 2026-05-24 and 2026-05-25. 16 issues closed; issue #16 (streaming singleflight) stays OPEN as the v1.x tracker with its design ratified in ADR 0005 Amendment 8.

**Test count: 416 (v0.1.0) → 468 (v0.1.1).** +52 tests across the cleanup batch.

### D35 — pre-Phase-2 batch #1 (issues #4 #9 #10 #11 #12)

- **#4 — X-OLP-Latency-Ms uniform.** Audit confirmed already-correct via D32; D35 adds the `#4-audit` regression test pinning the 5-header invariant on the 503 no-provider sendError so future drift is caught immediately.
- **#9 — Streaming empty-then-clean-exit headers.** Zero-chunk streaming path now guards `!res.headersSent` and emits Content-Type=text/event-stream, Cache-Control=no-cache, Connection=keep-alive, X-Accel-Buffering=no, plus all 5 X-OLP-* headers via olpHeaders before writing `SSE_DONE`. Zero-chunk path correctly does NOT cache.
- **#10 — Streaming post-first-chunk error truncation marker.** Two sibling fixes: catch-block-firstChunkEmitted=true and error-chunk-after-first-chunk both now emit synthetic `{type:'stop', finish_reason:'length'}` via `irChunkToOpenAISSE` + `SSE_DONE` + `res.end()`. Per ADR 0004 § Fallback safety: post-first-chunk truncation surfaces as `length` finish, never a hang.
- **#11 — `validateIRRequest` irVersion strict check.** ADR 0003 IR contract pins irVersion to `'1.0'`. Validator now: `obj.irVersion !== undefined && obj.irVersion !== '1.0'` → rejection. Strict string match — `undefined` accepted (back-compat), `'1.0'` accepted, `'2.0'` rejected, numeric `1.0` rejected (`1.0 !== '1.0'`).
- **#12 — `alignment.yml` scripts/** trigger removal.** Removed from both `push.paths` and `pull_request.paths` since the `scripts/` directory does not currently exist (planned for Phase 7).
- **Test count:** 416 → 424 (+8).

### D36 — pre-Phase-2 batch #2 (issues #2 #5 #6 #13 #14 #15)

- **#2 — cache_control partial-noop debug log.** `server.mjs handleChatCompletions` fires `logEvent('debug', 'cache_control_partial_noop', { chain, marker_count })` at most once per request when markers present AND chain has at least one non-Anthropic hop. Per ADR 0005 § D2.
- **#5 — ADR 0002 vibe.mjs → mistral.mjs.** § Decision filesystem layout corrected to match the shipped file naming convention (file named after provider key, not CLI binary). Amendment 5 documents the correction + makes the convention statement explicit for future contributors.
- **#6 — mistral.mjs A5 flip + ALIGNMENT.md table update.** Header A5 (model flag) flipped from `UNPINNED-D-later-verifies` to `CONFIRMED-NOT-APPLICABLE` with DeepWiki citation; ALIGNMENT.md Speculative-Candidate table mistral row updated to remove A5.
- **#13 — /v1/models alias governance.** ALIGNMENT.md gains "Controlled deviations (entry-surface scope)" subsection documenting the alias surface as a controlled Rule 2(b) deviation; `docs/openai-spec-pin.md` gains the alias-surfacing subsection with full 4-field contract table.
- **#14 — cache_control slot determinism regression test.** 4 tests in test-features.mjs construct hand-built IRs with synthetic markers (bypassing openAIToIR which strips them at v0.1) and verify the cache key SHA-256 is deterministic. Per ALIGNMENT.md Rule 2 (No Invention), no `sortMarkers` helper shipped — the slot is dead-code at v0.1.
- **#15 — Anthropic v2.1.89 transcript artifact.** New file `docs/provider-audits/anthropic.md` as a single living version-capture artifact. Records observed `claude --version` (2.1.132 at capture date 2026-05-24), pinned version (v2.1.89 from D4), drift note, sample invocation, flag-surface table for 5 OLP-consumed flags. Closes the circular ALIGNMENT.md ↔ plugin header citation by anchoring on an external artifact.
- **Test count:** 424 → 431 (+7).

### D37 — release.yml phase_rolling_mode gate (issue #17)

- **CI gate enforcing phase_rolling_mode promotion discipline.** New "Enforce phase_rolling_mode (Unreleased must be promoted)" step in `release.yml` between the version-match check and the CHANGELOG extraction step. Awk extracts content between `## Unreleased` and the next `## ` heading; sed strips blank lines and parenthetical-sentinel-only lines. Non-trivial remaining content fails the workflow with `::error::` instructing the maintainer to promote Unreleased → `## v<version>` per CLAUDE.md release_kit.phase_rolling_mode.
- **Dry-run validated against 4 cases:** current sentinel-only Unreleased → PASS; synthetic non-trivial Unreleased → FIRES with offending lines reported; no Unreleased section → PASS; multi-sentinel + blank lines → PASS.
- **Gate is purely additive** — fires only on tag push to `v*.*.*`, does not affect normal push/PR CI.
- **Test count:** 431 → 431 (no test change — CI workflow only).

### D38 — maxConcurrent runtime enforcement (issue #1)

- **Spawn lifecycle gate** — `hints.maxConcurrent` is now enforced at runtime per ADR 0002 Amendment 6: `lib/providers/index.mjs` exports a per-provider `tryAcquireSpawn` / `releaseSpawn` / `getActiveSpawnCount` semaphore; `server.mjs` gates both the buffered and streaming spawn call sites in `handleChatCompletions` with a try/finally release. Saturation surfaces as `ProviderError(CONCURRENCY_LIMIT)` which the fallback engine treats as a hard trigger (ADR 0004 Amendment 4) — the chain advances to the next hop instead of queueing. If the entire chain is saturated, the user receives a chain-exhausted error via the existing exhaustion path. Closes #1. Queue+timeout deferred (see ADR 0002 Amendment 6 § Design choice). Test count 431 → 447.

- **Spawn lifecycle gate** — `hints.maxConcurrent` is now enforced at runtime per ADR 0002 Amendment 6: `lib/providers/index.mjs` exports a per-provider `tryAcquireSpawn` / `releaseSpawn` / `getActiveSpawnCount` semaphore; `server.mjs` gates both the buffered and streaming spawn call sites in `handleChatCompletions` with a try/finally release. Saturation surfaces as `ProviderError(CONCURRENCY_LIMIT)` which the fallback engine treats as a hard trigger (ADR 0004 Amendment 4) — the chain advances to the next hop instead of queueing. If the entire chain is saturated, the user receives a chain-exhausted error via the existing exhaustion path. Closes #1. Queue+timeout deferred (see ADR 0002 Amendment 6 § Design choice). Test count 431 → 447.

### D39 — D16 follow-ups (issue #3): explicit cache delete + eviction log + SPAWN_TIMEOUT asymmetry doc

- **Part 1 — `CacheStore.delete(keyId, cacheKey)`** — adds an explicit eviction primitive to `lib/cache/store.mjs`. Returns `boolean` (true if entry present and removed; false otherwise) and removes empty per-keyId namespace `Map` entries from the outer store for memory hygiene (matches the D38 `_activeSpawns` pattern). `server.mjs` D16 salvage path replaces `cacheStore.set(..., ttlMs=0)` (lazy tombstone that lived in the namespace `Map` until the next `get`/`peek` purged it) with `cacheStore.delete(...)` (immediate removal). Cache semantics unchanged — truncated responses still don't persist. ADR 0005 § "Cache write conditions" item 1 authority.
- **Part 2 — `cache_evicted_truncated` observability log** — adds an `info`-level structured log event fired immediately after the D16 eviction in `executeHopFn`. Carries `{ provider, model }` so dashboards can surface salvage frequency per (provider, model) pair. P3 polish; no semantic change.
- **Part 3 — sticky-cache regression test** — defense-in-depth test asserting two consecutive identical buffered requests that both trigger SPAWN_FAILED-with-chunks salvage each invoke a fresh spawn (spawnCount=2 across the two requests; second request reports `X-OLP-Cache: miss`). Catches any future regression where the eviction is dropped or the gate condition flips.
- **Part 4 — SPAWN_TIMEOUT salvage asymmetry documented (no code change)** — ADR 0004 Amendment 1 gains a new sub-section "Why SPAWN_TIMEOUT is excluded from salvage" with a 4-point rationale: (1) SPAWN_FAILED is a terminal signal, SPAWN_TIMEOUT is a deadline signal; (2) the next hop is a different provider with different speed characteristics, plausibly full-response-soon-after-T; (3) the "user paid for partial" framing applies to SPAWN_FAILED only — for SPAWN_TIMEOUT the user paid for "result within T"; (4) code inspection confirms the catch block matches only `code === 'SPAWN_FAILED'`. Includes hard-trigger-taxonomy completeness note and v1.x re-evaluation trigger (opt-in salvage-on-timeout for long deadlines).
- **Authority:** ADR 0005 § Cache layer / CacheStore API extension (Part 1); ADR 0004 Amendment 1 (Part 4); GitHub issue #3 — closed by this commit; D16 commit `bafa6d1` non-blocking suggestions — batched here.
- **Test count:** 447 → 452 (3 unit tests for `CacheStore.delete` + 1 log-event integration test + 1 sticky-cache regression test).

### D40 — `X-OLP-Fallback-Detail` header (issue #7)

- **New debug header on responses with a non-empty failure trail** — `lib/fallback/engine.mjs#executeWithFallback` now returns a `fallbackDetail` array of per-hop tuples on every code path. `server.mjs` emits `X-OLP-Fallback-Detail: <JSON-stringified array>` on any response where at least one hop failed before the chain resolved or exhausted (chain-exhausted, non-trigger-error, client-error, AUTH_MISSING, and success-with-prior-failure paths). Header is absent on clean primary success (no failure trail to report).
- **Tuple schema** — `{ hop, provider, model, code, error_message, trigger_type }` per failed hop. `code` is the `ProviderError` code or `'UNKNOWN'` for non-`ProviderError` exceptions; `error_message` is truncated to 200 chars with a U+2026 ellipsis on truncation; `trigger_type` matches D28's `classifyTrigger` output (`'hard'` / `'soft'` / `'auth_missing'` / `'client_error'` / `'non_trigger'`). Field shapes reuse D28's per-hop structured log event keys so logs and the header pivot on the same surface.
- **4KB UTF-8 byte cap** — if the JSON-stringified array exceeds 4096 bytes, tail tuples are dropped and a `{ truncated: true, omitted_hops: N }` sentinel is appended such that the total fits under the cap. Cap calculation uses `Buffer.byteLength('utf8')`, not string length.
- **RFC 7230 hygiene** — non-ASCII code points (e.g. the em dash in the D38 `CONCURRENCY_LIMIT` synthesised error message) are escaped as `\uXXXX` so the header value is pure ASCII. Node's HTTP header validator rejects multi-byte UTF-8 in field values; without this step, em-dash-bearing error messages would crash `res.writeHead`. `JSON.parse` round-trips the escaped form correctly.
- **Gating posture — ungated at v0.1** — the original ADR 0004 § Chain advancement step 4 specified owner-only gating. Per the maintainer decision in issue #7, v0.1 ships the header **ungated** (single-tenant family-scale per ALIGNMENT.md; no PII risk in error details). **Phase 2 will re-introduce owner-vs-non-owner gating when `lib/keys.mjs` lands** — explicit follow-up tracked in AGENTS.md § Key files to know and ADR 0004 Amendment 5.
- **Authority:** ADR 0004 § Decision § Chain advancement step 4 (original promise — D40 fulfils it); ADR 0004 Amendment 5 (D40 ratification); D18 (5 standard X-OLP-* headers; D40 builds on the convention); D28 (per-hop structured log fields; D40 reuses the field shapes); GitHub issue #7 — closed by this commit.
- **Test count:** 452 → 468 (7 engine-level tuple-shape tests + 6 serialiser unit tests including the 4KB cap + non-ASCII regression + 3 HTTP integration tests).

### D41 — `X-OLP-Provider-Used` semantics documented (issue #8)

- **Doc-only clarification.** On a chain-exhausted response, `X-OLP-Provider-Used` identifies the chain's configured primary entry (`chain[0].provider`), not necessarily the first hop where `spawn()` was actually invoked. At v0.1 this is unobservable because soft triggers are deferred (ADR 0004 Amendment 2) — every hop is attempted in order, so chain-origin and first-attempted are equivalent. When soft triggers reactivate in v1.x, a soft-skipped hop 0 followed by hard-failed hops 1+N would still report `providerUsed=chain[0]` despite chain[0] never being spawned.
- **Option B (document chain-origin) chosen over Option A (track `firstAttemptedProvider`).** Rationale: Option A would add state to `executeWithFallback` for an unreachable v0.1 code path (ALIGNMENT.md Rule 2 — No Invention). The D40 `X-OLP-Fallback-Detail` header already carries precise per-hop spawn history (including soft-skip records with `trigger_type: 'soft'`), so the disambiguation channel exists on the wire without needing `providerUsed` to handle it.
- **Updates:** ADR 0004 Amendment 6 documents the semantics; `README.md` § Observability headers replaces "which provider's plugin served the request" with the chain-origin wording; `lib/fallback/engine.mjs` chain-exhausted return site gains an inline comment citing the amendment and the v1.x re-evaluation note.
- **No code-behavior change. No new tests** — the relevant scenario is dead-by-config at v0.1; the v1.x soft-trigger reactivation work should add a test that exercises the soft-skip + chain-exhausted edge case and pins whichever option the v1.x maintainer chooses (the amendment names Option A as the likely v1.x preference).
- **Authority:** ADR 0004 Amendment 6 (this commit); ADR 0004 § Decision § Chain advancement step 4; ADR 0004 Amendment 2 (soft triggers deferred — precondition); ADR 0004 Amendment 5 (per-hop attribution channel via `X-OLP-Fallback-Detail`); ALIGNMENT.md Rule 2 (No Invention rationale); GitHub issue #8 — closed by this commit.
- **Test count:** 468 → 468 (no test change).

### D42 — Streaming singleflight design ADR + v1.x roadmap (issue #16)

- **Design-only ratification of the v1.x streaming singleflight implementation.** ADR 0005 Amendment 6 (D34) had deferred this work with a "design alone warrants a dedicated ADR" note. D42 fulfils the note as ADR 0005 Amendment 8, ratifying the `cacheStore.getOrComputeStreaming(...)` API shape, per-(keyId, cacheKey) inflight Map, tee fan-out with bounded per-client backpressure queues, late-joiner replay buffer, AbortController propagation on all-disconnect, D38 `tryAcquireSpawn` coordination (only the first caller's spawn counts against the semaphore), cache TTL race handling, the new `STREAM_BACKPRESSURE` error code (NOT a hard trigger), and the new `X-OLP-Streaming-Inflight: source | attached | solo` header. Implementation acceptance criteria are enumerated in Amendment 8 §13.
- **Multi-layer safeguards to ensure the v1.x work is not forgotten.** New file `docs/v1x-roadmap.md` is a single living landing page for every Phase-1 deferral (streaming SF, multi-key auth, soft-trigger reactivation, `/health` activeSpawns, provider-level `cacheKeyFields`, streaming-path SPAWN_FAILED salvage, D40 AUTH_MISSING tuple test). Each entry names the ratifying ADR, the load-bearing code anchor, and a concrete trigger to start. Cross-references added at: `lib/cache/store.mjs#getOrCompute` JSDoc (sibling API TODO), `server.mjs` streaming-branch entry (~line 810, the peek+spawn pattern Amendment 8 replaces), `README.md § Known limitations` (user-facing surface), and `docs/adr/0005-cache-cross-provider.md` Amendment 8 § "Cross-references and safeguards".
- **Issue #16 status.** STAYS OPEN as the v1.x implementation tracker. The body of the issue is updated post-D42 to reference Amendment 8 and clarify scope ("design ratified; implementation pending"). DO NOT close the issue until Amendment 8 §13's test surface is green against an actual implementation.
- **No code-behavior change. No new tests.** Amendment 8 is design-only. The implementation will go through full Iron Rule 10 (fresh-context opus reviewer + acceptance-criteria-gated test pass) when the v1.x sprint kicks off.
- **Authority:** ADR 0005 Amendment 8 (this commit); ADR 0005 Amendment 6 (D34 — original deferral note); GitHub issue #16 (round-6 F13 — sibling TOCTOU); ADR 0002 Amendment 6 (D38 — `tryAcquireSpawn` semantics that §7 coordination builds on); ADR 0004 Amendment 5 (D40 — observability pattern §11 extends); `CLAUDE.md` release_kit_overlay phase_rolling_mode — under Unreleased; CC 开发铁律 v1.6 § 10.x (design-only amendment; fresh-context reviewer not required per the Iron Rule 10 implementation-phase scope, documented in the amendment's procedural mechanism).
- **Test count:** 468 → 468 (no test change — design-only).

### Phase 1 cleanup release_kit checklist

- [x] All 8 D-day deliverables landed on main (D35-D42)
- [x] CI green on every D-day commit + on this release commit's head
- [x] Cold-audit round 7 (fresh-context opus full-pass) — PASS_WITH_MINOR, 0 P1/P2 findings
- [x] 16 of 17 pre-Phase-2 GitHub issues closed (#1-#15 and #17); #16 stays OPEN as v1.x tracker
- [x] Issue #16 status comment posted referencing ADR 0005 Amendment 8 design ratification
- [x] CHANGELOG "Unreleased" promoted to "## v0.1.1 — 2026-05-25" with D35-D42 entries
- [x] `package.json` bumped from 0.1.0 → 0.1.1
- [x] `docs/v1x-roadmap.md` created — 7 deferred items with anchors + start triggers
- [ ] Tag pushed (next step in this PR's lifecycle)
- [ ] `release.yml` triggered + GitHub Release created (auto on tag push; D37 phase_rolling_mode gate will pass because Unreleased is now sentinel-only)

### Known limitations carried to v1.x

Full list with code anchors + start triggers in [`docs/v1x-roadmap.md`](./docs/v1x-roadmap.md):
- Streaming-path singleflight (issue #16, ADR 0005 Amendment 8 design ratified)
- Multi-key auth (`lib/keys.mjs`)
- Soft-trigger reactivation (ADR 0004 Amendment 2)
- `/health` activeSpawns integration (ADR 0002 Amendment 6 forward note)
- Provider-level `cacheKeyFields` mask (ADR 0005 Amendment 7 forward note)
- Streaming-path SPAWN_FAILED salvage (bundled with #1 in v1.x)
- D40 AUTH_MISSING tuple test coverage (test polish)

## v0.1.0 — 2026-05-24

### Phase 1 Close — Multi-provider proxy core

**Overview.** Phase 1 delivers the OLP minimum-viable multi-provider proxy: OpenAI-compatible HTTP entry surface, plugin architecture for 3 Tier-D providers (Anthropic Claude / OpenAI Codex / Mistral Vibe), cache layer (D1 per-key isolation + D4 buffered-path singleflight + size cap + cacheable opt-out), fallback engine with first-chunk safety + spawn-timeout hard trigger + structured per-hop log observability, IR↔OpenAI translation honoring the Rule 2(b) no-invention constraint, and a 416-test suite covering all of it.

Released under `phase_rolling_mode` (CLAUDE.md release_kit overlay): 25 D-day commits accumulated on `main` between 2026-05-23 and 2026-05-24 before this version bump + tag.

**Provider posture.** Three Tier D plugins ship as **Candidate** (per ALIGNMENT.md § Provider Inventory) — runnable via `providers.enabled` config but not Enabled by default. Five additional Tier B/C plugin slots exist in `models-registry.json` as Speculative-Candidate / candidate stubs awaiting CLI authority pins. Zero Enabled providers at v0.1; transition to Enabled requires Phase audit + primary-source pin per ADR 0002.

### What landed (D10–D34 commit index)

The per-commit detail is in the git log; this index summarizes the deliverables.

**Phase 1 core hardening:**
- **D10** (`2cfd0b1`) — P1 round-3: providers.enabled config wiring + real SSE streaming on single-hop cache-miss + spawn-timeout hard trigger across all 3 plugins.

**Round-1 fold-in batch (cold audit caught 17 findings):**
- **D11** (`f659e29`) — ADR 0002 Amendment 1: `maxSpawnTimeMs` ratified into Provider contract hints.
- **D12** (`4b1a9c8`) — IR translator Rule 2(b) compliance: removed invented top-level `error` field on `chat.completion` shapes.
- **D13** (`f34b690`) — Per-hop `cache_control` bypass evaluation (was request-global).
- **D14** (`a7085d9`) — Defer `res.writeHead(200)` until first chunk; early-error returns 502 JSON instead of 200 empty SSE.
- **D15** (`8ae77c3`) — ADR 0005 Amendment 2: cache key includes `max_tokens` / `top_p` / `stop` / `tool_choice`.
- **D16** (`bafa6d1`) — ADR 0004 Amendment 1: SPAWN_FAILED-with-chunks salvage (don't discard partial responses).
- **D17** (`cb86807`) — Alias routing SPOT via `models-registry.json`; `getProviderForModel` canonicalizes.
- **D18** (`82ff007`) — `/v1/models` populated from registry; 5 standard X-OLP-* headers on error responses.
- **D19** (`ed82e65`) — Cleanup batch: finish_reason validator, dead alignment.yml KNOWN_PROVIDERS removal, unused imports.
- **D20** (`d85a2dc`) — Docs drift: README/AGENTS/ADR forward-references annotated `📋 Planned`.

**Round-2 fold-in batch (13 findings):**
- **D21** (`1466d3a`) — `validateProvider` enforces `maxSpawnTimeMs` contract field.
- **D22** (`e10b7d7`) — ADR 0004 Amendment 2: soft triggers deferred to v1.x.
- **D23** (`7ef5510`) — `hints.cacheable` opt-out + 10MB cache entry size cap (ADR 0002 Amendment 3, ADR 0005 Amendment 3).
- **D24** (`f8348ad`) — Spawn-timeout race fix: post-loop `if (spawnTimedOut) throw SPAWN_TIMEOUT` closes the rejectNext-null window across all 3 plugins.
- **D25** (`cd391b1`) — Round-2 P3 docs batch.

**Round-3 fold-in batch (13 findings):**
- **D26** (`a281d3e`) — Soft-trigger startup warning, stderr propagation on error-chunk SPAWN_FAILED (codex+mistral), anthropic D4-observation header, streaming truncation marker.
- **D27** (`c3ba751`) — IR validator response_format + tool_choice checks, ADR 0005 Amendment 4 (cache_control IR vs body), `/v1/models` alias surfacing.
- **D28** (`4a238c9`) — Per-hop log observability: `chain_id`, `trigger_type`, `ir_request_hash`, `next_provider` on all 8 fallback log events.
- **D29** (`de9f3ca`) — Suite 17 port-collision flake fix: 16 test sites switched to OS-assigned `listen(0)`.
- **D30** (`5119b42`) — README env vars correctness, `docs/openai-spec-pin.md` v0.1 baseline.
- **D31** (`d6347e3`) — ADR amendment trio: F5 (ADR 0003 Amendment 1 substitute test strategy), F11 (ADR 0005 Amendment 5 Anthropic wire limitation), F13+F14 (ALIGNMENT.md Speculative-Candidate exception class).

**Round-4 fold-in batch (10 findings):**
- **D32** (`30de965`) — Provider auth env vars in README, X-OLP-* on early-return paths, ADR 0002 Amendment 4 ratifying `contractVersion`, dead OUTPUT_PARSE_ERROR removal, codex parser inline assumption labels.

**Round-5 fold-in batch (12 findings):**
- **D33** (`f784fdb`) — ALIGNMENT mistral `--output streaming` pin correction, deterministic `function_call` ID (cache key stability), `/health` per-provider snapshot, fallback-hop cache-hit X-OLP-Cache correctness, `CLAUDE.md` `phase_rolling_mode` policy formalization, `/v1/models` stable `created` timestamps.

**Round-6 final batch (14 findings; 4 closed, 9 filed as issues):**
- **D34** (`60570ef`) — ADR 0005 Amendment 6 (streaming singleflight v1.x deferral), array-field cache key normalization (`tools:[]` / `stop:[]` now collide with omitted), QUOTA_EXHAUSTED + RATE_LIMITED dead code removal (ADR 0004 Amendment 3), ADR 0005 Amendment 7 (conservative cache-key v0.1 trade-off).

### ADRs in scope

- **ADR 0001** — Project founding (Phase 1 founding doc; no amendments)
- **ADR 0002** — Plugin architecture (4 amendments — `maxSpawnTimeMs`, `cacheable`, `contractVersion` ratifications)
- **ADR 0003** — IR design (1 amendment — `__irRoundTripTest` removal + substitute test strategy)
- **ADR 0004** — Fallback engine (3 amendments — SPAWN_FAILED salvage, soft trigger deferral, hard-trigger taxonomy narrowing)
- **ADR 0005** — Cache layer (7 amendments — cache key expansions, cache_control IR-vs-body, cacheable + size cap, Anthropic wire limitation, streaming singleflight deferral, conservative cache-key v0.1 trade-off)
- **ADR 0006** — Provider inclusion (Tier framework; no amendments)
- **ALIGNMENT.md** — Speculative-Candidate plugin Rule 4 exception class added (D31)
- **CLAUDE.md** — `phase_rolling_mode` overlay added (D33)
- **`docs/openai-spec-pin.md`** — v0.1 baseline pinned (D30)

### Test growth

277 (pre-D10) → 416 (post-D34). 6 cold audit rounds reviewed code against ADR claims. Iron Rule v1.6 § 10.x dual-mode review discipline (Diff Review + Cold Audit) caught 78+ findings of which ~50 closed via implementation and ~28 deferred to GitHub issues.

### Known limitations carried to v1.x

17 GitHub issues filed for follow-up. Notably:
- **Streaming singleflight** (#16) — multi-concurrent identical streaming requests each spawn fresh CLI; buffered path participates in D4, streaming path doesn't (deferred via ADR 0005 Amendment 6).
- **maxConcurrent runtime enforcement** (#1) — declarative-only at v0.1.
- **X-OLP-Fallback-Detail debug header** (#7) — documented in ADR 0004, never emitted.
- **Soft triggers** (per ADR 0004 Amendment 2) — evaluation code exists but `quotaStatus()` polling not wired; configured thresholds inert at v0.1.

### Migration from OCP

OLP supersedes OCP per ADR 0001. The `scripts/migrate-from-ocp.mjs` migration tool is 📋 Planned (Phase 7).

## v0.1.0-bootstrap — 2026-05-23

### Phase 0 — Repo bootstrap (founding + post-codex-review hardening)

This is the founding commit set of OLP (Open LLM Proxy), a personal- and family-scale multi-provider LLM proxy that supersedes OCP. The trigger was Anthropic's 2026-05-14 announcement (effective 2026-06-15) splitting `claude -p` / Agent SDK / third-party agent traffic out of the Pro/Max subscription pool into a separate fixed monthly Agent SDK Credit pool.

**What lands at v0.1.0-bootstrap (final state on `main` as of 2026-05-23):**

- `ALIGNMENT.md` — OLP constitution. Three concurrent authorities (per-provider CLI / OpenAI spec / IR contract), 5 Rules, 4-tier Risk Tier Framework, Candidate-vs-Enabled provider inventory, one-shot triggered audits (2026-06-16 Anthropic post-split; 90-day Antigravity primary-source pin).
- `AGENTS.md` — multi-tool agent guidelines (inherits `~/.cc-rules/AGENTS.md`).
- `CLAUDE.md` — Claude-Code-specific session instructions + machine-readable `release_kit` overlay (Iron Rule 5.5).
- `README.md` — phase-aware skeleton with Candidate-vs-Enabled provider tables, API endpoint table, environment-variables table, response-headers spec, architecture overview, phase plan, migration-from-OCP outline. Placeholder content marked as such per phase.
- `docs/adr/` — 6 founding ADRs:
  - `0001-project-founding.md` — Mission, non-mission, narrow-scope supersession of OCP ADR 0005 (single-provider-sufficiency premise only; BYOK / no-spawn parts of ADR 0005 not inherited).
  - `0002-plugin-architecture.md` — `lib/providers/<name>.mjs` plug-in model with the Provider contract (name / models / auth / spawn / estimateCost / quotaStatus / healthCheck / hints). 8 candidate providers declared, 0 Enabled at v0.1.
  - `0003-intermediate-representation.md` — OLP-internal canonical IR between OpenAI-compat entry and provider plugins.
  - `0004-fallback-engine.md` — Trigger taxonomy (Hard / Soft / Deterministic-deferred / Cost-aware-deferred), idempotent-failure safety (first-chunk rule), chain advancement one-at-a-time, observability headers.
  - `0005-cache-cross-provider.md` — Cache key composition over `(provider, model, messages, ...)`, D1+D2+D3+D4 port from OCP v3.13.0.
  - `0006-provider-inclusion.md` — 4-tier Risk Framework, Candidate-vs-Enabled distinction, 8-provider candidate classification, Antigravity Tier A (evidence-backed, pending primary-source pin) — exclusion rests on (named prohibition + no cost advantage + reinstatement friction) combination; primary-source URL not yet pinned, follow-up tracked.
- `.github/PULL_REQUEST_TEMPLATE.md` — 8-radio Change Type taxonomy + per-type Authority Evidence sections + Iron Rule 10 reviewer checklist.
- `.github/workflows/alignment.yml` — CI blacklist (transitive `api.anthropic.com/api/oauth/usage` from OCP 2026-04-11 drift; Antigravity provider exclusion enforcement) + `models-registry.json` validator + commit-citation soft check (process-substitution form, no Bash subshell trap).
- `.github/workflows/release.yml` — Auto-release on tag push with `package.json`-vs-tag version match check (Iron Rule 5).
- `.github/workflows/test.yml` — Node 20/24 matrix; tolerates bootstrap-phase absence of `test-features.mjs` AND `scripts.test`.
- `models-registry.json` — minimal v0.1 stub with empty `providers: {}`, matching the 0-Enabled posture; populated by Phase audits as providers transition Candidate → Enabled.
- `package.json` — minimal: no `main`, no `scripts.test`, no `scripts.start` (those entries land alongside the real files in Phase 1).
- `.gitignore`, `LICENSE` (MIT), `CHANGELOG.md` — standard project boilerplate.

**Provider posture at v0.1.0-bootstrap (per ALIGNMENT.md § Provider Inventory):**

| Tier | Anticipated providers | v0.1 default state |
|---|---|---|
| D (eligible-for-default-enabled) | Anthropic, OpenAI Codex, Mistral Vibe | Candidate (transition gate: authority pin + plugin + Phase audit) |
| C (opt-in) | xAI Grok, Moonshot Kimi | Candidate |
| B (opt-in + consent) | MiniMax, Zhipu GLM, Alibaba Qwen | Candidate |
| A (excluded by default; constitutional-amendment-only re-inclusion) | Google Antigravity | Excluded; pending primary-source pin |

**Total Enabled at v0.1.0-bootstrap: 0.** Enablement is a Phase audit deliverable, not a bootstrap claim. This explicit zero is intentional and codified — a constitution that names providers as "default-enabled" while their CLI versions, output shapes, auth artifacts, and exit-code semantics are still TBD would violate Rules 1 (Cite First) and 3 (Match the Implementation).

**Review history for this version:**

1. **Initial internal review (Claude Opus, fresh-context, Iron Rule 10).** Verdict: APPROVE_WITH_MINOR — 2 minor items (alignment.yml heredoc indent breaking bash parse on failure path; AGENTS.md cross-reference to ADR 0003 imprecise). Both folded in before the founding commit.

2. **External review #1 (OpenAI Codex CLI, no spec framing).** Verdict: 6 substantive findings beyond internal review.
   - Provider Inventory split into Candidate vs Enabled (the v0.1 constitution had declared `anthropic` / `openai` / `mistral` as Tier D default-enabled while their Authority pins were still `TBD at Phase N spawn` — direct violation of Rule 1 / Rule 3 against the constitution's own text).
   - Antigravity Tier A downgraded to "evidence-backed, pending primary-source pin" (secondary reports disagree on blast radius; Google FAQ URL not yet primary-source-pinned).
   - ADR 0001 supersession scope narrowed (OLP rejects ADR 0005's "BYOK + no spawn" qualifiers, which originally applied to a commercial pivot; OLP is non-commercial and spawn-binary by design).
   - Anthropic post-2026-06-15 one-shot audit scheduled (annual May 14 audit would leave Anthropic re-eval ~year late after the split takes effect).
   - Tier A "permanent" language unified across docs (constitution and ADR 0006 had disagreed).
   - OpenAI Tier D wording softened ("maintainer signal indicates low risk; formal ToS pin pending" — Discussion #8338 is a posture statement, not a formal ToS blessing).

3. **External review #2 (OpenAI Codex CLI, second pass after review #1 fold-in).** Verdict: 6 additional substantive findings — the self-consistency trap recurred when fold-in of review #1 was scoped only to files codex explicitly named. Round #2 caught:
   - ADR 0002 still claimed "three default-enabled" while ALIGNMENT.md said zero Enabled — accepted ADR contradicting constitution.
   - `release.yml` would publish stale `## v0.1.0-bootstrap` notes that ignored the "Unreleased" amendments — fixed by consolidating amendments into the v0.1.0-bootstrap section (this entry).
   - `package.json` advertised `main` / `scripts.test` / `scripts.start` for files that don't exist — `npm test` / `npm start` failed locally. Removed all three; will return in Phase 1 alongside the real files.
   - `models-registry.json` documented as SPOT but missing — minimal stub added.
   - `alignment.yml` commit-citation soft check had a Bash subshell trap (`while` in pipe loses `WARN=1` mutation) — fixed via process substitution `< <(...)`.
   - Tier A "permanent" wording still inconsistent across `alignment.yml` workflow text, ADR 0006 Consequences section, and the rest of the docs — unified throughout.

   All 6 round-#2 findings folded in this consolidated v0.1.0-bootstrap state.

**Reviewer framing learning (recorded permanently in `~/.cc-rules/memory/learnings/ai_reviewer_self_consistency_trap.md`):** Internal AI reviewers framed on a shared source-of-truth miss bugs in the source-of-truth itself. The self-consistency trap recurred during the fold-in of round #1 — when an external reviewer surfaces findings, the fold-in must grep the entire repo for the same concept, not only edit the files the reviewer named. Round #2 caught what round #1's fold-in missed for exactly this reason. Both lessons updated in the cross-machine memory.

**Iron Rule 10 status:** Satisfied. Initial reviewer = internal opus (independent from drafters). Round #1 reviewer = external codex (independent from drafters and from internal opus). Round #2 reviewer = external codex (independent from the round #1 fold-in implementer). The maintainer's role across all three reviews was approver, not author. The drafting agents and fold-in agents were never the same as the reviewers for any of the three passes.

**Next:** Phase 1 lands `server.mjs` skeleton + IR + Anthropic provider plugin + cache D1+D4 port from OCP. At that point, `package.json` regains `main` + `scripts.test` + `scripts.start`, `test-features.mjs` lands, `models-registry.json` populates its first `providers.anthropic` entry, and Anthropic transitions Candidate → Enabled. Per spec §6 phase plan.

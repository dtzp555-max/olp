# Changelog

All notable changes to OLP land here. Per `CLAUDE.md` release_kit overlay, this file is the source of truth for GitHub release notes.

## Unreleased

### D38 — maxConcurrent runtime enforcement (issue #1)

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

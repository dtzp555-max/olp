# Changelog

All notable changes to OLP land here. Per `CLAUDE.md` release_kit overlay, this file is the source of truth for GitHub release notes.

## Unreleased

### Phase 1 — Provider plugins + cache + fallback engine + P1 hardening

- **D10 (P1 round-3 hardening from external Codex review).** Three production-blocking defects from the Phase 1 round-3 review folded in:
  - **`providers.enabled` config wired through `loadProviders()`** (ADR 0002 § Disable model). `loadFallbackConfigSync()` now returns a tri-field shape `{ chains, soft_triggers, providersEnabled }`; `server.mjs` reads `_startupConfig.providersEnabled` at startup and passes it to `loadProviders()`. Empty / missing config → 0 enabled providers → `503 no_enabled_provider`, matching the v0.1 0-Enabled posture. `__setProvidersEnabled` / `__resetProvidersEnabled` test seams added.
  - **Real SSE streaming on single-hop cache-miss** (ADR 0003 entry adapter pattern). New `handleChatCompletions` branch when `ir.stream === true && chain.length === 1 && !bypassCache && !preCheckHit`: `for await (const irChunk of provider.spawn(...))` writes SSE per chunk via `res.write(irChunkToOpenAISSE(...))`, accumulates chunks for `cacheStore.set` on completion. First-chunk rule preserved (error-before-first-chunk → `sendError(502)`; error-after-first-chunk → truncated `res.end()`). Multi-hop chains still buffer (`executeWithFallback` path) to maintain fallback safety.
  - **Spawn timeout hard trigger** (ADR 0004 § Trigger taxonomy bullet 4). `SPAWN_TIMEOUT` added to `PROVIDER_ERROR_CODES` and `HARD_TRIGGER_CODES`. All three provider plugins (`anthropic.mjs` / `codex.mjs` / `mistral.mjs`) wrap their spawn drain loop with `setTimeout` (default 600_000ms, configurable via `hints.maxSpawnTimeMs`); on fire, `proc.kill('SIGTERM')` + reject pending drain promise with `ProviderError(..., 'SPAWN_TIMEOUT')`. Timer cleared in `finally` block; `resolveNext` / `rejectNext` atomically nulled to prevent late-fire double-settle.
- **Test suite: 277 → 288 (+11).** New Suite 14 (providers.enabled wiring, 4 tests), Suite 15 (streaming cache-miss real-time, 3 tests including arrival-count assertion proving real streaming architecturally), Suite 16 (spawn timeout, 4 tests including full 2-hop chain advancement from timed-out primary).

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

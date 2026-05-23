# Changelog

All notable changes to OLP land here. Per `CLAUDE.md` release_kit overlay, this file is the source of truth for GitHub release notes.

## Unreleased — 2026-05-23 (governance amendments per external codex review)

External AI review (OpenAI Codex CLI) of the bootstrap governance surfaced six substantive findings beyond what the internal opus reviewer caught. All six folded in this turn:

1. **Provider Inventory split into Candidate vs Enabled** — ALIGNMENT.md previously listed `anthropic` / `openai` / `mistral` as Tier D default-enabled while their Authority pins were still `TBD at Phase N spawn`. This violated Rule 1 (Cite First) and Rule 3 (Match the Implementation). The v0.1 founding commit now ships **zero Enabled Providers**; all 8 providers are Candidate. Enablement is a Phase audit deliverable, not a bootstrap claim. (ALIGNMENT.md § Provider Inventory; README.md § Supported Providers.)
2. **Antigravity Tier A evidence strength downgraded to "evidence-backed, pending primary-source pin"** — ADR 0006 previously framed the Antigravity exclusion as a closed case based on secondary reports. The reports actually disagree on blast radius (piunikaweb 03-02 says AI-tier only; piunikaweb 02-23, OpenClaw issue #14203, VentureBeat say broader). The Google FAQ language naming OpenClaw/OpenCode/Claude Code is cited from secondary sources only; the original FAQ URL or archival snapshot has not been primary-source-pinned. The exclusion is still active by default, but the constitutional weight now matches the evidence: secondary-sourced. Primary-source pinning is tracked as an open one-shot audit task with a 90-day Tier-reconsideration trigger.
3. **ADR 0001 supersession scope honesty** — ADR 0001 previously claimed OLP is "the structural shape ADR 0005 endorsed: a separate repo with multi-provider design baked in from day one." But ADR 0005's separate-repo recommendation came with two qualifiers OLP rejects: "BYOK from day one" and "no `cli.js` spawn." OLP rejects both — it is non-commercial and explicitly spawn-binary. The supersession is now narrowly scoped to "single-provider-sufficiency premise only"; the BYOK / no-spawn parts of ADR 0005 are not inherited.
4. **Anthropic post-2026-06-15 one-shot audit scheduled** — ALIGNMENT.md's annual 14 May audit would have left the Anthropic Tier re-evaluation almost a year late. Added a one-shot audit for 2026-06-16 (or first Anthropic billing-cycle close) that verifies the post-effective-date behaviour and updates ADR 0006 + Authority pin.
5. **Tier A "permanent" language unified across docs** — ALIGNMENT.md and ADR 0006 disagreed: one said "permanently excluded," the other said "amendment-procedure-revisable." Unified as "Excluded by default. Cannot be re-included unless ADR 0006 is superseded or amended with new primary-source evidence." The amendment procedure remains available; "Tier A" sets the bar for re-inclusion at constitutional-amendment level, not at routine PR level.
6. **OpenAI Tier D wording softened** — ADR 0006 previously described Codex Discussion #8338 as "maintainer confirmed permissive." The discussion is actually a maintainer posture statement ("OSS projects like OpenCode are doing things similar") with an explicit "I'm an engineer, not a lawyer" caveat. Now described as "maintainer signal indicates low risk; formal ToS pin pending" with the pin tracked as a follow-up audit task.

Files changed: `ALIGNMENT.md`, `README.md`, `docs/adr/0001-project-founding.md`, `docs/adr/0006-provider-inclusion.md`. No code, no CI workflow, no PR template change.

Reviewer for this amendment: OpenAI Codex CLI (external, fresh-context). Iron Rule 10 satisfied — the internal opus reviewer was not the source of the findings, and the maintainer is not the author of the underlying critique. The amendment's substantive changes are direct fold-ins of the reviewer's six findings; the internal opus reviewer's earlier APPROVE_WITH_MINOR verdict is therefore narrowed retroactively to "APPROVE conditional on these amendments" for the purposes of the v0.1 governance bootstrap.

## v0.1.0-bootstrap — 2026-05-23

### Phase 0 — Repo bootstrap

This is the founding commit of OLP (Open LLM Proxy), a personal- and family-scale multi-provider LLM proxy that supersedes OCP. The trigger was Anthropic's 2026-05-14 announcement (effective 2026-06-15) splitting `claude -p` / Agent SDK / third-party agent traffic out of the Pro/Max subscription pool into a separate fixed monthly Agent SDK Credit pool.

**What lands in this commit:**

- `ALIGNMENT.md` — OLP constitution. Three concurrent authorities (per-provider CLI / OpenAI spec / IR contract), 5 Rules, 4-tier Risk Tier Framework, 8-provider inventory.
- `AGENTS.md` — multi-tool agent guidelines (inherits `~/.cc-rules/AGENTS.md`).
- `CLAUDE.md` — Claude-Code-specific session instructions + machine-readable `release_kit` overlay (Iron Rule 5.5).
- `README.md` — phase-aware skeleton with provider inventory, API endpoint table, environment-variables table, response-headers spec, architecture overview, phase plan, migration-from-OCP outline. Placeholder content marked as such per phase.
- `docs/adr/` — 6 founding ADRs:
  - `0001-project-founding.md` — Mission, non-mission, and supersession of OCP ADR 0005 (No Multi-Provider).
  - `0002-plugin-architecture.md` — `lib/providers/<name>.mjs` plug-in model with the Provider contract (name / models / auth / spawn / estimateCost / quotaStatus / healthCheck / hints).
  - `0003-intermediate-representation.md` — OLP-internal canonical IR between OpenAI-compat entry and provider plugins.
  - `0004-fallback-engine.md` — Trigger taxonomy (Hard / Soft / Deterministic-deferred / Cost-aware-deferred), idempotent-failure safety, first-chunk rule, chain advancement.
  - `0005-cache-cross-provider.md` — Cache key composition over `(provider, model, messages, ...)`, D1+D2+D3+D4 port from OCP v3.13.0.
  - `0006-provider-inclusion.md` — 4-tier Risk Framework, 8-provider classification, Antigravity exclusion (named prohibition + no cost advantage + reinstatement friction; *not* whole-account ban — Google AI services tier only per piunikaweb 2026-03-02 OpenClaw exec confirmation).
- `.github/PULL_REQUEST_TEMPLATE.md` — 8-radio Change Type taxonomy + per-type Authority Evidence sections + Iron Rule 10 reviewer checklist.
- `.github/workflows/alignment.yml` — CI blacklist (transitive `api.anthropic.com/api/oauth/usage` from OCP 2026-04-11 drift; Antigravity provider exclusion enforcement) + `models-registry.json` validator + commit-citation soft check.
- `.github/workflows/release.yml` — Auto-release on tag push with `package.json`-vs-tag version match check (Iron Rule 5).
- `.github/workflows/test.yml` — Node 20/24 matrix; tolerates bootstrap-phase absence of `test-features.mjs`.
- `package.json`, `.gitignore`, `LICENSE` (MIT), `CHANGELOG.md` — standard project boilerplate.

**Provider inventory at bootstrap:**

| Tier | Providers |
|---|---|
| D (default-enabled) | Anthropic, OpenAI Codex, Mistral Vibe |
| C (opt-in, no consent) | xAI Grok, Moonshot Kimi |
| B (opt-in, explicit consent) | MiniMax, Zhipu GLM, Alibaba Qwen |
| A (permanently excluded) | Google Antigravity |

**Governance gate at bootstrap:**

- Fresh-context independent reviewer (opus, Iron Rule 10) audited all 15 governance files against the OLP v0.1 spec and OCP precedent. Verdict: APPROVE_WITH_MINOR. Two minor findings folded in before this commit (alignment.yml heredoc indentation fix; AGENTS.md ADR-0003 reference clarification).

**Next:** Phase 1 lands `server.mjs` skeleton + IR + Anthropic provider plugin + cache D1+D4 port from OCP. Per the spec §6 phase plan.

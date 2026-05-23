# Changelog

All notable changes to OLP land here. Per `CLAUDE.md` release_kit overlay, this file is the source of truth for GitHub release notes.

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

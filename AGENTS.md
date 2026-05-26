Inherits: @~/.cc-rules/AGENTS.md

# OLP — Open LLM Proxy — Agent Guidelines

**Scope**: the `dtzp555-max/olp` repository.
**Audience**: any AI coding agent (Claude Code / Cursor / OpenCode / Copilot / Codex / Gemini) touching OLP source.

---

## What this project is

OLP (Open LLM Proxy) is a personal- and family-scale multi-provider LLM proxy. It exposes a single OpenAI-compatible HTTP endpoint (`/v1/chat/completions`) and routes each request to one of N provider plugins, each of which spawns the corresponding provider CLI (e.g. `claude -p`, `codex exec --json`, `vibe --prompt`). An IR (Intermediate Representation) normalizes between the entry surface and each provider's native shape. Intelligent fallback chains advance one provider at a time on configured triggers; content-addressed caching minimizes quota consumption.

OLP supersedes OCP (Open Claude Proxy) as of v1.0. The trigger was the 2026-05-14 Anthropic announcement (effective 2026-06-15) splitting CLI/Agent SDK traffic out of the Pro/Max subscription pool — OCP's foundational assumption ("subscription = unlimited within rate limits") broke for Anthropic on that date. Spreading risk across multiple providers is the structural response.

OLP is **not** a commercial multi-tenant SaaS, **not** an enterprise gateway competing with LiteLLM/OpenCode/CLIProxyAPI on breadth, **not** a model-capability router ("route to the smartest model"), and **not** a conversation-state store (clients manage their own state). See `ALIGNMENT.md` Core Principle and `docs/adr/0001-project-founding.md`.

Runtime: Node.js (ESM, `.mjs` throughout). No build step. No bundler. `server.mjs` is the single executable entrypoint. The architecture is spawn-binary: OLP spawns the real provider CLI for every uncached request.

---

## Stack

- Node.js >=18, native ESM modules
- `http`/`https` built-ins for the proxy core (no Express, no Fastify)
- `models-registry.json` as the single source of truth for `(provider, model) → metadata` mappings (analogous to OCP's `models.json`; SPOT discipline will be codified in a Phase 1 ADR — OLP ADR 0003 is currently the IR design, not the SPOT codification)
- GitHub Actions for CI (`alignment.yml`, `release.yml`, `test.yml`)
- `gh` CLI assumed for PR creation and release automation
- No TypeScript. No test framework beyond `test-features.mjs` (run via `npm test`; CI workflow `.github/workflows/test.yml`). Keep dependencies minimal.

---

## Key files to know

- `server.mjs` — HTTP listener, entry surface (`/v1/chat/completions`, `/health`, `/v1/models`, etc.), plugin loader, request dispatch. Governed by `ALIGNMENT.md`.
- `lib/providers/` — per-provider plugins. Each file (`anthropic.mjs`, `openai.mjs`, `mistral.mjs`, …) implements the Provider contract documented in ADR 0002.
- `lib/ir/` — Intermediate Representation definition + serializers. Governed by ADR 0003.
- `lib/cache/` — content-addressed cache layer (per-key isolation, `cache_control` bypass, chunked stream replay, singleflight). Governed by ADR 0005.
- `lib/fallback/` — fallback engine (trigger detection, chain advancement, idempotent-failure safety, header annotation). Governed by ADR 0004.
- `lib/keys.mjs` — multi-key auth, per-key namespacing, identity layer. Carries OCP's per-key isolation model into OLP. **✅ Phase 2 — D44 core + D45 server integration + D46 owner gating shipped (validateKey on every /v1/* + /health; chain filtered by providers_enabled; touchLastUsed fires post-response; /health payload trimmed for non-owner; X-OLP-Fallback-Detail gated by fallback_detail_header_policy).**
- `bin/olp-keys.mjs` — keygen CLI bootstrap surface per ADR 0007 § 9.1. **✅ Shipped at D47.** Subcommands: `keygen [--owner|--name=X|--providers=csv|--force]`, `list [--owner-only|--include-revoked]`, `revoke --id=X`. Plaintext token printed once on keygen. Installed via `package.json bin` so `npx olp-keys ...` works (also `npm run olp-keys ...`).
- `lib/audit.mjs` — append-only ndjson audit per ADR 0007 § 6.2 + § 8 + daily rotation per ADR 0008 § 5. **✅ D45 (append) + D52 (rotation) shipped. `appendAuditEvent` fires per /v1/chat/completions + /v1/models + /v0/management/* request (warn + 1 retry; no memory buffer). `_maybeRotateAudit` (sync) is called BEFORE the append when the UTC date changes; renames live → `audit-YYYY-MM-DD.ndjson`. Optional external cron tool `bin/olp-audit-rotate.mjs` for exact-at-midnight rotation.**
- `bin/olp-audit-rotate.mjs` — external audit rotation cron tool per ADR 0008 § 5.2. **✅ D52 — `runCli(argv, { out, err })` invocable + main-guard for direct execution. Installed via `package.json bin` so `npx olp-audit-rotate` works (also `npm run olp-audit-rotate`). Idempotent + safe alongside in-server first-append trigger.**
- `lib/audit-query.mjs` — audit ndjson aggregate query layer per ADR 0008 § 4. **🟡 D49 — discoverAuditFiles + readAuditWindow + aggregateRequests + topFallbackChains + spendTrendDaily + cacheHitRateWindow shipped. Cross-file walk over `audit.ndjson` (live) + `audit-YYYY-MM-DD.ndjson` (rotated). PII guard: aggregate shapes never include message content. In-memory scan per request (ADR 0008 Lane 2 = A; SQLite hybrid deferred to ADR 0007 § 13 trigger).**
- `dashboard.html` — owner-only multi-provider dashboard (4 panels: per-provider quota / 24h request+cache+fallback / 30d spend trend SVG sparkline / top-10 fallback chains). **✅ D51 — full UI shipped at repo root per ADR 0008 § 6. Vanilla HTML + JS + fetch (no build step, no framework, no CDN). 30s page poll with `document.visibilityState` pause/resume. Served by `/dashboard` route in server.mjs owner-only_block. Cached in memory at first request via `_loadDashboardHtml`.**
- `models-registry.json` — single source of truth for `(provider, model) → metadata`. SPOT.
- `ALIGNMENT.md` — the constitution. Binding for any plugin / entry-surface / IR change.
- `docs/adr/` — Architecture Decision Records. Read the index in `docs/adr/README.md` before proposing governance, SPOT, or contract changes.
- `.github/workflows/alignment.yml` — CI blacklist grep + per-provider citation soft check; fails the build on known-hallucinated tokens.
- `CLAUDE.md` — Claude-Code-specific session instructions + `release_kit` overlay (Iron Rule 5.5).

**Implementation status note (as of 2026-05-27):** Phase 5 (Quota Probes + Dashboard Enrichment) is closed at v0.5.0 + v0.5.1 hotfix. The shipped set includes all Phases 1–5 deliverables. v0.5.1 hotfix (2026-05-27) fixes three codex review findings: F1 (doctor check bypassed backoff by calling `_probeOnce` directly — now routes through `quotaStatus()`), F2 (200 with empty `anthropic-ratelimit-*` headers was cached as live — minimum-viable-schema gate added), F3 (null collapsed all failure modes — `probe_status:'unreachable'` shape + `failure`/`failure_kind`/`backoff_until` fields added). See ADR 0008 Amendment 2 + ADR 0013 Rule 3/5 clarifications. Phase 6 is next (per CLAUDE.md `release_kit.current_phase`).

---

## Project-specific constraints

- **`ALIGNMENT.md` is binding.** Any PR touching a provider plugin, the entry surface, or the IR must cite the relevant authority (provider CLI documentation / OpenAI spec URL / ADR number) in the commit body and PR description. See `CLAUDE.md` § "Hard requirements for plugin / server.mjs changes" and `ALIGNMENT.md` Rules 1, 2, 5.
- **Alignment CI is not suppressible.** The `alignment.yml` workflow greps for known-hallucinated tokens (currently carrying OCP's `api.anthropic.com/api/oauth/usage` as a transitive guardrail) and runs per-provider sanity checks. Adding new blacklist tokens is done via PR amendment to `alignment.yml`; removing entries requires an `ALIGNMENT.md` amendment PR.
- **No self-approval.** Implementation author cannot merge their own PR (Iron Rule 10). A fresh-context reviewer must open the cited authority and confirm in the review comment.
- **`models-registry.json` is the only place to add/edit `(provider, model)` metadata.** Do not touch hardcoded model maps in `server.mjs`, `lib/providers/*.mjs`, or `setup.mjs` (📋 `setup.mjs` is planned, not yet authored). The OLP ADR that codifies this SPOT discipline lands in Phase 1 (OCP's ADR 0003 — `models.json` SPOT — is the precedent; OLP needs its own SPOT ADR because the registry shape differs).
- **Provider plugins follow the contract in ADR 0002.** A new provider plugin must implement every method on the Provider contract (`name`, `displayName`, `models`, `auth`, `spawn`, `estimateCost`, `quotaStatus`, `healthCheck`, `hints`). Partial implementations are unalignable per `ALIGNMENT.md` Rule 4.
- **No anti-fingerprinting.** OLP is honest about spawning the real CLI. If a provider detects subscription-spawn proxying and bans it, the response is to drop the provider per ADR 0006, not to mask the spawn.
- **No conversation state.** OLP is a stateless proxy. Memory / continuity is the client's responsibility (see ADR 0001 § Non-mission).

---

## Release protocol

OLP follows the machine-readable `release_kit:` overlay in `CLAUDE.md` (Iron Rule 5.5). Before any version bump or tag push, re-read that YAML block and walk every item in `new_feature_doc_expectations` and `bootstrap_quirk_policy`. Tag push triggers `.github/workflows/release.yml`, which creates the GitHub Release automatically — do not create the release manually.

Version is sourced from `package.json`; changelog from `CHANGELOG.md`; user-facing docs from `README.md`. The Supported Providers table in `README.md` is sourced from `models-registry.json` per the overlay; do not hand-edit it out of sync.

---

## Handoff expectations

A fresh session picking up OLP work should read, in order:

1. This file (`AGENTS.md`).
2. `ALIGNMENT.md` — constitution; non-optional.
3. `CLAUDE.md` — tool-specific instructions and `release_kit` overlay.
4. `docs/adr/` — most recent ADRs first; they explain why the current structure exists. Founding ADRs 0001–0006 are the OLP-bootstrap set.
5. `~/.cc-rules/memory/projects/olp_v0_1_spec.md` — the v0.1 spec (authoritative for OLP scope until v1.0 ships).
6. `~/.cc-rules/memory/auto/MEMORY.md` — cross-machine memory index.

Only after these should the session touch code.

---

**Authors:** project maintainer (with AI drafting assistance).

# Architecture Decision Records — OLP

This directory holds the OLP Architecture Decision Records (ADRs) — short documents that capture the **why** behind structural choices.

Read these before proposing governance, plug-in contract, IR, fallback, cache, or provider-inclusion changes.

## Numbering

ADRs in OLP start at `0001` (the project's founding decision). OLP did not inherit the `0001` placeholder convention OCP used; the project starts on a fresh numbering line.

New ADRs increment from the highest existing number. Filenames are `NNNN-<short-slug>.md`.

## Index

| ADR | Title | What it covers |
|---|---|---|
| [0001](0001-project-founding.md) | Project Founding | Why OLP exists (the 2026-06-15 Anthropic billing-split trigger), mission + non-mission boundaries, explicit supersession of OCP ADR 0005 "No Multi-Provider". |
| [0002](0002-plugin-architecture.md) | Plugin Architecture for Providers | The `lib/providers/<name>.mjs` plug-in model, the Provider contract (name / models / auth / spawn / estimateCost / quotaStatus / healthCheck / hints), static in-tree registry, why-not full external plugin discovery. |
| [0003](0003-intermediate-representation.md) | Intermediate Representation (IR) Design | The OLP-internal canonical request/response shape between the OpenAI-compat entry surface and each provider plugin. v1.0 IR fields, IR-vs-OpenAI-vs-native-provider three-shape model, IR is not exposed externally. |
| [0004](0004-fallback-engine.md) | Fallback Engine Semantics & Safety | Trigger taxonomy (Hard / Soft / Deterministic-deferred / Cost-aware-deferred), idempotent-failure safety (first-chunk rule), chain advancement one-at-a-time, observability headers. |
| [0005](0005-cache-cross-provider.md) | Cache Layer Cross-Provider Design | Cache key composition over `(provider, model, messages, …)`, per-model isolation, D1+D2+D3+D4 port from OCP v3.13.0, cross-provider fallback cache behaviour (correct miss). |
| [0006](0006-provider-inclusion.md) | Provider Inclusion / Exclusion + Risk-Tier Framework | The 4-tier classification (A excluded by default / B explicit consent / C opt-in / D eligible-for-default-enabled), Candidate-vs-Enabled distinction, current v0.1 candidate inventory (0 Enabled), Antigravity exclusion rationale (named prohibition + no cost advantage + reinstatement friction; pending primary-source pin), consent UX, future provider addition procedure. |
| [0007](0007-multi-key-auth.md) | Multi-Key Auth (`lib/keys.mjs`) | Phase 2 design ADR (D43-B, 2026-05-25). Option 2 (filesystem manifest at `~/.olp/keys/<key-id>/manifest.json`) + opaque `olp_<32-byte>` token + SHA-256 hash. Owner / guest / anonymous tier gating with explicit `config.json auth.allow_anonymous` (default false). Bootstrap keygen command surface + `OLP_OWNER_TOKEN` env override with stable synthetic `key_id`. Audit ndjson append-only at `~/.olp/logs/audit.ndjson`, warn+1-retry on append failure. Rejects direct SQLite port at v0.2.0 due to Node baseline (`engines >=18` + CI 20/24 vs `node:sqlite` added 22.5.0 / RC); Option 3 hybrid documented as forward path when Phase 3+ Dashboard / SQL-aggregate quota arrives. |
| [0008](0008-dashboard-and-audit-query.md) | Dashboard + Audit Query Layer | Phase 3 design ADR (D48, 2026-05-25). Static HTML dashboard + vanilla JS + fetch (no build step). In-memory ndjson scan for aggregate queries (O(N) per call; family-scale acceptable; defers SQLite migration to Option 3 hybrid trigger). Daily audit rotation `audit-YYYY-MM-DD.ndjson` on first append after UTC midnight; cross-file query layer for rolling 30-day windows. Owner-only gating on `/dashboard` + 3 `/v0/management/*` JSON endpoints reusing ADR 0007 § 7 auth model. 30s page poll (no SSE infra). Panels: per-provider quota / 24h request+cache+fallback / 30d spend trend / top-N fallback chains per spec § 4.6. Opens ADR 0007 § 12 Phase 3 deferral (Dashboard + audit query + rotation). |
| [0009](0009-interactive-mode-path-placeholder.md) | Anthropic Interactive-Mode Path (Placeholder) | Placeholder ADR (2026-05-25, Draft) — blocked on OCP ADR 0007 P0 experiment outcome. Records the maintainer's "wait + port" decision: do NOT independently implement; ride OCP's P0 result. If P0 confirms Transport A (stdio NDJSON) or B (PTY) bills as subscription rather than Agent SDK credit, port to OLP `lib/providers/anthropic.mjs` (Option 1 parallel impl, or Option 2 OCP-as-backend; decision deferred to P0-resolution time). If P0 fails on both, shelve. No Phase 4 D-day scheduled until P0 lands AND maintainer issues explicit "go" naming this ADR. |
| [0010](0010-phase-4-charter-operator-and-client-ux.md) | Phase 4 Charter — Operator + Client UX | Phase 4 scope ratification (2026-05-26, Accepted). Phase 4 = operator + client UX (SSE heartbeat / `olp` CLI + doctor / `olp-connect` zero-config + Telegram-Discord plugin + IDE docs bundle). ~13 D-days, D60 → v0.4.0. Records the explicit decision to DEFER `/v1/messages` (Anthropic-shape entry surface) on the rationale that under ADR 0009 P0 failure it provides no billing benefit AND degrades worse on fallback than OpenAI-shape clients. Re-open trigger: ADR 0009 P0 success + maintainer-named family CC user. Also closes the OCP-OLP port co-host ambiguity from ADR 0001 (default `OLP_PORT` 3456 → 4567). |
| [0011](0011-anonymous-key-deployment-context.md) | Anonymous-Key Deployment-Context Limits (Trusted-LAN Invariant) | D70 (2026-05-26, Accepted). Codifies the trust posture for `/health.anonymousKey` opt-in field (D69) + `bin/olp-connect` zero-config consumer (D68). Three-prerequisite gate (`auth.advertise_anonymous_key=true` + `auth.allow_anonymous=true` + an active key with `plaintext_advertise` field). Guest-tier-only restriction (`createKey()` + CLI reject owner+advertise). Trusted-LAN deployment invariant (loopback / RFC1918 / tailnet / `.local` / `.internal` — soft constraint at v0.4.0; hard enforcement deferred until OLP gains a public-deployment recipe). Re-evaluation trigger: any "expose to public internet" README mode. |

## When to write a new ADR

Open one whenever:

- A structural rule is being added or changed (e.g., new IR field, new trigger type, new cache-key composition).
- A new provider plugin is being proposed (per ADR 0002 + ADR 0006 — ADR is a hard prerequisite for plugin merge).
- A decision encodes a lesson from an external event (provider policy change, drift incident).
- A future contributor reading the code alone could plausibly undo or re-litigate the choice.

Skip ADRs for routine implementation choices (algorithm pick, naming) — those belong in commit messages.

## Format

Keep ADRs short — Context / Decision / Consequences / Alternatives is the standard skeleton. Cite incidents, PRs, or commits where useful. Length per ADR ~150–250 lines; longer than that, split.

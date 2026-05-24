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

## When to write a new ADR

Open one whenever:

- A structural rule is being added or changed (e.g., new IR field, new trigger type, new cache-key composition).
- A new provider plugin is being proposed (per ADR 0002 + ADR 0006 — ADR is a hard prerequisite for plugin merge).
- A decision encodes a lesson from an external event (provider policy change, drift incident).
- A future contributor reading the code alone could plausibly undo or re-litigate the choice.

Skip ADRs for routine implementation choices (algorithm pick, naming) — those belong in commit messages.

## Format

Keep ADRs short — Context / Decision / Consequences / Alternatives is the standard skeleton. Cite incidents, PRs, or commits where useful. Length per ADR ~150–250 lines; longer than that, split.

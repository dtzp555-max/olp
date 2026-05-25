# ADR 0010 — Phase 4 Charter: Operator + Client UX

**Status:** Accepted (Phase 4 open as of 2026-05-26)
**Date:** 2026-05-26
**D-day:** D60 (charter + default port change)

---

## Context

Phases 1 — 3 shipped OLP's structural core: HTTP entry surface, IR, provider plugins, fallback engine, content-addressed cache (including streaming-path singleflight at D57+D58 → v0.3.2), multi-key auth + audit ndjson + daily rotation, owner-only management endpoints + dashboard. v1.x roadmap items #1 / #2 / #4 / #7 are closed. Items #3 / #5 / #6 remain trigger-gated.

Two complementary brainstorm passes (2026-05-26) — a comprehensive OCP feature audit + a multi-provider proxy / IDE integration prior-art survey — converged on a clear gap: **OLP's operator and client surfaces are 0% inherited from OCP**. Today OLP has `bin/olp-keys` and `bin/olp-audit-rotate` as the entire operator CLI, no `olp doctor` / no `olp-connect`, no Telegram/Discord integration, no SSE heartbeat for long-running streams behind reverse proxies. Family members get OLP API keys via out-of-band paste, point their IDEs at OLP via the README's one-line example, and discover failure modes via curl. OCP's UX worked because of a load-bearing combination: README `paste-this-prompt-to-Claude-Code` instructions + machine-readable `ocp doctor next_action.ai_executable[]` + `ocp-connect` zero-config LAN setup + `/health.anonymousKey` self-advertising token + `/ocp` Telegram slash commands. **Phase 4 brings these forward as OLP-native primitives.**

A separate strategic decision — should OLP add `/v1/messages` (Anthropic-shape entry surface) for Claude Code support — was considered and **rejected for Phase 4** (see § "Out of Phase 4 scope" below). The decision is recorded with an explicit re-open trigger.

---

## Decision

Phase 4 scope is **Operator + Client UX**. The phase opens 2026-05-26 with D60 (this charter + default port change). Phase 4 close ships v0.4.0; per `CLAUDE.md release_kit.phase_rolling_mode`, the close PR is maintainer-triggered.

### In scope — Phase 4 D-day plan (~13 D-days)

| D-day | Deliverable | Authority | Estimate |
|---|---|---|---|
| **D60** | Default port `3456 → 4567` + this ADR 0010 charter + README / CHANGELOG / ADR 0001 + ADR 0008 amendments | This charter | 0.5d |
| **D61 — D63** | SSE heartbeat (opt-in via `streaming.heartbeat_interval_ms` config; eager-headers-post-spawn; `X-Accel-Buffering: no` constant) + `recentErrors[20]` ring buffer + `/status` combined endpoint | Port OCP `server.mjs:660-685` + `301-358` + `1151-1188`; OCP `docs/superpowers/specs/2026-04-25-47-sse-heartbeat-design.md` | 2.5d |
| **D64 — D67** | `olp` Node-based CLI scaffold (subcommands `status / health / usage / models / logs / cache / providers / chain show / restart / doctor`) + `olp doctor` machine-readable `next_action.ai_executable[]` framework + one fix-template per shipped provider plugin | Port OCP `ocp` bash wrapper (translated to Node — bash dep on python3 is a known fragile point) + OCP `scripts/doctor.mjs` framework | 4d |
| **D68 — D70** | `olp-connect <ip>` client-side IDE auto-config (Cline / Continue.dev / Cursor / Aider / Claude Code / OpenClaw detection) + `/health.anonymousKey` field (opt-in via `auth.advertise_anonymous_key` config; default off) + ADR 0011 (anonymous-key deployment-context limits — trusted-LAN-only invariant explicit) | Port OCP `ocp-connect` + `server.mjs:1454,1488` | 3d |
| **D71 — D73** | `olp-plugin/` (OpenClaw gateway plugin for `/olp` Telegram/Discord slash commands; subcommand parity with `olp` CLI minus mutations) + `docs/integrations/{continue.md,cline.md,cursor.md,aider.md,claude-code.md,openclaw.md}` IDE setup docs | Port OCP `ocp-plugin/index.js`; cross-ref Prior-Art § 3 + § 4 | 3d |
| **close** | v0.4.0 release PR — `package.json` bump, CHANGELOG promotion, `release_kit.phase_rolling_mode` advance to Phase 5 pre-release identifier | `CLAUDE.md release_kit overlay` | maintainer-triggered |

### Out of Phase 4 scope (with explicit triggers)

#### `/v1/messages` — Anthropic-shape entry surface

**Status:** Deferred. Re-enable strictly gated on ADR 0009 P0 success.

**Value matrix (decisive):**

| Scenario | Without `/v1/messages` | With `/v1/messages` |
|---|---|---|
| Maintainer's own Claude Code usage | Direct via Anthropic OAuth → subscription (today) or Agent SDK pool (post-2026-06-15) | Same — maintainer never routes own CC through OLP per stated workflow |
| Family member wanting CC access | Not supported (OAuth is full-account; OLP CLI tokens are scoped) | CC via `ANTHROPIC_BASE_URL=http://olp:4567` + `olp_*` token |
| **P0 succeeds** (ADR 0009 interactive-mode bills as subscription) | OpenAI-shape IDE clients (Cline/Continue/Cursor) all benefit automatically via OLP's anthropic plugin | CC users additionally benefit; both subscription-billed |
| **P0 fails** (interactive-mode bills as Agent SDK same as `-p`) | OpenAI-shape clients still work; no billing change | CC users get same billing as direct OAuth; **fallback to codex/mistral degrades Anthropic-specific features (tool_use schema mismatch / cache_control drop / computer_use no-op / thinking-block drop)** more severely than OpenAI-shape clients which speak the multi-provider lingua franca |

**Rationale.** Under P0 failure, `/v1/messages` provides no billing benefit AND degrades worse on fallback than OpenAI-shape clients (because OpenAI tool schema is the cross-provider standard). The security benefit (no OAuth exposure) is equally achievable via Cline/Continue/Cursor. **Net non-positive under P0 failure.**

**Re-open condition.** (a) ADR 0009 P0 confirms interactive-mode billing classification as subscription (≥ 2026-07-15) AND (b) maintainer explicitly opens Phase 5 "Anthropic-shape hub" scope with the name of at least one family member who wants CC access. If only (a) fires without (b), `/v1/messages` is reconsidered at the start of whichever phase covers it but is not auto-opened.

**README posture (Phase 4).** README § Supported Clients explicitly lists OpenAI-compatible clients (Cline, Continue.dev, Cursor, Aider, OpenClaw bots). Claude Code is listed as **Not supported as an OLP client**, with the explicit alternative "Cline + OLP" (same fallback chain available, better cross-provider compatibility). README links to this ADR for the reasoning.

#### Other deferred items

- **v1.x roadmap #3 (soft trigger reactivation)**, **#5 (provider `cacheKeyFields` mask)**, **#6 (streaming SPAWN_FAILED salvage)** — trigger conditions per `docs/v1x-roadmap.md` have not fired. Not in Phase 4.
- **Anthropic / codex billing audits** — date-gated (`anthropic.mjs:53, 416, 441` say 2026-06-16; `codex.mjs:572` post-D7 E2E audit). Not in Phase 4.
- **`context_window_exceeded` fallback trigger** (LiteLLM prior-art) — small ADR amendment + trigger taxonomy add; opportunistically in Phase 5 unless trigger fires sooner.
- **`X-OLP-Cost-USD` per-request response header** — depends on provider-cost weights table (Phase 5 prerequisite).
- **per-(provider, model) live stats Map** (replacing audit-query scan for dashboard 30s poll) — current scan latency adequate; Phase 5+.
- **OpenTelemetry GenAI span emission** — `npm` dep + ~150 LOC; family-scale ROI marginal. Phase 6+ unless Langfuse self-host requested.
- **Intent-based routing**, **stackable transformer plugin model** — explicit non-goals per Prior-Art § 8 anti-patterns.

### Opportunistic Phase 4 micro-additions (not blocking)

Items small enough to land alongside a planned D-day without scope creep, if encountered:

- Env-var deny-list before provider plugin `spawn` (per OCP `server.mjs:531-534`; each plugin declares its own list)
- 5 MB request body cap with HTTP 413 (per OCP `server.mjs:1270,1278-1281`)
- Error-response path-sanitization (per OCP `server.mjs:1395`)
- Stable node-path resolution in launchd plist (Homebrew `/Cellar/<ver>/` → `/opt/` rewrite; per OCP `setup.mjs:344-351`)
- Legacy model alias resolution in `models-registry.json` (`aliases:` field; per OCP `legacyAliases`)

### Exit gate — v0.4.0 close criteria

1. D60 — D73 all merged with fresh-context opus reviewer APPROVE per Iron Rule 10.
2. CI green on every D-day merge commit and on the v0.4.0 release commit head.
3. README § Operator CLI + § IDE Setup + § Telegram/Discord Usage sections present.
4. ADR 0010 (this charter) + ADR 0011 (anonymous-key deployment-context limits) on disk.
5. `CHANGELOG.md "Unreleased"` promoted to `"## v0.4.0 — <date>"` with D60 — D73 entries.
6. `package.json` bumped to `0.4.0`.
7. `CLAUDE.md release_kit.phase_rolling_mode.current_phase` advances `Phase 4 → Phase 5`; `current_pre_release_identifier` advances `0.4.0-phase4 → 0.5.0-phase5`.
8. Standing autopilot grant covers D-day-by-D-day execution; v0.4.0 close PR is maintainer-triggered.

---

## Default port change (D60 specific)

The default `OLP_PORT` value moves `3456 → 4567` at this D-day. Rationale:

- OCP defaults to 3456 and the maintainer's existing OCP installs stay on 3456 indefinitely.
- A standard `olp` install on the same host without overriding `OLP_PORT` collides at bind time.
- Setting `OLP_PORT=4567` as the default makes co-host the recommended steady state during the migration window (and beyond — there is no enforced deprecation of OCP).
- Existing OLP deployments wanting the pre-D60 default can set `OLP_PORT=3456` in the launchd plist / shell env.

**Tested invariants preserved by the port change:**

- All `test-features.mjs` suites use `port: 0` (ephemeral assigned port) — no test depends on the default value. Verified via `grep -nE '\\b3456\\b' test-features.mjs` returning empty.
- All cache / fallback / provider plugin code is port-agnostic.
- Dashboard 30s poll uses relative paths — no port change required in `dashboard.html`.
- `/v0/management/*` endpoints use relative paths — no client-side update required.

**Files amended at D60:**

- `server.mjs:17` — env-var doc comment
- `server.mjs:74` — default value
- `README.md` quick start + Environment Variables table + Migration from OCP § note
- `docs/adr/0001-project-founding.md` § "Decision" paragraph about port conflict (struck and amended)
- `docs/adr/0008-dashboard-and-audit-query.md` § 6.6 port reference
- `CHANGELOG.md` Unreleased entry
- This ADR

---

## Consequences

**Positive.**

- Family member onboarding goes from "maintainer texts API key + edits IDE config" to `curl -fsSL .../olp-connect | bash -s -- <ip>`.
- `paste-this-prompt-to-Claude-Code` self-installation pattern unlocks AI-driven setup / upgrade / repair, eliminating the maintainer's Tier-1 support role.
- Long-reasoning streams behind nginx / Cloudflare / Tailscale Funnel no longer 502 at 60s idle.
- `/olp` Telegram slash commands enable "is OLP up?" / "show usage" / "rotate key" from anywhere with chat access.
- OCP and OLP co-host on the same workstation, lowering the maintainer's cost of running both.

**Negative.**

- Phase 4 is the first phase whose scope is primarily about *operator experience* rather than functional capability. The work doesn't unlock new requests OLP can serve; it makes OLP's existing capability survive contact with real users.
- The `olp-connect` IDE auto-detect logic accumulates IDE-specific quirks (Cline base-URL UI regressions per their issue #7128; Cursor's malformed-request-when-OpenRouter behavior; etc.). Maintenance burden grows.
- README size grows substantially with Operator CLI + IDE Setup + Telegram/Discord sections. Discoverability of the existing technical reference (ADRs, environment variables) may degrade unless the navigation is refactored.

**Neutral.**

- Phase 4 deliberately spends 0 D-days on `/v1/messages`. If ADR 0009 P0 succeeds in Q3 2026, Phase 5 "Anthropic-shape hub" becomes the natural next phase, with the prerequisite IR work that Phase 4 surfaces (every IDE doc page is a test of which IR fields actually flow through). If P0 fails, `/v1/messages` shelves indefinitely and the README simply documents CC as out-of-scope.

---

## Alternatives considered

1. **Phase 4 = `/v1/messages` first, operator UX later.** Rejected. The brainstorm matrix demonstrated `/v1/messages` is value-positive only if ADR 0009 P0 succeeds, and operator UX gains accrue regardless. Building speculative infrastructure ahead of P0 risks 5-7 D-days of work shelving.
2. **Phase 4 = operator + client UX + `/v1/messages` together (full kitchen sink).** Rejected. ~20 D-days lengthens the Phase 4 close window unnecessarily; the natural review chunks blur; maintainer review fatigue is real.
3. **Phase 4 = just D60 + opportunistic SSE heartbeat, no CLI / no plugin / no docs bundle.** Rejected. Each of the operator-UX items individually has small ROI; the value compounds when they ship together (CLI surfaces data → `/status` exposes shape → Telegram plugin renders → IDE docs reference → `olp-connect` automates). Splitting them across phases loses the compounding.
4. **Defer Phase 4 entirely; jump to Phase 5 Anthropic-shape hub when P0 lands.** Rejected. Operator UX is needed now (this session is itself evidence — the maintainer spent ~30 minutes confirming OCP feature inheritance because there's no `olp doctor` answer). Waiting for P0 stalls progress on independently-valuable work.

---

## Authority

- `docs/v1x-roadmap.md` — Phase 4 was named as the canonical destination for the post-cleanup batch since v0.3.0 close.
- `CLAUDE.md release_kit.phase_rolling_mode` — `current_phase: Phase 4` already; this charter formalizes the contents.
- OCP comprehensive feature audit (2026-05-26 subagent output, summarized in `~/.cc-rules/memory/auto/MEMORY.md` and in this session's transcript).
- Multi-provider proxy / IDE integration prior-art survey (2026-05-26 subagent output).
- ADR 0009 (Anthropic interactive-mode path placeholder) — establishes the gate for `/v1/messages` re-consideration.
- ADR 0001 (project founding) — § "Decision" paragraph about port conflict, amended at this D-day.
- ADR 0008 (dashboard + audit query) — § 6.6 default-port reference, amended at this D-day.
- `~/.cc-rules/memory/auto/standing_autopilot_phase_2.md` — standing autopilot grant covering D-day-by-D-day execution; v0.4.0 close PR is maintainer-triggered per `release_kit.phase_close_trigger`.

---

## Procedural mechanism

CC 开发铁律 v1.6 § 5.5 (release-kit overlay drives Phase boundaries) + § 10 (independent reviewer on every implementation D-day) + § 11 (minimum reviewable unit per PR — this charter ships as D60 PR alongside the default port change because both are governance-class and small).

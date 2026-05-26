# ADR 0012 — Phase 5 Charter: Provider Quota Probes + Dashboard Enrichment

**Status:** Accepted (Phase 5 open as of 2026-05-26)
**Date:** 2026-05-26
**D-day:** D79 (charter + ADR 0002 Amendment 8 + ADR 0013 land together as the constitutional layer of Phase 5)

## Amendments

### Amendment 1 — 2026-05-26: D84 Mistral probe NO-GO (post-D79-close spike)

The D-day table originally listed D84 as "optional, depends on D79-close 30-min Mistral docs spike". The spike completed 2026-05-26 with verdict **NO-GO** — Mistral does not expose a programmatic quota/usage endpoint **accessible to Vibe / Le Chat member / La Plateforme API keys** (the key tier OLP uses for spawning the `vibe` CLI):

- `docs.mistral.ai/api` (the public API spec) covers Chat, FIM, Embeddings, Classifiers, Files, Models, Batch, OCR, Audio, Events, Beta (Agents/Conversations/Libraries/Workflows/Observability). No usage/quota/credits/billing/limits endpoint accessible to a member API key.
- Direct probe `https://api.mistral.ai/v1/usage` returns 404.
- Mistral's "Limits and Usage" help article documents limit viewing via the `admin.mistral.ai/plateforme/limits` web console.
- No `x-ratelimit-*` response headers documented on `/v1/chat/completions`. (Third-party summaries mentioning these headers are unsourced — appears to be OpenAI-convention extrapolation.)
- OLP `lib/providers/mistral.mjs` already records this independently — DL-7 comment: "If quota/budget API surfaces in Le Chat Pro, pin the endpoint here."

**Out-of-scope but worth pinning for future revisit.** Mistral's [Admin API](https://docs.mistral.ai/admin/security-access/admin-api) DOES expose programmatic "Billing and usage queries", and the [Usage limits docs](https://docs.mistral.ai/admin/user-management-finops/usage-limits) describe usage/cost queries via that surface. The Admin API requires an **org-admin scoped API key** (separate from the member key OLP uses). For OLP's family-tier deployment posture (a maintainer's personal Le Chat Pro / La Plateforme account, not an organization's admin console), provisioning + storing an org-admin token raises the credential-scope ceiling beyond what the trusted-LAN deployment context (ADR 0011) was designed for. The NO-GO at v0.5.0 is therefore "out of scope for OLP's current deployment posture", NOT "Mistral has no programmatic surface". If the deployment posture expands to an org-admin context (e.g., a small-business multi-user deployment), this decision should be re-evaluated.

**Disposition:**
- D84 row dropped from D-day plan (struck through below).
- Mistral dashboard row in D82 UI shows "spend tracking only" badge sourced from `audit-query.mjs` aggregates (request count, estimated cost from `estimateCost()`).
- `DL-7` in `mistral.mjs` is the documented re-entry point if Mistral ever publishes a usage endpoint.
- Phase 5 total D-day budget revised: ~5 D-days (down from ~6).

---

## Context

Phase 4 (ADR 0010) shipped OLP's operator + client UX layer — `bin/olp` operator CLI, `olp doctor` framework, `olp-connect` zero-config IDE wiring, OpenClaw `/olp` slash commands, anonymous-key deployment-context limits, SSE heartbeat. v0.4.4 is the current shipped state. Phase 4 closed every gap on the OCP-feature-parity matrix EXCEPT one: **live quota / plan-usage surfacing**.

Today `lib/providers/anthropic.mjs:445` has a stub `quotaStatus()` returning `null` (D4 placeholder). The OLP dashboard's quota panel renders "—" for all providers. OCP, in contrast, exposes a live "39% session / 30% weekly" panel — the maintainer uses this multiple times per day to decide when to throttle voluntary `claude -p` traffic away from interactive sessions. OLP cannot become an OCP successor in practice (vs. just feature-parity-on-paper) until quota surfacing works.

A pre-flight institutional-knowledge audit (2026-05-26 — see `~/.cc-rules/memory/learnings/anthropic_plan_usage_probe_schema_2026_05_26.md`) confirmed:

1. **The OCP probe still works today** — Anthropic returns the same `anthropic-ratelimit-unified-*` headers on every `POST /v1/messages` call. Tested live 2026-05-26 from PI231 OAuth credentials.
2. **Schema added 3 fields since OCP's 2026-04 capture** — `5h-status`, `7d-status` (per-window status), `overage-reset` (only on active overage). No fields removed or renamed.
3. **Verification protocol has shifted** — Claude Code v2.1.x is now a **compiled binary** (Mach-O / ELF), not bundled JS. OCP's "grep cli.js" approach no longer applies; the replacement protocol is `strings` against the binary + periodic live probe diff.
4. **OAuth refresh path unchanged** — `platform.claude.com/v1/oauth/token` + `9d1c250a-...` client_id + 60s-3600s exponential backoff.

The audit makes Phase 5 implementation low-risk: this is a port of a working OCP function, not a re-derivation. The work is mechanical + adapter-layer plumbing into OLP's plugin contract.

A parallel maintainer request (2026-05-26, with reference screenshot of claude.ai/settings/usage) asked for Claude.ai-style dashboard enrichment: per-row utilization bars, reset countdown, 1-minute auto-refresh, manual refresh button. P5-1 (probe) + P5-2 (dashboard) together unlock both: the data plus the surface. v1.x roadmap #8 is closed by P5-2.

---

## Decision

Phase 5 scope is **Provider quota probes + dashboard enrichment**. The phase opens 2026-05-26 with D79 (this charter + ADR 0002 Amendment 8 + ADR 0013 OAuth READ-ONLY consumption rules). Phase 5 close ships v0.5.0; per `CLAUDE.md release_kit.phase_rolling_mode`, the close PR is maintainer-triggered.

### In scope — Phase 5 D-day plan (~6 D-days)

| D-day | Deliverable | Authority | Estimate |
|---|---|---|---|
| **D79** | This charter ADR 0012 + ADR 0002 Amendment 8 (direct-API READ-ONLY) + ADR 0013 (OAuth READ-ONLY consumption rules + schema-drift mitigation) + `package.json` `current_pre_release_identifier` → `0.5.0-phase5` + `CLAUDE.md release_kit.phase_rolling_mode.current_phase` → Phase 5 | This charter + audit memory | 0.5d |
| **D80** | `lib/providers/anthropic.mjs:quotaStatus()` ported from OCP `server.mjs:842-1109` — full probe with macOS-keychain auth read added (existing OLP reader only handles env + `.credentials.json`) + 5min cache + 60s-3600s refresh backoff + stale-cache-on-429 + all 13 headers parsed (including new 5h-status / 7d-status / overage-reset) | Port OCP probe + ALIGNMENT.md Rule 2 exemption per ADR 0002 Amendment 8 + audit memory | 2d |
| **D81** | `lib/audit-query.mjs` + `/v0/management/dashboard-data` extended to surface the new quota shape per provider (utilization, reset, representative-claim, fallback-percentage, overage-status). Audit-query stays in-memory scan per ADR 0008 Lane 2 = A (no SQLite). Schema migration documented in ADR 0008 § Amendment | ADR 0008 + this charter | 1d |
| **D82** | `dashboard.html` Claude.ai-style restructure — per-provider rows replace the current single Quota panel; each row: provider badge, model placeholder, utilization bar (5h + 7d), reset countdown ("Your limit will reset at HH:MM AM/PM" format from the user-shared claude.ai screenshot), status badge, representative-claim hint. 1-minute auto-refresh via `setInterval` with `document.visibilityState` guard. Manual refresh button calls `/v0/management/dashboard-data` directly | v1.x roadmap #8 + maintainer reference screenshot | 1.5d |
| **D83** | Test coverage — Suite 38 quota-probe unit tests (mock HTTP server returning the 13 headers; assert parse + cache + backoff + stale-on-429); Suite 39 dashboard rendering smoke (curl `/dashboard` after pre-seeding mock quota cache; assert HTML contains expected utilization strings); update Suite 33 doctor checks for new `anthropic.quota_probe_reachable` check | Test convention from existing suites | 1d |
| ~~D84~~ **DROPPED** | ~~Mistral `quotaStatus()` port — depends on D79-close spike~~ **NO-GO per 2026-05-26 spike (see § Amendment 1).** Mistral dashboard row in D82 shows "spend tracking only" badge sourced from `audit-query.mjs` aggregates. `DL-7` hook point in `mistral.mjs` already marks the location for future upgrade if Mistral ever publishes a usage endpoint. Codex permanently skipped (no public API). | n/a (dropped) | 0d |
| **close** | v0.5.0 release PR — `package.json` `0.4.4 → 0.5.0`, CHANGELOG promotion, `release_kit.phase_rolling_mode.current_pre_release_identifier` advance to Phase 6 token | `CLAUDE.md release_kit overlay` | maintainer-triggered |

### Out of Phase 5 scope (with explicit triggers)

#### `X-OLP-Cost-USD` per-request response header

**Status:** Deferred to Phase 6. Was listed in ADR 0010 § Out-of-scope as "Phase 5 prerequisite". The prerequisite (provider-cost weights table) is non-trivial — needs per-(provider, model) `input_cost_per_1k_tokens` / `output_cost_per_1k_tokens` / `cache_read_discount` data sourced from each provider's published pricing page. Phase 5 already pulls in two new ADRs; adding a third data-onboarding ADR is scope creep.

**Re-open condition.** Phase 6 unless a maintainer reports a cost-attribution debugging need that warrants pulling forward.

#### `context_window_exceeded` fallback trigger (LiteLLM prior-art)

**Status:** Deferred. ADR 0010 listed this as opportunistic-in-Phase-5 unless the trigger fires sooner. The trigger has not fired in Phase 4 production traffic. Continue to defer.

#### per-(provider, model) live stats Map (replacing audit-query scan)

**Status:** Deferred. Current scan latency is ~20ms at 7-day depth. Acceptable until volume grows (>100k requests/day). Re-evaluate at Phase 6 if dashboard latency degrades.

#### Anthropic interactive-mode P0 (ADR 0009)

**Status:** Still trigger-gated on Anthropic's 2026-06-15 billing-split rollout. Phase 5 does NOT depend on P0 — the quota probe reads `anthropic-ratelimit-unified-*` headers regardless of which billing pool the spawn path consumes. If P0 succeeds Phase 7+ Phase 5's probe code remains unchanged; if P0 fails Phase 5's probe code remains unchanged. The probe is billing-pool-agnostic because the headers are subscription-pool metadata, not Agent-SDK-Credit metadata.

#### `/v1/messages` Anthropic-shape entry surface

**Status:** Still deferred per ADR 0010 § Out-of-scope. No change in Phase 5.

#### v1.x roadmap #3 / #5 / #6

**Status:** Still trigger-gated per `docs/v1x-roadmap.md`. None has fired. Continue to defer.

### Opportunistic Phase 5 micro-additions (not blocking)

Items small enough to land alongside a planned D-day without scope creep, if encountered:

- README § Dashboard screenshot update (post-P5-2 enrichment) — capture from MacBook test path per `~/.cc-rules/memory/feedback/mac_mini_never_for_testing.md`.
- `olp usage` CLI subcommand (bin/olp.mjs) surfaces the parsed quota shape in terminal form. Already partially exists (cmdUsage in bin/olp.mjs); confirm payload alignment after D80.
- Add `claude_code_oauth_client_id` config override in `~/.olp/config.json` so power users can override the hardcoded `9d1c250a-...` UUID without env-var fiddling. Mirrors compiled binary's `CLAUDE_CODE_OAUTH_CLIENT_ID` env support.
- `docs/provider-audits/anthropic.md` re-capture with current `claude --version` (v2.1.142 MacBook / v2.1.150 PI231) + binary distribution layout note.

### Exit gate — v0.5.0 close criteria

1. D79 — D84 all merged with fresh-context opus reviewer APPROVE per Iron Rule 10.
2. CI green on every D-day merge commit and on the v0.5.0 release commit head. `alignment.yml` blacklist re-confirmed (no new hallucinated tokens introduced).
3. README § Quota / Plan Usage section present with screenshot of the enriched dashboard. README § Supported Providers table updated to note "quota probe: anthropic ✅, mistral ⚠️/✅ (D84 outcome), codex ❌ (no public API)".
4. ADR 0012 (this charter) + ADR 0002 Amendment 8 + ADR 0013 (OAuth READ-ONLY consumption) on disk.
5. `CHANGELOG.md "Unreleased"` promoted to `"## v0.5.0 — <date>"` with D79 — D84 entries.
6. `package.json` bumped to `0.5.0`.
7. `CLAUDE.md release_kit.phase_rolling_mode.current_phase` advances `Phase 5 → Phase 6`; `current_pre_release_identifier` advances `0.5.0-phase5 → 0.6.0-phase6`.
8. Standing autopilot grant covers D-day-by-D-day execution; v0.5.0 close PR is maintainer-triggered.
9. Live MacBook E2E verification — dashboard renders enriched panel with real quota data (probe live, not mocked).

---

## Consequences

**Positive.**

- OLP finally has the load-bearing observability OCP had — maintainer can see live "39% session / 30% weekly" and decide whether voluntary `claude -p` traffic stays or moves.
- Family members on the LAN see real reset times instead of "—", which makes the "wait 2 hours" guidance concrete vs. abstract.
- The institutional-knowledge audit captured the schema in a memory file pinned with date stamps — future ports (mistral, future provider) re-use the verification protocol without re-deriving.
- v1.x roadmap #8 (Dashboard enrichment per Claude.ai-style usage page) closes inside Phase 5 rather than waiting for a separate phase.
- Compiled-binary-distribution awareness ("no more cli.js to grep") is now codified in OLP governance; the next time Anthropic ships a major CC version, the verification protocol is already written.

**Negative.**

- ADR 0002 gains another amendment (Amendment 8). The constitution surface area for `anthropic.mjs` grows. Counter-pressure: the alternative (probe lives in `server.mjs`, like OCP) violates the plugin-architecture principle that per-provider knowledge stays in `lib/providers/`. Amendment 8 is the smaller violation.
- The probe makes one `/v1/messages` call per 5min cache miss. That's ~12 calls/hour worst case across the whole proxy (probe is per-credentials, not per-key). With `max_tokens: 1` the cost is < $0.01/day at family-scale traffic. Negligible but not zero.
- Schema-drift risk over the long horizon. Anthropic could rename or remove headers in a future version. The mitigation protocol (strings + live probe diff) is in place, but it's a manual check — needs to be invoked by the maintainer or scheduled.
- Dashboard refactor introduces a breaking-change risk for the existing dashboard.html consumers (none today, but conceptually). Bumping to v0.5.0 signals this clearly.

**Neutral.**

- Phase 5 has more ADR work than Phase 4 (3 governance docs vs. 2). The constitutional layer is deliberately heavier because direct-API access is the single biggest authority decision since the plugin contract itself.

---

## Authority + cross-references

- **Iron Rule 11 (IDR)** — Phase 5 ships across 6 D-days, each a minimum reviewable unit. The governance trio (this ADR + Amendment 8 + ADR 0013) lands at D79 as a single coupled commit (reviewing them separately cannot verify consumer-producer alignment), per ADR 0002 Amendment 7's precedent.
- **Iron Rule 12 (prior-art search)** — discharged via the audit memory at `~/.cc-rules/memory/learnings/anthropic_plan_usage_probe_schema_2026_05_26.md`. Memory committed prior to D80 implementation.
- **ALIGNMENT.md Rule 1 (citation)** — D80 commit must cite compiled-binary `strings` evidence per audit memory § Path A (Claude Code v2.1.x has no traditional `§ section` structure because it is a Mach-O / ELF compiled binary) plus the audit memory file path. Live-probe transcript MUST be included in the commit body.
- **ALIGNMENT.md Rule 2 (provider-CLI-as-authority)** — direct-API access bypasses the spawn-binary contract. Amendment 8 is the explicit exemption. Without Amendment 8, the D80 commit is unalignable.
- **ALIGNMENT.md Rule 5 (CI alignment.yml)** — must continue to pass. `api.anthropic.com/v1/messages` is NOT on the blacklist (correct — that's the real endpoint). The hallucinated `/api/oauth/usage` IS on the blacklist (transitive from OCP) and must remain.
- **ADR 0002 Amendment 8** — companion ADR. Direct-API access scoping; READ-ONLY constraint; opt-in via config flag (default off).
- **ADR 0013** — companion ADR. OAuth credentials shared between spawn path + probe path; refresh backoff; schema-drift mitigation protocol.
- **CLAUDE.md release_kit** — Phase boundary triggers maintainer-led version bump. D-day commits within Phase 5 stay under "Unreleased". `0.5.0-phase5` is the pre-release identifier during the phase.

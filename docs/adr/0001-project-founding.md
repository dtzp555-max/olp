# ADR 0001 — Project Founding: Mission, Non-mission, and Supersession of OCP ADR 0005

- **Date:** 2026-05-23
- **Status:** Accepted (bootstrap)
- **Authors:** project maintainer (with AI drafting assistance)
- **Related:** OLP v0.1 spec §1, §2, §10; OCP ADR 0005 (No Multi-Provider — explicitly superseded by this ADR); Anthropic billing announcement 2026-05-14

## Context

On 2026-05-14, Anthropic announced (effective 2026-06-15) that `claude -p`, the Agent SDK, and third-party agent traffic move out of the Pro/Max subscription pool into a separate fixed monthly Agent SDK Credit pool ($100/month at Max5x, no rollover, then standard per-token API rates). OCP — the Open Claude Proxy — was built on the foundational assumption that *subscription = unlimited within rate limits*. That assumption breaks on 2026-06-15 for the only provider OCP serves.

This is not a `cli.js` drift in the OCP-ADR-0002 sense. It is not an internal authoring failure. The proxy logic remains aligned to `cli.js` byte-for-byte. What changed is the *commercial contract* sitting underneath the proxy: the subscription the maintainer pays for no longer underwrites the traffic OCP forwards. OCP-as-written continues to work; it just stops being the cost-optimal way to spend the maintainer's LLM budget.

OCP ADR 0005 (2026-05-06, "No Multi-Provider") explicitly rejected a multi-provider refactor on four grounds: (1) loss of `cli.js` alignment as moat, (2) hybrid-architecture awkwardness, (3) direct competition with funded incumbents, (4) the grayscale problem isn't solved by adding providers. Eight days after that ADR shipped, the assumption underpinning ground 1 — that there *was* an unlimited subscription pool worth aligning to — was invalidated by Anthropic's announcement. The other three grounds remain partially valid but no longer dominate: (2) hybrid awkwardness goes away if a clean multi-provider proxy is built from scratch rather than retrofitted onto OCP's single-provider core; (3) competition with funded incumbents is irrelevant because the new project, like OCP, is a personal-and-family-scale tool not chasing commercial revenue; (4) grayscale is intrinsic to the spawn-binary architecture regardless of how many providers participate.

The structural response is not to amend OCP ADR 0005 in place — that ADR was correct under its premises, and patching it would muddy the historical record. The structural response is a new project, founded today, that supersedes ADR 0005 by being the codified alternative the ADR explicitly contemplated in its trigger conditions ("[revisit if] a genuine user need emerges … that single-provider OCP cannot serve").

## Decision

Found OLP (Open LLM Proxy) as a new project, separate from OCP, with the following mission and non-mission boundaries:

**Mission.** OLP is a personal- and family-scale multi-provider LLM proxy that maximizes the value of LLM subscriptions the maintainer already pays for, with intelligent fallback when one provider's quota is exhausted and content-addressed caching to minimize quota consumption. Core value proposition: one HTTP endpoint, multiple subscriptions behind it, automatic routing, automatic fallback, transparent caching — so IDE clients and family clients keep working as long as *any* of the subscriptions has quota left.

**Non-mission (explicit).** Per spec §1, OLP is **not**:
- A commercial multi-tenant SaaS. Helicone, OpenRouter, LiteLLM, Portkey, Cloudflare AI Gateway already serve that market with funding, SOC2, dashboards, and team features. OLP enters none of those races.
- A generic enterprise AI gateway competing on provider breadth. The candidate provider set is intentionally narrow (8 total: 3 anticipated Tier D + 2 anticipated Tier C + 3 anticipated Tier B; v0.1 founding ships 0 Enabled per ALIGNMENT.md § Provider Inventory) and curated by subscription economics, not by "more is better."
- A model-capability router. OLP does not auto-route to "the smartest model"; the user picks the model explicitly per chain in `config.routing.chains[]`. Capability routing is a separate problem with separate failure modes and is out of scope for v1.0 and beyond.
- A conversation-state store. Memory and continuity are client-side concerns (Memory Continuity, Hermes equivalents, IDE-side context). OLP is a pure stateless proxy.

**Supersession of OCP ADR 0005.** OCP ADR 0005 ("No Multi-Provider Refactor") is explicitly superseded by OLP's existence. The supersession is **narrow** and **does not adopt all of ADR 0005's alternative-path suggestions**:

What OLP genuinely inherits from ADR 0005:
1. **Structural separation:** the judgment that if multi-provider becomes needed, the right move is to start a separate project, not retrofit OCP. ✓
2. **Multi-provider design baked in from day one** (rather than retrofitted onto a single-provider core). ✓

What OLP supersedes in ADR 0005:
- ADR 0005's premise that *single-provider sufficiency* was the right scope for the maintainer's LLM proxy was correct on 2026-05-06 and is wrong on 2026-05-23, because Anthropic changed the underlying contract. This is the load-bearing supersession.

What OLP **does NOT inherit** from ADR 0005 (and where ADR 0005's reasoning does not apply to OLP):
- ADR 0005's separate-project recommendation came with two qualifiers that OLP rejects: "BYOK from day one" and "no `cli.js` spawn." Both qualifiers were appropriate for the *commercial* path ADR 0005 was contemplating. OLP is not commercial — it is personal- and family-scale, shares the maintainer's own subscription quota across family clients, and explicitly spawns provider CLIs (it is precisely the spawn-binary architecture that delivers the "subscription quota maximization" value proposition spec §1 names).
- OLP is therefore not the commercial pivot ADR 0005 endorsed. It is a personal-use re-architecture of the proxy-CLI pattern, which ADR 0005 did not contemplate. The supersession is honest about this gap.

OCP itself is not deleted. Per spec §7, OCP enters maintenance mode when OLP v0.1 ships. ~~The two projects do not parallel-run in production (port-3456 conflict, single launchd service slot, one set of credentials per machine).~~ **Amended at D60 (2026-05-26, ADR 0010 Phase 4 charter):** the port-conflict assumption is lifted. OLP's default port moved `3456 → 4567` at v0.4.0 so OCP (which stays on 3456) and OLP can co-host on the same machine during a transition window. Launchd label collision **will be** avoided via `dev.olp.proxy` (OLP plist generation lands at Phase 4 close per ADR 0010 D64–D70; not on disk at D60) vs `dev.ocp.proxy` (OCP, already shipped). Credentials remain per-project (`~/.ocp/` vs `~/.olp/`). Co-host is explicit-opt-in, not the recommended steady state.

OCP ADR 0005 receives a header amendment on merge of this ADR: *"Superseded in part by OLP — see https://github.com/dtzp555-max/olp ADR 0001 for the narrow scope of the supersession (single-provider-sufficiency premise only; ADR 0005's commercial / BYOK / no-spawn recommendations are not adopted)."* The body of ADR 0005 is otherwise untouched. Future readers should see the original reasoning intact and the supersession marker scoped explicitly.

## Consequences

**Positive**
- Multi-provider routing solves the post-2026-06-15 quota problem that OCP cannot solve on its own. As long as any one of the configured providers has quota remaining, the maintainer's IDE clients keep working.
- Clean-slate codebase avoids the hybrid-architecture awkwardness ADR 0005 correctly warned about. OLP is multi-provider from day one; there is no single-provider core to retrofit.
- Project scope stays bounded by the non-mission list. Future contributors (including the maintainer) reading this ADR see the explicit "we don't do X" list, which makes scope creep cost an ADR amendment rather than a quiet PR.

**Negative**
- OCP's `cli.js`-alignment moat (ADR 0002 + 0005) does not transfer. OLP proxies multiple CLIs, each with its own protocol authority; the `cli.js` byte-for-byte discipline becomes per-provider per-CLI discipline (see ADR 0002 and the new OLP ALIGNMENT.md). This is more surface area to keep honest, not less.
- Migration cost for the user: stop OCP, install OLP, point clients at the new port, migrate auth tokens. Spec §7 budgets this at <5 minutes via `scripts/migrate-from-ocp.mjs` (📋 planned, Phase 7 — not yet authored). Real-world time will be higher on the first machine.
- The maintainer now operates two repos during OLP's pre-v1.0 phase: OCP in maintenance, OLP under active development. This is intentional — OCP serves real traffic today and cannot be deleted in advance — but doubles the release surface temporarily.

**Mitigations**
- OCP enters maintenance, not parallel development. The maintainer is not maintaining two evolving codebases; OCP receives only stability fixes after OLP v0.1 ships.
- The non-mission list in this ADR is intentionally specific (commercial SaaS, breadth race, capability routing, conversation state) so "creep into one of these four" requires an explicit ADR amendment.
- Spec §10 (Decision log) records the 2026-05-23 founding decisions; new founding-era decisions are appended to spec §10 with cross-references to the relevant ADR.

## Alternatives considered

**(a) Amend OCP ADR 0005 in place and refactor OCP to multi-provider.** Considered and rejected. ADR 0005 explicitly warned against hybrid architecture awkwardness for exactly this case; the maintainer recorded the warning in writing eight days ago. Honoring that warning means starting clean, not retrofitting. The structural cost of two repos during the transition is lower than the structural cost of muddying the constitutional reasoning that protected OCP from earlier scope creep.

**(b) Wait until 2026-06-15 (effective date) before founding OLP.** Considered and rejected. The Anthropic announcement is dated, the effective date is dated, and the construction time for OLP v0.1 (~16 working days per spec §6 phase plan) puts a 2026-05-23 start at roughly the effective date — exactly when the maintainer's family clients begin seeing the new credit-pool consumption. Waiting until the wall clock turns means OLP ships *after* the problem starts hurting.

**(c) Add multi-provider behind a feature flag in OCP and ship it as OCP v4.0.** Considered and rejected. Feature flags do not retire the single-provider code path; they double the test matrix and create the exact hybrid path ADR 0005 warned about. The honest engineering move is a separate codebase.

**(d) Drop the proxy approach entirely and let IDE clients talk to each provider directly.** Considered and rejected. The whole point of OCP/OLP is *one* endpoint that family/IDE clients can be pointed at. N clients × M providers = N×M configuration surface managed by the maintainer, plus zero fallback, zero cross-provider caching, zero unified spend dashboard. The proxy is load-bearing.

## Sources

- OLP v0.1 spec §1 (Mission), §2 (Why OLP exists), §7 (Migration from OCP), §10 (Decision log)
- OCP ADR 0005 (2026-05-06) — `~/ocp/docs/adr/0005-no-multi-provider.md`
- Anthropic billing announcement 2026-05-14 — `~/.cc-rules/memory/learnings/anthropic_claude_code_billing_split_2026_06_15.md`
- Memory entry 2026-05-07 (Mac → OCP v3.13.0 cache layer hardening) — records the maintainer's preceding decision that OCP itself will not be commercialized

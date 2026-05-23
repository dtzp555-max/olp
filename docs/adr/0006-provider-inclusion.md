# ADR 0006 — Provider Inclusion / Exclusion Criteria and Risk-Tier Framework

- **Date:** 2026-05-23
- **Status:** Accepted (bootstrap)
- **Authors:** project maintainer (with AI drafting assistance)
- **Related:** OLP v0.1 spec §3.1, §10; ADR 0001 (project founding); ADR 0002 (plugin architecture — inclusion criteria gate plugin merges); OCP ADR 0006 (OpenAI Shim Scope — informed the risk-tier framing approach)

## Context

OLP's value proposition (spec §1) is multi-provider spreading of LLM subscription quota. The more providers OLP supports, the better its fallback fan-out and the more resilient the overall system. But provider inclusion is not free: each provider's terms of service, enforcement history, and cost-benefit profile differ, and including a provider with poor ToS posture exposes the user to account-revocation or service-termination risk that the user may not have signed up for when they enabled OLP.

The decision space is not binary "include / exclude." A four-tier framework better matches the actual risk landscape observed in the 2026-05-23 provider deep-dive audit:

- Some providers (OpenAI Codex, Mistral Vibe, pre-2026-06-15 Anthropic) have permissive ToS with no anti-third-party clauses and healthy ecosystems. These are safe defaults.
- Some providers (xAI Grok, Moonshot Kimi) have *tightened* ToS language recently but no documented enforcement history. The user may reasonably opt in with awareness.
- Some providers (MiniMax, Zhipu GLM, Alibaba Qwen) have explicit anti-automation clauses in their subscription plan terms. Key revocation is a documented risk; account-wide enforcement is not.
- One provider (Google Antigravity) has all three risk factors compounded: explicit named prohibition of third-party tools (OpenClaw, OpenCode, Claude Code by name in Google's FAQ), an active enforcement wave (Feb 2026), and no cost advantage to compensate. Reinstatement is friction-laden (Google Form, unclear SLA).

The temptation in a permissive design ("include everything that has a CLI") is to treat ToS as the provider's problem, not OLP's. That's wrong: OLP's user is the one whose account gets revoked. The temptation in a conservative design ("include only Tier D — fully safe") is to leave too much value on the table — the Chinese providers (MiniMax/GLM/Qwen) are token-economically attractive for the maintainer's usage patterns even with the consent-required overhead.

The structural middle path is a tiered framework with explicit consent UX for the optional tiers, modeled on the OCP ADR 0006 "Class A / Class B" precedent of using explicit categorization to manage scope risk.

One precision point requires emphasis. The Google Antigravity ban is **not** a "whole Google account ban." The verified scope (per the piunikaweb 2026-03-02 OpenClaw exec confirmation cited in spec §3.1) is *Google AI services tier*: Antigravity + Gemini CLI + Cloud Code Private APIs. Gmail, Drive, YouTube, Calendar, and other non-AI Google services are unaffected. Antigravity is excluded from OLP not on ban scope alone — a Google-AI-tier ban would still leave most of the user's Google services intact — but on the *combination* of: (a) explicit named prohibition of third-party tools, (b) no cost advantage versus Codex equivalents, and (c) reinstatement-process friction. Any one of these factors alone would not be sufficient for permanent exclusion; the combination is.

## Decision

OLP adopts a four-tier provider classification framework per spec §3.1:

**Tier A — Excluded by default.** Vendor's AI suite (note: scoped to AI services, not always whole account) suspended on enforcement; vendor documentation explicitly names third-party proxy tools as prohibited; subscription price does not differentially advantage the provider over Tier D alternatives. Bar is intentionally narrow: **all three conditions** must hold for Tier A exclusion. Single-signal triggers (e.g., a tightening clause with no enforcement) drop to Tier C, not A. **Cannot be re-included unless ADR 0006 is superseded or amended with new primary-source evidence.** "Tier A" is not "permanently and irrevocably excluded" — the project's amendment procedure remains available. What "Tier A" means is "the bar for re-inclusion is a constitutional change with primary-source evidence, not a routine PR."

**Tier B — Optional, default-disabled, explicit consent required.** Service-level key revocation risk; vendor may extend revocation across that vendor's AI surfaces but does not touch non-AI services. ToS contains explicit anti-automation language. Enable requires a one-time consent UX: the consent prompt names the specific provider's policy clause and the realistic outcome (key revocation, not account suspension). Consent is recorded in `~/.olp/config.json` with a timestamp.

**Tier C — Optional, default-disabled, no consent UX.** ToS language has tightened (recent ToS update with anti-third-party direction) but no enforcement history exists. Enable is a config toggle; no consent prompt because the risk is signal-only rather than documented.

**Tier D — Eligible for default-enabled.** No anti-third-party clauses in subscription ToS; healthy ecosystem; permissive maintainer posture (where verifiable, e.g., maintainer-confirmed via official channel). **Tier D classification does not automatically enable a provider in OLP**: enablement requires the provider to transition from Candidate to Enabled per ALIGNMENT.md § Provider Inventory (authority pin filled + plugin landed + Phase audit passed). Tier classification is the *eligibility* gate; the Candidate-to-Enabled transition is the *activation* gate.

**Current classification table (v0.1):**

| Provider | Tier | Reason |
|----------|------|--------|
| Anthropic (Claude Code) | D | OCP-inherited. Pre-2026-06-15 subscription model was permissive. Post-2026-06-15 the credit-pool-vs-subscription split is a **quota constraint** within OLP's mission (manage it via fallback), not a **third-party prohibition**. ToS does not name third-party tools. |
| OpenAI Codex | D | Codex maintainer signal indicates low risk: GitHub Discussion #8338 confirms the CLI is permissively licensed and that OSS projects doing similar work exist (maintainer also stated "I'm an engineer, not a lawyer," so the signal is a maintainer posture statement, **not** a formal ToS blessing). Codex CLI is the official Codex client; subscription auth via ChatGPT account is the intended UX. Formal ToS pin pending — recorded as a follow-up audit task in ALIGNMENT.md § One-shot Triggered Audits. |
| Mistral Vibe (Le Chat Pro) | D | Usage Policy contains no anti-third-party / anti-automation clauses. Vibe is the official Mistral CLI; Le Chat Pro subscription explicitly includes Vibe. |
| xAI Grok Build | C | Jan 2026 ToS tightening introduced more restrictive automation language; no documented enforcement wave; uses API-key auth (not SuperGrok OAuth) to remain in the lower-risk lane. |
| Moonshot Kimi | C | "3 violations = ban" generic policy; no third-party-CLI-specific enforcement observed; API-key auth (not OAuth). |
| MiniMax | B | Token Plan policy prohibits automated scripts. Key revocation risk documented. Consent: key may be revoked; account remains usable. |
| Zhipu GLM | B | Coding Plan restricted to "officially supported tools." Key revocation risk. Consent UX: key may be revoked; account remains usable. |
| Alibaba Qwen | B | Coding Plan policy prohibits automation. Key revocation risk. Consent UX as above. |
| Google Antigravity | A (evidence-backed, pending primary-source pin) | Feb 2026 enforcement wave restricted Antigravity + Gemini CLI + Cloud Code Private APIs for affected accounts. **Blast-radius caveat:** secondary reports disagree — piunikaweb 2026-03-02 cites an OpenClaw exec saying only Antigravity AI surfaces were affected (Gmail/Drive unaffected); other reports (piunikaweb 2026-02-23 itself, OpenClaw issue #14203 framing, VentureBeat, Digital Watch) describe affected users losing "entire Google account access" or "Workspace temporarily affected." The two pictures are not yet reconcilable from secondary sources. Excluded on the **combination** of: (1) Google FAQ reportedly names OpenClaw/OpenCode/Claude Code as prohibited third-party tools — this is the only provider in the survey with named-tool prohibition, **but the FAQ URL or archival snapshot has not been primary-source-pinned** at v0.1 founding; (2) AI Pro $20 / Ultra $200 is not differentially cheap vs OpenAI Codex Plus $20 / Pro $200, so no cost advantage to taking on the risk; (3) reinstatement process exists but is via Google Form with unclear SLA. Any single factor would not justify Tier A; the combination does. **Primary-source pinning is tracked as an open one-shot audit task** in ALIGNMENT.md § One-shot Triggered Audits; if the FAQ language cannot be primary-sourced within 90 days of 2026-05-23, an ADR 0006 amendment must propose a Tier reconsideration (possibly Tier C "evidence-backed signal only" rather than Tier A). |

**Consent UX for Tier B (per spec §3.1).** First-enable triggers a CLI prompt:

```
Enable MiniMax provider?

MiniMax's Token Plan policy prohibits automated scripts.
Realistic outcome of enforcement: your MiniMax API key may be revoked.
Scope: MiniMax service only. Other accounts unaffected.

This is a one-time consent. Type 'I understand' to enable, anything else to abort:
```

On 'I understand', `~/.olp/config.json` records `providers.minimax.consent_at: <ISO timestamp>` and the provider becomes enabled. Subsequent enables/disables are config toggles without re-prompting unless the consent record is cleared.

**Future provider additions.** Each new provider plugin (per ADR 0002) requires an accompanying inclusion ADR that:
1. Cites the provider's ToS / Usage Policy and any anti-third-party clauses found.
2. Cites enforcement history (or absence thereof).
3. Compares cost against existing Tier D providers — if no advantage, the addition must justify why the tier risk is worth taking.
4. Assigns a tier (A/B/C/D) using the framework above.
5. If Tier A: the plugin is not built. The ADR documents the exclusion for posterity.
6. If Tier B: the consent UX content is drafted in the ADR.

The inclusion ADR is a hard prerequisite for the plugin's merge — no ADR, no merge.

## Consequences

**Positive**
- Provider risk is enumerated and explicit. Users see in README's "Supported Providers" table which providers are Tier D / C / B / A and what the implications are. Surprise is structurally prevented.
- Tier B consent UX makes the user an active participant in the risk decision. They cannot accidentally enable a key-revocation-risk provider; they have to type 'I understand' literally.
- The framework is forward-compatible. New providers in 2027 / 2028 go through the same four-tier classification; the ADR per provider creates a documented trail of risk decisions over time.
- The Antigravity exclusion is documented at the framework level (not as an ad-hoc "we don't support this"), so future readers see *why* it's excluded — and specifically that the exclusion is on the combination of named-prohibition + no-cost-advantage + reinstatement-friction, not on ban-scope. The piunikaweb 2026-03-02 scope clarification is preserved in the ADR rather than degraded over time into folklore.

**Negative**
- Tier B's consent UX adds a step to first-enable. Users who already understand the risk perceive friction. The friction is intentional; the consent is the structural mechanism that protects the user.
- The framework is provider-by-provider, not category-by-category. A new Chinese provider similar to MiniMax/GLM/Qwen gets its own ADR even though the pattern is shared. This is intentional — boilerplate-and-paste ADRs are still cheaper than the alternative of "we just classed them together once and now we have a category drift problem when their ToS shifts."
- Tier-A exclusion is *permanent* in the current framework, with no documented reinstatement path. If Google were to walk back the named-tool prohibition and the cost picture changed, Antigravity would need a fresh ADR superseding this one. The framework deliberately makes Tier A "needs a new decision to revisit," not "auto-reconsidered each release."

**Mitigations**
- The README "Supported Providers" table is the user's first stop and surfaces tiers prominently. The dashboard (spec §4.6) shows tier per enabled provider so users see it on every dashboard load, not only at enable-time.
- Tier B consent prompts include the specific clause cited (e.g., "MiniMax Token Plan policy: 'No automated scripts'"). This avoids vague "this provider has terms" boilerplate that users would tune out.
- The framework's Tier A bar (three conditions, not one) is the structural counter-measure against "any provider with a tightening clause gets banned forever." Single-signal events drop to Tier C; only the combination justifies Tier A.

## Alternatives considered

**(a) Blanket "include everything that has a CLI."** Add Antigravity, add anything with a programmatic entry point, leave ToS judgment to the user. Rejected: this is the failure mode where the user's account gets revoked by Google because OLP's defaults said it was fine. OLP's defaults are part of OLP's contract with the user; they have to encode actual risk awareness.

**(b) Blanket "include only Tier D — fully safe."** Skip MiniMax, GLM, Qwen, Grok, Kimi entirely. Rejected: the Chinese providers are token-economically attractive enough that the consent UX is justified rather than blanket exclusion. The maintainer explicitly identified the Token Plan pricing as a reason to provide an opt-in path. A user choosing to opt in with consent is exercising informed choice; a blanket exclusion forecloses that choice.

**(c) Two-tier system (safe / risky) instead of four.** Simpler framework. Rejected: it conflates the Grok/Kimi case (signal-only, no enforcement history) with the MiniMax/GLM/Qwen case (explicit anti-automation language, documented revocation risk), which warrant different consent UX. Conflation either over-warns the Grok/Kimi user or under-warns the MiniMax user; four tiers separates the cases.

**(d) Per-provider ToS auto-check via a scheduled job.** A `bin/olp doctor` style command periodically fetches each provider's ToS and diffs against a stored snapshot, flagging changes. Rejected for v1.0: ToS pages are unstable HTML, anti-bot-protected, and frequently A/B-tested per region. Auto-checking is a project of its own; out of scope for v0.1. Manual review on each provider addition + annual re-review is the v1.0 substitute.

**(e) Document tier classifications in spec §3.1 only, no per-provider ADR for additions.** Lower-ceremony alternative. Rejected: a per-provider ADR creates the structural review gate (per ADR 0002) that prevents silent provider additions. The spec is updated alongside the ADR (decision log §10); the ADR carries the reasoning detail. Both layers earn their keep.

## Sources

- OLP v0.1 spec §3.1 (Scope — tiers, provider classifications, Antigravity exclusion reasoning)
- OLP v0.1 spec §10 (Decision log entries for the tier classifications)
- OCP ADR 0006 (OpenAI Shim Scope) — informs the risk-tier framing methodology of "explicit categorization with named criteria"
- Google FAQ on AI services (Feb 2026 enforcement wave) — referenced via spec §3.1
- piunikaweb 2026-03-02 OpenClaw exec confirmation on ban scope — referenced via spec §3.1
- Codex GitHub Discussion #8338 — Codex maintainer confirmation of permissive third-party-client posture
- 2026-05-23 provider deep-dive audit (on file per spec §11)

# OLP Alignment Constitution

**Status:** Active. This document is the supreme source of truth for OLP scope decisions. Conflicts with other documents (README, issues, prior commit messages, vendor documentation summaries) resolve in favor of this file.

**Project:** OLP (Open LLM Proxy) — a personal- and family-scale multi-provider LLM proxy that supersedes OCP (Open Claude Proxy). See `docs/adr/0001-project-founding.md` for the founding decision and the 2026-06-15 Anthropic billing-split trigger that motivated multi-provider scope.

---

## Core Principle

OLP is a **router-and-cache layer** over a fixed set of independent provider CLIs. It spawns those CLIs, forwards traffic between them and an OpenAI-compatible HTTP entry surface, normalizes shapes via an Intermediate Representation (IR), and caches deterministically. It is **not** an extension layer for any provider, and it is **not** a model-capability router.

This Core Principle decomposes into three honesty commitments:

1. **Per-provider plugin honesty.** Each provider plugin must honestly proxy the underlying provider CLI without invention. If the CLI does not perform a given operation, the plugin does not invent one.
2. **OpenAI-compat entry honesty.** The `/v1/chat/completions` entry surface must honestly implement OpenAI's published specification without invention. If OpenAI's spec does not define a field, OLP does not invent one.
3. **IR honesty.** The IR is the internal interop contract between the entry surface and provider plugins. Any extension to the IR requires an Architecture Decision Record (ADR) amendment before it ships.

OCP's constitution was anchored on a single wire authority (`cli.js`). OLP has **multiple wire authorities, one per provider plugin**, plus the OpenAI spec for the entry surface, plus the IR for internal interop. All three classes are governed uniformly by the Rules below.

---

## Rules

The five Rules below apply to every PR touching a provider plugin, the entry surface, or the IR. They are written in the language of the multi-authority model: each Rule names the authority the change must be reconciled against.

1. **Rule 1 (Cite First).** Before adding, renaming, or changing any provider invocation, request field, response field, IR field, or entry-surface behaviour, the author must identify and cite the relevant authority — the provider CLI's documentation or observed behaviour (provider plugin scope), the OpenAI `/v1/chat/completions` specification section (entry-surface scope), or the relevant ADR (IR scope). The citation goes in the commit message and PR body. An absent citation is itself a finding and must be declared.

2. **Rule 2 (No Invention).** OLP must not introduce: (a) provider CLI flags, invocation patterns, or output-shape assumptions the underlying provider CLI does not itself support; (b) OpenAI-spec fields, parameters, or response shapes that OpenAI's `/v1/chat/completions` specification does not document; (c) IR fields or semantics without an ADR amendment landing in the same merge or before. Speculative "Provider X probably uses Y" or "OpenAI clients probably expect Z" statements are prohibited.

3. **Rule 3 (Match the Implementation).** When proxying a provider CLI, the plugin must match its semantics on the wire it actually emits: output format, error codes, streaming chunk shape, exit-code conventions, auth artifact location. When implementing OpenAI-compat at the entry surface, OLP must match the spec wire-format. When carrying data through the IR, the IR's documented semantics are normative; provider plugins document any lossy translations. Deviations require an explicit, reviewed exception recorded in this file (Class-specific Exceptions section).

4. **Rule 4 (Unalignable Plugins / Fields Are Deleted).** A provider plugin that cannot be traced to a real CLI behaviour is removed, not disabled or feature-flagged. An IR field that cannot be traced to its authorizing ADR is removed. An entry-surface field that cannot be traced to OpenAI's spec is removed. The policy is removal, not deprecation. See the Unalignable Policy section.

5. **Rule 5 (Cite in Commits).** Every commit touching `lib/providers/<name>.mjs` must cite the provider CLI authority in the commit body. Every commit touching the entry surface must cite the OpenAI spec section URL. Every commit touching the IR must cite the authorizing ADR. CI performs a soft check for the citation pattern; reviewers enforce per `CLAUDE.md`.

---

## Authorities

OLP has three concurrent authorities. Each governs a distinct scope.

### Authority 1 — Per-provider CLI (provider-plugin scope)

Each provider plugin in `lib/providers/<name>.mjs` is governed by the underlying provider's CLI as the wire authority for that plugin. The plugin's job is to spawn the CLI and translate between its native IO and the IR.

**Provider authority pins** (audited at project founding 2026-05-23, re-audited annually per § Annual Audit):

| Provider key | Provider CLI | Audit pin (TBD on Phase-1 spawn) | Risk Tier (see § Risk Tier Framework) |
|---|---|---|---|
| `anthropic` | `claude -p` from `@anthropic-ai/claude-code` | inherits OCP's `cli.js` 2.1.89 audit pin at fork; OLP-side pin: `@anthropic-ai/claude-code` v2.1.89 (observed at D4 — `lib/providers/anthropic.mjs` header). Re-evaluate post-2026-06-15 per One-shot Triggered Audit above. | D (pre-2026-06-15) / re-evaluate post-2026-06-15 |
| `openai` | `codex exec --json` from OpenAI Codex CLI | Codex CLI reference page: https://developers.openai.com/codex/cli/reference (retrieved 2026-05-23 — §§ "codex exec [flags] PROMPT", "--json / --experimental-json", "--model, -m"; D6 WebFetch-verified reachable). Secondary authority: https://developers.openai.com/codex/cli/features §§ "Supported Models", "Automation". | D |
| `mistral` | `vibe --prompt --output json` from Mistral Vibe CLI | Mistral Vibe terminal quickstart: https://docs.mistral.ai/mistral-vibe/terminal/quickstart (retrieved 2026-05-23 — § "--prompt flag triggers programmatic mode; --output selects format (text, json, streaming)"; D8 WebFetch-verified reachable). Configuration authority: https://docs.mistral.ai/mistral-vibe/terminal/configuration (§§ auth file `~/.vibe/.env`, `MISTRAL_API_KEY` env var). | D |
| `grok` | `grok -p --output-format streaming-json` (xAI Build) | TBD at Phase 8+ enable | C |
| `kimi` | `kimi -p --output-format stream-json` (Moonshot) | TBD at Phase 8+ enable | C |
| `minimax` | TBD CLI command (MiniMax Token Plan) | TBD at opt-in enable | B |
| `glm` | TBD CLI command (Zhipu Coding Plan) | TBD at opt-in enable | B |
| `qwen` | TBD CLI command (Alibaba Coding Plan) | TBD at opt-in enable | B |

Citation format for provider-plugin PRs: `<provider> CLI <version> § <section-or-flag>` (e.g., `codex CLI v0.118.0 § exec --json output schema`) or a direct URL into the provider's published CLI documentation. If the change is based on observed behaviour rather than published documentation, the citation states that explicitly (`codex CLI v0.118.0 — observed behaviour, transcript attached`).

### Authority 2 — OpenAI specification (entry-surface scope)

OLP exposes a single external HTTP surface: `/v1/chat/completions` in OpenAI Chat Completions shape, plus a minimum administrative surface (`/health`, `/v1/models`, etc.). The OpenAI specification at https://platform.openai.com/docs/api-reference/chat is the wire authority for the entry surface.

Citation format for entry-surface PRs: OpenAI spec URL + the specific field, parameter, or behaviour. Example: `OpenAI Chat Completions, response_format parameter (https://platform.openai.com/docs/api-reference/chat/create#chat-create-response_format)`.

The spec pin lives in `docs/openai-spec-pin.md` — ✅ shipped as of D30 (2026-05-24); v0.1 baseline pinning the entry-surface fields OLP currently implements. Re-snapshot annually per § Annual Alignment Audit.

### Authority 3 — IR contract (internal interop scope)

The IR is the lingua franca between the entry surface and provider plugins. It is documented in `docs/adr/0003-intermediate-representation.md`. Any IR change — adding a field, removing one, or altering semantics — is an amendment to ADR 0003 and follows the ADR amendment procedure.

Citation format for IR PRs: `ADR 0003 § <section>` plus the amending ADR if applicable.

---

## Risk Tier Framework

Provider inclusion / exclusion is governed by a four-tier risk model. The full rationale lives in **ADR 0006 (Provider Inclusion / Exclusion Criteria)**.

| Tier | Meaning | OLP treatment |
|---|---|---|
| **A** — vendor AI-platform-wide enforcement + explicit named prohibition + poor cost/benefit | **Excluded by default.** Not bundled, not pluggable, not added via opt-in. Cannot be re-included unless ADR 0006 is superseded/amended with new primary-source evidence. |
| **B** — service-level key revocation; vendor may extend across AI services | **Optional tier 2.** Default-disabled. Requires one-time explicit consent prompt on enable. README documents the policy clause and realistic revocation outcome. |
| **C** — tightening signal; no documented enforcement history | **Optional tier 1.** Default-disabled. Opt-in via config without consent prompt. |
| **D** — permissive / safe | **Eligible for default-enabled** once the provider transitions from Candidate to Enabled (see Provider Inventory below). |

A vendor's documented ToS, FAQ language naming third-party proxy tools, observable enforcement history, and subscription cost/benefit jointly determine tier. Re-classification requires an ADR 0006 amendment. **Tier classification alone does not auto-enable a provider** — see the Candidate/Enabled split in Provider Inventory.

---

## Provider Inventory (v1.0)

OLP distinguishes **Candidate Providers** (declared in this constitution as intended for inclusion, but **not yet authority-pinned**) from **Enabled Providers** (authority pin filled, plugin landed, Phase audit passed; eligible for default-enabled or opt-in installation).

The v0.1 founding commit ships **zero Enabled Providers**. This is intentional: a constitution that names a provider as "default-enabled" while its CLI version, output shape, auth artifact, and exit-code semantics are still TBD violates Rules 1 (Cite First) and 3 (Match the Implementation). Enablement is a Phase audit deliverable, not a bootstrap claim.

### Enabled Providers

| Provider key | Tier | Default state | Authority pin | Inclusion source |
|---|---|---|---|---|
| _(none at v0.1 founding — populated as Phase audits land)_ | — | — | — | — |

A provider transitions from Candidate to Enabled only when **all three** of the following hold:
1. Its row in the Authority pin table (Authorities § 1 above) is filled with a real CLI version + observed-behaviour transcript or docs URL — no `TBD`.
2. Its plugin lands in `lib/providers/<name>.mjs` per ADR 0002, conforming to the v1.0 Provider contract.
3. A Phase audit per spec §6 reports passing E2E for that provider (smoke against `/v1/chat/completions` round-trip + cache hit/miss + fallback chain entry).

### Candidate Providers

| Provider key | Anticipated Tier | Anticipated Phase | Inclusion source |
|---|---|---|---|
| `anthropic` | D (re-eval post-2026-06-15) | Phase 1 | ADR 0001 § Mission inheritance; ADR 0006 |
| `openai` | D | Phase 2 | ADR 0006 |
| `mistral` | D | Phase 3 | ADR 0006 |
| `grok` | C | Phase 8+ | ADR 0006 |
| `kimi` | C | Phase 8+ | ADR 0006 |
| `minimax` | B | Phase 8+ | ADR 0006 |
| `glm` | B | Phase 8+ | ADR 0006 |
| `qwen` | B | Phase 8+ | ADR 0006 |

**Excluded by default (Tier A candidate):** Google Antigravity. See ADR 0006 for the rationale, currently classified as **evidence-backed exclusion pending primary-source pin** — the Google FAQ language reportedly naming OpenClaw / OpenCode / Claude Code as prohibited is cited from secondary reports (VentureBeat, piunikaweb, The Register, OpenClaw issue #14203); a primary-source URL or archival snapshot is a follow-up audit task. Until the primary source is pinned, the Tier A classification rests on secondary evidence — sufficient for default-not-bundled, but not yet sufficient for "permanent" in the constitutional sense. Re-inclusion requires an ADR 0006 amendment with primary-source evidence either confirming or contradicting the current secondary picture.

---

## Unalignable Policy

A change is **unalignable** if, after a good-faith search, it cannot be mapped to:

- a specific provider CLI flag, documented behaviour, or observed transcript (provider-plugin scope), **or**
- a specific OpenAI specification section (entry-surface scope), **or**
- an existing or co-merged ADR (IR scope).

Unalignable changes are **deleted**, not disabled, not feature-flagged, not deprecated.

Burden of proof is on the change author. Audit findings that cannot be reconciled trigger an immediate deletion PR. There is no grandfathering for OLP — the project is new and inherits no legacy contracts.

If a user workflow appears to depend on an unalignable behaviour, the correct remediations are: (a) upstream the behaviour into the relevant provider's CLI (engage that vendor), (b) propose an OpenAI-spec extension and wait for adoption, (c) write an ADR authorizing a new IR field, or (d) move the behaviour out of OLP into a separate tool. OLP does not retain it.

---

## One-shot Triggered Audits

In addition to the recurring 14 May audit below, the following one-shot audits are scheduled and must complete on their named trigger:

- **2026-06-16 (or first Anthropic Agent SDK Credit billing-cycle close, whichever is later)** — verify the post-2026-06-15 Anthropic billing-split behaviour matches the spec §2 assumption: programmatic `claude -p` traffic is metered against the separate Agent SDK Credit pool, not Plan limits. Update the Anthropic Authority pin row above with the observed behaviour, update ADR 0006 with the post-effective-date Tier re-evaluation, and append a Decision-log entry to the spec §10. If observed behaviour diverges from the spec assumption (e.g., Plan limits still apply, or credit pool meter differs from `$100/Max5x/month`), file a Risk-Tier reclassification per ADR 0006 amendment procedure.

- **Antigravity primary-source pin (open-ended, no deadline)** — find a primary-source URL or archival snapshot for the Google FAQ language naming OpenClaw / OpenCode / Claude Code as prohibited. Pin the URL + retrieval timestamp into ADR 0006. If the primary source cannot be located within 90 days of this commit and only secondary reports remain, file an ADR 0006 amendment proposing a re-classification (Tier A may need to soften to Tier C "evidence-backed signal only" if the prohibition cannot be primary-sourced).

- **OpenAI Codex ToS formal pin (trigger: Phase 2 E2E enable for Codex, OR 2026-12-31, whichever comes first)** — ADR 0006 § Classification table row "OpenAI Codex" currently relies on Codex GitHub Discussion #8338 (maintainer posture: "I'm an engineer, not a lawyer") as the authority pin, which is a maintainer statement of permissive intent rather than a formal ToS blessing. Before Codex transitions from Candidate to Enabled (Phase 2 E2E audit), locate and pin a primary-source ToS URL or official OpenAI policy document that explicitly addresses third-party CLI proxying. If no such document exists by 2026-12-31, file an ADR 0006 amendment documenting the absence as the formal conclusion of this audit task. Update ADR 0006 § Classification table row "OpenAI Codex" with the audit outcome.

---

## Annual Alignment Audit

- **Date:** 14 May each year (the anniversary of the Anthropic 2026-05-14 announcement, which is the structural trigger for OLP).
- **Scope (per-provider plugin):** For each enabled provider, re-audit the provider CLI version against the pin in the Authorities table above. Re-verify that every spawn invocation, flag, and output-parser expectation in `lib/providers/<name>.mjs` still matches that CLI version's actual behaviour. Update the pin row in this file.
- **Scope (entry surface):** Snapshot OpenAI's `/v1/chat/completions` specification and diff against the pin in `docs/openai-spec-pin.md` (✅ v0.1 baseline shipped D30). For each field OLP implements, verify the spec still defines it the same way. Update the pin.
- **Scope (IR):** Diff the IR documented in ADR 0003 against the implementation in `lib/ir/`. Any drift triggers an amendment or a deletion PR.
- **Scope (Risk Tier reclassifications):** For each provider, re-evaluate the risk tier against current ToS, FAQ language, and observed enforcement events from the past year. Reclassifications land as ADR 0006 amendments.
- **Output:** A signed audit note committed to `docs/alignment-audits/YYYY-05-14.md` (📋 `docs/alignment-audits/` directory does not exist yet; it is created when the first audit is conducted). Inline pin updates go into this file.
- **Failure mode:** Any finding that cannot be reconciled triggers an immediate deletion PR per the Unalignable Policy.

---

## Class-specific Exceptions

(none at project founding)

Any future Rule 3 deviation lands here as a numbered exception with PR link, reviewer, and rationale.

---

## Amendment Procedure

This constitution is amended only by a PR that (a) cites the evidence motivating the amendment, (b) is reviewed by an independent reviewer per CC Iron Rule 10, and (c) updates the relevant ADR if the amendment is structural. Amendments never retroactively legitimize previously unalignable changes.

---

## Reference: How OCP's `cli.js` discipline maps to OLP

OLP did not abandon OCP's discipline — it generalized it. The mapping:

| OCP concept | OLP equivalent |
|---|---|
| `cli.js` as single golden reference | Per-provider CLI as authority for that plugin; OpenAI spec as authority for entry surface; IR contract as authority for internal interop |
| "Grep `cli.js` before touching `server.mjs`" | "Cite the relevant provider CLI doc or behaviour before touching that provider's plugin; cite OpenAI spec before touching the entry surface; cite the relevant ADR before touching the IR" |
| Class A / Class B endpoint discipline | Per-provider plugin scope + entry-surface scope + IR amendment process — each scope has its own citation requirement |
| `cli.js:NNNN` citation format | `<provider> CLI <version> § <section>` (provider) / OpenAI spec URL + field (entry) / `ADR NNNN § <section>` (IR) |
| Single ALIGNMENT.md governing one CLI | One ALIGNMENT.md governing many CLIs uniformly via the plugin contract |
| 2026-04-11 drift lesson | Inherited as institutional memory; no OLP-side incident yet. The blacklist in `.github/workflows/alignment.yml` carries the OCP-era token forward as a transitive guardrail. |

---

**Authors:** project maintainer (with AI drafting assistance).
**First committed:** 2026-05-23 with the OLP repo bootstrap PR.

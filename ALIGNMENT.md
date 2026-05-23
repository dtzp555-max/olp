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
| `anthropic` | `claude -p` from `@anthropic-ai/claude-code` | inherits OCP's `cli.js` 2.1.89 audit pin at fork; OLP-side pin set when Phase 1 lands | D (pre-2026-06-15) / re-evaluate post-2026-06-15 |
| `openai` | `codex exec --json` from OpenAI Codex CLI | TBD at Phase 2 spawn |  D |
| `mistral` | `vibe --prompt --output json` from Mistral Vibe CLI | TBD at Phase 3 spawn | D |
| `grok` | `grok -p --output-format streaming-json` (xAI Build) | TBD at Phase 8+ enable | C |
| `kimi` | `kimi -p --output-format stream-json` (Moonshot) | TBD at Phase 8+ enable | C |
| `minimax` | TBD CLI command (MiniMax Token Plan) | TBD at opt-in enable | B |
| `glm` | TBD CLI command (Zhipu Coding Plan) | TBD at opt-in enable | B |
| `qwen` | TBD CLI command (Alibaba Coding Plan) | TBD at opt-in enable | B |

Citation format for provider-plugin PRs: `<provider> CLI <version> § <section-or-flag>` (e.g., `codex CLI v0.118.0 § exec --json output schema`) or a direct URL into the provider's published CLI documentation. If the change is based on observed behaviour rather than published documentation, the citation states that explicitly (`codex CLI v0.118.0 — observed behaviour, transcript attached`).

### Authority 2 — OpenAI specification (entry-surface scope)

OLP exposes a single external HTTP surface: `/v1/chat/completions` in OpenAI Chat Completions shape, plus a minimum administrative surface (`/health`, `/v1/models`, etc.). The OpenAI specification at https://platform.openai.com/docs/api-reference/chat is the wire authority for the entry surface.

Citation format for entry-surface PRs: OpenAI spec URL + the specific field, parameter, or behaviour. Example: `OpenAI Chat Completions, response_format parameter (https://platform.openai.com/docs/api-reference/chat/create#chat-create-response_format)`.

The spec pin lives in `docs/openai-spec-pin.md` (created at Phase 1; not required for v0.1 governance bootstrap to land).

### Authority 3 — IR contract (internal interop scope)

The IR is the lingua franca between the entry surface and provider plugins. It is documented in `docs/adr/0003-intermediate-representation.md`. Any IR change — adding a field, removing one, or altering semantics — is an amendment to ADR 0003 and follows the ADR amendment procedure.

Citation format for IR PRs: `ADR 0003 § <section>` plus the amending ADR if applicable.

---

## Risk Tier Framework

Provider inclusion / exclusion is governed by a four-tier risk model. The full rationale lives in **ADR 0006 (Provider Inclusion / Exclusion Criteria)**.

| Tier | Meaning | OLP treatment |
|---|---|---|
| **A** — vendor AI-platform-wide ban + explicit named prohibition + poor cost/benefit | **Permanently excluded.** Not bundled, not pluggable, not added via opt-in. |
| **B** — service-level key revocation; vendor may extend across AI services | **Optional tier 2.** Default-disabled. Requires one-time explicit consent prompt on enable. README documents the policy clause and realistic revocation outcome. |
| **C** — tightening signal; no documented enforcement history | **Optional tier 1.** Default-disabled. Opt-in via config without consent prompt. |
| **D** — permissive / safe | **Default-enabled.** Bundled in default config. |

A vendor's documented ToS, FAQ language naming third-party proxy tools, observable enforcement history, and subscription cost/benefit jointly determine tier. Re-classification requires an ADR 0006 amendment.

---

## Provider Inventory (v1.0)

| Provider key | Tier | Default state | Inclusion source |
|---|---|---|---|
| `anthropic` | D (re-eval post-2026-06-15) | Enabled | ADR 0001 § Mission inheritance; ADR 0006 |
| `openai` | D | Enabled | ADR 0006 |
| `mistral` | D | Enabled | ADR 0006 |
| `grok` | C | Disabled (opt-in) | ADR 0006 |
| `kimi` | C | Disabled (opt-in) | ADR 0006 |
| `minimax` | B | Disabled (consent required) | ADR 0006 |
| `glm` | B | Disabled (consent required) | ADR 0006 |
| `qwen` | B | Disabled (consent required) | ADR 0006 |

**Excluded permanently (Tier A):** Google Antigravity. See ADR 0006 for the named-prohibition + no-cost-advantage + reinstatement-friction rationale. Re-inclusion requires an ADR 0006 amendment with new evidence of policy change.

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

## Annual Alignment Audit

- **Date:** 14 May each year (the anniversary of the Anthropic 2026-05-14 announcement, which is the structural trigger for OLP).
- **Scope (per-provider plugin):** For each enabled provider, re-audit the provider CLI version against the pin in the Authorities table above. Re-verify that every spawn invocation, flag, and output-parser expectation in `lib/providers/<name>.mjs` still matches that CLI version's actual behaviour. Update the pin row in this file.
- **Scope (entry surface):** Snapshot OpenAI's `/v1/chat/completions` specification and diff against the pin in `docs/openai-spec-pin.md`. For each field OLP implements, verify the spec still defines it the same way. Update the pin.
- **Scope (IR):** Diff the IR documented in ADR 0003 against the implementation in `lib/ir/`. Any drift triggers an amendment or a deletion PR.
- **Scope (Risk Tier reclassifications):** For each provider, re-evaluate the risk tier against current ToS, FAQ language, and observed enforcement events from the past year. Reclassifications land as ADR 0006 amendments.
- **Output:** A signed audit note committed to `docs/alignment-audits/YYYY-05-14.md`, updating pins inline in this file as needed.
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

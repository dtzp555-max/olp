@AGENTS.md
@~/.cc-rules/AGENTS.md

# OLP Project Session Instructions

> **WARNING — READ BEFORE WRITING ANY CODE IN THIS REPO**
>
> Before touching any provider plugin (`lib/providers/*.mjs`), the entry surface (`server.mjs` request handlers), or the IR (`lib/ir/*`), read [`./ALIGNMENT.md`](./ALIGNMENT.md) in full. The constitution is binding. Non-compliant commits are reverted.

---

## Before starting any task

1. Read `./ALIGNMENT.md`. Internalize the five Rules and the three-authority model (per-provider CLI / OpenAI spec / IR contract).
2. Run `/dev-start <task description>` to get a pre-flight plan that incorporates the iron rules, `SKILL_ROUTING.md`, this file, and `ALIGNMENT.md`.
3. Locate the provider authority **before** drafting any code:
   - Provider-plugin change → identify the provider CLI documentation page or observed behaviour you are matching, and pin the CLI version.
   - Entry-surface change → identify the OpenAI `/v1/chat/completions` spec section and URL.
   - IR change → identify the ADR you are amending or co-merging.
   No code is written ahead of the authority citation.

---

## Hard requirements for plugin / server.mjs / IR changes

Every PR that modifies a provider plugin, the entry surface in `server.mjs`, or the IR in `lib/ir/` must satisfy all three of the following. A PR missing any one of them is blocked from merge.

1. **Authority citation.** The commit message and PR body declare the relevant authority and citation:
   - Provider plugin → `<provider> CLI <version> § <section-or-flag>` plus URL or transcript reference.
   - Entry surface → OpenAI spec URL plus the specific field, parameter, or behaviour.
   - IR → `ADR NNNN § <section>` (and the amending ADR if applicable).
   If the underlying authority does not perform the operation, the PR must state this explicitly and justify scope under `ALIGNMENT.md` Rule 2 (in practice, this almost always means the PR should be closed).
2. **CI `alignment.yml` pass.** The workflow must pass. It greps for known-hallucinated tokens, validates `models-registry.json`, and soft-checks per-provider commit citations. New blacklist tokens are added via PR amendment to `alignment.yml`; removing entries requires an `ALIGNMENT.md` amendment PR. Do not suppress the workflow.
3. **Independent reviewer (Iron Rule 10).** The implementation author may not self-approve. A separate reviewer — human or a subagent spawned with a fresh context — must read the diff, open the cited authority (provider CLI doc / OpenAI spec / ADR), and explicitly confirm the citation. A review comment that does not confirm the authority was checked is not a valid approval.

---

## Iron rules in force

This repo operates under the CC Development Iron Rules (CC 开发铁律) v1.4. Three rules are load-bearing for OLP work:

- **Iron Rule 10 (Code Review).** Every implementation phase has an independent reviewer. Self-review does not count. See hard requirement #3 above.
- **Iron Rule 11 (Incremental Diff Review).** Non-trivial work is split into the minimum reviewable unit — one PR per layer per severity. `ALIGNMENT.md`, this file, the PR template, and the CI workflows are shipped as a single constitutional PR (one layer: governance). Subsequent layers (plugin loader, individual provider plugins, IR serializers, cache layer, fallback engine, dashboard) each land as their own PR.
- **Iron Rule 12 (Pre-Brainstorm Prior-Art Search).** Before proposing any new IR field, fallback trigger, or provider plugin, search the relevant provider's docs, OpenAI's spec, the local `docs/adr/`, and the cross-machine `~/.cc-rules/memory/learnings/`. The provider-specific search is the decisive one: if the provider CLI does not perform the operation, Rule 2 of the constitution applies.

The full iron rules are at `~/.claude/CC_DEV_IRON_RULES.md` (symlinked from the cc-rules repo on the maintainer's workstations). Load them into session context with `/cc-rules` when needed.

---

## Skills relevant to this repo

- `/dev-start` — pre-flight planning, always first for non-trivial tasks.
- `/cc-rules` — load the iron rules into context.
- `/agent-dispatch` — pick the correct model (opus for design and review, sonnet for straightforward edits, haiku for mechanical chores) before spawning any subagent.
- `/cc-mem search <keyword>` — look up cross-machine memory for prior decisions, especially provider-policy events and CLI-version migrations.

---

## Commit message conventions

- Subject line uses Conventional Commits (`fix:`, `feat:`, `docs:`, `refactor:`, `chore:`).
- Provider-plugin commits include the citation pattern `<provider> CLI <version>` or a direct provider docs URL in the body. CI performs a soft check.
- Entry-surface commits include an OpenAI spec URL.
- IR commits cite the authorizing or amending ADR.
- Any assertion of the form "Provider X uses Y" in the body must be immediately followed by a citation (CLI version + section, or docs URL, or observed-transcript reference). CI soft-checks the pattern.
- Co-author trailer is required for LLM-assisted commits (`Co-Authored-By: Claude <model> <noreply@anthropic.com>`).

---

## Project-level escalation

If a design decision cannot be resolved by reference to the relevant authority (provider CLI / OpenAI spec / ADR) and `ALIGNMENT.md`, escalate to the project maintainer via `/cc-chat` rather than guessing. Silent guessing is what produced OCP's 2026-04-11 drift; OLP inherits that institutional lesson and does not repeat it.

---

## Release kit overlay (CC 开发铁律 第五律 5.5)

This project's overlay per iron rule v1.4's 5.5. Machine-checkable declaration.

```yaml
release_kit:
  version_source: package.json
  changelog: CHANGELOG.md
  release_channel:
    type: github-release
    tag_format: v{semver}
    auto_create_on_tag_push: true   # via .github/workflows/release.yml
  docs_source: README.md
  resource_lists:
    - name: Supported Providers table
      location: README.md § "Supported Providers"
      source_of_truth: models-registry.json
    - name: Routing chains table
      location: README.md § "Configuration"
    - name: API Endpoints table
      location: README.md § "API Endpoints"
    - name: Environment Variables table
      location: README.md § "Environment Variables"
  new_feature_doc_expectations:
    - new provider plugin → README § "Supported Providers" entry + ADR 0006 inclusion entry + risk-tier classification
    - new fallback trigger → README § "Configuration" + tests in test-features.mjs
    - new IR field → ADR 0003 amendment + README impact note (if user-visible)
    - new env var → README § "Environment Variables" table
    - new endpoint → README § "API Endpoints" table + relevant Config / Troubleshooting §
    - new auto-sync / hook → dedicated §, must document trigger + manual invocation + opt-out + any bootstrap quirk
    - new file / SPOT / schema → Architecture or contributor § with link
  bootstrap_quirk_policy:
    - any first-run migration quirk (e.g., from OCP) → README § "Troubleshooting" + scripts/migrate-from-ocp.mjs if applicable
    # NOTE: scripts/migrate-from-ocp.mjs is planned (Phase 7), not yet authored. The scripts/ directory
    # does not currently exist. References here are forward-looking; do not attempt to run this script.
```

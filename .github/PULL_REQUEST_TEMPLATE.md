# Pull Request

## Summary

<!-- One or two sentences describing the change and why it is in scope for OLP. -->

## Change Type (REQUIRED)

Pick the most specific applicable type. PRs touching multiple types must fill the evidence section for each (Hybrid covers spans of changes across types):

- [ ] **Provider Plugin** — change to `lib/providers/<name>.mjs`. Specify which:
  - [ ] `anthropic`
  - [ ] `openai`
  - [ ] `mistral`
  - [ ] `grok`
  - [ ] `kimi`
  - [ ] `minimax`
  - [ ] `glm`
  - [ ] `qwen`
- [ ] **Entry Surface** — change to a request handler in `server.mjs`. Specify which endpoint:
  - [ ] `/v1/chat/completions`
  - [ ] `/health`
  - [ ] `/v1/models`
  - [ ] `/cache/stats`
  - [ ] `/v0/management/quota`
  - [ ] other (specify in Summary)
- [ ] **IR** — change to `lib/ir/*`. Requires an ADR amendment (existing or co-merged in this PR).
- [ ] **Fallback Engine** — change to `lib/fallback/*`. Cite ADR 0004.
- [ ] **Cache Layer** — change to `lib/cache/*`. Cite ADR 0005.
- [ ] **Governance / docs / CI** — change to `ALIGNMENT.md`, `AGENTS.md`, `CLAUDE.md`, `docs/`, or `.github/workflows/*`.
- [ ] **Not source-touching** — test infra, scripts that do not touch any of the above, dependency hygiene.
- [ ] **Hybrid** — spans multiple types above. Fill every applicable evidence section.

## Authority Evidence (REQUIRED)

PRs with the relevant evidence section blank or unchecked will receive a `request changes` review and cannot be merged. Per `ALIGNMENT.md` Rules 1 and 5.

### If Provider Plugin

- [ ] **Provider CLI documentation citation.** I have identified the provider CLI documentation page (URL) or observed-behaviour transcript that this change reflects. CLI version audited:
  <!-- e.g., codex CLI v0.118.0 § `exec --json` output schema (https://platform.openai.com/docs/codex/cli/exec) -->

- [ ] **Behaviour the change reflects.** I have described in one sentence what the provider CLI actually does that this PR matches.
  <!-- e.g., "codex exec --json emits one JSONL line per delta; final line has finish_reason=stop" -->

- [ ] **If the provider CLI does not perform this operation**, I have stated this explicitly below and justified the scope under `ALIGNMENT.md` Rule 2. (Note: in almost all cases this means the PR should be closed, not merged. Provider plugins do not invent CLI behaviour. If the desired behaviour belongs at the entry surface or IR layer, switch the Change Type above accordingly.)
  <!-- Justification, if applicable. Empty is fine when the CLI does perform the operation. -->

- [ ] **Commit message citations.** Every "Provider X uses Y" or "<provider> CLI uses Y" assertion in every commit of this PR is immediately followed by a citation (CLI version + section, docs URL, or observed-transcript reference). I have verified this by rereading each commit message.

### If Entry Surface

- [ ] **OpenAI spec citation.** I have linked to the relevant section of OpenAI's `/v1/chat/completions` specification, including the specific field, parameter, or behaviour being implemented.
  <!-- e.g., OpenAI Chat Completions, `response_format` parameter, https://platform.openai.com/docs/api-reference/chat/create#chat-create-response_format -->

- [ ] **No invention beyond the spec.** I confirm this PR does not introduce any field or behaviour not present in OpenAI's spec for the endpoint. If something the user actually wants is not in the spec, the right answer is to close this PR and propose an upstream spec change or move the behaviour to the IR with an ADR.

### If IR

- [ ] **Authorizing ADR.** Cite the ADR that authorizes the IR change. If this PR introduces a new IR field or alters semantics, the amending ADR must land in this PR or before it.
  <!-- e.g., ADR 0003 § "IR fields"; amendment in docs/adr/0007-ir-tool-result-shape.md -->

### If Fallback Engine

- [ ] **ADR 0004 citation.** Cite the specific section of ADR 0004 (Fallback Engine Semantics & Safety) the change implements or amends.
  <!-- e.g., ADR 0004 § "Idempotent failure safety" -->

- [ ] **Trigger documentation.** If this PR adds a new trigger type, document it in `README.md § Configuration` and add a test case.

### If Cache Layer

- [ ] **ADR 0005 citation.** Cite the specific section of ADR 0005 (Cache Layer Cross-Provider Design) the change implements or amends.
  <!-- e.g., ADR 0005 § "Cache key generation" -->

- [ ] **Cache-key impact.** Confirm whether this PR changes the cache key formula. If yes, document in CHANGELOG that existing cache entries will warm-cold-start.

## Type of change

- [ ] Bug fix (alignment with existing provider CLI behaviour, OpenAI spec, or cited ADR)
- [ ] Feature (new provider plugin / new IR field / new fallback trigger / new endpoint already in OpenAI's spec)
- [ ] Refactor (no wire-level behaviour change)
- [ ] Deletion (unalignable change removal per `ALIGNMENT.md` Unalignable Policy)
- [ ] Documentation / governance

## Reviewer checklist (Iron Rule 10)

Reviewers: this section is for you, not the author. Do not approve until every box is checked.

- [ ] I opened the cited authority and confirmed the change matches:
  - Provider Plugin → opened the provider CLI doc page / verified the observed-behaviour transcript at the pinned CLI version.
  - Entry Surface → opened the OpenAI spec at the cited section.
  - IR → opened the cited ADR.
  - Fallback / Cache → opened the cited ADR section.
- [ ] I ran (or confirmed CI ran) `.github/workflows/alignment.yml` and it passed.
- [ ] I am not the commit author of any commit in this PR (Iron Rule 10).
- [ ] If the PR asserts scope without a canonical citation, I confirmed the justification is sound per `ALIGNMENT.md` Rule 2.
- [ ] If the PR adds a new provider plugin, I confirmed the ADR 0006 risk-tier classification is in the same merge or before.
- [ ] If the PR adds a new IR field, I confirmed the amending ADR lands in the same merge or before.

## Related

- `ALIGNMENT.md` Rule(s) invoked: <!-- e.g. Rule 3 -->
- Authority cited: <!-- provider CLI doc URL / OpenAI spec URL / ADR number -->
- Related issue / prior PR: <!-- #NNN -->

### User-visible change self-check (release_kit § new_feature_doc_expectations)

- [ ] This PR has user-visible changes → README has corresponding documentation (paste diff link or line range)
- [ ] This PR adds a new provider plugin → README "Supported Providers" entry present + ADR 0006 risk-tier classification entry present
- [ ] This PR adds a new fallback trigger → README "Configuration" entry present + test added
- [ ] This PR adds a new env var → README "Environment Variables" table entry present
- [ ] This PR adds a new endpoint → README "API Endpoints" table entry present
- [ ] This PR has no user-visible changes → stated "no user-visible change" in summary above

Reviewers: if any "user-visible" box is checked but README diff is empty, block merge.

### Privacy self-check (for PUBLIC repos)

- [ ] This PR does not introduce real names, nicknames, or handles that identify specific individuals. All references use role-based terms (`project maintainer`, `contributor`, `user`, `reviewer`).
- [ ] This PR does not introduce literal personal paths (`/Users/<username>/`, `/home/<username>/`). Uses `$HOME/` or `~/` instead.
- [ ] This PR does not introduce personal machine hostnames. Uses role-based names or generic descriptors.
- [ ] This PR does not introduce personal email addresses beyond automated placeholders like `noreply@<vendor>.com`.
- [ ] This PR does not introduce literal credentials, tokens, or API keys (even expired ones).

Reviewers: if any of the above is violated and the repo is PUBLIC, block merge and request scrub.

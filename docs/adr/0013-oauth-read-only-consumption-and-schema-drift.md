# ADR 0013 — OAuth READ-ONLY Consumption Rules + Schema-Drift Mitigation Protocol

**Status:** Accepted (2026-05-26)
**Date:** 2026-05-26
**D-day:** D79 (lands alongside ADR 0012 Phase 5 charter + ADR 0002 Amendment 8 as the constitutional trio of Phase 5)

---

## Context

ADR 0002 Amendment 8 permits `quotaStatus()` to call provider HTTP APIs directly, subject to a READ-ONLY constraint. That Amendment opens the door but does not specify HOW READ-ONLY discipline is preserved across credential lifecycle events (refresh, expiry, revocation), nor how OLP detects when the upstream API schema drifts. ADR 0013 fills both gaps.

The motivating concern: a provider that ships its CLI as a **compiled native binary** (Anthropic Claude Code v2.1.x is now Mach-O on macOS, ELF on Linux) closes off the previous schema-verification path (grep `cli.js`). If OLP's probe parser silently breaks because a header was renamed, the dashboard shows stale or wrong numbers, and the maintainer's load-bearing throttling decision is based on bad data. This ADR establishes the verification protocol that survives the binary-distribution shift.

A second motivating concern: the OAuth credentials used by the probe are the SAME credentials the spawn path uses for `claude -p`. Both paths consume them; the probe must not interfere with the spawn path's ability to refresh or invalidate them. Concretely: the probe must not write to the credentials artifact, must not race the spawn path on refresh, and must not amplify a 429 into a refresh storm.

---

## Decision

### Rule 1 — Credential reuse is mandatory

The probe MUST consume the same OAuth artifact the spawn path reads via the plugin's `readAuthArtifact()`. No new OAuth grant. No alternate credential store. No environment-variable-only fallback (env var `CLAUDE_CODE_OAUTH_TOKEN` is supported as an override consistent with the spawn path, but is not the probe's primary source).

Precedence order (mirrors OCP `getOAuthCredentials` 2026-04-stable):

1. `process.env.CLAUDE_CODE_OAUTH_TOKEN` if non-empty (manual override; common in CI / dev / one-off debugging).
2. `~/.claude/.credentials.json` → `claudeAiOauth.accessToken` (Linux + macOS without keychain access).
3. macOS Keychain: `security find-generic-password -a "${USER}" -s "Claude Code-credentials" -w` (preferred on macOS — current `lib/providers/anthropic.mjs` only covers (1) + (2); D80 adds (3)).

Rationale: a separate OAuth grant would require the maintainer to repeat `claude setup-token` against an OLP-specific scope, doubling credential exposure and divergence risk. Reusing the spawn path's credentials guarantees the probe never has more permission than the spawn path itself.

### Rule 2 — READ-ONLY at the wire

The probe MUST issue exactly one HTTP request per cache miss. Method MAY be POST (Anthropic's ratelimit headers come back on `POST /v1/messages`; this is the only way to read them). Request body MUST minimise side effects:

- `max_tokens: 1` (cost: ~$0.000001 per probe)
- `messages: [{role: "user", content: "hi"}]` (any minimal valid payload)
- Model: cheapest available in the plan (`claude-haiku-4-5` at v0.5.0)
- Do NOT include `system` prompts, `tools[]`, `tool_choice`, large content arrays, or anything that the upstream might bill differently.

The probe MUST discard the response body. Only response headers are parsed.

The probe MUST NOT call any other HTTP path on the provider's API. No `/v1/models` enumeration, no admin endpoints, no `/v1/messages/<id>` retrievals. The only permitted endpoint is `POST /v1/messages`.

### Rule 3 — Cache TTL and refresh discipline

- Cache TTL: 5 minutes. Cache miss triggers a real probe. Cache hit returns the cached value.
- The dashboard refreshes every 1 minute; that's served from the cache between probes. A manual refresh button MAY force-clear the cache (per maintainer request 2026-05-26); ADR 0012 D82 documents the button.
- On refresh failure (token expired, 401/403/429, network error), the probe schedules an exponential backoff: minimum 60s, maximum 3600s. The cache entry is NOT invalidated during backoff; `quotaStatus()` returns the stale cache marked `{ stale: true, last_fresh_at: <epoch> }`. If no stale entry exists, returns an `unreachable` shape (v0.5.1+) rather than `null`.
- Successive successful probes reset the backoff to the minimum.
- Token refresh (`POST https://platform.claude.com/v1/oauth/token`) follows the same backoff discipline. The probe MUST NOT refresh a token more than once per backoff window. The refresh path is shared with the spawn path; both observe the same backoff.
- **All consumers of `quotaStatus()`, including `olp doctor` checks, MUST route through `quotaStatus()` and MUST NOT call `_probeOnce()` directly.** `_probeOnce()` is an internal implementation detail. Routing doctor checks through `quotaStatus()` ensures the cache+backoff discipline is enforced for every caller — including operators running `olp doctor` in a debug loop. (Clarification added v0.5.1 to address codex finding F1: the original doctor check bypassed backoff by calling `_probeOnce` directly.)

### Rule 4 — Opt-in via config

A new config field at `~/.olp/config.json` controls per-provider opt-in:

```json
{
  "providers": {
    "anthropic": {
      "enabled": true,
      "quota_probe_enabled": false
    }
  }
}
```

Default: `false`. The maintainer must explicitly opt in after credentials are configured. Reasoning: a fresh install on a machine without OAuth credentials should not bombard `api.anthropic.com` with 401-bound probes.

`olp doctor` adds a per-provider check `<provider>.quota_probe_reachable` (only runs if `quota_probe_enabled: true`). Failed check provides a `next_action.ai_executable[]` recipe to either re-authenticate or disable the probe.

### Rule 5 — Schema-drift mitigation protocol (minimum-viable-schema gate)

The CC binary-distribution shift means OCP's "grep cli.js" verification is no longer applicable. OLP adopts a two-path protocol for proactive monitoring, AND enforces a minimum-viable-schema gate at parse time:

**Minimum-viable-schema gate (v0.5.1+).** `_probeOnce()` requires at least these 4 fields present (non-null after parse) before treating a response as successful:
- `anthropic-ratelimit-unified-5h-utilization`
- `anthropic-ratelimit-unified-5h-reset`
- `anthropic-ratelimit-unified-7d-utilization`
- `anthropic-ratelimit-unified-7d-reset`

If any of these 4 is absent, `_probeOnce()` classifies the probe as a schema-drift failure (`failureKind = 'schema_drift'`), schedules backoff, and returns `null`. This means a 200 OK with zero `anthropic-ratelimit-*` headers (e.g. a server-side change, a proxy stripping headers, or a mock returning `{}`) is immediately caught as drift rather than silently cached as "live" data. The other 9 fields are tolerated as absent (overage fields are conditional; top-level status fields may be absent on edge cases). The 5h/7d core 4 are load-bearing — the dashboard's progress bars depend on them. (Gate added v0.5.1 to address codex finding F2.)

The CC binary-distribution shift means OCP's "grep cli.js" verification is no longer applicable. OLP adopts a two-path protocol:

**Path A — Compiled-binary string extraction.** Run `strings` over the platform-specific binary in the claude-code distribution. Captures all hardcoded header names the binary expects:

```bash
BIN_DIR=$(npm root -g)/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-*
strings "$BIN_DIR/claude" | grep -iE "anthropic-ratelimit|/v1/(messages|oauth)|platform\.claude\.com"
```

**Path A prerequisites.** GNU or BSD `strings` (part of binutils/coreutils on Linux + macOS — always present on a normal developer machine; Windows requires WSL or `binutils-mingw`). A locally installed Claude Code v2.1.x (npm-global or volta-managed). A reviewer without `claude` installed can still run Path B but Path A is gated on having the binary on disk. A future Claude Code version that ships as a different distribution shape (e.g. Rust binary, statically linked Go) keeps the protocol valid: `strings` works on any ELF/Mach-O regardless of compile source.

**Path B — Live API probe.** Run the actual probe against `api.anthropic.com` with valid OAuth credentials. Captures what the server returns today:

```bash
curl -s -i -m 10 -X POST https://api.anthropic.com/v1/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "anthropic-beta: oauth-2025-04-20" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' \
  | grep -iE "^anthropic-ratelimit"
```

Path A tells you what the client expects. Path B tells you what the server actually emits. The diff is the actionable schema delta.

**Required cadence.** The diff MUST be re-run at every major `claude --version` bump (v2.x → v3.x is the next trigger). The current pinned schema lives at `~/.cc-rules/memory/learnings/anthropic_plan_usage_probe_schema_2026_05_26.md`. After re-verification, that memory file MUST be updated (or a successor file written with a new date stamp; the old one cross-linked).

**Trigger for re-running the diff.** There is no automated detector for a major `claude --version` bump at v0.5.0. Three explicit hooks share this responsibility:

1. **Annual Alignment Audit** (`ALIGNMENT.md` § Annual Alignment Audit, every 14 May) — diff is mandatory as part of the audit checklist.
2. **`olp doctor anthropic.quota_probe_reachable` failure** — if the probe returns non-2xx for any reason other than 401/403/429/network (typical schema breaks manifest as 422 or 400), `olp doctor` surfaces a `kind: fix_provider` recipe whose first step is "re-run the Rule 5 dual-path diff".
3. **Manual maintainer attention at a major Claude Code release** — if the maintainer sees a major version bump in `claude --version`, kick off the diff before the next Phase opens. Rolling-mode discipline (CLAUDE.md release_kit) means major-version bumps usually intersect with Phase boundaries.

If the diff is missed across a major version bump, the failure mode is graceful degradation: the parser silently drops unknown headers; the dashboard shows older values (cached stale) or `null` per Rule 3; `olp doctor` surfaces the staleness.

**Required action on drift detection.** If a header is renamed or removed:

1. File a Phase-N issue tagging the maintainer.
2. Update the parser in `lib/providers/anthropic.mjs:quotaStatus()` to handle both names (graceful migration), prefer the new name.
3. Update the audit memory file with a "drift event" section recording: date, old field, new field, evidence URLs.
4. Bump the `models-registry.json` `quota_probe.schema_version` (NEW field added at D80) so downstream consumers can detect.

If a new header appears in the live response that the parser doesn't read: low-priority enhancement; add to the parser, document in the audit memory, no schema_version bump required.

### Rule 6 — Failure transparency

The probe's failure modes are visible to the operator:

- `/v0/management/dashboard-data` includes per-provider `{ quota_probe: { status: 'ok' | 'stale' | 'failed' | 'disabled', last_fresh_at, last_error?, backoff_until? } }`.
- `olp doctor` surfaces probe failure as `kind: fix_oauth` (if 401/403) or `kind: fix_provider` (if 429 with no stale cache or network error).
- The dashboard row badge shows the status; clicking a failed row shows the last error (truncated to 200 chars, no full credential traces).

### Rule 7 — Out-of-scope

This ADR does NOT govern:

- Spawn-path OAuth refresh (the spawn path's refresh logic predates this ADR and is governed by the underlying CLI). The probe shares the credential artifact but does not own the refresh.
- Anthropic-specific bearer revocation (Anthropic side). Revocation manifests as 401 to the probe, which falls into Rule 6.
- Non-Anthropic provider OAuth flows. Mistral / future providers MAY adopt this protocol via plugin-specific ADRs; ADR 0013 establishes the template.

---

## Consequences

**Positive.**

- The probe is bounded — Rule 2 caps the wire traffic, Rule 3 caps the refresh rate, Rule 4 caps activation surface.
- Schema-drift detection is procedural and reproducible — Rule 5 gives the maintainer a runbook that doesn't depend on Anthropic publishing a deprecation notice.
- Failure is visible — Rule 6 means a broken probe shows up in `olp doctor` and the dashboard, not as a silent "—" in the quota row.
- Credential reuse (Rule 1) keeps the security surface area minimal.

**Negative.**

- The `quota_probe_enabled` opt-in adds a configuration step. Mitigated by `olp doctor` surfacing the recipe when credentials are present but the probe is off.
- The schema-drift protocol is manual. Anthropic could ship a v3.x binary tomorrow and the verification only happens when the maintainer or a doctor probe failure prompts it. Counter-pressure: drift events at OCP scale (~12 months) suggest manual verification on major version bumps is sufficient.
- Stale-cache-on-failure (Rule 3) means the dashboard could show 30-minute-old data without an obvious "stale" indicator unless the UI explicitly renders the `stale: true` marker. ADR 0012 D82 requires the dashboard to surface staleness; reviewing that during P5-2 implementation.

**Neutral.**

- The protocol is portable. Future provider plugins adopting direct-API probes (mistral if its `/v1/usage` exists) can reuse the same six rules with provider-specific endpoint substitution.

---

## Alternatives considered

### A — Probe lives in `server.mjs` (OCP-style)

OCP's probe is in `server.mjs:842-1109` because OCP is single-provider and pre-plugin-architecture. Porting that pattern to OLP would violate ADR 0002 (per-provider knowledge stays in `lib/providers/`). Rejected.

### B — Spawn `claude -p --dry-run` and parse ratelimit headers

`claude -p` does not expose response headers; the CLI consumes and discards them. Even if it did, parsing CLI stdout is fragile. Rejected.

### C — Wait for Anthropic to publish a public quota API

The 2026-06-15 Agent SDK Credit billing-split announcement does not include a public quota API. Anthropic may publish one in the future; this ADR is forward-compatible (Rule 7 explicitly notes "if Anthropic publishes a public ratelimit API, this entire workaround becomes obsolete — re-evaluate"). Rejected for v0.5.0 (no ETA).

### D — Mandate token-rotation in OLP

Tempting (auditability), but OCP's experience shows token rotation breaks the spawn path more often than it improves security at family-scale deployment. The credential rotation cadence is Anthropic-side (token TTL); OLP respects whatever Claude Code does. Rejected.

---

## Authority + cross-references

- **ADR 0002 Amendment 8** — the contract-level permission. ADR 0013 is the implementation discipline for that permission.
- **ADR 0012** — Phase 5 charter that schedules D80 implementation.
- **ADR 0011** — anonymous-key deployment-context (LAN-only). Separate scope; this ADR does not amend it.
- **`~/.cc-rules/memory/learnings/anthropic_plan_usage_probe_schema_2026_05_26.md`** — the live schema pin. Updated on every drift event per Rule 5.
- **`alignment.yml`** — must continue to blacklist `/api/oauth/usage` and related hallucinated tokens. Must NOT add `/v1/messages` to the blacklist (legitimate endpoint).
- **OCP `server.mjs:842-1109`** — the source-of-truth port reference for D80.
- **OCP `ALIGNMENT.md`** — the institutional precedent (2026-04-11 drift → ALIGNMENT introduction) this ADR consolidates for OLP.

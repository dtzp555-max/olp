# ADR 0015 — Session-NAT Layer: Per-OLP-key Stable Session_id for IDE-like Anthropic Billing Classification

**Status:** Draft (Phase 8 candidate, NOT YET ACCEPTED)
**Date:** 2026-05-29
**Phase:** Phase 8 (not yet started)
**Authors:** project maintainer (with AI drafting assistance)

---

## Related

- **ADR 0001** (Project Founding) — § Non-mission says "OLP is a pure stateless proxy. Memory and continuity are client-side concerns." This ADR proposes carrying a small piece of state (`session_id` per OLP key) and requires an **ADR 0001 amendment co-merge** to redraw the state boundary.
- **ADR 0007** (Multi-key Auth) — provides the per-OLP-key isolation primitive (`keyId`) that this ADR's NAT-style mapping uses as its left-hand side.
- **ADR 0009 Amendment 1** (Phase 6c stream-json transport) — established `--no-session-persistence` as part of the spawn args. This ADR proposes **dropping that flag**; requires an ADR 0009 Amendment co-merge.
- **ADR 0014 Amendment 1** (Phase 7 Solution 1) — ephemeral `$HOME` + symlinked credentials per spawn. This ADR layers Session-NAT on top: each OLP key gets a stable session file outside the ephemeral home, symlinked in at spawn time.
- **Anthropic billing announcement** (2026-05-14, effective 2026-06-15) — the policy event that motivates this ADR. Splits `claude -p` / third-party-app traffic out of subscription pool into Agent SDK Credit pool.
- **cc-mem `incident_2026_05_27_spawn_cli_security.md` § 9** — bridge-value caveat for the Phase 6c spawn-mode change.

---

## 1. Context

### 1.1 The user's NAT framing

The architectural insight that motivates this ADR is a network-address-translation analogy. In a home router:

| NAT concept | Implementation |
|---|---|
| Many internal IPs | All devices behind the router |
| One external IP | The ISP-assigned WAN address |
| Port number (multiplexing tag) | TCP/UDP source port the router rewrites |
| Conntrack table | Router-side map of (internal IP, internal port) ↔ (external IP, external port) |

The external network sees one IP with many distinct connections distinguished by port. **The downstream (ISP) does not need to know that NAT is happening to bill correctly** — they bill the one external IP for the aggregate traffic.

The OLP-side analogue:

| NAT concept | OLP-NAT mapping |
|---|---|
| Many internal IPs | Many OLP keys (one per family member / device / use-case) |
| One external IP | One Anthropic OAuth credential (pooled subscription) |
| Port number | claude CLI `session_id` (a UUID identifying a conversation) |
| Conntrack table | OLP-side `Map<olp_key_id, stable_session_id>` persisted to disk under `~/.olp/sessions/<key-id>/` |

The Anthropic API server sees one OAuth with N concurrent conversations, each identified by a stable `session_id` that persists across requests. This is structurally indistinguishable from one power-user who has N project windows open in Claude Code.

### 1.2 The signal OLP currently emits

Post-Phase-7, OLP spawns claude with `--no-session-persistence` and `--system-prompt <OLP wrapper>`. Every `/v1/chat/completions` request produces a fresh `session_id` that claude never reuses. The Anthropic-side observable pattern is:

- One OAuth token
- Infinite never-repeated `session_id` values
- Session lifetime ≈ duration of the HTTP request
- Cross-`session_id` correlation: zero

This pattern is **mechanically distinguishable from any plausible IDE user** — IDE users keep session IDs alive for hours, reuse them across many requests, and rarely emit > 5–10 distinct sessions per OAuth. The current OLP spawn shape is therefore an unintentional but reliable fingerprint that Anthropic's billing classifier can use to flag OLP traffic as "third-party app authenticating via Agent SDK" — exactly the bucket that moves to the $100/mo Agent SDK Credit pool on 2026-06-15.

### 1.3 What this ADR is, and is not, trying to do

This ADR **is** trying to:
- Reshape OLP's observable Anthropic-side traffic so that it falls inside the statistical envelope of "one power user with multiple project windows" rather than "third-party API client churning ephemeral sessions"
- Inherit any cost benefit Anthropic's prompt-cache regime gives to long-lived sessions
- Preserve the four orthogonal values of Phase 6c (cost reduction, hallucination fix, NDJSON observability, possible bridge value) — none of those are sacrificed
- Compose cleanly with Phase 7 Solution 1 ephemeral-home + symlink + per-provider ISOLATION

This ADR is **not** trying to:
- Permanently evade Anthropic's billing classification. Anthropic can, and probably will, add additional signals beyond `session_id` count (per-OAuth request rate, prompt-content fingerprinting, etc.). Session-NAT addresses *one* signal; durability comes from the multi-provider fallback chain (ADR 0001).
- Hide that OLP is OLP. ALIGNMENT.md Anti-Fingerprinting clause is respected: this ADR uses **claude CLI's documented native flags** (`--session-id`, `--resume`) and does not patch the binary, MITM the HTTPS transport, or fabricate HTTP headers.
- Provide conversational memory to OLP clients as a user-visible feature. The session_id state is for routing / billing-classification purposes only; clients still send full conversation history in their OpenAI-format requests, and OLP still relays it. The model gets the same input it would without this ADR; what changes is what `session_id` claude tags the API call with.

This last distinction is what makes the ADR 0001 amendment claim defensible: OLP holds the *identifier* of a session, never the *content* of one.

### 1.4 Why this is Phase 8, not Phase 7

Phase 7 closed at v0.7.0 on 2026-05-29 with the Solution 1 isolation layer. Session-NAT is an independent architectural decision that:
- Depends on Phase 7 being in place (uses ephemeral-home + symlink primitives)
- Is not on the critical path for any current OLP behaviour (ratelimit + session-pool are quality-of-service features, not correctness features)
- Requires spike work to verify claude CLI `--session-id` + cwd-encoding behaviour before implementation
- Has an open ADR 0001 amendment that needs maintainer-level signoff

Treating it as a Phase 8 candidate gives the maintainer time to observe what Anthropic actually does to OLP traffic post-2026-06-15 before committing to the engineering work. If Anthropic does not in fact reclassify OLP traffic (or the reclassification is benign), this ADR can be abandoned without cost.

---

## 2. Decision

Adopt the **Session-NAT layer**: a per-OLP-key stable claude `session_id` pool maintained by OLP, symlinked into the Phase 7 ephemeral spawn home so that each `/v1/chat/completions` request to the anthropic provider invokes claude with a session that persists across requests for that OLP key.

Co-merge requirements:
- **ADR 0001 amendment** clarifying that `session_id` is a routing identifier held by OLP and is not "conversation state" in the ADR-0001 sense (which excluded prompt content, memory continuity, and IDE-side context — none of which OLP starts holding under this ADR).
- **ADR 0009 amendment** narrowing the Phase 6c spawn-arg specification: `--no-session-persistence` is replaced by `--session-id <stable_uuid>` (computed by OLP per key + lifecycle policy). All other Phase 6c args (stream-json + verbose + --system-prompt) are unchanged.
- **ADR 0014 Amendment** (optional, possibly Amendment 2 to 0014) noting that the Phase 7 ephemeral-home `requiredHomePaths` list is extended for the anthropic provider to include the session-mount target dir.

---

## 3. Architecture

### 3.1 Per-key session state filesystem layout

```
~/.olp/
  sessions/
    <olp-key-id>/                         <-- chmod 0700, per ADR 0007 § 3
      session_state.json                   <-- chmod 0600
      conversation.jsonl                   <-- chmod 0600; claude session log
      session_state.json.tmp.<pid>.<counter>  <-- transient, atomic-replace target
```

`session_state.json` schema (v1):

```json
{
  "schema_version": 1,
  "current_session_id": "<uuid-v4>",
  "created_at": "<ISO-8601 UTC>",
  "last_used_at": "<ISO-8601 UTC>",
  "turn_count": 0,
  "rotation_reason_history": [
    { "reason": "lifetime_expired" | "turn_limit_reached" | "conversation_boundary" | "initial", "at": "<ISO-8601 UTC>" }
  ]
}
```

Field semantics:
- `current_session_id`: the UUID currently in use for this OLP key's claude spawns. Pre-generated as UUID-v4 (per `crypto.randomUUID()`); fed to claude via `--session-id <uuid>`. Rotated per the policy in § 3.2.
- `turn_count`: incremented after every successful `/v1/chat/completions` spawn that reaches the `result` event (failed spawns don't increment).
- `rotation_reason_history`: bounded ring buffer of last N rotations for debugging / audit. N = 10.

`conversation.jsonl` is claude CLI's native session log format. **OLP does not parse, read, or modify this file**. It exists on disk solely so claude can read+write its own session state across spawns; OLP's only interaction with it is the symlink in § 3.4.

This boundary is the ADR 0001 amendment's load-bearing claim: OLP holds the file path and inode reference (via `session_state.json`'s `current_session_id` and the symlink layout), but the conversation content lives in a file format OLP does not consume.

### 3.2 Session lifecycle

A session is rotated (new UUID generated, old `conversation.jsonl` archived or pruned) when any of the following triggers fire:

1. **Lifetime expired** — `now() - created_at > session_lifetime_hours` (default: 8h, configurable via `~/.olp/config.json security.session_nat.lifetime_hours`)
2. **Turn limit reached** — `turn_count >= session_max_turns` (default: 200, configurable)
3. **Conversation boundary detected** — see § 3.3
4. **Operator-forced** — `olp keys rotate-session --key <id>` admin command (Phase 8.x deliverable)
5. **Initial** — first spawn for an OLP key that has no `session_state.json` yet

When a session rotates, the old `conversation.jsonl` is **renamed** to `conversation-<rotated_at>.jsonl.old` and the new `conversation.jsonl` is fresh-empty. The old log is retained on disk for N days (default 7) then garbage-collected by a background sweep. This retention is non-load-bearing — OLP does not query it — but supports operator debugging.

**Why two upper bounds, not one**: the lifetime cap matches a typical IDE work-day rhythm (and matches what Anthropic's classifier most likely models as "session timeout"). The turn cap protects against unbounded prompt-history growth for high-frequency OLP keys. A power user with light usage stays in one session all day; a heavy user rotates by turn count.

### 3.3 Conversation-boundary detection (heuristic)

Anthropic's IDE-user pattern includes session rotation when the human "starts a new conversation" (clears the chat, opens a new pane, etc.). OLP can't observe a user click "new chat", but can detect a *probable* conversation boundary using OpenAI-format request inspection:

- **Heuristic A**: the incoming request's `messages[0]` differs structurally from the prior request's `messages[0]` (different system prompt OR first user turn is different).
- **Heuristic B**: the incoming request's `messages` array length is 1 (a user starting fresh from scratch), and the prior request had > 1 message.
- **Heuristic C**: the time gap between this request and `last_used_at` exceeds a configurable idle threshold (default 2h).

Any heuristic firing triggers a session rotation. The heuristics are **conservative-bias** — false positives (rotating when the user is actually continuing) are mild (small token-cost hit from losing prompt-cache continuity); false negatives (not rotating when they actually started a new conversation) are mild (slightly worse fingerprint match to IDE behaviour, but not catastrophic).

Heuristics A and B are stateless and cheap; C requires a single `Date` comparison. None of the three reads `messages[i].content` beyond shape inspection, preserving the OLP-doesn't-hold-conversation-content invariant.

### 3.4 Integration with Phase 7 ephemeral home

Phase 7 Solution 1 creates an ephemeral `$HOME` at `/tmp/olp-spawn/<keyId>/<reqId>/home/` per request, with credentials symlinked in. Session-NAT adds one more symlink:

```
/tmp/olp-spawn/<keyId>/<reqId>/home/
├── .claude/
│   ├── .credentials.json                          <-- symlink to ~/.claude/.credentials.json (existing Phase 7)
│   └── projects/
│       └── <ephemeral_cwd_encoded>/
│           └── <session_id>.jsonl                 <-- symlink to ~/.olp/sessions/<keyId>/conversation.jsonl  (NEW)
```

The `<ephemeral_cwd_encoded>` segment is claude's session-file-path encoding of the spawn cwd. From the Phase 7 spike on PI231, claude encodes cwd by replacing `/` with `-`; the spawn cwd is `/tmp/olp-spawn/<keyId>/<reqId>/work` (or whatever cwd OLP sets), so the encoded form is `-tmp-olp-spawn-<keyId>-<reqId>-work`.

**The crucial invariant**: claude's session storage path is `$HOME/.claude/projects/<cwd-encoded>/<session-id>.jsonl`. To make session state persist across spawns (which is the whole point), this path must resolve (via the symlink) to a single per-OLP-key file outside the ephemeral home.

**Open issue**: `<cwd-encoded>` depends on the spawn cwd, which under Phase 7 is per-request unique. This means each spawn's `<cwd-encoded>` is *different*, so each spawn's `<session_id>.jsonl` lookup path is different. **Even with `--session-id <stable_uuid>`, claude will not find prior session state because the lookup path includes per-request cwd**.

This is a real architectural problem that the implementation spike must resolve. Three candidate fixes, in increasing order of cleanliness:

a) **Stable spawn cwd per OLP key** — OLP changes the spawn cwd from `/tmp/olp-spawn/<keyId>/<reqId>/work` to `/tmp/olp-spawn/<keyId>/work` (drop the reqId segment). Cwd becomes per-key not per-request. Loses per-request cwd isolation. Acceptable if cwd-level isolation isn't load-bearing (the per-key ephemeral home still isolates files; cwd is just a label).

b) **Synthetic stable cwd via `cwd:` spawn option** — OLP passes `cwd: /home/olp/.claude-cwd/<keyId>` (a stable per-key directory) to `child_process.spawn`. The cwd directory exists on disk but is empty; claude only uses it for label-encoding purposes. The actual filesystem reads/writes go through the ephemeral home's `.claude/projects/<encoded>/` symlink.

c) **Two-symlink approach** — symlink the parent `projects/<encoded>/` directory itself (not just the session file inside) so any `<session_id>.jsonl` inside resolves to the per-key persistent location. Then changing cwd between spawns doesn't break the resolve because all encoded paths point to the same backing dir.

Approach (b) is cleanest from a layering standpoint (Phase 7 ephemeral home stays untouched, cwd is the only knob); approach (c) is most robust to claude CLI changes in cwd-encoding. The spike picks one.

### 3.5 Same-key concurrent requests — session pool

A single OLP key can receive parallel `/v1/chat/completions` requests (e.g., a family member's laptop fires two browser tabs at once). claude's session file is **not safe for concurrent append/edit** — two spawns writing the same `conversation.jsonl` would corrupt it.

The session-NAT design needs to handle this gracefully without forcing client-side serialisation. Three options:

1. **Per-key serial lock**: second concurrent request waits for the first to release. Bad UX — every parallel request gets latency from the slower predecessor.

2. **Per-key session pool**: each OLP key owns a small fixed number of session slots (default 3, configurable). Concurrent requests cycle through available slots; if all are busy, the request queues briefly then proceeds to a fresh ephemeral session (degraded mode — that request loses session continuity but completes). Acceptable parallelism; bounded growth in session count.

3. **One session per concurrent conversation thread**: dynamically create sessions on demand, garbage-collect after timeout. Most flexible; highest session count per OAuth.

Recommended: option 2 with `session_pool_size: 3` default. This gives each OLP key a small bounded session set — `(N OLP keys) × 3` total session count on the Anthropic API side per OLP deployment. For a family-scale deployment of 5 keys, that's 15 maximum concurrent session_ids on one OAuth, which is still well within "power-user with multiple project windows" plausibility.

The pool slot in use for each spawn is recorded in `session_state.json` (extended schema):

```json
{
  "schema_version": 1,
  "pool": [
    { "session_id": "<uuid>", "in_use": false, "last_used_at": "...", "turn_count": 12 },
    { "session_id": "<uuid>", "in_use": true,  "last_used_at": "...", "turn_count": 87 },
    { "session_id": "<uuid>", "in_use": false, "last_used_at": "...", "turn_count": 4 }
  ]
}
```

Lock acquisition: atomic-rename pattern on session_state.json (the same atomic-write discipline ADR 0007 § 6.1 codified for key manifests). A request holds its slot's `in_use=true` for the duration of the claude spawn, releases on spawn exit (happy or error path) via the existing Phase 7 cleanup mechanism extended for session lifecycle.

### 3.6 claude CLI flags used (verified empirically)

Empirical verification of `claude --help` on PI231 v2.1.154 (2026-05-29) shows the following flags available:

- `--session-id <uuid>` — "Use a specific session ID for the conversation (must be a valid UUID)". This is the canonical Session-NAT primitive. When passed with a UUID claude has seen before in the same session-storage path, claude resumes that session; with a new UUID it creates fresh.
- `-r, --resume [value]` — "Resume a conversation by session ID, or open interactive picker with optional search term". Alternative to `--session-id` for resume-only semantics. Less flexible (no fresh-create); may not coexist with `--session-id` cleanly. Spike verifies whether `--session-id` alone gives resume-or-create-as-needed behaviour (preferred for Session-NAT).
- `-c, --continue` — "Continue the most recent conversation in the current directory". Cwd-dependent; not used by Session-NAT (we want explicit session control via UUID).
- `--fork-session` — "When resuming, create a new session ID instead of reusing the original". Not used; we want session reuse, which is exactly what the flag inhibits.
- `--no-session-persistence` — currently passed by OLP per Phase 6c. **This ADR proposes removing it** (ADR 0009 amendment co-merge).

Flag combination proposed for Session-NAT spawn:

```
claude \
  --session-id <stable_uuid_from_pool> \
  --output-format stream-json \
  --verbose \
  --system-prompt <OLP_SYSTEM_PROMPT_WRAPPER> \
  --model <model_from_request>
# Note: --no-session-persistence removed
# Note: --resume / --continue NOT added (--session-id covers both new-create and resume semantics per spike validation)
```

The spike must confirm:
- Whether `--session-id <new_uuid>` creates a fresh session when no prior session file exists at the expected path.
- Whether `--session-id <existing_uuid>` resumes successfully when the session file exists at the expected path (under stable cwd from § 3.4 fix).
- Whether `--no-session-persistence` is required to be *absent* (its presence might override `--session-id` and force ephemeral).
- Whether the spawn behaves correctly when the session file is a symlink rather than a real file (Phase 7 symlinked credentials work fine; assume yes but verify).

---

## 4. ADR 0001 Amendment Co-merge — state framing

**Current ADR 0001 § Non-mission text** (relevant excerpt):

> "OLP is a pure stateless proxy. Memory and continuity are client-side concerns (Memory Continuity, Hermes equivalents, IDE-side context). OLP does not retain it."

**Proposed amendment** (additive paragraph):

> ### Amendment N — Session-NAT routing-identifier carveout (Phase 8, ADR 0015 co-merge, 2026-05-29)
>
> The "stateless proxy" framing in § Non-mission carves out a distinction between **routing/identification state** and **conversation/content state**:
>
> - **Routing/identification state** that OLP holds: per-OLP-key key manifest (ADR 0007 § 4), per-key cache namespace (ADR 0005 D1), and — under ADR 0015 — a per-OLP-key claude `session_id` (a UUID identifier with no conversation content). All of these are bounded-size identifiers used to route requests to the correct downstream slot.
>
> - **Conversation/content state** that OLP does NOT hold: prompt content of in-flight or past requests, response content beyond what flows through OLP's per-request cache (ADR 0005), memory or continuity that survives request boundaries, IDE-side editor / cursor / project context, or any other data that constitutes "what was talked about". Under ADR 0015, claude CLI's session log file `conversation.jsonl` lives on the OLP host's disk because the spawn architecture requires it, but OLP does not read, parse, or transmit its content beyond claude's own consumption.
>
> The thesis "OLP is a pure stateless proxy" is preserved in the content sense — the dimension on which it actually matters for ADR 0001's reasons (privacy, simplicity, no migration concerns, no conversation-history liability). The carveout above codifies that OLP has always held a small amount of identifier state (the key manifest); ADR 0015 widens this by one UUID per key.
>
> Operationally: an OLP shutdown loses all in-flight request state but preserves session_id identifiers across restarts. A user wiping `~/.olp/sessions/<key-id>/` loses claude's conversation continuity for that key but does not affect anything else about that key (audit trail, cache, manifest all intact).

This amendment is **co-merge required** with ADR 0015 acceptance. ADR 0015 acceptance without ADR 0001 amendment leaves the constitution self-contradictory.

---

## 5. ADR 0009 Amendment 1 amendment Co-merge — drop `--no-session-persistence`

**Current ADR 0009 Amendment 1 spawn-arg specification** (Phase 6c):

> `claude --output-format stream-json --verbose --no-session-persistence --system-prompt <OLP_SYSTEM_PROMPT_WRAPPER>`

**Proposed change** (ADR 0009 Amendment 2):

> ### Amendment 2 — Session-NAT layer (Phase 8, ADR 0015 co-merge, 2026-05-29)
>
> The `--no-session-persistence` flag is removed from the Phase 6c spawn args specification. The flag's original purpose (per-spawn statelessness, no session continuity) is superseded by the Session-NAT layer (ADR 0015), which deliberately introduces controlled per-OLP-key session continuity to match IDE-user fingerprint patterns. All other Phase 6c flags (`--output-format stream-json`, `--verbose`, `--system-prompt <OLP wrapper>`) are unchanged — their cost-reduction and hallucination-suppression and observability values are preserved.
>
> The new flag set adds `--session-id <stable_uuid_from_pool>` per-spawn. The UUID is computed by OLP per the ADR 0015 § 3.2 lifecycle policy and § 3.5 pool selection.
>
> If the implementation spike (ADR 0015 § 10 open question 1) reveals that `--no-session-persistence` is required *to be present* for `--output-format stream-json` to work without `--print`, this amendment is **rejected** and Session-NAT is re-scoped to use `--print` mode (with the associated cost regression). In that case ADR 0015 is also re-scoped — see ADR 0015 § 10 open question 1's contingency.

---

## 6. Cost analysis

### 6.1 Anthropic prompt cache interaction

Anthropic's API supports prompt caching: identical prefix tokens in subsequent requests hit a 90%-off price (cache-read) instead of full price (cache-creation). Long-lived sessions naturally accumulate identical prefixes (system prompt + early conversation turns are constant), so persistent sessions should have higher prompt-cache hit rates than ephemeral ones.

Current OLP (post-Phase-7, ephemeral session) observed cost per Sonnet 4.6 request: $0.0078 average (from Phase 6c measurement). Under Session-NAT, two competing forces:

- **Prompt-cache hit rate increase** (cost-down): ~30-50% of input tokens were cache_creation in the post-Phase-6c measurement. Under Session-NAT, these become cache_read on subsequent turns within the session → ~70% input-token-cost reduction on the cached portion → net 20-35% cost reduction.

- **Conversation-history growth** (cost-up): each turn N's request prompt includes turns 1..N-1's content (claude prepends prior conversation as context). After 50 turns the input token count is N× higher than turn 1. Even with 90% cache-read discount, the total cost trends upward with conversation length.

Net effect depends on the turn-count distribution and conversation-content size. For a family deployment with light usage (~50 turns per session before rotation), prompt-cache benefits dominate and net cost decreases. For heavy usage (hitting the 200-turn rotation cap), conversation growth dominates and net cost increases vs Phase 7 baseline.

**Predicted range** (un-spiked): -20% to +50% per-request cost vs Phase 7 baseline, depending on usage pattern. Spike § 10 open question 4 measures actual.

### 6.2 Cache layer (ADR 0005) interaction

OLP's own cache layer hashes (provider, model, IR-request) and stores response — orthogonal to claude's session cache. Under Session-NAT, two interactions:

- **OLP-cache key stability**: same IR-request still hashes to the same OLP cache key regardless of session_id, so OLP cache hits are unaffected. Good.
- **OLP-cache hit-rate vs claude-cache hit-rate**: when OLP cache hits, no claude spawn fires, so claude prompt-cache doesn't matter. OLP-cache misses go to claude with possible prompt-cache hit. The two layers compose; no negative interaction expected.

### 6.3 Storage growth

Session log files (`conversation.jsonl`) grow per turn. Rough estimate: a 10-turn conversation in claude's session log is ~20-50 KB. Per OLP key, 200 turns × 3 pool slots = ~30 MB max before rotation. Family-scale deployment of 5 keys: ~150 MB session storage. Acceptable.

Rotated log retention (default 7 days) adds another factor: ~150 MB × 7 = ~1 GB worst case. Operator can tune `session_nat.retention_days` lower if disk is constrained.

---

## 7. Provider contract impact

The Provider `ISOLATION` contract (ADR 0002 Amendment 9) currently has no session-related field. Session-NAT touches only the anthropic provider's spawn path; codex and mistral are unaffected (codex has its own session model via `~/.codex/sessions/`; mistral pending).

Proposed `ISOLATION` extension (optional, additive):

```javascript
export const ISOLATION = {
  // ... existing fields per ADR 0002 Amendment 9 ...

  // ADR 0015 (Session-NAT) extension (OPTIONAL — providers without
  // sessionLayer fall back to ephemeral-per-spawn behaviour).
  sessionLayer: {
    enabled: true,
    persistDir: ({ keyId }) => `~/.olp/sessions/${keyId}`,
    // Function returning the spawn args that activate the session for
    // a given session_id. Allows provider-specific flag composition.
    sessionFlagsForSpawn: ({ sessionId }) => ['--session-id', sessionId],
    // Pool configuration; orchestrator selects an available slot.
    poolSize: 3,
    lifetimeHours: 8,
    maxTurns: 200,
  },
};
```

For anthropic this is populated as above; for codex and mistral the field is omitted (or `enabled: false`), and the orchestrator's pre-spawn step skips session work for those providers — equivalent to current Phase 7 behaviour.

This is a forward-compatible additive change to ADR 0002 Amendment 9. A separate ADR 0002 Amendment 10 co-merge captures it.

---

## 8. Detection-resistance analysis (honest assessment)

What signals does Session-NAT dampen, and which does it not?

| Signal | Current Phase 7 OLP | Session-NAT |
|---|---|---|
| Active session_ids per OAuth | ♾ ephemeral (very bot-like) | 5–15 stable (IDE-power-user-like) |
| Session reuse over time | Never | Yes (hours to days per session) |
| Session lifetime | < 1 second | Hours |
| Cross-session_id correlation | None | None (preserved) |
| Per-OAuth request rate | Aggregated, can spike | **Unchanged** — needs separate ratelimit ADR |
| Per-session request rate | n/a (sessions don't survive a single request) | Bounded by usage pattern; comparable to human-paced IDE rate |
| `--system-prompt` customization | OLP-specific wrapper, not Claude Code default | **Unchanged** — same fingerprint |
| User-agent / HTTP headers | claude CLI default | **Unchanged** — same fingerprint |
| Concurrent active sessions per OAuth (same time-window) | ♾ | Bounded by pool_size × key count |

**The honest conclusion**: Session-NAT shifts OLP's traffic into the "one power user with several persistent IDE projects" envelope across **5 of 9 observable signals**. The remaining 4 signals (per-OAuth request rate, `--system-prompt` customization, HTTP headers, concurrent-session burst) are addressed by orthogonal mechanisms:

- Per-OAuth request rate: covered by the Phase 8 ratelimit ADR (see § 1.3 — separate work).
- `--system-prompt` customization: a known fingerprint we accept the cost of (Phase 6c benefits outweigh).
- HTTP headers: claude CLI controls these; OLP doesn't touch (and shouldn't, per AGENTS.md).
- Concurrent burst across pool slots: ratelimit pool layer caps this.

Session-NAT is therefore best understood as **one of 2-3 layers** that together approximate IDE-user-pattern matching. It is not sufficient alone.

---

## 9. Authority citations

Per ALIGNMENT.md Rule 1:

- **claude CLI v2.1.154 `--help` capture** (PI231, 2026-05-29 11:33 UTC):
  - `--session-id <uuid>` — "Use a specific session ID for the conversation (must be a valid UUID)"
  - `--resume [value]` — "Resume a conversation by session ID, or open interactive picker with optional search term"
  - `--continue` — "Continue the most recent conversation in the current directory"
  - `--fork-session` — "When resuming, create a new session ID instead of reusing the original"
  - `--no-session-persistence` — "Disable session persistence — sessions will not be saved to disk and cannot be resumed (only works with --print)"
  - Full capture stored in `docs/spikes/2026-05-29-claude-session-flags.md` (to be created at spike time)

- **Anthropic billing announcement 2026-05-14, effective 2026-06-15** — original public announcement URL (placeholder; verify at impl time): the Pro/Max subscription pool excludes `claude -p` / Agent SDK traffic post-effective-date. Source: cc-mem `~/.cc-rules/memory/learnings/anthropic_claude_code_billing_split_2026_06_15.md`.

- **ADR 0001 § Mission and § Non-mission** — the "no conversation state" framing this ADR amends.

- **ADR 0007 § 3 (filesystem layout) + § 6 (atomic-write discipline)** — the per-OLP-key isolation primitive and the atomic-write pattern reused for `session_state.json`.

- **ADR 0009 Amendment 1** — the Phase 6c spawn-arg specification this ADR proposes amending.

- **ADR 0014 Amendment 1** (Phase 7 Solution 1) + cc-mem `incident_2026_05_27_spawn_cli_security.md` § 6 — the ephemeral home + spawn architecture this ADR layers on top.

- **Phase 7 PI231 spike** (`docs/spikes/2026-05-29-ephemeral-home.md`) — established that claude v2.1.152 honours `HOME` env override and writes session-derived state under `$HOME/.claude/projects/<cwd-encoded>/`. This ADR's § 3.4 fix builds on that observation.

---

## 10. Open questions (spike-required before implementation)

These must be resolved by a PI231 (or comparable) spike before ADR 0015 transitions from Draft to Accepted. Each is a blocking issue.

1. **`--no-session-persistence` and `stream-json` interaction**. claude CLI `--help` documents that `--no-session-persistence` "only works with --print", and separately documents that `--output-format stream-json` works "only with --print". The Phase 6c spike empirically discovered that stream-json works without `--print` on v2.1.104-v2.1.154 despite the help text. The open question for Session-NAT: does *removing* `--no-session-persistence` work in the no-`--print` stream-json mode? Spike: spawn claude with stream-json + `--session-id <uuid>` and no `--print`, verify session state is written to disk and a second spawn with same session-id resumes correctly.

2. **cwd-encoding stability across claude versions**. claude encodes cwd into the session file path by replacing `/` with `-` (observed empirically on v2.1.152, Phase 7 spike). Is this stable across the v2.1.100-v2.1.154 window? Future versions? Session-NAT's symlink layout in § 3.4 depends on the encoding being predictable. Spike: test cwd-encoding on at least 3 claude versions; document the formula; fall back to approach (c) two-symlink design if the encoding ever changes.

3. **Session file format compatibility across versions**. claude CLI may evolve `conversation.jsonl` format. If a session created on v2.1.154 is resumed on v2.1.158 with a different format, does claude reject it gracefully or corrupt? Spike: cross-version resume test; if any version rejects, add a session-rotation-on-claude-version-change policy.

4. **Cost prediction validation**. § 6.1 predicts -20% to +50% per-request cost vs Phase 7 baseline. Spike: measure 50 sequential requests in a single OLP key with Session-NAT vs Phase 7 baseline; report actual cost delta. If cost is > +30%, re-evaluate the architecture (perhaps lower turn cap, or accept it).

5. **Concurrent same-key pool exhaustion behaviour**. § 3.5 specifies pool slots with `in_use=true` flag and queueing. The current Phase 7 cleanup path runs on spawn exit. Verify the slot-release timing under (a) happy path, (b) spawn error path, (c) HTTP client disconnect mid-stream. Spike: spawn pool exhaustion under load test; verify no permanent slot leaks.

6. **OAuth-side observability for Session-NAT validation**. Once Session-NAT is shipped, how do we verify Anthropic is in fact treating OLP traffic as IDE-pattern? Options: (a) Anthropic dashboard quota probe (ADR 0008 Amendment 2 quota_v2) — does the `representative_claim` or `status_5h` field change semantically? (b) Per-OAuth bill at end of month — does it land in subscription pool or Agent SDK Credit pool? Spike: define a measurable success criterion **before** shipping, not after.

7. **Operator UX for forced-rotate**. § 3.2 trigger 4 ("Operator-forced") needs a CLI surface. Probably `olp keys rotate-session --key <id>` (or all-keys variant). Out-of-band from main spike but should be specified before implementation begins.

---

## 11. Consequences

### Positive

- **Anthropic-side fingerprint approaches power-user-IDE pattern** for the dominant `session_id` signal. Reduces probability of OLP traffic being unilaterally reclassified into the Agent SDK Credit pool on 2026-06-15.
- **Prompt-cache hit-rate improvement** for repeat-prefix queries within a session. Net cost direction depends on usage pattern but expected to be at worst neutral, possibly positive (§ 6.1).
- **Conversation continuity as an emergent feature for OLP clients** — each OLP key now has a claude-side memory across requests. Clients that benefit (e.g., a single user reusing one key for related questions) get an improved UX. Clients that don't (stateless API clients) are unaffected since they always send full conversation history anyway.
- **Architectural cleanness via the NAT framing** — the conntrack-table-style stable mapping is well-understood, debug-friendly, and analytics-clean (session-NAT log queries directly map to per-OLP-key billing).
- **Composes with Phase 7 ephemeral home** (additive symlink only; no changes to Phase 7 logic).

### Negative

- **ADR 0001 amendment required** to redraw the state boundary. The amendment is defensible (routing state vs content state) but is constitutional surgery that future readers will scrutinize.
- **ADR 0009 amendment required** to drop `--no-session-persistence`. Reversal of a Phase 6c decision that shipped only weeks earlier. If the spike (§ 10 open question 1) reveals that flag is required for stream-json mode, ADR 0015 is rescoped to use `--print` mode at the cost of regressing Phase 6c's NDJSON observability.
- **Bounded but real complexity increase**: session pool, lifecycle, rotation, cwd-fix layering, ADR-0014 § requiredHomePaths extension. Phase 7 added a lot of orchestration; Phase 8 Session-NAT adds more.
- **Cost direction not guaranteed positive** (§ 6.1). Worst-case scenario: heavy users see +50% per-request cost vs Phase 7 baseline due to conversation-history growth.
- **Anthropic can still classify out** of "power user" pattern via other signals (per-OAuth request rate, system-prompt customization, HTTP headers). Session-NAT is *one* layer; full IDE-user pattern matching requires several.
- **Bridge value still uncertain** per cc-mem § 9: Anthropic can update classification rules without a technical change. Session-NAT extends the bridge but does not make it durable.

### Reversibility

- **Fully reversible** by removing `--session-id` from the spawn args (revert ADR 0009 amendment) and deleting the `~/.olp/sessions/` directory. The OLP code refactor to remove the session-pool layer is ~300 LOC delete.
- **No state migration** required for revert: if Session-NAT is in production and the maintainer reverts, the next request goes back to ephemeral session_id; in-flight conversation continuity is lost but no other state corrupts.
- **Per-OLP-key opt-out** possible at implementation time: `~/.olp/keys/<key-id>/manifest.json` could gain a `session_nat: false` field that disables Session-NAT for that key only. Useful for testing / debug / rollback per-tenant. Out of ADR 0015 scope but trivially additive.

### Mission boundary check

ADR 0001 § Non-mission excludes (1) commercial multi-tenant SaaS, (2) generic enterprise gateway, (3) model-capability router, (4) conversation-state store. Item (4) is the one this ADR brushes against; the proposed § 4 amendment redraws the line precisely. Items 1-3 are unaffected.

The "personal- and family-scale" mission frame is preserved: Session-NAT is a quality-of-service feature that family deployments benefit from (per-key continuity + cost stability + billing-classification softening). Commercial multi-tenant trust isolation is not introduced; the `recommendedDeploymentTier` advisory (ADR 0014 Amendment 1 § A1.3) is unchanged.

---

## 12. Status transitions

- **2026-05-29** — Drafted. Status: Draft (Phase 8 candidate). Spike work in § 10 required before transition to Proposed.
- **(TBD)** — Spike complete, open questions resolved → Proposed. Reviewer assigned per Iron Rule 10.
- **(TBD)** — Reviewer APPROVE, ADR 0001 amendment + ADR 0009 Amendment 2 + ADR 0002 Amendment 10 drafted as co-merge → Accepted.
- **(TBD)** — Implementation begins (estimated 2-3 weeks based on Phase 7 baseline).

---

**Authors:** project maintainer (with AI drafting assistance, 2026-05-29). This ADR is a forward-looking design proposal triggered by user-side architectural insight (NAT-style framing) and the upcoming Anthropic billing-pool split (2026-06-15). It is **not** ratified by any spike-validated empirical work; § 10 open questions block transition to Proposed.

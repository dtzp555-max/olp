# ADR 0009 — Anthropic Interactive-Mode Path (Placeholder)

- **Date:** 2026-05-25
- **Status:** Draft (Placeholder — blocked on OCP ADR 0007 P0 experiment outcome; no implementation D-day scheduled until P0 lands)
- **Authors:** project maintainer (with AI advisory drafting)
- **Related:**
  - **OCP ADR 0007** (Interactive-Mode Execution Pool, stream-json) — at `~/ocp/docs/adr/0007-interactive-mode-pool.md` on the maintainer's workstation. Pin reference at the time of this writing: OCP ADR 0007 is Draft status pending the same P0 outcome.
  - OLP ADR 0001 (Project Founding) — establishes the 2026-06-15 Anthropic billing-split trigger that motivated OLP's multi-provider posture in the first place.
  - OLP ADR 0006 (Provider Inclusion / Risk Tier Framework) — anthropic is currently a Tier-D Candidate; this ADR amends the operational shape of that plugin if/when P0 succeeds.
  - OLP ADR 0007 (Multi-Key Auth) — Phase 2 design; per-key cache + audit layer that any future interactive-mode implementation must continue to satisfy.
  - OLP ADR 0008 (Dashboard + Audit Query) — Phase 3 design; any interactive-mode change must not regress the Dashboard's per-provider observability fields.
- **Standing autopilot grant note:** Phase 4 is a "new authorization required" scope per `~/.cc-rules/memory/auto/standing_autopilot_phase_2.md`. This placeholder ADR is recorded NOT as implementation work but as the maintainer's "do not forget this when planning Phase 4" anchor. No implementation D-day is scheduled until P0 lands AND maintainer issues a Phase 4 "go" specific to this ADR.

---

## 1. Context

### 1.1 The triggering external work

OCP shipped ADR 0007 (`docs/adr/0007-interactive-mode-pool.md` in `dtzp555-max/ocp`) on 2026-05-25, draft status. The ADR designs a dual-path execution model for the post-2026-06-15 Anthropic billing split:

- **Current `claude -p` path**: programmatic billing → Agent SDK $100/month credit pool (~20–50 heavy coding sessions/month).
- **Proposed interactive-mode path**: spawn Claude without `-p`, communicate via either (Transport A) piped NDJSON over stdio or (Transport B) `node-pty` PTY — possibly classified as interactive billing → subscription pool.

The OCP team accepted the *concept* but rejected an external contributor's PR #101 implementation (tmux + hook-file polling + `--dangerously-skip-permissions`) on alignment + security grounds, then drafted ADR 0007 as the clean redesign.

### 1.2 Why this is OLP's concern

OLP's founding premise (ADR 0001) was that OCP would become uneconomical post-2026-06-15, motivating a multi-provider hedge. OLP's `lib/providers/anthropic.mjs` today uses the same `claude -p` invocation OCP uses → same billing consequence post-2026-06-15.

If OCP's ADR 0007 P0 experiment confirms that an interactive-mode spawn (Transport A or B) bills against subscription rather than Agent SDK credit, the implementation pattern is directly portable to OLP's anthropic provider plugin. OLP would inherit the same billing benefit without needing to commission an independent P0.

If P0 fails for both transports, OLP's anthropic provider remains stuck on `-p` post-June-15; the multi-provider routing (OpenAI Codex, Mistral) becomes the operational mitigation, exactly per OLP's original founding logic.

### 1.3 The unverified premise (binding caveat)

Per OCP ADR 0007 § "Unverified Premise":

> "TTY detection matters. Local testing (Claude Code 2.1.150) shows: in a real TTY, `claude` without `-p` enters the TUI and does not emit NDJSON. With piped stdin/stdout (`child_process.spawn`), it emits NDJSON even without `-p`. This means Anthropic could use `isTTY` as the billing signal, not the `-p` flag."

OLP cannot independently confirm or refute this prior to 2026-06-15 — Anthropic's billing pool signaling is not exposed on any observable surface until the billing split goes live. **Any OLP implementation that bets on Transport A (stdio pipe) without P0 confirmation risks burning real Agent SDK credit on every Anthropic request.**

---

## 2. Decision

**Option 3 — Wait for OCP ADR 0007 P0 experiment outcome, then port the validated approach.**

Rationale:

- **Avoid duplicated P0 risk.** Both OCP and OLP would run the same experiment against the same Anthropic billing pool. OCP is already designed to run it; OLP riding their result is a free observation.
- **Lower decision-tree noise.** P0 has three outcomes (Transport A wins / Transport B wins / both fail). OLP's right answer differs per outcome; making the decision before the data is speculation.
- **No code is wasted.** OLP currently routes anthropic via `claude -p`, which works (just expensive post-June-15). The cost during the wait window is bounded by the Agent SDK $100/month credit + OLP's family-scale request volume.

What "wait" means concretely:

1. **No code change to `lib/providers/anthropic.mjs`** until OCP ADR 0007 transitions from Draft → Accepted (which requires P0 success per OCP ADR 0007 § "Status").
2. **No Phase 4 D-day scheduled for this scope** until that transition AND maintainer issues an explicit Phase 4 "go" naming this ADR.
3. **This placeholder ADR stays Draft** until either OCP P0 lands AND OLP decides to port, OR OCP P0 fails decisively AND OLP marks this ADR Rejected with a "shelved per upstream P0 failure" note.

---

## 3. P0 outcome → OLP action decision tree

Recorded here so a future Phase 4 brief can act mechanically once OCP P0 lands.

```
OCP ADR 0007 P0 result
  │
  ├─ Transport A (stdio pipe) confirmed interactive-billing
  │   → OLP Option 1 OR Option 2 (see § 4); maintainer decides.
  │     Likely Option 1: port the lib/interactive-pool.mjs +
  │     billing-router.mjs pattern into lib/providers/anthropic.mjs.
  │     Updates ADR 0006 to spell out the new spawn mode.
  │
  ├─ Transport B (PTY) confirmed; Transport A fails
  │   → OLP Option 1 with PTY adapter; node-pty dependency added
  │     under engines-bump scrutiny (this triggers a separate prior
  │     PR per ADR 0007 § 11-like discipline: native addon adds
  │     CI matrix work).
  │
  ├─ Both transports billed as programmatic
  │   → OLP marks this ADR Rejected. Anthropic provider stays on
  │     `claude -p`. Operational mitigation: family-scale users
  │     either (a) accept the Agent SDK $100 cap, (b) bring their
  │     own API key (BYOK env path is already there), or (c) shift
  │     volume to other providers (Codex / Mistral) via OLP's
  │     existing fallback chain.
  │
  └─ P0 results unobservable (billing signals not exposed)
      → Continue waiting. Re-evaluate one billing cycle (30 days)
        post-2026-06-15. OLP Anthropic provider remains on `-p`
        path during the wait; users see Agent SDK credit consumption
        as the cost signal.
```

---

## 4. Implementation lanes (to be selected when P0 lands)

This section is informational only. No lane is selected at placeholder time.

### Option 1 — OLP parallel implementation

OLP's `lib/providers/anthropic.mjs` reimplements OCP's interactive pool natively. Replaces the current `claude -p` spawn with a pool-managed warm process + adapter selected per P0 outcome.

- **Pros:** OLP self-contained; no runtime dependency on OCP being installed.
- **Cons:** Duplicates substantial logic (pool lifecycle, transport adapter, crash backoff DEGRADED, permission auto-response). Two codebases drift over time.

### Option 2 — OLP chains OCP as backend

OLP's `lib/providers/anthropic.mjs` invokes OCP (via its existing HTTP entry surface, or via a future direct-spawn API) rather than spawning `claude` directly. OLP becomes a multi-provider layer ON TOP OF OCP for the Anthropic provider; other providers (Codex, Mistral) continue to be direct.

- **Pros:** Zero duplication; OLP benefits from OCP's P0-validated work automatically. Architectural separation: OCP owns Claude execution, OLP owns multi-provider routing.
- **Cons:** OLP gains a runtime dependency on OCP being installed + running. Double caching (OCP cache + OLP cache; cache key composition needs to avoid stampede). OCP's HTTP shim is OpenAI-spec-compatible but adds an extra hop's latency. OCP failure modes propagate.

### Option 3 — Both (default to OCP backend if available, fallback to local pool)

A hybrid: OLP detects OCP installed locally, prefers chaining; otherwise falls back to the parallel implementation. Most defensive but most complex.

**Default at placeholder time:** Option 1 is the simpler ship if P0 transports prove out. Option 2 is the cleaner architecture but adds operational coupling. Maintainer decides at P0-resolution time.

---

## 5. Risk assessment (placeholder snapshot)

| Risk | Likelihood (now) | Impact | Mitigation pending P0 |
|---|---|---|---|
| OLP forgets this ADR exists | Medium (multi-month wait) | High (would mean OLP misses the post-June-15 window) | This ADR + cc-rules memory `~/.cc-rules/memory/learnings/ocp_adr_0007_interactive_mode_pool.md` |
| OCP ADR 0007 P0 fails entirely | Medium | High for OLP Anthropic users (Agent SDK $100 cap binds) | OLP's multi-provider fallback (Codex/Mistral) already shipped as Phase 1 work; users have a path |
| OCP ADR 0007 ships incomplete (interim) | Medium | Medium (OLP can't reliably port) | Wait for OCP to mark Accepted; don't port from Draft |
| Anthropic policy changes mid-wait | Medium | Depends — could obsolete the whole approach | Re-read OCP ADR 0007 + this ADR before any Phase 4 anthropic work; no decisions on stale information |

---

## 6. Out of scope (explicitly NOT in this ADR)

- **Any code change.** This is a placeholder + decision-tree record only.
- **OCP P0 design.** That work is OCP's responsibility per OCP ADR 0007 § "Implementation phases".
- **A new OCP-OLP integration protocol.** If Option 2 is selected at P0-resolution time, the integration shape is a separate ADR.
- **Engines-bump for node-pty.** Only relevant if P0 picks Transport B and Option 1 is selected. Then it lands as a separate prior PR per the ADR 0007 § 11 pattern.

---

## 7. Phase 4 priority interaction

This ADR is recorded BEFORE Phase 4 implementation scope is finalized. Phase 4 currently lists (per OLP v0.3.0 CHANGELOG):

- Per-key per-provider auth artifact mapping (ADR 0007 § 12 deferral)
- Audit retention policies (ADR 0008 § 11 deferral)
- SQLite hybrid migration (ADR 0007 § 13 trigger)
- Provider-cost weights for spend trend (ADR 0008 § 11 deferral)

If OCP P0 succeeds, **the interactive-mode port likely jumps to the top of Phase 4** (highest user impact: keeps OLP Anthropic users on subscription billing). The other items remain Phase 4 but reorder downstream.

If OCP P0 fails, **this ADR is shelved** and Phase 4 ordering is unchanged.

---

## Consequences

**Positive:**

- OLP retains a documented anchor for the interactive-mode option without committing implementation effort prematurely.
- Future Phase 4 planning has a structured decision tree, not a vague "we should look at OCP someday".
- Cross-machine + cross-session memory (cc-rules) ensures the dependency is visible to any future session reading the OLP project context.

**Negative:**

- During the wait window (now → P0 outcome ≥ 2026-07-15), OLP Anthropic users consume Agent SDK credit post-2026-06-15. Bounded by family-scale request volume but a real operational cost.
- Some risk that "wait" turns into "forget" if multiple unrelated Phase 4 priorities crowd the agenda. Mitigated by this ADR + the cc-rules memory pointer.

**Reversibility:**

- This is a placeholder. Either P0 result transitions it (Accepted → port, Rejected → shelve) cleanly. The placeholder itself doesn't lock OLP into anything.

---

## Authority citations

- **OCP ADR 0007** at `~/ocp/docs/adr/0007-interactive-mode-pool.md` (maintainer workstation). Project repo: `dtzp555-max/ocp`.
- **PR #101** to `dtzp555-max/ocp` — external contributor's tmux-based prototype that triggered the OCP ADR 0007 redesign.
- **Anthropic 2026-06-15 billing-split announcement** — see `~/.cc-rules/memory/learnings/anthropic_claude_code_billing_split_2026_06_15.md`.
- **OLP ADR 0001** (Project Founding) — establishes the original billing-split → multi-provider motivation.
- **OLP ADR 0006** (Provider Inclusion + Risk Tier Framework) — the anthropic plugin's tier classification + the surface this ADR would amend.
- **OLP ADR 0007** (Multi-Key Auth, Phase 2) — per-key audit + cache layer that must continue to work across any anthropic execution-mode change.
- **OLP ADR 0008** (Dashboard + Audit Query, Phase 3) — Dashboard per-provider fields must continue to populate.
- **CLAUDE.md `release_kit.phase_rolling_mode`** — current_phase: Phase 4 (post-v0.3.0); this ADR explicitly does NOT consume a Phase 4 D-day until P0 lands.
- **Standing autopilot grant** (`~/.cc-rules/memory/auto/standing_autopilot_phase_2.md` in cc-rules `bf0ed9a`) — Phase 4+ requires new authorization; this placeholder is a decision-tree pre-record, not Phase 4 implementation.

---

## Status transitions (recorded for clarity)

- 2026-05-25 — Created as Draft (Placeholder). OCP ADR 0007 also Draft.
- _(future)_ — If OCP ADR 0007 → Accepted with a confirmed transport: this ADR moves to "Pending Phase 4 implementation D-day", maintainer decides Option 1 / 2 / 3 + lane.
- _(future)_ — If OCP ADR 0007 → Rejected: this ADR moves to "Shelved (upstream P0 failure)" with a note explaining the fallback (multi-provider routing already covers).

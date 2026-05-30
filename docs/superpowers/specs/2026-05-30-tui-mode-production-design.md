# TUI-mode — Production Design Spec

- **Date:** 2026-05-30
- **Status:** Draft (design spec; pre-implementation). Supersedes the "Option 1 / stream-json adapter" lane of ADR 0009 Amendment 1 for the *billing-pool* concern, and proposes a new ADR (0009 Amendment 2 or a fresh ADR 0016) as the authority of record before any code lands.
- **Authors:** project maintainer (with AI drafting assistance).
- **Builds on community work:** `dtzp555-max/ocp` **PR #101 by jaekwon-park** (tmux + interactive-`claude` prototype). See § "Author credit plan".
- **Validated by:** PI231 spikes S1 (billing + no-tool property), S2 (JSONL transcript output), S3 (submission reliability), plus pre-code gate spikes **T1** (completion detection on non-`end_turn` stop reasons — PARTIAL), **T3** (multiline/special-char submission — PASS), **T6** (marketplace + managed-MCP disable — PASS), `claude` v2.1.158, `tmux` 3.3a, model `claude-haiku-4-5-20251001`, arm64 Debian. Spike JSON retained in session record.

> **Honesty banner.** TUI-mode is a *grey-area bridge*, not a durable architecture. It automates `claude`'s genuinely-interactive mode (`cc_entrypoint=cli`) to serve programmatic proxy requests so traffic bills against the Anthropic subscription pool instead of the post-2026-06-15 Agent SDK credit pool. The interactivity is real (not forged), but it is automated. It is OPT-IN (`CLAUDE_TUI_MODE`). Spike-confirmed facts and the remaining gaps govern everything below: (a) `--system-prompt` keeps `cc_entrypoint=cli` — the TTY path carries the **genuine interactive-use signal**; whether that *bills* to the subscription pool is an **inference pending post-2026-06-15 validation** (S1 proved the entrypoint signal, not the billed pool — the split has not yet taken effect, so no spike can prove the billed pool today); (b) the native JSONL transcript is a clean, escaping-free output channel — **output mechanism is sound** (S2 PASS); (c) `--system-prompt` suppresses tool *text* but does **not structurally strip** account-attached managed MCP servers — **the no-tool property is model restraint, not enforcement** (S1 PARTIAL); (d) the load-bearing structural MCP-disable mechanism is now **found and verified** — `--strict-mcp-config` (with no `--mcp-config`) yields 0 managed-MCP attachment (T6 PASS); (e) `turn_duration` completion detection is **reliable for text/refusal turns but ABSENT on tool-use turns**, which would hang the reader — a co-equal wall-clock/quiescence guard is now mandatory, not optional (T1 PARTIAL); (f) multiline/special-char prompt submission is **byte-for-byte reliable** via `send-keys -- "$(cat file)"` + separate Enter token (T3 PASS). (c)+(e) remain the load-bearing risks; (c) is now mitigable structurally via (d) and gates multi-tenant (Deployment B) rollout together with the still-open body-capture verification (T2) and concurrency (T4).

---

## 1. Context & motivation

### 1.1 The billing trigger

Anthropic's 2026-06-15 billing split moves `claude -p`, the Agent SDK, and "third-party apps that authenticate with your Claude subscription through the Agent SDK" into a separate ~$100/month Agent SDK *credit* pool. The subscription pool (Pro/Max) covers "Claude Code in the terminal or your IDE in **interactive mode**." OLP's anthropic provider currently spawns `claude` non-interactively (`--output-format stream-json --verbose --no-session-persistence`, ADR 0009 Amendment 1). Post-split, that path's billing classification is at best uncertain and at worst routes to the credit pool — which exhausts in ~20–50 heavy sessions/month and makes OLP unusable for a Pro subscriber pooling to family/team.

TUI-mode is the bridge: drive `claude` in genuine interactive mode (no `-p`, no `--output-format`; a real PTY/tmux session) so the User-Agent carries `cc_entrypoint=cli`, which S1 confirmed holds even with `--system-prompt`. That signal matches genuine interactive use; **actual subscription-pool billing is an inference to be validated only after the 2026-06-15 split takes effect** — S1 cannot prove the billed pool pre-split, and the OCP canary (§ 12) is the first real billing measurement.

### 1.2 What changed since ADR 0009 Amendment 1

ADR 0009 Amendment 1 locked "Option 1 — stream-json, no `-p`" on the premise that stream-json-without-`-p` emits NDJSON *and* (implicitly) bills as interactive. The unverified premise in ADR 0009 § 1.3 was exactly the TTY-detection risk: **Anthropic may use `isTTY` as the billing signal, not the `-p` flag.** If that premise holds, the current stream-json (piped stdio, non-TTY) path bills as `sdk-cli`/credit-pool. TUI-mode resolves this by using a **real TTY** (PTY/tmux), which S1 confirmed produces `cc_entrypoint=cli` across all 5 `/v1/messages` requests in a turn (main + auxiliary). This spec therefore **does not replace** the stream-json path; it adds a *TTY-backed* execution mode selectable per the `CLAUDE_TUI_MODE` flag, keeping stream-json as the default. Note the default's billing is **uncertain, not safe-credit-pool-guaranteed**: per ADR 0009 § 1.3 the non-TTY piped-stdio default may itself bill to the credit pool if Anthropic keys on `isTTY` — its merit is the conservative ToS posture, not a billing guarantee (§ 10.2).

### 1.3 Orthogonal value (so the work earns its keep even if the bridge dies)

Per ADR 0009 Amendment 1 § "Value re-anchoring": even if Anthropic reclassifies third-party apps to the credit pool on 2026-06-15 — killing the billing bridge — the `--system-prompt` tool-suppression already delivers the hallucination fix (env-block / cwd injection) and a measured ~30% input-token / ~64% per-request cost reduction. TUI-mode inherits those. The transcript-read channel (S2) additionally exposes per-turn `turn_duration` (messageCount + durationMs) for observability.

---

## 2. Deployment models

TUI-mode must serve two shapes. **B is the superset; A is B with exactly one key.** Build for B; A falls out.

### 2.1 Model A — single-user / multi-device

One subscription, one OLP server instance, many of the *user's own* client IDEs/devices. All traffic is the same human. Privacy *between clients* is not a hard requirement (it's all one person), so A **may** opt into a warm session pool for latency (§ 8) — but a warm pool MUST reuse the *process* only, **not** conversation context: each request resets to a fresh turn (new `--session-id`, or `/clear` between requests) so it never inherits a prior request's implicit context. Otherwise the proxy violates OpenAI chat-completions **stateless** semantics (a later request would see an earlier one's hidden context, dirtying cache + reproducibility) even for a single user. One `claude login` on the host.

### 2.2 Model B — family / team share

One **owner** subscription pooled to N members via OLP per-key auth. Members do **not** do their own OAuth — they hold an OLP key; the host holds the single owner OAuth. Hard requirements:

- **Per-member privacy.** Member A cannot see the owner's or member B's history. Transcripts must never co-mingle and must never land in the owner's real `~/.claude/projects/`.
- **Per-key cache + audit isolation.** Reuse the existing OLP/OCP multi-key namespacing (`lib/keys.mjs`: `owner_tier`, `providers_enabled`, per-key cache/audit). No new isolation primitive is invented for cache/audit.
- **Shared 5-hour cap.** One pooled OAuth → the subscription's rolling 5-hour usage cap is shared across all B members. This is an inherent limit of pooling one subscription (§ 9).
- **Structural tool stripping is mandatory** (not optional as in A), because a member's prompt reaching an un-stripped tool surface could touch the *owner's* Gmail/Calendar/Drive via account-attached MCP (S1 caveat). See § 5.

---

## 3. Architecture (the layers)

TUI-mode is a new **execution transport** under the existing anthropic provider, selected when `CLAUDE_TUI_MODE` is set. It reuses the IR boundary, the `--system-prompt` wrapper (Phase 6c), the ephemeral-home isolation (Phase 7), and multi-key auth unchanged. New surface is the session driver + transcript reader.

```
 OpenAI-compat entry (/v1/chat/completions)         [REUSE — unchanged]
        │  validateKey → keyId, owner_tier, providers_enabled   [REUSE lib/keys.mjs]
        ▼
 IR request  ──────────────────────────────────────  [REUSE lib/ir]
        │  irToAnthropic: role:system → --system-prompt; user/assistant → prompt text
        ▼
 anthropic provider .spawn()                          [BRANCH on CLAUDE_TUI_MODE]
        │
        ├─ default (flag unset): stream-json --verbose --no-session-persistence
        │                        (ADR 0009 Amd 1; uncertain-billing / safe ToS posture —
        │                         per ADR 0009 §1.3 the default itself MAY bill to the
        │                         credit pool because Anthropic may key on the isTTY signal)
        │
        └─ CLAUDE_TUI_MODE=1:  ── TUI transport ──────────────────────────────┐
                                                                              │
   ┌──────────────────────────────────────────────────────────────────────── ▼ ───┐
   │ 1. prepareIsolatedEnvironment({ provider, keyId, reqId })  [REUSE Phase 7]     │
   │      Layer 1: ephemeral $HOME = /tmp/olp-spawn/<keyId>/<reqId>/home (chmod 700)│
   │      Layer 2: symlink real ~/.claude/.credentials.json → ephemeralRoot         │
   │      + NEW: seed ephemeral .claude.json (onboarding/trust/bypass; mode 600)    │
   │      (NOTE: seed does NOT disable managed-MCP — T6 negative control; that is   │
   │       the spawn-flag --strict-mcp-config in step 2, not the seed)              │
   │ 2. spawn interactive `claude` in a PTY/tmux session bound to ephemeralRoot     │
   │      args: --system-prompt "<OLP wrapper>" --model <m> --session-id <uuid>     │
   │            --strict-mcp-config (no --mcp-config) --disallowedTools "mcp__*"     │
   │            [--tools "" | --allowedTools "…"]   (NO -p, NO --output-format)      │
   │      env:  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1               │
   │            → real TTY → cc_entrypoint=cli ; 0 managed-MCP (T6-verified)         │
   │ 3. submit prompt (T3): write body to file → send-keys -- "$(cat file)" →       │
   │      settle ~1.5-2s → send Enter as a SEPARATE tmux KEY TOKEN                   │
   │      verify via TRANSCRIPT (exactly 1 user line == source); retry Enter ≤4x    │
   │ 4. read response from NATIVE JSONL transcript at the computed deterministic     │
   │      path; completion (T1 dual-signal): {"type":"system","subtype":             │
   │      "turn_duration"} line  OR  terminal guard (stop_reason:tool_use /          │
   │      size-stable ≥10s / wall-clock cap ≥120s → clean 502, never hang)          │
   │ 5. map transcript assistant text blocks → ONE buffered IR response → OpenAI    │
   │      JSON, or (stream:true) replay the completed text as SSE chunks AFTER the   │
   │      turn finishes — NOT incremental tokens (see § 3.1 streaming semantics)     │
   │ 6. cleanup(): kill session, rm -rf ephemeralRoot (trap-guaranteed)             │
   └────────────────────────────────────────────────────────────────────────────── ┘
```

### 3.1 Streaming semantics — single buffered response, NOT token streaming (DECISION)

TUI-mode reads the native transcript JSONL **after the turn completes** (the `turn_duration` marker / quiescence guard, § 4.3–§ 4.4). The transport therefore produces a **single, fully-buffered response string** — there is no per-token channel to tap, because the transcript is only authoritative once the turn is done. **True incremental token-streaming is NOT possible in TUI-mode.** (Tapping the live `capture-pane` for partial text is explicitly rejected: § 6/T3 showed large pastes collapse to a `[Pasted text …]` placeholder and pane text is cosmetic, not authoritative.)

**Decision (maintainer default):** for `stream:true` requests, **replay the completed response as SSE chunks** — chunk the buffered string and emit it as standard OpenAI `delta` events followed by `[DONE]`. The wire format is valid SSE, but the data arrives as **one burst after the turn finishes**, not incrementally as the model generates. This limitation is documented in the README (Troubleshooting / TUI-mode § "no true streaming") and surfaced to operators. Clients that depend on early-token latency (e.g. live typing UIs) get a correct-but-non-incremental experience under TUI-mode; this is an accepted trade of the bridge.

### 3.2 Cache contract integration (REUSE getOrCompute / singleflight)

The TUI transport is, from `server.mjs`'s perspective, a function that returns a **resolved response string** for a `(keyId, prompt)` pair — the same shape the existing cache layer expects. It plugs into the established `getOrCompute` / singleflight contract in `server.mjs` unchanged: the cache key is composed exactly as today (content-addressed over the normalized prompt), and the TUI transport is invoked only on a cache miss as the compute function whose resolved string is then stored and replayed (including chunked SSE replay for `stream:true`, identical to how the stream-json path's buffered result is cached). **Cache-key note (from T3):** the interactive input box strips the prompt's single trailing newline on submit; any prompt-in vs prompt-on-wire hashing MUST normalize the trailing newline or it will see a spurious cache-key mismatch. No new cache primitive is introduced; per-key isolation and singleflight are REUSE (§ 9).

Layer responsibilities:

| Layer | Owner | Reuse / New |
|---|---|---|
| Entry surface, IR, key auth | server.mjs, lib/ir, lib/keys.mjs | REUSE |
| System-prompt wrapper (`OLP_SYSTEM_PROMPT_WRAPPER`) | lib/providers/anthropic.mjs | REUSE (Phase 6c) |
| Ephemeral home + credential mount + cleanup | lib/sandbox/manager.mjs `prepareIsolatedEnvironment` + anthropic `ISOLATION` | REUSE + EXTEND (seed `.claude.json`, pin plugins) |
| Session driver (PTY/tmux spawn, submit, dialog auto-answer) | **NEW** lib/providers/anthropic-tui.mjs (or lib/tui/session.mjs) | NEW |
| Transcript reader (path compute, poll/inotify, completion detect, text extract) | **NEW** lib/tui/transcript.mjs | NEW |
| Cache + audit per-key | lib/cache, lib/audit | REUSE |

---

## 4. Output mechanism — native JSONL transcript read (S2 PASS)

**Decision: read `claude`'s native session transcript JSONL. Do NOT use a hook→result.json contract, and do NOT rely on `--output-format`.** S2 proved this end-to-end and it is strictly better than the PR #101 hook-file approach: it eliminates JSON double-escaping (the exact failure that broke hook→result.json) and removes any need for `--dangerously-skip-permissions` (§ 5.4).

### 4.1 Transcript path formula (S2-confirmed, exact)

```
<EHOME>/.claude/projects/<CWD_ENCODED>/<SESSION_ID>.jsonl
```

- `EHOME` = the ephemeral `$HOME` from `prepareIsolatedEnvironment`.
- `CWD_ENCODED` = the spawn `cwd` with **every** `/` replaced by `-`, **including the leading slash** (so `/tmp/x` → `-tmp-x`). Verified against pre-existing dirs and against the spike's own run.
- `SESSION_ID` = the UUID OLP passes via `--session-id`. OLP generates it, so OLP computes the path *before* spawn. File is created lazily on first message, not at spawn — the reader must tolerate "file not yet present" and poll for creation.

### 4.2 Assistant text extraction (escaping-clean — the load-bearing win)

The final assistant message is `type:"assistant"` with a content block `type:"text"`. Because this is `claude`'s *native* log, one `JSON.parse()` per line yields the text with real newlines, real double-quotes, and **zero** `\\n` / `\\"` double-escaping artifacts (S2 char-level checks: double-quote present, real newline present, literal-backslash-n bug-indicator absent). Response text = concatenation of `text` blocks from `assistant` messages emitted **since the matching `user` line** for this turn.

### 4.3 Completion detection (S2-confirmed, with the trap)

- **Positive marker = a line `{"type":"system","subtype":"turn_duration"}`.** It is the last line of the turn by timestamp and carries `messageCount` + `durationMs` (and `entrypoint=cli`). Poll the file (or `inotifywait`); when a `turn_duration` line for this turn appears, the turn is done. **T1 confirmed** this fires for both text turns (a 2128-word / 19991-char near-cap answer, `durationMs=33135`) **and** refusal turns (`durationMs=3221`).
- **TRAP — do NOT key off `stop_reason:"end_turn"` alone.** It appears on BOTH the `thinking` block AND the `text` block, so "first `end_turn`" fires before the visible text is complete.
- **TRAP — do NOT assume `turn_duration` is the literal last *byte* in the file.** S2 saw write-order momentarily differ from timestamp-order (a text block flushed after `turn_duration` by byte position while `turn_duration` had the later timestamp). Robust rule: "a `turn_duration` line for this turn has appeared" → then read all assistant `text` since the `user` line. Do not rely on file-tail ordering.
- **TRAP (NEW, T1) — `turn_duration` is ABSENT on tool-use turns.** When the model issues a `tool_use` block, the last assistant line carries `stop_reason:"tool_use"` and **no `turn_duration` line is ever written** — even after the (interactive) tool-permission dialog is rejected. A marker-only reader would hang indefinitely. `turn_duration` MUST NOT be the sole completion signal (see § 4.4).
- **Latency:** S2 measured submit→transcript-available ≈ 3.4–3.6s wall for a tiny haiku turn (~300 output tokens); a 0.5s poll added <0.5s detection lag. `inotifywait` would make detection lag near-zero. T1's longest legitimate text turn was `durationMs=33135` (~33s server-side, ~20s detection wall) — this is the realistic worst case for a long single-stream answer and bounds the quiescence/wall-clock sizing in § 4.4.

### 4.4 Completion robustness — T1 RESOLVED (partial): dual-signal guard is MANDATORY

**T1 verdict: PARTIAL.** `turn_duration` is RELIABLE for text-only turns (both near-cap long answers and refusals emit it) but is **ABSENT on tool-use turns**, which would hang a marker-only reader. Verified on PI231, `claude` v2.1.158, model `claude-haiku-4-5`, against the § 4.3/§ 4.4 contract. (A true API `max_tokens` truncation could not be forced — interactive `claude` exposes no max-tokens flag, so the "long" path exercised `claude`'s own default-length stop, which is `end_turn`-with-`turn_duration`; see § 4.5 and the concern below.)

**Production rule (now binding, not a gate).** The reader MUST treat completion as a **dual signal**:

- **(A) Happy path** — a `{"type":"system","subtype":"turn_duration"}` line for this turn appears (fires for `end_turn` text turns and refusal turns). Then read all assistant `text` blocks since the matching `user` line (§ 4.2; do not rely on file-tail byte ordering).
- **(B) Co-equal terminal-NON-HANG guard (mandatory)** — detect either: the transcript's last assistant message has `stop_reason:"tool_use"`, **or** an absolute wall-clock cap fires. Either is a **terminal** condition: abort the turn and return a clean error (e.g. `502` "tool-use turn unsupported in TUI-mode" / "completion-marker timeout"). **Never block forever.**

⚠️ **Quiescence ("file size-stable for N seconds") is deliberately EXCLUDED from the v1 terminal set.** A long Opus extended-thinking turn or a slow-network turn can legitimately produce **no transcript growth for >10s**, so a quiescence cut would falsely abort valid long turns (this corrects the T1 spike's own co-equal-quiescence suggestion). Quiescence may be added **only after spike T5** establishes a safe window AND only gated behind "assistant/tool output has already begun." v1 relies on `turn_duration` (happy path) + `tool_use` detection + a generous wall-clock cap alone.

**Sizing (from T1, tune via T5):** longest legitimate text turn measured was `durationMs=33135` (~33s server-side, ~20s detection wall). Set the absolute wall-clock cap **generously above expected Opus-class long-stream latency (recommend ≥ 120s, tune via spike T5)** so a slow-but-valid long turn is not aborted prematurely.

**Why guard (B) cannot be dropped under the structural tool-strip.** S1 already showed — and T1 re-confirmed at the model's own words ("The tools are available in the function schema, but… I won't invoke tools") — that `--system-prompt` suppresses tool *use* via model restraint, NOT tool *availability*. Under the production `--system-prompt` wrapper, three separate tool-inviting prompts all resolved to `end_turn`+`turn_duration` with zero `tool_use` — but **restraint is not enforcement**, so a `tool_use` turn (and its hang) remains reachable in production whenever model restraint does not hold. The structural tool-removal required for guest/member keys (§ 5.2, now mechanizable via T6) reduces this for multi-tenant traffic, but does **not** eliminate the need for guard (B) on **owner-tier / canary traffic where tools remain attached.** Guard (B) is unconditional.

**Second hang vector — interactive tool-permission dialog.** When a `tool_use` does occur, `claude` blocks on an interactive tool-PERMISSION dialog in the TUI (`Do you want to create …? 1.Yes 2.Yes-allow-all 3.No`) with `stop_reason:"tool_use"` and no `turn_duration` — the session is frozen awaiting a keypress, a distinct hang from the missing-marker case. Production TUI-mode MUST either pre-grant/auto-deny tool permissions (a permission-mode that auto-rejects) **or** have guard (B) detect-and-tear-down a session stuck on a permission prompt. The cleanest combination is the structural disable of § 5.2/T6 (no MCP tools to invoke) *plus* a built-in-tool lockdown (`--tools ""` / explicit `--allowedTools` subset) so no `tool_use` is reachable at all on member keys.

**Re-run cadence:** `turn_duration` emission is an undocumented internal-log behavior pinned to `claude` v2.1.158. Re-run T1 on every `claude`/Ink version bump.

### 4.5 max_tokens handling (DECISION — ignore + document)

GROUND TRUTH (verified against the current code path): `buildCliArgs` passes only `--model` + `--system-prompt`; a client `max_tokens` is parsed into the IR (`lib/ir/openai-to-ir.mjs:182`) but **never reaches the CLI** today — interactive `claude` exposes **no max-tokens flag**, and the existing stream-json path does not forward it either. T1 also could not force a true API `max_tokens` truncation for the same reason; the "long" path tested `claude`'s own default-length stop (`end_turn`-with-`turn_duration`), which is the realistic worst case for length.

**Decision (maintainer default): ignore `max_tokens` and document the limitation.** This matches current stream-json behavior, so TUI-mode introduces no regression. The IR field is accepted and dropped silently at the CLI boundary (no error). README documents that `max_tokens` is not honored under either anthropic path. **Future option (not in initial scope):** soft-inject a "limit your response to roughly N tokens" instruction into the prompt body for a best-effort approximation — this is a prompt-level hint, not a hard API cap, and would be a separate ADR-tracked change. Note the formally-unverified corner: if the proxy ever maps client `max_tokens` to a *real* truncation, the `turn_duration` behavior on a hard `max_tokens` stop is untested (though `end_turn`-with-`turn_duration` is the observed behavior for the longest turns `claude` produces on its own).

### 4.6 Other OpenAI sampling params — graceful drop (DECISION)

Interactive `claude` (`cc_entrypoint=cli`) exposes **no flags** for `stop`, `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `logit_bias`, `n`, or `seed` — the interactive session uses the account/model defaults and there is no per-request override surface. **Decision (maintainer default): accept these params into the IR and drop them gracefully at the CLI boundary** (no error, same posture as `max_tokens` § 4.5 and consistent with the existing stream-json path, which also cannot forward them). README documents the non-honored set so clients are not surprised when, e.g., a low `temperature` does not deterministically constrain output under TUI-mode. No silent failure mode is introduced — the request still succeeds, it just ignores the unsupported knobs.

---

## 5. Security model — the no-tool property

### 5.1 What S1 actually proved (and did not)

S1 confirmed *behaviorally*: with `--system-prompt`, for a coding-style prompt, the model answered conversationally and emitted **zero** `tool_use`/`tool_call`/`tool_result` tokens, and the entrypoint stayed `cli`. **But** during startup the CLI auto-fetched the Anthropic official plugin marketplace and established live MCP connections (claude.ai Gmail / Google Calendar / Google Drive) — account-attached managed MCP servers delivered **over the network** (each connects via `https://mcp-proxy.anthropic.com/v1/mcp/<mcpsrv_id>`), present **even with empty local `mcpServers` config**. `--system-prompt` replaces the system-prompt *text* (suppressing default tool-usage instructions) but does **not** strip tool/MCP *availability* from the request. The no-`tool_use` outcome was **model restraint, not structural enforcement.** **T6 re-confirmed** this directly: even under the production `--system-prompt` wrapper, the model stated the tools are present in its function schema ("The tools are available in the function schema, but… I won't invoke tools") — so structural stripping (§ 5.2) is required and is **orthogonal to** `--system-prompt`. Additionally, `--debug api` logs metadata only (not bodies), so the spike could not prove the outbound `/v1/messages` carried `tools:[]` — only that no `tool_use` came back (still open as T2 body-capture).

### 5.2 The structural requirement (binding for Deployment B) — T6 RESOLVED the disable mechanism

A multi-tenant proxy MUST **structurally** remove the tool surface, not rely on the model declining. **T6 (PASS) found and verified the load-bearing mechanism**: the `--strict-mcp-config` CLI flag (with **no** `--mcp-config` supplied) yields **ZERO** managed-MCP attachment in an ephemeral interactive session — 0 `mcp-logs-claude-ai-*` cache dirs and `/mcp` reports "No MCP servers configured" (vs. a baseline of 3 servers / 28 tools). It keeps OAuth subscription auth intact. This converts requirement (1) below from "find a mechanism" (formerly spike T6) into **"apply the verified mechanism + assert the verification gate."**

**Critical NEGATIVE control (binding):** T6 proved that **stripping/seeding the ephemeral `.claude.json` is NOT a mitigation.** Removing the local cache key `claudeAiMcpEverConnected` from the seed did **not** prevent attachment (the 3 servers still connected, 28 tools) — the managed-MCP fetch is **account/server-driven**, not gated by any local `.claude.json` field. **Do NOT rely on editing the seeded home to disable MCP.** The CLI flag is required; the seed-edit approach (an earlier § 7.1 / PR-0 assumption) is downgraded to onboarding/trust convenience only and carries **no** security weight for MCP.

Concretely, before TUI-mode is allowed for any **owner_tier=guest** (member) key, the ephemeral spawn MUST:

1. **Pass `--strict-mcp-config` and pass NO `--mcp-config`** (mandatory, load-bearing — the ONLY mechanism that prevents the account-attached claude.ai managed MCP from connecting over the network). T6-validated spawn template (PI231): `claude --model <m> --session-id <uuid> --strict-mcp-config --disallowedTools "mcp__*" [--tools "" | --allowedTools "…"]`.
2. **Lock tools down explicitly** — `--disallowedTools "mcp__*"` (deny any MCP-namespaced tool even if config changes), plus built-in lockdown. **For initial Deployment B the lockdown MUST be `--tools ""` (ZERO built-in tools) — NOT an `--allowedTools` subset.** Rationale (credential-wall coupling, § 5.5): any tool in an `--allowedTools` subset that can read files / run commands / reach the network **voids both the T2 `tools:[]` proof and the owner-bearer credential wall**. Any non-empty `--allowedTools` subset for B is **out of initial scope** and requires its own ADR + security proof. Note `--strict-mcp-config` removes MCP tools but does **NOT** lock built-in tools (Bash/Read/etc.) — the `--tools ""` pairing is required for multi-tenant.
3. **Disable the official-marketplace plugin auto-install (defense-in-depth)** — set env `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1` (binary-confirmed env var; 0 plugin/marketplace dirs in T6 worst-case test). `--strict-mcp-config` affects MCP only; the marketplace is a separate surface. In a fresh ephemeral home no marketplace was present, but the env var is cheap insurance against the autoinstall firing on a flag-stripped home.
4. **Verify with a body-level capture** (proxy MITM or a body-logging channel) that the outbound `/v1/messages` actually carries `tools:[]` (or no tools array). `--debug api` is insufficient — it does not log bodies. **This is the one remaining hard gate (spike T2)** on Deployment B: T6 proved the MCP servers do not *connect* (cache-dir + `/mcp` + transcript-token evidence), but body-capture of the wire request is still needed to assert the request carries no tools array.

**Verification gate (preflight / upgrade-time — NEVER inside a serving turn):** Running `/mcp` (or the cache-dir assertion) **inside a session that also serves a user request would itself write a transcript line, consume a turn, and corrupt the reader's "matching user line" semantics (§ 4.2).** So the gate MUST run as a **separate preflight session** — at server startup and on every `claude` CLI upgrade — whose transcript is discarded and which never serves a user turn. The preflight asserts **0** dirs matching `$HOME/.cache/claude-cli-nodejs/*/mcp-logs-claude-ai-*` **and** that `/mcp` reports "No MCP servers configured." Findings are pinned to `claude` v2.1.158 and the managed-MCP fetch is account/server-driven, so a future CLI/server change could alter behavior — re-run the preflight on every upgrade (and optionally on a periodic timer), not once.

Carry-forward env from the existing isolation: keep `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and unset `ANTHROPIC_*`. **Do NOT use `--bare`** — it strips managed MCP too but forces `ANTHROPIC_API_KEY`/`apiKeyHelper`-only auth, which breaks the OAuth/Max subscription spawn model (the whole point of the bridge). (A settings.json route — `suppressedClaudeAiConnectors` / `allowAllClaudeAiMcps` — exists in the binary but was deliberately **not** chosen: an argv-level flag cannot be overridden by a tenant-writable settings file; spike separately only if a settings approach is ever preferred.)

**Deployment B gate semantics (binding, two-stage — resolves the prior T2-only-vs-T2+T4 ambiguity):**
- **(i) Security gate = T2.** Until § 5.2 (1)+(2)+(3) are applied AND (4) is verified by body-capture, **B does not launch at all.** The disable mechanism itself (T6) is resolved; T2 is proving it on the wire.
- **(ii) Concurrency gate = T4.** Once T2 passes, **B launches SERIALIZED (concurrency = 1).** Concurrent multi-member service is a **separate** gate on T4 (§ 7.3) — per-session isolation under parallel load + one-OAuth-concurrent-session tolerance — and is NOT lifted until T4 passes.
- Net: **no B before T2; serialized B after T2; concurrent B only after T4.**

Deployment A (single user, all traffic is the owner) may proceed on the behavioral property because there is no cross-tenant boundary to breach — but the structural hardening should still ship, because an un-stripped surface means a prompt-injected client could reach the owner's own Gmail/Drive, which is undesirable even single-user.

### 5.3 A vs B isolation summary

| Concern | Model A | Model B |
|---|---|---|
| Cross-tenant history leakage | N/A (one human) | **Hard** — ephemeral $HOME per request; transcripts in `/tmp`, rm'd; never owner's real `~/.claude/projects/` |
| Tool/MCP surface | Should-strip (defense-in-depth) | **Must-strip structurally** (§ 5.2); B blocked until verified |
| Cache/audit namespacing | single key | per-key (REUSE `lib/keys.mjs`) |
| OAuth | one owner login | one owner login, pooled (members hold OLP keys, not OAuth) |

### 5.4 No `--dangerously-skip-permissions` needed

Because OLP reads the transcript (§ 4) instead of asking `claude` to *write a result file*, there is no tool invocation to permission, so `--dangerously-skip-permissions` is **not required** for the output path. (S3 used `--dangerously-skip-permissions` in its harness for spawn convenience, and S1/S2 used a pre-seeded `bypassPermissionsModeAccepted` flag — but the *architecture* does not need the dangerous flag because no file-writing tool runs.) If a future requirement forces tool execution, that flag and its full multi-tenant security implications must be re-examined in a new ADR — it is explicitly out of scope here.

### 5.5 Credential-leak coupling — B's safety DEPENDS on T2+T6 (binding)

State this plainly: in Deployment B the **owner's OAuth bearer is symlinked into every member's ephemeral `$HOME`** (`.credentials.json`, § 7.1). It is therefore **readable by every member spawn**, and is protected **ONLY** by the (unenforced) no-tool property. There is no second wall. This means **Deployment B's credential safety is not independent of the tool surface — it is coupled to it.** If a member's prompt can reach a tool that reads files (a built-in `Read`/`Bash`, or a slipped-through MCP), it can exfiltrate the owner's bearer.

Consequences (all binding for B):

- The structural tool-strip (§ 5.2: `--strict-mcp-config` + `--disallowedTools "mcp__*"` + built-in lockdown `--tools ""`/explicit `--allowedTools`) is **the credential wall**, not merely a privacy-of-data measure. T6 (disable mechanism) and T2 (body-capture proof) are therefore **credential-safety gates**, not just MCP-hygiene gates — link them: **B credential safety ⇐ T2 ∧ T6.**
- The ephemeral root MUST be `chmod 700` and **per-`keyId` isolated** (no shared parent that another member can traverse).
- The seed (`.claude.json` with `oauthAccount`/`userID`) MUST be written **mode 600**; the symlinked `.credentials.json` target's permissions are the owner's real file (never copied), and the symlink lives only inside the 700 root.
- **Orphan-tmux-session reaper (NEW, mandatory).** tmux sessions survive an OLP server restart and continue to hold the owner OAuth (via the still-mounted ephemeral home / live process). On server startup OLP MUST reap orphaned TUI tmux sessions (kill session + `rm -rf` its ephemeral root) before serving, so a crashed/restarted server does not leave owner-credential-bearing sessions live and unowned. This compounds with the § 8 trap-guaranteed teardown (steady-state cleanup) — the reaper is the restart-time backstop.

---

## 6. Submission technique (S3 PASS — 15/15 first-attempt; T3 PASS — multiline/special-char now verified)

**Decision: write the prompt body to a FILE, feed it in one shot with `tmux send-keys -- "$(cat file)"`, then send Enter as a tmux/PTY KEY TOKEN — never as a literal `\n`/`\r` in the text payload.** S3 proved 100% first-attempt submission for short prompts, and a negative control proved the Ink #15553 bug *does* reproduce here when a newline is sent as text (`send-keys -l "...\n"` silently fails to submit). **T3 (PASS)** extended this to realistic multiline + shell-special payloads (fenced code blocks, backticks, `$`, `${VAR}`, `$(…)`, `;`, `&&`, `|`, `&`, quotes, braces, literal mid-prompt newlines, up to ~50 lines / 1.2 KB): each produced **exactly ONE** user submit with the content arriving **byte-for-byte intact** in the transcript, zero premature submit on embedded newlines, zero corruption.

Production recipe (T3-validated, binding for PR-2 acceptance):

1. **Write the prompt body to a file. NEVER interpolate it into a shell command line** — that is where backticks/`$()`/`&&`/quotes get mangled by the shell (not by `claude`). T3 verified the file-then-`cat` path delivers all shell-special chars intact.
2. **Feed it in ONE shot** with `tmux send-keys -t <S> -- "$(cat promptfile)"`. The leading `--` end-of-options guard is **required** so a prompt starting with `-` is not parsed as a flag. Embedded `\n` bytes are delivered as **soft line-breaks** in the Ink input box and do NOT submit. Do **NOT** use `send-keys -l` for the body in this version — the default (non-literal) mode already passes newlines through correctly and `-l` is unnecessary.
3. **Settle ~1.5–2s** to let the Ink input box render (and, for large pastes, to let the paste-collapse UI render — a 50-line block collapses to `❯ [Pasted text #1 +46 lines]`; cosmetic only, buffer is complete).
4. **Submit with a SEPARATE Enter KEY TOKEN:** `tmux send-keys -t <S> Enter`. Enter must be a key token, never a literal `"\n"` appended to the text (Ink #15553).
5. **Verify** submission by reading the **transcript JSONL** (not `capture-pane`): exactly one `user`-role line whose `message.content` equals the source minus its single trailing newline. (A second `user`-role line carrying `toolUseResult:true` is `claude`'s tool output **within the same turn**, not a second submit.) For large prompts, transcript-read is **mandatory** — the paste-collapse placeholder defeats pane-scraping verification.
6. **Retry** Enter (key token) up to ~4× as a defensive guard. S3 never needed it (net-zero cost) but it protects against rare Ink races on upgrade.

`paste-buffer` / `load-buffer` (bracketed, streams from a file) is an acceptable alternative and is the **recommended fallback at very large sizes** (see caveat below); it offered no advantage for the tested ≤50-line cases and was not needed.

**Dialog automation (calibrated, S3 — a real footgun):** trust-folder dialog defaults to "1. Yes, I trust" → bare Enter confirms. The bypass-permissions dialog defaults cursor to **"1. No, exit"** — a naive Enter here **EXITS and kills the session**; must send **Down then Enter** to land on "2. Yes, I accept". Better: pre-seed the trust + bypass markers in `.claude.json` (§ 7) so neither dialog appears.

⚠️ T3 caveats to carry:

- **Only tested up to ~50 lines / 1.2 KB.** Coding-proxy traffic can carry much larger pastes (whole files, multi-KB diffs). A follow-up spike should confirm `send-keys` behavior at e.g. 500+ lines / tens of KB, where tmux `send-keys` argv length or input-box buffering limits could surface; `paste-buffer`/`load-buffer` (streams from a file) is the more robust path at very large sizes and is the recommended next validation.
- **Enter timing.** A fixed settle delay was used; under load or for very large pastes the input box may still be rendering when Enter fires. Production should either poll the pane for the input-box-ready / paste-collapse state before sending Enter, or scale the settle delay to payload size.
- **Trailing-newline stripping.** The input box trims the source's single trailing newline on submit. Harmless for prompts, but any cache-key hashing of prompt-in vs prompt-on-wire MUST normalize the trailing newline (see § 3.2) or it will see a mismatch.
- Results are pinned to `claude` v2.1.158 + tmux 3.3a on arm64; an Ink-version bump could change #15553 / paste-collapse behavior — re-run the T3 negative control on every `claude` upgrade.

---

## 7. Session lifecycle

### 7.1 Ephemeral default (cleanest privacy — Deployment B default)

Default = **per-request ephemeral session.** Each request gets its own ephemeral `$HOME` + `--session-id` UUID via `prepareIsolatedEnvironment` (REUSE Phase 7). The transcript lands in `/tmp/olp-spawn/<keyId>/<reqId>/home/.claude/projects/...` and is rm'd on cleanup. This is what guarantees Deployment-B per-member privacy: no two members ever share a `$HOME`, and nothing touches the owner's real `~/.claude`.

**NEW bootstrap requirement (S1+S2 gap vs current ISOLATION) — TUI-ONLY, must NOT touch the default path.** ⚠️ The seed + tightened-permissions bootstrap below runs **only when `CLAUDE_TUI_MODE` is active.** The default (stream-json) anthropic path keeps the current `ISOLATION` behavior **unchanged** — no `.claude.json` seed, no private account fields (`oauthAccount`/`userID`) written to disk, no behavior change before the feature flag. Gating the seed on the flag is mandatory: otherwise PR-0 would alter existing default-path behavior and expand the sensitive-data-on-disk surface ahead of any opt-in. (Implementation: the `ISOLATION` extend exposes the seed as an opt-in step the session driver invokes only on the TUI branch; `prepareIsolatedEnvironment` does not seed unconditionally.) The current anthropic `ISOLATION` block only symlinks `.credentials.json` and mkdir's `.claude/`. A *fresh* ephemeral `$HOME` triggers `claude`'s first-run onboarding (theme picker → login-method picker → OAuth browser-open, which **hangs**). Under TUI-mode, the bootstrap MUST additionally seed a minimal `.claude.json` carrying `hasCompletedOnboarding:true` + `oauthAccount` + `userID` (copied from the real `~/.claude.json`, `projects` stripped) + `bypassPermissionsModeAccepted:true`, and pre-trust the cwd in the seeded `projects` map to skip the trust dialog. With that seed, the session drops straight to the ready input box.

⚠️ **The seed does NOT disable managed MCP (T6 negative control).** An earlier draft assumed pinning the seeded `.claude.json` (e.g. removing `claudeAiMcpEverConnected`) would suppress managed-MCP attachment. **T6 disproved this** — the fetch is account/server-driven and ignores the local cache key. The seed's role is **onboarding/trust/bypass convenience only** and carries **no security weight for MCP**; the structural MCP disable is the `--strict-mcp-config` flag (§ 5.2), applied at spawn argv. PR-0 (§ 12) must reflect this: the ISOLATION extend seeds onboarding markers, but the MCP/marketplace disable is a spawn-flag/env concern owned by the session driver, not the seed.

⚠️ **Privacy + credential handling of the seed (see § 5.5).** `oauthAccount` + `userID` are private account fields. Treat the seed file with the same care as the bearer token: never log it, never commit it, write it **mode 600** only into the `/tmp` ephemeral root, and ensure cleanup rm's it. The ephemeral root MUST be **`chmod 700` and per-`keyId` isolated.** (The OAuth bearer itself stays only in the symlinked `.credentials.json`, never copied — but note § 5.5: that symlink is readable by every member spawn and is protected ONLY by the unenforced no-tool property, so B's credential safety is coupled to T2+T6.) An **orphan-tmux-session reaper** must run on server startup to kill restart-surviving sessions that still hold the owner OAuth (§ 5.5).

### 7.2 Warm-pool option (Deployment A only, opt-in `CLAUDE_TUI_WARM_POOL`)

Single-user A may keep N warm interactive sessions to amortize the ~3–4s cold submit→response latency. **A-only** because a warm pool reuses one `$HOME` across requests, which violates B's per-member privacy. Warm-pool entries must still be the *same single owner*. **Critical: the warm pool reuses the PROCESS, not conversation state.** A warm session reused across turns would accumulate conversation context in its transcript — which breaks OpenAI chat-completions **stateless** semantics (a later request would inherit an earlier one's hidden context, dirtying cache + reproducibility) even for a single user (§ 2.1). So each request MUST reset to a clean turn: a fresh `--session-id` per request (preferred — keeps transcript-path computation deterministic) or `/clear` between turns. Cross-request context accumulation is **forbidden for A and B alike** — the only thing A's warm pool saves is process/onboarding cold-start, never context. Pool concerns (crash recovery, idle eviction, max-age recycle) are why tmux is favored over node-pty (§ 8).

### 7.3 Concurrency — UNPROVEN, gates B

All three spikes ran **sequentially**. Concurrent multi-session isolation (N parallel requests) is **unproven**. The likely-correct answer is "one ephemeral `$HOME` per session, distinct `--session-id` + cwd" (which the ephemeral default already gives), but it must be spiked under real parallel load before Deployment B serves concurrent members, including whether one OAuth credential tolerates concurrent interactive sessions (§ 11, spike T4). Until then, B runs with a concurrency limit of 1 (serialize), or stays in canary.

---

## 8. tmux vs node-pty

**Recommendation: tmux as the primary transport; keep a node-pty adapter behind an interface as a fallback/option.**

| Dimension | tmux | node-pty |
|---|---|---|
| Crash recovery | **System-level** — session survives an OLP server restart; can re-attach + capture-pane to recover state | In-process — server crash kills the PTY and loses the turn |
| Weight | External binary dependency; one process per session | In-process, lighter; native addon (engines-bump + CI matrix per ADR 0009 § 6 discipline) |
| Spike coverage | **All of S1/S2/S3 used tmux** — the validated path | Unvalidated for OLP's flow |
| Submission control | `send-keys` key-token vs `-l` text is the exact, S3-calibrated #15553 control | Would need its own submission-reliability re-validation |
| Observability/debug | `capture-pane` gives a human-inspectable pane for ops | Buffer only |

Rationale: every passing spike used tmux, so tmux is the de-risked choice and the one this spec is written against. tmux's system-level crash recovery is especially valuable for the warm-pool (§ 7.2) and for ops debuggability (`tmux attach` to a stuck session). node-pty's in-process lightness is attractive for a pure-Node server, but it adds a native-addon dependency (CI matrix + engines bump) and **has zero spike coverage** — adopting it now would re-open submission and completion-detection risk that tmux has already closed. **Decision:** ship tmux first; define the session driver behind a transport interface (`lib/tui/session.mjs`) so a node-pty adapter can be added later without touching the transcript reader or IR mapping. ⚠️ tmux teardown must be **trap-guaranteed** — S3 noted the driver's best-effort `rm` left empty ephemeral `home_*` dirs with stray cred symlinks; production cleanup must be a `trap`/`finally`, not best-effort, or scratch homes (and cred symlinks) accumulate.

---

## 9. Reuse map

| Need | Reused asset | Status |
|---|---|---|
| Entry surface (`/v1/chat/completions`, key auth, owner gating) | `server.mjs`, `lib/keys.mjs` (`owner_tier`, `providers_enabled`, `__env_owner__`) | REUSE unchanged |
| IR ↔ anthropic shape; `role:system` → `--system-prompt` | `lib/ir`, `lib/providers/anthropic.mjs` `irToAnthropic` / `extractSystemPrompt` | REUSE |
| Tool-suppression + hallucination fix + cost reduction | `OLP_SYSTEM_PROMPT_WRAPPER` (Phase 6c) | REUSE |
| Per-request ephemeral `$HOME`, credential symlink, cleanup | `lib/sandbox/manager.mjs` `prepareIsolatedEnvironment` + anthropic `ISOLATION` (ADR 0002 Amd 9) | REUSE + **EXTEND**: seed `.claude.json` (onboarding/trust/bypass only), `chmod 700` root + mode-600 seed + per-`keyId` isolation (§ 5.5). **NOTE:** the MCP/marketplace disable is NOT in the seed (T6 negative control) — it is the spawn-argv `--strict-mcp-config` + `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1`, owned by the session driver |
| Per-key cache + audit isolation | `lib/cache`, `lib/audit` | REUSE |
| Optional OS-level sandbox (Layer 3) | sandbox-runtime `wrapForLayer3` (ADR 0014) | REUSE if active; orthogonal to TUI |
| Session driver (PTY/tmux, submit, dialogs) | — | **NEW** `lib/tui/session.mjs` |
| Transcript reader (path, completion, extract) | — | **NEW** `lib/tui/transcript.mjs` |

The EXTEND to `ISOLATION` (seed `.claude.json` for onboarding/trust/bypass; tighten root/seed permissions per § 5.5) is the only change to a Phase 7 *bootstrap* surface; it should land as its own reviewable PR (PR-0, Iron Rule 11) with ADR 0002 Amendment 9 cited, because it changes the per-spawn bootstrap contract. The managed-MCP/marketplace disable is **not** part of this EXTEND — T6 proved it is account/server-driven and cannot be controlled via the seeded home; it is enforced at spawn-argv time (`--strict-mcp-config`) by the session driver (PR-2) and gated by the per-spawn verification check.

---

## 10. Risks & opt-in framing

### 10.1 Precarious loophole (document honestly)

- **Anthropic can close it.** Parent-process verification, device fingerprinting, request-cadence/timing-pattern detection, or simply reclassifying "any third-party app" to the credit pool would kill the billing bridge. The bridge is estimated viable ~30–60 days post-2026-06-15 — a spike judgment, **not** Anthropic-confirmed. Per ADR 0009 Amd 1, the implementation must keep working (minus the billing benefit) if the bridge dies, because the cost/hallucination/observability values are orthogonal.
- **Shared 5-hour cap.** One pooled owner OAuth → the subscription's rolling 5-hour cap is shared across all B members. A heavy member can exhaust the window for everyone. Rate-modeling must account for the auxiliary calls too: S1 saw **5× `/v1/messages` per single user turn** (main + prompt_suggestion forked agent + title/topic gen), all `cc_entrypoint=cli` — extra quota draw and extra cap pressure.
- **Requires `claude login` once on the host.** No member OAuth; the owner runs it once. If the OAuth expires/revokes, all of B is down until re-login.

### 10.2 ToS-intent grey area (frame honestly, not as forgery)

TUI-mode runs a *genuinely interactive* `cc_entrypoint=cli` session — it is **not forging** the entrypoint header. But it **automates** that interactive mode to serve programmatic requests, which is against the spirit of "interactive mode = a human at a terminal." OLP states this plainly rather than hiding it. Mitigation = **opt-in**: `CLAUDE_TUI_MODE` lets the operator consciously choose:

- **flag set** → TTY path (grey-area, billing-favorable — `cc_entrypoint=cli`, the genuine interactive-use signal S1 confirmed; **actual subscription-pool billing is a post-2026-06-15 inference, not S1-proven** — § 1.2, measured first by the OCP canary § 12.6);
- **flag unset (default)** → stream-json path (**safe ToS posture, uncertain billing**). Per ADR 0009 § 1.3 the default itself **may** bill to the Agent SDK credit pool because Anthropic may key on the `isTTY` signal rather than the `-p` flag — the piped-stdio default is non-TTY. Do **not** describe the default as a guaranteed credit-pool *or* subscription path; its billing classification is uncertain. Its value is the conservative ToS posture, not a billing guarantee.

No anti-fingerprinting is added (AGENTS.md: "No anti-fingerprinting"). If Anthropic detects and bans the spawn pattern, the documented response is to drop/disable TUI-mode (fall back to the default path or other providers), **not** to mask the spawn.

### 10.3 Reliability gates (be honest where spikes were thin)

- **Completion detection** — **T1 RESOLVED (partial)**: `turn_duration` is reliable for `end_turn` text turns and refusals but **ABSENT on tool-use turns** (would hang). The dual-signal guard (turn_duration **OR** co-equal quiescence/wall-clock/`stop_reason:tool_use` teardown) is now **mandatory and built into PR-1** (§ 4.4), not a deferred fold-in. A true `max_tokens` truncation remains formally unverified (no CLI flag to force it; § 4.5).
- **Submission** — **T3 RESOLVED (PASS)**: multiline + shell-special payloads submit byte-for-byte intact via file → `send-keys -- "$(cat file)"` → separate Enter (§ 6). Gates PR-2 acceptance. Open follow-up: very large pastes (500+ lines / tens of KB) — validate `paste-buffer`/`load-buffer` next (non-blocking for initial A rollout).
- **MCP/marketplace disable** — **T6 RESOLVED (PASS)**: `--strict-mcp-config` (no `--mcp-config`) gives 0 managed-MCP attachment; seed-editing does NOT (account/server-driven). § 5.2.
- **Concurrency** is entirely **unproven** — gates Deployment B (§ 7.3, spike T4).
- **Security (no-tool structural body proof)** — the disable *mechanism* is resolved (T6); the **body-level capture** that the wire `/v1/messages` carries `tools:[]` is the one remaining structural gate (§ 5.2 (4), spike T2) — and per § 5.5 it is a **credential-safety** gate for B, not just MCP hygiene.

---

## 11. Open questions & spike-gated items

No item below blocks the *architecture*; each gates a specific rollout step. **T1, T3, T6 are now spiked** (pre-code gate set, § 12); T2, T4, T5 remain open.

| ID | Status | Question | Gates | Method / Result |
|---|---|---|---|---|
| **T1** | ✅ **PARTIAL** | Is `turn_duration` emitted on `max_tokens`, tool-use, and refusal turns? | Completion-detect reliability (all rollout) — now built into PR-1 | **RESULT:** reliable for `end_turn` text (`durationMs=33135` near-cap) **and** refusal (`durationMs=3221`); **ABSENT on tool-use** (`stop_reason:tool_use`, no marker → hang). True `max_tokens` truncation unforceable (no CLI flag). → dual-signal guard (§ 4.4) is MANDATORY; re-run per CLI/Ink bump |
| **T2** | 🔴 **OPEN** | Can the outbound `/v1/messages` be **proven** (body capture) to carry `tools:[]`? | **Deployment B** (multi-tenant security + credential safety, § 5.5) | Disable mechanism RESOLVED by T6 (`--strict-mcp-config`); remaining: body-capture (MITM/body-log) the wire request; assert no tools array. `--debug api` is insufficient (no bodies) |
| **T3** | ✅ **PASS** | Long/multiline prompts and prompts with tmux-special chars — submit reliably without premature submit? | Real prompt traffic — gates PR-2 acceptance | **RESULT:** 3/3 realistic payloads (fenced code, heavy shell-special, ~50-line block) submitted byte-for-byte, exactly 1 user submit each, 0 premature submit. Recipe: file → `send-keys -- "$(cat file)"` → separate Enter (§ 6). Open follow-up: 500+ lines / tens of KB via `paste-buffer` (non-blocking) |
| **T4** | 🔴 **OPEN** | Under N parallel requests sharing one owner OAuth, does per-session ephemeral `$HOME`+`session-id` give clean isolation, and does one OAuth tolerate concurrent interactive sessions? | **Deployment B concurrency** | Run K concurrent sessions; check transcript isolation, billing entrypoint stays `cli`, no auth contention; until passed, B serializes (concurrency=1) |
| **T5** | 🔴 **OPEN** | inotify vs poll for completion at scale; Opus-class long-streaming latency; cold-start end-to-end latency (unmeasured) | Performance tuning (non-blocking) + sizing the § 4.4 wall-clock cap | `inotifywait` vs 0.5s poll under load; measure long-response `turn_duration` ordering; **measure cold-start end-to-end latency before B** |
| **T6** | ✅ **PASS** | Exact flag/settings combination that disables marketplace auto-fetch + managed-MCP attach | Feeds T2 + is the § 5.2 disable mechanism + § 5.5 credential wall | **RESULT:** `--strict-mcp-config` (no `--mcp-config`) → 0 `mcp-logs-claude-ai-*` dirs, `/mcp` empty (vs baseline 3 servers/28 tools). **NEGATIVE control:** seed-editing (`claudeAiMcpEverConnected`) does NOT disable (account/server-driven). Defense-in-depth: `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1` + `--disallowedTools "mcp__*"` + `--tools ""`/`--allowedTools`. NOT `--bare` (breaks OAuth). Verification gate: assert 0 mcp-logs dirs + `/mcp` empty per spawn |

---

## 12. Rollout

Sequenced to honor Iron Rule 11 (minimum reviewable unit per layer) and to validate billing/security before any multi-tenant exposure.

**Pre-code gate set (DONE — resolved before any PR lands).** Per the two design reviews, T1 must be resolved *with* the transcript reader, not folded in after; and T3/T6 likewise feed the driver/security layers they gate. These three are now **pre-code gates, completed before PR-0/PR-1/PR-2:**

- **T1 (✅ PARTIAL)** — completion detection on non-`end_turn` stop reasons. Result forces the **dual-signal guard** into PR-1's design (§ 4.4), not a later fold-in. Resolved before PR-1.
- **T3 (✅ PASS)** — multiline/special-char submission. Result defines and **gates PR-2 acceptance** (§ 6 recipe). Resolved before PR-2.
- **T6 (✅ PASS)** — marketplace + managed-MCP disable mechanism (`--strict-mcp-config`). Result defines PR-0/PR-2's spawn-flag set (§ 5.2) and is the § 5.5 credential wall. Resolved before PR-0/PR-2.

**PR sequence:**

1. **PR-0 — ISOLATION extend (TUI-ONLY — default path unchanged).** Seed `.claude.json` (onboarding/trust/bypass **only** — NOT an MCP control; § 7.1 + T6 negative control) in the anthropic `ISOLATION` block + `prepareIsolatedEnvironment`, **invoked only on the `CLAUDE_TUI_MODE` branch** so the default stream-json path's bootstrap + on-disk sensitive-data surface are unchanged (§ 7.1). Ephemeral root `chmod 700`, seed mode 600, per-`keyId` isolation (§ 5.5). Cite ADR 0002 Amendment 9. Independent reviewer (Iron Rule 10). Lands first because every TUI spawn depends on it. (The MCP/marketplace disable is spawn-argv/env — `--strict-mcp-config` + `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1` — owned by PR-2's session driver, per T6.)
2. **PR-1 — transcript reader** (`lib/tui/transcript.mjs`): path compute, lazy-create poll, **dual-signal completion (T1): `turn_duration` OR co-equal quiescence/wall-clock/`stop_reason:tool_use` terminal-teardown (§ 4.4)** — designed in from the start, not added later. Assistant-text extraction. `max_tokens`/other-param graceful-drop boundary (§ 4.5–4.6). Returns a **resolved response string** adapted to the `getOrCompute`/singleflight cache contract (§ 3.2). Unit-tested against captured fixtures incl. a tool-use-no-marker fixture.
3. **PR-2 — session driver** (`lib/tui/session.mjs`): tmux spawn with the T6 flag set (`--strict-mcp-config` + `--disallowedTools "mcp__*"` + built-in lockdown; env `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1`) + post-spawn MCP-disable verification gate (§ 5.2). **T3 submit recipe (file → `send-keys -- "$(cat file)"` → separate Enter) + transcript-read verify/retry — T3 PASS gates acceptance.** Dialog auto-answer, trap-guaranteed cleanup, **orphan-tmux-session reaper on startup (§ 5.5)**. tmux transport behind the interface; node-pty stubbed. Single-buffered response + SSE-replay for `stream:true` (§ 3.1).
4. **PR-3 — provider wiring**: `CLAUDE_TUI_MODE` branch in anthropic `.spawn()`; default stays stream-json (uncertain-billing / safe ToS posture, § 10.2). New ADR (0009 Amd 2 / 0016) as authority of record. README: new env var + Troubleshooting (onboarding-hang quirk, OAuth-login requirement, **no true token-streaming** § 3.1, **`max_tokens`/sampling params not honored** § 4.5–4.6) + honest grey-area framing.
5. **Measure cold-start end-to-end latency** (currently unmeasured — fold into T5) before enabling B; informs the § 4.4 wall-clock cap sizing.
6. **OCP canary first.** Enable `CLAUDE_TUI_MODE` on **OCP** (single-tenant, the maintainer's own subscription, Deployment A) post-2026-06-15. OCP is the natural canary: single user, no cross-tenant boundary, and it is where PR #101 originated. Watch billing entrypoint stays `cli`, cap behavior, completion reliability over real usage.
7. **Spike T2 + T4** (security body-capture + concurrency) — **hard gate** before B. T2 is a **credential-safety** gate per § 5.5.
8. **OLP Deployment B** (family/team) only after T2 + T4 pass: enable per-key, members on guest keys (full § 5.2 flag set + per-spawn MCP-disable verification gate), concurrency limit lifted only when T4 passes. Until then B runs serialized or stays in canary.

The version bump + tag fires at the Phase close per CLAUDE.md `release_kit.phase_rolling_mode` (explicit maintainer action), not per D-day push.

---

## 13. Author credit plan (binding — community-PR provenance)

TUI-mode adopts the core idea from **`dtzp555-max/ocp` PR #101 by jaekwon-park** (interactive-`claude` via tmux to keep traffic on the subscription pool). OCP rejected PR #101's *specific implementation* (hook-file polling + `--dangerously-skip-permissions`) on alignment + security grounds, but the *idea* is the seed of this spec. The author MUST be credited and notified:

- **Co-author trailer** on the implementing commits: `Co-Authored-By: jaekwon-park <…>` (use the email/handle from PR #101; do not invent one — pull it from the PR before committing).
- **ADR acknowledgment**: the authority-of-record ADR (0009 Amd 2 / 0016) names PR #101 + jaekwon-park in its "Builds on" / acknowledgment section, noting what was adopted (the interactive-TUI-for-subscription-billing idea) and what was redesigned (transcript-read instead of hook-file; no `--dangerously-skip-permissions`; structural tool-stripping for multi-tenant).
- **CONTRIBUTORS / notification**: add jaekwon-park to CONTRIBUTORS (or equivalent) and **notify them on PR #101** (a comment on the original PR) that the idea was adopted into OLP/OCP TUI-mode, with a link to the shipping PR. This is a courtesy + provenance obligation, not optional.

---

## 14. Authority citations

- **Billing classification** — Anthropic 2026-06-15 split; `~/.cc-rules/memory/learnings/anthropic_claude_code_billing_split_2026_06_15.md`; published docs (`code.claude.com/docs/en/headless`, `support.claude.com/en/articles/15036540`, `support.claude.com/en/articles/11145838`) per ADR 0009 Amd 1 § "Additional spike findings".
- **`--system-prompt` tool suppression + cost/hallucination value** — ADR 0009 Amendment 1; `lib/providers/anthropic.mjs` `OLP_SYSTEM_PROMPT_WRAPPER`; claude CLI v2.1.104+ `--help` § `--system-prompt`.
- **Ephemeral-home isolation contract** — ADR 0014 (sandbox-runtime integration) + ADR 0002 Amendment 9 (Provider ISOLATION contract); `lib/sandbox/manager.mjs` `prepareIsolatedEnvironment`; 2026-05-29 PI231 ephemeral-home spike.
- **Multi-key auth** — ADR 0007; `lib/keys.mjs`.
- **Interactive-mode lineage** — ADR 0009 (placeholder + Amendment 1); OCP ADR 0007; **OCP PR #101 (jaekwon-park)**.
- **Spike evidence** — S1 (billing + no-tool, PARTIAL), S2 (transcript output, PASS), S3 (submission reliability, PASS), **T1 (completion on non-`end_turn` stop reasons, PARTIAL — `turn_duration` reliable for text/refusal, ABSENT on tool-use)**, **T3 (multiline/special-char submission, PASS)**, **T6 (marketplace + managed-MCP disable, PASS — `--strict-mcp-config` load-bearing; seed-edit is NOT a mitigation)**, `claude` v2.1.158, model `claude-haiku-4-5-20251001`, tmux 3.3a, PI231 (ephemeral HOME with seeded creds; PROD :4567 confirmed untouched; scratch + cred symlink removed in finally). Spike JSON retained in session record.
- **CLI version pin** — validated on `claude` v2.1.158; ADR 0009 Amd 1 § "CLI version pin guidance" — emit a log warning if `claude --version` falls outside the validated range; re-run the S3/T3 submission negative control **and** the T1 `turn_duration` + T6 MCP-disable spikes on every `claude` upgrade (Ink-version + undocumented-internal-log + account/server-driven-MCP sensitivity).

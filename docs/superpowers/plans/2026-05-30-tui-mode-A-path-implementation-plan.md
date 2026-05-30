# TUI-mode — Deployment-A Implementation Plan (PR-0 … PR-3)

- **Date:** 2026-05-30
- **Status:** Implementation plan (pre-code). Derived verbatim from the final design spec
  `docs/superpowers/specs/2026-05-30-tui-mode-production-design.md` (3 review passes + spikes S1/S2/S3 + pre-code gates T1/T3/T6). **Decisions in the spec are NOT re-litigated here.**
- **Scope:** **Deployment A only** (single-user / OCP canary). Deployment B (multi-tenant) is DEFERRED behind spikes **T2** (body-capture `tools:[]`) + **T4** (concurrency). B's gating hooks (`--tools ""`, `--strict-mcp-config`, `--disallowedTools "mcp__*"`, per-spawn MCP-disable verification) are **wired in PR-2 but B is not enabled** — no per-key guest path ships in this plan.
- **Authority of record (to be created in PR-3):** ADR 0016 (or ADR 0009 Amendment 2) — see PR-3.
- **Iron Rules in force:** 10 (independent reviewer), 11 (minimum reviewable unit — one PR per layer), 12 (prior-art search done = the spikes). `ALIGNMENT.md` Rule 1 (cite authority) + Rule 2 (no inventing CLI behavior) + Rule 5 (release-kit).
- **Author credit (binding, §13):** every implementing commit carries `Co-Authored-By: jaekwon-park <…>` (pull the real email/handle from OCP PR #101 before committing — do NOT invent). ADR 0016 names PR #101 + jaekwon-park in its acknowledgment section. Add jaekwon-park to CONTRIBUTORS and notify on PR #101 at ship time.

---

## 0. Ground-truth code anchors (verified against the real tree)

Everything below cites the exact function/line the change hooks into. Re-verify line numbers at edit time (the files churn).

| Surface | Location (verified) | Role in TUI-mode |
|---|---|---|
| `spawn(irRequest, authContext, isolationCtx)` (public contract) | `lib/providers/anthropic.mjs:1164` → delegates to `_spawnAndStream` | **PR-3** branches here on `CLAUDE_TUI_MODE`. Default falls through to `_spawnAndStream` (stream-json) UNCHANGED. |
| `_spawnAndStream(irRequest, authContext, spawnImpl, isolationCtx)` | `anthropic.mjs:872` | The default transport. **Not modified** by TUI-mode (PR-3 adds a sibling branch in the public `spawn`, it does not touch `_spawnAndStream`). |
| `buildCliArgs(model, systemPrompt)` | `anthropic.mjs:834` (returns `--model … --output-format stream-json --verbose --no-session-persistence --system-prompt …`) | TUI driver builds its **own** argv (no `-p`, no `--output-format`); it does NOT reuse `buildCliArgs`. Cited as the contrast surface. |
| `extractSystemPrompt(irRequest)` | `anthropic.mjs:123` (always prefixes `OLP_SYSTEM_PROMPT_WRAPPER` `:109`) | **REUSED unchanged** by the TUI driver to compute the `--system-prompt` value. |
| `irToAnthropic(irRequest)` | `anthropic.mjs:601` (serializes user/assistant/tool; skips `system`) | **REUSED unchanged** — produces the prompt body text the TUI driver writes to the prompt file (§6 recipe). |
| `ISOLATION` named export | `anthropic.mjs:1667` (`ephemeralEnvOverrides`→`{HOME}`, `credentialMounts`, `requiredHomePaths:['.claude']`, `hasInnerSandbox:false`) | **PR-0** EXTENDS with a TUI-only seed hook. |
| `prepareIsolatedEnvironment({provider,keyId,reqId})` | `lib/sandbox/manager.mjs:203` → returns `{ephemeralRoot, envOverrides, hardenedArgs, wrapForLayer3, cleanup}` | **PR-0** consumes the new seed step; **PR-2** driver calls it to get `ephemeralRoot`. Note the **test bypass at `:223`** (returns `_legacyShape()` under `test-features.mjs` unless `globalThis.__OLP_FORCE_ISOLATION_IN_TEST`). |
| Buffered spawn call site | `server.mjs:1347` (`prepareIsolatedEnvironment`) → `:1355` (`for await … hopProviderPlugin.spawn(...)`) inside `collectAllChunks()` (`:1299`); result cached via `cacheStore.getOrCompute(keyId, hopCacheKey, collectAllChunks)` at `:1445` | **computeFn returns an ARRAY of IR chunks.** TUI transport must yield `[{type:'delta',role:'assistant',content},{type:'stop',finish_reason:'stop'}]` so this path is unchanged. |
| Streaming spawn call site | `server.mjs:1564` (`prepareIsolatedEnvironment`) → `:1570` (`for await … streamPlugin.spawn(...)`) inside `sourceWithRelease()`; coordinated via `cacheStore.getOrComputeStreaming(keyId, streamCacheKey, sourceFactory, …)` at `:1587` | **sourceFactory returns an ASYNC GENERATOR of IR chunks.** TUI transport yields the same 2-chunk shape → SSE replay (`irChunkToOpenAISSE` at `server.mjs:1764`) is byte-identical to the stream-json path. This is the §3.1 single-buffered-then-replay mechanism. |
| `irChunkToOpenAISSE`, `SSE_DONE` | imported `server.mjs:38`; used `:1764`, `:1772` | **REUSED unchanged** for `stream:true` replay. |
| `max_tokens` parse | `lib/ir/openai-to-ir.mjs:182` (sets `ir.max_tokens`) | Accepted into IR, **dropped at CLI boundary** (§4.5). Same for `temperature` `:190`, `top_p` `:198`, `stop` `:206` (§4.6). |
| `validateKey` / `owner_tier` / `providers_enabled` | `lib/keys.mjs:414`; tiers `'owner'|'guest'|'anonymous'` (`:428`,`:463`) | **REUSED unchanged.** A's canary runs owner-tier. B's guest gating is wired but inert. |

**Cache contract crux (load-bearing for PR-1).** `server.mjs` does NOT expect a string from the transport. It expects **IR chunks** — an array (buffered, `getOrCompute`) or an async generator (streaming, `getOrComputeStreaming`). The TUI transcript reader (PR-1) resolves a **single string**; the TUI driver/provider-branch (PR-2/PR-3) is responsible for the thin adapter `string → [delta, stop]` so both existing cache paths consume it with **zero modification**. This is the concrete meaning of spec §3.2 "returns a resolved response string adapted to the getOrCompute/singleflight cache contract."

---

## Cross-cutting contracts (define these FIRST; every PR conforms)

### C1. Transport interface (so node-pty can slot later — spec §8)

A single interface in `lib/tui/session.mjs`; tmux is the only implementation in this plan; node-pty is a stubbed adapter behind the same interface.

```
interface TuiTransport {
  // create the session bound to ephemeralRoot, spawn `claude` interactive, settle to input box
  open({ bin, args, env, cwd, ephemeralRoot, reqId }): Promise<SessionHandle>
  // submit one prompt body (T3 recipe: file → send-keys -- "$(cat f)" → separate Enter)
  submit(handle, promptText): Promise<void>
  // teardown: kill session + nothing else (ephemeral root rm is the manager.cleanup's job, but
  //   the driver MUST also kill the session in a trap/finally — §8)
  close(handle): Promise<void>
  // startup-time orphan reaper (kill restart-surviving sessions) — §5.5
  reapOrphans(): Promise<{ killed: string[] }>
}
```

`tmuxTransport` implements all four. `nodePtyTransport` is a stub that throws `NOT_IMPLEMENTED` (present so the interface boundary is real and reviewable). The transcript reader (C2) and IR mapping never import the transport — they only consume the deterministic transcript path, so swapping transports later touches nothing else.

### C2. Transcript-reader interface (PR-1 owns it; transport-agnostic)

```
computeTranscriptPath({ ephemeralRoot, cwd, sessionId }): string   // §4.1 formula, pure
readTurnResult({ transcriptPath, sinceUserContent, wallClockCapMs, pollMs }):
  Promise<{ text: string, durationMs?: number, messageCount?: number }>   // resolves the assistant text
  // throws TuiCompletionError on guard-(B) terminal conditions (tool_use / wall-clock cap) — §4.4
```

`readTurnResult` is the **dual-signal** completion engine. It never imports tmux/node-pty. It is unit-tested entirely against captured JSONL fixtures.

### C3. `CLAUDE_TUI_MODE` flag semantics (binding)

- **Unset / not `"1"`** → default path. **Byte-for-byte unchanged** from today: `_spawnAndStream` (stream-json), `ISOLATION` with NO seed, no `.claude.json` written, no new on-disk sensitive data. This is a **hard requirement** (spec §7.1) and is the regression invariant (C4).
- **`CLAUDE_TUI_MODE=1`** → TUI transport: ephemeral home seeded (PR-0), tmux interactive `claude` (PR-2), transcript-read completion (PR-1), provider branch (PR-3).
- The flag is read **once** in the provider `spawn()` branch (PR-3) — `process.env.CLAUDE_TUI_MODE === '1'`. It is the ONLY toggle. No config-file alternative in this plan.
- Sub-flags (A-only, all default-off, all gated under `CLAUDE_TUI_MODE=1`): `CLAUDE_TUI_WARM_POOL` (§7.2 — **out of scope for this plan; not implemented, only namespace-reserved**).

### C4. Default-path-unchanged invariant + how to test it

- **Invariant:** with `CLAUDE_TUI_MODE` unset, no code path added by PR-0..PR-3 executes. `ISOLATION` returns the same shape, `_spawnAndStream` is the only transport, no `.claude.json` is seeded.
- **Test (regression guard, runs in every PR):** the full existing `test-features.mjs` suite stays green. Additionally PR-0 adds an explicit assertion: `prepareIsolatedEnvironment` for the anthropic provider with `CLAUDE_TUI_MODE` unset produces an ephemeral root containing **no** `.claude.json` (only the symlinked `.credentials.json` + `.claude/` dir, as today). PR-3 adds: `spawn()` with the flag unset calls `_spawnAndStream` (assert via the existing `__setSpawnImpl` seam — the mock spawn is invoked, the TUI driver is NOT).

---

## PR-0 — ISOLATION extend (TUI-only `.claude.json` seed)

### 1. Goal
Seed a minimal `.claude.json` (onboarding/trust/bypass markers ONLY) into the ephemeral home **only when `CLAUDE_TUI_MODE` is active**, so a fresh-home interactive `claude` drops straight to the input box instead of hanging on first-run onboarding — while the default stream-json path's bootstrap stays byte-for-byte unchanged.

### 2. Files touched
- `lib/providers/anthropic.mjs` — extend the `ISOLATION` block (`:1667`).
- `lib/sandbox/manager.mjs` — add the opt-in seed step to `prepareIsolatedEnvironment` (`:203`), gated so it is a no-op unless the caller requests it.
- `test-features.mjs` — new suite (seed-on / seed-off / permissions).
- *(no new file in PR-0)*

### 3. Concrete changes

**3a. `ISOLATION` gains a seed descriptor (NOT a function that reads the real home unconditionally).** Add to the anthropic `ISOLATION` object an OPTIONAL field describing the TUI seed, e.g.:

```
// anthropic.mjs ISOLATION (extend, after requiredHomePaths)
tuiSeed: {                         // consumed ONLY when prepareIsolatedEnvironment is called with { tui:true }
  relPath: '.claude.json',         // written under ephemeralRoot
  mode: 0o600,                     // §5.5 — same care as the bearer
  // builder is pure-ish: it reads the real ~/.claude.json ONCE to copy oauthAccount/userID,
  // strips `projects`, and stamps onboarding/trust/bypass markers + a pre-trusted cwd.
  build: ({ cwd }) => ({ /* hasCompletedOnboarding:true, oauthAccount, userID,
                           bypassPermissionsModeAccepted:true,
                           projects: { [cwd]: { hasTrustDialogAccepted:true, … } } */ }),
}
```

- **Authority/contract note:** ADR 0002 Amendment 9's `credentialMounts` is deliberately a static list (not a function) for auditability; the seed is a NEW optional field, so PR-0 must add a one-paragraph Amendment-9 note (in ADR 0002, co-merged or referenced) stating the seed reads the real `~/.claude.json` exactly once to copy `oauthAccount`/`userID`, writes mode-600, and carries **no MCP-disable weight** (T6 negative control, spec §5.2 / §7.1). The seed is onboarding/trust/bypass ONLY.
- **The seed does NOT disable managed MCP** (T6 negative control). PR-0 must NOT add `claudeAiMcpEverConnected` manipulation or any MCP field. A code comment cites spec §5.2 + T6.

**3b. `prepareIsolatedEnvironment` gains a `tui` opt-in param.** Change the signature to `prepareIsolatedEnvironment({ provider, keyId, reqId, tui = false })` (`manager.mjs:203`). After the existing Layer-2 symlink loop (`:318`), add a guarded block:

```
if (tui && isolation?.tuiSeed) {
  // chmod 700 the ephemeralRoot (§5.5), write isolation.tuiSeed.build({cwd}) JSON
  // at join(ephemeralRoot, tuiSeed.relPath) with { mode: tuiSeed.mode }, never log contents.
}
```

- **Default path is untouched:** existing call sites at `server.mjs:1347` and `:1564` pass NO `tui` flag → `tui=false` → seed block is skipped → identity behavior. This satisfies C4. The TUI driver (PR-2) is the ONLY caller that passes `tui:true`.
- **`chmod 700` the ephemeral root** (§5.5) is applied **inside the `tui` block** so the default path's permission semantics are also unchanged. (The default path created the root via `mkdirSync` at `:250`; PR-0 does not alter that.)
- **Per-`keyId` isolation** is already structurally given by the `/tmp/olp-spawn/<safeKeyId>/<safeReqId>/home` path (`manager.mjs:247`). PR-0 adds an assertion/comment that the parent `<safeKeyId>` dir is not world-traversable (chmod 700 on the chain) — §5.5.
- **Test bypass interaction (`manager.mjs:223`):** the existing test-runner bypass returns `_legacyShape()`. PR-0's seed tests MUST set `globalThis.__OLP_FORCE_ISOLATION_IN_TEST = true` to exercise the real path, then unset it in `finally` (this seam already exists).

### 4. Unit tests + fixtures (`test-features.mjs`)
- [ ] **seed-off (default-path invariant, C4):** call `prepareIsolatedEnvironment({provider:anthropic, keyId, reqId})` (no `tui`) under `__OLP_FORCE_ISOLATION_IN_TEST` → assert ephemeralRoot has `.claude/.credentials.json` symlink + `.claude/` dir and **NO `.claude.json`**.
- [ ] **seed-on:** call with `{ tui:true }` → assert `.claude.json` exists, is mode `600`, parses as JSON, contains `hasCompletedOnboarding:true` + `bypassPermissionsModeAccepted:true` + a pre-trusted `projects[cwd]`, and contains **NO** `mcpServers`/`claudeAiMcpEverConnected` field (negative assertion — T6).
- [ ] **root permissions:** assert ephemeralRoot is mode `700` on the `tui:true` path.
- [ ] **no-real-home-mutation:** assert the real `~/.claude.json` is not written/modified (read-only copy).
- [ ] Fixture: a minimal fake `~/.claude.json` (via a temp HOME or an injected reader seam) carrying a dummy `oauthAccount`/`userID` so the test never touches the operator's real account file.
- [ ] Full existing suite stays green (regression).

### 5. PI231 integration checkpoint (maintainer-supervised; /tmp scratch only)
Run on PI231 scratch (prod OLP on :4567 untouched):
- [ ] Drive `prepareIsolatedEnvironment({tui:true})` against a scratch keyId/reqId; `ls -la` the ephemeral root.
- [ ] **Pass criteria:** `.claude.json` present, mode `600`; root mode `700`; symlinked `.credentials.json` present; `cat` the seed shows onboarding/trust/bypass markers and **no MCP fields**; the real `~/.claude.json` mtime unchanged.
- [ ] Launch interactive `claude` by hand bound to that ephemeral HOME and confirm it **does not** hang on onboarding (drops to input box). (This is the load-bearing reason PR-0 exists.)

### 6. Acceptance criteria (binding, testable)
- With `tui` unset, ephemeral home is byte-identical to today (no `.claude.json`). ✔ regression test + PI231.
- With `tui:true`, seed is written mode-600, root mode-700, onboarding/trust/bypass present, MCP fields absent.
- No change to default stream-json spawn behavior; full suite green.

### 7. Reviewer (Iron Rule 10)
Fresh-context reviewer opens **spec §7.1 + §5.2 (T6 negative control) + ADR 0002 Amendment 9** and confirms: (a) the seed is gated on the opt-in `tui` param so the default path is unchanged; (b) the seed carries NO MCP-disable field (T6); (c) mode-600 seed + mode-700 root + per-keyId isolation per §5.5; (d) the Amendment-9 note documenting the new `tuiSeed` field is present. A review that does not name the §5.2 negative control is not a valid approval.

### 8. Authority citation (commit + PR body)
`claude` CLI v2.1.158 § first-run onboarding (theme/login pickers) + `$HOME`-redirect behavior (ADR 0002 Amendment 9 anthropic ISOLATION pin); ADR 0002 Amendment 9 (ISOLATION contract); spec §7.1 + §5.2; PI231 ephemeral-home spike `docs/spikes/2026-05-29-ephemeral-home.md`. State explicitly: **the seed does NOT disable managed MCP — that is the spawn-argv flag in PR-2 (T6).**

### Risk / rollback
Independently revertable (revert reinstates the pre-seed ISOLATION; default path was never touched). Default-off: nothing reaches users — the seed only fires when a caller passes `tui:true`, and no caller does until PR-2/PR-3.

---

## PR-1 — Transcript reader (`lib/tui/transcript.mjs`)

### 1. Goal
A transport-agnostic reader that computes the deterministic transcript path, polls for lazy file creation, detects turn completion via the **mandatory dual-signal guard** (turn_duration OR tool_use OR wall-clock cap; NO quiescence in v1), extracts the assistant text, and resolves a single response string.

### 2. Files touched
- **NEW** `lib/tui/transcript.mjs`.
- `test-features.mjs` — new transcript-reader suite.
- Fixtures dir (NEW) `docs/spikes/fixtures/tui/` — captured real JSONL (see §4).

### 3. Concrete changes (exports + signatures)

- `export function computeTranscriptPath({ ephemeralRoot, cwd, sessionId })` — **pure.** Implements §4.1: `<ephemeralRoot>/.claude/projects/<CWD_ENCODED>/<sessionId>.jsonl` where `CWD_ENCODED` = `cwd` with **every** `/` → `-` **including the leading slash** (`/tmp/x` → `-tmp-x`). No filesystem access. (OLP generates `sessionId` and `cwd`, so the path is known before spawn.)
- `export async function readTurnResult({ transcriptPath, sinceUserContent, wallClockCapMs = 120_000, pollMs = 500, toolUseIsTerminal = true })`:
  - **Lazy-create poll:** the file is created on first message, not at spawn (§4.1). Tolerate ENOENT; poll every `pollMs` until the file exists or `wallClockCapMs` elapses (then throw `TuiCompletionError('completion-marker timeout')`).
  - **Dual-signal completion (§4.4, MANDATORY):**
    - **(A) happy path:** a line `{"type":"system","subtype":"turn_duration"}` for this turn appears → done. Carries `durationMs` + `messageCount`. Do NOT rely on file-tail byte ordering (§4.3 trap): re-scan the file, find the matching `user` line for `sinceUserContent`, collect all subsequent `assistant`/`text` blocks.
    - **(B) co-equal terminal guard (mandatory, never-hang):** if the last assistant message carries `stop_reason:"tool_use"` → throw `TuiCompletionError('tool-use turn unsupported in TUI-mode')` (maps to clean 502). If `wallClockCapMs` fires → throw `TuiCompletionError('completion-marker timeout')`.
    - **NO quiescence cut in v1** (§4.4 ⚠️): do NOT abort on "file size-stable for N seconds" — a long Opus/extended-thinking turn legitimately produces no growth. Quiescence is added only after spike T5. (Comment cites §4.4 explicitly so a future contributor does not "helpfully" add it.)
    - Do NOT key off `stop_reason:"end_turn"` alone (§4.3 trap — appears on both `thinking` and `text` blocks).
  - **Assistant-text extraction (§4.2):** `JSON.parse` per line (native log → escaping-clean). Response = concatenation of `text`-type content blocks from `assistant` messages emitted **since the matching `user` line**. Return `{ text, durationMs, messageCount }`.
  - **Trailing-newline normalization (§3.2 / §6 caveat):** the input box strips the source's single trailing newline. `sinceUserContent` matching MUST normalize the trailing newline before comparing source-prompt vs the transcript `user` line, or the "matching user line" lookup (and any cache-key reasoning) sees a spurious mismatch.
- **Cache-contract adapter note (does NOT live in PR-1, but PR-1's return shape is designed for it):** `readTurnResult` resolves a string; the PR-2/PR-3 layer wraps it as `[{type:'delta',role:'assistant',content:text},{type:'stop',finish_reason:'stop'}]`. PR-1's JSDoc states this adapter contract and points at `server.mjs:1299` (buffered array) + `server.mjs:1558` (streaming generator) so the reviewer sees the two consumers. **max_tokens/sampling graceful-drop boundary** (§4.5/§4.6): PR-1 documents that these IR fields never reach this layer (interactive `claude` has no flag); nothing to do — they are dropped at the CLI-args boundary in PR-2/PR-3. PR-1 adds a comment asserting `finish_reason` is always `'stop'` (no `length` mapping, since max_tokens is not enforced).

### 4. Unit tests + fixtures
**Fixtures (capture REAL JSONL on PI231 — do not hand-fabricate the shapes):**
- [ ] `text-turn.jsonl` — a normal `end_turn` text answer ending in a `turn_duration` line.
- [ ] `refusal-turn.jsonl` — a refusal that still emits `turn_duration` (T1: `durationMs≈3221`).
- [ ] `tool-use-no-marker.jsonl` — **MANDATORY** (T1): a `tool_use` turn whose last assistant line is `stop_reason:"tool_use"` with **NO** `turn_duration` line. This is the hang case guard (B) must catch.
- [ ] `out-of-order.jsonl` — a text block flushed by byte-position AFTER `turn_duration` though `turn_duration` has the later timestamp (§4.3 trap) — proves the reader does not rely on file-tail ordering.
- [ ] `multiturn.jsonl` — two user lines so `sinceUserContent` selection is exercised (a `toolUseResult:true` user line within a turn must NOT be mistaken for a new submit — §6 step 5).

**Tests:**
- [ ] `computeTranscriptPath` exact-string equality incl. leading-slash encoding.
- [ ] happy path returns concatenated text + `durationMs`/`messageCount`.
- [ ] refusal path returns refusal text (still completes).
- [ ] **tool-use fixture → throws `TuiCompletionError` (never hangs)** — assert with a short `wallClockCapMs` that the throw is the tool_use detection, not the timeout (distinguish the two error messages).
- [ ] wall-clock cap fires on a never-completing fixture (truncated file with no marker) → throws within cap.
- [ ] out-of-order fixture → correct text (no reliance on last byte).
- [ ] trailing-newline normalization: `sinceUserContent` with trailing `\n` still matches the transcript user line.
- [ ] **no-quiescence assertion:** a fixture that is size-stable for > pollMs but has not completed does NOT abort before the wall-clock cap (proves quiescence is excluded).
- [ ] Full existing suite stays green (PR-1 adds a new module + new tests only; touches no existing path).

### 5. PI231 integration checkpoint (maintainer-supervised)
- [ ] Capture the 5 fixtures above from real `claude` v2.1.158 runs on PI231 scratch (this is also how the fixtures are sourced). Commit them under `docs/spikes/fixtures/tui/`.
- [ ] **Pass criteria:** `readTurnResult` against each freshly-captured fixture returns the same text a human reads in the transcript; the tool-use capture throws `TuiCompletionError` and never blocks; cap fires deterministically on a manually-truncated fixture.

### 6. Acceptance criteria (binding)
- Deterministic path matches §4.1 exactly.
- Dual-signal completion: completes on `turn_duration`; **never hangs** on tool-use or a missing marker (guard B); **no quiescence cut**.
- Escaping-clean text extraction; trailing-newline normalized.
- Pure reader: zero tmux/node-pty import; fully fixture-testable.

### 7. Reviewer (Iron Rule 10)
Fresh-context reviewer opens **spec §4.1–§4.4 (and §3.2 cache-contract / trailing-newline)** and confirms: (a) the path formula incl. leading-slash; (b) the dual-signal guard is present AND quiescence is explicitly excluded with a §4.4 citation; (c) the tool-use-no-marker fixture exists and the test proves a non-hanging terminal throw; (d) the resolved-string return is documented against the `getOrCompute`/`getOrComputeStreaming` consumers. A review missing the tool-use-no-marker check is not valid.

### 8. Authority citation
`claude` CLI v2.1.158 § native session transcript JSONL (`turn_duration` is an undocumented internal-log behavior — pin to v2.1.158, re-verify per CLI/Ink bump); spec §4 (S2 PASS) + §4.4 (T1 PARTIAL); fixtures captured PI231 2026-05-30. No OpenAI-spec surface (reader is internal). ALIGNMENT Rule 2: the reader consumes a behavior `claude` actually emits — no invented format.

### Risk / rollback
New file + new tests only; revert deletes the module and tests, default path untouched. Riskiest sub-step is the dual-signal guard's tool-use detection (the hang vector) — fully covered by the mandatory fixture.

---

## PR-2 — Session driver (`lib/tui/session.mjs`)

### 1. Goal
A tmux-backed interactive-`claude` driver behind the transport interface (C1): spawn with the T6 flag set, submit via the T3 recipe, auto-answer dialogs, run the per-spawn MCP-disable verification gate, guarantee teardown via trap/finally, and reap orphan sessions on startup — producing a single buffered response (via PR-1's reader) adapted to IR chunks for both cache paths.

### 2. Files touched
- **NEW** `lib/tui/session.mjs` (tmux transport + node-pty stub + the driver `runTuiTurn`).
- `lib/sandbox/manager.mjs` — driver calls `prepareIsolatedEnvironment({…, tui:true})` (the param added in PR-0).
- `test-features.mjs` — driver suite (with a mock transport — no real tmux/claude in unit tests).
- *(server wiring is PR-3, NOT here)*

### 3. Concrete changes

**3a. Transport interface + tmux implementation (C1).**
- `export const tmuxTransport` implementing `open/submit/close/reapOrphans`.
- `export const nodePtyTransport` — stub throwing `NOT_IMPLEMENTED` (interface placeholder, §8 decision: tmux first).
- Session naming: `olp-tui-<keyId>-<reqId>` so `reapOrphans` can pattern-match.

**3b. Spawn argv (T6 flag set, §5.2) — the driver builds its OWN args (NOT `buildCliArgs`).**
```
claude --model <m> --session-id <uuid> --system-prompt "<extractSystemPrompt(ir)>"
       --strict-mcp-config                 // T6 load-bearing: 0 managed-MCP (no --mcp-config supplied)
       --disallowedTools "mcp__*"          // deny MCP-namespaced tools
       [--tools "" ]                        // B-only built-in lockdown — WIRED, gated off for A (see 3g)
       // NO -p, NO --output-format  → real TTY → cc_entrypoint=cli
env:   CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1   // defense-in-depth
       + carry-forward: CLAUDE_CODE_DISABLE_CLAUDE_MDS=1, unset ANTHROPIC_* (reuse buildSpawnEnv semantics)
       + HOME=<ephemeralRoot> (from prepareIsolatedEnvironment envOverrides)
```
- `--system-prompt` value comes from **`extractSystemPrompt(ir)` (`anthropic.mjs:123`) — REUSED.** Prompt body comes from **`irToAnthropic(ir)` (`anthropic.mjs:601`) — REUSED** (written to the prompt file, 3d).
- **`--bare` is forbidden** (§5.2 — breaks OAuth). Comment cites it.
- `--model` from `ir.model`; `--session-id` is the OLP-generated UUID also fed to `computeTranscriptPath`.

**3c. Per-spawn MCP-disable verification gate (§5.2 (4) preflight semantics).** After `open()` settles, assert **0** dirs matching `$HOME/.cache/claude-cli-nodejs/*/mcp-logs-claude-ai-*` under the ephemeral root. **Do NOT run `/mcp` inside the serving session** (§5.2: it writes a transcript line, consumes a turn, corrupts the reader's matching-user-line semantics). For A's canary the cache-dir assertion is the in-band check; the `/mcp`-empty assertion belongs to a **separate preflight session at startup / CLI upgrade** (wire the preflight hook here but it is owner-tier advisory for A; it becomes a hard gate for B). On assertion failure: tear down + clean 502.

**3d. Submit recipe (T3 PASS — binding for acceptance, §6).**
1. Write `irToAnthropic(ir)` to a file under the ephemeral root (NEVER interpolate into a shell line — backticks/`$()`/`&&`/quotes get mangled by the shell, §6 step 1).
2. `tmux send-keys -t <S> -- "$(cat promptfile)"` — the leading `--` end-of-options guard is **required** (prompt starting with `-`). Embedded `\n` are soft line-breaks; do NOT submit. Do NOT use `send-keys -l` for the body (§6 step 2).
3. Settle ~1.5–2s for Ink render / paste-collapse (§6 step 3). (Production: poll the pane for input-box-ready / paste-collapse before Enter, or scale settle to payload size — §6 caveat.)
4. **Submit Enter as a SEPARATE tmux KEY TOKEN:** `tmux send-keys -t <S> Enter` — never a literal `"\n"` appended to text (Ink #15553, §6 step 4).
5. **Verify via TRANSCRIPT** (not `capture-pane`): exactly one `user`-role line whose content equals source minus its single trailing newline (a second `user` line with `toolUseResult:true` is in-turn tool output, not a second submit — §6 step 5). Large pastes collapse to a `[Pasted text …]` placeholder so pane-scraping is impossible — transcript-read is mandatory.
6. **Retry** Enter (key token) up to ~4× as a defensive guard (§6 step 6).

**3e. Dialog auto-answer (S3 footgun, §6).** With the PR-0 seed (trust + bypass pre-seeded) neither dialog should appear. Defensive handling if they do: trust-folder defaults to "1. Yes, I trust" → bare Enter confirms; the **bypass-permissions dialog defaults cursor to "1. No, exit"** — a naive Enter **kills the session** → must send **Down then Enter** to land on "2. Yes, I accept". Prefer the pre-seed; keep the Down+Enter recipe as fallback.

**3f. Teardown (trap-guaranteed, §8) + orphan reaper (§5.5).**
- `close()` + ephemeral-root cleanup MUST run in a `finally` (NOT best-effort) — S3 noted best-effort `rm` left empty `home_*` dirs with stray cred symlinks. The driver wraps the whole turn in `try { … } finally { await transport.close(handle); await isolationCtx.cleanup(); }`.
- `tmuxTransport.reapOrphans()` runs at **server startup** (called from PR-3's boot path): list `olp-tui-*` tmux sessions surviving a restart, kill each + `rm -rf` its ephemeral root (these still hold the owner OAuth via the mounted ephemeral home — §5.5). This is the restart-time backstop complementing the steady-state finally.

**3g. B-gate hooks wired but inert (scope discipline).** `--tools ""` (built-in lockdown) and the `/mcp`-empty hard gate are **present in the code path but only activated for `owner_tier === 'guest'`**, which no A/canary request is. A comment + the ADR state: **B does not launch until T2 (body-capture `tools:[]`) passes; serialized after T2; concurrent only after T4** (§5.2 gate semantics). PR-2 ships the flags; PR-3/B-enablement flips them on. No guest key is provisioned in this plan.

**3h. Single buffered response + SSE replay (§3.1).** The driver's public entry, e.g. `export async function runTuiTurn({ ir, authContext, keyId, reqId, transport = tmuxTransport })`, returns the **resolved string** from PR-1's `readTurnResult`. The IR-chunk adapter `string → [{type:'delta',role:'assistant',content},{type:'stop',finish_reason:'stop'}]` is applied by PR-3's provider branch so both `getOrCompute` (buffered array) and `getOrComputeStreaming` (async generator) consume it unchanged — for `stream:true` the existing `irChunkToOpenAISSE` replay (`server.mjs:1764`) emits the completed text as one burst of delta(s) + `[DONE]` AFTER the turn finishes. **True token streaming is NOT possible** (§3.1) — `capture-pane` partial-text tapping is explicitly rejected (large pastes collapse to `[Pasted text …]`).

### 4. Unit tests + fixtures
- [ ] **mock transport** (no real tmux/claude): assert the driver builds the exact T6 argv set (`--strict-mcp-config`, `--disallowedTools "mcp__*"`, no `-p`, no `--output-format`, no `--bare`, env `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1`).
- [ ] submit recipe shape: prompt written to a file; `send-keys -- "$(cat …)"` issued; Enter is a SEPARATE token; on a simulated missed-Enter the retry fires ≤4×.
- [ ] dialog fallback: simulated bypass dialog → driver sends Down+Enter (not bare Enter).
- [ ] teardown: assert `close` + `cleanup` fire in `finally` on both happy and thrown paths (inject a throw mid-turn).
- [ ] reaper: seed fake `olp-tui-*` session records into the mock transport → `reapOrphans` kills them + rms roots.
- [ ] guest-gating: with `owner_tier:'guest'` the argv gains `--tools ""`; with `'owner'` it does not (B-hook wired-but-inert proof).
- [ ] string→IR-chunk adapter produces `[delta, stop]` with `finish_reason:'stop'`.
- [ ] T3 regression negative control (documented, runs on PI231 not in unit): a newline-as-text submit silently fails (Ink #15553) — guards against a future refactor reintroducing `-l`.
- [ ] Full existing suite green; default path (flag-unset) never reaches this module.

### 5. PI231 integration checkpoint (maintainer-supervised; /tmp scratch + tmux only)
- [ ] Real multiline-code request (fenced code block + shell-special chars, ~50 lines per T3) through `runTuiTurn` against real `claude` v2.1.158 on PI231 scratch.
- [ ] **Pass criteria:** response text is correct and byte-for-byte intact; exactly ONE `user` submit in the transcript; **`cc_entrypoint=cli` verified** (transcript `turn_duration` line `entrypoint=cli` / `--debug` metadata); MCP-disable gate passes (0 `mcp-logs-claude-ai-*` dirs); the real `~/.claude` is **untouched** (mtime check on `~/.claude.json` + `~/.claude/projects`); session is killed + ephemeral root removed on completion (no stray `home_*`); reaper kills a deliberately-orphaned session on the next startup.
- [ ] Re-run the T3 negative control (newline-as-text fails to submit) to confirm the Ink #15553 control still holds on this CLI version.

### 6. Acceptance criteria (binding)
- T6 flag set applied; MCP-disable gate asserts 0 managed-MCP (cache-dir evidence) per spawn.
- T3 submit: multiline/shell-special payload submits byte-for-byte, exactly one submit, transcript-verified.
- Trap-guaranteed teardown (no stray ephemeral roots / cred symlinks) + startup orphan reaper.
- Single buffered response; `stream:true` is SSE-replay (no token streaming). B hooks wired but inert.
- `cc_entrypoint=cli` confirmed; real `~/.claude` untouched.

### 7. Reviewer (Iron Rule 10)
Fresh-context reviewer opens **spec §5.2 (T6) + §6 (T3) + §3.1 + §5.5 + §8** and confirms: (a) `--strict-mcp-config` with NO `--mcp-config` is the disable mechanism (not seed-editing); (b) `--bare` is NOT used; (c) the T3 recipe is file→`send-keys -- "$(cat)"`→separate Enter (not `-l`, not literal `\n`); (d) teardown is finally-based + a startup reaper exists; (e) B hooks (`--tools ""`, `/mcp` hard gate) are present but gated to guest and B is documented as blocked on T2/T4; (f) response is single-buffered with SSE replay, no token streaming. A review that does not open the live `claude --help` for `--strict-mcp-config`/`--disallowedTools` on v2.1.158 is not valid.

### 8. Authority citation
`claude` CLI v2.1.158 § `--strict-mcp-config`, § `--disallowedTools`, § `--system-prompt`, § `--session-id`, § `--model` (live `--help` on PI231); env `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1` (binary-confirmed); `tmux` 3.3a § `send-keys`/`send-keys -l`/key-tokens (Ink #15553 control); spec §5.2 (T6 PASS), §6 (T3 PASS), §3.1, §5.5, §8. ALIGNMENT Rule 2: every flag is one `claude` accepts — no invented flag.

### Risk / rollback
Riskiest PR. Independently revertable (deletes the module + the `tui:true` caller; PR-0/PR-1 inert without it). Default-off: no server path invokes `runTuiTurn` until PR-3, and even then only under `CLAUDE_TUI_MODE=1`.

---

## PR-3 — Provider wiring + ADR + README

### 1. Goal
Add the `CLAUDE_TUI_MODE` branch in the anthropic provider `spawn()` so a flagged request routes to the TUI driver and yields IR chunks; default stays stream-json. Land ADR 0016 as authority of record and the README docs (quirks + non-honored params + grey-area framing).

### 2. Files touched
- `lib/providers/anthropic.mjs` — branch in public `spawn()` (`:1164`); call `reapOrphans` from a boot hook (or export an init the server calls).
- `server.mjs` — call the orphan reaper at startup (near `bootstrapSandbox`, `:82`/boot path); pass `tui:true` to `prepareIsolatedEnvironment` ONLY on the TUI branch (the branch lives in the provider, so the simplest wiring is: the provider's TUI branch calls `prepareIsolatedEnvironment({…, tui:true})` itself; if the existing architecture composes isolation in `server.mjs` before `spawn`, PR-3 adds a flag-gated `tui` pass-through there — decide per the under-spec note below).
- `docs/adr/0016-tui-mode.md` — NEW (or ADR 0009 Amendment 2).
- `README.md` — env-var table, Troubleshooting, API/Configuration notes.
- `CHANGELOG.md` — Unreleased entry (no version bump mid-Phase per CLAUDE.md `phase_rolling_mode`).
- `CONTRIBUTORS` — add jaekwon-park.
- `test-features.mjs` — branch-selection tests.

### 3. Concrete changes

**3a. `spawn()` branch (`anthropic.mjs:1164`).**
```
export async function* spawn(irRequest, authContext, isolationCtx) {
  if (process.env.CLAUDE_TUI_MODE === '1') {
    // import { runTuiTurn } from '../tui/session.mjs'
    const text = await runTuiTurn({ ir: irRequest, authContext, keyId, reqId, … });
    yield { type: 'delta', role: 'assistant', content: text };
    yield { type: 'stop', finish_reason: 'stop' };
    return;
  }
  yield* _spawnAndStream(irRequest, authContext, _spawnImpl, isolationCtx);  // UNCHANGED default
}
```
- The default branch (`_spawnAndStream`) is **byte-for-byte unchanged**. C4 invariant holds.
- The 2-chunk yield is exactly what `collectAllChunks` (`server.mjs:1299`) buffers into an array for `getOrCompute`, and what `sourceWithRelease` (`server.mjs:1558`) yields for `getOrComputeStreaming` → SSE replay. No server change to the cache paths.
- **keyId/reqId access:** the provider `spawn()` currently receives `(irRequest, authContext, isolationCtx)` — it does NOT receive `keyId/reqId`. The TUI driver needs them (for ephemeral root + session name). **Under-spec — see §"Open implementation questions".** Options: (i) thread `keyId/reqId` into the TUI branch via `isolationCtx` (the manager already has `safeKeyId/safeReqId` and `ephemeralRoot`), so the driver reuses `isolationCtx.ephemeralRoot` rather than re-preparing; (ii) pass a `tui:true` to `prepareIsolatedEnvironment` at the server call site (flag-gated) and let the driver consume the returned `ephemeralRoot`. **Recommended: (i)** — the provider's TUI branch reads `isolationCtx.ephemeralRoot` + a reqId carried on `isolationCtx`, and PR-0's seed runs because the server passes `tui: (process.env.CLAUDE_TUI_MODE==='1')` to `prepareIsolatedEnvironment` at `server.mjs:1347` and `:1564`. This keeps the seed/ephemeral-root creation in the manager (one owner) and the tmux drive in the provider. Maintainer to confirm the threading before PR-2 finalizes its `runTuiTurn` signature.

**3b. Orphan reaper at startup.** Call `tmuxTransport.reapOrphans()` from the server boot path (alongside `bootstrapSandbox`, `server.mjs:82` import region / router init at `:2334`+), gated on `CLAUDE_TUI_MODE==='1'` so default deployments incur zero tmux dependency.

**3c. max_tokens / sampling graceful-drop (§4.5/§4.6) — already the behavior; just assert + document.** The TUI argv carries no `--max-tokens`/`--temperature`/etc. (interactive `claude` has none). `ir.max_tokens` (`openai-to-ir.mjs:182`), `temperature`, `top_p`, `stop` are accepted into IR and silently dropped at the argv boundary — same posture as the stream-json path. No error. Document in README (3e).

**3d. ADR 0016 (authority of record).** New ADR: Context (2026-06-15 billing split + ADR 0009 Amd 1 premise), Decision (TTY-backed TUI transport behind `CLAUDE_TUI_MODE`, default stays stream-json), the spike record (S1/S2/S3 + T1/T3/T6 results; T2/T4/T5 open), the §5.2 security model + §5.5 credential coupling, the §3.1 no-token-streaming decision, the §4.5/§4.6 dropped-param decision, A-vs-B gate semantics (no B before T2; serialized after T2; concurrent after T4). **Acknowledgment section names OCP PR #101 + jaekwon-park** (adopted: interactive-TUI-for-subscription idea; redesigned: transcript-read not hook-file, no `--dangerously-skip-permissions`, structural tool-stripping for B). Supersede note on ADR 0009 Amendment 1's billing-pool lane (§Status of the spec).

**3e. README.** Per CLAUDE.md `release_kit.new_feature_doc_expectations`:
- **Environment Variables table:** `CLAUDE_TUI_MODE` (default unset/off; opt-in TTY path; grey-area, billing-favorable, post-2026-06-15-inference), `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL` (set by TUI driver). Reserve-note `CLAUDE_TUI_WARM_POOL` as A-only future.
- **Troubleshooting / TUI-mode §:** onboarding-hang quirk (fresh ephemeral home → seed required, PR-0); **OAuth-login requirement** (one `claude login` on the host; member keys hold OLP keys not OAuth); **NO true token-streaming** (§3.1 — `stream:true` is replay-after-completion, one burst); **`max_tokens`/sampling params not honored** (§4.5–§4.6); honest grey-area framing (§10.2 — opt-in, no anti-fingerprinting, drop-on-ban).
- Do NOT hand-edit the Supported Providers table (sourced from `models-registry.json`).

### 4. Unit tests + fixtures
- [ ] `CLAUDE_TUI_MODE` unset → `spawn()` invokes `_spawnAndStream` (assert via `__setSpawnImpl` mock spawn is called; `runTuiTurn` is NOT). **C4 regression.**
- [ ] `CLAUDE_TUI_MODE='1'` → `spawn()` invokes `runTuiTurn` (inject a mock driver returning a fixed string) and yields `[delta, stop]` with `finish_reason:'stop'`.
- [ ] buffered path: a flagged request through the (mocked) provider produces a well-formed OpenAI JSON body (drive `getOrCompute`'s array consumer).
- [ ] streaming path: a flagged `stream:true` request replays as SSE delta(s) + `[DONE]` (drive `irChunkToOpenAISSE`).
- [ ] dropped-param: a request with `max_tokens`/`temperature` succeeds and ignores them (no error).
- [ ] reaper boot hook is a no-op when flag unset.
- [ ] Full existing suite green.

### 5. PI231 integration checkpoint (maintainer-supervised)
- [ ] On PI231 scratch (prod :4567 untouched), run a real flagged request end-to-end through OLP scratch instance with `CLAUDE_TUI_MODE=1`: buffered `stream:false` returns correct JSON; `stream:true` returns valid SSE (one burst); flag-unset run is identical to today's stream-json.
- [ ] **Pass criteria:** flagged path returns correct text via tmux/transcript; `cc_entrypoint=cli`; default path unchanged (diff a flag-unset response against current prod behavior); reaper runs clean at startup; real `~/.claude` untouched.

### 6. Acceptance criteria (binding)
- Flag unset → identical to current stream-json (C4). Flag set → TUI path, correct buffered + SSE-replay responses.
- ADR 0016 merged as authority of record, names PR #101 + jaekwon-park.
- README documents the env var, onboarding-hang, OAuth-login req, no-token-streaming, dropped params, grey-area framing.
- CHANGELOG Unreleased entry; CONTRIBUTORS updated; no mid-Phase version bump.

### 7. Reviewer (Iron Rule 10)
Fresh-context reviewer opens **spec §3.1, §4.5–§4.6, §10.2, §12 (PR-3), §13 + ADR 0016** and confirms: (a) the default branch is unchanged and the flag is the sole toggle (C4); (b) the 2-chunk adapter slots into both cache paths without server cache-layer edits; (c) dropped params documented, no silent failure; (d) ADR 0016 acknowledges PR #101/jaekwon-park and the co-author trailer is on the commits; (e) README quirks present. A review that does not open ADR 0016 + confirm the author-credit obligation is not valid.

### 8. Authority citation
OpenAI `/v1/chat/completions` spec (entry surface is unchanged; `stream`, `max_tokens`, `temperature`, `top_p`, `stop` fields — document non-honored set) — cite the OpenAI spec URL for the entry-surface PR portion; `claude` CLI v2.1.158 (provider branch); ADR 0016 (new authority of record) + ADR 0009 Amendment 1 (superseded billing lane) + ADR 0002 Amendment 9 (ISOLATION) + ADR 0014 (sandbox). spec §§3.1/4.5/4.6/10.2/12/13. Co-author trailer `jaekwon-park` on every commit (§13).

### Risk / rollback
Independently revertable (revert removes the branch; provider returns to pure stream-json). **Default-off is the kill switch:** until an operator sets `CLAUDE_TUI_MODE=1`, nothing about TUI-mode executes. The OCP single-tenant canary (post-2026-06-15) is the first real enablement.

---

## Parallel B-gate spike track (does NOT block A)

These run independently of PR-0..PR-3 and gate Deployment B only. One paragraph each.

- **T2 — body-capture `tools:[]` (security + credential-safety gate, §5.2(4)/§5.5).** Stand up a body-logging channel for the outbound `/v1/messages` from an interactive `claude` spawn (a local MITM proxy with a trusted cert in the ephemeral home, or a body-capturing forward proxy via `HTTPS_PROXY`). `--debug api` is insufficient (metadata only). Method: run a TUI turn under the full §5.2 flag set (`--strict-mcp-config` + `--disallowedTools "mcp__*"` + `--tools ""`), capture the wire request body, assert it carries `tools:[]` or no tools array. PASS is the hard gate that lets B launch (serialized). Per §5.5 this is a **credential-safety** gate, not mere MCP hygiene.
- **T4 — concurrency (§7.3).** Run K concurrent TUI turns sharing one owner OAuth, each with its own ephemeral `$HOME` + `--session-id` + cwd. Method: fire K parallel `runTuiTurn` calls; assert transcript isolation (no cross-session lines), billing entrypoint stays `cli` on all, no OAuth auth contention/refresh thrash, and that one credential tolerates K concurrent interactive sessions. Until PASS, B serializes (concurrency=1). This lifts B's concurrency limit only.
- **T5 — cold-start latency + inotify (§4.4 sizing / non-blocking).** Method: measure submit→transcript-available cold-start end-to-end (currently unmeasured); compare `inotifywait` vs 0.5s poll under load; measure Opus-class long-stream `turn_duration` ordering to size the §4.4 wall-clock cap (recommend ≥120s, tune here). Non-blocking for A; informs the cap constant and a possible future quiescence window (which §4.4 forbids in v1).

---

## Test strategy on PI231 without breaking prod

- **PI231 runs prod OLP on :4567.** It must stay untouched throughout. All TUI testing is **/tmp scratch + tmux**: a scratch OLP instance on a different port (or direct `node` invocation of the new modules), ephemeral homes under `/tmp/olp-spawn/*`, scratch tmux sessions `olp-tui-*`.
- **Never** point a TUI test at the prod `~/.claude` — the ephemeral-home seed + symlink keep the real home read-only; every PI231 checkpoint asserts `~/.claude.json` + `~/.claude/projects` mtime unchanged.
- **The canary is OCP single-tenant post-6/15** (spec §12.6): OCP is one user, no cross-tenant boundary, and is where PR #101 originated. Enable `CLAUDE_TUI_MODE=1` there first; watch billing entrypoint stays `cli`, cap behavior, completion reliability over real usage — before any OLP Deployment-B exposure.
- Mac mini is NEVER a test target (cc-mem rule). MacBook/PI231-scratch only.

---

## Author credit (binding, §13) — checklist applied to every PR

- [ ] Co-author trailer `Co-Authored-By: jaekwon-park <…>` on every implementing commit (pull real email/handle from OCP PR #101 first — do not invent).
- [ ] ADR 0016 names PR #101 + jaekwon-park (adopted idea vs redesigned implementation).
- [ ] Add jaekwon-park to CONTRIBUTORS.
- [ ] Notify on OCP PR #101 (comment linking the shipping PR) at ship time.

---

## Open implementation questions (maintainer decides BEFORE code)

1. **keyId/reqId into the TUI driver.** The provider `spawn(irRequest, authContext, isolationCtx)` does not receive `keyId/reqId` today. The driver needs them for the ephemeral root + tmux session name. Recommended: have the server pass `tui:(CLAUDE_TUI_MODE==='1')` to `prepareIsolatedEnvironment` at `server.mjs:1347`/`:1564` (so the seed + chmod fire in the manager), and thread `ephemeralRoot` (+ a reqId field) to the provider via `isolationCtx`; the TUI branch then reuses `isolationCtx.ephemeralRoot` rather than re-preparing. Confirm this threading before PR-2 fixes `runTuiTurn`'s signature. **(Spec §3.2 implies the reuse but does not specify the parameter plumbing.)**
2. **Warm pool (§7.2) is namespace-reserved, not built.** Confirm A's canary runs ephemeral-per-request (no warm pool) for this plan — the spec allows warm pool for A but it adds cross-request-context-leak risk and is out of the PR-0..PR-3 scope.
3. **Wall-clock cap constant.** Spec recommends ≥120s pending T5. Confirm the v1 value to bake into `readTurnResult` (PR-1) — or read it from config so T5 can tune it without a code change.
4. **Large-paste path (§6 caveat).** T3 validated ≤50 lines / 1.2 KB. Coding-proxy traffic carries multi-KB pastes. Decide whether PR-2 ships `send-keys` only (with the documented ≤50-line validation) or also wires the `paste-buffer`/`load-buffer` fallback for large bodies now (recommended as a fast-follow, non-blocking for A).
5. **Preflight MCP-disable session for A.** §5.2 makes the separate-preflight `/mcp`-empty assertion a hard gate for B. Confirm whether A's canary runs it as advisory-at-startup (recommended) or skips it (relying on the per-spawn cache-dir assertion alone).

---

## Maintainer decisions — plan-review fixes + open questions RESOLVED (2026-05-30)

Plan-review verdict was **ready-with-fixes**. All anchors verified accurate. Decisions below resolve P1–P5 + the open implementation questions; the plan is now ready to implement.

| Ref | Decision |
|---|---|
| **P1 / OQ#1 — keyId/reqId plumbing** | **Reuse `isolationCtx.ephemeralRoot` + reqId.** The two existing spawn call sites (`server.mjs:1347`, `:1564`) already call `prepareIsolatedEnvironment` and pass `isolationCtx` into `spawn()`. PR-0 adds `ephemeralRoot` + `reqId` to the returned `isolationCtx`; the TUI branch reads them from there — **no new edits to the default-path call sites**, preserving the byte-for-byte-unchanged invariant. `runTuiTurn(isolationCtx, irRequest, opts)` takes `isolationCtx`, not raw keyId/reqId. |
| **P2 — reaper boot anchor** | Wire `reapOrphans()` into the real boot region: the `isMain` block at **`server.mjs:2417`** (NOT `:2334`, which is wrong; `:82` is the import). Co-locate with the existing `await bootstrapSandbox()` call. |
| **P3 / OQ#5 — A preflight `/mcp`** | **A also spawns with `--strict-mcp-config` + `--disallowedTools "mcp__*"`** (defense-in-depth — even the owner does not want a prompt-injected client reaching the owner's own Gmail/Drive). The separate preflight `/mcp`-empty session is **advisory-at-startup for A** (log a warning if managed MCP still attaches; do NOT block), and a **hard gate for B**. Decided line item for PR-2, no longer open. |
| **P4 — tier citation** | Cite accurately: manifest `owner_tier ∈ {'owner','guest'}` (`keys.mjs:143`); `'anonymous'` is a runtime fallback identity (`:439`), not a manifest tier. Cosmetic; correct the anchor table. |
| **P5 / OQ#3 — wall-clock cap** | **Config, not constant.** Read from env `CLAUDE_TUI_WALLCLOCK_MS` (default `120000`) so T5 can tune it without a code change. Baked into `readTurnResult` (PR-1). |
| **OQ#2 / OQ#5 — warm pool** | **Out of PR-0..PR-3 scope.** Initial A = per-request ephemeral session (cleanest, matches B). Warm pool is a later opt-in optimization (`CLAUDE_TUI_WARM_POOL`), process-reuse-not-context per spec §7.2, tracked separately. |
| **OQ#4 — large-paste (>50 lines)** | **Defer to fast-follow.** PR-2 ships the `send-keys -- "$(cat file)"` recipe with the documented ≤50-line / multi-KB validation from T3; the `paste-buffer`/`load-buffer` path for very large bodies is a non-blocking follow-up PR. Document the current bound in the README. |

**Net:** P1 (the one true PR-2-interface blocker) is decided = reuse `isolationCtx`. P2/P4 are anchor corrections. P3/P5 are decided line items. Warm-pool + large-paste are explicitly scoped out of the initial A deliverable. Implementation may proceed PR-0 → PR-1 → PR-2 → PR-3.

# TUI-mode implementation — session handoff (resume at PR-1)

**Written:** 2026-05-30. **Goal:** a tested, working A-path TUI-mode before 2026-06-15 (the Anthropic billing split), so that even if 6/15 blocks the proxy, there is working code + data to adjust from.

---

## 0. What TUI-mode is (one paragraph)

OLP/OCP are OpenAI-compatible HTTP proxies that spawn the `claude` CLI. Anthropic's 2026-06-15 billing split routes traffic by the `cc_entrypoint` field the CLI stamps on every request: **`cli` (genuine interactive terminal/IDE) → subscription pool; `sdk-cli` (`-p`, `--output-format`, any non-TTY invocation) → the separate Agent SDK credit pool** (Pro plans get only ~$20 of credit there → useless). TUI-mode drives `claude` in a **real interactive tmux session** (no `-p`, no `--output-format`) so it stamps `cc_entrypoint=cli`, and **reads the response from claude's native JSONL session transcript** (not a hook file). This keeps the proxy usable for Pro subscribers post-6/15. It is OPT-IN (`CLAUDE_TUI_MODE`), default stays stream-json. It is an honest grey-area bridge (genuinely interactive, but automated) — see spec §10.

---

## 1. READ THESE FIRST (in order)

All on branch **`feat/tui-mode-pr0-isolation-seed`** (which is stacked on `docs/tui-mode-design-spec`, so it contains the spec + plan + PR-0):

1. `docs/superpowers/specs/2026-05-30-tui-mode-production-design.md` — the design spec (final; 3 independent reviews + 6 spikes folded in). **Authoritative.** Do not re-litigate its decisions.
2. `docs/superpowers/plans/2026-05-30-tui-mode-A-path-implementation-plan.md` — the implementation plan (PR-0..PR-3) + the **"Maintainer decisions"** appendix at the bottom (resolves P1–P5 + open questions). **Read the appendix carefully.**
3. The committed PR-0 code (this branch's HEAD `1fd27e1`): `lib/sandbox/manager.mjs` (the `tui` param + `_seedTuiClaudeJson`), `test-features.mjs` Suite 45, `docs/adr/0002-plugin-architecture.md` § tuiSeed extension note.

---

## 2. WHERE WE ARE

```
✅ PR-0  TUI-only ISOLATION .claude.json seed   (committed 1fd27e1, pushed, 816 tests pass)
⬜ PR-1  transcript reader  lib/tui/transcript.mjs      ← START HERE
⬜ PR-2  session driver     lib/tui/session.mjs         (needs PI231 integration testing)
⬜ PR-3  provider wiring     CLAUDE_TUI_MODE branch + ADR 0016 + README
then:  OCP single-tenant canary (Deployment A) post-2026-06-15 to measure REAL billing
```

Deployment **B** (family/team multi-tenant) is DEFERRED behind spikes **T2** (body-capture proof the wire `/v1/messages` carries `tools:[]`) + **T4** (concurrency) — these are verification, not open research (T6 already found the disable mechanism). Do NOT build B in this pass.

---

## 3. VALIDATED FACTS (do NOT re-spike — already proven on PI231, claude v2.1.158)

- **S1 (PARTIAL):** `--system-prompt` keeps `cc_entrypoint=cli`. BUT account-attached managed MCP servers (the owner's Gmail/Calendar/Drive) auto-attach over the network even with empty local config — the "no-tool" property is model restraint, not enforcement. (Gates B; mitigated by T6.)
- **S2 (PASS):** read the native JSONL transcript at `<EHOME>/.claude/projects/<CWD_ENCODED>/<SESSION_ID>.jsonl` where `CWD_ENCODED` = the spawn cwd with **every `/` → `-` (including the leading slash)**, and `SESSION_ID` = the UUID you pass via `--session-id` (so YOU compute the path before spawn). The file is created lazily on first message — poll for it. Assistant text extracts escaping-clean (one `JSON.parse` per line). **Completion marker = a `{"type":"system","subtype":"turn_duration"}` line** (last line of the turn by timestamp; carries messageCount + durationMs).
- **S3 (PASS):** submission is 100% reliable IF Enter is a tmux **key token**, not a literal `\n` in text (Ink bug anthropics/claude-code#15553).
- **T1 (PARTIAL):** `turn_duration` fires for `end_turn` text turns AND refusals, but is **ABSENT on tool-use turns** (which would hang a marker-only reader).
- **T3 (PASS):** multiline/special-char prompts submit byte-for-byte via the file→send-keys recipe (§ below).
- **T6 (PASS):** `--strict-mcp-config` (with NO `--mcp-config`) gives **0** managed-MCP attachment. **Editing/seeding `.claude.json` does NOT disable MCP** (account/server-driven — negative control). Defense-in-depth: env `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1` + `--disallowedTools "mcp__*"` + (for B) `--tools ""`. Do NOT use `--bare` (breaks OAuth).

**Billing caveat (honesty):** S1 proved the `cc_entrypoint=cli` SIGNAL, NOT the actual billed pool — the split hasn't happened. The OCP canary post-6/15 is the first real billing measurement.

---

## 4. CRITICAL GOTCHAS (things that already bit us — a fresh session WILL miss these)

1. **TWO different startup dialogs — do not conflate them:**
   - **bypass-permissions** dialog ("you accept all responsibility… 1.No 2.Yes") → suppressed by `bypassPermissionsModeAccepted:true` in the seeded `.claude.json` (PR-0 does this). Its default cursor is "1.No,exit" — a naive Enter EXITS.
   - **trust-folder** dialog ("Is this a project you trust? 1.Yes 2.No") → **NOT suppressed by the seed.** Still appears for a fresh ephemeral `$HOME` (projects stripped). **PR-2's session driver MUST answer it by sending "1".** (A review-fix agent wrongly claimed bypassPermissionsModeAccepted suppresses the trust dialog — it does NOT. This was caught + corrected; do not reintroduce that claim.)
2. **Submission recipe (exact):** write the prompt body to a FILE (never interpolate into a shell command line — `$()`/backticks/`;` get mangled by the shell). Then: `tmux send-keys -t <S> -- "$(cat promptfile)"` (the leading `--` end-of-options guard is required), sleep ~1.5–2s to let Ink settle, then submit with a SEPARATE key token: `tmux send-keys -t <S> Enter`. Embedded `\n` in the body are delivered as soft line-breaks and do NOT submit. Verify submission via capture-pane (spinner / "esc to interrupt" / response bullet `●`); retry Enter (key token) up to ~4× as a defensive guard.
3. **Completion = DUAL SIGNAL (no quiescence in v1):** terminal when EITHER a `turn_duration` line appears (happy path) OR `stop_reason:"tool_use"` is seen OR a wall-clock cap fires → return a clean error, never hang. **Do NOT use "file size-stable for N seconds" as a v1 terminal signal** — a long Opus extended-thinking turn legitimately stalls transcript growth and quiescence would falsely abort it. Quiescence is a T5 follow-up only. Read all assistant `text` blocks since the matching `user` line; do NOT rely on file-tail byte ordering (write-order can differ from timestamp-order). Wall-clock cap = env `CLAUDE_TUI_WALLCLOCK_MS` (default 120000), config not constant.
4. **No `--dangerously-skip-permissions`** — we read the transcript, no tool writes, so it's not needed (this is the whole point vs PR #101's hook approach). No `--bare` (breaks OAuth).
5. **Streaming = BUFFERED.** The transcript is read AFTER the turn completes, so there is NO true token-streaming. For `stream:true`, replay the completed response as SSE chunks (one burst after the turn). The maintainer accepted this; document it in README. Do NOT try to parse the live terminal pane for token-streaming — that's the fragile path the maintainer explicitly rejected ("不做易坏的功能").
6. **max_tokens + sampling params (temperature/top_p/stop/etc.)** — interactive claude has NO flags for these; they're parsed into IR (`lib/ir/openai-to-ir.mjs:182`) and dropped at the CLI boundary today already. Graceful-drop + document; no regression.

---

## 5. PI231 (the test machine) — playbook

- SSH: `tlab@172.16.2.231` (RPi4 arm64 Debian). `claude` v2.1.158 at `~/.npm-global/bin/claude` (`export PATH="$HOME/.npm-global/bin:$PATH"`). tmux 3.3a. uuidgen / python3 available.
- **⚠️ PI231 runs PROD OLP on :4567 — DO NOT TOUCH IT.** All TUI testing is `/tmp` scratch + tmux sessions with unique names. Clean up: kill tmux sessions, `rm -rf` scratch dirs, **`shred -u` any `--debug-file`** (debug logs contain the OAuth bearer — never `cat` a full debug log; only grep specific tokens).
- Ephemeral session recipe (what PR-0's seed enables): make an ephemeral `$HOME`, symlink `~/.claude/.credentials.json` into it, seed `.claude.json` (PR-0's `_seedTuiClaudeJson` does this: strip projects, set hasCompletedOnboarding + bypassPermissionsModeAccepted), run `claude --model <m> --session-id <uuid> [--system-prompt …] [--strict-mcp-config …]` in a tmux session with cwd = ephemeral home. Answer the **trust** dialog with "1". cc_entrypoint capture: add `--debug api --debug-file <path>`, grep `cc_entrypoint=`, shred.
- The maintainer (you, with the human) handles PI231 integration testing directly — subagents are unreliable at the delicate tmux/interactive timing (it bit us; the human's accumulated context catches subagent errors).

---

## 6. THE REMAINING PRs (concrete)

Use the **plan** (`docs/superpowers/plans/...`) PR sections + Maintainer-decisions appendix as the source of truth. Summary:

### PR-1 — `lib/tui/transcript.mjs` (transcript reader) — START HERE
- Pure module, no existing-path touch. Exports a reader that, given `{ ephemeralRoot, sessionId, cwd }`, computes the transcript path (§ CWD_ENCODED formula above), polls for lazy file creation, detects completion via the **dual-signal guard** (turn_duration OR tool_use OR wall-clock cap from `CLAUDE_TUI_WALLCLOCK_MS`), extracts assistant `text` blocks since the matching `user` line, and returns a **resolved string** (the adapter to IR `[{delta},{stop}]` chunks lives in PR-3's provider branch, not here — keep PR-1 transport-agnostic).
- **Needs real JSONL fixtures captured from PI231**, especially a **`tool-use-no-marker.jsonl`** (a turn with `stop_reason:"tool_use"` and NO `turn_duration`) + an `out-of-order.jsonl` (text block flushed after turn_duration by byte). The maintainer captures these on PI231. Unit-test the reader against the fixtures; assert the non-hang throw is distinguishable from the timeout.

### PR-2 — `lib/tui/session.mjs` (session driver) — needs PI231 integration testing
- tmux transport behind a transport interface (so node-pty can slot later — but ship tmux only; node-pty stubbed). `runTuiTurn(isolationCtx, irRequest, opts)` — takes `isolationCtx` (has `ephemeralRoot` + `reqId` from PR-0), NOT raw keyId/reqId.
- Spawn flags: `--session-id <uuid>` + `--system-prompt <OLP wrapper>` + (T6) `--strict-mcp-config` + `--disallowedTools "mcp__*"` + env `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1`. (A also uses --strict-mcp-config per decision P3.)
- **Answer the trust-folder dialog (send "1")** — the seed already handles bypass. (See gotcha #1.)
- Submit via the file→`send-keys -- "$(cat file)"`→separate-Enter recipe (gotcha #2).
- Call the PR-1 reader for the response; map to single-buffered + SSE-replay for stream:true.
- **trap-guaranteed cleanup** (`finally`, not best-effort) + an **orphan-tmux-session reaper on server startup** wired into the `isMain` boot block at `server.mjs:2417` (decision P2) — tmux sessions survive restart and hold the owner OAuth.
- Preflight `/mcp`-empty verification: a SEPARATE preflight session at startup (not in a serving turn — it would corrupt the reader's matching-user-line). For A: advisory (log warn). For B: hard gate (decision P3).

### PR-3 — provider wiring
- `CLAUDE_TUI_MODE` branch in `lib/providers/anthropic.mjs` `spawn()` (~line 1164 → `_spawnAndStream`); default falls through to the untouched stream-json path. The string→IR-chunks adapter (`[{type:'delta',role:'assistant',content},{type:'stop',finish_reason:'stop'}]`) lives HERE — it fits BOTH cache consumers: `getOrCompute` (array, `server.mjs:1445`, buffered path `collectAllChunks:1299`) and `getOrComputeStreaming` (`:1587`, `sourceWithRelease:1558`) with ZERO server edits.
- New **ADR 0016** (OLP) as authority of record (interactive-mode billing lane; supersedes ADR 0009 Amd 1's billing premise). Acknowledge **PR #101 + jaekwon-park**.
- README: new env var + Troubleshooting (onboarding/OAuth-login requirement, **NO token-streaming** = buffered, max_tokens/sampling not honored) + honest grey-area framing.

---

## 7. WORKING METHOD + CONVENTIONS

- **Hybrid:** run a small workflow per PR — `implement (sonnet) → review (opus, fresh-context) → fix (sonnet) → npm test must pass`. THEN the maintainer commits + supervises PI231 integration. The maintainer's PI231 context catches subagent errors (it already caught a fabricated trust-dialog claim).
- **Branch stacking:** PR-1 branches off `feat/tui-mode-pr0-isolation-seed` (which has spec+plan+PR-0). Stack PR-2 off PR-1, etc. OR merge PR-0 to main first then branch — maintainer's call. No OLP TUI PRs are opened on GitHub yet (branches pushed only).
- **Co-author on every implementing commit:** `Co-Authored-By: jaekwon-park <insainty21@gmail.com>` (work traces to OCP PR #101) + `Co-Authored-By: Claude <model> <noreply@anthropic.com>`.
- **ALIGNMENT discipline:** provider-plugin changes cite claude CLI version (v2.1.158) + spec/ADR. Independent reviewer per Iron Rule 10. Minimum reviewable unit per Iron Rule 11.
- **Default-path-unchanged is sacred:** `CLAUDE_TUI_MODE` default off; stream-json path byte-for-byte unchanged until explicitly enabled. Reviewer must verify this for each PR.
- **Don't break `npm test`** (currently 816 pass). The `__OLP_FORCE_ISOLATION_IN_TEST` global is the seam to exercise real ISOLATION in tests (see Suite 43f / 45).

---

## 8. KEY CODE ANCHORS (verified)

- `lib/sandbox/manager.mjs`: `prepareIsolatedEnvironment` (now has `tui`/`tuiSeedSource` params + `reqId` in return + `_seedTuiClaudeJson` helper).
- `lib/providers/anthropic.mjs`: `spawn`:1164 → `_spawnAndStream`; `ISOLATION`:1667 (has tui doc comment); `buildCliArgs`:834 (passes only --model + --system-prompt today); `extractSystemPrompt`:123; `irToAnthropic`:601; `OLP_SYSTEM_PROMPT_WRAPPER`.
- `server.mjs`: spawn sites `:1347` (buffered `collectAllChunks:1299` → `getOrCompute:1445`) + `:1564` (streaming `sourceWithRelease:1558` → `getOrComputeStreaming:1587`); `irChunkToOpenAISSE`; `isMain` boot block `:2417` (reaper hook target).
- `lib/ir/openai-to-ir.mjs:182` (max_tokens parsed, dropped at CLI).
- `lib/keys.mjs`: `validateKey:414`; `owner_tier ∈ {owner, guest}` (`:143`), 'anonymous' is a runtime fallback identity (`:439`).

---

## 9. SUGGESTED FIRST MOVE in the new session

1. `git checkout feat/tui-mode-pr0-isolation-seed && git pull` (or confirm you're on it).
2. Read this handoff + the spec + the plan's Maintainer-decisions appendix.
3. Capture the PR-1 JSONL fixtures on PI231 (esp. `tool-use-no-marker.jsonl`) — drive a tool-inviting prompt under `--system-prompt` and a normal prompt; save the transcripts as test fixtures.
4. Branch `feat/tui-mode-pr1-transcript-reader` off PR-0; run the PR-1 implement→review→fix workflow against the fixtures.

**Deadline:** working A-path + PI231 integration test before 2026-06-15. ~16 days.

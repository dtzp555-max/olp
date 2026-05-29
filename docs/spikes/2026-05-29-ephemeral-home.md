# PI231 Spike — Ephemeral $HOME / $CODEX_HOME Override Verification

**Date:** 2026-05-29
**Operator:** project maintainer (via PI231 SSH)
**Spike artifact:** `tlab@172.16.2.231:/tmp/olp-spike-20260529-100243/`
**ADR context:** ADR 0014 Amendment 1 § A1.2 Layer 1 — "Per-spawn ephemeral home directory"
**Task ref:** OLP task list #4 ("PI231 spike — verify Claude / Codex HOME / CODEX_HOME override behavior")

---

## TL;DR

**Both providers PASS.** Setting `HOME` (claude) and `CODEX_HOME` (codex) before spawn redirects 100% of CLI state writes into the ephemeral location. Real `~/.claude/`, `~/.claude.json`, and `~/.codex/` were unmodified by the spike. Credentials accessed via symlink work end-to-end (model returned "PONG" for both providers). Solution 1 is implementable today; Tasks #5-#8 unblocked.

One non-blocking caveat for codex (PATH-helper installation refused under `/tmp` paths — § Caveats).

Vibe (mistral) not on PI231; pinned to a follow-up spike when the CLI is installed.

---

## 1. Environment

| Component | Value |
|---|---|
| Host | `tlab@172.16.2.231` (RPi4-P8-231, Debian Bookworm arm64) |
| Real `~` | `/home/tlab` |
| `claude` | `/home/tlab/.npm-global/bin/claude` — v2.1.152 |
| `codex` | `/home/tlab/.npm-global/bin/codex` — v0.133.0 |
| `vibe` | not installed |
| Prod OLP | running (port 4567 with `OLP_SANDBOX_DISABLED=1`) — spike does not interfere |

Pre-state mtimes (from spike `pre-mtimes.txt`):
```
1779999955 /home/tlab/.claude.json
1779999956 /home/tlab/.claude/.credentials.json
1779759544 /home/tlab/.codex/auth.json
```

Marker file timestamps (pre-spike) used to detect any post-spike write to real home.

---

## 2. Methodology

Both providers tested per the same skeleton:

```bash
SPIKE_ROOT=/tmp/olp-spike-<timestamp>
mkdir -p $SPIKE_ROOT/<provider>-home/.<provider>
ln -s ~/.<provider>/<credential-file> $SPIKE_ROOT/<provider>-home/.<provider>/<credential-file>

<ENV_OVERRIDE>=<path> timeout 90 <provider> <invocation> "say PONG and nothing else"

find $SPIKE_ROOT/<provider>-home -printf "%y %M %s %p\n"    # what landed in fake home
find ~/.<provider> ~/.<provider>.json -newer <marker>       # did real home get modified
```

The `find -newer <marker>` test is the load-bearing assertion: if it returns **empty**, the redirect held perfectly. If it returns any path, the CLI silently fell back to the real `$HOME`-derived path despite the env override.

---

## 3. Phase B — claude CLI (anthropic)

### 3.1 Invocation

```bash
HOME=$SPIKE_ROOT/claude-home timeout 60 claude \
  --print "say PONG and nothing else" \
  --no-session-persistence \
  --model claude-sonnet-4-6
```

Credentials linked: `$SPIKE_ROOT/claude-home/.claude/.credentials.json` → `/home/tlab/.claude/.credentials.json`

### 3.2 Result

```
PONG
```

Exit 0. Model returned through Anthropic API via OAuth token from the symlinked real credentials. End-to-end success.

### 3.3 Fake home post-state (decisive evidence)

Files written under `$SPIKE_ROOT/claude-home/`:

```
.claude/.credentials.json                                       (symlink — unchanged)
.claude/projects/-home-tlab/<uuid>.jsonl                        (135 bytes — project transcript)
.claude/projects/-home-tlab/memory/                             (created)
.claude/sessions/                                               (drwx------ private)
.claude/backups/.claude.json.backup.1780012965052               (50 bytes — pre-write backup)
.claude.json                                                    (23,182 bytes — fresh)
.cache/claude-cli-nodejs/-home-tlab/mcp-logs-claude-ai-Gmail/<ts>.jsonl
.cache/claude-cli-nodejs/-home-tlab/mcp-logs-claude-ai-Google-Calendar/<ts>.jsonl
.cache/claude-cli-nodejs/-home-tlab/mcp-logs-claude-ai-Google-Drive/<ts>.jsonl
```

**`.claude.json` (23 KB) was written to the ephemeral location.** This is the file whose non-atomic write upstream (anthropics/claude-code#29250) drove ADR 0014 Amendment 1 § A1.1.2. The Solution 1 architecture removes the maintenance-treadmill concern by letting this file land in tmpfs — confirmed working.

`projects/-home-tlab/` — claude encodes the spawn CWD (`/home/tlab`) by replacing `/` with `-`. Not relevant to isolation; would also be the path if claude ran with the real `$HOME`.

### 3.4 Real home post-state

```bash
$ find ~/.claude.json ~/.claude -newer $SPIKE_ROOT/marker
# (empty)

$ stat -c "%Y %n" ~/.claude.json ~/.claude/.credentials.json
1779999955 /home/tlab/.claude.json
1779999956 /home/tlab/.claude/.credentials.json
```

Both mtimes identical to pre-state. **Real `~/.claude.json` was not touched by the spike.**

### 3.5 Verdict

✅ **PASS.** claude v2.1.152 honours `HOME` env override completely. All state writes redirect to the ephemeral location. Symlinked credentials work for auth. The Layer 1 + Layer 2 architecture per ADR 0014 Amendment 1 § A1.2 is implementable for anthropic without further work.

---

## 4. Phase B — codex CLI (openai)

### 4.1 Invocation (final, working)

The first attempt used `--ask-for-approval never` per docs found in pre-spike research — that flag has been **removed in codex v0.133.0**. Help output shows it must be passed as a config override: `-c approval_policy="never"`. Retry:

```bash
echo "say PONG and nothing else" | \
  HOME=$SPIKE_ROOT/codex-home \
  CODEX_HOME=$SPIKE_ROOT/codex-home/.codex \
  timeout 90 codex exec \
    --skip-git-repo-check \
    -c approval_policy=\"never\" \
    --sandbox read-only \
    "say PONG and nothing else"
```

Credentials linked: `$SPIKE_ROOT/codex-home/.codex/auth.json` → `/home/tlab/.codex/auth.json`

### 4.2 Result

```
WARNING: proceeding, even though we could not update PATH: Refusing to create
  helper binaries under temporary dir "/tmp"
  (codex_home: AbsolutePathBuf("/tmp/olp-spike-20260529-100243/codex-home/.codex"))
Reading additional input from stdin...
OpenAI Codex v0.133.0
--------
workdir: /home/tlab
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
reasoning effort: none
reasoning summaries: none
session id: 019e710b-dc28-79f0-854a-06be116b4830
--------
user
say PONG and nothing else
...
codex
PONG
tokens used
10,826
```

Exit 0. Model invoked, returned "PONG", session id assigned.

**The `WARNING` is significant — see § 5 Caveats. Key fact:** the warning's path embed `codex_home: AbsolutePathBuf("/tmp/olp-spike-…")` proves `CODEX_HOME` was parsed and honoured. The warning is a *narrow* refusal (PATH helper binary install), not a refusal of `CODEX_HOME` itself.

### 4.3 Fake home post-state (decisive evidence)

```
.codex/auth.json                                                (symlink — unchanged)
.codex/models_cache.json                                        (200,842 bytes)
.codex/installation_id                                          (36 bytes)
.codex/cache/codex_apps_tools/<hash>.json                       (92,600 bytes)
.codex/goals_1.sqlite                                           (24,576 bytes)
.codex/logs_2.sqlite                                            (49,152 bytes)
.codex/state_5.sqlite                                           (180,224 bytes)
.codex/shell_snapshots/                                         (created)
.codex/memories/                                                (created)
.codex/skills/                                                  (created)
.codex/sessions/2026/05/29/                                     (date-partitioned)
.codex/.tmp/plugins-clone-<rand>/.git/...                       (cloned plugins repo)
```

State scale: ~500 KB across 3 SQLite DBs + model cache + plugin checkout. Far more than claude writes. **All of it landed in the ephemeral location.**

### 4.4 Real home post-state

```bash
$ find ~/.codex -newer $SPIKE_ROOT/codex-marker3
# (empty)

$ stat -c "%Y %n" ~/.codex/auth.json
1779759544 /home/tlab/.codex/auth.json
```

Mtime unchanged. **Real `~/.codex` was not touched by the spike.**

### 4.5 Verdict

✅ **PASS.** codex v0.133.0 honours `CODEX_HOME` env override for ALL state files. Symlinked auth artifact works for API authentication. The codex inner sandbox (read-only by default per ADR 0002 Amendment 9 § Per-provider codex declaration) initialized and ran without error.

---

## 5. Caveats

### 5.1 codex PATH helper warning

Codex's startup includes a step that tries to install helper binaries into PATH (presumably under `$CODEX_HOME/bin/` or similar). When `$CODEX_HOME` is under `/tmp/`, codex refuses this step for security reasons (anti-prefix-attack on PATH):

```
WARNING: proceeding, even though we could not update PATH:
  Refusing to create helper binaries under temporary dir "/tmp"
```

**Impact for OLP**: none of the load-bearing functionality is affected. The model invocation completed, auth worked, all session state landed in `$CODEX_HOME`. The skipped step is for shell-completion-style helpers that the spawn-binary architecture does not need.

**If we ever do need those helpers**: ephemeral root would need to move out of `/tmp/`. Candidates: `/var/lib/olp-spawn/<keyId>/<reqId>/` (operator-managed) or `~/.olp/spawn/<keyId>/<reqId>/` (within OLP's own data root). Decision deferred — not required for Phase 7 implementation.

### 5.2 claude project-path encoding (`-home-tlab`)

claude encodes the spawn cwd into project paths by replacing `/` with `-`. The encoded value reflects the **real cwd at spawn time** (`/home/tlab` → `-home-tlab`), not the ephemeral `$HOME`. This is expected: cwd is a separate input from `$HOME`.

**Impact for OLP**: none. The encoding is internal to claude's project tracking. OLP spawn pipeline already runs each request from a per-spawn cwd if it wants to isolate cwd separately; that is orthogonal to Layer 1's `$HOME` redirect.

### 5.3 codex v0.133.0 flag set drift

The pre-spike research cited `--ask-for-approval never` as the non-interactive approval flag (sourced from OpenAI docs pages indexed before v0.133.0 changed the flag layout). v0.133.0 instead requires `-c approval_policy="never"` via the generic config-override flag. ADR 0002 Amendment 9 § codex `toolHardeningArgs` declaration uses `--sandbox read-only` which is still a valid top-level flag; no amendment update required. **Implementation note (Task #7)**: codex.mjs `toolHardeningArgs` should not inject `--ask-for-approval` — use `-c approval_policy="never"` if the policy needs to be locked at spawn time.

### 5.4 Mistral `vibe` CLI not present on PI231

`which vibe` returned empty. Vibe is not currently part of the PI231 test deployment per the topology memory (`~/.cc-rules/memory/projects/olp/topology_pi231_server_2026_05_27.md`). The ADR 0002 Amendment 9 mistral declaration uses `VIBE_HOME` per the Mistral docs page (3 occurrences verified at amendment time). The observed-behavior verification is a follow-up spike triggered when vibe is installed.

---

## 6. Implications for ADR 0014 Amendment 1

| Architecture claim | Spike result |
|---|---|
| Layer 1 (ephemeral `$HOME` / `$CODEX_HOME`) is implementable | ✅ Confirmed for anthropic + codex |
| `~/.claude.json` upstream non-atomic-write concern is solved by redirect | ✅ Confirmed — write lands in tmpfs `.claude.json`, real one untouched |
| Layer 2 (symlinked credentials) preserves auth | ✅ Confirmed — both providers authenticated via symlink |
| codex inner sandbox composes with Layer 1 (no nested-bwrap conflict) | ✅ Confirmed — codex `--sandbox read-only` initialized and ran |
| Solution 1 obsoletes outer-bwrap maintenance treadmill | ✅ Confirmed — no `--ro-bind` mount patches required |

No architectural changes required. ADR 0014 Amendment 1 is **validated by primary-source observation on the target deployment**.

---

## 7. Unblocked / next

Tasks unblocked by this spike's PASS verdict:
- Task #5 — refactor `lib/sandbox/manager.mjs` to `prepareIsolatedEnvironment()` per Layer 1 + Layer 2
- Task #6 — add `ISOLATION` block to `lib/providers/anthropic.mjs`
- Task #7 — add `ISOLATION` block to `lib/providers/codex.mjs` (use `-c approval_policy="never"` per § 5.3, not `--ask-for-approval`)
- Task #8 — wire `prepareIsolatedEnvironment` into `server.mjs` spawn site

Follow-ups not blocking:
- Vibe spike when CLI is installed (verify documented `VIBE_HOME` behavior matches observed)
- codex PATH-helper out-of-`/tmp` consideration if the helpers ever become required

---

## 8. Artifact retention

The spike root `/tmp/olp-spike-20260529-100243/` on PI231 is automatically cleaned by tmpfs lifetime / reboot. No commit of binary artifacts. Evidence above is the canonical record.

---

**Authored** by project maintainer 2026-05-29; commands executed on PI231 with maintainer's SSH session.

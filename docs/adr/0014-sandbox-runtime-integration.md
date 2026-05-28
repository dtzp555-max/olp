# ADR 0014 — Sandbox-Runtime Integration for Multi-Tenant Provider Spawning

**Status:** Accepted (PR-A shipped; PR-B shipped pending PI231 Suite 44 validation + HTTP-path activation debug; PR-C/D pending) — **see Amendment 1 (2026-05-29): PR-B's outer-bwrap approach is superseded by the per-spawn ephemeral-home + per-provider ISOLATION contract architecture. PR-C/D are reframed; the substantive decision moves into Amendment 1.**
**Date:** 2026-05-28
**Phase:** Phase 7

---

## Related

- **ADR 0001** (Project Founding) — OLP's multi-provider rationale and "no conversation state" principle.
- **ADR 0009 Amendment 1** (stream-json transport, Phase 6) § Caveats #3: "Sandbox-runtime still required for real multi-tenant deployment."
- **ADR 0002** (Plugin Architecture) — Provider contract; `spawn()` is the surface this ADR will wrap in PR-B/C.
- **ADR 0006** (Provider Inclusion / Risk Tier Framework) — classifies providers by deployment risk; sandbox status is a gating condition for Tier-A (cloud-deployed).
- **`docs/plans/cloud-deployment-family.md` § 5** — sandbox is a hard prerequisite before any cloud rollout.
- **cc-mem incident memory** — `~/.cc-rules/memory/projects/olp/incident_2026_05_27_spawn_cli_security.md` — the multi-tenant security gap that motivates this ADR.

---

## 1. Context

### 1.1 The multi-tenant security gap

OLP is a personal-scale proxy (ADR 0001 § Non-commercial). However, the "family-scale" deployment model means multiple human callers share a single OLP instance — each with their own OLP API key (ADR 0007) but all using the same underlying `claude` or `codex` CLI installation on the server host.

The security gap, identified in the 2026-05-27 session and captured in cc-mem incident memory § 3, is:

1. **OAuth token exposure.** A malicious (or misbehaving) prompt to the Anthropic provider could elicit a `cat ~/.olp/keys/...` or similar read of any file the OLP process user can access — including the OAuth credentials file that allows the attacker to impersonate the server-side identity.
2. **Codex shell-tool execution.** The `codex exec` path exposes a shell tool to the model. With OLP acting as a relay, a prompt to codex from one client could execute arbitrary commands in the server process's working directory, reading or writing files belonging to other clients.
3. **Cross-tenant data leakage.** Even without adversarial prompts, a model that freely accesses the filesystem could inadvertently leak one client's cached context to another client's response.

The 2026-05-27 prior-art search (incident memory § 4) surveyed the multi-tenant LLM proxy ecosystem (LiteLLM, OpenCode, CLIProxyAPI, open-source Anthropic proxies) and found that **none solve multi-tenant file-system and tool isolation at the OS level**. The field's typical answer is "don't run multi-tenant" or "use a separate VM per tenant" — neither applicable at OLP's family scale.

### 1.2 Anthropic's official answer: `@anthropic-ai/sandbox-runtime`

The `@anthropic-ai/sandbox-runtime` package (Anthropic Experimental org, `anthropic-experimental/sandbox-runtime`, v0.0.52 as of this ADR) is Anthropic's open-source solution to wrapping security boundaries around arbitrary processes. It is the library that Claude Code itself uses internally to sandbox MCP servers and tool execution.

The library provides:

- **Linux:** bubblewrap (`bwrap`) namespace isolation + socat network bridge + seccomp filter via `apply-seccomp-filter` binary. Ripgrep (`rg`) is required for deny-path glob expansion.
- **macOS:** `sandbox-exec` seatbelt profile, which is a built-in OS facility (no additional packages required).

Both paths enforce filesystem read/write restrictions and network policy at the kernel level, not at the process level. A `cat ~/.olp/keys/...` inside the sandbox fails at the syscall layer regardless of what the shell or model requests.

### 1.3 The 2026-05-28 spike

A PoC spike was conducted on PI231 (arm64 Debian Bookworm) on 2026-05-28. Key findings:

1. **`npm install @anthropic-ai/sandbox-runtime@0.0.52` succeeds cleanly** on arm64 Linux. No native build step; prebuilt binaries were available.
2. **`SandboxManager.isSupportedPlatform()` returns `true`** on PI231 (Linux, not WSL).
3. **`SandboxManager.checkDependencies()` reports errors**: `bubblewrap (bwrap) not installed`, `socat not installed`, `ripgrep (rg) not found`. These are the three OS-level deps that must be installed separately (not bundled in the npm package).
4. **The install fix is a one-liner**: `sudo apt-get install -y bubblewrap socat ripgrep`. This is a 5-minute operational task, not a code change.
5. **Three PoC scripts** were parked at `/tmp/sandbox-spike/` on PI231 verifying: dependency check return shapes, `SandboxManager.wrapWithSandbox` call signature, and filesystem-deny path behaviour.

Verdict: **YELLOW** — architecturally green (the library works and the platform is supported), operationally blocked on apt deps. PR-A lays the dependency + doctor layer. PR-B wraps the anthropic spawn after apt install.

---

## 2. Decision

### 2.1 Layered rollout (Iron Rule 11 — minimum reviewable unit)

The sandbox integration is split into four discrete PRs, each independently reviewable and independently safe to land or revert:

| PR | Scope | Blocking condition | Status |
|---|---|---|---|
| **PR-A** (this PR) | npm dep `@anthropic-ai/sandbox-runtime ^0.0.52` + `lib/sandbox/doctor.mjs` (preflight module) + `/health` `sandbox` field + ADR 0014 | None — no runtime initialization | ✅ Accepted |
| **PR-B** | `lib/sandbox/manager.mjs` (bootstrap + spawn-wrap) + `lib/providers/anthropic.mjs` spawn wrapped + server startup wiring + `/health.sandbox.active` + Suite 43/44 tests | `bubblewrap` + `socat` + `rg` installed on PI231 (`sudo apt-get install -y bubblewrap socat ripgrep`) | ✅ Implemented — pending PI231 validation (Suite 44) + opus reviewer |
| **PR-C** | `lib/providers/codex.mjs` spawn wrapped with `enableWeakerNestedSandbox: true` | PR-B accepted + codex PoC on PI231 | 🔲 Blocked on PR-B |
| **PR-D** | `docs/plans/cloud-deployment-family.md` § "Phase 7 prerequisite met" update; cloud rollout unblocked | PR-B + PR-C accepted | 🔲 Blocked on PR-C |

Rationale for the split:

- **PR-A is safe without bwrap.** The doctor module and `/health` field add observability with no runtime side effects. No `SandboxManager.initialize()` call. No sandbox spawned.
- **PR-B is the load-bearing security gate.** Wrapping `anthropic.mjs` spawn requires empirical negative-test confirmation (in-sandbox `cat ~/.olp/keys/...` MUST fail). This cannot be verified until PI231 has bwrap installed.
- **PR-C follows PR-B** because codex has a distinct issue: codex itself uses bubblewrap internally (`codex exec` spawns its own sandbox). `enableWeakerNestedSandbox: true` is required to allow the inner sandbox to function inside the outer OLP sandbox.
- **PR-D is documentation-only** and depends on the runtime PRs being proven in production.

### 2.2 PR-A specific scope (binding)

PR-A MUST NOT include:

- Any call to `SandboxManager.initialize()` (no real sandbox created)
- Any modification to `lib/providers/anthropic.mjs`, `lib/providers/codex.mjs`, or `lib/providers/mistral.mjs`
- Any new HTTP endpoint (no `/metrics`, no new dashboard endpoint)
- Any modification to `models-registry.json`

PR-A MUST include:

- `package.json` dependency: `"@anthropic-ai/sandbox-runtime": "^0.0.52"`
- `lib/sandbox/doctor.mjs`: pure preflight module (no state; no initialization)
- `/health` response: top-level `sandbox` field (`available`, `missing`, `platform`, `message` when unavailable)
- `docs/adr/0014-sandbox-runtime-integration.md` (this document)
- `CHANGELOG.md` Unreleased entry
- `test-features.mjs` Suite 42 (8 new tests, all passing)

---

## 3. `lib/sandbox/doctor.mjs` design

### 3.1 Exports

```javascript
// Returns { available: boolean, missing: string[], details: { ... } }
export async function checkSandboxAvailability() { ... }

// Returns { ok: boolean, message: string } — human-readable summary
export async function describeSandboxStatus() { ... }
```

### 3.2 `checkSandboxAvailability` algorithm

1. Probe OS deps independently via `child_process.execFileSync('which', [binary])`:
   - `bwrap` (Linux only — macOS uses built-in `sandbox-exec`)
   - `socat` (Linux only)
   - `rg` (ripgrep — Linux only; macOS seatbelt profiles use regex patterns natively)
2. Call `probeLibrary()` which `import()`s `@anthropic-ai/sandbox-runtime` and calls:
   - `SandboxManager.isSupportedPlatform()` — platform classification
   - `SandboxManager.checkDependencies(undefined)` — library's own dep check (called without initialize, falling back to PATH lookup)
3. Compute `missing[]`: on Linux, add 'bubblewrap', 'socat', 'ripgrep' for each absent dep; if library import failed, add that too.
4. `available = libLoaded && isSupportedPlatform && missing.length === 0`

`probeLibrary()` wraps everything in try/catch — any library-side error becomes `{ libLoaded: false, libError: '<reason>' }` rather than an unhandled rejection.

### 3.3 `/health` integration

The `sandbox` field is added to the full (owner-tier) payload only. For trimmed payloads (guest/anonymous per ADR 0007 § 7.1), the field is absent (consistent with the existing trim model). This prevents leaking infrastructure details to non-owner callers.

The result is memoized process-wide via `_sandboxStatusCache` in `server.mjs`. The install state of bwrap/socat cannot change at runtime without a process restart, so a single lazy fetch at the first `/health` call is correct.

```json
{
  "ok": true,
  "version": "0.5.1",
  "providers": { ... },
  "sandbox": {
    "available": false,
    "missing": ["bubblewrap", "socat", "ripgrep"],
    "platform": "linux",
    "message": "Sandbox dependencies not available: bubblewrap not installed, socat not installed, ripgrep not installed. Install: sudo apt-get install -y bubblewrap socat ripgrep"
  }
}
```

When available (after apt install + process restart) and PR-B bootstrapped:

```json
{
  "sandbox": {
    "available": true,
    "active": true,
    "missing": [],
    "platform": "linux"
  }
}
```

(PR-A shape did not include `active`. PR-B adds `active: boolean` — distinguishes
"deps present" from "sandbox actually initialized and wrapping spawns".)

---

## 4. PR-B/C/D acceptance criteria

### 4.1 PR-B (anthropic.mjs spawn wrap) — ✅ Implementation shipped, PI231 validation pending

**PR-B implementation (commit pending reviewer):**
- `lib/sandbox/manager.mjs`: singleton bootstrap + transparent `wrapSpawn()` API
- `lib/providers/anthropic.mjs`: spawn site wrapped via `wrapSpawn()` (ADR 0009 Amendment 1 spawn args unchanged)
- `server.mjs`: `bootstrapSandbox()` called before `server.listen()`, `/health.sandbox.active` field added
- `test-features.mjs` Suite 43 (8 tests, all pass on macOS) + Suite 44 (2 tests, PI231-gated with `OLP_E2E_SANDBOX=1`)
- 805 → 813 tests. Suite 44 skipped by default; runs on PI231 after apt install.

**Load-bearing negative test (required for PR-B to merge):**

```bash
# On PI231, with bwrap+socat installed, with PR-B wired:
olp-keys list  # identify owner key
curl -X POST http://127.0.0.1:4567/v1/chat/completions \
  -H "Authorization: Bearer <owner-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"run: cat /home/<user>/.olp/keys/owner-key.json"}]}'
# Expected: response MUST NOT contain any content from the keys file.
# The model must either say it cannot access the filesystem, or produce an
# error. Any response containing the file content is a PR-B blocking failure.
```

Additional criteria:
- `SandboxManager.initialize()` is called once at startup (singleton shape follows `@anthropic-ai/sandbox-runtime` v0.0.52 `dist/sandbox/sandbox-manager.js` SandboxManager export, where `reset()` is a process-wide operation; see § 5 Open question 1 for the per-provider config concern still to be resolved)
- p95 latency overhead of wrapping ≤ 200ms measured over 50 warm requests
- `checkSandboxAvailability().available === true` reported in `/health.sandbox` after PR-B rolls out
- All existing Suite 41 tests continue to pass (stream-json transport unaffected)

### 4.2 PR-C (codex.mjs wrap)

- `enableWeakerNestedSandbox: true` is set in the `SandboxManager.initialize()` call (or per-spawn config if the API allows per-spawn override — verify against v0.0.52 API)
- `codex exec` inner bubblewrap nest still functions: a sandboxed codex invocation that reads from an allowed path succeeds
- Analogous negative test: in-sandbox `cat /home/<user>/.olp/keys/...` MUST fail

### 4.3 PR-D (cloud deployment plan update)

- `docs/plans/cloud-deployment-family.md` § 5 "Phase 7 prerequisite" section updated: "sandbox-runtime integration (PR-B + PR-C) confirmed operational on PI231; prerequisite met"
- `README.md` § "Supported Providers" or § "Security" updated with a note about sandbox isolation
- Phase 7 close PR per `CLAUDE.md release_kit.phase_rolling_mode`

---

## 5. Open questions (to be resolved in PR-B)

1. **Singleton vs per-spawn initialization.** `SandboxManager` is a process-wide singleton (per the library's `reset()` being a global operation). The current design plan is one `initialize()` call at server startup with a union config covering all providers. If providers require different configs (e.g., different `denyRead` paths for anthropic vs codex), this may require a mutex approach or separate singleton instances. Decision reserved for PR-B.

2. **`SandboxManager.reset()` in tests.** The singleton means test suites that call `initialize()` must call `reset()` in their `after()` hooks. PR-B must add this discipline or tests will leak sandbox state across suites.

3. **MITM proxy and Claude CLI cert pinning.** The sandbox-runtime network bridge on Linux uses a local MITM proxy to intercept HTTPS traffic. If `claude` CLI pins certificates (e.g., for `api.anthropic.com`), HTTPS through the bridge may fail. PR-B must empirically verify this on PI231 before merging.

4. **macOS `sandbox-exec` profile content.** macOS uses a seatbelt (SBPL) profile, not bwrap. The profile must explicitly allow `network outbound "api.anthropic.com"` etc. The default profile may be too restrictive for the Claude CLI's OAuth refresh calls. PR-B must test macOS as well as Linux.

5. **`getDefaultWritePaths()` output.** The library exports `getDefaultWritePaths()` which returns the paths the sandbox always allows writing to. OLP's spawn directory may not be in that list — PR-B must verify the working directory is writable or pass it explicitly in `filesystem.allowWrite`.

---

## 6. Pitfalls inherited from the spike (binding warnings for PR-B/C authors)

These were confirmed empirically or inferred from the library source during the 2026-05-28 spike:

1. **Three OS deps, not one.** The npm package bundles nothing. Linux requires: `bubblewrap` (bwrap), `socat`, `ripgrep` (rg). All three. Missing even one → `checkDependencies()` returns errors → `wrapWithSandbox` will fail at runtime.

2. **Linux deny-paths are literal, not glob.** The library's `linuxGetMandatoryDenyPaths()` uses ripgrep to expand glob patterns to concrete paths before passing them to bwrap. But custom `filesystem.denyRead` entries that contain glob chars (`~/.ssh/*`) must be either expanded manually OR passed as the glob form (the library expands them if `rg` is available). The safe convention for PR-B: use absolute literal paths (e.g., `/home/<user>/.ssh`) rather than `~/`-prefixed or glob paths.

3. **`enableWeakerNestedSandbox: true` is required for codex.** Codex's `exec` subcommand spawns its own bubblewrap sandbox internally. Without `enableWeakerNestedSandbox`, the outer OLP sandbox blocks the inner codex sandbox from creating user namespaces. The flag loosens the outer sandbox's seccomp filter specifically to allow `clone(CLONE_NEWUSER)` — the inner sandbox then runs with reduced but non-zero isolation.

4. **`SandboxManager.reset()` is process-wide.** Calling `reset()` anywhere (including test teardown) clears the singleton config. Any concurrent in-flight spawn that still holds a reference to the old sandbox state will break. PR-B's design must either (a) initialize once at boot and never reset, or (b) use a mutex to prevent concurrent init/reset.

5. **MITM CA generation is async and expensive.** `SandboxManager.initialize()` generates a self-signed CA certificate for the MITM proxy on Linux. This takes ~100-500ms. Initialize at server startup, not per-request.

---

## 7. Authority citations

- **`@anthropic-ai/sandbox-runtime` v0.0.52** — https://github.com/anthropic-experimental/sandbox-runtime
  - `dist/sandbox/sandbox-manager.js` — `isSupportedPlatform()`, `checkDependencies()`, `SandboxManager` export shape
  - `dist/sandbox/linux-sandbox-utils.js` — `checkLinuxDependencies()`, `whichSync` usage, `enableWeakerNestedSandbox` rationale
  - `README.md` — installation prerequisites, platform support matrix

- **2026-05-28 PoC spike on PI231 (arm64 Debian Bookworm)** — report at `/tmp/sandbox-spike/report.md` on PI231. Key findings: dep install clean; `isSupportedPlatform()=true`; `checkDependencies()` errors on bwrap+socat+rg absence; three PoC scripts parked. Verdict YELLOW.

- **cc-mem incident memory 2026-05-27** — `~/.cc-rules/memory/projects/olp/incident_2026_05_27_spawn_cli_security.md` § 3 (gap description), § 4 (prior-art search showing ecosystem hasn't solved multi-tenant fs/tool isolation).

- **OLP ADR 0009 Amendment 1 § Caveats #3** — "Sandbox-runtime still required for real multi-tenant deployment. Per the 2026-05-27 session prior-art search, Anthropic's official multi-tenant answer is `@anthropic-ai/sandbox-runtime` (OS-level isolation)."

- **`docs/plans/cloud-deployment-family.md` § 5** — sandbox is a hard prerequisite before any cloud deployment.

- **OLP ALIGNMENT.md** — PR-A is library/doctor/governance; it does not touch provider plugins, the entry surface, or the IR. The authority citation for the npm dep is the official sandbox-runtime repo URL + the spike report (not a provider CLI, not the OpenAI spec, not an existing ADR — this is a new dependency decision, which is the correct scope for ADR 0014).

- **Iron Rule 11 (Incremental Diff Review)** — splits non-trivial work into the minimum reviewable unit. The 4-PR split (A/B/C/D) is the direct application of this rule to the sandbox integration: each PR is independently reviewable, independently safe to land or revert, and corresponds to one logical layer.

---

## 8. Consequences

### Positive

- **Multi-tenant isolation at the OS level.** After PR-B+C land, each provider spawn runs inside a bubblewrap (Linux) or sandbox-exec (macOS) boundary. A prompt-injected `cat ~/.olp/keys/...` hits a kernel-level deny. Cross-client filesystem leakage is structurally prevented, not just mitigated by prompt engineering.

- **Cloud deployment unblocked.** `docs/plans/cloud-deployment-family.md` § 5 cites sandbox as the hard prerequisite for moving from family-LAN to cloud. PR-D closes this gate.

- **Observability from day one.** The `/health.sandbox` field makes the install state machine-readable. Any monitoring script or dashboard can tell whether sandbox isolation is active without SSH access.

- **Anthropic's official library.** Using `@anthropic-ai/sandbox-runtime` rather than a home-grown bwrap wrapper means OLP inherits Anthropic's tested integration patterns (deny-path expansion, MITM proxy, seccomp, macOS seatbelt profiles) rather than reinventing them. When the library updates, OLP upgrades via `npm update`.

### Negative

- **Three new OS-level dependencies.** `bubblewrap`, `socat`, and `ripgrep` must be installed on every host running OLP with sandbox isolation active. Absent these deps, sandbox is unavailable (but OLP continues to function without isolation — degraded security, not degraded functionality). The `/health.sandbox.available` field makes this state explicit.

- **p95 latency overhead.** The spike did not measure sandbox wrapping overhead directly (blocked on apt install). Expected overhead per the sandbox-runtime README: ~100-200ms for sandbox initialization amortized over the process lifetime (one-time at startup); per-spawn overhead is the namespace clone + filesystem mount overhead, typically <50ms on modern kernels. PR-B's acceptance criteria gates on ≤200ms p95 overhead over 50 warm requests.

- **Codex inner-sandbox degradation.** `enableWeakerNestedSandbox: true` loosens the outer OLP sandbox's seccomp filter to allow `clone(CLONE_NEWUSER)`. The codex inner sandbox still runs with meaningful isolation (its own namespace, its own deny-list), but the combined depth of protection is less than ideal compared to a world where codex didn't self-sandbox.

- **Library is experimental.** The `anthropic-experimental` org signals this is not a production-stable API. The version pin (`^0.0.52`) provides a minor-range buffer but the API surface may change. If the library is deprecated or the API breaks, OLP's fallback is to remove the sandbox wrapping (reverting PRs B-D) until a replacement path is found. This is acceptable at family scale — security degradation is not a service outage.

### Reversibility

- **PR-A** is trivially reversible: `npm uninstall @anthropic-ai/sandbox-runtime` + delete `lib/sandbox/doctor.mjs` + revert server.mjs and CHANGELOG changes. No production behavior changes.
- **PR-B/C** are reversible by removing the `SandboxManager.wrapWithSandbox` call from each provider's `spawn()` method. The spawn falls back to the current unsandboxed path.
- **PR-D** is a documentation update; reverting it is a docs-only change.

---

## Status transitions

- 2026-05-28 — Created. Status: Accepted for PR-A scope. PR-B/C/D pending operational prereqs.
- 2026-05-28 — PR-A shipped (commit `07d9c8a`).
- 2026-05-28 — PR-B implementation shipped (commit chain `d0dcd28` → `2864275` → `497b255` → `b1e24b7` → `3551921`). Status: shipped pending PI231 Suite 44 validation + HTTP-path activation debug. `OLP_SANDBOX_DISABLED=1` emergency disable installed (b1e24b7) because the in-process MITM proxy interaction with OLP's HTTP request handler suppressed claude stdout on the HTTP path while the same wrap script produced output when invoked directly from a manual shell. Prod is currently running with `OLP_SANDBOX_DISABLED=1` set.
- 2026-05-29 — **Amendment 1 — supersede PR-B outer-bwrap with ephemeral-home + per-provider ISOLATION contract.** See § Amendment 1 below. PR-B's `lib/sandbox/manager.mjs` outer-bwrap implementation is archived to branch `phase-7-pr-b-outer-bwrap-snapshot` and superseded; PR-C is reframed as inner-sandbox preservation under the new architecture; PR-D is reframed as the README "Security Model" section. `lib/sandbox/doctor.mjs` is preserved unchanged.

---

# Amendment 1 — Supersede PR-B outer-bwrap with ephemeral-home + per-provider contract (2026-05-29)

- **Date:** 2026-05-29
- **Status:** Accepted (governance only — the implementation refactor lands in subsequent PRs per ALIGNMENT.md Rule 1 / Iron Rule 11)
- **Author:** project maintainer (with AI drafting assistance)
- **Reviewer:** independent fresh-context reviewer per Iron Rule 10 — pending at this draft
- **Scope:** This amendment supersedes the implementation strategy of PR-B (the outer-bubblewrap-wrap of `claude` CLI shipped in commits `d0dcd28` → `b1e24b7`). It does NOT supersede the multi-tenant security gap analysis in § 1 of the original ADR, nor the four-tier authority citation list (§ 7), nor `lib/sandbox/doctor.mjs` (preserved unchanged). It DOES supersede the PR-B implementation, the PR-C scope ("wrap codex spawn in the same outer-bwrap pattern with `enableWeakerNestedSandbox`"), and PR-D's framing as "documentation update for cloud rollout unblock".

---

## A1.1 — Why the substitution is forced (the four forcing reasons)

PR-B as designed (outer-bwrap wrapping of the `claude` CLI spawn, with the OLP server initializing `SandboxManager` once at boot and every spawn routed through `wrapWithSandbox`) was shipped on 2026-05-28 and disabled on the same day via the `OLP_SANDBOX_DISABLED=1` env-var gate after the HTTP-path activation regression appeared on PI231 (the manual-shell wrap produced claude stdout; the OLP HTTP-request-handler wrap produced none). The 2026-05-28/2026-05-29 follow-up investigation found that the HTTP-path failure was not the whole story — even if the in-process MITM proxy lifecycle issue were debugged, four independent and load-bearing reasons forced the architecture away from outer-bwrap entirely. Each is cited to its primary authority below.

### A1.1.1 — Forcing reason #1: Anthropic's stated design intent for `@anthropic-ai/sandbox-runtime`

The PR-B design used `@anthropic-ai/sandbox-runtime` to wrap the `claude` CLI from the outside. Anthropic's published design intent for the library is the opposite direction of containment: the library is for sandboxing what Claude Code itself *triggers* (tool calls, MCP servers, sub-processes spawned during model execution), not for wrapping Claude Code from outside.

**Primary citation:** https://www.anthropic.com/engineering/claude-code-sandboxing — "Claude Code sandboxing" engineering blog. The post describes Claude Code's *internal* use of the sandbox-runtime library: the model emits a `tool_use` Bash call → Claude Code wraps the resulting `/bin/sh -c <…>` in a sandbox via `SandboxManager.wrapWithSandbox()` before spawning. The blog also notes the library "can be used to sandbox arbitrary processes, agents and MCP servers" — i.e., it is general-purpose, not Claude-Code-internal-only. **Our reading:** Anthropic's documented and demonstrated usage is *inner-wrap by Claude Code*; outer-wrap of `claude` itself is not documented in the blog and not shown in the post's example invocations. **This is a project-design judgment based on the absence of outer-wrap precedent, not a "don't do this" statement from Anthropic.** The architectural concerns enumerated below (MITM proxy lifecycle, semver leverage) stand on their own merits regardless of how Anthropic frames the library's intended usage.

**What this means for PR-B's design:** wrapping `claude` from outside with the same library is "out-of-distribution" usage. The library was not designed for, tested against, or documented for the outer-wrap case. Two concrete consequences observed in PR-B:

1. **MITM proxy collision.** The library starts a per-process local MITM proxy on Linux to inspect HTTPS traffic for allowlisted domains. When the same library is invoked again from inside the sandboxed process (e.g., for any sub-spawn `claude` might do), a second MITM proxy attempt collides. The PR-B implementation never reached this case because it disabled before tripping it, but the architecture invites the collision.
2. **Inner-sandbox conflict** (see A1.1.3 for codex, but the principle applies generally). Any CLI that itself uses the same library to sandbox its own tool calls is *expected* by Anthropic to be the *holder* of the sandbox, not the *content* of one. The library's `enableWeakerNestedSandbox` option exists precisely to acknowledge this — but only as a partial mitigation.

The Anthropic design-intent reason is not a "won't work" reason. The PR-B outer-bwrap path did work for the smoke case (manual-shell invocation produced output). The reason is a *don't-do-this* reason: OLP would be the only known user of the library in the outer-wrap configuration, taking on the maintenance burden of a usage pattern Anthropic doesn't test, doesn't document, and doesn't owe semver discipline for. The library is `^0.0.52`. A future minor version bump could break OLP's outer-wrap path without warning. Aligning OLP's use of the library with Anthropic's documented design intent restores semver leverage.

### A1.1.2 — Forcing reason #2: The `~/.claude.json` upstream "closed as not planned" — permanent maintenance treadmill for outer-bwrap

Anthropic's `claude` CLI persists session state (most notably MRU project list, last-used model, telemetry session id) to `~/.claude.json` using a **non-atomic** write pattern: write-in-place rather than write-temp-then-rename. When `~/.claude.json` is on a read-only mount (e.g., `--ro-bind ~/.claude` in a bwrap config), the CLI either silently degrades (some state lost) or outright fails depending on which write path is hit on a given invocation.

The OLP outer-bwrap path in PR-B mounted `~/.claude` read-only initially, hit this exact issue (the 2026-05-28 fold-in commit `2864275` "allow read ~/.claude + skip wrap under test mock" added the read allowance), and then on the further `b1e24b7` commit the operator had to widen the mount again. The fold-in commit message explicitly notes: "~/.claude is NOT in denyRead. It contains the spawn's own OAuth credentials — claude CLI must read its own auth file to function. Denying read here causes 'Not logged in' failures."

**Primary citation:** https://github.com/anthropics/claude-code/issues/29250 — upstream issue requesting atomic-write semantics for `~/.claude.json`. Status: closed `not_planned` by GitHub's inactivity bot on 2026-03-31 (`closed_by: github-actions[bot]`, comment text: "Closing for now — inactive for too long"), labeled `duplicate` and `stale`. **No upstream Anthropic maintainer comment in the thread articulates any policy rationale** — the only non-bot comments are the reporter's own follow-ups and a third-party-tool plug. The closure does NOT establish "won't fix" as Anthropic policy; at most it establishes that the issue has not received maintainer engagement and that Anthropic considers it a duplicate of some other tracked report. The forcing argument for ephemeral-home over outer-bwrap rests on the architectural-cost analysis (the maintenance-treadmill description below), not on an alleged upstream policy posture.

**What this means for the outer-wrap maintenance treadmill:** Every future addition of `claude`-CLI-owned state files (telemetry, cache directories, session locks, MCP registration files, etc.) is, by upstream policy, free to use any write pattern the maintainers prefer. The outer-bwrap pattern requires OLP to track each of these additions and add corresponding `--ro-bind` / `--rw-bind` / write-allowlist entries — forever — because the CLI does not give OLP an enumerable contract surface for "files I will write to." The maintainer-time cost is a permanent recurring tax.

A non-outer-wrap approach that gives `claude` a fresh, ephemeral home directory inverts this: `claude` is free to invent any state file under its $HOME with any write pattern it chooses; OLP never tracks the list. The treadmill goes away. This is the load-bearing case for Solution 1 even setting aside the codex inner-sandbox issue below.

### A1.1.3 — Forcing reason #3: Codex inner-bwrap conflict (multi-provider forcing function)

The PR-C plan in the original ADR was to wrap the `codex` spawn in the same outer-bwrap pattern as PR-B, with `enableWeakerNestedSandbox: true` set on the `SandboxManager.initialize()` call to allow codex's own internal bubblewrap sandbox to function inside OLP's outer bubblewrap sandbox.

Empirical investigation (2026-05-29 PI231 prep — to be confirmed in Task #4) and published codex CLI behaviour both indicate this nested-sandbox path is structurally fragile:

**Primary citation:** https://github.com/openai/codex/issues/16018 — upstream codex CLI issue. The issue body documents that codex's bwrap-based default sandbox **fails outright** in environments lacking unprivileged user namespaces — the reporter quotes the error `bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces`. The issue is a **feature request by the reporter** asking codex to "suggest or automatically fall back to an alternative supported backend when available"; **the issue body itself does NOT contain the string `danger-full-access` and does NOT document an existing automatic fallback to it**. The codex `--sandbox danger-full-access` mode is a documented *manual* opt-out (https://developers.openai.com/codex/concepts/sandboxing § "Sandboxing modes"). Whether codex automatically degrades into it under nested-bwrap failure — or whether the spawn aborts outright — is an empirical question slated for Task #4 PI231 spike verification.

In other words: wrapping codex in OLP's outer bwrap, *if* the outer bwrap is configured with sufficient capability to allow the inner clone, requires giving the outer sandbox more capability than the security boundary should grant. *If* it is configured to a tighter, safer capability set, codex's inner-bwrap initialization fails (the documented failure mode per the linked issue). Whether codex then aborts the spawn or silently degrades to `danger-full-access` is empirically open (Task #4); either outcome is undesirable. The strict-additive-isolation invariant (outer-bwrap + inner-bwrap = composed isolation) does not hold for codex under this configuration: either OLP gives up outer-isolation strength to admit the inner clone, or codex's inner isolation breaks in some manner.

**What this means as a multi-provider forcing function:** OLP is by constitution (ADR 0001 § Mission) a multi-provider proxy. The outer-bwrap architecture cannot cover codex without a security regression. The structural response is to abandon outer-bwrap as the foundational architecture and adopt a strategy that is *compatible* with each provider's own native isolation (claude's lack of inner sandbox vs codex's `--sandbox read-only` inner sandbox). This is what Solution 1 does — see A1.2 below.

### A1.1.4 — Forcing reason #4: `CODEX_HOME` exists and is the documented relocation lever

The "ephemeral home directory per spawn" component of Solution 1 (A1.2 Layer 1) only works if each provider CLI offers a documented mechanism for relocating its state directory away from the default `$HOME` location. For `claude`, the standard `HOME` env var works (the CLI reads `~/.claude` as `$HOME/.claude`, and changing `HOME` relocates the lookup). For `codex`, the equivalent lever is the `CODEX_HOME` env var.

**Primary citation:**
- https://developers.openai.com/codex/config-reference — OpenAI's published codex CLI configuration reference. The page documents `CODEX_HOME` in 2 places (verified by independent fetch 2026-05-29): as the root of the per-profile config path (`$CODEX_HOME/profile-name.config.toml`) and as the default log directory base (`$CODEX_HOME/log`). The variable is the documented relocation lever for the codex state, configuration, and authentication directory away from the default `~/.codex`.
- Secondary corroboration:
  - https://developers.openai.com/codex/auth/ — OpenAI's published codex CLI authentication reference. The page documents `CODEX_HOME` in 2 places (verified by independent fetch 2026-05-29), both in the credential-storage section: "file stores credentials in `auth.json` under `CODEX_HOME` (defaults to `~/.codex`)." Confirms `CODEX_HOME` is the credential-directory base.
  - https://codex.danielvaughan.com/2026/04/08/codex-cli-configuration-reference/ — third-party reference page that mirrors the documented behaviour, used as cross-reference for the reachability check.

**What this means for Solution 1 feasibility:** All three Tier-D providers have a documented one-env-var relocation lever:
- claude via `HOME` (POSIX convention)
- codex via `CODEX_HOME` (citations above)
- mistral via `VIBE_HOME` per https://docs.mistral.ai/mistral-vibe/terminal/configuration (3 occurrences verified 2026-05-29, including the canonical `export VIBE_HOME="/path/to/custom/vibe/home"` example and an enumeration of files/directories `VIBE_HOME` affects).

The ephemeral-home approach is implementable today; it does not require upstream changes from any of Anthropic, OpenAI, or Mistral. Task #4 PI231 spike verifies *observed CLI behaviour* matches *documented behaviour* for each provider — this is verification-grade follow-up, not authority-pin work.

---

## A1.2 — The substitute architecture: per-spawn ephemeral home + per-provider ISOLATION contract

The new architecture is layered. Each layer addresses a distinct attack surface, and each layer is independently reasoned about, independently reviewable, and independently revertible. The four layers, in order of containment depth:

### A1.2.1 — Layer 1: Per-spawn ephemeral home directory

Every uncached `/v1/chat/completions` request (per-`keyId`, per-`reqId`) provisions a fresh ephemeral home directory at `/tmp/olp-spawn/<keyId>/<reqId>/home/`. The directory is created on the spawn path and torn down (best-effort) on response completion. The spawn process gets this directory passed in via a per-provider env-var override:

- **anthropic** (`claude` CLI): `HOME=/tmp/olp-spawn/<keyId>/<reqId>/home`. The CLI's `~/.claude.json` and `~/.claude/` state writes go to the ephemeral location. No cross-request, no cross-tenant carry-over.
- **openai** (`codex` CLI): `CODEX_HOME=/tmp/olp-spawn/<keyId>/<reqId>/home/.codex`. Codex's `~/.codex` state, auth artifacts, and config files go to the ephemeral location.
- **mistral** (`vibe` CLI): `VIBE_HOME=/tmp/olp-spawn/<keyId>/<reqId>/home/.vibe` per https://docs.mistral.ai/mistral-vibe/terminal/configuration (documented env var, 3 occurrences verified at amendment time). Vibe's `~/.vibe/` state — `.env`, `agents/`, `prompts/`, `skills/`, `tools/`, `config.toml` — goes to the ephemeral location. Task #4 PI231 spike verifies observed CLI behaviour matches the documented contract.

Layer 1 provides:
- **No cross-tenant state carry-over** at the filesystem level. Two clients invoking anthropic concurrently get two separate `$HOME` directories; the CLI cannot read the other's `~/.claude.json`, recent-projects list, or session state.
- **No accumulation of stale state** across requests. The MRU project list does not grow without bound. The telemetry session id is fresh per request.
- **No outer-wrap maintenance treadmill.** When `claude` invents a new state file under `~/.claude.foo.json` next quarter, OLP does not need to update a `--ro-bind` list. The new file lives in the ephemeral home and goes away with the request.

What Layer 1 does NOT provide:
- It does not protect against the CLI walking *out of* its $HOME to read other paths (e.g., a model emitting a `Read` tool call on `/etc/passwd` or `~/.ssh/id_rsa`). For that protection, Layers 3 and 4 are needed.

### A1.2.2 — Layer 2: Symlinked credential files into the ephemeral home

A fresh `$HOME` is empty. The CLI needs its OAuth credentials, API key, or equivalent auth artifact to function. Layer 2 provisions these by reading the operator-pinned credential location and symlinking the relevant file(s) into the ephemeral home at the location the CLI expects.

Each provider plugin declares its credential paths in the ISOLATION block (see ADR 0002 Amendment pending). The runtime spawn pipeline reads this declaration, walks the list, and symlinks each entry from its real location (under the operator's real `$HOME`) into the ephemeral home. The symlinks are file-level, not directory-level, so the CLI sees its credential file but does not see the rest of the operator's `~/.claude/` or `~/.codex/` tree.

Example (anthropic):
- Real: `~/.claude/.credentials.json` (operator's actual OAuth credential)
- Ephemeral: `/tmp/olp-spawn/<keyId>/<reqId>/home/.claude/.credentials.json` (symlink → real)

Example (codex):
- Real: `~/.codex/auth.json`
- Ephemeral: `/tmp/olp-spawn/<keyId>/<reqId>/home/.codex/auth.json` (symlink → real)

Layer 2 provides:
- **Credential availability** without granting visibility into other state under the same provider directory.
- **A narrow declared surface.** The provider plugin enumerates exactly which files matter. New CLI state files that are not declared do not get symlinked, and the CLI re-initializes them in the ephemeral home (which is exactly the Layer 1 behaviour).

What Layer 2 does NOT provide:
- It does not protect against the CLI walking out of its $HOME (see Layer 3).
- It does not protect against the CLI's tool-use surface reading the symlink target's *containing directory* if the model emits a `Read` tool call with an absolute path that resolves around the symlink. For that, Layer 3 + Layer 4.

### A1.2.3 — Layer 3: Optional `sandbox-runtime` per-call `customConfig` for non-$HOME read protection

For providers whose own inner sandbox does NOT exist or does not cover the OLP threat model (the `claude` CLI today is the leading example — claude has no inner sandbox; codex has `--sandbox read-only` by default but the protection scope differs), Layer 3 wraps the spawn in `@anthropic-ai/sandbox-runtime`'s `SandboxManager.wrapWithSandbox()` *per-call* with a `customConfig` argument tailored to the per-spawn ephemeral home.

The key architectural difference vs PR-B's outer-wrap:
- PR-B initialized `SandboxManager` once at server boot with a *global* config covering all providers.
- Layer 3 calls `wrapWithSandbox()` *per spawn* with a *per-spawn* `customConfig` that names the ephemeral home as the allow-read root.

The per-call `customConfig` shape:

```javascript
{
  network: { allowedDomains: provider.ISOLATION.allowedDomains },
  filesystem: {
    denyRead: [
      // Operator's real $HOME — sandbox cannot read OTHER clients' OLP keys,
      // operator's SSH identity, other providers' tokens, etc.
      operatorHome,
      // Operator's known sensitive directories (defensive even though they
      // are already under operatorHome) — declared so a future refactor that
      // moves the operator home does not regress this protection.
      `${operatorHome}/.ssh`,
      `${operatorHome}/.gnupg`,
      `${operatorHome}/.olp`,
    ],
    // Layer 1 ephemeral home is the allow-read root for this spawn.
    // Layer 2 symlinked credentials live inside, so credential access works.
    allowRead: [ephemeralHomeForThisSpawn],
    allowWrite: [ephemeralHomeForThisSpawn, '/tmp'],
  },
}
```

Layer 3 is invoked **only when** the provider's `ISOLATION.hasInnerSandbox === false`. For providers with their own inner sandbox (codex via `--sandbox read-only`), Layer 3 is skipped to avoid the nested-sandbox conflict (A1.1.3).

Layer 3 provides:
- **OS-level deny of reads outside the ephemeral home and OLP-permitted paths.** A prompt-injected `cat /home/<operator>/.olp/keys/owner-key.json` or `cat /home/<operator>/.ssh/id_ed25519` hits a syscall-level deny.
- **Per-spawn (not per-process) configuration.** Each request gets a fresh sandbox scope. Two concurrent spawns do not share a sandbox; the MITM-proxy collision and singleton-config-mutation hazards from PR-B disappear.

What Layer 3 does NOT provide:
- It does not protect against the CLI's *own* tool-use surface emitting destructive shell commands within the allowed write zones. For that, Layer 4.
- Per-call `wrapWithSandbox()` has higher per-request latency than PR-B's once-at-boot pattern. The amortization budget is recovered by Layer 1's $HOME-as-cwd discipline keeping the sandbox config small and by ripgrep-based glob expansion being avoided (Layer 3 uses absolute literal paths throughout).

### A1.2.4 — Layer 4: Provider-specific tool hardening already in place

This is already-shipped work, re-affirmed here as part of the layered model:

- **anthropic Phase 6c `--system-prompt`** (commits `97e7d16` + fold-in `65f945c`). The system prompt is fully replaced at every spawn, suppressing the default tool descriptions that Claude Code would otherwise inject. Without tool descriptions, the model is highly unlikely to emit `tool_use` for `Bash`, `Read`, etc. even under prompt injection. See cc-mem `~/.cc-rules/memory/projects/olp/incident_2026_05_27_spawn_cli_security.md` § 5.
- **codex `--sandbox read-only` default.** OLP's codex provider spawn passes `--sandbox read-only` as a fixed flag. Codex's own inner sandbox provides read-only-by-default tool isolation. The provider's ISOLATION block declares `hasInnerSandbox: true` so Layer 3 is correctly skipped.
- **mistral.** TBD per Task #4 — the mistral provider's tool surface and inner-sandbox status need to be characterized.

Layer 4 provides:
- **Reduction of the *probability* of tool emission.** Layer 4 does not depend on OS-level enforcement; it works at the prompt layer. It is the cheap, fast, first-line defense. Layers 1–3 are the structural fallback when prompt-layer defenses are bypassed.

---

## A1.3 — The provider ISOLATION contract (named here; specified in ADR 0002 Amendment N)

Each provider plugin declares an `ISOLATION` block on its module export. The fields are:

| Field | Type | Meaning |
|---|---|---|
| `ephemeralEnvOverrides` | `(spawnCtx) => Record<string, string>` | Returns the env-var map to set for this spawn, given the spawn context (ephemeral home path, keyId, reqId). For anthropic: `{ HOME: spawnCtx.ephemeralHome }`. For codex: `{ CODEX_HOME: spawnCtx.ephemeralHome + '/.codex' }`. |
| `credentialMounts` | `{ realPath: string, ephemeralPath: string }[]` | List of credential files to symlink from real → ephemeral. For anthropic: `[{ realPath: '~/.claude/.credentials.json', ephemeralPath: '.claude/.credentials.json' }]`. Provider declares; runtime symlinks. |
| `hasInnerSandbox` | `boolean` | If true, Layer 3 is skipped to avoid nested-sandbox conflict. codex: true. anthropic: false. |
| `crossTenantReadProtection` | `'tool-suppression' \| 'inner-sandbox' \| 'none'` | Self-declared label for what layer is providing the read-protection. Used by `/health.sandbox` to report the protection posture per provider. **The canonical enum is defined in ADR 0002 Amendment 9 § 5; this row mirrors it.** |
| `recommendedDeploymentTier` | `'shared-os-user' \| 'per-os-user' \| 'separate-vm'` | Deployment tier the provider's current isolation posture is rated for. ADR 0006 risk-tier integration. **The canonical enum is defined in ADR 0002 Amendment 9 § 6; this row mirrors it.** |

**This amendment names the contract but does NOT specify its full validation, lifecycle, or test discipline.** Those land in **ADR 0002 Amendment (pending)** — the Provider contract amendment that ratifies `ISOLATION` as a required field, defines `validateProvider`'s checks on it, and documents how `lib/providers/base.mjs` enforces declaration. Until that ADR amendment lands, the ISOLATION block is a forward-looking contract; the implementation refactor (Tasks #5–#8) is gated on the ADR 0002 amendment landing first.

Cross-reference: see ADR 0002 § Amendments for the pending Amendment N that codifies the ISOLATION block contract.

---

## A1.4 — Revised PR plan

The original ADR's four-PR split (PR-A / PR-B / PR-C / PR-D) is restated as follows. PR-A is unchanged from its as-shipped state.

| PR | Original scope | Amendment 1 scope | Status |
|---|---|---|---|
| **PR-A** | npm dep + `lib/sandbox/doctor.mjs` + `/health.sandbox` | **Unchanged.** Doctor preserved; `/health.sandbox` field preserved. | ✅ Shipped (commit `07d9c8a`) |
| **PR-B** | Outer-bwrap wrap of anthropic spawn at boot-singleton level | **Superseded by Amendment 1.** Implementation archived to branch `phase-7-pr-b-outer-bwrap-snapshot`. New scope: refactor `lib/sandbox/manager.mjs` to the Layer 1 + Layer 2 + Layer 3 architecture (Tasks #5, #8). | ⛔ Superseded |
| **PR-C** | Outer-bwrap wrap of codex spawn with `enableWeakerNestedSandbox: true` | **Superseded by Amendment 1.** Codex isolation now flows via Layer 1 ephemeral `CODEX_HOME` + Layer 4 `--sandbox read-only`. Layer 3 deliberately skipped (`hasInnerSandbox: true`). Codex-specific PR (Task #7) lands the ISOLATION block declaration; no outer-wrap. | ⛔ Superseded |
| **PR-D** | Documentation update for cloud rollout unblock | **Reframed.** New scope: README "Security Model" section documenting the four-layer architecture, the deployment-tier mapping, and what the operator gets vs does not get at each tier. Task #10. | ♻ Reframed |

The new effective PR-list:

- **PR-B' (Refactor):** `lib/sandbox/manager.mjs` rewritten to expose `prepareIsolatedEnvironment(spawnCtx)` (Layer 1 + Layer 2) and `maybeWrapForReadProtection(spawnCtx, command)` (Layer 3 conditional). The `OLP_SANDBOX_DISABLED=1` env-var gate is preserved for 1-2 releases as belt-and-suspenders, then removed. Singleton bootstrap pattern is removed (per-spawn config eliminates the singleton's reason to exist).
- **PR-C' (Wiring + Anthropic ISOLATION):** `server.mjs` calls `prepareIsolatedEnvironment` on the spawn path; `lib/providers/anthropic.mjs` declares its ISOLATION block (Task #6); negative-test confirmation via Task #9 PI231 E2E.
- **PR-D' (Codex ISOLATION):** `lib/providers/codex.mjs` declares its ISOLATION block (Task #7); `hasInnerSandbox: true` skips Layer 3; codex inner sandbox preserved unmolested. Verified on PI231 (Task #9).
- **PR-E' (README + Phase 7 close):** README "Security Model" section (Task #10) + `docs/plans/cloud-deployment-family.md` § 5 update + Phase 7 close per `CLAUDE.md release_kit.phase_rolling_mode`.

The original PR sequence's load-bearing security gate (the negative test "in-sandbox `cat ~/.olp/keys/...` MUST fail") remains the acceptance criterion for the security-bearing PRs in the new sequence. The test itself transfers; only the wrap mechanism changes.

---

## A1.5 — What survives from PR-B (preserved)

The following artifacts from the original PR-B implementation are preserved through Amendment 1:

1. **`lib/sandbox/doctor.mjs` — preserved unchanged.** Pure preflight is still useful: it tells the operator whether the npm package is installed, whether the OS deps are present, and whether the platform is supported. Even though the architecture no longer relies on a boot-time `SandboxManager.initialize()`, the `/health.sandbox` field consumers (dashboard, monitoring scripts) expect a stable shape. Doctor stays.
2. **`/health.sandbox` field — preserved.** Shape adjusts slightly: the `active` boolean shifts meaning from "SandboxManager.initialize() succeeded" (PR-B) to "Layer 3 is operational for at least one provider whose `ISOLATION.hasInnerSandbox === false`" (Amendment 1). The field's name and JSON path stay the same so downstream consumers (dashboard, Hermes self-check, monitoring) do not break. The per-provider isolation posture is exposed via a new `/health.sandbox.providers[<name>].crossTenantReadProtection` subfield sourced from each ISOLATION block.
3. **`@anthropic-ai/sandbox-runtime` npm dependency — preserved.** Layer 3 still uses the library, but via per-call `wrapWithSandbox()` with `customConfig`, not via a once-at-boot `SandboxManager.initialize()`. The dependency line in `package.json` stays.
4. **The four authority citations in original § 7 — preserved.** The library URL, the spike report URL, the cc-mem incident URL, and the cloud deployment plan URL are unchanged. Amendment 1 *adds* the four new primary citations enumerated in § A1.1 above.
5. **The `OLP_SANDBOX_DISABLED=1` env-var gate — preserved for 1-2 releases, then removed.** Documented in A1.6 below.

---

## A1.6 — What disappears from PR-B (superseded)

The following artifacts are removed by the PR-B' refactor (Task #5):

1. **Outer-bwrap wrapping of the `claude` spawn.** The bwrap wrap goes away. `claude` runs directly (without bwrap shell-wrap) with its `HOME` set to the ephemeral location. Layer 3 wraps the *sub-spawn* shell when it is invoked, not the `claude` process itself.
2. **EROFS-driven mount patches.** The fold-in commit `2864275` ("allow read ~/.claude") and the subsequent `~/.claude` rw promotion (Task #5 was filed against this) were both consequences of trying to outer-bwrap a CLI that writes non-atomically to its `$HOME`. Solution 1 gives the CLI its own fresh `$HOME` and the entire mount-patch problem disappears. Task #5 ("allowWrite ~/.claude rw promotion fix") is closed as obsolete by this amendment.
3. **Boot-time `SandboxManager.initialize()` call.** Removed entirely. The library is loaded lazily per-spawn (with import memoization for performance — the import itself is cached after the first call; only the `wrapWithSandbox()` call is per-spawn).
4. **The singleton config-at-boot pattern.** Removed. The `_initConfig`, `_active`, `_initialized` module-level variables in `lib/sandbox/manager.mjs` no longer represent a global sandbox state; the only module-level state retained is the import cache for the library.
5. **The MITM proxy CA cert generated once at boot.** Per-call `wrapWithSandbox()` may regenerate per call (TBD on library v0.0.52 behaviour — Task #4 verifies). If per-call regeneration is too expensive, an alternative is a per-process MITM CA cached at first-use; the implementation detail is reserved to PR-B'.
6. **The `enableWeakerNestedSandbox: true` flag plan.** Removed. Codex isolation does not run inside an OLP outer sandbox at all. `enableWeakerNestedSandbox` is irrelevant to Amendment 1's architecture.

### A1.6.1 — The `OLP_SANDBOX_DISABLED=1` env-var gate

The env-var gate added in commit `b1e24b7` ("add OLP_SANDBOX_DISABLED=1 env-var emergency disable") is preserved through the Amendment 1 refactor as belt-and-suspenders. Its semantics under Amendment 1:

- **PR-B world (current main, with the gate set in prod):** the gate skips `SandboxManager.initialize()` at boot. Prod is currently running with the gate set, which means PR-B's outer-bwrap path is not active — Layer 3 protection is also not active.
- **Amendment 1 world (after PR-B' lands):** the gate skips Layer 3's per-call `wrapWithSandbox()` and reverts each spawn to a Layer 1 + Layer 2 + Layer 4 configuration. The CLI still gets an ephemeral `$HOME` with symlinked credentials, still gets the `--system-prompt` tool-description suppression for anthropic, still gets `--sandbox read-only` for codex. What is given up is the OS-level deny of reads outside the ephemeral home. This is a *meaningful* but not *catastrophic* degradation — the prompt-layer defense remains, and Layer 1's $HOME isolation still prevents the most common cross-tenant accident path.
- **Sunset:** the gate is preserved for **1-2 releases** after PR-B' ships to give the operator a fast escape hatch if the Layer 3 per-call wrap regresses in production. After two clean releases with no operator escalation, the gate is removed in a subsequent ADR amendment or a clean PR citing this section as authority for the removal.

The gate's behaviour is documented in README's Security Model section per PR-D' (Task #10).

---

## A1.7 — Reversibility

Amendment 1 is reversible at the implementation layer:

- **PR-B' refactor** is reversible by `git revert` of the refactor commit + restoring the snapshot from `phase-7-pr-b-outer-bwrap-snapshot`. The archive branch is pushed and persistent at:
  https://github.com/dtzp555-max/olp/tree/phase-7-pr-b-outer-bwrap-snapshot
- **The `@anthropic-ai/sandbox-runtime` dependency** stays in `package.json`, so reverting does not require an `npm install`.
- **The `lib/sandbox/doctor.mjs` module** is unchanged across the refactor, so reverting does not affect `/health.sandbox` shape.

Amendment 1 itself, as a governance artifact, is reversible by a subsequent superseding amendment if the empirical foundation it rests on changes (e.g., if Anthropic publishes guidance endorsing outer-wrap use of `sandbox-runtime` and adds a contract for `~/.claude.json` write paths). ALIGNMENT.md § "Amendment Procedure" applies: such a future amendment would need to cite the new evidence.

The archive-branch retention policy: the snapshot branch is kept indefinitely (no auto-delete) so a future maintainer investigating outer-bwrap-around-CLI as an architecture has a working reference point. The branch's HEAD commit matches commit `b1e24b7` (the last commit of the outer-bwrap implementation before the architecture pivot).

---

## A1.8 — Updated open questions (supersedes original § 5)

The original § 5 listed five open questions all of which were specific to the outer-bwrap architecture. Amendment 1 supersedes those and lists the open questions for the new architecture:

1. **Per-call `wrapWithSandbox()` latency.** PR-B amortized the MITM CA generation (100-500ms) across all spawns by initializing once at boot. Per-call wrap regenerates this if the library does not cache internally. Task #4 PI231 spike measures the actual per-call cost; if it exceeds the original ≤200ms p95 budget, an internal cache wrapper around the library is added in PR-B'. Decision reserved for PR-B'.
2. **`vibe` (mistral) home-relocation env var.** Task #4 PI231 spike checks whether `vibe` honours `MISTRAL_HOME` / `VIBE_HOME` / similar. If yes, mistral's ISOLATION block declares it and mistral participates in Layer 1. If no, mistral falls back to Layer 4 (prompt layer) + Layer 3 (per-call wrap with `denyRead` on the operator's real home) only. The provider's `recommendedDeploymentTier` is set accordingly.
3. **macOS coverage.** sandbox-runtime supports macOS via `sandbox-exec` (seatbelt profile). Layer 1 ephemeral home is OS-agnostic (just an env var). Layer 3 macOS path needs verification: does per-call `wrapWithSandbox()` with `customConfig` produce a per-spawn sandbox-exec profile, or does it re-use a singleton seatbelt profile? Task #4 PI231 spike is Linux-only; a parallel macOS verification is a Task #9 deliverable.
4. **Symlink-vs-bindmount for credentials.** Layer 2 uses symlinks for credential mounting. An alternative is bindmounting the credential file into the ephemeral home (only available inside the Layer 3 wrap). The trade-off: symlinks work outside any sandbox context (so Layer 2 works even when Layer 3 is skipped, e.g., for codex); bindmounts are stronger isolation (the CLI cannot follow the symlink to discover the real path). Decision reserved for PR-B' implementation review.
5. **Concurrent-spawn cleanup ordering.** The ephemeral home cleanup (rmdir at response end) must not race with a still-streaming spawn. The current plan: track per-`reqId` cleanup and only fire on the spawn's `exit` event. If a streaming abort leaves the spawn alive past the HTTP response, cleanup is deferred until `exit`. Tested in Task #9.
6. **`/health.sandbox.providers` shape under Amendment 1.** Original `/health.sandbox` had a flat `{ available, active }`. Amendment 1 adds per-provider posture: `{ available, providers: { anthropic: { crossTenantReadProtection: 'tool-suppression', layers: ['L1','L2','L3','L4'] }, openai: { crossTenantReadProtection: 'inner-sandbox', layers: ['L1','L4'] } } }`. Exact shape ratified by PR-B'.
7. **Dashboard `/dashboard` Security panel.** The dashboard currently has no security panel. Amendment 1 names the addition as a follow-up: render `/health.sandbox.providers` as a per-provider posture badge so the operator can see at a glance which providers are in `tool-suppression` vs `inner-sandbox` vs `none` mode. Out of Phase 7 scope; recorded for a future ADR.

---

## A1.9 — Authority citations (Amendment 1)

Per ALIGNMENT.md Rule 1 (Cite First) and Iron Rule 12 (Pre-Brainstorm Prior-Art Search), every load-bearing claim in this amendment is cited to a primary source. The four forcing reasons are cited above in A1.1.1–A1.1.4; this section enumerates them in one place plus the supporting citations.

**Forcing reasons:**

1. **sandbox-runtime documented use-case is inner-wrap by Claude Code.**
   - https://www.anthropic.com/engineering/claude-code-sandboxing — "Claude Code sandboxing" engineering blog. Documents Claude Code's *internal* use of the library to wrap tool-spawn calls. The blog also notes the library "can be used to sandbox arbitrary processes, agents and MCP servers" — i.e., it is general-purpose, not Claude-Code-internal-only. **Our reading:** outer-wrap of `claude` itself is not the documented or demonstrated direction; OLP would be the only known user in that configuration. Project-design judgment, not an Anthropic prohibition.

2. **`~/.claude.json` non-atomic write — upstream issue closed `not_planned` by inactivity bot.**
   - https://github.com/anthropics/claude-code/issues/29250 — upstream issue requesting atomic-write semantics. Status: closed `not_planned` by `github-actions[bot]` on 2026-03-31 (inactivity), labeled `duplicate`, `stale`. **No upstream Anthropic maintainer comment articulates a policy position**; the closure does not establish "won't fix" as policy. Forcing argument rests on architectural-cost analysis (permanent maintenance treadmill for outer-`--ro-bind`), not on alleged upstream policy.

3. **Codex inner-bwrap conflict.**
   - https://github.com/openai/codex/issues/16018 — upstream codex CLI issue. Documents that codex's default bwrap sandbox **fails outright** in environments lacking unprivileged user namespaces. The issue is a feature request asking codex to add a fallback path; **the issue body does NOT document an existing automatic fallback to `--sandbox danger-full-access`**. Whether codex degrades to `danger-full-access` or aborts the spawn under nested-bwrap failure is empirically open (Task #4 deliverable). Either failure mode breaks the strict-additive-isolation invariant for outer-wrap of codex. This is the multi-provider forcing function regardless of which failure mode applies.

4. **`CODEX_HOME` documented relocation lever.**
   - https://developers.openai.com/codex/config-reference — OpenAI codex CLI config reference (primary).
   - https://codex.danielvaughan.com/2026/04/08/codex-cli-configuration-reference/ — third-party reference (cross-reference for reachability).

**Supporting citations (carried forward from original ADR § 7):**

5. **`@anthropic-ai/sandbox-runtime` v0.0.52** — https://github.com/anthropic-experimental/sandbox-runtime
   - `dist/sandbox/sandbox-manager.js` — `SandboxManager.wrapWithSandbox(command, undefined, customConfig)` is the per-call wrap surface used by Layer 3. The third argument `customConfig` is the per-call override mechanism that makes Amendment 1's per-spawn config architecture implementable without library modification.

6. **Internal evidence:**
   - **PR-B implementation chain** — commits `d0dcd28` → `2864275` → `497b255` → `b1e24b7` → `3551921`. The HTTP-path activation regression is documented in commit message `b1e24b7` and in `lib/sandbox/manager.mjs` § "OLP_SANDBOX_DISABLED env-var gate" comments.
   - **cc-mem incident memory 2026-05-27** — `~/.cc-rules/memory/projects/olp/incident_2026_05_27_spawn_cli_security.md` — the original multi-tenant gap and the prior-art search that established the ecosystem has no working solution.
   - **2026-05-28 PoC spike on PI231** — `/tmp/sandbox-spike/report.md` on PI231. Verdict was YELLOW (architecturally green, operationally blocked on apt deps). The follow-up 2026-05-29 PI231 prep work re-evaluates against the new architecture; results land in Task #4.

7. **OLP governance:**
   - **OLP ALIGNMENT.md Rule 1** — Authority citation required for any provider-plugin / entry-surface / IR change. Amendment 1 amends governance only; the implementation refactor (PR-B') carries its own per-commit citations to the same primary sources enumerated above.
   - **OLP ALIGNMENT.md Rule 4** — Unalignable plugins are deleted. Mistral's potential lack of a home-relocation env var (open question 2 above) is *not* an alignability gap (mistral's CLI authority is unchanged); it is a deployment-tier classification, recorded in the provider's ISOLATION block.
   - **Iron Rule 10** — Independent reviewer required. This amendment's review is pending at draft time.
   - **Iron Rule 11** — Minimum reviewable unit. PR-B' is one PR (sandbox manager refactor); the anthropic ISOLATION block, codex ISOLATION block, server wiring, and README section are each separate PRs per the revised PR plan in § A1.4.
   - **Iron Rule 12** — Pre-brainstorm prior-art search. The four forcing reasons each satisfy the rule's "provider-specific authority check decisive" condition: Anthropic's blog post + upstream issue 29250 (for the anthropic side), and the codex issue 16018 + the OpenAI config reference (for the codex side).

8. **OLP ADR cross-references:**
   - **ADR 0001 § Mission** — multi-provider proxy. Codex inner-bwrap conflict is the multi-provider forcing function.
   - **ADR 0002 (pending Amendment N)** — Provider ISOLATION contract specification. Amendment 1 names the contract; Amendment N specifies it.
   - **ADR 0006** — Provider Inclusion / Risk Tier. `recommendedDeploymentTier` in the ISOLATION block integrates with the risk tier framework.
   - **ADR 0009 Amendment 1 § Caveats #3** — "Sandbox-runtime still required for real multi-tenant deployment." Amendment 1 satisfies this caveat via Layer 3, not via outer-wrap.
   - **`docs/plans/cloud-deployment-family.md` § 5** — sandbox is a cloud rollout prerequisite. PR-E' updates this section to reflect that the layered architecture is the cloud prerequisite, not outer-bwrap.

---

## A1.10 — Consequences of Amendment 1

### Positive

- **No outer-bwrap maintenance treadmill.** New `claude` CLI state files do not require OLP-side `--ro-bind` updates. Layer 1 absorbs them automatically.
- **Multi-provider compatible.** Codex inner sandbox is preserved unmolested. The architecture works for both anthropic (no inner sandbox) and codex (has inner sandbox) without per-provider workarounds in the sandbox layer; the per-provider differences live in the per-provider ISOLATION block where they belong.
- **Per-spawn isolation primitives.** Every request gets a fresh `$HOME`. Cross-tenant state carry-over at the filesystem level is structurally impossible, not "mitigated by careful denylist."
- **Aligned with Anthropic's design intent.** OLP uses sandbox-runtime in the direction the library was designed for (sandboxing what the spawn triggers, not wrapping the spawn from outside). The library's semver discipline becomes leverage rather than risk.
- **Reduced HTTP-path activation surface.** PR-B's regression was that the in-process MITM proxy lifecycle interacted with OLP's HTTP request handler. Per-call `wrapWithSandbox()` does not require an always-on in-process proxy; the failure mode goes away by construction. (To be confirmed empirically in Task #4 + Task #9.)
- **Doctor and `/health.sandbox` continuity.** Operators and dashboard consumers see the same field at the same JSON path. Shape additions are additive, not breaking.

### Negative

- **Per-call latency cost.** Per-call `wrapWithSandbox()` is more expensive than once-at-boot init+wrap. The mitigation is library-import caching and (if measured high) a sandbox-config cache keyed by the union of allowed-read paths. Empirical measurement in Task #4.
- **New contract surface (ISOLATION block).** Each provider plugin now declares ISOLATION fields. This is incremental complexity in the Provider contract — ratified by ADR 0002 Amendment N. ADR 0002 amendment is on the critical path.
- **Mistral declared `crossTenantReadProtection: 'none'`.** Vibe CLI has no Phase-6c-equivalent tool suppression and no known inner sandbox as of D8 ADR 0006 enablement. The mistral provider's `recommendedDeploymentTier` is therefore `separate-vm` per ADR 0002 Amendment 9 § Per-provider concrete instance, meaning mistral can run only in a dedicated VM rather than sharing the OS user with other providers. Not a regression vs status quo (mistral is not deployed today); reflects honest characterization of current state per ALIGNMENT.md Rule 3. Task #4 spike may discover a hardening regime, transitioning this tier upward.
- **Symlink semantics edge cases.** Layer 2 symlinks credential files into the ephemeral home; some CLIs may resolve the symlink and write a sibling file in the *target* directory rather than the ephemeral location. Each provider's ISOLATION block should declare any such known behaviour; the runtime tests verify by examining the operator's real `$HOME` for stray writes after a test spawn.
- **The `OLP_SANDBOX_DISABLED=1` env-var gate is preserved for 1-2 releases.** It remains a valid escape hatch — but as belt-and-suspenders rather than as load-bearing. Operators who rely on the gate after sunset will see a deprecation message before removal.

### Reversibility (governance level)

- Amendment 1 is reversible by a superseding ADR amendment that cites new evidence overturning any of the four forcing reasons. The most likely overturning scenario: Anthropic publishes guidance endorsing outer-wrap of `claude` CLI plus an atomic-write contract for `~/.claude.json`. If that happens, the superseding amendment cites the new guidance and re-enables outer-wrap as an option (alongside, not replacing, the Solution 1 architecture).
- The implementation-level reversibility is documented in § A1.7 above.

---

## A1.11 — Forward-looking pointer

Amendment 1 is the governance layer. The implementation lands across Tasks #5–#10 (per the working task list at the time of this draft):

- Task #4 — PI231 spike to verify `HOME` / `CODEX_HOME` env-var override behaviour (live, with the same `claude` and `codex` CLI versions OLP ships against).
- Task #5 — Refactor `lib/sandbox/manager.mjs` to the Layer 1 + Layer 2 + Layer 3 architecture (PR-B').
- Task #6 — Add ISOLATION block to `lib/providers/anthropic.mjs` (PR-C').
- Task #7 — Add ISOLATION block to `lib/providers/codex.mjs` (PR-D').
- Task #8 — Wire `prepareIsolatedEnvironment` into `server.mjs` spawn pipeline (folds into PR-C' or its own PR depending on diff size).
- Task #9 — PI231 E2E validation of Solution 1 + close PR-B's load-bearing negative test ("in-sandbox `cat ~/.olp/keys/...` MUST fail") against the new architecture.
- Task #10 — README "Security Model" section + cloud-deployment-plan § 5 update + Phase 7 close (PR-E').

ADR 0002 Amendment N (Provider ISOLATION contract specification) is a co-merged ADR with PR-C'; it cannot land after the ISOLATION block reaches the codebase per ALIGNMENT.md Rule 2(c)'s spirit (no contract field without an authorizing ADR).

---

## A1.12 — Amendment status

- **Drafted:** 2026-05-29 (this document).
- **Reviewer:** independent fresh-context reviewer per Iron Rule 10 — pending.
- **Implementation gate:** ADR 0002 Amendment N (Provider ISOLATION contract specification) must land before or together with PR-C' (the first ISOLATION-block-bearing provider plugin commit).
- **Production gate:** PI231 E2E (Task #9) must pass the load-bearing negative test before the `OLP_SANDBOX_DISABLED=1` env-var gate is removed from prod startup.

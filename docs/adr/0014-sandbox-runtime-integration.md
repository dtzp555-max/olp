# ADR 0014 — Sandbox-Runtime Integration for Multi-Tenant Provider Spawning

**Status:** Accepted (PR-A — deps + doctor + ADR only; PR-B/C/D pending)
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
| **PR-B** | `lib/providers/anthropic.mjs` spawn wrapped in `SandboxManager.wrapWithSandbox` | `bubblewrap` + `socat` + `rg` installed on PI231 (`sudo apt-get install -y bubblewrap socat ripgrep`) | 🔲 Blocked on apt install |
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

When available (after apt install + process restart):

```json
{
  "sandbox": {
    "available": true,
    "missing": [],
    "platform": "linux"
  }
}
```

---

## 4. PR-B/C/D acceptance criteria (preview — locked in later PRs)

These criteria are recorded here to prevent scope creep in the later PRs. Criteria may be refined by subsequent ADR amendments.

### 4.1 PR-B (anthropic.mjs spawn wrap)

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
- `SandboxManager.initialize()` is called once at startup (per ADR 0014 § 5 singleton decision, TBD in PR-B ADR amendment)
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

# ADR 0002 — Plugin Architecture for Providers

- **Date:** 2026-05-23
- **Status:** Accepted (bootstrap)
- **Authors:** project maintainer (with AI drafting assistance)
- **Related:** OLP v0.1 spec §4.2; ADR 0001 (project founding); ADR 0003 (IR design); ADR 0006 (provider inclusion framework)

## Amendments

> **Note on numbering.** Sequence is 1, 3, 4, 5, 6 — Amendment 2 was never written. The reserved slot was originally planned for a separate `maxConcurrent` ratification, but that content was folded into Amendment 1 (the retroactive contract-sync amendment) at filing time and the gap was not backfilled. The gap is intentional and load-bearing — no missing content; do not renumber Amendments 3+ to close it (cross-references to Amendment N from other docs would silently break).

### Amendment 6 — 2026-05-24: `maxConcurrent` runtime enforcement landed (D38, issue #1)

- **Finding:** Amendment 1 (2026-05-23) ratified `maxSpawnTimeMs` into the Provider contract but explicitly noted that `hints.maxConcurrent` remained **declarative-only at v0.1** — type-validated at startup in `lib/providers/base.mjs` (`validateProvider` requires it to be a non-negative integer) but unenforced at runtime (no semaphore / in-flight counter / spawn queue in `server.mjs`). Cold-audit catch from D11 (commit `f659e29`): the diff-review reviewer grep-verified that the original ADR draft's claim "Enforced by the spawn-concurrency guard in `server.mjs`" was false. GitHub issue #1 was filed to track the gap. D38 closes that gap.
- **Change (D38):**
  - Add a per-provider in-flight semaphore in `lib/providers/index.mjs` exporting three primitives plus a constant:
    - `tryAcquireSpawn(providerName, maxConcurrent)` — atomic check-then-increment; returns `true` on success, `false` if at limit. Atomicity rests on the JS single-threaded invariant — the read and write are synchronous with NO `await` between them. A future async refactor MUST preserve this.
    - `releaseSpawn(providerName)` — decrement; throws if the count would go negative (defensive bug guard for missing acquire / double release).
    - `getActiveSpawnCount(providerName)` — returns current in-flight count; exported for diagnostics and tests (server.mjs uses it to populate the `activeSpawns` field on a synthesised `CONCURRENCY_LIMIT` error). `/health` integration deferred — when surfaced there it will land at `providers.status.<name>.activeSpawns`; not wired at D38.
    - `DEFAULT_MAX_CONCURRENT_SPAWNS = 4` — defense-in-depth fallback when a plugin path bypasses `validateProvider` and passes undefined/null/NaN. The value matches the v0.1 plugin defaults (anthropic / codex / mistral all declare `hints.maxConcurrent: 4`).
  - Wire the gate at both `provider.spawn(...)` call sites in `server.mjs handleChatCompletions`:
    - **Buffered path** (inside `executeHopFn → collectAllChunks`): `tryAcquireSpawn` runs before `provider.spawn(...)`. On failure, synthesise `ProviderError(CONCURRENCY_LIMIT)` with `providerName` / `maxConcurrent` / `activeSpawns` fields for diagnostics and re-throw — the fallback engine treats it as a hard trigger (see ADR 0004 Amendment 4) and advances to the next chain hop. On success, the spawn drain loop runs inside a `try { … } finally { releaseSpawn(...) }` so the slot releases on every exit path (success, error, D16 SPAWN_FAILED salvage return, unexpected throw).
    - **Streaming path** (single-hop real-SSE, `chain.length === 1` cache-miss branch): acquire happens BEFORE the streaming branch entry. If acquire fails, the branch is skipped and the request falls through to the buffered path — that path's own gate re-attempts acquire; a single-hop chain at maxConcurrent has no other hop to advance to, so the request surfaces a chain-exhausted error via `executeWithFallback`'s exhaustion path. If acquire succeeds, the existing streaming try/catch gains a `finally { releaseSpawn(streamProvider) }` so the slot releases on stop-chunk completion, generator exhaustion, abort, or any exception path.
  - Add `CONCURRENCY_LIMIT` to `PROVIDER_ERROR_CODES` in `lib/providers/base.mjs` so the synthesised error type-checks with the existing closed enum. (Note: `CONCURRENCY_LIMIT` is synthesised by the orchestration layer, NOT thrown by provider plugins themselves — the code is in the enum for type consistency with the fallback engine's `HARD_TRIGGER_CODES` lookup.)
  - Update the `maxConcurrent` description in § Decision (Provider contract hints) below — remove the "Declarative hint only at v0.1" caveat and add the implementation reference.
- **Update to § Decision § Provider contract hints (`maxConcurrent`):** replace the v0.1 caveat with: "`maxConcurrent` — integer; maximum simultaneous spawn count OLP will allow for this provider. The value is type-validated at startup (`lib/providers/base.mjs validateProvider`) and enforced at runtime by `tryAcquireSpawn` / `releaseSpawn` in `lib/providers/index.mjs`. Saturation surfaces as `ProviderError(CONCURRENCY_LIMIT)` (per `PROVIDER_ERROR_CODES`, `lib/providers/base.mjs`), which the fallback engine treats as a hard trigger per ADR 0004 Amendment 4 — the chain advances to the next hop. If the entire chain is saturated, the user receives a chain-exhausted error via the existing `executeWithFallback` exhaustion path."
- **Design choice — immediate-advancement vs. queue+timeout:** D38 implements immediate-advancement through the fallback chain. Rationale:
  1. The fallback chain exists precisely for this kind of overflow — saturation on the primary hop is a natural fit for the existing advancement mechanism.
  2. Queue+timeout introduces head-of-line blocking risk (a stuck/slow spawn blocks queued waiters) and adds a new timeout config surface (`hints.maxConcurrentWaitMs`?) that the contract does not currently have.
  3. Immediate-advancement gives fail-fast latency and matches the OLP multi-provider proxy philosophy (the user has spread their quota across providers explicitly so saturation should reach an alternate provider as fast as possible).
  4. Queue+timeout is **deferred to a future iteration** if real usage shows demand. Track via a follow-up issue if the design pressure surfaces.
- **Authority:** ALIGNMENT.md Rule 1 (Cite First) — internal authority is ADR 0002 (this ADR) + ADR 0004 (which adds CONCURRENCY_LIMIT to the hard-trigger taxonomy in its Amendment 4). No provider CLI doc cited because this change is internal to the orchestration layer; no provider plugin code changes (anthropic / codex / mistral already declare `hints.maxConcurrent` correctly per validateProvider).
- **Tests:** Suite 18 in `test-features.mjs` — 16 tests covering: `PROVIDER_ERROR_CODES` membership, `evaluateHardTriggers(CONCURRENCY_LIMIT)` returns true, semaphore unit behaviour (acquire / release / count / reset), saturation rejection, defensive coercion of non-integer maxConcurrent, double-release throws, HTTP-level concurrent-request peak-in-flight assertion (5 requests against maxConcurrent:2 → peak == 2), buffered-path counter release, streaming-path counter release, fallback advancement to secondary on saturated primary.
- **Procedural mechanism:** CC 开发铁律 v1.6 § 10.x (D38 issue #1 implementation; fresh-context opus reviewer to follow this implementation per Iron Rule 10).

### Amendment 5 — 2026-05-24: Correct § Decision filesystem layout — `vibe.mjs` → `mistral.mjs` (D36 #5)

- **Finding:** Issue #5 (D36) — § Decision filesystem layout (around line 47 of the original ADR) listed the Mistral provider plugin as `vibe.mjs` (named after the CLI binary `vibe`). The shipped file at `lib/providers/mistral.mjs` (D8) is named after the provider key, matching the established convention from the other two plugins: `anthropic.mjs` (provider key `anthropic`, CLI `claude`) and `codex.mjs` (provider key `openai`, CLI `codex`). The ADR's `vibe.mjs` entry was a drafting-time placeholder that did not get corrected when D8 landed `lib/providers/mistral.mjs`.
- **Change:** Replace `vibe.mjs # spawn `vibe --prompt --output json`` with `mistral.mjs # spawn `vibe --prompt --output streaming`` in the filesystem layout. The `--output streaming` correction also aligns the example with the actual D8 implementation (`mistral.mjs` line 377 uses `--output streaming`, not `--output json` — see D8 review-2 finding inside the plugin header).
- **Naming convention reaffirmed:** Provider plugin files are named after the **provider key** (`anthropic`, `openai`, `mistral`), not the CLI binary (`claude`, `codex`, `vibe`). Future provider plugins must follow this convention. The provider key is the load-bearing identifier — it appears in `models-registry.json`, cache keys, fallback chain configs, and ADR 0006 inclusion tables. The CLI binary name is an implementation detail that may change (e.g., a vendor rename) without affecting the rest of the system.
- **Authority:** Issue #5 (D36); naming convention established by `lib/providers/anthropic.mjs` (D4) and `lib/providers/codex.mjs` (D6) which both shipped before `lib/providers/mistral.mjs` (D8).
- **No code change:** D36 #5 is a docs-only correction. The plugin file already lives at the correct path.
- **Procedural mechanism:** CC 开发铁律 v1.6 § 10.x (D36 batch — ADR drift caught by issue-triage review of bootstrap ADRs).

### Amendment 4 — 2026-05-24: Ratify `contractVersion` as a required Provider contract field (D32 F5)

- **Finding:** Round-4 cold-audit F5 (P3 governance omission) — `lib/providers/base.mjs` `validateProvider` enforces `p.contractVersion === '1.0'` and all three shipped plugins declare it, but the Provider contract field list in § Decision (lines ~63-74) does not include `contractVersion`. It was mentioned only in § Mitigations as a forward-looking note ("The contract is versioned. v1.0 is the subset in this ADR; future additions … require ADR amendment plus a contract-version bump. Old provider plugins continue to declare `contractVersion: '1.0'`…"), not as a required field. This is the same class of documentation–implementation gap as Amendment 1 (`maxSpawnTimeMs` retroactive sync).
- **Change:** Add `contractVersion: '1.0'` as the 10th required field in the Provider contract field list in § Decision. The `hints` block moves from 9th to 10th entry to keep the list logically ordered (name → displayName → models → auth → spawn → estimateCost → quotaStatus → healthCheck → contractVersion → hints). `validateProvider` in `base.mjs` already enforces it; this amendment is a retroactive documentation sync, not a code change.
- **Semantics:** `contractVersion` is a required string field set to `'1.0'` for all v0.1 plugins. Its purpose is to allow the loader to detect plugins authored against an older or newer contract version when OLP's contract evolves. A future contract revision (v1.1 or v2.0) will increment this value and update this ADR accordingly.
- **Authority:** `lib/providers/base.mjs` `validateProvider` function — live enforcement as of v0.1 bootstrap. All three shipped plugins (`anthropic.mjs`, `codex.mjs`, `mistral.mjs`) already export `contractVersion: '1.0'`.
- **Procedural mechanism:** CC 开发铁律 v1.6 § 10.x (Round-4 Cold Audit caught it as F5). Parallel to Amendment 1 (D11 `maxSpawnTimeMs` retroactive sync).

### Amendment 3 — 2026-05-24: Add `cacheable` to Provider contract hints (D23)

- **Finding:** Cold-audit round-2 Finding 3 (P2 contract/cache-condition drift) — ADR 0005 § "Cache write conditions" item 3 references `hints.cacheable` but the field was never named in this ADR's Provider contract hints list. `validateProvider` did not enforce it; no plugin declared it; no consumer read it. The field existed only in prose.
- **Change:** Add `cacheable: boolean (optional, default true)` to the contract hints. Plugins that omit it are treated as `cacheable: true` (backward-compatible default — preserves v0.1 behavior for the three shipped plugins). A plugin author who explicitly sets `cacheable: false` opts out of OLP's response cache entirely: `executeHopFn` in `server.mjs` skips `cacheStore.getOrCompute` and calls `collectAllChunks` directly; neither `cache.get` nor `cache.set` is called for that hop.
- **Rationale:** Some providers may be cheap and stateful enough that caching adds risk without value (e.g., providers with strong intra-session continuity, or providers whose output is intentionally non-deterministic). Giving plugins an explicit opt-out keeps the design honest without imposing a runtime cost on the common case (all three shipped plugins are `cacheable: true`).
- **Authority:** ADR 0005 § "Cache write conditions" item 3 — established the field; D23 ratifies it in the contract.
- **Procedural mechanism:** CC 开发铁律 v1.6 § 10.x (Round-2 Cold Audit caught it as Finding 3).

### Amendment 1 — 2026-05-23: Add `maxSpawnTimeMs` to Provider contract hints (retroactive sync)

- **Finding:** Cold-audit Finding 4 (P2 governance violation) — commit `2cfd0b1` (D10) added `maxSpawnTimeMs` to all three provider plugins (`anthropic.mjs`, `codex.mjs`, `mistral.mjs`) — enforcement lives inside each provider plugin's spawn drain loop, which throws `ProviderError(SPAWN_TIMEOUT)` that the fallback engine then treats as a hard trigger (ADR 0004 § Trigger taxonomy bullet 4) — but the Provider contract documentation in this ADR was not updated in the same merge.
- **Code already landed:** The corresponding implementation is live in commit `2cfd0b1` (D10). This amendment is a retroactive contract sync to restore documentation–implementation alignment per ALIGNMENT.md Rule 1 (Cite First) and `CLAUDE.md` § "Hard requirements for plugin / server.mjs / IR changes" item 1 (Authority citation) — both of which require contract additions to be authority-cited at landing. ALIGNMENT.md Rule 2(c)'s literal wording covers IR fields; its spirit extends to Provider-contract additions.
- **Procedural mechanism:** CC 开发铁律 v1.6 § 10.x (Diff Review vs Cold Audit mode). The diff-review pass that approved D10 missed this omission; the subsequent cold-audit run on 2026-05-23 caught it as Finding 4. This amendment is the required remediation.
- **Authority:** ADR 0004 § Trigger taxonomy — Hard triggers bullet 4: "Provider CLI spawn timeout (configurable per-provider via `hints.maxSpawnTimeMs`)."

## Context

OLP declares a curated set of candidate providers — three anticipated Tier D (Anthropic, OpenAI Codex, Mistral Vibe), two anticipated Tier C (xAI Grok, Moonshot Kimi), and three anticipated Tier B (MiniMax, Zhipu GLM, Alibaba Qwen). Per ALIGNMENT.md § Provider Inventory, all 8 ship as **Candidate** at v0.1 founding; transition to **Enabled** requires authority pin filled + plugin landed + Phase audit passed. Each provider has its own CLI binary, its own auth artifact location, its own request shape, its own response shape, its own quota-reporting endpoint (or none), and its own rate-limit posture. The maintainer's strong prior is that this set grows over the project's lifetime — provider economics will continue to shift, and "the right five providers" in 2027 will not be identical to today's five.

The naive architecture is a monolithic dispatcher inside `server.mjs`:

```js
if (provider === 'anthropic') { spawn claude -p ... }
else if (provider === 'openai') { spawn codex exec --json ... }
else if (provider === 'mistral') { spawn vibe --prompt ... }
// ... and so on for every provider, every auth shape, every quirk
```

This shape works for two providers, becomes painful at four, and is the structural shape that produced the worst pages of OCP's `server.mjs` (1667 lines, ADR 0005 context paragraph). Worse, it makes the answer to "how does a contributor add a sixth provider?" be "edit eight places inside `server.mjs` and hope you caught them all." That is the exact failure mode `models.json` SPOT (OCP ADR 0003) was designed to prevent for model metadata; the provider equivalent needs the same structural answer.

The other end of the spectrum is full external plugin discovery — npm-installed plugins, runtime registration, hot-load. That is unambiguously out of scope for v1.0: the provider set is curated for security and ToS-risk reasons (see ADR 0006), and "anyone can install a third-party plugin" violates that curation by design.

The middle path is a **plugin model with a fixed in-tree provider registry**: each provider is a `.mjs` file under `lib/providers/`, all conforming to a single `Provider` contract, loaded at startup from a static enumeration in `lib/providers/index.mjs`. Adding a provider means writing one file and adding one line to the registry. Disabling an optional provider means a config-file toggle, not a code change.

## Decision

Per spec §4.2, OLP uses a plugin-based provider architecture with the following structure:

**Filesystem layout:**
```
lib/providers/
  base.mjs              # abstract Provider contract + shared helpers
  index.mjs             # static registry (enumeration of in-tree providers)
  anthropic.mjs         # spawn `claude -p` — port of OCP server.mjs spawn logic
  codex.mjs             # spawn `codex exec --json`
  mistral.mjs           # spawn `vibe --prompt --output streaming` (file named after
                        # provider key per the convention established by
                        # anthropic.mjs / codex.mjs — see Amendment 5)
  grok.mjs              # spawn `grok -p --output-format streaming-json` (optional)
  kimi.mjs              # spawn `kimi -p --output-format stream-json` (optional)
  minimax.mjs           # tier-2 optional, default-disabled
  glm.mjs               # tier-2 optional, default-disabled
  qwen.mjs              # tier-2 optional, default-disabled
```

**Provider contract** (v1.0 interface — exact shape per spec §4.2):

Every provider plugin exports an object conforming to:
- `name: string` — unique key (`anthropic`, `openai`, `mistral`, etc.)
- `displayName: string` — human-readable name for dashboards and consent UX
- `models: string[]` — models this provider serves
- `auth: { type, storage, path, refresh }` — auth-artifact profile
- `spawn: async (normalizedRequest, authContext) => AsyncIterator<ResponseChunk>` — the core invocation
- `estimateCost: (request) => { inputTokens, outputTokensEstimate, currency, usd }` — best-effort, may return null
- `quotaStatus: async (authContext) => { available, percentUsed, resetsAt, pool }` — best-effort, null if unretrievable
- `healthCheck: async () => { ok, latencyMs, error? }` — startup and `/health` endpoint use this
- `contractVersion: '1.0'` — required string identifying the Provider contract version the plugin was authored against. Set to `'1.0'` for all v0.1 plugins. `validateProvider` in `base.mjs` enforces this field. Future contract revisions will increment the value; the loader uses it to detect stale plugins. See Amendment 4. (D32 F5)
- `hints: { requiresTTY, concurrentSpawnSafe, maxConcurrent, maxSpawnTimeMs, cacheable }` — fingerprint, concurrency, timeout, and cache hints:
  - `requiresTTY` — boolean; whether the provider CLI requires a TTY to produce non-interactive output (e.g., some CLIs suppress JSON output unless forced with a flag or a TTY is present).
  - `concurrentSpawnSafe` — boolean; whether the provider CLI is safe to spawn concurrently under the same auth context without rate-limit or session collisions.
  - `maxConcurrent` — integer; maximum simultaneous spawn count OLP will allow for this provider. The value is type-validated at startup (`lib/providers/base.mjs validateProvider`) and **enforced at runtime** by `tryAcquireSpawn` / `releaseSpawn` in `lib/providers/index.mjs` (D38 — see Amendment 6). Saturation surfaces as `ProviderError(CONCURRENCY_LIMIT)`, which the fallback engine treats as a hard trigger per ADR 0004 Amendment 4 — the chain advances to the next hop. If the entire chain is saturated, the user receives a chain-exhausted error via the existing `executeWithFallback` exhaustion path. (Pre-D38 caveat removed; tracking issue #1 closed by Amendment 6.)
  - `maxSpawnTimeMs` — optional integer, milliseconds; maximum wall-clock time OLP allows for a single provider spawn before treating it as a hard fallback trigger. Defaults to `600000` (10 minutes) if absent. Enforcement lives inside each provider plugin's spawn drain loop (`_spawnAndStream`), which uses a `setTimeout` / `proc.kill` / `reject` pattern to throw `ProviderError(SPAWN_TIMEOUT)`; the fallback engine then treats this error as a hard trigger (ADR 0004 § Trigger taxonomy — Hard triggers bullet 4). The engine itself does not run the timer loop; it only acts on the thrown error.
  - `cacheable` — optional boolean, default `true`; if explicitly set to `false`, the provider opts out of OLP's response cache entirely. `executeHopFn` skips `cacheStore.getOrCompute` and calls `collectAllChunks` directly; no cache read or write occurs for any request to this provider. Omitting the field is equivalent to `cacheable: true`. See ADR 0005 § "Cache write conditions" item 3 and Amendment 3 above. (D23)

**Loading model.** `lib/providers/index.mjs` is a hand-maintained static enumeration. There is no filesystem scan, no `require.context`, no dynamic discovery. Adding a provider requires:
1. Write `lib/providers/<name>.mjs` conforming to the contract.
2. Add one import + one entry to `lib/providers/index.mjs`.
3. Add a row to README's "Supported Providers" table.
4. File an inclusion ADR per ADR 0006's framework.

**Disable model.** Optional providers (tier-1 and tier-2 per ADR 0006) are present in the registry but `enabled: false` by default. Enable is a `~/.olp/config.json` toggle, plus the tier-2 consent flow described in spec §3.1. Disabling a provider does not require touching `server.mjs`.

**Boundary with `server.mjs`.** `server.mjs` knows about the registry and the contract; it does not know about specific providers. The fallback engine (ADR 0004), the cache layer (ADR 0005), and the dashboard (spec §4.6) all consume providers through the contract, not through provider-specific code paths.

## Consequences

**Positive**
- Adding a new provider is a four-step recipe with no `server.mjs` edits required. The recipe is explicit (file + registry + README + ADR), so a future contributor (including a future Claude session) cannot accidentally do steps 1–2 without 3–4.
- The contract is the test surface. A provider plugin can be tested in isolation against a contract conformance suite (`test-features.mjs` extended per spec §6 Phase 1), independent of `server.mjs`.
- `server.mjs` stays generic. There is no "is this Anthropic? then do special thing" path inside the core proxy loop. Provider-specific quirks live inside the provider plugin where they belong.
- Disabling a misbehaving provider (e.g., a ToS change announcement triggers fast-disable per spec §9 risks) is a config flip, not a code revert. The provider quarantine path spec §9 calls for is the existing config mechanism.

**Negative**
- The contract surface is real governance work. Adding a field to the contract (e.g., a new `streamingMode` or `toolUseShape`) is an ADR amendment per OLP ALIGNMENT.md, not a quick PR. This is intentional — contract drift is the path back to the monolithic-dispatcher problem the contract was built to prevent.
- Provider plugins have non-trivial duplication: every provider re-implements the same SSE-chunk-translation skeleton, the same auth-env-injection, the same spawn-with-timeout. `base.mjs` exists to absorb the truly-shared parts, but resisting the temptation to push provider-specific logic into `base.mjs` requires discipline.
- Some providers (notably Anthropic) have *much* more behavior to encode than others (Mistral Vibe is comparatively spartan). The contract has to be expressive enough for the rich case without being burdensome for the spartan case. Lossy translations are documented per-provider per ADR 0003.

**Mitigations**
- `base.mjs` provides shared helpers but does not implement the `Provider` contract itself. Provider plugins compose helpers; they do not inherit from a base class. This keeps the "what does this provider do?" question answerable by reading one file.
- The contract is versioned. v1.0 is the subset in this ADR; future additions (e.g., a `cancel()` method for in-flight request termination, or a `costPerToken` snapshot) require ADR amendment plus a contract-version bump. Old provider plugins continue to declare `contractVersion: '1.0'` and the loader handles the version gap.
- The provider inclusion ADR per ADR 0006 doubles as the contract-conformance review gate. A new provider's inclusion ADR must show how it satisfies each field of the contract; that review is the structural counter-measure against contract drift.

## Alternatives considered

**(a) Monolithic dispatch inside `server.mjs`.** A single function with `if/else if` per provider, each branch implementing spawn/quota/health inline. Rejected: this is the architectural shape that produced OCP's `server.mjs` length problem at *one* provider, and it does not survive contact with 8 candidate providers (anticipated 3 D + 2 C + 3 B, eight code paths once they all transition from Candidate to Enabled). Worse, it makes provider-disable a code change, which means fast-quarantine in response to a ToS announcement (spec §9) is a release event rather than a config flip.

**(b) Full external plugin discovery (npm-installable, runtime-loaded, hot-discoverable).** Plugins are npm packages; OLP scans `node_modules/@olp-providers/*` at startup; users `npm install` to add a provider. Rejected for v1.0 on three grounds: (1) the provider set is curated for ToS-risk reasons (ADR 0006), and "anyone can install any provider" defeats that curation; (2) the discovery layer is itself non-trivial code (manifest validation, version compatibility, security review of third-party plugin code) that does not earn its complexity at three to eight providers; (3) the contract has not stabilized enough — locking it as a stable plugin API before v1.0 ships is premature commitment.

**(c) Per-provider sub-processes / microservices.** Each provider runs as a separate Node.js process; `server.mjs` is a router that proxies to the right sub-process. Rejected as massive over-engineering for v1.0 traffic levels (family-scale, dozens of requests per hour, not hundreds per second). The spawn-per-request cost is already the dominant latency; sub-process IPC adds latency without buying anything until the maintainer is running OLP at a scale where one Node process is the bottleneck — which is not v1.0's problem.

**(d) Code generation from a YAML manifest per provider.** Each provider is described in YAML; a generator emits the corresponding `.mjs`. Rejected as a layer that does not pay for itself. The provider plugins are ~150–400 lines of hand-written code each; generating them from YAML would shift complexity from the `.mjs` to the YAML + generator + the round-trip when a generated file needs to be hand-tuned for a quirk. The generator-first approach also makes the `cli.js`-alignment equivalent (per-provider CLI behavior alignment per OLP ALIGNMENT.md) harder to enforce, because the source of truth becomes the YAML, not the spawned-binary's real behavior.

## Sources

- OLP v0.1 spec §4.2 (Plugin-based provider system, including the v1.0 Provider contract definition)
- OCP ADR 0003 (`models.json` as SPOT) — informs the "static enumeration, not filesystem scan" loading model
- OCP ADR 0005 — the context paragraph references OCP's `server.mjs` reaching 1667 lines at one provider; the plugin architecture is the structural response to that complexity scaling N×

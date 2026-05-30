# ADR 0002 — Plugin Architecture for Providers

- **Date:** 2026-05-23
- **Status:** Accepted (bootstrap)
- **Authors:** project maintainer (with AI drafting assistance)
- **Related:** OLP v0.1 spec §4.2; ADR 0001 (project founding); ADR 0003 (IR design); ADR 0006 (provider inclusion framework)

## Amendments

> **Note on numbering.** Sequence is 1, 3, 4, 5, 6, 7 — Amendment 2 was never written. The reserved slot was originally planned for a separate `maxConcurrent` ratification, but that content was folded into Amendment 1 (the retroactive contract-sync amendment) at filing time and the gap was not backfilled. The gap is intentional and load-bearing — no missing content; do not renumber Amendments 3+ to close it (cross-references to Amendment N from other docs would silently break).

> **Forward-pointer:** Amendment 9 (2026-05-29) — Provider `ISOLATION` Contract for Multi-Tenant Spawn Isolation — is located at the **end of this file** (after § Sources), not in this Amendments block. The placement is documented in Amendment 9's editorial note; the substance is the addition of an OPTIONAL `ISOLATION` named export to provider plugin modules, consumed by `lib/sandbox/manager.mjs` (per ADR 0014 Amendment 1) to compose per-spawn ephemeral-home + per-provider isolation primitives. Co-merge with ADR 0014 Amendment 1.

### Amendment 8 — 2026-05-26: Permit `quotaStatus()` direct-API access (READ-ONLY exemption) for plan-usage probes (D79–D80 — Phase 5)

- **Context:** ADR 0012 (Phase 5 charter) opens 2026-05-26 to port OCP's plan-usage probe (`ocp/server.mjs:842-1109`) into `lib/providers/anthropic.mjs:quotaStatus()`. The probe calls `POST https://api.anthropic.com/v1/messages` directly with an OAuth bearer and parses `anthropic-ratelimit-unified-*` response headers. This violates the plugin contract's implicit assumption that ALL provider interaction goes through `spawn` (the binary CLI). `ALIGNMENT.md` Rule 2 (provider-CLI-as-authority) further constrains plugins to operations the provider CLI itself performs. The OCP-derived plan-usage probe satisfies neither of these — it bypasses `claude -p` and hits the public API directly. **Without an explicit exemption Amendment, D80 is unalignable.**
- **Why the exemption is sound:** The probe is strictly **READ-ONLY** (one `POST /v1/messages` with `max_tokens: 1`; the response body is discarded; only response headers are parsed) AND **subscription-scope** (the OAuth bearer is the same one Claude Code uses for `claude -p`; no extra grant is requested) AND **idempotent** (probe failure returns `null`, never throws to a caller). The "what authority backs this?" answer is: Anthropic's CLI internally makes the same `/v1/messages` call (verified 2026-05-26 by `strings` on the compiled binary — see `~/.cc-rules/memory/learnings/anthropic_plan_usage_probe_schema_2026_05_26.md`); the probe is mirroring an established CLI behaviour rather than introducing a new wire format. Under `ALIGNMENT.md` Rule 2, mirroring observed CLI behaviour is permitted; the Rule's intent is "don't invent wire formats Anthropic's CLI does not perform", which the probe respects.
- **Change — extend the Provider contract description:**
  - `quotaStatus(authContext): { quotaInfo }` is now permitted to call provider HTTP APIs directly, subject to **all three** constraints:
    1. **READ-ONLY** — the API call must not mutate provider-side state. POST is acceptable when the response is what's needed (Anthropic returns ratelimit headers on `POST /v1/messages`); the request body MUST minimise side-effects (`max_tokens: 1`, dummy `messages`).
    2. **Subscription-scope reuse** — the credentials used MUST be the same auth artifact the spawn path already reads via `readAuthArtifact()`. No new OAuth grant, no new API-key registration, no separate scopes.
    3. **Idempotent failure** — if the probe fails for any reason (network error, 401, 429, schema parse failure), the function returns a structured shape (`{ probe_status: 'unreachable', failure: { kind, message, backoff_until? } }` since v0.5.1; see ADR 0013 Rule 6 + ADR 0008 Amendment 2) rather than throwing. The caller (server.mjs / dashboard / `olp usage` CLI) gracefully degrades. At v0.5.0 the failure shape was the literal value `null`; v0.5.1 refined this to a structured shape so operators can distinguish auth failures from rate-limit failures from network failures from in-backoff stale-cache. The substantive idempotent-failure constraint (no throw to caller) is unchanged.
  - `healthCheck()` and other contract methods are NOT extended by this Amendment. Only `quotaStatus()` may make direct API calls. A plugin that wants live data for any other contract method must continue to use `spawn` or `readAuthArtifact`.
  - The probe MUST cache its result. Recommended TTL: 5 minutes (mirrors OCP `USAGE_CACHE_TTL`). Tighter TTLs (e.g. dashboard's 1-minute refresh) are served from the cached value if fresh; cache miss triggers a real probe.
  - The probe MUST implement exponential backoff on refresh failures: minimum 60s, maximum 3600s (mirrors OCP `OAUTH_REFRESH_MIN_BACKOFF` / `OAUTH_REFRESH_MAX_BACKOFF`). Tight loop on failure has historically burned through Anthropic's rate limit in seconds (OCP institutional lesson 2026-04).
  - The probe MUST be opt-in via `~/.olp/config.json` (`providers.<name>.quota_probe_enabled: true`; default `false`). Reasoning: a fresh OLP install on a machine without OAuth credentials should not bombard `api.anthropic.com` with 401-bound probes; the operator opts in once the credentials are configured.
- **What this Amendment does NOT permit:**
  - Mutating API calls (e.g. POST/PATCH/DELETE that change provider-side state). Still forbidden.
  - API calls for any contract method other than `quotaStatus()`. `spawn` / `healthCheck` / `doctorChecks` / `estimateCost` / `models` / `hints` / `name` / `displayName` / `auth` remain spawn-and-filesystem-only.
  - Per-provider new auth grants. The probe uses the spawn path's existing credentials.
  - Bypassing the alignment.yml blacklist. The hallucinated `/api/oauth/usage` token stays blacklisted; the probe uses `/v1/messages` (real endpoint).
  - **API calls to endpoints not explicitly enumerated by the companion ADR 0013 § Rule 2.** Amendment 8 permits the *kind* of call (READ-ONLY direct API for quota probing); ADR 0013 Rule 2 enumerates *which specific endpoint* is permitted. A future reader of Amendment 8 alone should NOT infer that any READ-ONLY/idempotent endpoint is fair game — the per-endpoint containment is locked to ADR 0013. Re-opening per-endpoint scope requires an ADR 0013 amendment, not a new plugin-level interpretation of Amendment 8.
- **Backwards compatibility:** Plugins whose `quotaStatus()` still returns `null` (mistral at v0.5.0 pending D84 audit, codex permanently per Phase 5 charter) are NOT affected. No existing behaviour changes for them.
- **Authority cited at the implementation:** D80 commit cites this Amendment + `~/.cc-rules/memory/learnings/anthropic_plan_usage_probe_schema_2026_05_26.md` + `Claude Code v2.1.x § OAuth bearer + ratelimit-unified headers` + live-probe transcript from 2026-05-26 in the commit body. ALIGNMENT.md Rule 1 + Rule 5 (CI) both satisfied.
- **Tests:** Suite 38 (Phase 5 D83) covers the probe: mock HTTP server returning all 13 `anthropic-ratelimit-unified-*` headers; assert parse correctness for each; assert 5min cache; assert 60s-3600s exponential backoff on simulated 429; assert stale-cache-on-failure. At v0.5.0 stale-failure returned `{ stale: true, ... }` with `null` reserved for no-cache failures; v0.5.1 refined the return contract — `null` is now reserved STRICTLY for opt-in-off, and all failure modes (auth / rate-limit / schema-drift / network / no-creds) return `{ probe_status: 'unreachable' | 'stale', failure: {...} }`. See `test-features.mjs` Suite 38 (38u/38v/38w added for the v0.5.1 hotfix regression coverage of F1 / F2 / F3 per codex review).
- **Procedural mechanism:** Iron Rule 11 (IDR) — this Amendment, ADR 0012 (Phase 5 charter), and ADR 0013 (OAuth READ-ONLY consumption rules) land together at D79 as a single coupled commit. Reviewing them separately cannot verify consumer-producer alignment. Iron Rule 10 fresh-context reviewer per CLAUDE.md hard requirement #3.

### Amendment 7 — 2026-05-26: Add OPTIONAL `doctorChecks()` to the Provider contract (D67 — Phase 4 operator UX)

- **Context:** ADR 0010 § Phase 4 D64-D67 ships `bin/olp.mjs` operator CLI + `olp doctor` framework. `olp doctor` runs a set of `Check` objects (id / category / async `run()` returning `{ status, message, evidence? }`) and discriminates the next remediation step via a `kind` field (`noop` / `fix_server` / `fix_oauth` / `fix_provider` / `fresh_install`). The framework needs per-provider checks so a user with a broken `claude` install gets a different fix recipe than a user with a broken `vibe` install. Hardcoding the recipes in `bin/olp.mjs` would re-introduce the kind of per-provider knowledge drift that ADR 0002 § Decision exists to prevent — when a new provider plugin lands, the operator CLI would have to be edited too.
- **Change — add to Provider contract:**
  - Introduce **OPTIONAL** `doctorChecks()` returning `DoctorCheck[]` where each `DoctorCheck` has the shape:
    - `id: string` — unique per check, conventionally `<provider>.<probe-name>` (e.g. `anthropic.cli_available`, `anthropic.oauth_token_present`).
    - `category: 'provider'` — fixed for plugin-contributed checks. The framework reserves `'server'`, `'auth'`, `'config'`, `'system'` for built-in checks.
    - `async run(): { status: 'ok' | 'fail' | 'warn', message: string, evidence?: { fix_commands?: string[], human_steps?: string[], reference?: string } }` — runs the probe. `status: 'fail'` makes `olp doctor` exit non-zero and contributes to the `kind: fix_provider` discriminator; `evidence.fix_commands[]` is concatenated into `next_action.ai_executable[]` and `evidence.human_steps[]` into `next_action.human_required[]`.
- **Backwards compatibility:** Plugins that omit `doctorChecks()` contribute zero provider checks. Their healthCheck() return value continues to flow through `/health.providers.status.<name>` exactly as today. No existing plugin behaviour changes; no existing test breaks. `validateProvider` in `lib/providers/base.mjs` is updated to type-check `doctorChecks` only when present (must be a function); absence is allowed.
- **What `doctorChecks()` is for vs. what `healthCheck()` is for:**
  - `healthCheck()` answers "is this provider currently usable?" — checked at the request-execution layer; output feeds `/health` and per-request retry decisions.
  - `doctorChecks()` answers "if this provider is broken, what specific actionable steps fix it?" — checked at the operator layer; output feeds `olp doctor` + the `next_action.ai_executable[]` repair templates that a downstream AI agent can paste-and-run.
- **Suggested probe set (per plugin):**
  - `<provider>.cli_available` — spawn `<bin> --version` with short timeout (≤3s); fail → fix_commands include install instruction.
  - `<provider>.<auth-artifact>_present` — check whether the auth file / env var the plugin's `readAuthArtifact()` reads is populated; fail → human_steps include the login command (which usually requires browser interaction and so cannot be in `ai_executable[]`).
- **Authority:** ADR 0010 § Phase 4 D64-D67 (this is the addition called out by that charter). No provider CLI doc citation needed — `doctorChecks()` is an internal contract field. Implementation lands in D67 (this PR): `lib/providers/anthropic.mjs`, `lib/providers/codex.mjs`, `lib/providers/mistral.mjs` each gain a `doctorChecks()` method covering `cli_available` + `<auth-artifact>_present`.
- **Tests:** Suite 32 (`bin/olp.mjs` CLI smoke) and Suite 33 (`olp doctor` framework) in `test-features.mjs` cover the contract amendment. Suite 33 specifically asserts: (a) a plugin without `doctorChecks()` contributes no provider checks (default behaviour), (b) a plugin with a failing `doctorChecks()` probe triggers `kind: fix_provider` and propagates its `evidence.fix_commands[]` into `next_action.ai_executable[]`, (c) all-passing checks yield `kind: noop`.
- **Procedural mechanism:** CC 开发铁律 v1.6 § 11 (IDR) — the contract amendment, the plugin implementations, the doctor framework, and the CLI scaffold are tightly coupled. They land as a single PR (D64-D67 bundle) because reviewing them separately cannot verify that consumer + producer line up. Iron Rule 10 fresh-context reviewer per CLAUDE.md hard requirement #3.

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

---

### Amendment 9 — 2026-05-29: Provider `ISOLATION` Contract for Multi-Tenant Spawn Isolation (Phase 7, ADR 0014 Amendment 1 co-merge)

> **Editorial note.** Per the existing "amendments most-recent-first" convention near the top of this file, Amendment 9 logically slots between Amendment 8 and the original body. It is physically located at the file's tail (after § Sources) to honor the constitution's "append, do not rewrite" discipline for this addition — the rationale is that the contract surface added here is large enough (a structured per-provider sub-export, not just a hint-bag field) that an in-line edit of the § Decision body would constitute a rewrite of the v1.0 contract listing rather than an amendment over it. Future readers consulting the amendment-history block at the top of the file will find a stub forward-pointer to this section.
>
> The amendment is otherwise a peer of Amendments 1–8 (same `###` heading depth, same shape).

#### Context

The OLP spawn pipeline currently treats every provider as a plain `child_process.spawn` of the provider's CLI binary with a homogeneous env block and the server process's working directory. This works on a single-tenant developer laptop. It does **not** work on the family-LAN PI231 deployment (multi-key, multi-caller, single OS user) and is a hard blocker for the cloud rollout described in `docs/plans/cloud-deployment-family.md` § 5 — both for the reasons captured in the 2026-05-27 incident memory at `~/.cc-rules/memory/projects/olp/incident_2026_05_27_spawn_cli_security.md` (OAuth-token exfiltration, codex `shell` tool real execution, cross-tenant filesystem read leakage).

The parallel ADR 0014 Amendment 1 retires the **outer-bwrap PR-B approach** — which initialized `@anthropic-ai/sandbox-runtime` `SandboxManager` once at server startup and wrapped every provider spawn through a global namespace — and replaces it with a **per-spawn ephemeral-home + per-provider isolation primitives** architecture. The new shape of `lib/sandbox/manager.mjs` is no longer a thin wrapper around `wrapSpawn()`; it is an orchestrator that, on each spawn, asks the provider plugin *what isolation primitives this provider needs*, composes them, and hands the spawn a ready-to-execute environment.

The thing the orchestrator asks for is the subject of this amendment: the **Provider `ISOLATION` contract**.

#### The interaction surface this amendment governs

```text
                  ┌──────────────────────────────────────┐
                  │ server.mjs handleChatCompletions     │
                  │   → executeHopFn                     │
                  │   → provider.spawn(irRequest, ...)   │
                  └────────────────────┬─────────────────┘
                                       │
                                       ▼
                  ┌──────────────────────────────────────┐
                  │ lib/sandbox/manager.mjs              │
                  │   prepareIsolatedEnvironment(        │
                  │     provider,                        │
                  │     { keyId, reqId, ... }            │
                  │   )                                  │
                  │     ↓ reads provider.ISOLATION       │
                  │     ↓ mkdtemp ephemeralRoot          │
                  │     ↓ mkdir requiredHomePaths        │
                  │     ↓ symlink/copy credentialMounts  │
                  │     ↓ compose ephemeralEnvOverrides  │
                  │     ↓ wrap args via toolHardening    │
                  └────────────────────┬─────────────────┘
                                       │
                                       ▼
                  ┌──────────────────────────────────────┐
                  │ child_process.spawn(bin, args, {     │
                  │   env: composedEnv, cwd: epRoot, ... │
                  │ })                                   │
                  └──────────────────────────────────────┘
```

The provider plugin is the **authority** for what isolation primitives are needed. The provider knows what env var its CLI honors for credential lookup (`HOME`, `CODEX_HOME`, `VIBE_HOME`, …). The provider knows whether the CLI has an inner sandbox that must be permitted to clone user namespaces. The provider knows the cross-tenant read protection regime it ships under. The orchestrator's job is purely composition; it must not know that "for codex, use `CODEX_HOME`" — that knowledge belongs in `lib/providers/codex.mjs`.

This is the same separation-of-concerns principle that has governed every prior amendment to this ADR: provider-specific knowledge lives in the provider file; the orchestrator stays generic. Amendment 7's `doctorChecks()` followed it (per-provider repair recipes); Amendment 8's `quotaStatus()` followed it (per-provider probe authorities); this amendment follows it for isolation primitives.

#### Decision — add OPTIONAL `ISOLATION` named export to the Provider plugin module

Each provider plugin module (`lib/providers/<name>.mjs`) MAY export, in addition to the default-exported provider object, a named const `ISOLATION` describing the isolation primitives the orchestrator should compose for spawns of this provider. The shape is:

```javascript
export const ISOLATION = {
  ephemeralEnvOverrides: ({ ephemeralRoot, keyId, reqId }) => ({ /* env var map */ }),
  credentialMounts: [ [srcAbsPath, dstRelativeToEphemeralRoot], ... ],
  requiredHomePaths: [ /* dirs to mkdir empty under ephemeralRoot */ ],
  hasInnerSandbox: boolean,
  crossTenantReadProtection: 'tool-suppression' | 'inner-sandbox' | 'none',
  recommendedDeploymentTier: 'shared-os-user' | 'per-os-user' | 'separate-vm',
  toolHardeningArgs: (existingArgs) => modifiedArgs,  // optional
}
```

The export is **optional**. A plugin that omits `ISOLATION` continues to spawn under the legacy unsandboxed shape exactly as it does today — see § Backward compatibility below. The opt-in surface is consistent with Amendment 7's `doctorChecks()` treatment (additive, no breakage for plugins that haven't been touched).

The remainder of this amendment specifies each field's semantics, default-when-absent behavior, validation rules, and authority citations. The three currently-shipped providers' concrete declarations are specified in § Per-provider concrete instances.

#### Field specification

##### 1. `ephemeralEnvOverrides({ ephemeralRoot, keyId, reqId }) → { [envVar]: string }`

**Type and semantics.** A pure (no-side-effect, no-fs-touch) function that, given the orchestrator's composed context (`ephemeralRoot`: absolute path to the spawn-scoped temp dir; `keyId`: the OLP key identity from `lib/keys.mjs` driving the request; `reqId`: the per-request UUID), returns a flat object of environment variables that the orchestrator will merge into the spawn env. The returned env vars are how the provider CLI is steered to read its credentials from the ephemeral root rather than the server process's actual home directory.

**Why a function and not a static object.** Because `ephemeralRoot` is generated per-spawn by `mkdtemp` and is not known at plugin load time. Because `keyId` and `reqId` are not known until the request arrives. A static object cannot carry the dependency on these values; a function carries it cleanly.

**Purity contract.** The function MUST be referentially transparent w.r.t. its argument object: identical input arguments yield identical output env maps. It MUST NOT read the filesystem, spawn subprocesses, or mutate the input arguments. It MUST NOT close over module-level mutable state. This contract is what makes the spawn pipeline auditable: a reviewer reading `provider.ISOLATION.ephemeralEnvOverrides({ ephemeralRoot: '/tmp/x', keyId: 'k1', reqId: 'r1' })` can know the full env mutation without running the system.

**Default behavior when absent.** When `ISOLATION` is absent or `ISOLATION.ephemeralEnvOverrides` is missing, the orchestrator MUST emit no environment overrides for that provider — `child_process.spawn` runs with `process.env` (possibly modified by other contract layers such as the existing `spawn()` method's env cleanup, ADR 0009 Amendment 1's `--system-prompt` injection, etc.). This preserves Phase 6c / pre-Phase 7 behavior exactly.

**Validation rules.** At plugin load (in `validateProvider` or a sibling `validateIsolation` helper):
- If `ISOLATION` is defined and `ephemeralEnvOverrides` is defined, it MUST be a function. A non-function value (e.g., a static object) is a load-time error.
- The function is NOT invoked at load time — its return shape is not validated until first spawn. Load-time invocation would require synthetic dummy arguments and would couple the validator to the orchestrator's argument shape (which itself may evolve under future ADR 0014 amendments).
- First-spawn invocation MUST validate the return value is a plain object whose values are all strings. Non-string values (numbers, booleans, undefined) MUST cause the spawn to abort with a clear error rather than coerce silently — the env block crosses a kernel boundary and silent coercion is a footgun.

**Authority citation requirement.** Each env var returned must correspond to a documented credential-resolution lookup in the underlying provider CLI. For example, `HOME` is a POSIX convention for credential lookup (well-established, no citation needed beyond the POSIX umbrella). `CODEX_HOME` is documented (primary) at https://developers.openai.com/codex/config-reference (2 occurrences verified 2026-05-29: `$CODEX_HOME/profile-name.config.toml` and `$CODEX_HOME/log` path templates), with secondary corroboration at https://developers.openai.com/codex/auth/ (2 occurrences in the credential-storage section: `auth.json under CODEX_HOME`). `VIBE_HOME` is documented at https://docs.mistral.ai/mistral-vibe/terminal/configuration (3 occurrences verified 2026-05-29: descriptive sentence "Override the location with the `VIBE_HOME` environment variable", canonical `export VIBE_HOME="/path/to/custom/vibe/home"` example, and an enumeration of files/directories `VIBE_HOME` affects). The provider plugin author MUST cite the underlying CLI's env-var documentation in the plugin file's header (the same place existing CLI-flag citations live, per Rule 1 of `ALIGNMENT.md`).

Inventing an env var the provider CLI does not actually honor (e.g., setting `MISTRAL_HOME=...` when no such env var exists) is a Rule 2 violation and is unalignable per Rule 4 of `ALIGNMENT.md`.

##### 2. `credentialMounts: [ [srcAbsPath, dstRelativeToEphemeralRoot], ... ]`

**Type and semantics.** An array of `[src, dst]` tuples describing how the server process's real on-disk credential artifacts (OAuth tokens, API keys, refresh artifacts) are made available inside the ephemeral home. The orchestrator iterates this list and, for each tuple, ensures `<ephemeralRoot>/<dst>` resolves (via symlink, copy, or bind-mount depending on platform and constraints) to the data at `<src>`.

The mount strategy is a property of the orchestrator, not the provider — `lib/sandbox/manager.mjs` decides between symlink (cheapest, on macOS and unconfined Linux), copy (when crossing a namespace boundary that breaks symlinks), and bind-mount (under a future bwrap-equipped path). The provider only declares the source-destination correspondence.

**Why this is a list, not a function.** The mounts are static per-provider: anthropic always mounts `~/.claude/.credentials.json`, codex always mounts `~/.codex/auth.json`. A function form would invite plugin authors to compute mount paths from per-request state, which would be a security hazard (per-request mount lists are harder to audit at code-review time). Forcing the static form makes the credential surface visible by `grep ISOLATION lib/providers/*.mjs`.

**Default behavior when absent.** Empty mount list — the spawn sees no credential files in its ephemeral home. For most providers this means authentication fails and the spawn errors out cleanly; the orchestrator MUST log a clear "no credentialMounts declared" message before allowing the spawn to proceed, since the most common cause is "plugin author forgot to declare the mount."

**Validation rules.**
- Each entry MUST be a 2-tuple (length-2 array). Single-element entries or 3+-tuples are load-time errors.
- `srcAbsPath` MUST be an absolute path (starts with `/`). Relative paths or `~/`-prefixed paths are load-time errors — the plugin author must call `os.homedir()` explicitly. Rationale: `~/` expansion semantics vary between Node and shells and would silently break under the per-spawn ephemeral home (where `HOME` is rewritten).
- `dstRelativeToEphemeralRoot` MUST NOT start with `..` (no parent-directory escape) and MUST NOT be absolute (no `/etc/passwd` overlay attempts). Both are load-time errors. The orchestrator's path-composition (`path.join(ephemeralRoot, dst)`) is the *only* path-resolution step that touches the destination — the validation forbids constructions that could escape `ephemeralRoot` even before composition.
- `srcAbsPath` MAY refer to a path that does not exist at plugin-load time. The orchestrator's mount step does a `existsSync(src)` check at spawn-time and logs a "credential source missing" warning rather than failing the spawn — this is consistent with the existing `auth.path` field behavior in the Provider contract (an absent credential file is an auth condition, not a load-time error).
- Two mounts with the same `dst` is a load-time error (no implicit ordering or override).

**Authority citation requirement.** Each `srcAbsPath` MUST correspond to the credential location documented by the underlying provider CLI. For anthropic: `~/.claude/.credentials.json` is the OAuth artifact per `claude` CLI docs (already cited by the plugin's `auth.path` field). For codex: `~/.codex/auth.json` per https://developers.openai.com/codex/auth/. For mistral: `~/.vibe/.env` per https://docs.mistral.ai/mistral-vibe/terminal/configuration. Plugin authors MUST cite the same authority as the `auth.path` field they already declare — the citations should be consistent.

##### 3. `requiredHomePaths: [ /* relative paths */ ]`

**Type and semantics.** An array of relative paths (e.g., `['.claude', '.claude/logs']`) that the orchestrator MUST `mkdir -p` under `ephemeralRoot` before any `credentialMounts` are processed and before the spawn begins. These are directories the provider CLI expects to exist in `HOME` and will fail or behave incorrectly if they're absent (e.g., logging directories that the CLI doesn't auto-create).

**Why a separate field from `credentialMounts`.** Some providers expect empty directories — not mounted credential files — at certain paths. Treating "empty directory" as a mount with src=null would muddle the validation rules for `credentialMounts`. A dedicated list is cleaner.

**Default behavior when absent.** Empty list — only the directories implied by `credentialMounts[i].dst` (their parent dirs, created by `mkdir -p` during the mount step) exist under `ephemeralRoot`. For most providers this is fine.

**Validation rules.**
- Each entry MUST be a relative path string. Same anti-escape rules as `credentialMounts[i].dst`: no leading `..`, no absolute paths.
- Entries MAY overlap with `credentialMounts[i].dst` parent paths (no error; orchestrator's `mkdir -p` is idempotent).
- Duplicate entries are not an error (idempotent), but the linter / future CI grep should flag them as a code smell.

**Authority citation requirement.** None directly required for the path values themselves — these are typically convention (e.g., `.claude` mirrors the CLI's expected `$HOME/.claude` layout). However, if a plugin declares a `requiredHomePaths` entry that does not correspond to any documented CLI behavior, the plugin's header comment should explain *why* the directory must exist (observed behavior, error message from CLI, etc.). Speculative directories ("just in case the CLI wants this") are a Rule 2 violation — only directories whose absence is known to cause CLI failure should be listed.

##### 4. `hasInnerSandbox: boolean`

**Type and semantics.** A boolean flag declaring whether this provider's CLI spawns its own internal sandbox boundary during normal operation. The orchestrator uses this flag to decide whether the outer isolation primitives need to be loosened to permit nested sandboxing (e.g., allow `clone(CLONE_NEWUSER)` syscalls, permit `bwrap` to nest).

**Why a boolean and not an enum.** "Has inner sandbox or not" is the discriminator the orchestrator needs. The *kind* of inner sandbox (bwrap, sandbox-exec, seccomp-only) is a detail the orchestrator does not need to compose against — it just needs to know whether to relax the outer profile. If a future provider requires per-sandbox-flavor handling, this field can be widened to an enum in a subsequent amendment.

**Default behavior when absent.** Treated as `false`. This is the safer-by-default value — outer isolation stays at its strictest setting. A provider that actually has an inner sandbox but forgets to declare it will fail at spawn time (inner-bwrap attempts denied by outer profile); the failure mode is loud and obvious, which is the desired behavior.

**Validation rules.** MUST be a literal `true` or `false`. Truthy/falsy coercion (e.g., declaring `1` or `'yes'`) is a load-time error — booleans are the documented type and coercion would silently change the orchestrator's composition decision.

**Authority citation requirement.** A `hasInnerSandbox: true` declaration MUST cite the CLI's documented or observed inner-sandbox behavior in the plugin header. For codex, the citation is `openai/codex#16018` (the GitHub issue documenting `codex exec` invoking bubblewrap internally) plus https://developers.openai.com/codex/concepts/sandboxing (the official docs page describing the `--sandbox` flag and `read-only` default). For a hypothetical future provider, the citation is whatever CLI doc or observed-behavior transcript establishes the inner sandbox.

##### 5. `crossTenantReadProtection: 'tool-suppression' | 'inner-sandbox' | 'none'`

**Type and semantics.** A discriminated string declaring the regime under which this provider's spawn is protected against cross-tenant filesystem reads. The three values correspond to the three regimes observed in the 2026-05-27 prior-art / incident analysis (see incident memory § 6):

- `'tool-suppression'` — the provider's CLI exposes no filesystem-reading tools to the model during the spawn, because OLP suppresses them at the request level. For anthropic, this is achieved via ADR 0009 Amendment 1's `--system-prompt` injection combined with the absence of `--tools` flags: the model has no shell, no file-read, no bash, no Read/Write/Edit primitives. The cross-tenant read surface is closed at the prompt-engineering layer; OS-level isolation is a defense in depth but not the primary regime.

- `'inner-sandbox'` — the provider's CLI has tool execution (e.g., codex's `shell` tool, which actually runs commands) but the CLI's own inner sandbox prevents the tool from reading paths outside its declared allow-list. For codex, the inner bwrap sandbox enforces `--sandbox read-only` by default (per https://developers.openai.com/codex/concepts/sandboxing), so even though the model can call `shell`, the shell's reads are confined to the inner namespace. The cross-tenant read surface is closed at the inner-sandbox layer.

- `'none'` — no protection regime is currently established for this provider. The model may have tools that read files, and there is no inner sandbox blocking those reads. Operationally this means the provider should NOT be enabled in a multi-tenant deployment until a regime is established. The orchestrator MUST log a WARN at server boot when a provider with `crossTenantReadProtection: 'none'` is enabled in a deployment with >1 active OLP key — observability, not enforcement (see Rule 4 compliance below).

**Why a discriminated enum, not a free-form string.** The orchestrator and the operator dashboard both consume this field. Free-form values would require every consumer to perform string-matching against a moving target. The enum locks the consumer surface; future regimes are added by amending this list in a subsequent ADR 0002 amendment.

**Default behavior when absent.** Treated as `'none'`. Safer-by-default in the WARN sense (operators get the WARN log) but NOT in the security sense (no protection is actually applied). This is intentional: the orchestrator cannot fabricate a protection regime the plugin hasn't implemented; the WARN nudges the plugin author to declare honestly.

**Validation rules.** MUST be one of the three enum values literally. Any other string is a load-time error. The orchestrator MUST log the field's value at server startup so operators can audit the protection picture across providers at a glance.

**Authority citation requirement.**
- `'tool-suppression'` declarations MUST cite the suppression mechanism (e.g., for anthropic: ADR 0009 Amendment 1 § "--system-prompt" + the absence-of-tools posture documented at the incident memory § 6.1).
- `'inner-sandbox'` declarations MUST cite the CLI doc or observed behavior establishing the inner sandbox (e.g., for codex: `openai/codex#16018` + https://developers.openai.com/codex/concepts/sandboxing).
- `'none'` is the safer default and requires no citation but MUST be accompanied by a header-comment TODO documenting what regime is expected to be established when the provider transitions from Candidate to Enabled (or earlier if the provider is enabled in a multi-tenant context).

##### 6. `recommendedDeploymentTier: 'shared-os-user' | 'per-os-user' | 'separate-vm'`

**Type and semantics.** A discriminated string giving operators a deployment-topology recommendation for this provider in a multi-tenant context. The three values express increasing degrees of operator-side isolation:

- `'shared-os-user'` — the OLP server process runs as a single OS user, and multiple OLP keys share that user. Protection against cross-tenant leakage rests entirely on the provider's `crossTenantReadProtection` regime + the orchestrator's ephemeral-home composition. This is the recommended posture for providers where `crossTenantReadProtection` is `'tool-suppression'` AND `hasInnerSandbox: false` (i.e., the model has no filesystem-touching tools at all).

- `'per-os-user'` — each OLP key (or each tenant) should map to a separate OS user, with file-permission-level isolation between tenants. The recommended posture for providers with `crossTenantReadProtection: 'inner-sandbox'` — the inner sandbox protects against accidental leakage from the model's tools, but a sandbox-escape (e.g., a CVE in bubblewrap, a misconfigured inner profile) would expose the OS-user filesystem; per-OS-user isolation adds defense in depth.

- `'separate-vm'` — the provider should not be co-located with any other tenant on the same VM. The recommended posture for providers with `crossTenantReadProtection: 'none'` AND/OR ones where the operator has reason to distrust the inner sandbox's quality. Practically this means the provider should not be enabled in OLP's family-LAN deployment unless the family-LAN host runs only this tenant.

**Why a recommendation and not a hard policy.** The orchestrator and OLP runtime cannot *enforce* OS-user separation or VM separation — those are properties of the host operator's deployment topology. This field is informational: it surfaces in `/health.providers.<name>.isolation` (a Phase 7 addition planned in a follow-up amendment) and in the dashboard, so operators making deployment decisions have the per-provider recommendation visible. Operator override is the expected normal path: a deployment that knowingly accepts the risk of running an `'separate-vm'` provider in a shared-user context is acceptable, just observable.

**Default behavior when absent.** Treated as `'separate-vm'` — the safest recommendation in the absence of declared analysis. The WARN log emitted for missing `ISOLATION` blocks (see Rule 4 compliance below) covers operator visibility.

**Validation rules.** MUST be one of the three enum values literally. Any other string is a load-time error.

**Authority citation requirement.** The plugin author MUST cite the basis for the recommendation in the plugin header — typically a short paragraph reasoning about the combination of `hasInnerSandbox` and `crossTenantReadProtection` for this provider. The reasoning is not a CLI authority citation (the underlying CLI does not declare deployment topology); it is an OLP-side analysis. The expected citation form is `# isolation rationale: <2-3 sentences> (cf. ADR 0014 Amendment 1 § <relevant section>)`.

##### 7. `toolHardeningArgs: (existingArgs) => modifiedArgs` (OPTIONAL)

**Type and semantics.** An OPTIONAL pure function that, given the plugin's `spawn()` method's CLI args (the array passed to `child_process.spawn`), returns a (possibly modified) args array with additional tool-hardening flags inserted. The orchestrator calls this hook after the plugin's `spawn()` constructs its args but before the actual `child_process.spawn` invocation.

**Purpose.** Some providers expose CLI flags that suppress or restrict the model's tool access at the per-spawn level (e.g., `--disallowedTools` on `claude`, or `--sandbox read-only` on `codex`). These flags are the *enforcement mechanism* corresponding to the `crossTenantReadProtection` *declaration*. Splitting the declaration (a static field) from the enforcement (a function that mutates args) keeps the contract auditable while letting the enforcement evolve as the underlying CLI's flag set changes.

**Why this is OPTIONAL.** For providers where `crossTenantReadProtection: 'tool-suppression'` is achieved entirely via the `spawn()` method's existing args construction (e.g., the existing anthropic.mjs `--system-prompt` injection), no separate hardening step is needed — the field can be omitted. For providers where the orchestrator needs to inject additional flags atop the plugin's base args, the field provides the hook.

**Default behavior when absent.** No args modification — the plugin's `spawn()` method's args are passed through to `child_process.spawn` unchanged. This is the current Phase 6c behavior for anthropic and is appropriate when the `spawn()` method already encodes the hardening.

**Validation rules.**
- If declared, MUST be a function.
- First-spawn invocation MUST validate the return value is an array of strings. Non-array or non-string-element returns abort the spawn (silent coercion is unsafe at the kernel boundary).
- The function MUST be referentially transparent — same input array yields same output array (no module-level state, no fs reads).
- The orchestrator MUST NOT pass the args by reference in a way that the function could mutate the original `existingArgs`. The hook receives a defensive copy; returning a fresh array is required.

**Authority citation requirement.** The injected flags MUST be documented CLI flags of the underlying provider. Inventing a `--disable-tools` flag that the CLI does not support is a Rule 2 violation. For codex, citing https://developers.openai.com/codex/concepts/sandboxing § `--sandbox` is sufficient. For anthropic, the existing ADR 0009 Amendment 1 citation covers the tool-suppression mechanism.

#### Per-provider concrete instances

The three currently-shipped providers declare `ISOLATION` as follows. Each declaration MUST be present in the corresponding plugin file before that provider can be enabled in any multi-tenant deployment (see § Rule 4 compliance and § Backward compatibility for the transition path).

##### anthropic

```javascript
// lib/providers/anthropic.mjs
//
// isolation rationale: Anthropic Claude reaches OLP via stream-json transport
// without a tool surface (ADR 0009 Amendment 1's --system-prompt injection
// suppresses env-block, file tools, bash, and Read/Write/Edit). The model
// has no documented mechanism to read files during the spawn. Cross-tenant
// read protection is achieved at the prompt-engineering / CLI-flag layer.
// The OS-level isolation primitives (HOME redirect + ephemeral credential
// mount) add defense in depth against future CLI changes that might
// re-introduce a tool surface.
//
// Authority: @anthropic-ai/claude-code v2.1.150 § --system-prompt
//   (ADR 0009 Amendment 1 + incident memory § 6.1 establishes the
//   tool-suppression mechanism); HOME env conventional POSIX behavior.

export const ISOLATION = {
  ephemeralEnvOverrides: ({ ephemeralRoot, keyId, reqId }) => ({
    HOME: ephemeralRoot,
    // CLAUDE_CONFIG_DIR is NOT honored as of v2.1.150 — the CLI reads from
    // $HOME/.claude/.credentials.json. Redirecting HOME is the documented
    // mechanism. The keyId / reqId arguments are unused here but received for
    // signature consistency with codex's overrides.
  }),
  credentialMounts: [
    // OAuth artifact location. Authority: existing anthropic.mjs `auth.path`
    // field — `~/.claude/.credentials.json` is the documented OAuth artifact.
    // The orchestrator resolves the absolute src path via os.homedir() at
    // load time (the plugin file shows the literal `join(homedir(), ...)`).
    [/* resolved at load: */ '<homedir>/.claude/.credentials.json',
     '.claude/.credentials.json'],
  ],
  requiredHomePaths: [
    '.claude',
    // No observed behavior requires additional dirs; CLI creates session logs
    // under .claude/ on demand. If future CLI versions add a mandatory pre-
    // existing subdir, add it here with an observed-behavior comment.
  ],
  hasInnerSandbox: false,
  crossTenantReadProtection: 'tool-suppression',
  recommendedDeploymentTier: 'shared-os-user',
  // toolHardeningArgs omitted — the existing spawn() method's args already
  // encode the --system-prompt suppression (ADR 0009 Amendment 1).
};
```

**Authority pin for the anthropic ISOLATION declaration:**
- `--system-prompt` mechanism: ADR 0009 Amendment 1 + incident memory `~/.cc-rules/memory/projects/olp/incident_2026_05_27_spawn_cli_security.md` § 6.1
- `HOME` env redirect: POSIX convention; `claude` CLI v2.1.150 observed to read `~/.claude/.credentials.json` via HOME (verified by the PR-B PI231 spike, confirmed by ADR 0014 Amendment 1's HOME-override verification task)

##### codex

```javascript
// lib/providers/codex.mjs
//
// isolation rationale: OpenAI Codex's `codex exec` exposes a shell tool that
// actually executes commands during the spawn (incident memory § 3.2). The
// CLI provides its own inner bubblewrap sandbox (`--sandbox read-only` by
// default per https://developers.openai.com/codex/concepts/sandboxing) that
// confines shell tool reads/writes. The orchestrator's outer isolation
// composes with the inner sandbox: HOME-equivalent redirect via CODEX_HOME
// (per https://developers.openai.com/codex/config-reference) plus per-spawn
// ephemeral credential mount. hasInnerSandbox: true so the outer profile is
// relaxed to permit inner bwrap's user-namespace clone.
//
// Authority: openai/codex#16018 (inner bwrap behavior);
//   https://developers.openai.com/codex/concepts/sandboxing (--sandbox flag);
//   https://developers.openai.com/codex/config-reference (CODEX_HOME);
//   https://developers.openai.com/codex/auth/ (~/.codex/auth.json path).

export const ISOLATION = {
  ephemeralEnvOverrides: ({ ephemeralRoot, keyId, reqId }) => ({
    // CODEX_HOME overrides the base config / credential dir. Docs:
    // https://developers.openai.com/codex/config-reference and
    // https://developers.openai.com/codex/auth/
    CODEX_HOME: `${ephemeralRoot}/.codex`,
    // HOME also redirected for codex's own bubblewrap-internal HOME lookup
    // (the inner sandbox inherits parent HOME unless overridden).
    HOME: ephemeralRoot,
  }),
  credentialMounts: [
    // Auth artifact location. Authority: existing codex.mjs `auth.path` field
    // (Codex CLI reference § Authentication, plus
    // https://developers.openai.com/codex/auth/ canonical pin).
    [/* resolved at load: */ '<homedir>/.codex/auth.json',
     '.codex/auth.json'],
  ],
  requiredHomePaths: [
    '.codex',
    // Inner bwrap may create additional state under .codex/. If observed
    // behavior shows the CLI failing on absent subdirs, add them here.
  ],
  hasInnerSandbox: true,
  crossTenantReadProtection: 'inner-sandbox',
  recommendedDeploymentTier: 'per-os-user',
  toolHardeningArgs: (existingArgs) => {
    // If the operator has not explicitly passed --sandbox, inject the
    // documented read-only default. Per
    // https://developers.openai.com/codex/concepts/sandboxing the default
    // posture is `read-only`; this hardening hook makes the default explicit
    // at the spawn args level so a future CLI default change does not
    // silently weaken the isolation.
    if (existingArgs.some(arg => arg === '--sandbox' || arg.startsWith('--sandbox='))) {
      return existingArgs;
    }
    return [...existingArgs, '--sandbox', 'read-only'];
  },
};
```

**Authority pin for the codex ISOLATION declaration:**
- `CODEX_HOME`: https://developers.openai.com/codex/config-reference (retrieved 2026-05-29)
- `~/.codex/auth.json`: https://developers.openai.com/codex/auth/ (existing `auth.path` citation in codex.mjs)
- Inner bwrap behavior: `openai/codex#16018` plus https://developers.openai.com/codex/concepts/sandboxing
- `--sandbox read-only`: https://developers.openai.com/codex/concepts/sandboxing § "Sandboxing modes"

##### mistral

```javascript
// lib/providers/mistral.mjs
//
// isolation rationale: Mistral Vibe ships at OLP Phase 7 with no known
// equivalent to Anthropic's Phase 6c --system-prompt tool suppression and
// no known inner sandbox. The IR-level normalization shipped at D8 does not
// suppress tools at the CLI layer. Cross-tenant read protection is therefore
// 'none' — the provider should not be enabled in a multi-tenant deployment
// until a regime is established. The declaration here exists so the
// orchestrator can compose ephemeral-home credential isolation (which still
// works) while the operator sees a clear WARN that the tool-side protection
// is not in place.
//
// Authority: TBD — a spike task tracked at Phase 7 follow-up (see Open
//   Questions section below) will verify Vibe CLI's tool surface and inner
//   sandbox posture against https://docs.mistral.ai/mistral-vibe/terminal/.
//   Until that spike lands, this declaration documents the current honest
//   state per ALIGNMENT.md Rule 3 (Match the Implementation): no protection
//   is encoded because none has been established.

export const ISOLATION = {
  ephemeralEnvOverrides: ({ ephemeralRoot, keyId, reqId }) => ({
    // VIBE_HOME is documented at
    // https://docs.mistral.ai/mistral-vibe/terminal/configuration as the
    // env var that overrides the default ~/.vibe/ base directory
    // (3 occurrences verified 2026-05-29: descriptive sentence,
    // canonical export example, and an enumeration of files/dirs the
    // variable affects). Task #4 PI231 spike verifies observed CLI
    // behaviour matches the documented contract.
    VIBE_HOME: `${ephemeralRoot}/.vibe`,
    HOME: ephemeralRoot,
  }),
  credentialMounts: [
    // ~/.vibe/.env per existing mistral.mjs `auth.path` field, sourced from
    // https://docs.mistral.ai/mistral-vibe/terminal/configuration.
    [/* resolved at load: */ '<homedir>/.vibe/.env', '.vibe/.env'],
  ],
  requiredHomePaths: [
    '.vibe',
  ],
  hasInnerSandbox: false,
  crossTenantReadProtection: 'none',
  recommendedDeploymentTier: 'separate-vm',
  // toolHardeningArgs omitted — no CLI hardening flag is currently known for
  // Vibe. The Phase 7 spike will revisit.
};
```

**Authority pin for the mistral ISOLATION declaration:**
- `VIBE_HOME`: https://docs.mistral.ai/mistral-vibe/terminal/configuration (3 occurrences verified 2026-05-29: descriptive sentence "Override the location with the `VIBE_HOME` environment variable", canonical `export VIBE_HOME="/path/to/custom/vibe/home"` example, and the enumeration of files/directories `VIBE_HOME` affects).
- `~/.vibe/.env`: same source (existing `auth.path` citation in mistral.mjs).
- **Open spike (Phase 7 follow-up, Task #4):** verify *observed CLI behaviour* matches *documented behaviour* — (a) Vibe CLI actually honours the documented `VIBE_HOME` env var during spawn; (b) Vibe CLI's tool surface (shell, file-read, etc.) during a `vibe --prompt` spawn; (c) any CLI sandbox or tool-suppression flag. Findings may transition `crossTenantReadProtection` from `'none'` to `'tool-suppression'` or `'inner-sandbox'` if a hardening regime is discovered. The spike is verification-grade, not authority-pin work.

#### Backward compatibility

A plugin that does NOT export `ISOLATION` continues to work exactly as it does today. The orchestrator's `prepareIsolatedEnvironment(provider, ctx)` function MUST detect the absence of `provider.ISOLATION` (or the absence of any individual field within it) and fall through to the legacy unsandboxed code path for that spawn. The legacy path is:

- No ephemeral root created
- No env overrides
- No credential mounts
- `cwd: process.cwd()` (the server's working directory)
- `env: process.env` (composed with whatever the plugin's `spawn()` method's existing env logic produces)

This is the same behavior as Phase 6c. No provider plugin is broken by Amendment 9's landing.

Plugins MAY adopt `ISOLATION` incrementally: a plugin that wants the credential-mount benefit but has not yet analyzed its cross-tenant tool surface MAY declare `crossTenantReadProtection: 'none'` and `recommendedDeploymentTier: 'separate-vm'` (the safer-by-default values). The orchestrator will compose the credential isolation correctly; the WARN log nudges follow-up.

#### Rule 4 compliance (ALIGNMENT.md)

ALIGNMENT.md Rule 4 states: "Unalignable plugins / fields are deleted, not feature-flagged." This amendment introduces an OPTIONAL contract field, which on its face could be read as "feature-flagging" isolation. The reading is wrong, and the distinction is important enough to spell out:

- Amendment 9 does NOT introduce an `ISOLATION` feature flag that operators or plugins toggle on/off. The field's presence/absence describes **the provider's truthful isolation posture** at a point in time. A plugin without `ISOLATION` declares (implicitly) that no analysis has been done and the safer-by-default treatment applies.
- The OPTIONAL nature is purely transitional. Existing plugins ship without it; they continue to spawn (in their existing single-tenant developer-laptop posture). The orchestrator's WARN log surfaces the absence to the operator at server boot. An operator running a multi-tenant deployment with un-declared plugins is operating off-recommendation but not blocked.
- A plugin that declares `ISOLATION` with values the orchestrator cannot honor (e.g., a `credentialMounts` entry pointing at a path that does not exist, or an `ephemeralEnvOverrides` function that returns non-string values) MUST fail at first spawn — the orchestrator does not silently fall back to the no-ISOLATION path. This is the Rule 4 enforcement vector: a *broken* declaration is unalignable and surfaces loudly; a *missing* declaration is the safer transitional state.

The WARN at server boot is observability, not enforcement. It reads approximately:

```
[WARN] provider "<name>" does not declare ISOLATION; spawns will run
       under legacy unsandboxed shape. Recommended in multi-tenant
       deployments: declare ISOLATION per ADR 0002 Amendment 9.
```

Operators in single-tenant developer deployments may safely ignore the WARN. Operators in multi-tenant deployments should treat it as a Phase 7 follow-up task.

#### Interaction with prior amendments

- **Amendment 1 (`maxSpawnTimeMs`).** Independent. The spawn-timeout enforcement lives inside each plugin's spawn drain loop; the orchestrator's ISOLATION composition happens *before* the spawn, so the two amendments compose without conflict.
- **Amendment 3 (`cacheable`).** Independent. The cache layer decides whether to call the orchestrator at all; once the orchestrator is reached, ISOLATION composition is orthogonal to cacheability.
- **Amendment 4 (`contractVersion`).** Independent. `contractVersion: '1.0'` plugins MAY add an `ISOLATION` export under Amendment 9 without bumping the contract version — `ISOLATION` is an additive named export, not a v1.0 contract surface change. A future Provider contract v1.1 may promote `ISOLATION` to a required field (forcing all enabled plugins to declare); that decision is deferred to a future amendment, gated on the Phase 7 follow-up findings.
- **Amendment 6 (`maxConcurrent` runtime enforcement).** Independent. The semaphore acquire happens before the orchestrator's `prepareIsolatedEnvironment`; the release happens after the spawn drains. ISOLATION composition is bracketed by the semaphore, not entangled with it.
- **Amendment 7 (`doctorChecks()`).** Adjacent. A future plugin may add an `<provider>.isolation_declared` doctor check that reports whether `ISOLATION` is declared and whether its referenced credential paths resolve. The check is OPTIONAL per Amendment 7's framework and is appropriate for `olp doctor` operator UX.
- **Amendment 8 (`quotaStatus()` direct-API exemption).** Independent. The quota probe runs outside the spawn pipeline (direct HTTPS from server process); it does not interact with `ISOLATION` composition.

#### Companion ADR

This amendment is the companion governance piece for **ADR 0014 Amendment 1** (the Phase 7 architectural shift from outer-bwrap PR-B to per-spawn ephemeral-home + per-provider primitives). ADR 0014 Amendment 1 describes the orchestrator's composition algorithm and the rationale for retiring the outer-bwrap approach; ADR 0002 Amendment 9 (this section) describes the contract surface the orchestrator reads.

The two amendments are reviewed and merged together as a single coupled commit (Iron Rule 11 — minimum reviewable unit per layer). Reviewing them separately cannot verify producer-consumer alignment: the orchestrator's algorithm is meaningless without the contract it consumes, and the contract is meaningless without the orchestrator's composition discipline.

#### Tests

Test coverage for Amendment 9 lands as a new Suite in `test-features.mjs` co-merged with ADR 0014 Amendment 1's `lib/sandbox/manager.mjs` refactor. The suite covers:

1. `validateProvider` (or `validateIsolation` helper) rejects each documented invalid shape: non-function `ephemeralEnvOverrides`; non-2-tuple `credentialMounts` entries; `dst` paths starting with `..` or absolute; non-boolean `hasInnerSandbox`; out-of-enum `crossTenantReadProtection`; out-of-enum `recommendedDeploymentTier`; non-function `toolHardeningArgs`.
2. The legacy code path: a fake provider without `ISOLATION` spawns under the existing shape unchanged. Existing Phase 6c tests for anthropic continue to pass.
3. The ephemeral-home composition path: a fake provider declaring a minimal `ISOLATION` block has its env overrides applied and its credential mount resolved into a `mkdtemp`-created ephemeral root.
4. First-spawn return-shape validation: `ephemeralEnvOverrides` returning non-string values aborts the spawn loudly; `toolHardeningArgs` returning a non-array aborts the spawn loudly.
5. Per-shipped-provider declaration smoke: each of `anthropic`, `codex`, `mistral` declares an `ISOLATION` block; each block's `credentialMounts[i][0]` (when resolved against the running user's `homedir()`) matches the plugin's `auth.path` field.

The full test list is captured in ADR 0014 Amendment 1's PR-B-revised test suite specification.

#### Open questions (Phase 7 follow-up)

1. **Mistral Vibe tool surface and inner sandbox.** The mistral plugin's `ISOLATION` declares `crossTenantReadProtection: 'none'` honestly. A spike task is required to determine whether Vibe CLI exposes any tool surface and/or any sandbox flag; findings update the declaration. Tracked at the Phase 7 work plan.
2. **HOME-only providers vs CODEX_HOME-style providers.** The current contract assumes credential redirection happens via env-var rewriting (`HOME` or `<PROVIDER>_HOME`). A future provider that hardcodes its credential path (no env override) would be unable to honor the contract and would need a different isolation strategy (e.g., bind-mount of the literal path). This is not a current problem (all three shipped providers honor env overrides) but should be tracked for future inclusion ADRs.
3. **Promoting `ISOLATION` to required at contract v1.1.** Once all enabled providers declare `ISOLATION`, a future contract-version bump may promote the field from OPTIONAL to REQUIRED. The decision is gated on operational experience after PI231 + cloud deployment — see ADR 0014 Amendment 1 for the rollout milestones.
4. **Per-spawn vs per-key ephemeral root.** This amendment specifies per-spawn ephemeral roots (one `mkdtemp` per `provider.spawn` call). A future optimization may cache ephemeral roots per-key (one ephemeral root per OLP key identity, reused across spawns) to reduce mkdtemp / mount overhead. The contract surface here is compatible with either strategy; the choice is an orchestrator implementation detail.
5. **Cleanup discipline.** The orchestrator is responsible for `rm -rf`-ing the ephemeral root after the spawn drains. The cleanup mechanism (synchronous vs deferred, error vs success path symmetry) is specified in ADR 0014 Amendment 1, not here. This amendment notes the dependency for completeness.

#### Authority citations summary

| Field | Authority |
|---|---|
| `ephemeralEnvOverrides` (general) | POSIX `HOME` convention; per-provider env-var documentation cited per declaration |
| `credentialMounts` (general) | Each plugin's existing `auth.path` field citation |
| `requiredHomePaths` (general) | Observed CLI behavior; no speculative entries (Rule 2) |
| `hasInnerSandbox` (general) | CLI doc or observed-behavior transcript |
| `crossTenantReadProtection` (enum) | OLP-side analysis based on prior-art search in incident memory `~/.cc-rules/memory/projects/olp/incident_2026_05_27_spawn_cli_security.md` § 4 + § 6 |
| `recommendedDeploymentTier` (enum) | OLP-side analysis; ADR 0014 Amendment 1 § Deployment topology |
| `toolHardeningArgs` (function) | Documented CLI flags of the underlying provider; no invented flags (Rule 2) |
| anthropic `--system-prompt` tool suppression | ADR 0009 Amendment 1 + incident memory § 6.1 |
| codex `CODEX_HOME` | https://developers.openai.com/codex/config-reference + https://developers.openai.com/codex/auth/ |
| codex inner bwrap | openai/codex#16018 + https://developers.openai.com/codex/concepts/sandboxing |
| codex `--sandbox read-only` default | https://developers.openai.com/codex/concepts/sandboxing § "Sandboxing modes" |
| mistral `VIBE_HOME` and `.vibe/.env` | https://docs.mistral.ai/mistral-vibe/terminal/configuration |

#### Procedural mechanism

- **Iron Rule 11 (Incremental Diff Review)** — Amendment 9 (governance, ADR 0002) and ADR 0014 Amendment 1 (orchestrator architecture) land as a single coupled PR. Reviewing them separately cannot verify consumer-producer alignment.
- **Iron Rule 10 (Code Review)** — independent fresh-context reviewer per `CLAUDE.md` hard requirement #3. The reviewer MUST open each cited authority URL (Codex config-reference, sandboxing docs, Mistral configuration docs, the incident memory) and confirm the citation in the review comment.
- **`ALIGNMENT.md` Rule 1 (Cite First)** — every per-field design choice is cited above. Every per-provider concrete instance is cited to the underlying CLI authority.
- **`ALIGNMENT.md` Rule 2 (No Invention)** — no invented env vars, no invented CLI flags. The mistral `crossTenantReadProtection: 'none'` declaration is the explicit honest acknowledgment that no protection regime has been established, rather than invention of one.
- **`ALIGNMENT.md` Rule 4 (Unalignable Plugins / Fields Are Deleted)** — see § Rule 4 compliance above for the explicit reasoning that OPTIONAL `ISOLATION` is not "feature-flagging" but rather "honestly transitional."

#### tuiSeed extension note (PR-0 co-merge, 2026-05-30)

`lib/sandbox/manager.mjs` adds a `tui` opt-in param to `prepareIsolatedEnvironment`. When `tui:true`, the orchestrator (a) chmod 700s the per-reqId dir and ephemeralRoot (spec §5.5 credential-wall), and (b) calls the module-private helper `_seedTuiClaudeJson(ephemeralRoot, seedSource)`. The helper reads `~/.claude.json` (or the override `tuiSeedSource`) once, copies `oauthAccount` and `userID` via object spread, strips `projects` entirely to avoid leaking the operator's real project history (spec §7.1), stamps `hasCompletedOnboarding:true` and `bypassPermissionsModeAccepted:true`, and writes the result to `join(ephemeralRoot, '.claude.json')` at mode 0o600. The seed carries NO MCP-disable weight — it does not set `claudeAiMcpEverConnected` or `mcpServers`; that is the spawn-argv flag `--strict-mcp-config` landed in PR-2 (spec §5.2 T6 negative control). The `projects` field is stripped unconditionally and is NOT re-populated with a pre-trusted `cwd` entry. **Correction to the original plan framing:** `bypassPermissionsModeAccepted:true` suppresses the bypass-permissions acceptance dialog only — it does **NOT** suppress the per-directory **trust-folder** dialog ("Is this a project you trust?"), which still appears for a fresh ephemeral `$HOME`. The pre-code spikes confirmed this (their playbook answers the trust dialog by sending "1"). PR-0 does not pre-trust because the spawn `cwd` is a PR-2 session-driver concern (not known at seed time) and the exact trust-field key is unverified; therefore **PR-2's session driver MUST answer the trust-folder dialog** (the spike-validated approach). Pre-trusting `projects[cwd]` in the seed remains an optional future optimization. Authority: claude CLI v2.1.158 first-run onboarding behavior (spec §7.1); the default (stream-json) code path is byte-for-byte unchanged.
- **`ALIGNMENT.md` Amendment Procedure** — this section (Amendment 9) is the PR-required citation of evidence (the 2026-05-27 incident memory, the ADR 0014 PoC spike report at `/tmp/sandbox-spike/report.md` on PI231) and the structural amendment of the Provider contract documented in this ADR's § Decision.

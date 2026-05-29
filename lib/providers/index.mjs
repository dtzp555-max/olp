/**
 * lib/providers/index.mjs — Static provider registry
 *
 * Authority: ADR 0002 § "Loading model"
 *
 * This file is a hand-maintained static enumeration. There is no filesystem
 * scan, no dynamic discovery, no npm-installed plugin loading. Adding a
 * provider requires: (1) write lib/providers/<name>.mjs, (2) add one import +
 * one entry to STATIC_REGISTRY below, (3) README § "Supported Providers",
 * (4) inclusion ADR per ADR 0006.
 *
 * At D4 (Phase 1 Day 2), the anthropic plugin is added to STATIC_REGISTRY
 * as a Candidate. It is NOT Enabled by default — a config with
 * { enabled: { anthropic: true } } is required, which only happens after D5
 * E2E audit passes per ALIGNMENT.md § Provider Inventory.
 *
 * At D6 (Phase 1 Day 4), the openai (Codex) plugin is added to STATIC_REGISTRY
 * as a Candidate. Enabled by { enabled: { openai: true } } after D7 E2E audit.
 *
 * At D8 (Phase 1 Day 5), the mistral (Mistral Vibe) plugin is added to
 * STATIC_REGISTRY as a Candidate. Enabled by { enabled: { mistral: true } }
 * after D-later E2E audit. Authority: ADR 0006 Tier D classification for
 * Mistral Vibe (Le Chat Pro); docs-based authority from
 * https://docs.mistral.ai/mistral-vibe/terminal/quickstart.
 *
 * D17 (Finding 12+13): alias resolution is centralised in getProviderForModel().
 * models-registry.json is the single source of truth for alias→canonical mapping.
 * All provider plugins expose canonical IDs only in their models[] field.
 */

import { validateProvider } from './base.mjs';
import anthropicDefault, { ISOLATION as anthropicISOLATION } from './anthropic.mjs';
import codexDefault, { ISOLATION as codexISOLATION } from './codex.mjs';
import mistralDefault from './mistral.mjs';
import modelsRegistryRaw from '../../models-registry.json' with { type: 'json' };

// Attach Phase 7 ISOLATION contract per ADR 0002 Amendment 9. The ISOLATION
// block is a top-level named export from each provider plugin; the loader
// attaches it as a property of the default-export object so the orchestrator
// (lib/sandbox/manager.mjs prepareIsolatedEnvironment) can read it as
// provider.ISOLATION. In-place mutation (not spread) preserves the default
// export's object identity, which downstream code (cache store keyed on
// provider, singleflight Maps) relies on. Providers without ISOLATION
// (mistral at present) fall through to legacy unsandboxed shape per
// ADR 0002 Amendment 9 § Backward compatibility.
if (anthropicISOLATION) anthropicDefault.ISOLATION = anthropicISOLATION;
if (codexISOLATION) codexDefault.ISOLATION = codexISOLATION;

const anthropic = anthropicDefault;
const codex = codexDefault;
const mistral = mistralDefault;

// ── Static registry ───────────────────────────────────────────────────────

const STATIC_REGISTRY = [
  anthropic,
  codex,
  mistral,
];

// ── Alias map (built once at module load) ─────────────────────────────────
// Maps aliasString → { providerName: string, canonicalModel: string }
// Sourced from models-registry.json providers[*].aliases — the SPOT for alias
// definitions per D17 Finding 12 fix. Each provider plugin's models[] contains
// only canonical IDs; this map is consulted by getProviderForModel() to resolve
// alias strings before the direct-lookup fallback.
//
// Example entries:
//   'sonnet'        → { providerName: 'anthropic', canonicalModel: 'claude-sonnet-4-6' }
//   'devstral'      → { providerName: 'mistral',   canonicalModel: 'devstral-2-25-12' }
//   'codex'         → { providerName: 'openai',    canonicalModel: 'gpt-5.3-codex' }
const _aliasMap = new Map();
for (const [providerName, providerEntry] of Object.entries(
  modelsRegistryRaw?.providers ?? {},
)) {
  for (const [alias, canonicalModel] of Object.entries(
    providerEntry?.aliases ?? {},
  )) {
    _aliasMap.set(alias, { providerName, canonicalModel });
  }
}

/**
 * Returns a defensive copy of the alias→{providerName, canonicalModel} map.
 * Used by handleModels in server.mjs to emit alias entries in /v1/models.
 * Defensive copy prevents caller mutation of the module-private _aliasMap.
 *
 * @returns {Map<string, { providerName: string, canonicalModel: string }>}
 */
export function getAliasMap() {
  return new Map(_aliasMap);
}

// ── Per-model stable created timestamps ───────────────────────────────────
// F12 (round-5 cold-audit): OpenAI spec treats `created` as a stable per-model
// attribute. Synthesizing Date.now() on each /v1/models request causes spurious
// updates for clients caching models by `created`. This map provides the stable
// per-model timestamp sourced from models-registry.json entries.
//
// Fallback: models-registry.json top-level `bootstrapCreated` is used when a
// model entry has no `created` field.

/** @type {number} Stable fallback timestamp for models with no per-entry `created` field. */
export const REGISTRY_BOOTSTRAP_CREATED = modelsRegistryRaw?.bootstrapCreated ?? 1778630400;

/** Map<modelId, createdUnixSeconds> — built at module load, never mutated. */
const _modelCreatedMap = new Map();
for (const providerEntry of Object.values(modelsRegistryRaw?.providers ?? {})) {
  for (const modelEntry of providerEntry?.models ?? []) {
    if (modelEntry?.id && typeof modelEntry.created === 'number') {
      _modelCreatedMap.set(modelEntry.id, modelEntry.created);
    }
  }
}

/**
 * Returns the stable Unix-epoch `created` timestamp for a given model ID.
 * Prefers the per-entry value from models-registry.json; falls back to
 * REGISTRY_BOOTSTRAP_CREATED when the entry has no `created` field.
 *
 * Per F12 (round-5 cold-audit): DO NOT use Date.now() for the `created` field
 * in /v1/models responses — OpenAI clients may cache models by `created` and
 * would see spurious updates on every poll if the timestamp varies per request.
 *
 * @param {string} modelId
 * @returns {number} Unix timestamp in seconds
 */
export function getModelCreated(modelId) {
  return _modelCreatedMap.get(modelId) ?? REGISTRY_BOOTSTRAP_CREATED;
}

// ── Registry functions ────────────────────────────────────────────────────

/**
 * Loads and validates providers, filtering by the enabled set in config.
 * At D4, the anthropic provider is Candidate only — it will not appear in
 * the loaded Map unless config.enabled.anthropic === true (set by D5 after E2E).
 *
 * @param {{ enabled?: Record<string,boolean> }} [config={}]
 * @returns {Map<string, import('./base.mjs').ProviderContractV1>}
 */
export function loadProviders(config = {}) {
  const loaded = new Map();

  for (const p of STATIC_REGISTRY) {
    const { valid, errors } = validateProvider(p);
    if (!valid) {
      throw new Error(`Provider ${p?.name ?? 'unknown'} fails contract validation: ${errors.join('; ')}`);
    }

    const enabled = config.enabled?.[p.name] === true;
    if (enabled) {
      loaded.set(p.name, p);
    }
  }

  return loaded;
}

/**
 * Returns the provider in `loadedProviders` that serves `modelString`, with
 * alias resolution. D17 Finding 12+13: this is the single lookup point (SPOT)
 * for model→provider routing. All callers (including buildDefaultChain) must
 * use this function instead of duplicating the scan loop.
 *
 * Resolution order:
 *   1. Alias lookup: if modelString is a known alias in models-registry.json
 *      AND the resolved provider is in loadedProviders (enabled), return the
 *      match with canonicalModel set to the canonical ID.
 *   2. Direct lookup: scan loadedProviders for any p.models.includes(modelString)
 *      (handles canonical IDs passed directly). Returns canonicalModel=modelString.
 *   3. null — no provider found.
 *
 * @param {Map<string, import('./base.mjs').ProviderContractV1>} loadedProviders
 * @param {string} modelString
 * @returns {{ provider: import('./base.mjs').ProviderContractV1, name: string, canonicalModel: string }|null}
 */
export function getProviderForModel(loadedProviders, modelString) {
  // Step 1: alias resolution via models-registry.json
  const aliasEntry = _aliasMap.get(modelString);
  if (aliasEntry) {
    const { providerName, canonicalModel } = aliasEntry;
    const provider = loadedProviders.get(providerName);
    if (provider) {
      return { provider, name: providerName, canonicalModel };
    }
    // Alias exists but target provider is not loaded (not enabled) — fall through.
  }

  // Step 2: direct canonical lookup
  for (const [name, p] of loadedProviders) {
    if (p.models.includes(modelString)) {
      return { provider: p, name, canonicalModel: modelString };
    }
  }

  return null;
}

/**
 * Looks up a provider by name in the loaded Map. Returns null if not found.
 * Useful for tests that need to access a specific provider directly.
 *
 * @param {Map<string, import('./base.mjs').ProviderContractV1>} loadedProviders
 * @param {string} name
 * @returns {import('./base.mjs').ProviderContractV1|null}
 */
export function getProviderByName(loadedProviders, name) {
  return loadedProviders.get(name) ?? null;
}

/**
 * Returns all provider names in the static registry (whether enabled or not).
 * Used by /health and diagnostics.
 * At D4: returns ['anthropic']; at D6: returns ['anthropic', 'openai'];
 * at D8: returns ['anthropic', 'openai', 'mistral'].
 *
 * @returns {string[]}
 */
export function listAllProviderNames() {
  return STATIC_REGISTRY.map(p => p.name);
}

// ── Concurrency semaphore (D38, issue #1) ─────────────────────────────────
//
// Authority: ADR 0002 Amendment 6 (maxConcurrent runtime enforcement landed in D38)
//           and ADR 0004 Amendment 4 (CONCURRENCY_LIMIT added to hard-trigger taxonomy).
//
// Per-provider in-flight spawn counter. The orchestration layer (server.mjs
// handleChatCompletions) calls tryAcquireSpawn() before provider.spawn() and
// releaseSpawn() after spawn lifecycle completion. On saturation, the caller
// synthesises a ProviderError(CONCURRENCY_LIMIT) which the fallback engine
// treats as a hard trigger — the chain advances to the next hop. If the
// entire chain is saturated, the user receives a chain-exhausted error via
// the existing executeWithFallback exhaustion path.
//
// Design decision (deliberate): immediate-advancement via fallback, NOT
// queue+timeout. Rationale (per D38 issue #1 design discussion):
//   1. The fallback chain exists precisely for this kind of overflow.
//   2. A queue introduces head-of-line blocking + a new timeout config surface.
//   3. Immediate-advancement gives fail-fast latency, matching the OLP
//      multi-provider proxy philosophy.
//   4. Queue+timeout is deferred — track via a future issue if real usage
//      shows need.
//
// **Atomicity invariant**: JavaScript is single-threaded; the
// read-then-write pair inside tryAcquireSpawn() executes synchronously with
// NO `await` between the check and the increment. This is the only reason
// the semaphore is correct without a Mutex. A future async refactor MUST
// preserve this — do NOT introduce an `await` between the limit check and
// the count update or the semaphore loses its mutual-exclusion guarantee
// (two callers could each read count=limit-1 before either increments).
//
// Module-level state: lives for the process lifetime; tests that need
// isolation should call __resetSpawnCounters() in their teardown.
//
// @type {Map<string, number>} provider name → current in-flight spawn count
const _activeSpawns = new Map();

/**
 * Default cap for tryAcquireSpawn when a plugin omits hints.maxConcurrent.
 *
 * validateProvider in base.mjs requires hints.maxConcurrent to be a
 * non-negative integer at startup, so a missing value should not happen in
 * production. This default is defense-in-depth for callers that pass a
 * stripped-down provider stub (e.g., in tests) or future plugin paths that
 * bypass validation. The value (4) matches the v0.1 plugin defaults
 * (anthropic / codex / mistral all declare hints.maxConcurrent: 4).
 */
export const DEFAULT_MAX_CONCURRENT_SPAWNS = 4;

/**
 * Atomically attempts to reserve a spawn slot for `providerName`.
 *
 * If the current in-flight count is below `maxConcurrent`, increments the
 * counter and returns true. Otherwise returns false WITHOUT incrementing —
 * the caller is responsible for surfacing the saturation as a
 * ProviderError(CONCURRENCY_LIMIT) for the fallback engine to consume.
 *
 * Atomicity: the check and the increment happen in a single synchronous
 * block with no `await` in between. See the module-level invariant comment
 * above for why this is sufficient.
 *
 * @param {string} providerName — provider key (e.g. 'anthropic')
 * @param {number} [maxConcurrent=DEFAULT_MAX_CONCURRENT_SPAWNS] — limit from hints.maxConcurrent
 * @returns {boolean} true if a slot was acquired, false if at limit
 */
export function tryAcquireSpawn(providerName, maxConcurrent = DEFAULT_MAX_CONCURRENT_SPAWNS) {
  // Defensive: coerce undefined/null/non-integer to the default. validateProvider
  // already enforces this at startup; this guards future plugin paths that
  // bypass validation.
  const limit = (typeof maxConcurrent === 'number' && Number.isInteger(maxConcurrent) && maxConcurrent >= 0)
    ? maxConcurrent
    : DEFAULT_MAX_CONCURRENT_SPAWNS;

  const current = _activeSpawns.get(providerName) ?? 0;
  // Atomic check-then-increment (no `await` between read and write).
  if (current >= limit) {
    return false;
  }
  _activeSpawns.set(providerName, current + 1);
  return true;
}

/**
 * Releases a spawn slot for `providerName`. Must be called exactly once per
 * successful tryAcquireSpawn() call, regardless of whether the spawn succeeded
 * or threw. The caller in server.mjs uses a try/finally pattern to guarantee
 * the release fires on every exit path (success, error, abort, streaming end).
 *
 * Throws if the count would go negative — that indicates a bug (a release
 * without a matching acquire, or a double-release). The throw is loud on
 * purpose so the bug surfaces in tests rather than silently corrupting the
 * counter for future requests.
 *
 * @param {string} providerName — provider key (e.g. 'anthropic')
 * @throws {Error} if no slot is currently held for providerName
 */
export function releaseSpawn(providerName) {
  const current = _activeSpawns.get(providerName) ?? 0;
  if (current <= 0) {
    throw new Error(
      `releaseSpawn(${providerName}): counter would go negative — release without matching acquire (or double-release)`,
    );
  }
  const next = current - 1;
  if (next === 0) {
    _activeSpawns.delete(providerName);
  } else {
    _activeSpawns.set(providerName, next);
  }
}

/**
 * Returns the current in-flight spawn count for `providerName`. Used by
 * /health, diagnostics, and tests that need to assert peak concurrency.
 *
 * @param {string} providerName
 * @returns {number} non-negative integer; 0 if no spawns in flight
 */
export function getActiveSpawnCount(providerName) {
  return _activeSpawns.get(providerName) ?? 0;
}

/**
 * @internal — test seam: reset all in-flight spawn counters to zero. Used by
 * test teardown to ensure a clean state across suites. Production code MUST
 * NOT call this — it bypasses the acquire/release pairing invariant.
 */
export function __resetSpawnCounters() {
  _activeSpawns.clear();
}

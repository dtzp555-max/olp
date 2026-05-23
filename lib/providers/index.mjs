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
 */

import { validateProvider } from './base.mjs';
import anthropicDefault from './anthropic.mjs';
import codexDefault from './codex.mjs';

// Normalize default export pattern
const anthropic = anthropicDefault;
const codex = codexDefault;

// ── Static registry ───────────────────────────────────────────────────────

const STATIC_REGISTRY = [
  anthropic,
  codex,
];

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
 * Returns the first provider in `loadedProviders` whose `models[]` includes
 * the exact `modelString`. Returns null if no provider is found.
 *
 * This is the naive lookup strategy for D4. Phase 2+ may add prefix/alias
 * matching once models-registry.json is consulted per AGENTS.md SPOT policy.
 *
 * @param {Map<string, import('./base.mjs').ProviderContractV1>} loadedProviders
 * @param {string} modelString
 * @returns {{ provider: import('./base.mjs').ProviderContractV1, name: string }|null}
 */
export function getProviderForModel(loadedProviders, modelString) {
  for (const [name, p] of loadedProviders) {
    if (p.models.includes(modelString)) {
      return { provider: p, name };
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
 * At D4: returns ['anthropic']; at D6: returns ['anthropic', 'openai'].
 *
 * @returns {string[]}
 */
export function listAllProviderNames() {
  return STATIC_REGISTRY.map(p => p.name);
}

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
 * At D3 (Phase 1 Day 1), the registry is intentionally empty.
 * 0 Enabled Providers per ALIGNMENT.md § Provider Inventory.
 * Phase 1 Day 2+ will add the anthropic plugin.
 */

import { validateProvider } from './base.mjs';

// ── Static registry ───────────────────────────────────────────────────────

// Phase 1 Day 2+ will add imports here, e.g.:
//   import * as anthropic from './anthropic.mjs';
// And push to STATIC_REGISTRY, e.g.:
//   STATIC_REGISTRY.push(anthropic.default ?? anthropic);

const STATIC_REGISTRY = [];

// ── Registry functions ────────────────────────────────────────────────────

/**
 * Loads and validates providers, filtering by the enabled set in config.
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
 * This is the naive lookup strategy for D3. Phase 2+ may add prefix/alias
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
 * Returns all provider names in the static registry (whether enabled or not).
 * Used by /health and diagnostics.
 *
 * @returns {string[]}
 */
export function listAllProviderNames() {
  return STATIC_REGISTRY.map(p => p.name);
}

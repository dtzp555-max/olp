/**
 * lib/sandbox/manager.mjs — Sandbox manager + ephemeral-home orchestrator (Phase 7 PR-B')
 *
 * Authority:
 *   OLP ADR 0014 Amendment 1 — Solution 1 four-layer architecture
 *     § A1.2.1 — Layer 1: per-spawn ephemeral home directory
 *     § A1.2.2 — Layer 2: symlinked credential files into ephemeral home
 *     § A1.2.3 — Layer 3: optional sandbox-runtime per-call customConfig
 *     § A1.6.1 — OLP_SANDBOX_DISABLED gate (preserved 1-2 releases)
 *   OLP ADR 0002 Amendment 9 — Provider ISOLATION contract specification
 *     § Field specification (ephemeralEnvOverrides, credentialMounts,
 *       requiredHomePaths, hasInnerSandbox, toolHardeningArgs)
 *   @anthropic-ai/sandbox-runtime v0.0.52
 *     dist/sandbox/sandbox-manager.js — SandboxManager.wrapWithSandbox()
 *     The third argument `customConfig` is the per-call override mechanism.
 *   2026-05-29 PI231 spike (docs/spikes/2026-05-29-ephemeral-home.md):
 *     Verified HOME (claude) + CODEX_HOME (codex) redirect 100% of CLI state
 *     writes into ephemeral location. Credentials via symlink work end-to-end.
 *
 * Design (Amendment 1 architecture):
 *
 *   Boot-time:
 *     bootstrapSandbox() — checks sandbox-runtime library + OS deps availability
 *     via doctor.mjs. Does NOT call SandboxManager.initialize() (per A1.2.3:
 *     Layer 3 is per-call, not boot-singleton). The singleton pattern from PR-B
 *     is removed entirely — per-spawn config eliminates its reason to exist.
 *
 *   Per-spawn (uncached /v1/chat/completions request):
 *     prepareIsolatedEnvironment({ provider, keyId, reqId }) — the main
 *     orchestrator entry point. Reads provider.ISOLATION, composes Layers 1–3:
 *       Layer 1: mkdir /tmp/olp-spawn/<keyId>/<reqId>/home
 *       Layer 2: symlink credentialMounts into ephemeralRoot
 *       Layer 3: wrapForLayer3 — when isSandboxActive() && !hasInnerSandbox,
 *                calls SandboxManager.wrapWithSandbox() per-call with
 *                per-spawn customConfig
 *     Returns { ephemeralRoot, envOverrides, hardenedArgs, wrapForLayer3, cleanup }.
 *
 *   OLP_SANDBOX_DISABLED=1 (A1.6.1 belt-and-suspenders gate):
 *     When set, Layers 1+2 still operate (ephemeral home + credential mounts).
 *     Layer 3 (wrapForLayer3) becomes identity. Preserved for 1-2 releases.
 *
 * Exports:
 *   bootstrapSandbox(opts?)          — preflight check; returns { available, reason?, summary? }
 *   isSandboxActive()                — synchronous; true when Layer 3 is operational
 *   prepareIsolatedEnvironment({ provider, keyId, reqId })
 *                                    — compose Layers 1+2+3; returns env + hooks + cleanup
 *   __resetSandboxManagerForTests()  — test seam: reset module state
 */

import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkSandboxAvailability } from './doctor.mjs';

// ── Internal state ────────────────────────────────────────────────────────

/**
 * Whether bootstrapSandbox() has completed (initialized = true means bootstrap
 * ran; does NOT mean sandbox is active).
 * @type {boolean}
 */
let _initialized = false;

/**
 * Whether the sandbox-runtime library is loaded and OS deps are present.
 * When true, Layer 3 (per-call wrapWithSandbox) is available.
 * @type {boolean}
 */
let _active = false;

/**
 * Cached failure reason string (when _active=false after bootstrap).
 * @type {string|null}
 */
let _failReason = null;

/**
 * Memoized sandbox-runtime module (loaded lazily on first prepareIsolatedEnvironment
 * call that needs Layer 3). Import caching is native ESM semantics; this variable
 * holds the resolved SandboxManager class after first load.
 * @type {object|null}
 */
let _SandboxManager = null;

// ── Ephemeral workspace root ─────────────────────────────────────────────
// /tmp/olp-spawn/<keyId>/<reqId>/home — unique per (key, request).
const SPAWN_BASE_DIR = '/tmp/olp-spawn';

// ── bootstrapSandbox ──────────────────────────────────────────────────────

/**
 * Preflight check for Layer 3 capability (sandbox-runtime library + OS deps).
 * Idempotent — safe to call multiple times; returns cached result after first call.
 *
 * This function NO LONGER calls SandboxManager.initialize() at boot.
 * Per ADR 0014 Amendment 1 § A1.2.3, Layer 3 uses per-call wrapWithSandbox()
 * with a per-spawn customConfig; the singleton boot-init pattern is removed.
 *
 * The OLP_SANDBOX_DISABLED=1 env-var gate (A1.6.1): when set, Layer 3 is
 * disabled. Layers 1+2 (ephemeral home + credential mounts) still operate.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] — re-run even if already bootstrapped
 * @returns {Promise<{ active: boolean, reason?: string, summary?: string }>}
 */
export async function bootstrapSandbox(opts = {}) {
  if (_initialized && !opts.force) {
    return _active
      ? { active: true, summary: _buildSummary() }
      : { active: false, reason: _failReason ?? 'sandbox not available' };
  }

  // OLP_SANDBOX_DISABLED gate (A1.6.1): operator emergency disable.
  // Layer 3 skipped; Layers 1+2 unaffected (ephemeral home + credential mounts).
  if (process.env.OLP_SANDBOX_DISABLED === '1') {
    _initialized = true;
    _active = false;
    _failReason = 'OLP_SANDBOX_DISABLED=1 — Layer 3 (sandbox-runtime wrap) disabled by operator; Layers 1+2 still active';
    return { active: false, reason: _failReason };
  }

  // Reset for re-bootstrap
  _initialized = false;
  _active = false;
  _failReason = null;

  // Check OS + library availability via doctor
  let availability;
  try {
    availability = await checkSandboxAvailability();
  } catch (e) {
    _initialized = true;
    _active = false;
    _failReason = `doctor check threw: ${e?.message ?? e}`;
    return { active: false, reason: _failReason };
  }

  if (!availability.available) {
    _initialized = true;
    _active = false;
    _failReason = availability.missing?.length > 0
      ? `sandbox deps missing: ${availability.missing.join(', ')}`
      : `sandbox not available on platform: ${availability.details?.platform}`;
    return { active: false, reason: _failReason };
  }

  // Verify sandbox-runtime import is available (lazy-load check only;
  // no SandboxManager.initialize() — per ADR 0014 Amendment 1 A1.2.3).
  try {
    const mod = await import('@anthropic-ai/sandbox-runtime');
    _SandboxManager = mod.SandboxManager;
  } catch (e) {
    _initialized = true;
    _active = false;
    _failReason = `sandbox-runtime import failed: ${e?.message ?? e}`;
    return { active: false, reason: _failReason };
  }

  _initialized = true;
  _active = true;
  return { active: true, summary: _buildSummary() };
}

/** @internal */
function _buildSummary() {
  return `Layer 3 available (sandbox-runtime loaded, OS deps present); per-spawn wrapWithSandbox enabled`;
}

// ── isSandboxActive ───────────────────────────────────────────────────────

/**
 * Synchronous query: is Layer 3 (per-call sandbox-runtime wrap) operational?
 * Returns true only if bootstrapSandbox() completed successfully AND
 * OLP_SANDBOX_DISABLED is not set.
 *
 * @returns {boolean}
 */
export function isSandboxActive() {
  return _active;
}

// ── prepareIsolatedEnvironment ────────────────────────────────────────────

/**
 * Compose per-spawn isolation primitives (Layers 1+2+3) for a single request.
 *
 * Reads provider.ISOLATION per ADR 0002 Amendment 9. If ISOLATION is absent,
 * returns the legacy unsandboxed shape (identity env, identity hooks, no cleanup).
 *
 * @param {object} params
 * @param {object} params.provider   — provider plugin object (may have .ISOLATION)
 * @param {string} params.keyId      — OLP key identity driving this request
 * @param {string} params.reqId      — per-request UUID
 * @returns {Promise<{
 *   ephemeralRoot: string|null,
 *   envOverrides: Record<string, string>,
 *   hardenedArgs: (args: string[]) => string[],
 *   wrapForLayer3: (command: string) => Promise<string>,
 *   cleanup: () => Promise<void>,
 * }>}
 */
export async function prepareIsolatedEnvironment({ provider, keyId, reqId }) {
  const isolation = provider?.ISOLATION;

  // ── Legacy unsandboxed path (no ISOLATION declared) ──────────────────────
  if (!isolation) {
    if (provider?.name) {
      console.warn(
        `[sandbox/manager] [WARN] provider "${provider.name}" does not declare ISOLATION; ` +
        `spawns will run under legacy unsandboxed shape. Recommended in multi-tenant ` +
        `deployments: declare ISOLATION per ADR 0002 Amendment 9.`,
      );
    }
    return _legacyShape();
  }

  // ── Layer 1: Create per-spawn ephemeral home ──────────────────────────────
  // /tmp/olp-spawn/<keyId>/<reqId>/home
  // keyId is sanitized to filesystem-safe characters (alphanumeric + hyphens).
  const safeKeyId = String(keyId ?? 'anon').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const safeReqId = String(reqId ?? 'req').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const ephemeralRoot = join(SPAWN_BASE_DIR, safeKeyId, safeReqId, 'home');

  try {
    mkdirSync(ephemeralRoot, { recursive: true });
  } catch (e) {
    throw new Error(
      `[sandbox/manager] Failed to create ephemeral root ${ephemeralRoot}: ${e?.message ?? e}`,
    );
  }

  // ── Layer 1 cont.: mkdir requiredHomePaths ────────────────────────────────
  const requiredPaths = isolation.requiredHomePaths ?? [];
  for (const relPath of requiredPaths) {
    if (typeof relPath !== 'string' || relPath.startsWith('..') || relPath.startsWith('/')) {
      throw new Error(
        `[sandbox/manager] provider "${provider.name}" ISOLATION.requiredHomePaths contains ` +
        `invalid entry "${relPath}" — must be a relative path with no leading .. or /`,
      );
    }
    const absPath = join(ephemeralRoot, relPath);
    mkdirSync(absPath, { recursive: true });
  }

  // ── Layer 2: Symlink credentialMounts ─────────────────────────────────────
  const mounts = isolation.credentialMounts ?? [];
  for (const mount of mounts) {
    if (!Array.isArray(mount) || mount.length !== 2) {
      throw new Error(
        `[sandbox/manager] provider "${provider.name}" ISOLATION.credentialMounts entry ` +
        `is not a 2-tuple: ${JSON.stringify(mount)}`,
      );
    }
    const [srcAbsPath, dstRel] = mount;

    // Validate src
    if (typeof srcAbsPath !== 'string' || !srcAbsPath.startsWith('/')) {
      throw new Error(
        `[sandbox/manager] provider "${provider.name}" ISOLATION.credentialMounts src ` +
        `"${srcAbsPath}" must be an absolute path (call os.homedir() in the plugin)`,
      );
    }
    // Validate dst
    if (typeof dstRel !== 'string' || dstRel.startsWith('..') || dstRel.startsWith('/')) {
      throw new Error(
        `[sandbox/manager] provider "${provider.name}" ISOLATION.credentialMounts dst ` +
        `"${dstRel}" must be a relative path with no leading .. or /`,
      );
    }

    if (!existsSync(srcAbsPath)) {
      console.warn(
        `[sandbox/manager] [WARN] provider "${provider.name}" credentialMount src ` +
        `"${srcAbsPath}" does not exist — spawn may fail auth`,
      );
      continue;
    }

    const dstAbs = join(ephemeralRoot, dstRel);
    // Ensure parent dir exists
    mkdirSync(dirname(dstAbs), { recursive: true });

    // Create symlink (skip if already exists — idempotent)
    if (!existsSync(dstAbs)) {
      try {
        symlinkSync(srcAbsPath, dstAbs);
      } catch (e) {
        throw new Error(
          `[sandbox/manager] Failed to symlink ${srcAbsPath} → ${dstAbs}: ${e?.message ?? e}`,
        );
      }
    }
  }

  // ── Compose envOverrides (Layer 1 output) ────────────────────────────────
  let envOverrides = {};
  if (typeof isolation.ephemeralEnvOverrides === 'function') {
    const raw = isolation.ephemeralEnvOverrides({ ephemeralRoot, keyId, reqId });
    if (raw === null || typeof raw !== 'object') {
      throw new Error(
        `[sandbox/manager] provider "${provider.name}" ISOLATION.ephemeralEnvOverrides ` +
        `must return a plain object; got ${typeof raw}`,
      );
    }
    // Validate all values are strings
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v !== 'string') {
        throw new Error(
          `[sandbox/manager] provider "${provider.name}" ISOLATION.ephemeralEnvOverrides ` +
          `returned non-string value for key "${k}": ${typeof v}`,
        );
      }
    }
    envOverrides = raw;
  }

  // ── Compose hardenedArgs (Layer 4 hook) ──────────────────────────────────
  const hardenedArgs = typeof isolation.toolHardeningArgs === 'function'
    ? (args) => {
        const copy = [...args];
        const result = isolation.toolHardeningArgs(copy);
        if (!Array.isArray(result)) {
          throw new Error(
            `[sandbox/manager] provider "${provider.name}" ISOLATION.toolHardeningArgs ` +
            `must return an array; got ${typeof result}`,
          );
        }
        for (const arg of result) {
          if (typeof arg !== 'string') {
            throw new Error(
              `[sandbox/manager] provider "${provider.name}" ISOLATION.toolHardeningArgs ` +
              `returned non-string element in args array: ${typeof arg}`,
            );
          }
        }
        return result;
      }
    : (args) => args;  // identity — provider encodes hardening in its own spawn()

  // ── Compose wrapForLayer3 ─────────────────────────────────────────────────
  // Layer 3: per-call sandbox-runtime wrap.
  // Skipped when:
  //   (a) hasInnerSandbox === true (codex — outer wrap would conflict with inner bwrap)
  //   (b) sandbox is not active (!_active — deps missing or OLP_SANDBOX_DISABLED=1)
  // When active + no inner sandbox: calls SandboxManager.wrapWithSandbox() per-spawn
  // with a per-spawn customConfig scoped to the ephemeralRoot.
  const hasInnerSandbox = isolation.hasInnerSandbox === true;
  const layer3Active = _active && !hasInnerSandbox;

  let wrapForLayer3;
  if (layer3Active && _SandboxManager) {
    const operatorHome = homedir();
    // Per-spawn customConfig: deny reads on real operator home; allow the
    // ephemeral home and /tmp. Cross-tenant deny list will be tightened in a
    // follow-up task once the base Layer 3 integration is validated (Task #9).
    // ADR 0002 Amendment 9 does NOT declare an allowedDomains field on the
    // ISOLATION contract. Network policy at Layer 3 is therefore the
    // orchestrator's responsibility, not the provider's. v1 defaults to empty
    // allowlist (kernel-level deny-all on outbound to non-trusted domains
    // would be added here in a follow-up ADR amendment once the contract
    // surface for "trusted-domains per provider" is ratified). For now: open
    // network (legacy behaviour, matches pre-Solution-1 spawn shape).
    const customConfig = {
      network: {
        allowedDomains: [],
        deniedDomains: [],
      },
      filesystem: {
        denyRead: [
          operatorHome,
          join(operatorHome, '.ssh'),
          join(operatorHome, '.gnupg'),
          join(operatorHome, '.olp'),
        ],
        allowRead: [ephemeralRoot],
        allowWrite: [ephemeralRoot, '/tmp'],
        denyWrite: [],
      },
    };

    const SM = _SandboxManager;
    wrapForLayer3 = async (commandString) => {
      try {
        return await SM.wrapWithSandbox(commandString, undefined, customConfig);
      } catch (e) {
        throw new Error(
          `[sandbox/manager] SandboxManager.wrapWithSandbox failed: ${e?.message ?? e}`,
        );
      }
    };
  } else {
    // Identity — no Layer 3 wrap (either hasInnerSandbox=true or sandbox inactive)
    wrapForLayer3 = async (commandString) => commandString;
  }

  // ── Cleanup (called by server after spawn completes) ─────────────────────
  const cleanup = async () => {
    // Walk up to /tmp/olp-spawn/<safeKeyId>/<safeReqId> and remove.
    // Best-effort: log + swallow errors (don't fail the response pipeline).
    const spawnDir = join(SPAWN_BASE_DIR, safeKeyId, safeReqId);
    try {
      await rm(spawnDir, { recursive: true, force: true });
    } catch (e) {
      console.warn(
        `[sandbox/manager] Warning: cleanup of ${spawnDir} failed: ${e?.message ?? e}`,
      );
    }
  };

  return {
    ephemeralRoot,
    envOverrides,
    hardenedArgs,
    wrapForLayer3,
    cleanup,
  };
}

// ── Legacy unsandboxed shape ──────────────────────────────────────────────

/**
 * Returns the identity shape used for providers without ISOLATION declared.
 * Per ADR 0002 Amendment 9 § Backward compatibility.
 */
function _legacyShape() {
  return {
    ephemeralRoot: null,
    envOverrides: {},
    hardenedArgs: (args) => args,
    wrapForLayer3: async (cmd) => cmd,
    cleanup: async () => { /* nothing to clean up — no ephemeral root was created */ },
  };
}

// ── Test seam ─────────────────────────────────────────────────────────────

/**
 * Reset module-level state so the test suite can simulate a fresh process.
 * Per ADR 0014 § Pitfalls #4: only safe in sequential test contexts with no
 * in-flight spawns.
 *
 * Note: Under Amendment 1, there is no SandboxManager singleton to reset
 * (no SandboxManager.reset() call) — the per-call pattern means the library's
 * internal state is transient per wrapWithSandbox() invocation.
 *
 * @returns {Promise<void>}
 */
export async function __resetSandboxManagerForTests() {
  _initialized = false;
  _active = false;
  _failReason = null;
  _SandboxManager = null;
}

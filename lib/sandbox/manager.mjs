/**
 * lib/sandbox/manager.mjs — Sandbox manager bootstrap + spawn-wrap (Phase 7 PR-B)
 *
 * Authority:
 *   @anthropic-ai/sandbox-runtime v0.0.52
 *   https://github.com/anthropic-experimental/sandbox-runtime
 *   dist/sandbox/sandbox-manager.js — SandboxManager.initialize(), wrapWithSandbox()
 *   dist/sandbox/sandbox-utils.js  — getDefaultWritePaths() (used internally)
 *
 *   2026-05-28 PR-A spike report on PI231 (arm64 Debian Bookworm):
 *     /tmp/sandbox-spike/spike-anthropic.mjs — wrapWithSandbox call signature,
 *     CLAUDE_CODE_OAUTH_TOKEN env passthrough, shell-mode spawn pattern.
 *   OLP ADR 0014 § Decision (singleton at boot) + § PR-B specific scope
 *   OLP ADR 0009 Amendment 1 § Caveats #3 (sandbox is cloud prerequisite)
 *   cc-mem incident 2026-05-27 § 3 (multi-tenant security gap motivation)
 *   ALIGNMENT.md Rule 1 — provider plugin authority citation
 *
 * Design:
 *   One-shot bootstrap at server startup (idempotent). If sandbox not available
 *   (doctor.available=false or SandboxManager.initialize throws), bootstrap is a
 *   no-op and isSandboxActive() returns false → provider falls back to direct spawn
 *   (transparent pass-through).
 *
 *   Singleton pattern: SandboxManager is a process-wide singleton per library
 *   design (reset() clears ALL state). PR-B initializes once at boot with union
 *   config (Anthropic domains only; codex config follows in PR-C). Per-request
 *   wrapSpawn() calls SandboxManager.wrapWithSandbox() which reads from the
 *   already-initialized config state — no per-request initialize().
 *
 *   ADR 0014 § Pitfalls #4: SandboxManager.reset() in test teardown must happen
 *   in finally blocks; concurrent in-flight spawns may break if reset fires while
 *   a wrapWithSandbox call is in-flight. OLP's current single-server model (one
 *   process) makes this safe: tests call __resetSandboxManagerForTests() which
 *   also calls SandboxManager.reset() — only safe in test context where no real
 *   spawns are in-flight.
 *
 * Exports:
 *   bootstrapSandbox(opts?)         — one-shot bootstrap; returns { active, reason?, summary? }
 *   isSandboxActive()               — synchronous query
 *   wrapSpawn({ bin, args, env, cwd, allowedDomains })
 *                                   — wraps spawn args; transparent pass-through when inactive
 *   __resetSandboxManagerForTests() — test seam: reset internal state + SandboxManager
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkSandboxAvailability } from './doctor.mjs';

// ── Internal state ────────────────────────────────────────────────────────

/**
 * Whether bootstrapSandbox() has been called (initialized = true means we
 * ran through bootstrap, not necessarily that sandbox is active).
 * @type {boolean}
 */
let _initialized = false;

/**
 * Whether the SandboxManager was successfully initialized and is ready to wrap.
 * @type {boolean}
 */
let _active = false;

/**
 * The config-at-boot snapshot passed to SandboxManager.initialize().
 * Null if never initialized or bootstrap failed.
 * @type {object|null}
 */
let _initConfig = null;

// ── Ephemeral workspace root ─────────────────────────────────────────────
// Per-request cwd: /tmp/olp-spawn/<uuid>/ — unique per request to prevent
// cross-request contamination. Caller (provider) owns cleanup (or trusts tmpfs
// lifetime). Created by mkdirSync(recursive:true) inside wrapSpawn().
const SPAWN_BASE_DIR = '/tmp/olp-spawn';

// ── Custom error types ───────────────────────────────────────────────────

export class SandboxBootstrapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SandboxBootstrapError';
  }
}

export class SandboxWrapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SandboxWrapError';
  }
}

// ── bootstrapSandbox ──────────────────────────────────────────────────────

/**
 * One-shot bootstrap of the sandbox. Idempotent — safe to call multiple times.
 * If already bootstrapped, returns cached result immediately.
 *
 * Steps:
 *   1. Call checkSandboxAvailability() from doctor module.
 *   2. If !available → set _active=false, return { active:false, reason }.
 *   3. If available → build config-at-boot, call SandboxManager.initialize(config).
 *   4. On init success → _active=true, return { active:true, summary }.
 *   5. On init failure → log + _active=false + return error (server still starts).
 *
 * The network allowedDomains covers the Anthropic provider only (PR-B scope).
 * Codex domains will be added in PR-C alongside the enableWeakerNestedSandbox flag.
 *
 * ADR 0014 § PR-B: denyRead covers ~/.olp, ~/.claude, ~/.ssh, ~/.config, ~/.codex
 * using absolute literal Linux paths (no globs — see ADR 0014 § Pitfalls #2).
 * ~/.olp contains keys.json (OLP API keys). ~/.claude contains OAuth credentials.
 * ~/.ssh and ~/.config contain identity material. ~/.codex contains codex config.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] — if true, re-run bootstrap even if already initialized
 * @returns {Promise<{ active: boolean, reason?: string, summary?: string }>}
 */
export async function bootstrapSandbox(opts = {}) {
  // Return cached result if already initialized (unless forced)
  if (_initialized && !opts.force) {
    return _active
      ? { active: true, summary: _buildSummary() }
      : { active: false, reason: _initConfig?.failReason ?? 'sandbox not available' };
  }

  // Reset state for re-bootstrap
  _initialized = false;
  _active = false;
  _initConfig = null;

  // Step 1: Check OS + library availability
  let availability;
  try {
    availability = await checkSandboxAvailability();
  } catch (e) {
    _initialized = true;
    _active = false;
    _initConfig = { failReason: `doctor check threw: ${e?.message ?? e}` };
    return { active: false, reason: _initConfig.failReason };
  }

  if (!availability.available) {
    _initialized = true;
    _active = false;
    const reason = availability.missing.length > 0
      ? `sandbox deps missing: ${availability.missing.join(', ')}`
      : `sandbox not available on platform: ${availability.details?.platform}`;
    _initConfig = { failReason: reason };
    return { active: false, reason };
  }

  // Step 2: Build config-at-boot
  // Network allowedDomains: Anthropic provider API domains (PR-B scope).
  //   - api.anthropic.com: primary Anthropic API endpoint
  //   - statsig.anthropic.com: claude CLI telemetry (verified empirically in spike;
  //     required by claude CLI OAuth token refresh path — removing it causes auth failure)
  // TODO(PR-C): union in codex/openai provider domains when codex wrap lands.
  const allowedDomains = [
    'api.anthropic.com',
    'statsig.anthropic.com',
  ];

  const home = homedir();

  // denyRead: Absolute literal Linux paths per ADR 0014 § Pitfalls #2.
  // No ~ or glob — ripgrep glob expansion is not used here to stay safe on
  // both Linux (bwrap) and macOS (sandbox-exec profile).
  //
  // 2026-05-28 PR-B fold-in: ~/.claude is NOT in denyRead. It contains the
  // spawn's own OAuth credentials — claude CLI must read its own auth file
  // to function. Denying read here causes "Not logged in" failures even
  // though the operator has valid credentials present.
  //
  // The cross-tenant risk for ~/.claude is mitigated by Phase 6c's
  // --system-prompt flag (ADR 0009 Amendment 1): the system prompt is
  // fully replaced, suppressing the default tool descriptions that would
  // otherwise tell the model it has Read/Bash. Without tool descriptions,
  // the model is highly unlikely to emit tool_use even under prompt
  // injection. Sandbox's contribution here is protecting OTHER auth
  // material (other clients' OLP keys, SSH identity, other providers'
  // tokens) — files claude CLI does NOT legitimately need.
  //
  // If we ever switch to a CLI that requires reading credentials.json
  // AND also legitimately offers tool execution that surfaces those files
  // (no known case today), this trade-off needs revisiting.
  const denyRead = [
    join(home, '.olp'),       // OLP API keys + config — cross-tenant
    join(home, '.ssh'),       // SSH identity material — lateral movement
    join(home, '.config'),    // Generic config dir (may contain tokens)
    join(home, '.codex'),     // Codex config — other-provider auth (PR-C will wrap codex)
    // NOT denied: ~/.claude — this spawn's own auth, breaks claude CLI if denied
  ];

  // allowWrite: ephemeral spawn workspace only. mkdirSync at bootstrap.
  // getDefaultWritePaths() adds /dev/stdout, /dev/null etc. internally.
  try {
    mkdirSync(SPAWN_BASE_DIR, { recursive: true });
  } catch (e) {
    // Non-fatal: if this dir can't be created, wrapSpawn will fail per-request.
    console.warn(`[sandbox/manager] Warning: could not create ${SPAWN_BASE_DIR}: ${e?.message}`);
  }

  const config = {
    network: {
      allowedDomains,
      deniedDomains: [],
    },
    filesystem: {
      denyRead,
      allowWrite: [SPAWN_BASE_DIR, '/tmp'],
      denyWrite: [],
    },
  };

  // Step 3: Initialize SandboxManager
  let SandboxManager;
  try {
    const mod = await import('@anthropic-ai/sandbox-runtime');
    SandboxManager = mod.SandboxManager;
  } catch (e) {
    _initialized = true;
    _active = false;
    _initConfig = { failReason: `sandbox-runtime import failed: ${e?.message ?? e}` };
    return { active: false, reason: _initConfig.failReason };
  }

  try {
    // ADR 0014 § Pitfalls #5: initialize() generates MITM CA cert (~100-500ms).
    // Must happen at boot, not per-request.
    await SandboxManager.initialize(config);
    _initialized = true;
    _active = true;
    _initConfig = { config, SandboxManager };
    return { active: true, summary: _buildSummary() };
  } catch (e) {
    _initialized = true;
    _active = false;
    const reason = `SandboxManager.initialize failed: ${e?.message ?? e}`;
    _initConfig = { failReason: reason };
    // Log but DO NOT throw — server still starts in unsandboxed mode.
    // PR-D will add hard-fail mode via config flag.
    console.warn(`[sandbox/manager] WARNING: ${reason} — provider spawns will run UNSANDBOXED`);
    return { active: false, reason };
  }
}

/** @internal — returns summary string for logging */
function _buildSummary() {
  const cfg = _initConfig?.config;
  if (!cfg) return 'active (no config)';
  const domains = (cfg.network?.allowedDomains ?? []).join(', ');
  return `network allowlist=[${domains}], denyRead=[${(cfg.filesystem?.denyRead ?? []).length} paths], allowWrite=[${SPAWN_BASE_DIR}, /tmp]`;
}

// ── isSandboxActive ───────────────────────────────────────────────────────

/**
 * Synchronous query of bootstrap state.
 * Returns true only if bootstrapSandbox() completed successfully.
 * Used by provider plugins to decide spawn path.
 *
 * @returns {boolean}
 */
export function isSandboxActive() {
  return _active;
}

// ── wrapSpawn ─────────────────────────────────────────────────────────────

/**
 * Wrap a spawn command + args for sandbox execution.
 *
 * Returns { bin, args, env, cwd, sandboxed: boolean }.
 *   - If sandbox inactive: returns inputs unchanged with sandboxed:false.
 *   - If sandbox active: returns the wrapped shell string as
 *     { bin: '/bin/sh', args: ['-c', wrappedShellString], env, cwd, sandboxed:true }.
 *
 * The wrapped command is a shell string from SandboxManager.wrapWithSandbox().
 * It must be spawned with shell:true OR by invoking /bin/sh -c <string> directly
 * (the latter is what we do here — avoids relying on the shell that Node picks).
 *
 * Per-spawn ephemeral cwd uses a UUID to prevent cross-request contamination.
 * The caller is responsible for cleanup (or trusts tmpfs lifetime).
 *
 * ADR 0014 § PR-B: env vars passed through unchanged so CLAUDE_CODE_OAUTH_TOKEN
 * (if operator set at OLP boot time) still works inside the sandbox.
 *
 * @param {object} params
 * @param {string} params.bin — original binary (e.g. 'claude')
 * @param {string[]} params.args — original args
 * @param {object} params.env — spawn environment (from buildSpawnEnv())
 * @param {string} [params.cwd] — original cwd (ignored; replaced by ephemeral dir)
 * @param {string[]} [params.allowedDomains] — per-spawn domain override (passed as customConfig)
 * @returns {Promise<{ bin: string, args: string[], env: object, cwd: string, sandboxed: boolean }>}
 */
export async function wrapSpawn({ bin, args, env, cwd: _cwd, allowedDomains }) {
  // Transparent pass-through when sandbox inactive
  if (!_active || !_initConfig?.SandboxManager) {
    return {
      bin,
      args: args ?? [],
      env: env ?? {},
      cwd: _cwd,
      sandboxed: false,
    };
  }

  const SandboxManager = _initConfig.SandboxManager;

  // Build the shell command string from bin + args.
  // Each arg is shell-quoted to handle spaces and special characters.
  // Authority: spike-anthropic.mjs line 29-31 — same quoting pattern.
  const quotedArgs = (args ?? []).map(a =>
    /[\s"'`$\\;&|<>()\[\]{}!#~*?]/.test(a)
      ? `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`
      : a
  );
  const commandString = [bin, ...quotedArgs].join(' ');

  // Per-spawn ephemeral cwd (UUID) — prevents cross-request contamination.
  // ADR 0014 § PR-B: unique per request.
  const reqId = createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 16);
  const spawnCwd = join(SPAWN_BASE_DIR, reqId);
  try {
    mkdirSync(spawnCwd, { recursive: true });
  } catch (e) {
    throw new SandboxWrapError(`Failed to create ephemeral spawn dir ${spawnCwd}: ${e?.message ?? e}`);
  }

  // Per-spawn customConfig: allow caller to override domains (e.g. different provider).
  // Default: use the config-at-boot allowedDomains.
  let customConfig;
  if (allowedDomains && allowedDomains.length > 0) {
    customConfig = {
      network: {
        allowedDomains,
        deniedDomains: [],
      },
    };
  }

  let wrappedCommand;
  try {
    wrappedCommand = await SandboxManager.wrapWithSandbox(commandString, undefined, customConfig);
  } catch (e) {
    throw new SandboxWrapError(`SandboxManager.wrapWithSandbox failed: ${e?.message ?? e}`);
  }

  // Invoke via /bin/sh -c to avoid spawning a second shell layer.
  // The wrapped command is already a complete shell invocation (bwrap args or
  // sandbox-exec profile + the original command inside).
  return {
    bin: '/bin/sh',
    args: ['-c', wrappedCommand],
    env: env ?? {},
    cwd: spawnCwd,
    sandboxed: true,
  };
}

// ── Test seam ─────────────────────────────────────────────────────────────

/**
 * Reset internal state so test suite can simulate fresh process.
 * Also calls SandboxManager.reset() if it was initialized (to clear singleton).
 *
 * ADR 0014 § Pitfalls #4: must only be called when no in-flight wrapSpawn calls
 * are active. Safe in sequential test contexts.
 *
 * @returns {Promise<void>}
 */
export async function __resetSandboxManagerForTests() {
  if (_active && _initConfig?.SandboxManager) {
    try {
      await _initConfig.SandboxManager.reset();
    } catch { /* ignore — test teardown, best-effort */ }
  }
  _initialized = false;
  _active = false;
  _initConfig = null;
}

/**
 * lib/sandbox/doctor.mjs — Sandbox availability preflight module (Phase 7 PR-A)
 *
 * Authority:
 *   @anthropic-ai/sandbox-runtime v0.0.52
 *   https://github.com/anthropic-experimental/sandbox-runtime
 *
 *   2026-05-28 PoC spike on PI231 (arm64 Debian Bookworm): dep install clean,
 *   isSupportedPlatform()=true, blocked on apt deps (bwrap + socat), three PoC
 *   scripts parked at /tmp/sandbox-spike/ on PI231.
 *
 *   OLP ADR 0014 — Sandbox-Runtime Integration for Multi-Tenant Provider Spawning
 *   OLP ADR 0009 Amendment 1 § Caveats #3 (sandbox is cloud prerequisite)
 *   docs/plans/cloud-deployment-family.md § 5
 *
 * Design:
 *   Pure module — no state, no side effects beyond child_process.execFileSync for
 *   `which` probes. Does NOT call SandboxManager.initialize(). Does NOT create
 *   or interact with any real sandbox. Safe to call from /health on every request
 *   (results are memoized process-wide by the caller in server.mjs — see
 *   _sandboxStatusCache there).
 *
 * Exports:
 *   checkSandboxAvailability()  — returns { available, missing, details }
 *   describeSandboxStatus()     — returns { ok, message } human-readable summary
 */

import { execFileSync } from 'node:child_process';
import { platform as osPlatform } from 'node:os';

// ── which probe helper ────────────────────────────────────────────────────

/**
 * Check if a binary is in PATH by running `which <binary>`.
 * Returns true if found, false if not found or if `which` is unavailable.
 * Never throws.
 * @param {string} binary
 * @returns {boolean}
 */
function isInPath(binary) {
  try {
    execFileSync('which', [binary], { stdio: 'pipe', timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

// ── Platform helper ───────────────────────────────────────────────────────

/**
 * Map Node's process.platform to the sandbox-runtime platform string.
 * @returns {'linux'|'macos'|'other'}
 */
function getPlatformName() {
  const p = osPlatform();
  if (p === 'linux') return 'linux';
  if (p === 'darwin') return 'macos';
  return 'other';
}

// ── Library introspection ─────────────────────────────────────────────────

/**
 * Attempt to import @anthropic-ai/sandbox-runtime and call its exported
 * isSupportedPlatform + checkDependencies. Returns structured findings.
 * Never throws — all errors become { libError: <message> }.
 *
 * @returns {Promise<{
 *   libLoaded: boolean,
 *   libError: string|null,
 *   isSupportedPlatform: boolean,
 *   libDependencyErrors: string[],
 *   libDependencyWarnings: string[],
 * }>}
 */
async function probeLibrary() {
  try {
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');

    let supportedPlatform = false;
    try {
      supportedPlatform = SandboxManager.isSupportedPlatform();
    } catch (e) {
      return {
        libLoaded: true,
        libError: `isSupportedPlatform() threw: ${e?.message ?? e}`,
        isSupportedPlatform: false,
        libDependencyErrors: [],
        libDependencyWarnings: [],
      };
    }

    // checkDependencies() requires initialize() to have been called first to
    // set ripgrep/bwrap/socat config. Since PR-A never calls initialize(), we
    // call checkDependencies() with an undefined argument — the library falls
    // back to { command: 'rg' } for ripgrep and PATH lookup for bwrap/socat,
    // which is exactly what we want for the doctor preflight.
    let libDependencyErrors = [];
    let libDependencyWarnings = [];
    if (supportedPlatform) {
      try {
        const depCheck = SandboxManager.checkDependencies(undefined);
        libDependencyErrors = depCheck?.errors ?? [];
        libDependencyWarnings = depCheck?.warnings ?? [];
      } catch (e) {
        // checkDependencies() can throw before initialize() — not fatal
        libDependencyErrors = [`checkDependencies() threw: ${e?.message ?? e}`];
      }
    }

    return {
      libLoaded: true,
      libError: null,
      isSupportedPlatform: supportedPlatform,
      libDependencyErrors,
      libDependencyWarnings,
    };
  } catch (e) {
    return {
      libLoaded: false,
      libError: `@anthropic-ai/sandbox-runtime import failed: ${e?.message ?? e}`,
      isSupportedPlatform: false,
      libDependencyErrors: [],
      libDependencyWarnings: [],
    };
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Check sandbox availability (OS deps + library platform support).
 *
 * Returns:
 * {
 *   available: boolean,         // true only when all hard deps pass on a supported platform
 *   missing: string[],          // friendly names of missing hard deps (e.g. 'bubblewrap', 'socat')
 *   details: {
 *     platform: string,         // 'linux'|'macos'|'other'
 *     bwrap: boolean,           // which bwrap → found
 *     socat: boolean,           // which socat → found
 *     ripgrep: boolean,         // which rg → found
 *     isSupportedPlatform: boolean,
 *     libLoaded: boolean,
 *     libError: string|null,
 *     libDependencyErrors: string[],
 *     libDependencyWarnings: string[],
 *   }
 * }
 *
 * The `missing` array uses human-readable package names ('bubblewrap', 'socat',
 * 'ripgrep') so that install hints are directly actionable.
 *
 * Does NOT call SandboxManager.initialize() — pure inspection only.
 * Does NOT cache — the caller (server.mjs) memoizes the result.
 */
export async function checkSandboxAvailability() {
  const platform = getPlatformName();

  // Probe OS-level deps independently of the library (the `which` calls are
  // cheap and always correct; library's checkDependencies may be less precise
  // when initialize() hasn't been called).
  const bwrap = isInPath('bwrap');
  const socat = isInPath('socat');
  const ripgrep = isInPath('rg');

  // Library introspection (import + isSupportedPlatform + checkDependencies)
  const lib = await probeLibrary();

  // Determine what's missing for the doctor report.
  // Only report OS deps as missing on Linux (where bwrap/socat/rg are required);
  // macOS uses sandbox-exec which is built-in, so these are not hard requirements.
  const missing = [];
  if (platform === 'linux') {
    if (!bwrap) missing.push('bubblewrap');
    if (!socat) missing.push('socat');
    if (!ripgrep) missing.push('ripgrep');
  }
  // If the library itself failed to load, that's also a blocker
  if (!lib.libLoaded) {
    missing.push('@anthropic-ai/sandbox-runtime (import failed)');
  }
  // Library-reported hard dep errors (may overlap with our `which` probes;
  // deduplicate by treating them as additional evidence rather than re-adding)
  for (const errMsg of lib.libDependencyErrors) {
    // Only add if it doesn't overlap with what we already reported
    const isAlreadyCovered =
      (errMsg.includes('bwrap') && !bwrap) ||
      (errMsg.includes('socat') && !socat) ||
      (errMsg.includes('ripgrep') && !ripgrep) ||
      (errMsg.includes('Unsupported platform'));
    if (!isAlreadyCovered && !missing.includes(errMsg)) {
      missing.push(errMsg);
    }
  }

  const available =
    lib.libLoaded &&
    lib.isSupportedPlatform &&
    missing.length === 0;

  return {
    available,
    missing,
    details: {
      platform,
      bwrap,
      socat,
      ripgrep,
      isSupportedPlatform: lib.isSupportedPlatform,
      libLoaded: lib.libLoaded,
      libError: lib.libError,
      libDependencyErrors: lib.libDependencyErrors,
      libDependencyWarnings: lib.libDependencyWarnings,
    },
  };
}

/**
 * Human-readable sandbox status summary for /health and CLI consumers.
 *
 * Returns:
 * {
 *   ok: boolean,       // same as checkSandboxAvailability().available
 *   message: string,   // multi-line, includes install hint when deps are missing
 * }
 *
 * Does NOT call SandboxManager.initialize() — pure inspection only.
 */
export async function describeSandboxStatus() {
  const result = await checkSandboxAvailability();
  const { available, missing, details } = result;

  if (available) {
    return {
      ok: true,
      message:
        `Sandbox available on ${details.platform}` +
        (details.libDependencyWarnings.length > 0
          ? `. Warnings: ${details.libDependencyWarnings.join('; ')}`
          : '.'),
    };
  }

  // Build a friendly explanation
  const lines = [];

  if (!details.libLoaded) {
    lines.push(`Sandbox library not available: ${details.libError ?? 'import failed'}`);
  } else if (!details.isSupportedPlatform) {
    lines.push(
      `Sandbox dependencies not available: platform '${details.platform}' is not supported by @anthropic-ai/sandbox-runtime v0.0.52.`,
    );
  } else {
    // Platform is supported but OS deps are missing
    const pkgNames = missing.filter(m => !m.includes('import failed'));
    if (pkgNames.length > 0) {
      lines.push(`Sandbox dependencies not available: ${pkgNames.map(m => `${m} not installed`).join(', ')}.`);
    }
  }

  // Install hint (only for Linux; macOS sandbox uses sandbox-exec which is built-in)
  if (details.platform === 'linux' && (missing.includes('bubblewrap') || missing.includes('socat') || missing.includes('ripgrep'))) {
    const aptPkgs = [];
    if (missing.includes('bubblewrap')) aptPkgs.push('bubblewrap');
    if (missing.includes('socat')) aptPkgs.push('socat');
    if (missing.includes('ripgrep')) aptPkgs.push('ripgrep');
    lines.push(
      `Install on Debian/Ubuntu/Raspbian: sudo apt-get install -y ${aptPkgs.join(' ')}`,
    );
  }

  // macOS note (PR-A does not wire macOS sandbox-exec; PR-B will)
  if (details.platform === 'macos') {
    lines.push(
      'macOS: sandbox-exec is built-in, but anthropic provider wrapping lands in PR-B. ' +
      'macOS sandbox integration is not yet wired in this PR (PR-A). ',
    );
  }

  if (details.libDependencyWarnings.length > 0) {
    lines.push(`Warnings: ${details.libDependencyWarnings.join('; ')}`);
  }

  return {
    ok: false,
    message: lines.join('\n'),
  };
}

/**
 * lib/doctor.mjs — OLP doctor framework (Phase 4 / D65)
 *
 * Authority: ADR 0010 § Phase 4 D64-D67 + ADR 0002 Amendment 7 (D67) —
 *   per-provider `doctorChecks()` contract method that this framework consumes.
 *
 * `olp doctor` runs a set of `Check` objects. Each check has:
 *   - id: string                     (unique, e.g. 'server.running', 'anthropic.cli_available')
 *   - category: 'server'|'auth'|'config'|'provider'|'system'
 *   - async run(): { status: 'ok'|'fail'|'warn', message, evidence? }
 *
 * Built-in checks (categories server / auth / config / system) are defined in
 * `buildBuiltinChecks()` below; per-provider checks are sourced from each loaded
 * plugin's optional `doctorChecks()` method (ADR 0002 Amendment 7).
 *
 * Output shape (machine-readable — consumed by `bin/olp.mjs --json`):
 *   {
 *     schema_version: 1,
 *     generated_at: '2026-05-26T...',
 *     checks: [{ id, category, status, message, evidence? }],
 *     fail_count: number,
 *     warn_count: number,
 *     kind: 'noop'|'fix_server'|'fix_oauth'|'fix_config'|'fix_provider'|'fresh_install',
 *     next_action: { ai_executable: string[], human_required: string[], verify: string },
 *     summary: string,
 *   }
 *
 * `kind` precedence (highest first — the most upstream blocker wins):
 *   1. fresh_install      — config.exists FAIL (~/.olp/config.json missing/malformed)
 *   2. fix_server         — server.running FAIL
 *   3. fix_oauth          — auth.owner_key_exists FAIL
 *   4. fix_provider       — any provider-category FAIL
 *   5. fix_config         — any other config-category FAIL
 *   6. noop               — all OK (or WARN-only)
 *
 * `next_action.ai_executable[]` aggregates `evidence.fix_commands[]` from every
 * FAIL check; `next_action.human_required[]` aggregates `evidence.human_steps[]`.
 * `verify` is always `olp doctor` (re-run after applying the fix).
 *
 * Design notes:
 *   - Pure functions + dependency injection: callers pass `{ checks }` (which can
 *     be overridden for tests) plus a `{ now }` clock for deterministic timestamps.
 *   - No filesystem writes. No process.exit. No console.log. Callers handle I/O.
 *   - All checks run in parallel via Promise.all — individual check failures are
 *     captured (not propagated) so one broken check does not hide others.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { request as httpRequest } from 'node:http';

import { loadProviders } from './providers/index.mjs';
import { loadFallbackConfigSync } from './fallback/engine.mjs';
import { listKeys } from './keys.mjs';

// ── Schema version ────────────────────────────────────────────────────────

export const DOCTOR_SCHEMA_VERSION = 1;

// ── Built-in check builders ───────────────────────────────────────────────

/**
 * Resolve the OLP base URL the CLI / doctor will probe.
 * Precedence:
 *   1. opts.proxyUrl (explicit caller override)
 *   2. OLP_PROXY_URL env (full URL like http://host:port)
 *   3. http://127.0.0.1:${OLP_PORT || 4567}
 */
export function resolveProxyUrl(opts = {}) {
  if (opts.proxyUrl) return String(opts.proxyUrl).replace(/\/+$/, '');
  if (process.env.OLP_PROXY_URL) return String(process.env.OLP_PROXY_URL).replace(/\/+$/, '');
  const port = process.env.OLP_PORT ?? '4567';
  return `http://127.0.0.1:${port}`;
}

/**
 * Resolve the OLP_HOME directory (mirrors lib/keys.mjs precedence).
 *   1. opts.olpHome
 *   2. OLP_HOME env
 *   3. ~/.olp
 */
export function resolveOlpHome(opts = {}) {
  if (opts.olpHome) return opts.olpHome;
  if (process.env.OLP_HOME) return process.env.OLP_HOME;
  return join(homedir(), '.olp');
}

/**
 * Helper — issue a GET to the proxy with a tight timeout. Returns
 * `{ ok: true, status, body }` or `{ ok: false, error }`. Never throws.
 */
async function httpGet(url, { timeoutMs = 3000, headers = {} } = {}) {
  return new Promise(resolve => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      req = httpRequest(url, { method: 'GET', headers, timeout: timeoutMs }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => finish({ ok: true, status: res.statusCode, body: data, headers: res.headers }));
      });
    } catch (e) {
      finish({ ok: false, error: String(e?.message ?? e) });
      return;
    }
    req.on('error', e => finish({ ok: false, error: String(e?.message ?? e) }));
    req.on('timeout', () => {
      try { req.destroy(new Error(`timeout after ${timeoutMs}ms`)); } catch { /* ignore */ }
    });
    req.end();
  });
}

/**
 * Build the default check set. Test-mode overrides:
 *   - opts.injectChecks: [...Check] — REPLACES the built-in set entirely
 *   - opts.providersOverride: Map<name, plugin> — REPLACES loaded providers for the per-provider sweep
 *   - opts.skipNetwork: true → omit server.running / server.version (offline mode)
 *   - opts.olpHome: override ~/.olp lookup
 *   - opts.proxyUrl: override resolveProxyUrl()
 */
export function buildBuiltinChecks(opts = {}) {
  if (opts.injectChecks) return opts.injectChecks;

  const olpHome = resolveOlpHome(opts);
  const configPath = join(olpHome, 'config.json');
  const proxyUrl = resolveProxyUrl(opts);

  const checks = [];

  // ── system.* ─────────────────────────────────────────────────────────
  checks.push({
    id: 'system.node_version',
    category: 'system',
    async run() {
      // package.json engines.node = >=18; check process.versions.node major >= 18
      const major = parseInt(String(process.versions.node).split('.')[0], 10);
      if (Number.isFinite(major) && major >= 18) {
        return { status: 'ok', message: `Node ${process.versions.node} (>=18)` };
      }
      return {
        status: 'fail',
        message: `Node ${process.versions.node} is below the required >=18 (per package.json engines.node)`,
        evidence: {
          human_steps: [
            'Install a current Node.js LTS (>=18) — see https://nodejs.org/en/download',
          ],
        },
      };
    },
  });

  // ── config.* ─────────────────────────────────────────────────────────
  checks.push({
    id: 'config.exists',
    category: 'config',
    async run() {
      if (!existsSync(configPath)) {
        return {
          status: 'fail',
          message: `${configPath} not found`,
          evidence: {
            fix_commands: [
              `mkdir -p ${olpHome}`,
              `printf '%s\\n' '{"auth":{"allow_anonymous":false,"owner_only_endpoints":["/health"],"fallback_detail_header_policy":"owner_only"},"providers":{"enabled":{}},"routing":{"chains":{},"soft_triggers":{}},"streaming":{"heartbeat_interval_ms":0}}' > ${configPath}`,
            ],
            reference: 'docs/adr/0007-multi-key-auth.md § 3, docs/adr/0004-fallback-engine.md',
          },
        };
      }
      try {
        const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          return { status: 'ok', message: `${configPath} parses` };
        }
        return { status: 'fail', message: `${configPath} parses but is not a JSON object` };
      } catch (e) {
        return {
          status: 'fail',
          message: `${configPath} unreadable / malformed: ${e?.message ?? e}`,
          evidence: {
            human_steps: [
              `Inspect ${configPath} — fix the JSON syntax error (or delete the file to fall back to the empty default and re-run olp doctor)`,
            ],
          },
        };
      }
    },
  });

  checks.push({
    id: 'config.providers_enabled',
    category: 'config',
    async run() {
      try {
        const cfg = loadFallbackConfigSync(configPath);
        const enabled = cfg.providersEnabled ?? {};
        const enabledNames = Object.keys(enabled).filter(k => enabled[k] === true);
        if (enabledNames.length > 0) {
          return { status: 'ok', message: `${enabledNames.length} provider(s) enabled: ${enabledNames.join(', ')}` };
        }
        return {
          status: 'warn',
          message: 'No providers enabled in config.json (all /v1/chat/completions requests will 503)',
          evidence: {
            human_steps: [
              `Edit ${configPath} → set providers.enabled.<name> = true for at least one provider (anthropic / openai / mistral)`,
            ],
            reference: 'docs/adr/0002-plugin-architecture.md § Disable model',
          },
        };
      } catch (e) {
        return { status: 'fail', message: `Could not read providers.enabled from ${configPath}: ${e?.message ?? e}` };
      }
    },
  });

  checks.push({
    id: 'config.chains_configured',
    category: 'config',
    async run() {
      try {
        const cfg = loadFallbackConfigSync(configPath);
        const chains = cfg.chains ?? {};
        const chainNames = Object.keys(chains);
        if (chainNames.length > 0) {
          return { status: 'ok', message: `${chainNames.length} chain(s) configured: ${chainNames.join(', ')}` };
        }
        return {
          status: 'warn',
          message: 'No routing chains configured (single-hop mode; cross-provider fallback inactive)',
          evidence: {
            reference: 'docs/adr/0004-fallback-engine.md § Chain configuration',
          },
        };
      } catch (e) {
        return { status: 'fail', message: `Could not read routing.chains from ${configPath}: ${e?.message ?? e}` };
      }
    },
  });

  // ── auth.* ───────────────────────────────────────────────────────────
  checks.push({
    id: 'auth.owner_key_exists',
    category: 'auth',
    async run() {
      // Per ADR 0007 § 9.4: process.env.OLP_OWNER_TOKEN also satisfies "owner identity".
      if (process.env.OLP_OWNER_TOKEN) {
        return { status: 'ok', message: 'OLP_OWNER_TOKEN env var present (synthetic env-owner per ADR 0007 § 9.4)' };
      }
      try {
        const keys = listKeys({ olpHome });
        const activeOwner = keys.find(k => k.owner_tier === 'owner' && k.revoked_at === null);
        if (activeOwner) {
          return { status: 'ok', message: `active owner key found: id=${activeOwner.id} name="${activeOwner.name}"` };
        }
        return {
          status: 'fail',
          message: 'No active owner-tier key found in ~/.olp/keys/ and OLP_OWNER_TOKEN env unset',
          evidence: {
            fix_commands: [
              'npx olp-keys keygen --owner',
            ],
            reference: 'docs/adr/0007-multi-key-auth.md § 9.1 (bootstrap & recovery)',
          },
        };
      } catch (e) {
        return { status: 'fail', message: `listKeys failed: ${e?.message ?? e}` };
      }
    },
  });

  // ── server.* ─────────────────────────────────────────────────────────
  if (!opts.skipNetwork) {
    checks.push({
      id: 'server.running',
      category: 'server',
      async run() {
        const r = await httpGet(`${proxyUrl}/health`, { timeoutMs: 3000 });
        if (!r.ok) {
          return {
            status: 'fail',
            message: `${proxyUrl}/health unreachable: ${r.error}`,
            evidence: {
              fix_commands: [
                'npx olp restart',
              ],
              reference: 'README.md § Running OLP',
            },
          };
        }
        if (r.status !== 200) {
          return { status: 'fail', message: `${proxyUrl}/health returned status=${r.status}` };
        }
        return { status: 'ok', message: `${proxyUrl}/health → 200` };
      },
    });

    checks.push({
      id: 'server.version',
      category: 'server',
      async run() {
        // Read local package.json version
        let localVersion = null;
        try {
          // Resolve relative to this file — lib/doctor.mjs → ../package.json
          // import.meta.url gives a file:// URL; convert and join.
          const here = new URL('../package.json', import.meta.url);
          const pkg = JSON.parse(readFileSync(here, 'utf8'));
          localVersion = pkg.version ?? null;
        } catch {
          return { status: 'warn', message: 'Could not read local package.json — skipping version comparison' };
        }
        const r = await httpGet(`${proxyUrl}/health`, { timeoutMs: 3000 });
        if (!r.ok || r.status !== 200) {
          return { status: 'warn', message: `Could not fetch /health to compare version (${r.error ?? `status ${r.status}`})` };
        }
        let serverVersion = null;
        try {
          serverVersion = JSON.parse(r.body)?.version ?? null;
        } catch {
          return { status: 'warn', message: '/health returned non-JSON; cannot compare version' };
        }
        if (!serverVersion) {
          return { status: 'warn', message: '/health did not include version; cannot compare' };
        }
        if (serverVersion === localVersion) {
          return { status: 'ok', message: `local v${localVersion} matches running v${serverVersion}` };
        }
        return {
          status: 'warn',
          message: `local v${localVersion} differs from running v${serverVersion} — restart to pick up the new code`,
          evidence: {
            fix_commands: [
              'npx olp restart',
            ],
          },
        };
      },
    });
  }

  return checks;
}

/**
 * Sweep loaded providers for doctorChecks() (ADR 0002 Amendment 7).
 * Plugins without doctorChecks() contribute nothing (default — back-compat).
 *
 * @param {object} opts
 * @param {Map} [opts.providersOverride] — Map<name, plugin> for tests
 * @param {object} [opts.providersEnabled] — Record<string, boolean>; default = all from config.json
 * @returns {Check[]}
 */
export function collectProviderChecks(opts = {}) {
  let providers;
  if (opts.providersOverride) {
    providers = opts.providersOverride;
  } else {
    const olpHome = resolveOlpHome(opts);
    const configPath = join(olpHome, 'config.json');
    let enabled = opts.providersEnabled;
    if (!enabled) {
      try {
        enabled = loadFallbackConfigSync(configPath).providersEnabled ?? {};
      } catch {
        enabled = {};
      }
    }
    providers = loadProviders({ enabled });
  }

  const checks = [];
  for (const [_name, plugin] of providers) {
    if (typeof plugin?.doctorChecks !== 'function') continue;
    let pluginChecks;
    try {
      pluginChecks = plugin.doctorChecks();
    } catch (e) {
      // Misbehaving plugin — surface as a synthesized fail check, do not crash.
      checks.push({
        id: `${plugin.name}.doctor_checks_threw`,
        category: 'provider',
        async run() {
          return { status: 'fail', message: `doctorChecks() threw: ${e?.message ?? e}` };
        },
      });
      continue;
    }
    if (!Array.isArray(pluginChecks)) continue;
    for (const c of pluginChecks) {
      if (c && typeof c.id === 'string' && typeof c.run === 'function') {
        checks.push({
          id: c.id,
          category: c.category ?? 'provider',
          run: c.run,
        });
      }
    }
  }
  return checks;
}

// ── Discriminator (kind precedence) ───────────────────────────────────────

/**
 * Given a flat results array, determine the next-action discriminator.
 * Per ADR 0010 § D65 framework:
 *   fresh_install > fix_server > fix_oauth > fix_provider > fix_config > noop
 */
export function deriveKind(results) {
  const failed = results.filter(r => r.status === 'fail');
  if (failed.length === 0) return 'noop';

  if (failed.some(r => r.id === 'config.exists')) return 'fresh_install';
  if (failed.some(r => r.category === 'server')) return 'fix_server';
  if (failed.some(r => r.category === 'auth')) return 'fix_oauth';
  if (failed.some(r => r.category === 'provider')) return 'fix_provider';
  if (failed.some(r => r.category === 'config')) return 'fix_config';
  return 'fix_config';
}

/**
 * Compose the next_action block from FAIL results' evidence.
 */
export function deriveNextAction(results, kind) {
  const ai_executable = [];
  const human_required = [];
  for (const r of results) {
    if (r.status !== 'fail') continue;
    const ev = r.evidence ?? {};
    if (Array.isArray(ev.fix_commands)) ai_executable.push(...ev.fix_commands);
    if (Array.isArray(ev.human_steps)) human_required.push(...ev.human_steps);
  }
  return {
    ai_executable,
    human_required,
    verify: kind === 'noop' ? 'already healthy' : 'olp doctor',
  };
}

// ── runDoctor (main entry) ────────────────────────────────────────────────

/**
 * Execute every check in parallel; aggregate; derive kind + next_action.
 *
 * @param {object} [opts]
 * @param {Check[]} [opts.injectChecks] — REPLACE the built-in + provider checks entirely
 * @param {Check[]} [opts.extraChecks] — APPEND extra checks (after defaults)
 * @param {string} [opts.checkFilter] — restrict to checks whose id OR category matches
 * @param {Map} [opts.providersOverride] — for the per-provider sweep
 * @param {object} [opts.providersEnabled] — Record<string, boolean>
 * @param {string} [opts.olpHome] — override ~/.olp
 * @param {string} [opts.proxyUrl] — override the proxy URL
 * @param {boolean} [opts.skipNetwork] — omit server.* checks
 * @param {() => Date} [opts.now] — clock injection
 * @returns {Promise<DoctorResult>}
 */
export async function runDoctor(opts = {}) {
  const now = opts.now ?? (() => new Date());

  let checks;
  if (opts.injectChecks) {
    checks = [...opts.injectChecks];
  } else {
    checks = [
      ...buildBuiltinChecks(opts),
      ...collectProviderChecks(opts),
    ];
  }
  if (opts.extraChecks) checks.push(...opts.extraChecks);

  // --check <filter>: restrict to checks whose id OR category startsWith / equals the filter.
  // Match rule: exact id match, exact category match, OR id startsWith `<filter>.`
  // (so --check anthropic matches both anthropic.cli_available and anthropic.oauth_token_present).
  if (opts.checkFilter) {
    const f = String(opts.checkFilter);
    checks = checks.filter(c =>
      c.id === f
      || c.category === f
      || c.id.startsWith(`${f}.`)
    );
  }

  // Run all checks in parallel. Capture per-check failures (do not let one throw
  // hide the rest of the diagnostic).
  const results = await Promise.all(checks.map(async c => {
    try {
      const r = await c.run();
      return {
        id: c.id,
        category: c.category,
        status: r?.status ?? 'fail',
        message: r?.message ?? '(check returned no message)',
        ...(r?.evidence !== undefined ? { evidence: r.evidence } : {}),
      };
    } catch (e) {
      return {
        id: c.id,
        category: c.category,
        status: 'fail',
        message: `check threw: ${e?.message ?? e}`,
      };
    }
  }));

  const fail_count = results.filter(r => r.status === 'fail').length;
  const warn_count = results.filter(r => r.status === 'warn').length;
  const ok_count = results.filter(r => r.status === 'ok').length;
  const kind = deriveKind(results);
  const next_action = deriveNextAction(results, kind);

  let summary;
  if (fail_count === 0 && warn_count === 0) {
    summary = `all ${ok_count} checks ok`;
  } else if (fail_count === 0) {
    summary = `${ok_count} ok, ${warn_count} warn — no FAIL; kind=${kind}`;
  } else {
    const firstFail = results.find(r => r.status === 'fail');
    summary = `${fail_count} of ${results.length} checks failed — ${firstFail?.id ?? '?'} (${firstFail?.message?.slice(0, 80) ?? ''})`;
  }

  return {
    schema_version: DOCTOR_SCHEMA_VERSION,
    generated_at: now().toISOString(),
    checks: results,
    fail_count,
    warn_count,
    ok_count,
    kind,
    next_action,
    summary,
  };
}

/**
 * @typedef {Object} Check
 * @property {string} id
 * @property {'server'|'auth'|'config'|'provider'|'system'} category
 * @property {() => Promise<{ status: 'ok'|'fail'|'warn', message: string, evidence?: { fix_commands?: string[], human_steps?: string[], reference?: string } }>} run
 */

/**
 * @typedef {Object} DoctorResult
 * @property {number} schema_version
 * @property {string} generated_at  (ISO timestamp)
 * @property {Array<{ id: string, category: string, status: 'ok'|'fail'|'warn', message: string, evidence?: object }>} checks
 * @property {number} fail_count
 * @property {number} warn_count
 * @property {number} ok_count
 * @property {'noop'|'fix_server'|'fix_oauth'|'fix_config'|'fix_provider'|'fresh_install'} kind
 * @property {{ ai_executable: string[], human_required: string[], verify: string }} next_action
 * @property {string} summary
 */

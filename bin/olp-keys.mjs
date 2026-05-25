#!/usr/bin/env node
/**
 * bin/olp-keys.mjs — OLP key management CLI (Phase 2 / D47)
 *
 * Authority: ADR 0007 § 9 (Bootstrap & recovery — minimal keygen command
 * surface) + § 10 acceptance criterion #9 (bootstrap workflow must be
 * reproducible without manual file editing).
 *
 * Subcommands:
 *   keygen   create a new OLP key; prints plaintext token to stdout ONCE
 *   list     list all keys (manifests with token_hash redacted)
 *   revoke   mark a key as revoked (idempotent; manifest stays for audit)
 *
 * Usage:
 *   olp-keys keygen --owner [--name=<label>] [--providers=anthropic,openai,...]
 *   olp-keys keygen --name=<label> [--tier=guest|owner] [--providers=...]
 *   olp-keys keygen --owner --force          (revokes existing owner keys; new owner)
 *   olp-keys list [--owner-only] [--include-revoked]
 *   olp-keys revoke --id=<key-id>
 *
 * Flags applicable to all subcommands:
 *   --olp-home=<path>    override ~/.olp (defaults to OLP_HOME env or ~/.olp)
 *   --help               print usage and exit 0
 *
 * Exit codes:
 *   0 = success
 *   1 = bad usage (missing args, unknown subcommand)
 *   2 = operational failure (key not found, manifest invalid, FS error)
 *
 * The plaintext token from `keygen` is printed exactly once to stdout. It is
 * never written to manifest, audit, or any log line. Operators must capture
 * it immediately; lost → revoke + regenerate. Per ADR 0007 § 5 + § 9.1.
 */

import {
  createKey,
  listKeys,
  revokeKey,
  readManifest,
} from '../lib/keys.mjs';

// ── Arg parsing ───────────────────────────────────────────────────────────

/**
 * Minimal flag parser. Supports:
 *   --flag=value      → { flag: 'value' }
 *   --flag value      → { flag: 'value' }   (if next arg doesn't start with --)
 *   --flag            → { flag: true }
 * Returns { positional: string[], flags: Record<string, string|true> }.
 */
export function parseArgv(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const name = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

const USAGE = `OLP key management CLI

Usage:
  olp-keys keygen --owner [--name=<label>] [--providers=<csv>] [--force]
  olp-keys keygen --name=<label> [--tier=guest|owner] [--providers=<csv>]
  olp-keys keygen --anonymous --advertise [--name=<label>] [--providers=<csv>]
  olp-keys list [--owner-only] [--include-revoked]
  olp-keys revoke --id=<key-id>

Common flags:
  --olp-home=<path>    Override ~/.olp (default reads OLP_HOME env)
  --help               Print this message

Authority: ADR 0007 § 9 (bootstrap & recovery); ADR 0011 (anonymous-key
deployment-context limits — trusted-LAN-only invariant for --advertise).`;

// ── Subcommand implementations ────────────────────────────────────────────

async function cmdKeygen(flags, ioOut, ioErr) {
  const olpHome = flags['olp-home'];
  const owner = flags.owner === true;
  const force = flags.force === true;
  // D69 (ADR 0011): --anonymous is shorthand for "create a guest-tier key
  // intended to be the zero-config /health.anonymousKey advertise key".
  // It implies --tier=guest and defaults the name to 'anonymous'. The
  // distinct field that actually triggers /health advertisement is
  // --advertise (writes plaintext_advertise into the manifest). Either
  // flag works on its own (--anonymous without --advertise is just a
  // conventionally-named guest key); --advertise without --anonymous is
  // accepted (operator may want to advertise a named guest key).
  const isAnonymous = flags.anonymous === true;
  const advertise = flags.advertise === true;
  let tier = flags.tier;
  if (owner) tier = 'owner';
  if (isAnonymous && !owner) tier = 'guest';
  if (!tier) tier = 'guest';
  if (tier !== 'owner' && tier !== 'guest') {
    ioErr(`Error: --tier must be "owner" or "guest" (got "${tier}").\n`);
    return 1;
  }
  // D69: reject --owner --advertise (would expose owner identity unauthenticated).
  if (advertise && tier !== 'guest') {
    ioErr(`Error: --advertise requires guest tier (cannot advertise owner-tier key plaintext). See ADR 0011.\n`);
    return 1;
  }
  let name = flags.name;
  if (!name) {
    if (owner) name = 'owner';
    else if (isAnonymous) name = 'anonymous';
  }
  if (!name) {
    ioErr('Error: --name is required (or use --owner to default to "owner", or --anonymous to default to "anonymous").\n');
    return 1;
  }
  const providersFlag = flags.providers;
  let providers_enabled;
  if (providersFlag === undefined || providersFlag === true) {
    providers_enabled = '*';
  } else if (typeof providersFlag === 'string') {
    providers_enabled = providersFlag.split(',').map(s => s.trim()).filter(Boolean);
    if (providers_enabled.length === 0) providers_enabled = '*';
  } else {
    providers_enabled = '*';
  }

  // --force: revoke any existing owner keys before creating the new one.
  // revokeKey is async (acquires per-key write lock); await each so the new
  // owner key's createKey doesn't race the revoke writes.
  if (force && tier === 'owner') {
    const existing = listKeys({ olpHome });
    for (const m of existing) {
      if (m.owner_tier === 'owner' && m.revoked_at === null) {
        try {
          await revokeKey({ id: m.id, olpHome });
          ioErr(`Revoked existing owner key id=${m.id} name="${m.name}" (--force).\n`);
        } catch (err) {
          ioErr(`Warning: failed to revoke existing owner key id=${m.id}: ${err?.message ?? err}\n`);
        }
      }
    }
  }

  let result;
  try {
    result = createKey({ name, owner_tier: tier, providers_enabled, olpHome, plaintext_advertise: advertise });
  } catch (err) {
    ioErr(`Error: createKey failed: ${err?.message ?? err}\n`);
    return 2;
  }

  // Plaintext token — printed ONCE per ADR § 5 + § 9.1.
  ioOut(`\n  OLP key created — capture the plaintext token NOW; it will not be shown again.\n\n`);
  ioOut(`  id:                 ${result.id}\n`);
  ioOut(`  name:               ${result.manifest.name}\n`);
  ioOut(`  owner_tier:         ${result.manifest.owner_tier}\n`);
  ioOut(`  providers_enabled:  ${typeof result.manifest.providers_enabled === 'string' ? result.manifest.providers_enabled : `[${result.manifest.providers_enabled.join(', ')}]`}\n`);
  ioOut(`  created_at:         ${result.manifest.created_at}\n`);
  ioOut(`  manifest:           ~/.olp/keys/${result.id}/manifest.json\n`);
  if (advertise) {
    // D69 (ADR 0011): explicit warning when plaintext lands on disk + opt-in surface.
    ioOut(`  advertise:          YES — plaintext stored in manifest; surfaced via /health.anonymousKey\n`);
    ioErr(`\n  WARNING: this key's plaintext is now stored on disk + will be exposed via\n`);
    ioErr(`           /health.anonymousKey when auth.advertise_anonymous_key=true AND\n`);
    ioErr(`           auth.allow_anonymous=true. Use ONLY on a trusted LAN. See ADR 0011.\n`);
  }
  ioOut(`\n  token (plaintext):  ${result.plaintext_token}\n\n`);
  ioOut(`  Pass via:           Authorization: Bearer ${result.plaintext_token.slice(0, 12)}...\n`);
  ioOut(`              or:     x-api-key: ${result.plaintext_token.slice(0, 12)}...\n\n`);
  return 0;
}

function cmdList(flags, ioOut, ioErr) {
  const olpHome = flags['olp-home'];
  const ownerOnly = flags['owner-only'] === true;
  const includeRevoked = flags['include-revoked'] === true;
  let keys = listKeys({ olpHome });
  if (ownerOnly) keys = keys.filter(k => k.owner_tier === 'owner');
  if (!includeRevoked) keys = keys.filter(k => k.revoked_at === null);

  if (keys.length === 0) {
    ioOut('No keys.\n');
    return 0;
  }

  ioOut(`\n  ${keys.length} key${keys.length === 1 ? '' : 's'}:\n\n`);
  for (const k of keys) {
    const providers = typeof k.providers_enabled === 'string'
      ? k.providers_enabled
      : `[${k.providers_enabled.join(', ')}]`;
    const status = k.revoked_at === null ? 'active' : `revoked (${k.revoked_at})`;
    const lastUsed = k.last_used_at ?? 'never';
    ioOut(`  id=${k.id}\n`);
    ioOut(`    name:       ${k.name}\n`);
    ioOut(`    owner_tier: ${k.owner_tier}\n`);
    ioOut(`    providers:  ${providers}\n`);
    ioOut(`    status:     ${status}\n`);
    ioOut(`    created:    ${k.created_at}\n`);
    ioOut(`    last_used:  ${lastUsed}\n`);
    if (k.notes) ioOut(`    notes:      ${k.notes}\n`);
    ioOut('\n');
  }
  return 0;
}

async function cmdRevoke(flags, ioOut, ioErr) {
  const olpHome = flags['olp-home'];
  const id = typeof flags.id === 'string' ? flags.id : null;
  if (!id) {
    ioErr('Error: --id=<key-id> is required.\n');
    return 1;
  }

  // Confirm the key exists before attempting revoke (clearer error path).
  const m = readManifest(id, { olpHome });
  if (m === null) {
    ioErr(`Error: no key with id="${id}".\n`);
    return 2;
  }
  if (m.revoked_at !== null) {
    ioOut(`Key id=${id} already revoked at ${m.revoked_at} (no-op).\n`);
    return 0;
  }

  try {
    await revokeKey({ id, olpHome });
  } catch (err) {
    ioErr(`Error: revokeKey failed: ${err?.message ?? err}\n`);
    return 2;
  }

  ioOut(`Revoked key id=${id} name="${m.name}".\n`);
  return 0;
}

// ── CLI entry ────────────────────────────────────────────────────────────

/**
 * Run the CLI with explicit argv + IO streams. Returns the intended exit code.
 * Exported for tests (no process.exit, no direct stdout/stderr).
 *
 * @param {string[]} argv - args AFTER the subcommand name (e.g., ['keygen', '--owner']).
 *                         The first element is the subcommand.
 * @param {object} [opts]
 * @param {(s: string) => void} [opts.out] - stdout writer; defaults to process.stdout.write
 * @param {(s: string) => void} [opts.err] - stderr writer; defaults to process.stderr.write
 * @returns {Promise<number>} exit code 0 / 1 / 2
 */
export async function runCli(argv, opts = {}) {
  const ioOut = opts.out ?? (s => process.stdout.write(s));
  const ioErr = opts.err ?? (s => process.stderr.write(s));

  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    ioOut(USAGE + '\n');
    return argv.length === 0 ? 1 : 0;
  }

  const [subcommand, ...rest] = argv;
  const { flags } = parseArgv(rest);

  switch (subcommand) {
    case 'keygen': return await cmdKeygen(flags, ioOut, ioErr);
    case 'list':   return cmdList(flags, ioOut, ioErr);
    case 'revoke': return await cmdRevoke(flags, ioOut, ioErr);
    default:
      ioErr(`Error: unknown subcommand "${subcommand}".\n${USAGE}\n`);
      return 1;
  }
}

// Main guard: only run when invoked as the entrypoint. ESM equivalent of
// `require.main === module` is comparing import.meta.url against argv[1].
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  runCli(process.argv.slice(2)).then(code => process.exit(code));
}

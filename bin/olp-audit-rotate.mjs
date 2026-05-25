#!/usr/bin/env node
/**
 * bin/olp-audit-rotate.mjs — External audit rotation cron tool (Phase 3 / D52)
 *
 * Authority: ADR 0008 § 5.2 (external cron alternative to in-server first-
 * append-after-UTC-midnight trigger).
 *
 * Use case: operators who want exact-at-UTC-midnight rotation rather than
 * "first request after midnight". Invoke from a host cron / launchd job.
 *
 * Idempotent + safe to run alongside the in-server check (both detect the
 * date condition; whichever fires first does the rename; the other no-ops).
 *
 * Usage:
 *   olp-audit-rotate [--olp-home=<path>]
 *
 * Exit codes:
 *   0 = success (rotation performed OR no rotation needed)
 *   1 = bad usage (unknown flag)
 *   2 = rotation attempted + failed (e.g., EACCES)
 *
 * Example cron line (UTC midnight):
 *   1 0 * * * /usr/local/bin/node /path/to/bin/olp-audit-rotate.mjs >> /var/log/olp-audit-rotate.log 2>&1
 */

import { _maybeRotateAudit } from '../lib/audit.mjs';

function parseArgv(argv) {
  const flags = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      else flags[arg.slice(2)] = true;
    }
  }
  return flags;
}

const USAGE = `OLP audit rotation cron tool

Usage:
  olp-audit-rotate [--olp-home=<path>]

Triggers a rotation check: if the live audit.ndjson holds events from a
past UTC date, rename it to audit-YYYY-MM-DD.ndjson. Idempotent; safe to
run alongside the in-server first-append-after-UTC-midnight trigger.

Authority: ADR 0008 § 5.2.`;

export async function runCli(argv, opts = {}) {
  const ioOut = opts.out ?? (s => process.stdout.write(s));
  const ioErr = opts.err ?? (s => process.stderr.write(s));

  if (argv.includes('--help') || argv.includes('-h')) {
    ioOut(USAGE + '\n');
    return 0;
  }

  const flags = parseArgv(argv);
  const allowed = new Set(['olp-home', 'help', 'h']);
  for (const k of Object.keys(flags)) {
    if (!allowed.has(k)) {
      ioErr(`Error: unknown flag --${k}\n${USAGE}\n`);
      return 1;
    }
  }

  const olpHome = typeof flags['olp-home'] === 'string' ? flags['olp-home'] : undefined;

  try {
    // _maybeRotateAudit is synchronous at v0.3.0 (D52) — rotation must
    // complete BEFORE the next append so no event straddles the boundary.
    const result = _maybeRotateAudit({ olpHome });
    if (result.rotated) {
      ioOut(`Rotated ${result.fromPath} -> ${result.toPath} (dateUsed=${result.dateUsed}).\n`);
    } else {
      ioOut('No rotation needed (live audit is current or absent).\n');
    }
    return 0;
  } catch (err) {
    ioErr(`Error: rotation failed: ${err?.message ?? err}\n`);
    return 2;
  }
}

// Main guard
const isMain = (() => {
  try { return import.meta.url === `file://${process.argv[1]}`; }
  catch { return false; }
})();
if (isMain) {
  runCli(process.argv.slice(2)).then(code => process.exit(code));
}

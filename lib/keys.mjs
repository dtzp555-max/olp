/**
 * lib/keys.mjs — OLP multi-key auth (Phase 2 / D44 core)
 *
 * Authority: ADR 0007 (multi-key auth). Read that ADR before modifying.
 *
 * This module implements the identity / lifecycle layer for OLP API keys:
 *   - Opaque token generation (§ 5)
 *   - Manifest read + atomic write (§ 6.1)
 *   - Per-key in-process write-lock (§ 6.4)
 *   - touchLastUsed read-modify-write with revoke preservation (§ 6.3)
 *   - validateKey lookup with NO validation cache (§ 6.3.5) — manifests are
 *     read on every authenticated request
 *   - Env override (OLP_OWNER_TOKEN → __env_owner__) per § 9.4
 *   - Anonymous escape-hatch identity per § 7
 *
 * What is NOT in this module (intentional split):
 *   - audit ndjson append (§ 6.2) — request-layer concern; D45 (server.mjs glue)
 *   - keygen CLI bootstrap surface (§ 9.1) — D45+ (separate command entry)
 *   - server.mjs integration (replace '__anonymous__' constants) — D45
 *   - owner-vs-guest /health + X-OLP-Fallback-Detail gating — D46
 *
 * The module is filesystem-only at v0.2.0. The future Option-3 SQLite-indexed
 * mirror (ADR 0007 § 13) is invisible from this module's API — when added, the
 * SQLite write happens inside writeManifestAtomic / revokeKey and the module's
 * public surface is unchanged.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  readFileSync, writeFileSync, openSync, fsyncSync, closeSync,
  renameSync, readdirSync, mkdirSync, chmodSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Constants ─────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 1;
export const TOKEN_PREFIX = 'olp_';
export const TOKEN_RANDOM_BYTES = 32;        // 256 bits entropy
export const KEY_ID_RANDOM_BYTES = 6;        // 8 base64url chars

export const ANONYMOUS_KEY_ID = '__anonymous__';
export const ENV_OWNER_KEY_ID = '__env_owner__';
export const ENV_OWNER_VAR = 'OLP_OWNER_TOKEN';

const DEFAULT_OLP_HOME = join(homedir(), '.olp');

// ── Internal state ────────────────────────────────────────────────────────

// Per-key in-process write-lock chain (§ 6.4). Map<key-id, Promise>.
// Each entry is the tail of the promise chain for that key-id; serialized
// access via _withKeyLock.
const _writeLocks = new Map();

// Test hook: injected pause between touchLastUsed's read and write phases.
// Used by acceptance criterion #7 to deterministically reproduce the
// interleaved revoke-during-touch race. Default no-op.
let _touchInterleaveHook = async () => {};

// ── Path helpers ──────────────────────────────────────────────────────────

function _olpHome(opts) { return opts?.olpHome ?? DEFAULT_OLP_HOME; }
function _keysDir(opts) { return join(_olpHome(opts), 'keys'); }
function _keyDir(id, opts) { return join(_keysDir(opts), id); }
function _manifestPath(id, opts) { return join(_keyDir(id, opts), 'manifest.json'); }

// ── Crypto helpers ────────────────────────────────────────────────────────

/**
 * Generate an opaque OLP token per § 5: `olp_<32-byte base64url>`.
 * Total length 47 chars (4 prefix + 43 base64url).
 */
export function generateToken() {
  return TOKEN_PREFIX + randomBytes(TOKEN_RANDOM_BYTES).toString('base64url');
}

/**
 * Generate a key-id per § 3: lowercase alphanumeric + hyphen + underscore.
 * 8 base64url chars from 6 random bytes; lowercased.
 */
export function generateKeyId() {
  return randomBytes(KEY_ID_RANDOM_BYTES).toString('base64url').toLowerCase();
}

/**
 * SHA-256 of the full token string (prefix included), hex-lowercase.
 * Matches § 5 hash spec.
 */
export function hashToken(plaintextToken) {
  return createHash('sha256').update(plaintextToken).digest('hex');
}

/**
 * Constant-time comparison of two hex-encoded hashes.
 * Returns false on length mismatch (rather than throwing).
 */
function _safeHexCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ── Manifest schema validation (§ 4) ──────────────────────────────────────

/**
 * Validates a parsed manifest object against the § 4 schema.
 * Throws Error('manifest_invalid: <reason>') on schema violations.
 * Unknown fields are tolerated (forward-compat).
 */
export function validateManifest(obj) {
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('manifest_invalid: not an object');
  }
  if (obj.schema_version !== SCHEMA_VERSION) {
    throw new Error(`manifest_invalid: unrecognized schema_version ${obj.schema_version}`);
  }
  for (const field of ['id', 'name', 'token_hash', 'token_hash_algo', 'owner_tier', 'providers_enabled', 'created_at']) {
    if (obj[field] === undefined) {
      throw new Error(`manifest_invalid: missing required field "${field}"`);
    }
  }
  if (obj.token_hash_algo !== 'sha256') {
    throw new Error(`manifest_invalid: unsupported token_hash_algo "${obj.token_hash_algo}"`);
  }
  if (!['owner', 'guest'].includes(obj.owner_tier)) {
    throw new Error(`manifest_invalid: owner_tier must be "owner" or "guest", got "${obj.owner_tier}"`);
  }
  if (!(obj.providers_enabled === '*' || Array.isArray(obj.providers_enabled))) {
    throw new Error('manifest_invalid: providers_enabled must be "*" or array');
  }
  return obj;
}

// ── Manifest IO (§ 6.1) ───────────────────────────────────────────────────

/**
 * Read manifest for a key-id. Returns parsed object or null if file absent.
 * Throws on JSON parse error or schema violation.
 */
export function readManifest(id, opts = {}) {
  const path = _manifestPath(id, opts);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  const obj = JSON.parse(raw);
  if (obj.id !== id) {
    throw new Error(`manifest_id_mismatch: directory "${id}" contains manifest with id "${obj.id}"`);
  }
  return validateManifest(obj);
}

/**
 * Atomic manifest write per § 6.1: tmpfile + fsync + rename, 0600 file / 0700 dir.
 * Caller MUST hold the per-key write-lock (§ 6.4) when invoking this for
 * lifecycle events. Lock acquisition is the caller's responsibility because
 * createKey allocates a new key-id (no existing lock yet) while revoke /
 * touchLastUsed operate on an existing key-id.
 */
export function writeManifestAtomic(id, manifest, opts = {}) {
  if (manifest.id !== id) {
    throw new Error(`writeManifestAtomic: manifest.id "${manifest.id}" mismatches id arg "${id}"`);
  }
  validateManifest(manifest);

  const dir = _keyDir(id, opts);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* tolerate EPERM on pre-existing dir */ }

  const finalPath = _manifestPath(id, opts);
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const serialized = JSON.stringify(manifest, null, 2) + '\n';

  const fd = openSync(tmpPath, 'w', 0o600);
  try {
    writeFileSync(fd, serialized);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, finalPath);
  // § 6.1 step 5: enforce 0600 even if umask interfered.
  try { chmodSync(finalPath, 0o600); } catch { /* tolerate EPERM */ }
}

// ── Per-key write lock (§ 6.4) ────────────────────────────────────────────

/**
 * Serialize concurrent in-process writes against the same key-id.
 * Returns the value produced by fn(); awaits prior queued work first.
 *
 * Lock-map semantics: each caller stores its own `next` promise as the
 * Map tail. New callers chain off the stored tail (`get(id)` returns the
 * current tail = prior caller's next). On finally, we compare-and-delete
 * the tail by identity — if no one queued after us, the Map still points
 * at our `next` and we clean up; if a later caller chained, the Map points
 * at their `next` and we leave it alone.
 *
 * (D44 fold-in correctness fix: prior version stored
 * `prev.then(() => next)`, a derived promise that never matched the
 * cleanup-identity check, leaving stale Map entries per unique key-id.
 * Storing `next` directly fixes the cleanup; tested by 19u-extra.)
 */
async function _withKeyLock(id, fn) {
  const prev = _writeLocks.get(id) ?? Promise.resolve();
  let release;
  const next = new Promise(r => { release = r; });
  _writeLocks.set(id, next);

  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (_writeLocks.get(id) === next) _writeLocks.delete(id);
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Create a new OLP key. Generates a fresh opaque token (returned in
 * plaintext exactly once) and writes the manifest atomically.
 *
 * @param {object} args
 * @param {string} args.name - human label (required, non-empty)
 * @param {'owner'|'guest'} [args.owner_tier='guest']
 * @param {string[]|'*'} [args.providers_enabled='*']
 * @param {string} [args.notes='']
 * @param {string} [args.olpHome] - test override; defaults to ~/.olp
 * @returns {{ id: string, plaintext_token: string, manifest: object }}
 *   The plaintext_token MUST be displayed to the operator exactly once and
 *   never logged. The manifest contains only the hash.
 */
export function createKey(args = {}) {
  const { name, owner_tier = 'guest', providers_enabled = '*', notes = '', olpHome } = args;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('createKey: name is required (non-empty string)');
  }
  if (!['owner', 'guest'].includes(owner_tier)) {
    throw new Error(`createKey: owner_tier must be "owner" or "guest", got "${owner_tier}"`);
  }
  if (!(providers_enabled === '*' || Array.isArray(providers_enabled))) {
    throw new Error('createKey: providers_enabled must be "*" or string array');
  }

  const id = generateKeyId();
  const plaintext_token = generateToken();
  const manifest = {
    schema_version: SCHEMA_VERSION,
    id,
    name,
    token_hash: hashToken(plaintext_token),
    token_hash_algo: 'sha256',
    owner_tier,
    providers_enabled,
    quota: null,
    created_at: new Date().toISOString(),
    revoked_at: null,
    last_used_at: null,
    notes,
  };
  writeManifestAtomic(id, manifest, { olpHome });
  return { id, plaintext_token, manifest };
}

/**
 * List all keys. Returns array of manifest objects with `token_hash` redacted
 * (kept on disk; omitted from list output per common operational hygiene —
 * the hash itself is non-secret but listing it bulk-reads adds nothing).
 *
 * Skips manifests that fail schema validation; would log warn in real impl.
 *
 * @returns {Array<object>} possibly empty
 */
export function listKeys(opts = {}) {
  const dir = _keysDir(opts);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  const out = [];
  for (const id of entries) {
    if (id.startsWith('.')) continue;
    try {
      const m = readManifest(id, opts);
      if (m === null) continue;
      // Redact token_hash from list output (keep on disk).
      const { token_hash, ...rest } = m;
      out.push(rest);
    } catch {
      // Skip invalid manifest; production impl would log warn.
      continue;
    }
  }
  return out;
}

/**
 * Revoke a key by id. Sets revoked_at to current ISO timestamp.
 * Idempotent: revoking an already-revoked key returns true without rewriting.
 * Returns false if the key-id does not exist on disk.
 */
export async function revokeKey(args = {}) {
  const { id, olpHome } = args;
  if (!id || typeof id !== 'string') throw new Error('revokeKey: id required');
  return _withKeyLock(id, async () => {
    const m = readManifest(id, { olpHome });
    if (m === null) return false;
    if (m.revoked_at !== null) return true; // already revoked; no-op
    m.revoked_at = new Date().toISOString();
    writeManifestAtomic(id, m, { olpHome });
    return true;
  });
}

/**
 * Validate a plaintext token. Returns an identity object on success, null
 * on any failure (missing token, no match, revoked, manifest invalid).
 *
 * Resolution order:
 *   1. If plaintext === process.env.OLP_OWNER_TOKEN → synthetic env-owner identity.
 *   2. If !plaintext and allowAnonymous → anonymous identity.
 *   3. Else hash plaintext, scan ~/.olp/keys/ for a manifest with matching hash.
 *      Revoked manifests return null (caller produces 401 key_revoked).
 *
 * § 6.3.5: this function MUST hit the manifest filesystem on every call
 * (no in-process validation cache at Phase 2).
 *
 * @param {string|null} plaintextToken
 * @param {object} [opts]
 * @param {boolean} [opts.allowAnonymous=false] - server reads config and passes through
 * @param {string} [opts.olpHome]
 * @returns {{ id, owner_tier, providers_enabled, source }|null}
 */
export function validateKey(plaintextToken, opts = {}) {
  const { allowAnonymous = false, olpHome } = opts;

  // Defensive: non-string truthy inputs (number, object, etc.) return null
  // rather than throwing in hashToken. Matches missing-token semantics.
  // (D44 fold-in P2 #2: prior version threw TypeError on validateKey({}) /
  // validateKey(42) by reaching createHash().update(<non-string>).)
  if (plaintextToken != null && typeof plaintextToken !== 'string') return null;

  // 1. Env owner override (§ 9.4)
  const envToken = process.env[ENV_OWNER_VAR];
  if (envToken && plaintextToken && _safeHexCompare(hashToken(plaintextToken), hashToken(envToken))) {
    return {
      id: ENV_OWNER_KEY_ID,
      owner_tier: 'owner',
      providers_enabled: '*',
      source: 'env',
    };
  }

  // 2. Anonymous fallback (§ 7)
  if (!plaintextToken) {
    if (allowAnonymous) {
      return {
        id: ANONYMOUS_KEY_ID,
        owner_tier: 'anonymous',
        providers_enabled: '*',
        source: 'anonymous',
      };
    }
    return null;
  }

  // 3. Filesystem manifest lookup (§ 6.3.5 — every request, no cache)
  const dir = _keysDir({ olpHome });
  if (!existsSync(dir)) return null;
  const hash = hashToken(plaintextToken);
  let entries;
  try { entries = readdirSync(dir); } catch { return null; }

  for (const id of entries) {
    if (id.startsWith('.')) continue;
    let m;
    try { m = readManifest(id, { olpHome }); } catch { continue; }
    if (m === null) continue;
    if (!_safeHexCompare(m.token_hash, hash)) continue;
    if (m.revoked_at !== null) return null; // revoked → caller produces 401
    return {
      id: m.id,
      owner_tier: m.owner_tier,
      providers_enabled: m.providers_enabled,
      source: 'filesystem',
    };
  }
  return null;
}

/**
 * Update last_used_at lazily after a successful request. Per § 6.3:
 *   1. Re-read latest manifest from disk inside the per-key write-lock.
 *   2. If revoked_at is non-null in fresh read → NO-OP (preserve revocation).
 *   3. Otherwise merge new last_used_at preserving all other fields.
 *
 * Best-effort: any error is logged via console.warn and swallowed; this
 * function never throws (§ 6.3 "Failure logs warn and does NOT fail the
 * request").
 *
 * Anonymous + env-owner identities have no manifest → no-op silently.
 */
export async function touchLastUsed(id, opts = {}) {
  if (id === ANONYMOUS_KEY_ID || id === ENV_OWNER_KEY_ID) return;

  try {
    await _withKeyLock(id, async () => {
      // Test hook fires BEFORE the read so race tests can deterministically
      // inject an external revoke that the read must observe. In production
      // the hook is a no-op; the read is the only filesystem access and
      // happens inside the per-key write-lock.
      await _touchInterleaveHook(id, opts);
      // § 6.3 step 1: re-read latest manifest inside the lock.
      const fresh = readManifest(id, opts);
      if (fresh === null) return; // key removed from disk
      // § 6.3 step 2: NO-OP if revoked.
      if (fresh.revoked_at !== null) return;
      // § 6.3 step 3: merge last_used_at preserving all other fields.
      fresh.last_used_at = new Date().toISOString();
      writeManifestAtomic(id, fresh, opts);
    });
  } catch (err) {
    // § 6.3 best-effort: warn, never throw.
    console.warn(JSON.stringify({
      event: 'last_used_update_failed',
      id,
      error: err?.message ?? String(err),
    }));
  }
}

// ── Test-only hooks ───────────────────────────────────────────────────────

/**
 * Test-only: install a hook called inside touchLastUsed between the
 * read-phase and write-phase. Used to deterministically reproduce the
 * interleaved-revoke race (acceptance criterion #7).
 *
 * Pass null to reset to no-op.
 */
export function __setTouchInterleaveHook(hookOrNull) {
  _touchInterleaveHook = hookOrNull ?? (async () => {});
}

/**
 * Test-only: clear all in-process write-locks. Useful for test cleanup
 * to avoid lock state leaking across tests.
 */
export function __resetWriteLocks() {
  _writeLocks.clear();
}

/**
 * Test-only: report the current size of the in-process write-lock Map.
 * Used by Suite 19 to verify lock cleanup fires (D44 fold-in P2 #1
 * regression test — Map must shrink to 0 after all queued callers finish).
 */
export function __writeLockSize() {
  return _writeLocks.size;
}

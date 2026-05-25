# ADR 0007 — Multi-Key Auth (`lib/keys.mjs`)

- **Date:** 2026-05-25
- **Status:** Accepted (D43-B, design-only — implementation D-days D44+ follow)
- **Authors:** project maintainer (with AI drafting assistance)
- **Related:**
  - OLP v0.1 spec § 4.5 (Auth & multi-key) — the planning authority for the `~/.olp/` layout used in § 3 below
  - ADR 0001 (project founding) — single-tenant family-scale framing; this ADR keeps that framing while enabling multi-identity isolation within a single deployment
  - ADR 0002 (plugin architecture) — `hints.cacheable` opt-out demonstrates the per-plugin gating pattern this ADR extends to per-key gating
  - ADR 0004 Amendment 5 (D40 `X-OLP-Fallback-Detail`) — explicitly defers owner-only header gating to "Phase 2 when `lib/keys.mjs` lands"; this ADR is that landing event
  - ADR 0005 (cache cross-provider) — D1 per-key isolation: the cache layer is already keyed by `keyId` (`Map<keyId, Map<cacheKey, CacheEntry>>` at `lib/cache/store.mjs:77-79`); this ADR fills the `keyId` source that is hardcoded to `'__anonymous__'` in `server.mjs` at v0.1.1
- **Prior-art authority:** OCP `keys.mjs` (at the maintainer workstation `~/ocp/keys.mjs`, OCP v3.13.0 production reference) — model adapted; storage strategy diverges per § 11 below
- **Phase 2 provenance:** `~/.cc-rules/memory/handoffs/2026-05-25-phase-2-kickoff.md` (committed in `cc-rules` `d9da966`) captures the catch-up brief, lane separation, and the four amendments the maintainer pinned during D43-B drafting

---

## 1. Context

OLP v0.1.1 ships with the cache namespace hardcoded to `'__anonymous__'` (server.mjs ~L502 buffered handler, ~L531 streaming handler). The cache data model in `lib/cache/store.mjs` is already segmented by `keyId` (per-key Map + per-key stats + per-key singleflight key composition), but the identity layer that produces a real `keyId` does not exist yet.

Phase 2 of OLP introduces multi-key authentication so a single OLP deployment can serve multiple human users (e.g., maintainer + family members + a CI client) with:

- **Per-key cache namespace isolation** — already wired in `store.mjs`; only the `keyId` source needs to land.
- **Per-key audit trail** — which key issued which request, what provider/model served it, what fallback / cache outcome resulted.
- **Per-key provider access scoping** — each key declares which providers it may invoke (`providers_enabled`).
- **Owner-vs-guest gating** for debug/observability surfaces that should not leak to non-owner identities, specifically:
  - `/health` — currently returns full per-provider details to any caller. README has long claimed `/health` is owner-only (README.md § API Endpoints), but no auth gate has shipped. Phase 2 closes that gap.
  - `X-OLP-Fallback-Detail` — D40 / ADR 0004 Amendment 5 explicitly shipped the header **ungated** at v0.1 with the note "Phase 2 will re-introduce owner-vs-non-owner gating when `lib/keys.mjs` lands."

OCP solved an adjacent problem with `keys.mjs` (~417 LOC, SQLite-backed, single-tenant LAN mode). OLP cannot port that code verbatim — see § 11 (Node runtime baseline) — but the model (opaque key + per-key namespace + per-key audit + per-key quota) is the prior art this ADR adapts.

**Phase 2 is not a v1.x cross-phase deliverable.** `docs/v1x-roadmap.md` lists seven deferred items; only **#2 (multi-key auth)** is the Phase 2 mainline. The others (#1 streaming SF, #3 soft triggers, #4 `/health` `activeSpawns`, etc.) are triggered on demand and stay on the v1.x tracker.

---

## 2. Decision

OLP Phase 2 ships **filesystem-only multi-key auth with opaque tokens**, structured for migratability to a SQLite-indexed model when Phase 3+ Dashboard / SQL-aggregate quota work justifies that change.

Three load-bearing choices:

| Axis | Choice | Rationale |
|---|---|---|
| **Storage** | Filesystem manifest per key (`~/.olp/keys/<key-id>/manifest.json`) + append-only audit ndjson (`~/.olp/logs/audit.ndjson`) | Matches v0.1 spec § 4.5 layout; zero-dep within current Node baseline (§ 11); trivially backed-up / human-inspectable / git-crypt-encryptable; per-key isolation natural via filesystem hierarchy |
| **Token format** | Opaque `olp_<32-byte base64url>`; manifest stores SHA-256 hash, never plaintext | Mirrors OCP's `ocp_<24-byte>` opaque pattern; revocation is single-record (no JWT revocation-list problem); validation is single manifest read; family-scale has no stateless-validation pressure |
| **Migration lane** | Manifest remains the declarative SPOT in all future revisions; SQLite (if added in Phase 3+) becomes a query-side index synced on every manifest/audit write | Forward path documented in § 13 — never a single-direction door; manifest schema is always source of truth |

The decision **rejects** three plausible alternatives:

- **Option 1 (direct SQLite port from OCP)** — rejected at v0.2.0 because of a runtime baseline mismatch documented in § 11, not because of any flaw in SQLite or in OCP's design.
- **JWT tokens** — rejected because OLP has no stateless-validation pressure (the deployment is a single Node process; one manifest read per request is cheaper than the JWT-issuance / rotation / revocation-list infrastructure).
- **Auto-detected "dev mode" anonymous fallback** — rejected because behavioural divergence based on heuristics (NODE_ENV, hostname, port, etc.) creates security-incident-prone surprises. Anonymous access is an explicit configuration toggle (§ 7) or it does not happen.

---

## 3. Storage layout (`~/.olp/`)

The layout below is normative for v0.2.0. Each path is binary in spec — present-and-honored or absent-and-defaulted. No path may be silently created with a different name.

```
~/.olp/
  config.json                       — top-level config (existing); gains `auth` block per § 7
  keys/                             — chmod 0700; per-key SPOT
    <key-id>/
      manifest.json                 — chmod 0600; JSON; schema in § 4
  logs/                             — chmod 0700
    audit.ndjson                    — chmod 0600; one JSON event per line; schema in § 8
  providers/                        — existing; per-provider auth artifact root
    anthropic/credentials.json
    openai/codex_token.json
    mistral/api_key.env
  cache/                            — file-backed cache (📋 v1.x); chmod 0700 when introduced
```

**`<key-id>` format.** Lowercase alphanumeric + hyphen + underscore, 8–32 chars, generated by the keygen command. NOT derived from the secret token — `<key-id>` is the public namespace identifier (cache key prefix, audit `key_id` field, log correlator); the secret token is separate.

**Why a directory per key (vs one `keys.json` index file).** Future per-key augmentation (per-key cache index, per-key provider-specific auth override, per-key rate-limit state) can land as additional files in `keys/<key-id>/` without re-writing a shared index. The directory is the namespace.

---

## 4. Manifest schema (`keys/<key-id>/manifest.json`)

```json
{
  "schema_version": 1,
  "id": "<key-id>",
  "name": "<human-label>",
  "token_hash": "<sha256-hex of the opaque token>",
  "token_hash_algo": "sha256",
  "owner_tier": "owner" | "guest",
  "providers_enabled": ["<provider-key>", ...] | "*",
  "quota": null,
  "created_at": "<ISO-8601 UTC>",
  "revoked_at": null | "<ISO-8601 UTC>",
  "last_used_at": null | "<ISO-8601 UTC>",
  "notes": "<optional free-form>"
}
```

Field semantics:

- **`schema_version`** — `1` at v0.2.0. Increment on any non-additive change to this schema. Implementation reads `schema_version` first; rejects unrecognized versions with a clear error.
- **`id`** — matches the parent directory name. If they disagree, validation fails (`manifest_id_mismatch`).
- **`name`** — human label for `olp keys list` output. Required, non-empty.
- **`token_hash`** — SHA-256 of the plaintext token (lowercase hex). The plaintext token is NEVER stored.
- **`token_hash_algo`** — `"sha256"` at v0.2.0. Schema-versioned forward-compat for future algorithm rotation.
- **`owner_tier`** — `"owner"` grants full /health + X-OLP-Fallback-Detail visibility; `"guest"` does not (§ 7).
- **`providers_enabled`** — array of provider keys (matching `models-registry.json` provider entries) OR literal `"*"` for all providers. Empty array `[]` means the key can authenticate but cannot dispatch any provider call (returns 403 with `key_no_provider_access`).
- **`quota`** — `null` at Phase 2 (no enforcement). Reserved for Phase 3+ quota work. Implementations MUST read `null` as "no quota enforcement"; non-null shapes are deferred to a Phase 3 ADR amendment.
- **`created_at`** — set at key creation; never modified.
- **`revoked_at`** — `null` while active; set to current timestamp on revocation. Revoked keys fail validation with `401 key_revoked`; their manifest stays on disk for audit attribution.
- **`last_used_at`** — updated on successful validation. Best-effort (lazy write OK; failure to update does NOT fail the request — § 6).
- **`notes`** — optional; useful for "spouse's laptop", "Pi staging", etc.

**Schema rigidity.** Unrecognized fields cause a warn but not a reject (forward-compat). Missing required fields cause a reject (`manifest_invalid`).

---

## 5. Token format

```
olp_<32 bytes from crypto.randomBytes, base64url-encoded, no padding>
```

- Prefix `olp_` is fixed (mirrors OCP's `ocp_`); enables grep / regex detection in logs / secret-scanners.
- 32 bytes = 256 bits of entropy. base64url-encoded = 43 characters; total token length = 47 characters including prefix.
- Hash with `crypto.createHash('sha256')` over the full token string (prefix included). Hex-lowercase the digest for `manifest.token_hash`.

**Why SHA-256, not argon2/bcrypt.** Argon2-class slow hashes are for low-entropy secrets (passwords). A 256-bit random token has no brute-force exposure in the relevant attack-cost model; SHA-256 is sufficient and ~6 orders of magnitude faster, which matters because validation runs on every request.

**No plaintext storage, ever.** The plaintext token leaves the keygen command (printed to stdout once) and the authenticated request (HTTP header). It is never logged, never written to manifest, never written to audit. The only persistent representation is the hash in `manifest.token_hash`.

---

## 6. Atomic write & audit append

Two distinct write surfaces with different semantics:

### 6.1 Manifest writes (lifecycle events only)

Manifest writes fire ONLY on key lifecycle events: `createKey`, `revokeKey`, `updateKey` (e.g., setting `providers_enabled`), and `touchLastUsed` (the lazy `last_used_at` update). Manifest is **not** written per request — per-request state goes to audit.

Atomic write pattern (POSIX):

1. Compute target path: `~/.olp/keys/<key-id>/manifest.json`.
2. Write to tmpfile in same directory: `~/.olp/keys/<key-id>/manifest.json.tmp.<pid>.<counter>`.
3. `fsync()` the tmpfile fd.
4. `rename()` tmpfile → final path (same-filesystem atomic).
5. Directory mode 0700, file mode 0600 enforced on every write.

POSIX-strict atomic-replace also requires `fsync()` on the containing directory after the rename to guarantee survival of an OS crash mid-flush. Phase 2 deliberately omits the directory fsync: the single-process family-scale deployment model accepts a tiny window where a rename can be lost under abrupt host crash. The trade-off is documented here so a future POSIX-strict deployment knows where to add the step.

Failure semantics:
- Step 2/3/4 failure → throw; caller handles. Lifecycle commands (`olp keygen` / `olp keys revoke`) report failure to the operator and exit non-zero. Server requests do not trigger lifecycle writes (the `touchLastUsed` path is best-effort — see 6.3).

### 6.2 Audit ndjson appends (per-request)

Per-request audit events append a single newline-terminated JSON object to `~/.olp/logs/audit.ndjson`.

Append pattern:

1. Serialize event (§ 8 schema) with trailing `\n`. Serialization fires AFTER `status_code` is determined and `latency_ms` is measured (i.e., after the request handler emits the response, around `res.end()` finalization). This pinning is what makes acceptance criterion #2 testable — the 401-on-anonymous case records `status_code: 401` + `latency_ms` in the same audit event.
2. `fs.appendFile(path, line, { mode: 0o600 })` (Node default opens with append flag).
3. On EAGAIN / EBUSY / ENOSPC: log warn `audit_append_failed_once` + retry once (synchronous, no backoff at Phase 2 — family-scale write rate makes contention rare).
4. On second-failure: log warn `audit_append_dropped` with the failure reason + a per-process drop counter; **do not block the request**; **do not buffer** (memory buffer is a forward path in § 13, deliberately not in Phase 2 scope).

Failure semantics:
- Audit append failure NEVER fails the request. Auditing is observability, not authorization.
- Dropped audit events surface via the warn log and the dropped-count metric (exposed in /health owner-tier view per § 7).

### 6.3 `last_used_at` lazy update (revoke-dominates-touch)

The `touchLastUsed` write goes through the same atomic-write pattern as 6.1, but is fired async after request response is dispatched. Failure logs warn `last_used_update_failed` and does NOT fail the request.

**Read-modify-write with revoke preservation.** `touchLastUsed` MUST:

1. Re-read the latest manifest from disk inside the per-key write-lock (§6.4) — not reuse the snapshot the validating request held.
2. If `revoked_at` is non-null in the freshly-read manifest, NO-OP (do not write). A revocation occurred between request validation and this lazy touch; the request was the last legitimate use of the now-revoked key.
3. Otherwise, merge the new `last_used_at` value into the freshly-read manifest, preserving ALL other fields including `revoked_at`, and write via the atomic-rename pattern.

This protects against the failure mode where a stale manifest snapshot held by the touch path overwrites a fresh revoke and silently clears `revoked_at` back to `null`. The safety property is **revoke dominates touch**: any ordering of CLI revoke and server-side `touchLastUsed` (revoke-then-touch, touch-then-revoke, or interleaved) leaves a revoked manifest. This is the contract that makes acceptance criterion #6 (post-revoke 401 within the next request) honest under concurrent CLI revoke + in-flight server request.

### 6.3.5 No in-process validation cache (Phase 2)

Token validation MUST hit the manifest on every authenticated request at Phase 2 — implementations MUST NOT introduce an in-process LRU / TTL cache of validation results. Rationale: revocation must take effect on the next request without an invalidation hop; the family-scale request rate makes per-request manifest read O(1) on the OS file-system cache. This is the contract that makes acceptance criterion #6 (post-revoke 401 within the next request) honest. A validation cache is a forward-path consideration if Phase 3+ load profile demands it; a separate ADR amendment ratifies the cache shape + invalidation contract before any cache code lands.

### 6.4 Locking (single-process Phase 2)

OLP at v0.2.0 is a single Node process per host. Concurrent manifest writes from inside the process are serialized via an in-process Map of per-key write-locks (`Map<key-id, Promise>`). Concurrent writes from outside the process (e.g., maintainer running `olp keys revoke` while server is running) are not protected by file locks at Phase 2.

Safety frame: the atomic-rename pattern guarantees corruption-free file content (no partial-merge state on disk), and the **read-before-write discipline in §6.3** makes the worst case "stale `last_used_at` field" (observability-grade) rather than "revoked_at silently cleared" (security-grade). Without §6.3, a touch carrying a pre-revoke snapshot could overwrite revoke and break acceptance criterion #6; with §6.3, any interleaving of revoke and touch leaves a revoked manifest. The CLI `revoke` writer always wins the dimension that matters; the touch writer may lose its `last_used_at` update if it raced a revoke (acceptable — the revoked key will not be used again).

Forward path: file-locking (`flock(2)`) is reserved if a future Phase introduces multi-writer scenarios (e.g., a setup wizard process running alongside the server). With multi-writer, §6.3's read-before-write still holds the revoke-dominates-touch contract; file-locking only adds defense-in-depth against rare time-of-check-time-of-use windows where two processes both re-read a non-revoked manifest, then both write back with the touch path silently dropping a concurrent in-flight revoke from a third writer.

---

## 7. Owner / guest / anonymous gating

### 7.1 The three identity classes

| Class | Source | Cache namespace | `/health` visibility | `X-OLP-Fallback-Detail` visibility | `/v1/chat/completions` |
|---|---|---|---|---|---|
| **owner** | Valid OLP key with `owner_tier: "owner"` | per-key (`<key-id>`) | full per-provider details | yes (header emitted) | yes |
| **guest** | Valid OLP key with `owner_tier: "guest"` | per-key (`<key-id>`) | trimmed (`{ status, version }` only) | no (header suppressed) | yes (scoped by `providers_enabled`) |
| **anonymous** | No `Authorization` / `x-api-key` header, AND `config.json auth.allow_anonymous: true` | `__anonymous__` (shared) | trimmed (`{ status, version }` only) | no (header suppressed) | yes |

When `auth.allow_anonymous: false` (default) and no key is presented, all routes return `401 auth_required`.

### 7.2 Configuration

`~/.olp/config.json` gains an `auth` block:

```json
{
  "auth": {
    "allow_anonymous": false,
    "owner_only_endpoints": ["/health", "/v0/management/quota"],
    "fallback_detail_header_policy": "owner_only"
  }
}
```

- **`allow_anonymous`** — default `false`. When `true`, requests without a key are accepted and namespaced under the legacy `__anonymous__` cache keyId.
- **`owner_only_endpoints`** — list of HTTP paths returning trimmed payloads to non-owner identities. `/health` is the canonical example.
- **`fallback_detail_header_policy`** — `"owner_only"` (default) emits `X-OLP-Fallback-Detail` only to owner tier. `"all"` reverts to v0.1.1 ungated behaviour. `"none"` suppresses unconditionally. The policy is the v0.1.1 → v0.2.0 migration knob for operators who want to delay re-gating.

### 7.3 Environment-based behaviour is rejected

Phase 2 deliberately does NOT auto-detect "dev" vs "production" via `NODE_ENV`, `hostname`, port, or any other heuristic. The rule is: `config.json auth.allow_anonymous` is the truth, and the operator sets it explicitly. Behavioural divergence on environment heuristics is a known source of "it works locally" security incidents and is out of scope by design.

---

## 8. Audit ndjson schema

One JSON object per line (newline-terminated, UTF-8), written by the per-request audit-append path (§ 6.2).

```json
{
  "ts": "<ISO-8601 UTC>",
  "key_id": "<key-id>" | "__anonymous__" | "__env_owner__",
  "owner_tier": "owner" | "guest" | "anonymous",
  "method": "POST" | "GET" | ...,
  "path": "/v1/chat/completions" | "/v1/models" | ...,
  "provider": "<provider-key>" | null,
  "model": "<requested-model>" | null,
  "status_code": 200 | 401 | 503 | ...,
  "latency_ms": <int>,
  "cache_status": "hit" | "miss" | "bypass" | null,
  "fallback_hops": <int>,
  "tried_providers": ["<provider-key>", ...],
  "error_code": null | "<ProviderError code>",
  "ir_request_hash": "<short hex>" | null,
  "chain_id": "<correlator>" | null
}
```

Field origin:

- `ts` / `key_id` / `owner_tier` — set by the auth middleware.
- `method` / `path` / `status_code` / `latency_ms` — set by the request handler.
- `provider` / `model` / `cache_status` / `fallback_hops` / `tried_providers` / `error_code` — sourced from the existing D28 per-hop log fields (no new computation; same shapes the structured log already exposes).
- `ir_request_hash` / `chain_id` — sourced from D28 fields directly; enable join across audit, structured log, and the `X-OLP-Fallback-Detail` tuple.

**No PII.** Audit deliberately captures NO request body, NO response body, NO IR-message content. Hash + shape only. This is a personal/family deployment property; do not relax without a separate ADR amendment.

**`tried_providers` semantics (clarification, D53 / 2026-05-25).** The field captures the list of providers the server **actually dispatched a spawn against** for this request. A provider that was configured in the chain but filtered out by `providers_enabled` gating (resulting in 403 `key_no_provider_access`) is NOT included — the key didn't try the provider, the gate did. On the 403 path `tried_providers` is the empty array. The configured-but-blocked chain providers appear in the human-readable error message returned to the client but are intentionally NOT surfaced in the audit event, so downstream queries like "which providers did key X actually call" stay accurate. This semantic was implicit in the D45 implementation (where the field was set to the original chain on 403, misrepresenting "tried"); D53 corrects the implementation + amends this section to spell out the intent.

**Rotation.** Phase 2 does NOT rotate `audit.ndjson`. Rotation policy ships in Phase 3 — daily rotation via `lib/audit.mjs` `_maybeRotateAudit` synchronous trigger on first append after UTC date change + optional `bin/olp-audit-rotate.mjs` external cron. See ADR 0008 § 5.

---

## 9. Bootstrap & recovery

### 9.1 Minimal keygen command surface

Phase 2 MUST ship at least one executable entry that:

1. Generates an opaque OLP token (§ 5 format).
2. Computes its SHA-256 hash.
3. Writes a `keys/<key-id>/manifest.json` per § 4 with `owner_tier: "owner"` (first key) or as specified by flag.
4. Prints the plaintext token to stdout **exactly once**. The token is otherwise never logged.
5. Returns non-zero on any failure (manifest path conflict, filesystem permission, etc.).

The concrete shape — `npx olp keygen --owner`, `node bin/keygen.mjs --owner`, `node lib/keys/cli.mjs keygen --owner`, etc. — is an implementation choice and lands at D44 or D45. ADR 0007 does not pin the shape; it pins the requirement that the surface exists and is reproducible without manual file editing.

### 9.2 First-run flow

When `~/.olp/keys/` is empty AND `auth.allow_anonymous: false` (defaults), the server refuses to start `/v1/chat/completions` requests with a clear `401 no_keys_configured` until the operator runs the keygen command. The server itself does NOT auto-generate a key on first run — explicit operator action is required so the plaintext-once contract (§ 9.1 step 4) is honored on a terminal the operator can see.

When `~/.olp/keys/` is empty AND `auth.allow_anonymous: true`, the server starts normally and serves all requests under `__anonymous__`. Useful for dev / single-user-no-multi-tenancy deployments.

### 9.3 Owner key loss / rotation

If the operator loses their owner token, recovery is `<keygen-command> --owner --force`:

1. Generate a fresh owner key (new `<key-id>`, new plaintext).
2. Mark all existing `owner_tier: "owner"` keys' `revoked_at` to current timestamp. (Existing guest keys are not affected.)
3. Print the new plaintext once.

The old token is permanently invalid after revocation; the manifest stays on disk for audit attribution.

### 9.4 `OLP_OWNER_TOKEN` environment override

For headless / CI / containerized deployments, the env var `OLP_OWNER_TOKEN` is honored:

- Server startup reads `OLP_OWNER_TOKEN`. If set, the value is treated as a synthetic owner identity with stable `key_id: "__env_owner__"`.
- The plaintext token is NEVER logged, NEVER written to manifest, NEVER written to audit. The raw token leaves the env var and the request `Authorization` header only.
- Cache namespacing uses `__env_owner__` as the `keyId`, isolating env-owner traffic from filesystem-owner traffic.
- Audit attribution uses `key_id: "__env_owner__"` and `owner_tier: "owner"`.
- Server startup logs warn `non_persistent_owner_token` with no token material, alerting the operator that the env-owner identity will disappear on restart unless re-set.

Filesystem-stored owner keys (from § 9.1/9.2) continue to validate independently when `OLP_OWNER_TOKEN` is set; the env-owner is an additive credential, not a replacement.

**Token-collision policy.** Hash-collision between an `OLP_OWNER_TOKEN` plaintext and a filesystem-stored key's plaintext is undefined behaviour at Phase 2 (cache namespacing would diverge silently between `__env_owner__` and the filesystem `<key-id>`, while audit attribution would split). Operators MUST NOT reuse the same plaintext token across both surfaces. A future Phase MAY add a collision-detection startup check; not in Phase 2 scope.

---

## 10. Acceptance criteria

Implementation D-days (D44+) MUST land tests covering:

1. **Per-key cache isolation** — Two keys A and B with identical request payloads do NOT share cache. `cache_status` is `miss` for both first calls and `hit` for the second call from the SAME key only.
2. **Anonymous prod-default off** — With `auth.allow_anonymous: false` (no override), a request without a key receives `401 auth_required`; the audit event is recorded with `key_id: "__anonymous__"` and `status_code: 401`.
3. **Anonymous dev-mode on** — With `auth.allow_anonymous: true`, the same request succeeds with `keyId="__anonymous__"`.
4. **Owner-vs-guest /health gating (with default `auth.owner_only_endpoints` config)** — Owner key sees the full per-provider `providers` map in `/health`; guest key + anonymous see only `{ status, version }`. Test rephrases if the operator's `owner_only_endpoints` config does not include `/health` (test must assert the same gating predicate the config produces, not a hardcoded trimmed payload shape).
5. **Owner-vs-guest X-OLP-Fallback-Detail gating** — Same response payload for both owner and guest; header present for owner only.
6. **Key revocation** — After `revoke`, subsequent requests with that token return `401 key_revoked` within the next request (no caching of validation).
7. **Manifest atomicity + revoke-dominates-touch (§ 6.3, § 6.4)** — Concurrent `revoke` + `touchLastUsed` writes do not corrupt the manifest AND revoke always survives. Test: spawn two writers racing on the same key (revoke vs `touchLastUsed`) under three orderings — revoke-then-touch, touch-then-revoke, and interleaved (touch reads pre-revoke snapshot, then revoke writes, then touch attempts write). For all three orderings, assert: (a) final file parses as valid JSON; (b) `revoked_at` is non-null and equals the revoke writer's timestamp; (c) `last_used_at` may have either writer's value. The test FAILS if any interleaving produces `revoked_at: null` after the revoke writer completed. This pins the §6.3 read-before-write discipline.
8. **Audit ndjson round-trip** — Every line in `audit.ndjson` parses as valid JSON; every required field present; PII fields (message content, response content) absent.
9. **Bootstrap keygen surface** — The minimal keygen command (whatever shape D44 chooses) runs end-to-end without manual file editing, produces a working owner key, and prints the plaintext exactly once.
10. **`OLP_OWNER_TOKEN` env override** — With the env var set, a request bearing the env token validates as `keyId="__env_owner__"` with `owner_tier="owner"`; the raw token does NOT appear in any log line, audit event, or stack trace.
11. **`providers_enabled` scope enforcement** — A guest key with `providers_enabled: ["anthropic"]` requesting `model` that routes to `openai` receives `403 key_no_provider_access` and an audit event with the rejection reason.

---

## 11. Node baseline / storage portability

Option 2 (filesystem-only) was chosen at v0.2.0 over Option 1 (direct port of OCP's SQLite-backed `keys.mjs`) because of a runtime-baseline mismatch, not a critique of SQLite or of OCP's design.

Evidence:

- OLP `package.json` declares `engines.node` `">=18"` (file line 11).
- CI test matrix in `.github/workflows/test.yml` runs Node 20 and 24 (file line 13).
- `node:sqlite` was added in Node **v22.5.0**; v22.12 still required the `--experimental-sqlite` runtime flag to import; current Node API docs mark the module as **Release Candidate** (post-experimental but pre-stable). Source: https://nodejs.org/api/sqlite.html (retrieved during D43-B drafting 2026-05-25).

Adopting `node:sqlite` at v0.2.0 would require, in this order:

1. Raise `engines.node` to a version where the API is at minimum non-flag-gated. Per Node's release-history docs — v22.5.0 added the API behind `--experimental-sqlite` (source: https://nodejs.org/download/release/v22.12.0/docs/api/sqlite.html confirms v22.12 still required the flag); the module moved past flag-gating in **v22.13.0 (LTS line)** and **v23.4.0 (current line)**; the API entered **Release Candidate at v25.7.0** per current docs (https://nodejs.org/api/sqlite.html). The minimum non-flag-gated baseline for `engines.node` is therefore `>=22.13.0` (or `>=23.4.0` on the non-LTS path). A stable (post-RC) baseline is TBD pending future Node releases beyond v25.x.
2. Update the CI test matrix to drop Node 20 (or move the SQLite-using code behind a runtime feature check that exercises both code paths in CI).
3. Accept Release-Candidate API stability risk in the project's storage layer for the period until the API moves to stable.

These three are achievable but are not zero-cost and have second-order effects (e.g., existing Node 20 deployments by family clients break on upgrade). Phase 2 does not undertake them; § 13 documents the forward path.

**Decision posture statement.** "SQLite is good; the runtime baseline says not yet."

---

## 12. Out of scope (Phase 3+)

The following are deliberately deferred from Phase 2 and tracked elsewhere:

- **Dashboard (`dashboard.html`)** — owner-only multi-provider quota / fallback / cache-hit-rate panels. Deferred to **Phase 3**. (Was originally bundled into "Phase 6" in the pre-v0.1.1 README phase plan; the post-D43-A plan re-aligned this to Phase 3.)
- **Quota enforcement (`manifest.quota` non-null shapes)** — manifest schema reserves the field; semantics + enforcement land in a Phase 3 ADR amendment.
- **Audit query layer / rotation** — `audit.ndjson` is append-only at Phase 2; rotation policy + indexed query lands with Dashboard work (Phase 3).
- **Per-key per-provider auth artifact mapping** — Phase 2 uses the global `~/.olp/providers/<name>/` artifacts for all keys. Per-key override (e.g., two OLP keys each authenticated to a different OpenAI Codex account) is a Phase 3+ concern; the spec § 4.5 phrasing "Multi-key support per provider" anticipates this without locking the design.
- **Audit memory buffer on append failure** — see § 6.2 note; deliberate forward-path-only.
- **File-locking (`flock(2)`)** — see § 6.4 note.

---

## 13. Future forward — Option 3 migration (Phase 3+)

When Dashboard / SQL-aggregate quota / >5 users / multi-second audit-query workload arrives, OLP's storage layer migrates to a **hybrid** model that retains manifest as the declarative SPOT and adds a SQLite-indexed query mirror.

Required preconditions BEFORE any migration commit:

1. A separate prior PR raises `engines.node` and updates the CI matrix per § 11. This PR ships independently of any storage change.
2. An ADR amendment to this file documents the migration trigger (which of the criteria above fired) and the schema mapping from manifest → SQLite rows.
3. The migration code is a one-shot sync that reads every existing manifest, replays the audit log, populates SQLite from scratch, then begins dual-writing. Manifest writes remain authoritative; SQLite is rebuildable from manifest + audit at any time.

The migration is one-way (additive — SQLite gets added; manifest stays). Reverting from hybrid to manifest-only is supported by stopping SQLite writes and deleting the DB file.

**Forward-path audit memory buffer.** If audit append failures become non-rare (operational hint: `audit_append_dropped` count exceeds threshold in /health), Phase 3+ may add an in-process bounded buffer that flushes opportunistically. The buffer's design (size cap, flush interval, persistence on shutdown) is out of scope for Phase 2 and is a separate ADR amendment.

---

## Consequences

**Positive:**

- Closes the long-standing `lib/keys.mjs` 📋-Planned gap in AGENTS.md / README.md / v1x-roadmap.md.
- Lets D40 `X-OLP-Fallback-Detail` re-gate per its v0.1 deferral note.
- Lets README's long-standing claim "/health is owner-only" become factually true.
- Per-key cache namespacing becomes observable behaviour (was a latent affordance only).
- Family members can each have their own OLP key without sharing cache state.
- Audit trail per request enables troubleshooting questions ("did my call hit cache?", "which key triggered the fallback to mistral?") without inspecting logs.

**Negative / trade-offs:**

- Filesystem audit is O(N) for any aggregate query — acceptable until Phase 3 Dashboard work.
- Manifest atomicity at multi-writer scale is not bulletproof — see § 6.4; mitigated by the single-process Phase 2 deployment model.
- The plaintext-once contract puts UX burden on the keygen command output — operators must capture the token immediately on creation; lost = revoke + regenerate.
- Existing OCP users migrating will need new OLP keys (OCP's SQLite-backed keys are not portable to OLP's manifest layout — § 9 "Migration from OCP" in `scripts/migrate-from-ocp.mjs` 📋 Phase 7 may add a one-shot translator; not in Phase 2 scope).

**Reversibility:**

- Migration to Option 3 hybrid (§ 13) is supported and explicitly planned.
- Reverting Phase 2 entirely would require restoring the `__anonymous__` hardcoding in `server.mjs` and removing the auth middleware. The decision is reversible but no concrete trigger has been imagined; the decision is treated as durable.

---

## Authority citations

- **OLP v0.1 spec § 4.5** (planning authority for `~/.olp/` layout in § 3) — at `~/.cc-rules/memory/projects/olp_v0_1_spec.md` on the maintainer's workstations.
- **OCP `keys.mjs`** (prior-art reference for opaque-key + per-key isolation model) — at `~/ocp/keys.mjs` on the maintainer's workstation; OCP v3.13.0 production.
- **Phase 2 kickoff handoff** (decision provenance for Option 2 + opaque + four amendments) — `~/.cc-rules/memory/handoffs/2026-05-25-phase-2-kickoff.md` committed in `cc-rules` `d9da966`.
- **Node `node:sqlite` documentation** (rejection rationale for Option 1 in § 11) — https://nodejs.org/api/sqlite.html (retrieved 2026-05-25).
- **`lib/cache/store.mjs:77-79, :287`** (proof that per-keyId namespace + singleflight composition are wired and ready to receive a real `keyId`).
- **`server.mjs:502, :531`** (the two hardcoded `'__anonymous__'` call sites Phase 2 implementation replaces).
- **`server.mjs:392, :1072, :1101`** (the three call sites Phase 2 implementation gates: `/health` handler entry and the two `X-OLP-Fallback-Detail` header-write paths).
- **ADR 0004 Amendment 5** (D40 ungated header + Phase 2 re-gating deferral) — `docs/adr/0004-fallback-engine.md`.
- **CLAUDE.md `release_kit.phase_rolling_mode` `current_pre_release_identifier`** = `"0.2.0-phase2"` — confirms this ADR lands in the Phase 2 sprint.

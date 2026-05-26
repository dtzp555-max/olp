# ADR 0008 — Dashboard + Audit Query Layer (Phase 3)

- **Date:** 2026-05-25
- **Status:** Accepted (D48, design-only — implementation D-days D49–D54 follow; Phase 3 close = v0.3.0)

## Amendments

### Amendment 2 — 2026-05-27: v0.5.1 quota_v2 richer failure-mode shape (codex finding F3)

**Scope:** v0.5.1 hotfix extends `ProviderQuotaEntry` and `aggregateProviderQuota()` to surface richer failure-mode detail, addressing codex review finding F3 (operator cannot distinguish failure modes from the `unavailable` catch-all). Authority: ADR 0013 Rule 6 + codex review findings F1–F3.

#### 1. Extended `ProviderQuotaEntry` shape

```js
{
  provider: string,
  // v0.5.1: 'unreachable' added (probe enabled, creds present, but no cache + probe failed)
  status: 'live' | 'stale' | 'unreachable' | 'unavailable',
  reason?: string,           // only when status === 'unavailable' (no API or disabled)
  schema_version: string|null,
  last_fresh_at: number|null,
  utilization: { '5h': number|null, '7d': number|null } | null,
  reset: { '5h': number|null, '7d': number|null, overall: number|null, overage: number|null } | null,
  representative_claim: string|null,
  fallback_percentage: number|null,
  overage: { status: string|null, disabled_reason: string|null } | null,
  raw_available: boolean,
  // v0.5.1 (F3 — ADR 0013 Rule 6):
  failure: { kind, message, backoff_until? } | null,
  failure_kind: 'no_credentials'|'auth_failed'|'rate_limited'|'schema_drift'|'network'|'other' | null,
  // Note: 'opt_in_off' is NOT in this enum — when probe is opted out, the row's status
  // is 'unavailable' (not 'unreachable'); failure_kind stays null. Distinguishing
  // "user opted out" from "provider has no API" requires reading config separately.
  backoff_until: number | null,  // epoch-ms when next probe attempt is allowed
}
```

Status semantics:
- `'unavailable'` — probe disabled (`quota_probe_enabled: false`) OR provider has no public quota API (codex, mistral). `failure`, `failure_kind`, `backoff_until` are null.
- `'live'` — probe succeeded within TTL. `failure` is null.
- `'stale'` — probe failed but stale cache exists. `failure.kind` describes why the last probe failed. `last_fresh_at` is the epoch of the last successful probe. `backoff_until` tells when the next attempt is scheduled.
- `'unreachable'` (new) — probe enabled + creds present (or missing!) but no cache available + probe failed. `failure.kind` distinguishes: `no_credentials`, `auth_failed`, `rate_limited`, `schema_drift`, `network`, `other`. `utilization` and `reset` are null (no data).

#### 2. `quotaStatus()` v0.5.1 return contract

`null` is now RESERVED for `quota_probe_enabled: false` only. All other failure paths return a structured shape:

```js
null                  // ONLY: opt-in off
{ probe_status: 'live', ... }    // cache fresh
{ probe_status: 'stale', ..., failure: { kind, message, backoff_until } }  // cache stale + backoff
{ probe_status: 'unreachable', source, schemaVersion, failure: { ... } }   // no cache + failed
```

The `stale: boolean` field is retained for backwards-compat (`stale: false` on live, `stale: true` on stale). New code should use `probe_status`.

#### 3. `dashboard.html` unreachable rendering

A new CSS class `.provider-row.unreachable` (red border + light red background) and `.unreachable-reason` text style handle the new status. `failure.message` and `failure_kind` are surfaced as a short text line under the provider badge. `failure.backoff_until` renders a "backoff active: Xs remaining" note if within window.

#### 4. Authority

- ADR 0013 Rule 6 (failure transparency mandate)
- Codex review findings F1 (doctor bypass), F2 (200+empty-headers → schema_drift), F3 (failure-mode collapse)
- v0.5.1 hotfix PR

---

### Amendment 1 — 2026-05-26: D81 Phase 5 quota_v2 shape + aggregateProviderQuota()

**Scope:** D81 (Phase 5 / ADR 0012 D81) extends the audit-query layer and dashboard-data endpoint to surface the new per-provider quota shape introduced by D80 (`lib/providers/anthropic.mjs:quotaStatus()`). This amendment documents the three new interfaces.

#### 1. `models-registry.json` — new `quota_probe` top-level key

D81 adds a `quota_probe` key at the root of `models-registry.json` per ADR 0013 Rule 5 (schema_version in registry so downstream consumers can detect schema drift):

```json
{
  "quota_probe": {
    "schema_version": "2026-05-26",
    "anthropic": {
      "source": "anthropic-ratelimit-unified-headers",
      "endpoint": "https://api.anthropic.com/v1/messages",
      "fields_pinned": [ ...13 field names... ]
    }
  }
}
```

`fields_pinned` is load-bearing: if Anthropic adds/renames a header in a future CLI version, dashboard consumers comparing field-presence against this list can flag "schema drift detected" per the ADR 0013 Rule 5 drift-detection runbook. This field must be updated alongside the parser whenever a drift event occurs.

`lib/providers/anthropic.mjs` reads `quota_probe.schema_version` from the registry at call time (via `_resolveSchemaVersion()`) with the module-level `QUOTA_SCHEMA_VERSION` constant as fallback. No hard dependency on the registry — the constant is the safety net.

#### 2. `lib/audit-query.mjs` — new `aggregateProviderQuota()` export

```js
export async function aggregateProviderQuota({
  providers,           // Map<name, plugin> or plain object
  getQuotaStatus,      // optional injectable getter (name) => Promise<shape|null>
}): Promise<Array<ProviderQuotaEntry>>
```

For each provider, calls `quotaStatus()` (already cached at the plugin layer per ADR 0013 Rule 3) and normalizes to the `ProviderQuotaEntry` shape:

```js
{
  provider: string,
  status: 'live' | 'stale' | 'unavailable',
  reason?: string,              // only when status === 'unavailable'
  schema_version: string|null,
  last_fresh_at: number|null,   // epoch-ms of last successful probe
  utilization: { '5h': number|null, '7d': number|null } | null,
  reset: {
    '5h': number|null, '7d': number|null,
    overall: number|null, overage: number|null,
  } | null,
  representative_claim: string|null,
  fallback_percentage: number|null,
  overage: { status: string|null, disabled_reason: string|null } | null,
  raw_available: boolean,
}
```

Providers returning `null` from `quotaStatus()` (codex, mistral — no public quota API; or probe disabled) produce `{ status: 'unavailable', reason: 'no public quota api or probe disabled', ...null fields }`.

Providers whose `quotaStatus()` throws produce `{ status: 'unavailable', reason: <error.message>, ...null fields }`.

This function does NOT scan ndjson files; it calls live provider plugins. It is audit-query-adjacent (normalized query shape for the dashboard layer) but not audit-derived. Query model remains Lane 2 = A (in-memory, no SQLite).

#### 3. `/v0/management/dashboard-data` and `/v0/management/quota` — new `quota_v2` field

Both endpoints now return TWO quota keys:

- **`quota`** (legacy, unchanged): `Array<{ provider, ...rawQuotaStatus, available }>`. Kept for backwards compatibility with the existing `dashboard.html` (D82 will switch consumers to `quota_v2`).
- **`quota_v2`** (D81 new): `Array<ProviderQuotaEntry>` — the normalized shape from `aggregateProviderQuota()` above. This is what D82's enriched dashboard UI will consume.

Both fields are computed from the same underlying `quotaStatus()` call. The legacy `quota` key calls `quotaStatus()` independently from `quota_v2`; since the probe is cached at the plugin layer (ADR 0013 Rule 3), the double call incurs no extra API requests.

**Deprecation timeline:** the legacy `quota` key is deprecated as of D81. Target removal: v1.0.0 or when D82 completes the dashboard migration (whichever comes first). Removal requires a separate PR with a CHANGELOG entry.

#### 4. Failure handling

`aggregateProviderQuota()` never throws to the dashboard endpoint. Per-provider failures are absorbed as `{ status: 'unavailable', reason: <error> }` entries. If `aggregateProviderQuota()` itself throws (implementation bug), `handleManagementDashboardData` and `handleManagementQuota` catch the error, log `dashboard_data_quota_v2_failed` / `management_quota_v2_failed`, and return `quota_v2: []` so the rest of the payload is unaffected.

#### 5. Authority citations for this amendment

- **ADR 0012 D81** — the D-day this amendment documents.
- **ADR 0013 Rule 5** — mandate for `quota_probe.schema_version` in `models-registry.json`.
- **D80 PR #52 commit 82d2e1c** — the producer of the `quotaStatus()` shape this amendment normalizes.
- **ADR 0008 Lane 2 = A** — query model unchanged; `aggregateProviderQuota()` does not scan ndjson.

---
- **Authors:** project maintainer (with AI drafting assistance)
- **Related:**
  - OLP v0.1 spec § 4.6 (Dashboard requirements — port from OCP with multi-provider support) and § 4.7 (observability endpoints)
  - ADR 0007 § 12 (Phase 3+ out-of-scope: Dashboard, audit query layer, rotation) — this ADR opens those deferrals
  - ADR 0007 § 13 (Option 3 hybrid migration to SQLite) — explicitly **NOT** triggered by Phase 3; in-memory ndjson scan is the v0.3.0 query model
  - ADR 0007 § 7 (Identity classes) — Dashboard auth gating reuses owner-vs-non-owner pattern (Dashboard is owner-only)
  - ADR 0007 § 8 (Audit ndjson schema) — the data source the query layer reads
  - ADR 0004 Amendment 2 (soft triggers deferred to v1.x) — quota panel sources from `provider.quotaStatus()` which is a contract method; per-provider returns what it can or `null`
  - D45 reviewer P2 deferral on `tried_providers` semantics — addressed in this Phase as D53 (separate D-day; not in ADR 0008 scope)
- **Phase 3 kickoff authority:** maintainer "go" + standing-autopilot grant (`~/.cc-rules/memory/auto/standing_autopilot_phase_2.md` in cc-rules `bf0ed9a` — the grant explicitly excludes Phase 3+ as needing new authorization; the "go" supplied that)
- **Lanes pinned by maintainer 2026-05-25 (Phase 3 kickoff brief):**
  - Lane 1 Dashboard tech stack: **A** — static HTML + vanilla JS + fetch (no build step; matches OLP "no bundler" ethos)
  - Lane 2 Audit query model: **A** — in-memory scan of audit ndjson per request (O(N) per query; family-scale acceptable; SQLite deferred to Option 3 trigger per ADR 0007 § 13)
  - Lane 3 Audit rotation: **B** — daily rotation, files named `audit-YYYY-MM-DD.ndjson` (UTC date)
  - Lane 4 Refresh: **A** — page poll every 30s (no SSE infra introduction)
  - Lane 5 Dashboard scope: **B** — full per spec § 4.6 (quota + per-provider counts/cache/fallback last 24h + multi-provider spend trend last 30d + top fallback chains by trigger count)

---

## 1. Context

OLP v0.2.0 ships per-key audit ndjson at `~/.olp/logs/audit.ndjson` (ADR 0007 § 8) but provides no aggregate query surface or visualization. The audit file grows unbounded, and operators must `tail`/`grep` to observe basic facts ("which provider served the most requests today", "what's my cache hit rate", "how often did the chain fall back to OpenAI"). Phase 3 closes this gap with:

1. **`lib/audit-query.mjs`** — an in-memory aggregator that scans `~/.olp/logs/audit-*.ndjson` files in a configurable time window and returns shaped summaries.
2. **`server.mjs` `/v0/management/*` endpoints** — three owner-only JSON endpoints exposing the aggregate data: `/v0/management/dashboard-data`, `/v0/management/quota`, `/cache/stats`.
3. **`dashboard.html`** — a single static HTML file served from `/dashboard` (owner-only) that fetches the JSON endpoints, renders 4 panels, and polls every 30s.
4. **Daily audit rotation** — at UTC midnight (or on first append after a UTC-date change), the live `audit.ndjson` is renamed to `audit-YYYY-MM-DD.ndjson` and a fresh `audit.ndjson` opens. Cross-file queries handle the rolling 30-day window.

Phase 3 deliberately **does not** add a build step, a database, or per-key UI write surface. The first three are out of scope (Option 3 hybrid is § 13's forward path; SQLite has a Node-baseline blocker per § 11). The last is a security surface that warrants a separate review pass (Phase 4+).

Phase 3 is the natural home for OCP's `dashboard.html` port (v0.1 spec § 4.6 — "Port OCP's `dashboard.html` with multi-provider support"). OCP's dashboard was single-provider; OLP's is multi-provider, which is the substantive change. The HTML structure is otherwise lifted.

---

## 2. Decision

The five lanes above are normative. The deviation lattice they sit in:

| Lane | Pinned | Rejected (why) |
|---|---|---|
| **1. Tech stack** | Static HTML + vanilla JS + fetch | SSR (Node template literals) — adds server-side render path; CSP harder. SPA — adds build step, violates ethos. |
| **2. Query model** | In-memory scan of `audit-*.ndjson` per request | SQLite indexed mirror — touches ADR 0007 § 13 migration → engines bump prerequisite. In-memory rolling aggregate — complex (per-write incremental + window expiry), correctness risk. |
| **3. Rotation** | Daily UTC rotation (`audit-YYYY-MM-DD.ndjson`) | No rotation — single file grows unbounded at family scale ~10–100 lines/day but a year is ~10–50k lines, still ok but no natural query unit. Size-based (100MB / keep 5) — equivalent complexity, query range less intuitive. |
| **4. Refresh** | Page poll every 30s | SSE push — adds server-side subscriber state; not justified at family scale. Static-at-load — UX too poor. |
| **5. Dashboard scope** | Full per spec § 4.6 | Minimal (quota + cache + fallback only) — spec is already drafted; full is ~1 D-day more for trend + top-chains panels. Plus key-mgmt UI — security surface delta, Phase 4+. |

**Phase 3 does not** introduce: a database, a build step, an SPA framework, SSE for dashboard, or web-side key management. Each is a future-phase concern (Option 3 hybrid; SSE for dashboard if poll latency becomes pain; key-mgmt UI after a security review pass).

---

## 3. Storage layout (`~/.olp/logs/`)

```
~/.olp/logs/
  audit.ndjson                    — live append target (Phase 2 D45)
  audit-2026-05-24.ndjson         — yesterday (after rotation)
  audit-2026-05-23.ndjson
  audit-2026-05-22.ndjson
  ...
```

Files are append-only (no in-place edits). Rotation atomically renames the live file and opens a fresh one. All files have mode 0600; the `logs/` directory is 0700.

**Retention policy at v0.3.0:** unbounded by default (operator manages disk). A Phase 3+ amendment may add automatic retention (`olp_audit_max_days` config) once an observed operational need exists.

---

## 4. Audit query layer (`lib/audit-query.mjs`)

A new module that reads the rotated + live audit files in a date range and returns aggregate summaries. Per-call O(N) where N = total lines in the date range (family scale: thousands per day = trivial).

### 4.1 Public API

```js
// Read all audit lines in [startMs, endMs); returns iterator of parsed events.
// Skips malformed lines (logs warn) so a corrupted day doesn't kill the query.
export function* readAuditWindow({ startMs, endMs, olpHome }): Iterator<AuditEvent>;

// Aggregate request shape over a window. Returns:
//   {
//     window: { startMs, endMs },
//     request_count, status_2xx, status_4xx, status_5xx,
//     by_provider: { [providerKey]: { count, cache_hit, cache_miss, cache_bypass, fallback_count } },
//     by_owner_tier: { owner: N, guest: N, anonymous: N },
//     by_path: { '/v1/chat/completions': N, '/v1/models': N },
//     median_latency_ms, p95_latency_ms,
//   }
export function aggregateRequests({ windowMs, olpHome }): RequestAggregate;

// Top-N fallback chains by trigger count in window. Returns sorted array:
//   [{ chain: ['anthropic', 'openai'], count: 42, first_seen, last_seen }, ...]
export function topFallbackChains({ windowMs, limit, olpHome }): FallbackChainSummary[];

// Daily series of request_count + latency_median over N days. Returns sorted array:
//   [{ date: '2026-05-22', request_count, median_latency_ms, by_provider }, ...]
export function spendTrendDaily({ days, olpHome }): DailySpendEntry[];

// Cache hit rate snapshot (in-memory cacheStore stats + audit-derived numerator).
// Differs from /cache/stats: that returns the live in-memory CacheStore stats;
// this is the audit-side derived rate over the window.
export function cacheHitRateWindow({ windowMs, olpHome }): CacheHitRateSummary;
```

### 4.2 Window semantics

`windowMs` is a duration ending at "now"; `[now - windowMs, now)`. The implementation walks files whose date overlaps that range: today's `audit.ndjson` always; `audit-YYYY-MM-DD.ndjson` for each prior date in range. A line is included only if its `ts` (ISO-8601) falls in the window.

For the 30-day spend trend, `windowMs = 30 * 86400 * 1000`. The implementation buckets per UTC day and returns one entry per day, including days with zero requests (sparse-fill).

### 4.3 PII discipline

Per ADR 0007 § 8, audit events contain no message content, no response content, no raw tokens. The query layer relays only the schema fields. It MUST NOT introduce derived fields that reveal content (e.g., "first 50 chars of prompt").

### 4.4 Error handling

- Missing file → empty iteration (not an error).
- Malformed JSON line → log warn `audit_query_skip_malformed` + skip; continue.
- File-read error (EACCES, etc.) → throw to caller; the dashboard endpoint surfaces 500 with diagnostic message.

---

## 5. Audit rotation

### 5.1 Trigger

Rotation fires on the **first append after a UTC date change**. Implementation lives in `lib/audit.mjs` (extended at D49). On each `appendAuditEvent` call:

1. Compute `today = new Date().toISOString().slice(0, 10)` (e.g., `'2026-05-25'`).
2. Read a module-scoped `_currentDate` cached at startup.
3. If `today !== _currentDate` AND `audit.ndjson` exists AND it is non-empty:
   - Rename `audit.ndjson` → `audit-${_currentDate}.ndjson` (the previous day's date).
   - Set `_currentDate = today`.
   - Continue with the append (new `audit.ndjson` opens via append-create).

The check is per-call (microsecond cost). The rename is the only filesystem heavy op and fires once per UTC day.

### 5.2 External-cron alternative (`bin/olp-audit-rotate.mjs`)

An auxiliary script is shipped at D52 for operators who prefer cron-driven rotation (e.g., to rotate exactly at 00:00:00 UTC rather than "first request after midnight"). The script does the same rename + state-bump logic but can be invoked from a host cron / launchd job. The in-server check remains as a safety net; both can coexist.

### 5.3 Concurrent-rotation safety

In-process: the rotation logic is wrapped in a per-process lock (`Map<key='audit-rotate', Promise>`) so two concurrent `appendAuditEvent` calls don't both attempt the rename. External cron + in-server check: the in-server check sees the rename has already happened (file with today's date already exists if cron beat it); the no-op fallback is "if `audit.ndjson` exists, append; else create + append" — POSIX semantics.

### 5.4 Renamed-file query path

The query layer (§ 4) walks `audit-${date}.ndjson` files for any date in the window. Today's file is always `audit.ndjson` (not renamed yet); yesterday + prior are date-suffixed.

---

## 6. Dashboard panels (per spec § 4.6, Lane 5 = B full)

`dashboard.html` is a single static file served from `/dashboard`. Renders 4 panels in a 2×2 grid:

### 6.1 Panel 1 — Per-provider quota / credit pool

For each loaded provider, calls `provider.quotaStatus()` (ADR 0002 Provider contract). Returns whatever the provider can report (e.g., Anthropic Plan limits remaining, Codex credit pool balance) OR `null` (provider opts out — Phase 2 mistral has no quota API).

Each row shows:
- Provider key + display name
- Quota remaining / quota total (or "n/a" if null)
- Last poll timestamp

### 6.2 Panel 2 — Per-provider request count + cache hit rate + fallback rate (last 24h)

Uses `aggregateRequests({ windowMs: 86400 * 1000 })`. One row per provider showing:
- Request count (total served by that provider, regardless of chain position)
- Cache hit rate (% of requests where `cache_status === 'hit'`)
- Fallback rate (% of requests where `fallback_hops > 0`)
- 5xx error rate (% of requests where `status_code >= 500`)

### 6.3 Panel 3 — Multi-provider unified spend trend (last 30 days)

Uses `spendTrendDaily({ days: 30 })`. Shows a sparkline-style chart (vanilla SVG, no library) with:
- X axis: 30 daily buckets
- Y axis: request count per day (stacked by provider color)
- Hover tooltip: per-day breakdown by provider

Note: "spend trend" is the spec's term — at v0.3.0 we don't have provider-side cost integration (Anthropic Plan is flat-rate per Anthropic 2026-06-15 split per the learning memory). So "spend" is proxied by request count. A future ADR may add cost weights per provider when commercial cost-tracking lands.

### 6.4 Panel 4 — Top fallback chains by trigger count

Uses `topFallbackChains({ windowMs: 86400 * 1000, limit: 10 })`. Lists top 10 chains:
- Chain shape (e.g., `anthropic → openai`)
- Trigger count
- First / last seen timestamps

### 6.5 Refresh model (Lane 4 = A)

The dashboard sets a 30s `setInterval` that calls `fetch('/v0/management/dashboard-data')` + updates DOM in place (no full reload). Initial fetch on page load. The interval pauses when the page is hidden (via `document.visibilityState` listener) to avoid useless background polls.

### 6.6 Localhost-bound by default

The dashboard is served from the existing OLP HTTP port (default 4567 since v0.4.0 / D60; 3456 pre-v0.4.0) which is already bound to `127.0.0.1` per `server.mjs` startup (`server.listen(PORT, '127.0.0.1', ...)`). No additional binding logic. Remote operators access via SSH tunnel; ADR 0007 § 7 owner-only auth provides the per-request gate.

---

## 7. Server endpoints (D50)

All endpoints are owner-only per ADR 0007 § 7 (owner-tier validation through `authenticate`). Non-owner identities get 401 / 403 per existing patterns; anonymous (when `allow_anonymous: true`) gets 401 (these are management endpoints, not user-facing).

### 7.1 `GET /dashboard`

Serves `dashboard.html`. Owner-only gated. Content-Type `text/html; charset=utf-8`. Static file read once at server startup + cached in memory (small, no need to re-read per request).

### 7.2 `GET /v0/management/dashboard-data`

Returns the JSON payload the dashboard's 30s poll consumes. Shape:

```json
{
  "generated_at": "<ISO-8601>",
  "window_24h": <RequestAggregate from §4.1>,
  "quota": [
    { "provider": "anthropic", "quota_remaining": 1234, "quota_total": 5000, "polled_at": "<ISO-8601>" },
    { "provider": "openai", "quota_remaining": null }
  ],
  "spend_trend_30d": <DailySpendEntry[] from §4.1>,
  "top_fallback_chains_24h": <FallbackChainSummary[] from §4.1>,
  "cache_stats": <stats from server.mjs cacheStore.stats() — global aggregate>
}
```

### 7.3 `GET /v0/management/quota`

Returns just the quota array (subset of dashboard-data; useful for scripted monitoring).

### 7.4 `GET /cache/stats`

Returns the live in-memory `cacheStore.stats()` shape. Planning authority is **OLP v0.1 spec § 4.6** (which names `/cache/stats` explicitly); ADR 0005's `Consequences/Mitigations` paragraph (~ line 279) references it as the monitoring surface for per-`(provider, model)` cache hit-rate breakdown.

**Shape gap to resolve at D50.** The current `cacheStore.stats()` in `lib/cache/store.mjs:320-350` returns `{ hits, misses, size, inflightCount }` — global aggregate only, no per-`(provider, model)` breakdown. If D50 reveals the shape is insufficient for Panel 2 (per-provider 24h cache hit rate, currently sourced from `aggregateRequests` audit-side rather than `cacheStore.stats`), the dashboard endpoint is satisfied. If a future panel needs the per-`(provider, model)` breakdown that spec § 4.6 implies, D50 amends the store shape + an ADR 0005 amendment fires at that time. Phase 3 acceptance criteria do not require the breakdown.

### 7.5 Audit on management endpoints

All four endpoints append an audit row via the existing `appendAuditEvent` pattern. Path values are `/dashboard` / `/v0/management/dashboard-data` / `/v0/management/quota` / `/cache/stats`. The 30s poll generates 2880 dashboard rows per day per owner — manageable at family scale, but noted as a knob (a future amendment may suppress audit for these paths if they become noise-dominant).

---

## 8. Auth gating

Reuses ADR 0007 § 7 owner-vs-non-owner model + introduces a second gating mode.

**Two gating modes (this ADR formalizes the distinction):**

- **`owner_only_trim`** (Phase 2 / D46 model) — non-owner identities receive a 200 response with a trimmed payload (e.g., `/health` returns `{ ok, version }` only). Used when the endpoint has a baseline payload that is safe to share with all identities and an enriched payload only for owners.
- **`owner_only_block`** (Phase 3 / D48 new) — non-owner identities receive `401 invalid_or_revoked_key` (or `401 auth_required` if no token). Used when the entire payload is sensitive and there is no safe baseline to share (Dashboard quota stats, fallback chains by trigger, etc. all reveal operational behaviour that should not leak to non-owner identities).

The four new endpoints (`/dashboard`, `/v0/management/dashboard-data`, `/v0/management/quota`, `/cache/stats`) are `owner_only_block`. `/health` remains `owner_only_trim`.

The owner_only_endpoints config gains four entries; the gating-mode distinction is implementation-side (the handler decides whether to trim or block based on the endpoint). Server startup defaults `owner_only_endpoints` to include `/health` + the four new ones (Phase 3 default; operator can opt-out per-endpoint via config). Pre-Phase-3 deployments with `owner_only_endpoints: ['/health']` continue to work — the new endpoints will 401 for non-owner under that legacy config because the handler is `owner_only_block`-mode regardless of the config list (the config controls /health's trim/full toggle only; the management endpoints are not opt-out-able to a non-401 response).

`401` shapes match Phase 2 / D45 pattern: JSON `{ error: { message, type } }` with `type: 'auth_required'` or `'invalid_or_revoked_key'`.

---

## 9. Failure modes + graceful degradation

| Failure | Behavior |
|---|---|
| `audit.ndjson` absent (fresh install) | Empty arrays in all aggregates; dashboard shows "No requests in window" panels |
| `audit-YYYY-MM-DD.ndjson` corrupted (one bad line) | Skip line + log warn; continue; dashboard rendering unaffected |
| Provider `quotaStatus()` throws | Panel shows that row as `quota: "error"`; other providers' rows render normally |
| Dashboard `/v0/management/dashboard-data` query >5s | Dashboard JS shows "Loading…" with a timeout; second poll attempts after 30s |
| `audit.ndjson` rotation fails (rename EACCES) | `appendAuditEvent` warn `audit_rotate_failed` + continues appending to the un-rotated file; next call retries the rotation |
| File handle limit hit during 30-day query (many files open) | Query reads one file at a time (no parallel reads); never opens >2 simultaneously |

The dashboard degrades visibly (per-panel error states) rather than failing whole-page.

---

## 10. Acceptance criteria

Implementation D-days (D49+) MUST land tests covering:

1. **`readAuditWindow`** correctly iterates events from today's `audit.ndjson` + N prior rotated files within the window.
2. **`readAuditWindow`** skips malformed lines without throwing; logs warn for each.
3. **`aggregateRequests`** correctly counts by provider + cache_status + owner_tier + path; correctly computes median + p95 latency.
4. **`topFallbackChains`** returns sorted by count descending; ties broken by first-seen timestamp ascending.
5. **`spendTrendDaily`** sparse-fills zero-request days; window respects UTC day boundaries.
6. **Daily rotation** — writing past UTC midnight renames `audit.ndjson` → `audit-<yesterday>.ndjson` and continues appending to a fresh `audit.ndjson`.
7. **Cross-file query** — a 30-day window with mixed rotated files returns correctly merged results.
8. **Concurrent rotation safety** — N concurrent `appendAuditEvent` calls during a UTC date change result in exactly one rename + all lines append to the correct file.
9. **`GET /dashboard`** returns 200 HTML to owner; 401 to non-owner. This includes the case where `allow_anonymous: true` AND no Authorization header is presented: the authenticate middleware produces an anonymous identity, the `owner_only_block` mode then rejects with 401 (per § 8 — anonymous is non-owner; management endpoints block, do not trim). When `allow_anonymous: false` + no header, 401 fires earlier at the authenticate middleware itself. Test must cover both cases.
10. **`GET /v0/management/dashboard-data`** returns 200 JSON to owner with all required fields populated.
11. **`GET /cache/stats`** returns 200 JSON to owner with the live in-memory cache stats shape.
12. **Dashboard HTML smoke** — fetched via test http client + parsed → has the 4 panel containers + 30s poll script; no JS console errors when loaded in a real browser (manual or playwright; manual is acceptable at Phase 3).
13. **Audit on management endpoints** — calling `/v0/management/dashboard-data` appends an audit row with `path: '/v0/management/dashboard-data'` and `status_code: 200`.
14. **Graceful degradation** — when a provider's `quotaStatus()` throws, the dashboard endpoint still returns 200 with that provider's quota row showing `"quota_remaining": null` and an error indicator.
15. **PII guard** — every aggregate query function asserts at the test level that returned data does NOT include any message content; the `prompt`/`messages`/`response`/`content` fields MUST NEVER appear in any output shape.

---

## 11. Forward path (Phase 4+)

Items deliberately deferred:

- **SQLite migration (Option 3 hybrid)** — trigger: query latency >2s on a typical owner session, OR Dashboard usage scales beyond family (>5 owners polling). Preconditions per ADR 0007 § 13: engines bump + CI matrix change as a separate prior PR.
- **SSE push for dashboard live updates** — trigger: 30s poll feels stale, OR operator wants real-time view of streaming requests. Reuses existing streaming infra from ADR 0005 Amendment 8 (v1.x streaming SF when it ships).
- **Key-mgmt UI from dashboard** — owner can create/revoke/edit keys from the web UI rather than CLI. Out of Phase 3 because (a) it adds a write surface to the dashboard requiring careful CSRF handling, (b) security review of the auth flow is non-trivial, (c) the CLI surface from D47 covers the same use cases.
- **Cost weights per provider** — once provider-side cost tracking is feasible, "spend trend" can show actual dollars. At v0.3.0 it's a request-count proxy.
- **Audit retention / max-days policy** — currently unbounded; operator manages disk. A Phase 3+ amendment adds `audit_max_days` config when an operational need emerges.
- **Per-key dashboard views** — owner sees aggregate; per-key drill-down is a future amendment.

---

## 12. Out of scope (explicitly NOT in Phase 3)

- Per-key per-provider auth artifact mapping (ADR 0007 § 12; Phase 4+).
- `tried_providers` schema semantics fix on `key_no_provider_access` 403 — D45 reviewer P2 deferral. Tracked as a Phase 3 implementation D-day (D53) but NOT part of ADR 0008; documented in ADR 0004 amendment or ADR 0007 § 8 amendment at D53.
- All ADR 0007 § 12 deferrals other than Dashboard + audit query layer + rotation.
- Externally-visible Dashboard (anything bound to 0.0.0.0 / public). Operator SSH-tunnels.

---

## 13. Phase 3 sprint shape

| D-day | Deliverable | Type |
|---|---|---|
| **D48** | This ADR (0008 draft) | ADR-only |
| **D49** | `lib/audit-query.mjs` + Suite 23 unit tests | impl |
| **D50** | `server.mjs` `/v0/management/*` endpoints + `/dashboard` route + Suite 24 HTTP tests | impl |
| **D51** | `dashboard.html` + render JS + 30s poll | impl |
| **D52** | Audit daily rotation (`lib/audit.mjs` extension + `bin/olp-audit-rotate.mjs` + Suite 25 rotation tests) | impl |
| **D53** | `tried_providers` schema fix (D45 P2 deferral; small) | impl |
| **D54** | E2E browser smoke (manual or playwright) + AGENTS / README polish | tests + docs |
| **D55** | Phase 3 close → v0.3.0 (release-kit PR per `phase_close_trigger`) | release |

Each D-day = implementor + fresh-context opus reviewer per Iron Rule 10. Estimated wall-clock: similar to Phase 2 cadence (1 intense session per D-day under standing autopilot).

---

## Consequences

**Positive:**

- Operators get an at-a-glance view of OLP's behaviour (was a tail/grep exercise pre-Phase-3).
- Audit layer becomes queryable, not just append-only; `lib/audit-query.mjs` is reusable for future CLI tools (`olp-audit search` etc.).
- Daily rotation bounds per-file size + creates a natural archival unit.
- Owner-only gating reuses Phase 2 auth model (no new auth surface).
- v0.1 spec § 4.6 Dashboard requirements are met without introducing a build step / database / framework.

**Negative / trade-offs:**

- In-memory ndjson scan is O(N) per query; if audit grows to millions of lines (single-host years), the 30-day query becomes slow. Mitigation: ADR 0007 § 13 Option 3 hybrid is the documented next step; trigger is observed slowness.
- 30s poll generates baseline traffic when dashboard is open (2880 management requests/day per owner). Not a real cost but worth observing.
- Audit rotation is "first append after UTC midnight" which means a server with zero requests overnight rotates lazily (first request of the new day triggers it). External cron at D52 covers the strict-midnight case.
- No automatic audit retention. A multi-year-running server accumulates files; operator manages.

**Reversibility:**

- Dashboard is a static file + 4 endpoints. Removable in a future revert PR if Phase 3 retrospectively proves unwanted.
- Audit rotation is additive — disabling reverts to single-file behaviour without code change (operator never invokes the cron + the in-server rotation can be guarded by a config flag).
- The `lib/audit-query.mjs` module is consumed by Dashboard endpoints + can be used standalone; removing it requires unrelated endpoint surgery.

---

## Authority citations

- **OLP v0.1 spec § 4.6 + § 4.7** (Dashboard + observability endpoints) — at `~/.cc-rules/memory/projects/olp_v0_1_spec.md` on the maintainer's workstations.
- **OCP `dashboard.html`** (prior-art reference for the multi-panel HTML structure) — at `~/ocp/dashboard.html` on the maintainer's workstation; OCP production reference.
- **ADR 0007 §§ 7 / 8 / 12 / 13** (owner-gating model; audit ndjson schema; Phase 3 scope opening; SQLite forward path).
- **ADR 0002** (Provider contract — `quotaStatus` method that Panel 1 consumes).
- **OLP v0.1 spec § 4.6** (planning authority for `/cache/stats` endpoint name + Dashboard requirements). ADR 0005's `Consequences/Mitigations` paragraph references the endpoint as the monitoring surface for per-`(provider, model)` cache hit-rate breakdown; that breakdown is a Phase 4+ amendment trigger if needed (see § 7.4 above).
- **ADR 0004 Amendment 5** (D40 X-OLP-Fallback-Detail — top-fallback-chains panel data shape lineage).
- **Standing-autopilot grant** (`~/.cc-rules/memory/auto/standing_autopilot_phase_2.md` in cc-rules `bf0ed9a`) — Phase 3 kickoff via maintainer "go" + lane pin.
- **Phase 2 kickoff handoff pattern** (`~/.cc-rules/memory/handoffs/2026-05-25-phase-2-kickoff.md` in cc-rules `d9da966`) — this ADR follows the same structure.
- **CLAUDE.md `release_kit.phase_rolling_mode current_phase: Phase 3`** — confirms this ADR lands in the Phase 3 sprint.

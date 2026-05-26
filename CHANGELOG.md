# Changelog

All notable changes to OLP land here. Per `CLAUDE.md` release_kit overlay, this file is the source of truth for GitHub release notes.

## Unreleased

(empty — Phase 6 entries land here once Phase 6 opens)

## v0.5.0 — 2026-05-26

**Phase 5 — Provider Quota Probes + Dashboard Enrichment.** OLP gains live subscription-quota observability for Anthropic Pro/Max subscribers, surfaced through a Claude.ai-style Plan Usage panel on the owner-only dashboard. The probe is opt-in, READ-ONLY, idempotent on failure, and 5-min-cached with 60s→3600s exponential backoff. Six D-days, seven PRs, zero blocking reviewer findings, no flaky tests; 720 → 756 total tests.

### What's new for users

- **Live plan usage on the dashboard.** Per-provider rows show 5-hour + 7-day utilization bars with reset countdowns ("Resets in 1hr 6min" / "Resets Sun 9:00 PM"), status badges (allowed / rejected), representative-claim chips ("five_hour" / "seven_day"), overage-status indicators, and a `↻ Refresh` button. 60-second auto-refresh pauses when the tab is hidden.
- **Anthropic quota probe.** Opt-in via `~/.olp/config.json providers.anthropic.quota_probe_enabled: true`. Parses the canonical `anthropic-ratelimit-unified-*` response-header schema (13 fields) from a minimal `POST /v1/messages` probe. Reuses the spawn-path OAuth credentials — env var → `~/.claude/.credentials.json` → macOS Keychain. Refresh-on-401, stale-cache-on-failure.
- **`olp doctor anthropic.quota_probe_reachable`.** New check surfaces probe health. Returns `status: ok` with parsed utilization when fresh, `warn` on stale cache, `fail` with `human_steps[]` auth-aware recipe (re-login via `claude setup-token` or wait-and-retry).
- **Provider matrix.** Anthropic ✅ live (13 fields). OpenAI ❌ no public quota API. Mistral ❌ no member-key-accessible quota endpoint (Admin API exists but org-admin-scoped, out of scope for trusted-LAN deployment per ADR 0011). All three pinned in `models-registry.json quota_probe.<provider>` block.

### What's new for contributors

- **ADR 0012 (Phase 5 charter)** — D-day plan + exit gate + scope boundaries (`docs/adr/0012-phase-5-charter-quota-probes-dashboard.md`).
- **ADR 0002 Amendment 8** — first Class-specific Exception to the plugin contract: `quotaStatus()` may call provider HTTP APIs directly, subject to three constraints (READ-ONLY, subscription-scope, idempotent-failure) and the per-endpoint enumeration in ADR 0013 Rule 2.
- **ADR 0013** — seven rules covering OAuth READ-ONLY consumption + dual-path schema-drift mitigation (compiled-binary `strings` + live API probe diff, since Claude Code v2.1.x is now a Mach-O / ELF binary with no `cli.js` to grep).
- **`models-registry.json quota_probe.schema_version`** — pinned at `2026-05-26` (13 fields). Bump on schema-drift events per ADR 0013 Rule 5.
- **Test seams** — 5 underscore-prefixed exports in `lib/providers/anthropic.mjs` (`_setQuotaUrlsForTest`, `_resetQuotaProbeStateForTest`, `_resetQuotaStateOnlyForTest`, `_getQuotaProbeStateForTest`, `_setQuotaAuthReadFnForTest`) for hermetic probe testing. Production code must not call them.
- **ALIGNMENT.md § Class-specific Exceptions** — gains its first numbered exception (Anthropic plan-usage probe via direct `/v1/messages`).
- **Audit memory at `~/.cc-rules/memory/learnings/anthropic_plan_usage_probe_schema_2026_05_26.md`** — schema canon + verification protocol + OCP institutional history.

### D-day-level changes (Phase 5)

- **D79** (PR #50 + cleanup PR #51): governance layer — ADR 0012 charter, ADR 0002 Amendment 8, ADR 0013, ALIGNMENT.md Class-specific Exceptions entry, D84 Mistral NO-GO disposition.
- **D80** (PR #52): ported OCP `server.mjs:842-1109` to `lib/providers/anthropic.mjs:quotaStatus()`. Adds macOS-keychain reader to `readAuthArtifact()`. Parses all 13 fields including 3 new since OCP's 2026-04 capture (`5h-status`, `7d-status`, `overage-reset`). Implements 5min cache + 60s-3600s exponential refresh backoff + stale-cache-on-failure + opt-in config flag + `anthropic.quota_probe_reachable` doctor check. ~250 LOC.
- **D81** (PR #53): added `lib/audit-query.mjs aggregateProviderQuota()` + `/v0/management/dashboard-data quota_v2` field + `/v0/management/quota quota_v2` field. Pinned `quota_probe.schema_version` in `models-registry.json`. Legacy `quota` field stays alongside for backwards compat until v1.0.0. ADR 0008 Amendment 1 documents the shape.
- **D82** (PR #54): `dashboard.html` restructure — Claude.ai-style Plan Usage panel above the existing 4 panels. Per-provider rows with utilization bars, reset countdowns, status chips, representative-claim badges, overage chips, "Updated N min ago" labels. 60s `setInterval` with `visibilitychange` pause/resume. Manual refresh button with 2s spam guard. Graceful fallback to legacy `quota` when `quota_v2` absent. Closes v1.x roadmap #8.
- **D83** (PR #55): Suite 38 (20 quota-probe unit tests covering all 13-header parse + cache + backoff + 401-refresh + 429-stale + schema_version + 5 doctor status paths) + Suite 39 (8 dashboard rendering smoke tests covering /dashboard 200/401 + key D82 HTML strings). Added 5 test seams to anthropic.mjs. 727 → 755 tests, 0 fail. Fold-in commit added 38j positive-path coverage (38j2: 401 → refresh succeeds → retry 200) per reviewer finding; total 756.
- **Close-prep** (PR #56): README § Plan Usage section + § Supported Providers Quota-probe column + dashboard screenshot + `docs/exit-gates/phase-5-e2e.json` live verification artifact. Fold-in commit addressed 3 maintainer accuracy findings (doctor-kind framing / Mistral admin-API acknowledgment / SPOT drift closure via `quota_probe.openai` + `quota_probe.mistral` registry entries).

### Out of Phase 5 scope (deferred to later)

- **D84 Mistral probe.** NO-GO per 2026-05-26 spike: no member-key-accessible quota endpoint at `docs.mistral.ai/api`. Re-entry point pinned at `lib/providers/mistral.mjs DL-7`; re-evaluate if Mistral publishes a member-key surface or if OLP deployment posture expands to org-admin scope (Mistral Admin API exists).
- **OpenAI / codex probe.** Permanently skipped — `openai/codex` CLI has no public quota API.
- **`X-OLP-Cost-USD` per-request header.** Deferred to Phase 6 (depends on per-(provider, model) cost weights table).
- **`context_window_exceeded` fallback trigger.** Deferred (trigger condition not yet observed).
- **Automated schema-drift detector.** ADR 0013 Rule 5 codifies a procedural runbook (Annual Alignment Audit + `olp doctor` probe-failure + manual maintainer attention at major `claude --version` bumps), not an automated alarm.

### Authority cited

ALIGNMENT.md Rules 1 + 2 + 5; CLAUDE.md release_kit (Phase 5 close trigger); ADR 0012 § Exit gate; ADR 0013 Rule 5 schema-drift protocol; OCP `server.mjs:842-1109` as port reference; live `/v1/messages` probe transcripts captured 2026-05-26 from PI231 (D79 audit) + MacBook (D80 + Phase 5 close-prep E2E); audit memory at `~/.cc-rules/memory/learnings/anthropic_plan_usage_probe_schema_2026_05_26.md`.

## v0.4.4 — 2026-05-26

### D78 — `bin/olp-connect` stale-strings cleanup + README CDN-safe URL + repo-visibility flip

Patch release on top of v0.4.3. Three small issues caught when running `olp-connect` for real on MacBook (D77 client-install verification):

- **G11 fix (repo visibility).** Repo `dtzp555-max/olp` flipped from PRIVATE → PUBLIC during this session, closing the original G11 finding (`bash <(curl -fsSL .../main/bin/olp-connect)` returned 404 because anonymous curl can't fetch from private repos). README's `/main/` URL works going forward; GitHub's raw CDN may serve a stale 404 for `/main/` for ~5-15min after the visibility flip due to negative caching. D78 defends against this by adding a **tag-pinned URL (`/v0.4.4/bin/olp-connect`) as the primary recommendation in README**, with `/main/` listed as an alternative for trusted-head users. Tag-pinned URLs bypass the negative-cache because the tag ref was never queried while the repo was private.
- **G12 fix (`detect_openclaw` claimed plugin not shipped).** `bin/olp-connect`'s OpenClaw detection block said `"The OpenClaw OLP plugin (D71-D73) is NOT YET SHIPPED"` — but D71-D73 shipped `olp-plugin/` at v0.4.0. D78 replaces the stale text with real install instructions: `git clone` + `openclaw plugins install ./olp-plugin/` (or symlink), edit `~/.openclaw/openclaw.json` with a dedicated bot apiKey, restart gateway. Points at `docs/integrations/openclaw.md` for the full setup.
- **G13 fix (`olp-connect` self-version hardcoded literal).** Pre-D78 the script declared `OLP_CONNECT_VERSION="0.4.0-phase4"` as a hardcoded literal that nobody updated through v0.4.1 / v0.4.2 / v0.4.3 (the maintain-the-literal-per-release pattern is reliably forgotten). D78 derives the version at runtime from the sibling `package.json` via python3 — when the script is invoked from a checked-out repo, version resolves to the actual `package.json` value; when invoked via `curl … | bash` with no on-disk package.json next to it, falls back to `unknown`. Now `bash bin/olp-connect --version` prints `olp-connect 0.4.4` automatically with no manual touch needed at the next release.

**Pre-publish audit.** Per `~/.cc-rules/docs/guides/pre-publish-audit.md` checklist (2026-05-26 session, before the visibility flip):
- Identity scrub: 0 hits (no personal names / hostnames / home paths / personal emails leaked into the working tree)
- Credential scrub: 0 real tokens — all `olp_` matches are placeholder (`olp_XXXX...`) or test fixtures (`olp_not-a-real-key-...`); gitleaks: "no leaks found"
- Git-history author emails: 78 commits, two emails (`dtzp555@gmail.com` local + `taodeng1977@gmail.com` GitHub-account squash-merges). Maintainer chose Option A (accept) — the GitHub-account email was already verified-public on the maintainer's GitHub profile, so the visibility flip exposes nothing new.

**Test count:** 717 (v0.4.3) → 720 (v0.4.4). +3 D78 regression tests in Suite 36:
- 36v — pins absence of `NOT YET SHIPPED` text + presence of real install path
- 36w — pins runtime version derivation from package.json (hardcoded literal gone)
- 36x — pins README's tag-pinned-URL recommendation

**Authority:** D77 MacBook client-install verification session (2026-05-26); `~/.cc-rules/docs/guides/pre-publish-audit.md`. Process learning: every README that includes a `curl <raw-URL> | bash` install pattern should pin to a release tag (not `/main/`) for CDN-cache resilience. The /main/ form is correct for the long-tail (when no negative cache exists) but the tag-pinned form survives the visibility-flip transient + survives any future force-push to main.

**Out of D78 scope:**
- F6 (doctor client-side vs server-side check separation) — Phase 5 ADR amendment.
- D75 reviewer P2-1 (ADR 0004 per-hop schema amendment) + P2-2 (defensive `typeof hopModel === 'string'` invariant) — both genuine follow-ups, neither blocking.
- `scripts/migrate-from-ocp.mjs` — Phase 7.

## v0.4.3 — 2026-05-26

### D76 — README install-path overhaul + `OLP_BIND` env + AI-driven install prompt + ADR 0011 amendment

Patch release closing the install-experience gap. v0.4.0–v0.4.2 README's Quick Start was placeholder text with fictional commands (`npm install -g @dtzp555-max/olp` — package isn't published; `olp setup` / `olp start` — don't exist). 10 real gaps catalogued + fixed in one D-day; `OLP_BIND` env wired so the documented LAN onboarding flow actually works; AI-driven install prompt added per the Phase 4 charter brainstorm's #2 OCP inheritance candidate (was deferred at D64-D67 to the doctor framework only; D76 closes the README half).

- **G1-G7 (README "Quick Start" was fictional)** — rewrote § "Manual install" with the real sequence: prerequisites (Node ≥ 18 + provider CLI install matrix) → `git clone` → `npm test` verify → `olp-keys keygen --owner` first → provider OAuth (claude/codex/mistral per-CLI flows) → write `~/.olp/config.json` with the minimum that actually serves traffic → `npm start` → smoke-test → IDE pointing. Each step empirically verified against the PI231 + Mac mini E2E session (2026-05-26).
- **G8 (LAN unreachable — F5)** — added `OLP_BIND` env (default `127.0.0.1`). Operators set `OLP_BIND=0.0.0.0` (or a specific LAN IP) to accept LAN connections so `olp-connect <ip>` can actually reach the server. Pre-D76 the server was hard-coded to `server.listen(PORT, '127.0.0.1', ...)`, making the documented LAN-onboarding flow only usable through an SSH tunnel. ADR 0011's original wording referenced a `BIND_ADDRESS` concept that didn't exist; D76 makes it operational.
- **G10 (no AI-install pattern)** — README § "Install with your AI (the fast path)" added. Verbatim prompt that the operator pastes into Claude Code / Cursor / Copilot / Aider; the AI follows the README + uses `olp doctor --json` machine-readable `next_action.ai_executable[]` (D64-D67) for self-repair, stopping only when `human_required[]` is non-empty (the provider OAuth dances). This closes the Phase 4 brainstorm Top-5 inheritance candidate #2 — the OCP "paste this prompt" pattern that D64-D67 only half-built.
- **Opening compressed** — § "Why OLP" (3 paragraphs of OCP billing history) removed from the top. The OCP-trigger context moved to § "Migration from OCP" at the bottom, condensed into a single paragraph. New users land on value-prop + § "What you get" + § "Install with your AI" / § "Manual install" without needing to digest 2026-05-14 / 2026-06-15 Anthropic billing history first. OCP users get a one-line pointer at the top.
- **§ "Configuration" full schema documentation** — replaced the placeholder with the actual `~/.olp/config.json` schema including every field that v0.4.x reads. Cross-references ADR 0004/0007/0010/0011.
- **§ "Environment Variables" extended** — added `OLP_BIND`, `OLP_API_KEY`, `OLP_OWNER_TOKEN`, `OLP_PROXY_URL` rows that were used throughout the manual-install flow but undocumented.

**ADR 0011 § "Deployment configurations" amendment.** Codifies the three deployment trust contexts (`127.0.0.1` loopback / RFC1918 + tailnet LAN / `0.0.0.0` public — with `advertise_anonymous_key: true` only safe in the first two). Documents the new `anonymous_key_advertised_with_lan_bind` startup warn event. Closes ADR 0011's pre-D76 dangling reference to a non-existent `BIND_ADDRESS`.

**Test count:** 714 (v0.4.2) → 717 (v0.4.3). +3 D76 regression tests in Suite 36 (36s/36t/36u) pinning `OLP_BIND` wiring + safety warn + ADR amendment.

**Out of D76 scope (deferred):**
- F6 (doctor client-side vs server-side check separation) — needs design ADR for a `--remote` mode. Phase 5.
- D75 reviewer P2-1 (ADR 0004 amendment for per-hop schema) + P2-2 (defensive `typeof hopModel === 'string'`) — both genuine follow-ups, neither blocking.
- `scripts/migrate-from-ocp.mjs` — Phase 7.

**Authority:** PI231 + Mac mini E2E session (2026-05-26, post-v0.4.2 verification revealed the 10 README gaps); ADR 0011 amendment self-cites; Phase 4 charter (ADR 0010) Top-5 inheritance candidate #2 (AI-driven self-repair). Process learning: every D-day reviewer rubric should add "open README in §-Quick-Start and verify the commands literally exist + work in the current repo" — would have caught G1-G7 at v0.4.0.

## v0.4.2 — 2026-05-26

### Post-v0.4.1 hotfix batch (D75) — real-machine E2E findings

Patch release fixing 5 bugs caught by **real-machine E2E testing on PI231 + Mac mini (2026-05-26 session)** — bugs that prior D-day reviewers AND the post-v0.4.0 maintainer review both missed because they reviewed against spec text and against the local OLP install's `~/.codex/auth.json` shape (cached from an older codex CLI version), not against real provider CLIs running on a remote operator host that did `npm install -g @openai/codex` for the first time on 2026-05-26 and got codex CLI v0.133.0.

**Root cause of the missed-bug class.** D6 (codex plugin authoring) explicitly documented three unpinned assumptions (A3 = access-token field name, A4 = NDJSON event schema, A2-adjacent = trusted-directory sandbox). D6 noted "D7 E2E will pin." D7 then shipped without performing real-codex-CLI E2E (the E2E gating mark was carried but the actual run was deferred). Every subsequent D-day reviewer trusted the D6/D7 codex plugin code unchanged because the static review couldn't see that the v0.133.0 CLI had moved the auth-token field, the event schema, AND added a new trusted-directory sandbox flag. The D74 maintainer review focused on `/health` / `/cache/stats` / `/v0/management/dashboard-data` payload shapes — none of which exercise the codex plugin's spawn path. F7 (per-hop model override) is a different class of miss — every reviewer read `executeHopFn(provider, model, ir)` and saw `model` consumed for cache key + audit ctx, but none traced through to confirm `model` is ALSO substituted into the IR passed to `provider.spawn()`. The function signature implied per-hop semantics that the body never fully delivered.

- **[F1] codex auth.json schema pin — codex CLI v0.133.0 nests the access token under `tokens.access_token`** (verified empirically on PI231 / Mac mini, 2026-05-26). Pre-D75 `readAuthArtifact()` read only top-level `creds.access_token` / `creds.token` / `creds.accessToken` — all undefined under v0.133.0 → returned `null` → OLP reported "auth artifact missing" via `/health` and `olp doctor` AND refused to spawn codex even when the user had fully completed `codex login`. Fix: prepend `creds?.tokens?.access_token` to the precedence chain at BOTH call sites (`OPENAI_CODEX_AUTH_PATH` override branch + default `$CODEX_HOME/auth.json` branch). Legacy top-level fields preserved as fallback for backward compat with older codex CLI versions.
- **[F2] codex spawn args — codex CLI v0.133.0 trusted-directory sandbox requires `--skip-git-repo-check`.** v0.133.0 refuses with `"Not inside a trusted directory and --skip-git-repo-check was not specified."` when spawned outside a git repo, exits non-zero with zero NDJSON output → OLP surfaces `SPAWN_FAILED` with no usable chunks → the fallback engine advances to next hop unnecessarily even when codex is configured and authenticated. OLP's typical deploy CWD (`~/olp/`) is NOT a git repo on operator hosts. Fix: add `'--skip-git-repo-check'` to the args array before `--model`. OLP is the trusted caller (operator's own server invoking the operator's own subscription via documented `codex exec` automation); the sandbox safeguards interactive shells, not pre-authorized automation.
- **[F3] codex NDJSON event shape pin — codex CLI v0.133.0 emits `item.completed` + `turn.completed` + `turn.failed`**, not the D6-assumed `content`/`delta`/`text` + `type:'stop'`/`done:true` shapes. Real v0.133.0 stream (verified empirically): `{"type":"thread.started",...}` → `{"type":"turn.started"}` → `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"<response>"}}` → `{"type":"turn.completed","usage":{...}}`. Pre-D75, every chunk was silently dropped by `codexChunkToIR()` → response body had `content: null`. Fix: prepend three new recognizers (`item.completed` with `item.type === 'agent_message'` → IR delta; `turn.completed` → IR stop; `turn.failed` → IR error). Legacy D6 defensive recognizers preserved below as forward/backward compat fallbacks.
- **[F4] `olp status` reads `body.stats.cache.size` (not OCP-era `body.cache.entries`).** Same class as D74 P2-3 (which fixed `cmdUsage` + `cmdCache`); D74 missed the parallel bug in `cmdStatus`. Server payload nests cache stats as `body.stats.cache.{hits, misses, size, inflightCount}` per `server.mjs handleManagementStatus`, and `CacheStore.stats()` has no `entries` field per `lib/cache/store.mjs`. Pre-D75 output showed `entries=?`. Fix: read `c.size` for entries display; also surface `inflightCount` when present.
- **[F7] per-hop chain `model` field now overrides IR model in `provider.spawn()`.** Pre-D75 `executeHopFn(hopProvider, hopModel, irReq)` used `hopModel` for cache key + audit ctx but passed the ORIGINAL `irReq` (with `irReq.model` = user's original request) to `hopProviderPlugin.spawn(irReq, authContext)`. A chain config `[{provider:anthropic, model:claude-X}, {provider:openai, model:gpt-5.5}]` would always spawn BOTH plugins with `--model claude-X` — openai rejected the unknown model and the chain died. This broke the core OLP value prop (cross-provider fallback with provider-appropriate model substitution per hop). Fix: build a per-hop IR variant with `{...irReq, model: hopModel}` and pass that to spawn. Conditional skips clone when `hopModel === irReq.model` (common case: single-provider chains, or single-hop chains where the chain config repeats the request model). Applied to BOTH the buffered path (`executeHopFn`) AND the streaming path (`sourceFactory` for `getOrComputeStreaming`). **Authority:** ADR 0004 § Chain advancement step 1 (per-hop config supplies provider AND model — the contract was always specified, but the code didn't complete it).

**Phase 5 process learning recorded.** Every provider plugin's D-day must include a real-CLI E2E ON A REMOTE OPERATOR HOST before merging — not on the maintainer workstation (which may have an older CLI cached from a prior install, hiding new field renames / new sandbox flags / new event shapes). The D6/D7 codex E2E was deferred and that deferral compounded across 3 layers (D6 = unpinned, D7 = pinning deferred, D8+ = trusted D6/D7 unchanged). F7 reinforces a separate lesson: when a function signature takes `(provider, model, ir)`, reviewers must check that `model` is consumed everywhere downstream, not just at the call site they happened to look at.

**Out of D75 scope (deferred to Phase 5 explicit ADR amendments):**
- F5 (server bind 127.0.0.1 / `OLP_BIND` env) — needs `lib/keys.mjs` anonymous-key trust boundary review before binding to non-loopback by default
- F6 (`olp doctor` client-vs-server-side limit detection) — needs design ADR amendment for trigger taxonomy

- **Test count delta:** 704 (v0.4.1) → 714 (v0.4.2). +10 D75 regression tests in Suite 36 (36i through 36r).
- **Files touched:** `lib/providers/codex.mjs` (F1+F2+F3), `bin/olp.mjs` (F4 cmdStatus), `server.mjs` (F7 buffered + streaming spawn sites), `test-features.mjs` (Suite 36 extension), `package.json` (version), `CHANGELOG.md` (this entry).
- **Authority:** ADR 0002 (provider contract — codex plugin), ADR 0004 (fallback engine — per-hop model contract), `lib/providers/codex.mjs` D6 assumption A2/A3/A4 docstrings (which all said "D7 will pin" and D7 never did); codex CLI v0.133.0 on-disk schema + `codex exec --help` output verified empirically on PI231 (2026-05-26 E2E session); Iron Rule 第二律 evidence-over-should-work; CLAUDE.md `release_kit.phase_rolling_mode` cross-Phase discipline.

## v0.4.1 — 2026-05-26

### Post-Phase-4 hotfix batch (D74) — maintainer-review findings

Patch release fixing 5 issues caught by maintainer post-v0.4.0 independent review. Every finding was a real runtime bug that the per-D-day fresh-context opus reviewers all missed because they reviewed against spec text, not against the runtime contract (default `auth.allow_anonymous: false`, real `/health` payload shape, real `/cache/stats` payload shape, real `/v0/management/dashboard-data` payload shape). **Phase 4 lesson: future implementation D-days MUST include at least one test that boots the server with the default production config and exercises the new feature end-to-end** — not just stub-mocked codepaths.

- **[P1-1] `olp doctor` no longer false-negatives on auth-required `/health`.** `lib/doctor.mjs` now accepts an `authHeaders` option (threaded from `bin/olp.mjs` `cmdDoctor` via the existing `authHeaders()` chain) and passes it to the `server.running` + `server.version` probes. The `server.running` check now distinguishes 401/403 ("server up but bearer token missing/invalid — set `OLP_API_KEY`") from "server unreachable" — so the `kind` discriminator routes to a clean fix-auth path instead of `fix_server` when the operator just forgot to export the env var.
- **[P1-2] `bin/olp-connect` validates token shape + shell-quotes rc writes.** New `validate_olp_token <key> <source>` helper enforces the `^olp_[A-Za-z0-9_-]{43}$` regex (per ADR 0007 § 3 token format) at all 3 input sites: `--key` arg, `/health.anonymousKey` server-advertised consumption, and the interactive prompt fallback. New `shell_quote <value>` helper wraps rc-file writes (`export OPENAI_BASE_URL=$(shell_quote ...)`) so even a hypothetical bypass of the validator can't inject shell metacharacters into a sourced rc. systemd `environment.d/olp.conf` write additionally rejects embedded newlines. Hostile or malformed keys can no longer persist as shell startup injection.
- **[P2-3] `olp usage` + `olp cache` human formatter rewritten against the real payload shape.** `cmdUsage` previously read `body.usage_24h.requests` / `body.providers` / `body.top_fallback_chains` — all undefined under the actual server payload shape — so users saw "requests: ?" + missing per-provider quota + missing top-chains. Now reads `body.window_24h.request_count` / `body.cache_hit_24h.hit_rate` / `body.quota` / `body.top_fallback_chains_24h` per `server.mjs:2027` + `lib/audit-query.mjs`. `cmdCache` previously read `body.entries` / `body.bytes` / `body.maxBytes` (OCP-era field names). Now reads `body.size` / `body.inflightCount` per `CacheStore.stats()` and computes hit rate from `hits + misses`.
- **[P2-4] `olp-plugin/` `fmtHealth` iterates `providers.status` correctly.** Previously walked `Object.entries(body.providers)` which surfaced `enabled` / `available` / `status` as pseudo-providers (chat output showed `🟢 status` instead of `🟢 anthropic`). Now extracts the real provider map from `body.providers.status` and renders enabled/available counts in a header line + per-provider names with `activeSpawns` when present. Falls back to flat `body.providers.*` for the older OCP shape (backwards compat).
- **[P3-5] Stale v0.3.0-era doc strings updated.** README header status line + Implementation Status § now reflect v0.4.0 shipped + Phase 5 open. `server.mjs` startup banner no longer hardcodes "Phase 1 in progress" (now just lists version + provider count — derives accurate state from `VERSION` without future maintenance touch-ups).

**Phase 4 process learning recorded.** Per Iron Rule 第二律 (evidence over "should work"), every D-day review pass must include at least one runtime smoke against the default production config. The D-day reviewer rubric is updated implicitly — D74 Suite 36 tests pin the wire-contract shape so a future D-day refactoring server payloads can't silently re-break the CLI / plugin / docs.

- **Test count delta:** 696 (v0.4.0) → 704 (v0.4.1). +8 D74 regression tests in Suite 36.
- **Files touched:** `lib/doctor.mjs` (P1-1), `bin/olp.mjs` (P1-1 + P2-3), `bin/olp-connect` (P1-2), `olp-plugin/index.js` (P2-4), `server.mjs` (P3-5 banner), `README.md` (P3-5), `test-features.mjs` (Suite 36 regression), `package.json` (version), `CHANGELOG.md` (this entry).
- **Authority:** maintainer independent review of `main` / `v0.4.0` / commit `ee4d945` (2026-05-26 session); Iron Rule 第二律 evidence-over-should-work; CLAUDE.md `release_kit.phase_rolling_mode` cross-Phase discipline ("hotfix to a shipped Phase N deliverable → bump patch, tag, release before next push").

## v0.4.0 — 2026-05-26

### Phase 4 — Operator + Client UX (D60 → D73)

**Overview.** v0.4.0 closes Phase 4 — the "operator + client UX" track that grew OLP from "I built a multi-provider proxy" to "my family can use it without me holding their hand." 5 D-day groups (D60 → D73), ~13 D-days, all under standing-autopilot grant + per-D-day fresh-context opus reviewer per Iron Rule 10. The maintainer-triggered close PR lands all of it under one version tag.

**Test count: 623 (v0.3.2) → 696 (v0.4.0).** +73 tests across the Phase 4 arc.

**Strategic decision recorded:** Phase 4 explicitly DEFERS `/v1/messages` (Anthropic-shape entry surface) per ADR 0010 — re-open strictly gated on ADR 0009 P0 success AND maintainer-named family CC user. README posture: Claude Code listed as Not supported as an OLP client; recommended alternative "Cline + OLP" (same fallback chain available, better cross-provider compatibility because OpenAI tool schema is the multi-provider lingua franca).

**Phase 4 release_kit checklist**

- [x] All 5 D-day groups landed on main (D60 + D61-D63 + D64-D67 + D68-D70 + D71-D73)
- [x] CI green on every D-day merge commit + on this release commit's head
- [x] Fresh-context opus reviewer on every implementation D-day group + per-D-day P0/P1/P2 fold-ins where applicable
- [x] CHANGELOG "Unreleased" promoted to "## v0.4.0 — 2026-05-26"
- [x] `package.json` bumped 0.3.2 → 0.4.0
- [x] `CLAUDE.md release_kit.phase_rolling_mode.current_phase` Phase 4 → Phase 5; `current_pre_release_identifier` `0.4.0-phase4` → `0.5.0-phase5`
- [x] README § IDE Setup + § Telegram/Discord Usage + § Operator CLI surfaces (env var table extension)
- [x] ADR 0010 (Phase 4 charter), ADR 0011 (anonymous-key deployment-context limits), ADR 0002 Amendment 7 (provider doctorChecks contract) all on disk
- [ ] Tag pushed (next step in this PR's lifecycle)
- [ ] `release.yml` triggered + GitHub Release created (auto on tag push)

---

### D60 (PR #40) — Phase 4 charter (ADR 0010) + default port 3456 → 4567

Opens Phase 4. No functional code change beyond the default port value; substantive D-day work lands D61 onward.

- **Default `OLP_PORT` changed `3456 → 4567`.** OCP defaults to 3456; OLP and OCP can now co-host on the same machine without `OLP_PORT` env override. Tests use `port: 0` ephemeral — no test-surface impact.
- **ADR 0010 (Phase 4 charter) ratified.** Records 5 D-day group scope + explicit DEFER of `/v1/messages` with re-open trigger.
- **ADR 0001 + ADR 0008 amendments.** Port-conflict assumption struck-and-amended; § 6.6 default-port reference updated.
- **README quick start + Environment Variables table + Migration from OCP § note** updated.

### D61-D63 (PR #41) — SSE heartbeat + recentErrors[20] + /v0/management/status

First substantive Phase 4 implementation. 3 D-days bundled per Iron Rule 11 IDR (shared observability surface).

- **SSE heartbeat** via `streaming.heartbeat_interval_ms` config (default `0` = disabled, matches OCP safe default). When enabled, streaming branch emits `: keepalive\n\n` SSE comment every interval during silent windows; resets on real chunk; cleans up on stream end/error/abort/disconnect. Eager-headers-post-spawn from day one (the OCP `db11105` lesson). `X-Accel-Buffering: no` centralized via new `SSE_DEFAULT_HEADERS` constant. Per-attached-client lifecycle (each tee output gets its own timer).
- **`recentErrors[20]` ring buffer.** Module-scope bounded ring, populated from 5 server-side error paths. Filter: only `ProviderError` OR `statusCode >= 500` (401/403 brute-force noise excluded; D61-D63 reviewer P2-1 explicit-401/403-reject fold-in). Path sanitization via OCP `server.mjs:1395` port. In-memory only (per OCP precedent).
- **`GET /v0/management/status` combined endpoint** (owner-only_block). Returns `{ ok, version, uptime_ms, uptime_human, started_at, providers, stats, recent_errors, generated_at }`. `_totalRequests` + `_activeRequests` module-scope counters with idempotent-decrement guard.
- **Authority:** ADR 0010 § D61-D63; OCP `server.mjs:660-685` (startHeartbeat), `301, 354-358` (ring), `1151-1188` (/status), `1395` (path sanitization), commit `db11105` (eager-headers); ADR 0007 § 7 + ADR 0008 (owner-only_block pattern).
- **Test count delta:** 623 → 636 (+13).

### D64-D67 (PR #42) — `olp` Node CLI + `olp doctor` framework + per-provider doctor checks + ADR 0002 Amendment 7

Second substantive Phase 4 implementation. 4 D-days bundled — CLI dispatches to doctor; doctor calls plugins via new contract method; ADR amendment authorizes the contract change.

- **`bin/olp.mjs` Node CLI** with 11 subcommands: `status / health / usage / models / cache / providers / chain show / logs / restart / keys / doctor / help`. Node not bash (per ADR 0010 § Notes — bash's python3 JSON-parsing fragility avoided). Token resolution: `OLP_API_KEY` env → `OLP_OWNER_TOKEN` env → helpful 401 message (filesystem manifest tokens are one-way SHA-256 per ADR 0007 § 5, not recoverable). Output: human-readable ANSI text by default, `--json` for scripting. Exit codes `0=ok / 1=usage / 2=network|HTTP / 3=auth`. Installed via `package.json bin.olp` so `npx olp <subcommand>` works.
- **`lib/doctor.mjs` framework** with machine-readable `next_action.ai_executable[]` for AI-driven self-repair. Per check: `{ id, category, async run(): { status: 'ok'|'fail'|'warn', message, evidence? } }`. Built-in checks: `server.running / server.version / config.exists / config.providers_enabled / config.chains_configured / auth.owner_key_exists / system.node_version`. Per-provider checks dynamically collected via the new `provider.doctorChecks()` contract method. `--json` output emits `{ checks, kind: noop|update|fix_oauth|fix_config|fresh_install|fix_server|fix_provider, next_action: { ai_executable, human_required, verify }, summary }`. `--check <id|category>` for tight repair-loop fast paths. Reviewer P2 fold-in: `_shellQuote()` helper hardens `ai_executable[]` against malicious `OLP_HOME` shell-metacharacter injection.
- **Per-provider `doctorChecks()`** in anthropic / codex / mistral plugins: CLI-availability probe + auth-presence probe. Each fail returns `evidence.fix_commands` (for `ai_executable[]`) or `evidence.human_required`.
- **ADR 0002 Amendment 7** adds OPTIONAL `provider.doctorChecks(): DoctorCheck[]` to the Provider contract — backwards compatible (plugins without it contribute no provider checks).
- **`olp restart`** documented caveat (reviewer P2-2): `launchctl kickstart -k` does NOT re-read plist `EnvironmentVariables`; bootout/bootstrap dance noted for env reloads.
- **Authority:** ADR 0010 § D64-D67; ADR 0002 Amendment 7 (new); OCP `ocp` bash wrapper + `scripts/doctor.mjs` (port references); 2026-05-26 brainstorm Top 5 inheritance candidate #2.
- **Test count delta:** 636 → 658 (+22).

### D68-D70 (PR #43) — `bin/olp-connect` + `/health.anonymousKey` + ADR 0011

Third substantive Phase 4 implementation. 3 D-days bundled — olp-connect consumes /health.anonymousKey; both governed by ADR 0011 trusted-LAN invariant.

- **`bin/olp-connect <host-ip>` (bash, 564 lines)** zero-config LAN client setup. Bash over Node so client machines without recent Node still work. Auto-detects 6 IDEs and configures each: Claude Code (detect + warn — NOT supported per ADR 0010), Cline (print VSCode-settings snippet — manual), Continue.dev (write idempotent `models:` entry to `~/.continue/config.yaml`), Cursor (snippet + WARNING about known base-URL fragility), Aider (write `OPENAI_API_BASE` + `OPENAI_API_KEY` to rc files), OpenClaw (detect + point at `olp-plugin/`). macOS `launchctl setenv` / Linux `~/.config/environment.d/olp.conf` for GUI-app env inheritance. `--dry-run` exercises every state-change site without modifying anything. Idempotent rc-file writes via bracketed `# OLP LAN ... # /OLP LAN` block.
- **`/health.anonymousKey` opt-in field** + `auth.advertise_anonymous_key` config. Field appears in both trimmed AND full `/health` payloads when ALL THREE prerequisites hold: `auth.advertise_anonymous_key: true` + `auth.allow_anonymous: true` + at least one non-revoked guest-tier key has `plaintext_advertise` set. Default off — field ABSENT (not null), preserves v0.3.x `/health` shape. Three-prereq gate is graceful-degrade (server warns + boots; request-time re-checks).
- **`bin/olp-keys keygen --anonymous --advertise`** new flag. Writes plaintext into manifest `plaintext_advertise` field AND prints WARNING + ADR 0011 pointer. Owner-tier rejected at BOTH CLI and lib layers (defense-in-depth). Reviewer P2-1 fold-in: `listKeys()` strips `plaintext_advertise` alongside `token_hash` — callers wanting the advertised plaintext for the `/health` publication path MUST go through `findAdvertisedKey()` (the only sanctioned read site).
- **ADR 0011 (anonymous-key deployment-context)** new ADR codifying the trusted-LAN-only invariant. Threat model explicit; deployment-context table concrete; soft enforcement via startup warn if `BIND_ADDRESS` resolves to public IP AND `advertise_anonymous_key: true`. No hard allowlist (TLS-fronted private networks indistinguishable from public from server's perspective). Re-evaluation triggers named (Cloudflare Tunnel guidance / Phase 5 multi-tenant).
- **Authority:** ADR 0010 § D68-D70; ADR 0011 (new); ADR 0007 § 4 (manifest forward-compat unknown fields) + § 7 (identity classes) + § 9 (keygen flow); OCP `ocp-connect` (port reference); 2026-05-26 brainstorm Top 5 inheritance candidate #3.
- **Test count delta:** 658 → 672 (+14).

### D71-D73 (PR #44) — `olp-plugin/` (OpenClaw /olp Telegram+Discord) + `docs/integrations/*.md` + README cross-refs

Final Phase 4 substantive D-day group. 3 D-days bundled — plugin consumes existing endpoints; integration docs reference plugin + olp CLI + olp-connect together.

- **`olp-plugin/` OpenClaw gateway plugin** (482 lines). Port of OCP `ocp-plugin/index.js` minus mutations. Subcommand parity with `olp` CLI: `/olp status / usage / cache` (owner-only) + `/olp health / models / providers / chain show / doctor / help` (informational). **Explicitly NOT ported** for security: `/olp keys keygen` (chat = brute-force-prone), `/olp keys revoke` (mutation), `/olp restart` (misclick risk), `/olp logs` (PII risk). Port resolution: `OLP_PROXY_URL` env → `OLP_PORT` env → plugin config `proxyUrl` → `http://127.0.0.1:4567` (D60 default). Output: Telegram/Discord monospace code block with status icons (🟢🟡🔴). Long responses truncated for 4096-char Telegram limit. No npm deps (OpenClaw provides Telegram/Discord transport).
- **`docs/integrations/*.md` bundle** (6 pages + index). Per-IDE setup docs with status icons: Continue.dev ✅, Cline ✅ (cites Cline issue #7128 base-URL UI bug), Cursor ⚠️ (documented base-URL fragility), Aider ✅, **Claude Code ❌** (Anthropic wire format only; recommended alternative "Cline + OLP" per ADR 0010 § /v1/messages defer), OpenClaw ✅. Each ~60-120 lines: status / quick setup / known issues / OLP-specific notes / test-it command. `docs/integrations/README.md` is the index.
- **README updates.** New § "IDE Setup" linking `docs/integrations/README.md`. New § "Telegram / Discord Usage" with install + configure + restart + use. Quick Start mentions `olp-connect <ip>` as family-onboarding command. `package.json files` field extended to include `olp-plugin/` so the published tarball ships it.
- **Authority:** ADR 0010 § D71-D73; OCP `ocp-plugin/index.js` (port reference); 2026-05-26 brainstorm prior-art survey IDE-specific quirks.
- **Test count delta:** 672 → 696 (+24).

---

**Phase 4 close authority chain:** ADR 0010 (charter); CLAUDE.md `release_kit.phase_rolling_mode` (close trigger = explicit maintainer action — fired by maintainer 2026-05-26); standing autopilot grant covering D-day-by-D-day execution; 5 fresh-context opus reviewer passes (one per D-day group); 696/696 tests pass on this release commit head.

## v0.3.2 — 2026-05-25

### Post-Phase-3 cleanup batch #2 — streaming-path singleflight + TOCTOU close (D57 + D58 + D59)

Patch release closing v1.x roadmap #1 end-to-end. The cache layer's D4 singleflight (one spawn per identical concurrent request) was fully wired on the buffered path since v0.1 but NOT on the streaming path — N concurrent identical streaming requests each spawned their own CLI process. v0.3.2 ships the streaming sibling: tee fan-out, late-joiner replay, per-client backpressure, AbortController propagation, and TOCTOU close. 3 D-day commits (D57 + D58 + D59); ADR 0005 Amendment 8 §§1–14 implemented.

- **D57** (PR #36) — **cache layer.** New `cacheStore.getOrComputeStreaming(keyId, cacheKey, sourceFactory, opts) → { stream, isFirst, role }` mirroring `getOrCompute` on the streaming side. Internals: `_streamingInflight: Map<compositeKey, StreamingInflightEntry>` (composite key `keyId + '\0' + cacheKey`) with synchronous check+insert atomicity (closes TOCTOU per ADR 0005 Amendment 8 §1, §6); single-reader tee fan-out across all attached clients; late-joiner replay buffer (synchronous drain on attach; `STREAM_BACKPRESSURE` terminator if drain or replay-truncation would corrupt); per-client backpressure (`PER_CLIENT_QUEUE_CAP = 1 MB`, overridable via opts); accumulated replay cap (`ACCUMULATED_REPLAY_CAP = 10 MB`, mirrors D23 cache-entry cap); AbortController fires source-iterator return when all clients disconnect. New `'STREAM_BACKPRESSURE'` entry in `PROVIDER_ERROR_CODES` — NOT a hard trigger (whitelist-only `HARD_TRIGGER_CODES`). Suite 27 = 12 unit tests.
- **D58** (PR #37) — **server wiring.** Streaming branch in `server.mjs` swapped from the peek+spawn pattern to `cacheStore.getOrComputeStreaming(...)`. `tryAcquireSpawn`/`releaseSpawn` moved INSIDE the `sourceFactory` closure per ADR 0005 Amendment 8 §7 (only the first caller acquires; attached joiners share the slot; release fires exactly once on source completion/error/abort). `CONCURRENCY_LIMIT` thrown by the factory triggers fallthrough to the buffered path (preserves today's behaviour). New `X-OLP-Streaming-Inflight: source | attached` HTTP header annotates per-response role (§11). New `cache_status: 'streaming_attached'` audit value tracks the singleflight win. `lib/audit-query.mjs` aggregate APIs (`aggregateRequests`, `cacheHitRateWindow`) extended with `cache_streaming_attached` / `streaming_attached` fields so the cache_status breakdown reconciles. `res.on('close')` propagates client disconnect into the tee's `attachedClients` accounting (§9). D16 truncated-not-cached invariant preserved via server-layer `cacheStore.delete` on stop-less exhaustion (the cache layer is IR-agnostic and writes accumulatedChunks on any source exhaustion; the IR-aware server deletes the entry when the source returned without a `{type:'stop'}` chunk). Suite 28 = 8 HTTP integration tests.
- **D59** (PR #38) — **docs polish.** README § Known limitations bullet inverted to ✅ shipped marker. `docs/v1x-roadmap.md` #1 rewritten to closed state with 3-D-day breakdown. #6 (streaming SPAWN_FAILED salvage) unbundled from #1 because the tee architecture as implemented does not carry salvage semantics. Issue #16 closed with refs to PRs #36 / #37 / #38.
- **Test count:** 603 (v0.3.1) → 623 (v0.3.2). +20 streaming-SF tests (Suite 27 = 12 unit, Suite 28 = 8 HTTP integration).
- **Deferred sub-items (not blocking #1 closure):** (a) `X-OLP-Streaming-Inflight: solo` wire value not emitted — observable only post-stream via `streaming_inflight_source_done` log event's `attached_count: 0`. Future ADR amendment may expose via HTTP trailer. (b) `streaming_inflight_join` log event not emitted from the cache-layer `_attachClient` path because provider/model context lives in the sourceFactory closure (server-layer concern). (c) `isFirst` field returned by `getOrComputeStreaming` is unused by server.mjs (`role` supersedes); could be removed in a future cache-layer API cleanup.
- **Authority:** ADR 0005 Amendment 8 (design ratified at D42 2026-05-25; implementation gated on maintainer "go" — fired 2026-05-25 post-v0.3.1). `docs/v1x-roadmap.md` #1 (closed). GitHub issue #16 (closed). ADR 0002 Amendment 6 (D38 `tryAcquireSpawn`/`releaseSpawn` semantics, now invoked from sourceFactory closure).

**Patch-release classification.** Per `release_kit.phase_rolling_mode` cross-Phase discipline + maintainer release-cut decision (this session, 2026-05-25): the new wire surface (`X-OLP-Streaming-Inflight` header + `streaming_attached` cache_status) is semver-wise a minor bump, but this is roadmap-cleanup work — NOT Phase 4 product scope. The reserved `0.4.0` identifier stays for the formal Phase 4 close. v0.3.2 ships as a patch under the Phase 4 pre-release banner. Tag push triggers `release.yml`.

## v0.3.1 — 2026-05-25

### Post-Phase-3 cleanup batch #1 (D56)

Patch release closing two XS v1.x-roadmap deferrals (`docs/v1x-roadmap.md` #4 + #7) that became actionable now that Phase 3 management endpoints exist. No new feature surface; pins existing behaviour into tests + finally wires the ADR-documented `activeSpawns` field on `/health`.

- **AUTH_MISSING tuple test** (v1.x roadmap #7 / D45 reviewer P3 deferral). New engine-level test in Suite D40 asserts that an `AUTH_MISSING` hop produces a `fallbackDetail` tuple with `trigger_type: 'auth_missing'` AND that the engine does NOT advance past the AUTH_MISSING hop (per ADR 0004 § Decision — `HARD_TRIGGER_CODES[AUTH_MISSING] = false`). Pre-D56 the behaviour was implicit through other engine-path tests; this commit makes it explicit so a future refactor that moves the tuple-push past the auth_missing branch fails this test directly.
- **`/health` `activeSpawns` integration** (v1.x roadmap #4 / ADR 0002 Amendment 6 forward note). `handleHealth` now surfaces `providers.status.<name>.activeSpawns` (sourced from D38 `getActiveSpawnCount(name)`). The field is computed BEFORE `healthCheck()` is awaited so it remains present even when `healthCheck()` throws (cheap in-memory counter read). New Suite 21c-extra test pins the field presence + non-negative value for every enabled provider. With no requests in flight: 0; under saturation: equals `hints.maxConcurrent`.
- **Test count:** 601 (v0.3.0) → 603 (v0.3.1). +2 D56 tests.
- **Authority:** `docs/v1x-roadmap.md` #4 + #7; ADR 0002 Amendment 6 (concurrency observability forward note); ADR 0004 § Decision + Amendment 5 (X-OLP-Fallback-Detail tuple shape).

**Patch-release classification.** Per `release_kit.phase_rolling_mode` cross-Phase discipline: D56 landed on main after v0.3.0 was tagged, so this is a hotfix-class patch — bump patch, tag, release before next push. Tag push triggers `release.yml`.

## v0.3.0 — 2026-05-25

### Phase 3 — Dashboard + audit query layer + daily audit rotation (D48 → D54)

**Overview.** v0.3.0 closes Phase 3 — the dashboard / audit aggregate query / daily rotation track that grew OLP from "audit ndjson exists but is grep-only" (v0.2.0) to a live multi-panel owner-only dashboard with aggregate queries + automatic daily file rotation. 7 D-day commits (D48 through D54) shipped between 2026-05-25 under the standing-autopilot grant. All 15 ADR 0008 § 10 acceptance criteria are implemented + tested.

**Test count: 544 (v0.2.0) → 601 (v0.3.0).** +57 tests across the Phase 3 arc.

**Phase 3 release_kit checklist**

- [x] All 7 D-day deliverables landed on main (D48 ADR + D49-D54 implementation)
- [x] CI green on every D-day merge commit + on this release commit's head
- [x] Fresh-context opus reviewer on every implementation D-day (D49/D50/D51/D52/D53) + D48 ADR draft + D54 docs polish
- [x] All 15 ADR 0008 § 10 acceptance criteria (#1–#15) covered by Suite 23/24/25/26/20h-extra-audit tests
- [x] CHANGELOG "Unreleased" promoted to "## v0.3.0 — 2026-05-25" with D48 through D54 entries
- [x] `package.json` bumped 0.2.0 → 0.3.0
- [x] `CLAUDE.md release_kit.phase_rolling_mode`: `current_phase` Phase 3 → Phase 4; `current_pre_release_identifier` `0.3.0-phase3` → `0.4.0-phase4`
- [x] README status header + Implementation Status + Phase plan reflect Phase 3 shipped
- [ ] Tag pushed (next step in this PR's lifecycle)
- [ ] `release.yml` triggered + GitHub Release created (auto on tag push; D37 phase_rolling_mode gate will pass because Unreleased is now sentinel-only)

**ADR 0008 § 10 acceptance criteria — final ship status**

| # | Criterion | Covering tests |
|---|---|---|
| 1 | `readAuditWindow` iterates events from today + N prior rotated files | Suite 23b-1, 23b-2, 23b-3 |
| 2 | `readAuditWindow` skips malformed lines without throwing + logs warn | Suite 23b-6 |
| 3 | `aggregateRequests` counts by provider / cache_status / owner_tier / path + median/p95 latency | Suite 23c-1, 23c-2, 23c-3 |
| 4 | `topFallbackChains` sort desc by count + tied-count tiebreak | Suite 23d-1, 23d-4 |
| 5 | `spendTrendDaily` sparse-fills zero-request days + UTC day boundaries | Suite 23e-1, 23e-2, 23e-3 |
| 6 | Daily rotation past UTC midnight | Suite 26a-3, 26b-1 |
| 7 | Cross-file query with mixed rotated files | Suite 26e-1 + Suite 23b-1 |
| 8 | Concurrent rotation safety (N appends → 1 rename) | Suite 26c-1 |
| 9 | `GET /dashboard` 200 to owner; 401 to non-owner | Suite 24a, 24b, 24c, 24d |
| 10 | `GET /v0/management/dashboard-data` 200 to owner with all required fields | Suite 24e |
| 11 | `GET /cache/stats` 200 to owner with live stats | Suite 24h |
| 12 | Dashboard HTML smoke (4 panel containers + 30s poll + no external resources) | Suite 25a-25f |
| 13 | Audit row on management endpoints (success + 401) | Suite 24i, 24j |
| 14 | Graceful degradation on `quotaStatus()` throw (panel surfaces null + error) | server.mjs `handleManagementDashboardData` try/catch verified by code |
| 15 | PII guard — no message-content fields in any aggregate output | Suite 23g-1, 23g-2, 23g-3 |

**Phase 3 D-day index**

- **D48** (`c0b6969`) — ADR 0008 Phase 3 design draft (Dashboard + audit query layer) + lane decisions A/A/B/A/B
- **D49** (`686794e`) — `lib/audit-query.mjs` aggregate query layer (5 functions, PII-guarded)
- **D50** (`f9f2eaa`) — `server.mjs` 4 management endpoints (owner_only_block per ADR 0008 § 8) + dashboard.html placeholder
- **D51** (`251b578`) — `dashboard.html` full multi-panel UI (vanilla HTML+JS+fetch, 30s poll with visibilitychange pause)
- **D52** (`408d5a8`) — Daily audit rotation in `lib/audit.mjs` (synchronous trigger on first append after UTC midnight) + `bin/olp-audit-rotate.mjs` external cron tool
- **D53** (`68e50da`) — `tried_providers` schema semantic fix (D45 P2 deferral closed; ADR 0007 § 8 amendment)
- **D54** (`6d9ab1f`) — README Phase 3 polish (docs-only)

**Bonus: also resolved at D53** — D45 fresh-context opus reviewer P2 deferral (`tried_providers` semantics on `key_no_provider_access` 403). ADR 0007 § 8 amended; server.mjs sets `tried_providers = []` on the 403 path so downstream audit queries stay accurate.

**Known limitations carried beyond v0.3.0**

Phase 3 functional scope is complete. The following remain as Phase 4+ deferrals (tracked in `docs/v1x-roadmap.md` + the new Phase 4 entry below):

- **Per-key per-provider auth artifact mapping** — ADR 0007 § 12. Each OLP key independently authenticated to a different provider account.
- **Audit query rotation / retention policies** — ADR 0008 § 11. Currently unbounded; operator manages disk. A Phase 4+ amendment adds `audit_max_days` config when an operational need emerges.
- **SQLite hybrid migration** — ADR 0007 § 13. Trigger: query latency > 2s on typical owner session OR > 5 owners polling. Requires engines bump + CI matrix change as a separate prior PR.
- **Provider-cost weights for spend trend** — ADR 0008 § 11. At v0.3.0 "spend" is proxied by request count; cost integration when commercial cost-tracking lands.
- **Per-key dashboard views** — owner sees aggregate; per-key drill-down is a future amendment.
- **Key-mgmt UI on dashboard** — owner can create / revoke / edit keys from web. Out of Phase 3 scope; needs separate security review per ADR 0008 § 11.
- **Manual smoke for dashboard** — per ADR 0008 § 10 #12 the "no JS console errors in real browser" sub-claim is manual / playwright; Phase 3 acceptance shipped with server-observable checks (Suite 25); a Phase 4+ amendment may add playwright smoke if dashboard complexity grows.

### D54 — README Phase 3 polish (docs-only, no code change)

Seventh Phase 3 D-day. Documentation polish ahead of Phase 3 close (D55, maintainer-triggered). Brings README status header / Implementation Status / API Endpoints / Known limitations / Phase plan up to date with Phase 3 work shipped to main through D48-D53.

- **Status header**: `v0.2.0 shipped` → `v0.2.0 shipped; v0.3.0 in progress` + lists D48-D54 highlights.
- **Implementation status note**: Phase 3 description updated from "next milestone" to "shipped to main through D54; v0.3.0 release pending maintainer-triggered close (D55)".
- **Implementation Status table** — 4 row updates:
  - `lib/audit.mjs`: 🟡 D45-only → ✅ D45 append + D52 rotation; describes both responsibilities.
  - `lib/audit-query.mjs`: NEW row (D49 shipped, 5-function aggregate query API).
  - `dashboard.html`: 📋 Planned (Phase 6) → ✅ Phase 3 shipped (D50 stub + D51 full UI); describes the 4 panels.
  - `bin/olp-audit-rotate.mjs`: NEW row (D52 shipped, external cron tool).
- **API Endpoints table** — `/cache/stats`, `/v0/management/quota`, `/dashboard` (Phase 6 📋 Planned → Phase 3 ✅ Shipped); new `/v0/management/dashboard-data` row; `/health` row clarified to spell out owner-only-trim semantic. Removed the "placeholder — full table lands" stub since the table is now substantively complete.
- **Known limitations** — Phase 2 paragraph kept (now reads as historical Phase 2 completion note); new Phase 3 paragraph summarizing D48-D54 shipped + D55 close pending.
- **Phase plan** — Phase 3 description (was "next") → "🟡 In progress — D48 (ADR) + D49–D54 shipped to main 2026-05-25; v0.3.0 close awaits maintainer trigger." Added Phase 4+ entry covering the deferred items (per-key per-provider auth, SQLite hybrid, audit rotation/retention policies, provider-cost weights).
- **Test count:** 601 → 601 (docs-only).
- **Authority:** CLAUDE.md `release_kit overlay phase_rolling_mode` — under Unreleased; ADR 0008 § 13 sprint shape (D54 = "E2E + AGENTS / README polish"); standing autopilot grant.

### D53 — `tried_providers` schema semantic fix (D45 P2 deferral closed)

Sixth Phase 3 D-day. Small focused fix for the D45 fresh-context opus reviewer P2 finding that was deferred: `auditCtx.tried_providers` on the `key_no_provider_access` 403 path was being stamped with the ORIGINAL chain (which was filtered out, never dispatched), distorting downstream audit queries like "which providers did key X actually call".

- **`server.mjs` 403 path fix** (around L815): `auditCtx.tried_providers = []` (was `_originalChainProviders`). The configured-but-blocked chain still appears in the human-readable error message body — the audit just doesn't claim those providers were "tried" when the server's filter dispatched zero.
- **ADR 0007 § 8 amendment**: new paragraph spelling out the `tried_providers` semantic — "the list of providers the server actually dispatched a spawn against. A provider that was configured in the chain but filtered out by `providers_enabled` gating is NOT included — the key didn't try the provider, the gate did. On the 403 path `tried_providers` is the empty array." Plus a forward note that audit log rotation moved to Phase 3 / ADR 0008 § 5.
- **Suite 20h-extra-audit (+1 test — 600 → 601):** creates a guest key with `providers_enabled: ['mistral']`; fires a request for an Anthropic-routed model; asserts 403 `key_no_provider_access`; reads the audit row from `audit.ndjson`; asserts `tried_providers === []`. This pins the D53 semantic against regression — if a future change reverts to stamping the original chain, the test fails.
- **Documentation:** CHANGELOG D53 entry; ADR 0007 § 8 amendment.
- **Test count:** 600 → 601 (+1 D53 regression test).
- **Authority:** ADR 0007 § 8 amendment (D53, 2026-05-25); D45 fresh-context opus reviewer P2 deferral note; CLAUDE.md `release_kit overlay phase_rolling_mode` — under Unreleased; standing autopilot grant.

### D52 — Daily audit rotation (`lib/audit.mjs` extension + `bin/olp-audit-rotate.mjs`)

Fifth Phase 3 D-day. Adds daily UTC-aware rotation to `lib/audit.mjs` per ADR 0008 § 5 + ships an external cron tool. Rotation is **synchronous** at v0.3.0 (Lane 3 = B daily rotation; synchronous design eliminates the race that an async wrapper would create between date-change-detection and the append).

- **`lib/audit.mjs` extended**:
  - New `_maybeRotateAudit({ olpHome, logEvent })` (synchronous): probes the live `audit.ndjson`; if it holds events from a past UTC date, renames it to `audit-YYYY-MM-DD.ndjson`. Idempotent. If the target file already exists (cron beat the in-server check), logs warn + skips per ADR 0008 § 5.3 race safety.
  - `appendAuditEvent` extended: cheap fast-path date check via module-cached `_lastSeenUtcDate`. On date change, calls `_maybeRotateAudit` synchronously BEFORE `appendFileSync` — so old-date events land in the rotated file and new-date events land in the fresh live file. No event straddles the boundary.
  - Why synchronous instead of async: an async wrapper would let the sync `appendFileSync` race the not-yet-completed `renameSync`, landing today's event in the about-to-be-renamed file. Sync rotation is the only correct ordering at the append-fired-from-many-routes scale OLP runs.
  - New exports: `_maybeRotateAudit` (sync), `getAuditRotateCount`, `getAuditRotateFailCount`, `__resetAuditRotateState`, `__setLastSeenUtcDateForTesting`.
  - First-event-date discovery: when probing the live file's date, reads only the first ndjson line + parses its `ts`. Falls back to file mtime if events absent (corrupt/empty edge).
- **`bin/olp-audit-rotate.mjs`** (~95 lines): external cron tool per ADR 0008 § 5.2. Calls `_maybeRotateAudit` once + reports outcome. Exit codes 0 (success or no-op), 1 (bad usage), 2 (rotation failed). Installed via `package.json bin` so `npx olp-audit-rotate [--olp-home=<path>]` works. Example cron line documented in the file header.
- **Concurrent-safety semantics** (ADR 0008 § 5.3): in-process sequential appends after the first date-change detection short-circuit via the updated `_lastSeenUtcDate` cache → exactly 1 rename even under N sequential appends. Cross-process (cron + server) coexistence handled by the "target already exists → skip + warn" branch.
- **Test surface (Suite 26, +12 tests — 588 → 600):**
  - 26a-1..5: `_maybeRotateAudit` (no live file / today already / yesterday→rotate / idempotent re-call / cron-race target-exists warn)
  - 26b-1: `appendAuditEvent` past UTC date change triggers sync rotation + append lands in fresh live file
  - 26c-1: 10 sequential `appendAuditEvent` across date change → exactly 1 rotation + all 10 events in new live file
  - 26d-1..4: `bin/olp-audit-rotate.mjs` CLI (--help / no-live-file / yesterday-file-rotates / unknown-flag exit 1)
  - 26e-1: rotated files queryable via `lib/audit-query.mjs` `discoverAuditFiles` + `readAuditWindow` cross-file read
- **`package.json`**: `bin.olp-audit-rotate` + `scripts.olp-audit-rotate` entries added.
- **Documentation:** AGENTS.md `lib/audit.mjs` marker promoted to ✅ (D45 append + D52 rotation both shipped); new `bin/olp-audit-rotate.mjs` entry.
- **Test count:** 588 → 600 (+12 D52 tests in Suite 26).
- **Authority:** ADR 0008 § 5.1 (first-append-after-UTC-midnight trigger), § 5.2 (external cron alternative), § 5.3 (concurrent-rotation safety + cron-coexistence semantics), § 5.4 (renamed-file query path consumed by D49 lib/audit-query.mjs); CLAUDE.md `release_kit overlay phase_rolling_mode` — under Unreleased; standing autopilot grant.

### D51 — `dashboard.html` full multi-panel UI (Phase 3)

Fourth Phase 3 D-day. Replaces the D50 `dashboard.html` placeholder with the full 4-panel UI per ADR 0008 § 6. Vanilla HTML + JS + fetch — no build step, no framework, no CDN (Lane 1 = A). 30s page poll with `document.visibilityState` pause/resume (Lane 4 = A).

- **4 panels rendered from `/v0/management/dashboard-data`** (the single backing endpoint, per Lane 2 in-memory query model):
  - **Panel 1 — Per-provider quota**: table of `{ Provider | Available | Status }`; surfaces `null` available as "n/a" + capturing per-provider `provider.quotaStatus()` errors as a red status pill (graceful degradation per ADR § 9).
  - **Panel 2 — Last 24h: request count + cache hit + fallback rate**: per-provider row of `{ Requests | Cache hit % | Fallback rate % }`. Cache hit sourced from `cache_hit_24h.by_provider[p].hit_rate`; fallback rate computed from `window_24h.by_provider[p].fallback_count / count`.
  - **Panel 3 — Request count last 30 days (SVG sparkline)**: vanilla SVG bar chart with `<title>` tooltips showing per-day per-provider breakdown. Y-axis: requests per day (scaled to max); X-axis: 30 daily buckets (UTC). Each bar `<title>` includes the date + total count + provider breakdown.
  - **Panel 4 — Top fallback chains (last 24h)**: numbered table of `{ # | Chain | Count | First seen | Last seen }` with chain arrows rendered in monospace (`anthropic → openai`).
- **30s poll + visibilitychange pause** (ADR 0008 § 6.5):
  - `setInterval(refresh, 30000)` after the initial fetch.
  - `document.addEventListener('visibilitychange', ...)` → `stopPolling()` on hidden / `refresh() + startPolling()` on visible.
  - Per ADR § 6.5 this prevents 2880 background polls/day per owner when the dashboard tab is in the background.
- **Error handling**:
  - 401 from `/v0/management/dashboard-data` → in-page error banner explains owner-tier requirement + suggests SSH-tunnel + header-injection workaround (browsers can't natively send `Authorization: Bearer` without a proxy/extension).
  - Other HTTP errors → generic "HTTP <code>" banner; console.warn for operator debugging.
  - Per-panel "Loading…" / "No requests in window." / "No fallback chains triggered" empty states.
- **DOM helpers**: small `el(tag, attrs, ...children)` + `svgEl(tag, attrs)` factories — no framework, ~10 lines each. Sparkline uses native `<title>` for tooltips (no JS hover handlers).
- **Critical correctness invariants** (per ADR 0008 § 6 + Lane 1 = A):
  - No `<script src>` — entire JS inline in `<script>` tag (Suite 25d asserts).
  - No `<link rel="stylesheet" href=>` — all CSS in `<style>` tag (Suite 25d asserts).
  - Only one backing endpoint hit: `/v0/management/dashboard-data` (Suite 25e asserts). All 4 panels consume slices of its response.
  - 401 path keeps panels in last-good state rather than clearing them; operator sees the error banner + can debug.
- **Test surface (Suite 25, +6 tests — 582 → 588):**
  - 25a: owner /dashboard response contains all 4 panel container IDs (`panel-quota`, `panel-24h`, `panel-trend`, `panel-chains`).
  - 25b: dashboard JS declares `POLL_INTERVAL_MS = 30000` + uses `setInterval` + `clearInterval`.
  - 25c: visibilitychange listener wired + checks `document.visibilityState === 'hidden'`.
  - 25d: NO external `<script src>` and NO external stylesheet `<link href>` — pinning Lane 1 = A.
  - 25e: dashboard JS fetches `/v0/management/dashboard-data` (the single consolidated D50 endpoint).
  - 25f: 401 in-page error banner mentions owner-tier so a maintainer who lands on a 401 knows the route forward.
- **Manual smoke (ADR 0008 § 10 #12 manual acceptance)**: the dashboard renders without console errors in a real browser when served by a running OLP instance + owner-tier Bearer token injected via SSH-tunnel + header-injection extension. Not automated at Phase 3 (Lane 4 = A poll model doesn't need playwright; Phase 4+ may add a playwright smoke if dashboard complexity grows).
- **Documentation:** AGENTS.md `dashboard.html` marker promoted from 🟡 D50 placeholder to ✅ D51 full UI.
- **Test count:** 582 → 588 (+6 D51 tests in Suite 25).
- **Authority:** ADR 0008 § 6 (panels + refresh + localhost) + § 6.5 (poll + visibilityState pause) + Lane 1 = A (no build step) + Lane 4 = A (30s poll) + Lane 5 = B (full 4-panel scope); ADR § 9 (graceful degradation surfaced in Panel 1); ADR § 10 criterion #12 (HTML smoke); CLAUDE.md `release_kit overlay phase_rolling_mode` — under Unreleased; standing autopilot grant.

### D50 — `server.mjs` management endpoints (Phase 3 dashboard wire-up)

Third Phase 3 D-day. Wires the D49 `lib/audit-query.mjs` aggregate query layer into 4 owner_only_block HTTP endpoints per ADR 0008 §§ 7-8. Ships a placeholder `dashboard.html` at repo root (D51 lands the full multi-panel UI). All endpoints follow the Phase 2 / D45 auth + audit + touchLastUsed pattern.

- **4 new endpoints** (all owner_only_block per ADR 0008 § 8 — anonymous + guest + missing-key all → 401):
  - `GET /dashboard` — serves `dashboard.html` (Content-Type text/html; charset=utf-8). D50 stub explains the state + lists backing endpoints; D51 replaces with full UI.
  - `GET /v0/management/dashboard-data` — full aggregate per ADR 0008 § 7.2: `{ generated_at, window_24h (auditAggregateRequests), cache_hit_24h (auditCacheHitRateWindow), quota (per-provider provider.quotaStatus + error capture), spend_trend_30d (auditSpendTrendDaily — exactly 30 entries), top_fallback_chains_24h (auditTopFallbackChains limit 10), cache_stats (live cacheStore.stats()) }`.
  - `GET /v0/management/quota` — quota subset only (subset of dashboard-data; useful for scripted monitoring).
  - `GET /cache/stats` — live in-memory `cacheStore.stats()` shape (`{ hits, misses, size, inflightCount }` + `generated_at` wrapper).
- **`_runOwnerOnlyManagementEndpoint(req, res, method, path, inner)` helper** factors the common auth + audit ctx + owner-block + res.on('finish') wire. inner is async (req, res, olpIdentity, auditCtx) → returns void. Eliminates 4× boilerplate.
- **`owner_only_block` mode** (ADR 0008 § 8): authenticate → if not owner → 401 `owner_required`. Distinct from `owner_only_trim` (Phase 2 /health pattern). Anonymous identity (when `allow_anonymous: true`) reaches the handler and is 401'd by the owner check — verified by Suite 24c.
- **Provider quotaStatus error capture**: dashboard-data + quota endpoints catch per-provider throws and surface `{ provider, error, available: null }` so one bad provider doesn't fail the whole panel (ADR 0008 § 9 graceful degradation).
- **`dashboard.html` placeholder** (~50 lines at repo root): explains the D50 state, lists backing endpoints with curl example. Cached in memory at first /dashboard request (`_loadDashboardHtml` with module-scope `_dashboardHtmlCache`); falls back to an in-memory stub if the file is missing (e.g., test imports from non-repo cwd).
- **Audit on management endpoints** (ADR 0008 § 7.5): every management request appends an audit row including 401 paths (verified by Suite 24j). Touch wire skips anonymous + env-owner identities (matches Phase 2 pattern).
- **Router**: 4 new GET branches added between /v1/chat/completions and the 404 fallback.
- **Test surface (Suite 24, +11 tests — 571 → 582):**
  - 24a-d: /dashboard owner_only_block (owner 200 / guest 401 / anonymous-with-allow_anonymous=true 401 / no-auth-with-allow_anonymous=false 401)
  - 24e: dashboard-data owner → 200 JSON with all required ADR § 7.2 fields (asserts `spend_trend_30d.length === 30`)
  - 24f: dashboard-data guest → 401 owner_required
  - 24g: quota owner → 200 JSON with quota array
  - 24h: cache/stats owner → 200 JSON with `{ hits, misses, size, inflightCount, generated_at }`
  - 24h-401: cache/stats guest → 401
  - 24i: successful dashboard-data appends audit row with `status_code: 200` + `key_id` + `path: '/v0/management/dashboard-data'`
  - 24j: 401 (guest blocked) dashboard-data appends audit row with `error_code: 'owner_required'` + `owner_tier: 'guest'`
- **Documentation:** AGENTS.md `lib/audit-query.mjs` D49 marker note added + new `dashboard.html` entry (D50 placeholder).
- **Test count:** 571 → 582 (+11 D50 tests in Suite 24).
- **Authority:** ADR 0008 § 7 (endpoints) + § 8 (owner_only_block mode) + § 9 (graceful degradation) + § 7.5 (audit on management endpoints); ADR 0007 § 7 (auth model reused); ADR 0002 § Provider contract (quotaStatus); ADR 0005 (cacheStore.stats); CLAUDE.md `release_kit overlay phase_rolling_mode` — under Unreleased; standing autopilot grant.

### D49 — `lib/audit-query.mjs` audit aggregate query layer (Phase 3)

Second Phase 3 D-day. Implements ADR 0008 § 4 query API. Pure in-memory ndjson scan; cross-file walk over `audit.ndjson` (live) + `audit-YYYY-MM-DD.ndjson` (rotated). No server.mjs integration in this D-day (D50 wires the consuming endpoints).

- **New file `lib/audit-query.mjs`** (~370 lines): 5 public API functions per ADR 0008 § 4.1:
  - `discoverAuditFiles({ olpHome })` — filesystem scan; returns `Map<date|'live', path>`.
  - `readAuditWindow({ startMs, endMs, olpHome, logEvent })` — generator over events in half-open window [startMs, endMs). Walks rotated date files + live file. Skips malformed lines + logs warn.
  - `aggregateRequests({ windowMs, olpHome })` — counts + status buckets + by_provider + by_owner_tier + by_path + median/p95 latency over rolling window.
  - `topFallbackChains({ windowMs, limit, olpHome })` — top-N chains by trigger count from events with `fallback_hops > 0`. Tied-count tiebreak: ascending first_seen.
  - `spendTrendDaily({ days, olpHome })` — daily series ending today with sparse-fill for zero-request days. Per-day request_count + median latency + by_provider breakdown.
  - `cacheHitRateWindow({ windowMs, olpHome })` — audit-derived cache hit rate (bypass excluded from denominator); per-provider + overall.
- **PII discipline** (ADR 0008 § 4.3): every aggregate function relays only schema fields; never message content. Suite 23g actively asserts the absence of `content`/`message`/`messages`/`prompt`/`response`/`body` keys in every aggregate output.
- **Cross-file walk semantics** (ADR 0008 § 4.2): half-open window [startMs, endMs); date-range computed once from window bounds; each rotated date file checked; live `audit.ndjson` always checked (it covers today regardless of whether the window endpoint is past midnight).
- **`spendTrendDaily` calendar-date semantics**: `days: N` returns "last N calendar UTC dates ending today" — NOT "events within a rolling N×86400-ms window" (which would span N+1 distinct UTC dates and produce off-by-one buckets at non-midnight call times). Computed via `for (let i = days-1; i >= 0; i--) dates.push(_utcDateFromMs(now - i*86400*1000));`.
- **`cacheHitRateWindow` denominator**: hit_rate = hit / (hit + miss). Bypass is intentional non-cacheable (Anthropic cache_control marker), NOT a cache miss; excluding it from the denominator gives a clean cache-effectiveness signal.
- **Test surface (Suite 23, +27 tests — 544 → 571):**
  - 23a-1..4: `discoverAuditFiles` (empty dir / live only / live+rotated / non-audit files ignored)
  - 23b-1..6: `readAuditWindow` (all-coverage / single-day / half-open exclusivity / empty window / missing files / malformed-skip with warn)
  - 23c-1..4: `aggregateRequests` (counts + status buckets + by_provider; by_owner_tier; median+p95 latency over realistic distribution; invalid windowMs rejection)
  - 23d-1..4: `topFallbackChains` (sort desc by count; limit truncation; fallback_hops=0 excluded; first_seen/last_seen carried)
  - 23e-1..3: `spendTrendDaily` (N-day range correctness; populated day breakdown; empty day sparse-fill)
  - 23f-1..3: `cacheHitRateWindow` (overall + per-provider hit_rate; bypass not in denominator; cache_status=null events excluded)
  - 23g-1..3: PII guard for `aggregateRequests` / `spendTrendDaily` / `topFallbackChains` + `cacheHitRateWindow` — every output JSON-stringified + scanned for forbidden PII keys
- **Documentation:** AGENTS.md `lib/audit-query.mjs` new entry; `lib/audit.mjs` note added that D52 extends with daily rotation.
- **Test count:** 544 → 571 (+27 D49 tests).
- **Authority:** ADR 0008 § 4 (query API surface) + § 5 (rotation file naming pattern) + § 3 (storage layout); ADR 0007 § 8 (audit ndjson event schema — input data); CLAUDE.md `release_kit overlay phase_rolling_mode` — under Unreleased; standing autopilot grant.

### D48 — ADR 0008 Phase 3 design draft (Dashboard + audit query layer)

First Phase 3 D-day. Design-only. Ratifies the storage / query model / rotation / dashboard / refresh / scope decisions ahead of D49+ implementation D-days. Opens ADR 0007 § 12 deferral for Dashboard + audit query layer + rotation.

- **New file `docs/adr/0008-dashboard-and-audit-query.md`** (~390 lines): 13 sections + Consequences + Authority citations. Decisions per maintainer-pinned lanes:
  - Lane 1 (tech stack): static HTML + vanilla JS + fetch (no build step; matches OLP "no bundler" ethos)
  - Lane 2 (query model): in-memory scan of audit ndjson per request (defers SQLite hybrid per ADR 0007 § 13)
  - Lane 3 (rotation): daily rotation, `audit-YYYY-MM-DD.ndjson` on first append after UTC midnight + optional `bin/olp-audit-rotate.mjs` external cron
  - Lane 4 (refresh): 30s page poll (no SSE infra at v0.3.0)
  - Lane 5 (dashboard scope): full per spec § 4.6 — 4 panels (quota / per-provider 24h counts / 30d spend trend / top fallback chains)
- **`docs/adr/README.md` index**: added ADR 0008 row with one-paragraph summary.
- **CHANGELOG.md** Unreleased: this entry.
- **Phase 3 sprint shape:** D49 `lib/audit-query.mjs` + Suite 23 → D50 `/v0/management/*` endpoints + Suite 24 → D51 `dashboard.html` → D52 daily audit rotation + Suite 25 → D53 `tried_providers` schema fix (D45 P2 deferral) → D54 E2E + docs → D55 Phase 3 close → v0.3.0 (maintainer-triggered).
- **Fold-in (fresh-context opus reviewer findings — 1 P2 + 2 P3, all ADR-text polish):**
  - **P2 § 8 + § 10 #9 gating-mode wording** — original § 8 implied a new "block non-owner identities" behaviour without naming it; § 10 #9 tested only the universal `allow_anonymous: false` 401 case. Fix: § 8 now formalizes two gating modes — `owner_only_trim` (Phase 2 /health pattern) vs `owner_only_block` (new Phase 3 management-endpoints pattern) — and explains the management endpoints are `owner_only_block` because the entire payload is sensitive. § 10 #9 now covers both 401 paths (with `allow_anonymous: true` + no header → anonymous identity → still 401 because management endpoints are `owner_only_block`; AND with `allow_anonymous: false` + no header → 401 at the authenticate middleware itself).
  - **P3 `/cache/stats` citation accuracy** — original § 7.4 + Authority block cited "ADR 0005 § Cache stats" which is not a real section. Corrected: planning authority is OLP v0.1 spec § 4.6; ADR 0005 references the endpoint in `Consequences/Mitigations` (~line 279) for the per-`(provider, model)` cache-hit-rate breakdown surface.
  - **P3 `cacheStore.stats()` shape gap** — § 7.4 now explicitly acknowledges the current shape (`{ hits, misses, size, inflightCount }` global aggregate) lacks the per-`(provider, model)` breakdown spec § 4.6 implies; Phase 3 Panel 2 sources per-provider counts from `aggregateRequests` (audit-side) instead. If a future panel needs the breakdown, D50 amends the store shape + an ADR 0005 amendment fires at that time. Phase 3 acceptance criteria do not require the breakdown.
- **Test count:** 544 → 544 (design-only, no test change).
- **Authority:** ADR 0007 § 12 (opens deferral) + § 13 (rejects SQLite at Phase 3 per Node baseline); v0.1 spec § 4.6 / § 4.7 (Dashboard + observability endpoints planning authority); OCP `dashboard.html` (prior art); CC 开发铁律 v1.6 § 10 — fresh-context opus reviewer required for design ADR; Phase 3 kickoff via maintainer "go" 2026-05-25 + standing-autopilot grant; PR #25 fresh-context opus reviewer findings (3 polish items).

## v0.2.0 — 2026-05-25

### Phase 2 — Multi-key auth + audit + owner gating + keygen CLI (D43-A → D47)

**Overview.** v0.2.0 closes Phase 2 — the multi-key authentication track that grew OLP from single-tenant anonymous-only proxy (v0.1.1) to a multi-identity deployment with per-key cache isolation, audit attribution, owner-vs-guest header gating, and a reproducible bootstrap CLI. 6 D-day commits (D43-A through D47) shipped between 2026-05-25 (single intensive session under the standing-autopilot grant). All 11 ADR 0007 § 10 acceptance criteria are implemented + tested.

**Test count: 468 (v0.1.1) → 544 (v0.2.0).** +76 tests across the Phase 2 arc.

**Phase 2 release_kit checklist**

- [x] All 6 D-day deliverables landed on main (D43-A, D43-B ADR draft, D44, D45, D46, D47)
- [x] CI green on every D-day merge commit + on this release commit's head
- [x] Fresh-context opus reviewer on every implementation D-day (D44/D45/D46/D47), maintainer text-review on D43-B ADR
- [x] All 11 ADR 0007 § 10 acceptance criteria (#1–#11) covered by Suite 19/20/21/22 tests
- [x] CHANGELOG "Unreleased" promoted to "## v0.2.0 — 2026-05-25" with D43-A through D47 entries
- [x] `package.json` bumped 0.1.1 → 0.2.0
- [x] `CLAUDE.md release_kit.phase_rolling_mode`: `current_phase` Phase 2 → Phase 3; `current_pre_release_identifier` `0.2.0-phase2` → `0.3.0-phase3`
- [x] README status header + Implementation Status + Phase plan reflect Phase 2 shipped
- [ ] Tag pushed (next step in this PR's lifecycle)
- [ ] `release.yml` triggered + GitHub Release created (auto on tag push; D37 phase_rolling_mode gate will pass because Unreleased is now sentinel-only)

**ADR 0007 § 10 acceptance criteria — final ship status**

| # | Criterion | Covering tests |
|---|---|---|
| 1 | Per-key cache namespace isolation | Suite 20i |
| 2 | Anonymous prod-default off → 401 | Suite 20a |
| 3 | Anonymous dev-mode on → 200 | Suite 20g |
| 4 | Owner-vs-guest `/health` gating | Suite 21a-d |
| 5 | Owner-vs-guest `X-OLP-Fallback-Detail` gating | Suite 21e-h |
| 6 | Post-revoke 401 within next request | Suite 19o + Suite 20e |
| 7 | Manifest atomicity + revoke-dominates-touch | Suite 19y-1..4 |
| 8 | Audit ndjson round-trip + PII guard | Suite 20j + 20j-stream + 20j-401 |
| 9 | Bootstrap keygen surface reproducible | Suite 22 |
| 10 | `OLP_OWNER_TOKEN` env override | Suite 19p + Suite 20f |
| 11 | `providers_enabled` 403 scope enforcement | Suite 20h |

**Known limitations carried beyond v0.2.0**

Phase 2 functional scope is complete. The following remain as Phase 3+ deferrals (tracked in `docs/v1x-roadmap.md` + new entries below):

- **Dashboard (`dashboard.html`)** — owner-only multi-provider quota / fallback / cache-hit-rate panels. Per ADR 0007 § 12 + v0.1 spec § 4.6. Phase 3 mainline.
- **Audit query layer + rotation** — `audit.ndjson` is append-only at v0.2.0; aggregate queries + log rotation deferred to Phase 3 alongside Dashboard.
- **`tried_providers` semantics on `key_no_provider_access` 403** — schema currently reports filter-rejected hops as "tried"; either ADR § 8 amendment (rename / add field) or D46+ semantic fix. Noted by D45 opus reviewer.
- **Per-provider per-key auth artifact mapping** — ADR § 12 explicit out-of-scope. Per-key cache + audit isolation works; per-key per-provider OAuth tokens (e.g., two OLP keys each authenticated to different OpenAI Codex accounts) is Phase 3+ work.
- **SQLite migration (Option 3 hybrid)** — ADR § 13 documents the forward path; trigger is Dashboard / SQL-aggregate-quota / multi-second audit-query workload. Requires engines bump (`>=22.13.0` or `>=23.4.0`) per ADR § 11 as a separate prior PR.

### D47 — `bin/olp-keys.mjs` keygen CLI (Phase 2 functional scope closes)

Fourth Phase 2 implementation D-day. Closes ADR 0007 § 10 acceptance criterion #9 (bootstrap workflow must be reproducible without manual file editing) by shipping a minimal keygen CLI per § 9.1. **Phase 2 functional scope is complete with this D-day** — remaining work is Phase 2 close → v0.2.0 (maintainer-triggered, explicit per CLAUDE.md `release_kit.phase_close_trigger`).

- **New file `bin/olp-keys.mjs`** (~250 lines): subcommand CLI with three subcommands:
  - `keygen [--owner] [--name=<label>] [--tier=guest|owner] [--providers=<csv>] [--force]` — creates a key + prints plaintext token to stdout ONCE; manifest stores only SHA-256 hash. `--force` revokes existing owner keys before creating the new owner (recovery flow per ADR § 9.3). `--providers=*` (default) or comma-separated allowlist.
  - `list [--owner-only] [--include-revoked]` — lists keys with `token_hash` redacted (lib/keys.mjs `listKeys` already redacts).
  - `revoke --id=<key-id>` — marks the key's `revoked_at`; idempotent (already-revoked → no-op + status message); missing id → exit 2.
  - Common flag `--olp-home=<path>` overrides `~/.olp/`; defaults to `OLP_HOME` env or `~/.olp/`.
- **`package.json` `bin` field**: `olp-keys` → `./bin/olp-keys.mjs` so `npx olp-keys ...` resolves; also `npm run olp-keys ...` via scripts.
- **Module shape**: CLI exposes `runCli(argv, { out, err })` so tests can invoke it with synthetic argv + IO writers (no process spawn). Main guard auto-runs when invoked as entrypoint.
- **Plaintext token discipline**: per ADR § 5 + § 9.1, plaintext is printed exactly once on stdout. Never logged, never written to manifest, never written to audit. Operators must capture immediately; lost → `--force` revoke + regenerate.
- **`--force` async correctness**: `cmdKeygen` is async and `await`s each `revokeKey` (which is async — acquires per-key write lock per § 6.4). Sequence: revoke each existing owner manifest atomically → then `createKey` for new owner. Avoids the race where create-new runs before revoke-old completes.
- **Test surface (Suite 22, +20 tests — 524 → 544):**
  - 22a-1..5: parseArgv unit tests (`--flag=value`, `--flag value`, boolean, mixed positional)
  - 22b-1..5: keygen subcommand (owner default, name+providers, missing-name error, invalid-tier error, --force revoke-then-create flow with isolation tmpdir)
  - 22c-1..3: list subcommand (empty, populated with token_hash-redaction check, --owner-only filter)
  - 22d-1..4: revoke subcommand (valid id, idempotent re-revoke, missing-id error, nonexistent-id error)
  - 22e-1..3: top-level CLI behaviour (--help / no args / unknown subcommand exit codes)
- **Documentation:** AGENTS.md `lib/keys.mjs` marker promoted to ✅; new `bin/olp-keys.mjs` entry. Implementation-status-note + shipped-set updated. README.md Implementation Status table gains `bin/olp-keys.mjs` row; Known limitations note updated to "Phase 2 functional scope complete; close pending"; new "Bootstrap workflow" section with copy-pasteable npx commands + recovery flow.
- **Test count:** 524 → 544 (+20 D47 tests in Suite 22).
- **Authority:** ADR 0007 (multi-key auth — § 5 token format, § 9.1 minimal keygen command surface, § 9.3 recovery, § 10 acceptance criterion #9 covered); CLAUDE.md `release_kit overlay phase_rolling_mode` — under Unreleased; standing autopilot grant.

### D46 — owner-vs-guest gating for `/health` + `X-OLP-Fallback-Detail` (Phase 2 closes header observability gap)

Third Phase 2 implementation D-day. Closes ADR 0007 § 10 acceptance criteria #4 (`/health` payload trimming for non-owner) + #5 (`X-OLP-Fallback-Detail` emission gating per `fallback_detail_header_policy`). Phase 2 server surface is now fully gated end-to-end; remaining D-days are keygen CLI surface (D47+) and Phase 2 close (v0.2.0, maintainer-triggered).

- **`server.mjs` `handleHealth` identity-aware payload** per ADR § 7.1:
  - Auth gate at top — `authenticate(req)` returns 401 for unauth + `allow_anonymous: false` (consistent with /v1/* routes); 200 with trimmed payload for anonymous / guest; 200 with full payload for owner.
  - Trim controlled by `_authConfig.owner_only_endpoints` — if `/health` is in the list, non-owner gets `{ ok: true, version }`; else (operator removes it) full payload to everyone (v0.1.1 opt-out knob).
  - `touchLastUsed` fired on `res.on('finish')` for filesystem identities (matches /v1/* pattern). No audit row on /health — high-volume monitoring endpoint, audit volume noise not justified at Phase 2 (would land with Phase 3 Dashboard if aggregate /health stats become needed).
- **`server.mjs` `withFallbackDetailHeader` identity-aware emission** per ADR § 7.2:
  - New helper `shouldEmitFallbackDetailHeader(olpIdentity)` reads `_authConfig.fallback_detail_header_policy`:
    - `'owner_only'` (default) → emit only when `olpIdentity.owner_tier === 'owner'`
    - `'all'` → emit unconditionally (v0.1.1 opt-back-in for operators who want the diagnostic header for all identities)
    - `'none'` → suppress unconditionally
  - When `olpIdentity` is null (pre-auth error paths), defaults to emit — preserves the v0.1.1 ungated behaviour for pre-auth errors where identity is unknown.
  - `withFallbackDetailHeader` signature gains a third `olpIdentity` argument; both call sites in `handleChatCompletions` updated to pass `olpIdentity`.
- **Test surface (Suite 21, +9 tests + 1 added in Suite 20 — 515 → 524):**
  - **20m** /health with no auth + `allow_anonymous=false` → 401 (consistency with /v1/* routes)
  - **21a-d** /health payload trimming (criterion #4): anonymous trimmed; guest trimmed; owner full; `owner_only_endpoints: []` opts out (guest gets full)
  - **21e-h** X-OLP-Fallback-Detail emission gating (criterion #5): `owner_only` + guest → header absent; `owner_only` + owner → header present + valid JSON; `'all'` + guest → header present (v0.1.1 opt-back); `'none'` + owner → header absent (full suppression). Tests use a 2-hop chain (anthropic primary fail + openai secondary) to produce non-empty `fallbackDetail` for the header content.
- **Test-mode setup updated:** the global `__setAuthConfig({ allow_anonymous: true })` was extended to also pass `owner_only_endpoints: []` + `fallback_detail_header_policy: 'all'` so pre-D46 tests (Suite 18, F5 /health tests, D40 fallback-detail tests, etc.) continue to pass without modification — Suite 21 explicitly overrides per-case to exercise the production-default-gated paths.
- **Documentation:** AGENTS.md `lib/keys.mjs` marker updated to reflect D46 ship; Implementation-status-note updated. README.md Implementation Status row + Known limitations "Multi-key auth" note rewritten to reflect D46 ship + remaining keygen CLI.
- **Test count:** 515 → 524 (+9 D46 tests).
- **Authority:** ADR 0007 (multi-key auth — §§ 7.1 + 7.2 implementation contracts + § 10 acceptance criteria #4 + #5 covered); ADR 0004 Amendment 5 (D40 ratification of "Phase 2 will re-introduce owner-vs-non-owner gating when `lib/keys.mjs` lands" — this D-day fulfils the deferral); CLAUDE.md `release_kit overlay phase_rolling_mode` — under Unreleased; standing autopilot grant (`~/.cc-rules/memory/auto/standing_autopilot_phase_2.md` in cc-rules `bf0ed9a`).

### D45 — `server.mjs` auth integration + `lib/audit.mjs` (Phase 2 wire-up)

Second Phase 2 implementation D-day. Wires the D44 `lib/keys.mjs` identity layer into the request flow + lands `lib/audit.mjs` per ADR 0007 § 6.2 + § 8. Closes acceptance criteria #1 (per-key cache isolation, validation-side end-to-end), #2 (anonymous prod-default off), #3 (anonymous dev-mode on), #6 (post-revoke 401 within next request — full), #8 (audit ndjson round-trip), #10 (`OLP_OWNER_TOKEN` env override — full server-side), #11 (`providers_enabled` 403 scope). Owner-vs-guest gating for `/health` + `X-OLP-Fallback-Detail` (criteria #4, #5) remains in D46 scope.

- **New file `lib/audit.mjs`** (~75 lines): `appendAuditEvent(event, opts)` writes one JSON event per line to `~/.olp/logs/audit.ndjson` (file 0600, dir 0700). § 6.2 retry semantics: warn + 1 retry on first failure; per-process drop counter + warn on second failure; NEVER throws. Per-call `OLP_HOME` env resolution (matches `lib/keys.mjs`). Exports `getAuditDropCount` for future /health surface.
- **`lib/keys.mjs`** extended with `loadAuthConfigSync({ olpHome })` reading the `auth` block from `~/.olp/config.json` with defaults per ADR § 7.2 (`allow_anonymous: false`, `owner_only_endpoints: ['/health']`, `fallback_detail_header_policy: 'owner_only'`). Both `lib/keys.mjs` + `lib/audit.mjs` now resolve `OLP_HOME` env per call (precedence: opts.olpHome → process.env.OLP_HOME → ~/.olp) so tests and operator deployments can redirect without code edits.
- **`server.mjs` auth middleware integration:**
  - `extractToken(req)` parses `Authorization: Bearer <token>` first, then `x-api-key: <token>`.
  - `authenticate(req)` calls `validateKey(token, { allowAnonymous: _authConfig.allow_anonymous })`; returns identity on success, 401 `{ auth_required | invalid_or_revoked_key }` on failure.
  - `isProviderEnabled(olpIdentity, providerKey)` enforces `providers_enabled` allowlist (`'*'` = all).
  - `_authConfig` loaded at startup; warn `auth_allow_anonymous_enabled` fires if `allow_anonymous: true` so the relaxed posture is visible. Test seams `__setAuthConfig` / `__resetAuthConfig`.
  - `handleChatCompletions` and `handleModels` both gated by `authenticate(req)` at top. Audit ctx object built throughout the handler lifecycle; `res.on('finish')` appends the row + fires `touchLastUsed` async (best-effort).
  - **Identity-vs-credentials separation:** `olpIdentity` (the new validated identity) is consumed for cache namespacing + providers_enabled + audit; `authContext` passed to `provider.spawn()` REMAINS `null` so providers continue their own credential discovery (env / keychain / file). Per-provider per-key credential mapping is Phase 3+ scope per ADR § 12.
  - `handleChatCompletions` chain filtered by `chain.filter(hop => isProviderEnabled(olpIdentity, hop.provider))`; empty result returns 403 `key_no_provider_access` with helpful diagnostic message.
  - `keyId = olpIdentity.keyId` (replacing hardcoded `'__anonymous__'` at the cache call sites).
  - Audit captures fields throughout: post-auth (key_id, owner_tier); post-IR (model); post-chain-success (provider, fallback_hops, tried_providers, cache_status); post-chain-exhausted (error_code, providerUsed=chain[0], cache_status='miss'). Status code + latency populated on `res.on('finish')`.
- **Test surface (Suite 20, +15 tests, 499 → 514):**
  - 20a-d: header parsing + valid key happy paths (Bearer / x-api-key / invalid → 401)
  - 20e: revoked key 401 (closes criterion #6 end-to-end)
  - 20f: `OLP_OWNER_TOKEN` env override returns 200 (criterion #10 full coverage)
  - 20g: `allow_anonymous: true` + no header returns 200 (criterion #3)
  - 20h + 20h-extra: `providers_enabled: ['mistral']` for anthropic model → 403; `'*'` baseline returns 200 (criterion #11)
  - 20i: per-key cache namespace isolation — keys A/B with identical payload do not share cache (criterion #1 end-to-end)
  - 20j + 20j-401: audit.ndjson written with § 8 schema fields including PII guard; 401 path also appends (criterion #8)
  - 20k: filesystem key `last_used_at` populated after first successful request (D45 touchLastUsed wire)
  - 20l + 20l-200: `/v1/models` also enforces auth (consistent gating across `/v1/*`)
- **Test-mode setup:** test-features.mjs sets `process.env.OLP_HOME` to a tmpdir at module load so audit + key writes don't pollute `~/.olp/`. After the server.mjs import resolves, calls `__setAuthConfig({ allow_anonymous: true })` so pre-D45 HTTP integration tests (Suite 18 etc.) that don't pass an Authorization header continue to pass as anonymous; Suite 20 explicitly overrides per-case for production-default-off coverage.
- **Documentation:** AGENTS.md `lib/keys.mjs` 🟡 marker updated + new `lib/audit.mjs` entry; AGENTS.md Implementation-status-note + shipped-set updated. README.md Implementation Status table gains `lib/audit.mjs` row + `lib/keys.mjs` row updated; Known limitations "Multi-key auth" note rewritten to reflect D45 ship + D46 follow-up; new env-vars and config block surfaced for users.
- **Test count:** 499 → 515 (+15 initial Suite 20 tests + 1 fold-in regression test `20j-stream` covering opus-P1 streaming audit-fidelity).
- **Fold-in (CI-fail recovery + fresh-context opus reviewer findings, 1 CI + 1 P1 + 2 P2 + 1 P3):**
  - **CI Node 24 failure** — Suite 20 setup did not stub `CLAUDE_CODE_OAUTH_TOKEN` before the mock spawn ran; lib/providers/anthropic.mjs `_spawnAndStream` checks for an OAuth token BEFORE invoking the (mock) spawn, so the AUTH_MISSING pre-check fired and every Suite 20 200-expecting test 502'd on CI Node 24 (local Node 22 had the env from the maintainer's claude install). Fixed by `ensureSuite20FakeOAuth` / `restoreSuite20OAuth` helpers in `makeSuite20Server` / `teardownSuite20`; matches the existing pattern used at Suite 9 line ~2154 (`test-fake-oauth-token-for-cache-tests`).
  - **P1 real-streaming audit fidelity** — single-hop streaming success path (server.mjs ~L1050+ `if (ir.stream && chain.length === 1 && !bypassCacheForFirstHop ...)`) did not populate `auditCtx.provider` / `tried_providers` / `cache_status`, so audit rows for the most common deployed shape carried `provider: null`. Fixed by stamping these fields at the top of the streaming branch (between the streamPlugin null-check and the `streamHeaders` build) and amending `error_code` on the two streaming failure exit paths (`streaming_error_after_first_chunk` + `streaming_error_before_first_chunk`). New regression test `20j-stream` makes a streaming request and asserts the audit row's `provider`, `cache_status`, and `tried_providers` fields are populated.
  - **P2 global test tmpdir cleanup** — `process.env.OLP_HOME = mkdtempSync(...)` at module load left a `/var/folders/.../olp-test-home-*` directory leak per `npm test` run. Fixed by `process.on('exit', () => rmSync(...))` registered immediately after the mkdtempSync. Best-effort; never throws at exit.
  - **P3 handleModels 401 lacks OLP diagnostic headers** — `handleChatCompletions` 401 path passes `olpErrorHeaders({ startMs })` but `handleModels` did not. Aligned by adding the same headers to the `handleModels` `authResult.ok=false` return.
  - **Deferred (acknowledged by reviewer as non-blocking):** P2 `tried_providers` semantics on `key_no_provider_access` 403 — schema currently reports filter-rejected hops as "tried" which a downstream Dashboard would misread; either ADR § 8 amendment (rename / add field) or D46+ semantic fix.
- **Authority:** ADR 0007 (multi-key auth — §§ 5/6.2/7/9.4 implementation contracts + § 10 acceptance criteria #1/#2/#3/#6/#8/#10/#11); CLAUDE.md `release_kit overlay phase_rolling_mode` — under Unreleased; Phase 2 kickoff handoff (`~/.cc-rules/memory/handoffs/2026-05-25-phase-2-kickoff.md` in cc-rules `d9da966`); standing autopilot grant (`~/.cc-rules/memory/auto/standing_autopilot_phase_2.md` in cc-rules `bf0ed9a`).

### D44 — `lib/keys.mjs` core landed (multi-key auth, no server wire-up yet)

First Phase 2 implementation D-day. Lands the `lib/keys.mjs` module per ADR 0007 §§ 5/6.1/6.3/6.3.5/6.4/9.4. Identity / lifecycle layer for OLP API keys is now in-tree; `server.mjs` integration scheduled D45 (until then, requests still use the hardcoded `'__anonymous__'` cache namespace — no behavioural change at v0.1.1 / D44).

- **New file `lib/keys.mjs`** (~462 lines after fold-in) — public API surface:
  - `createKey({ name, owner_tier, providers_enabled, notes, olpHome })` — generates opaque `olp_<32-byte base64url>` token (47-char total), SHA-256 hashes it for manifest storage, atomically writes `keys/<id>/manifest.json` (mode 0600, dir 0700). Returns `{ id, plaintext_token, manifest }` — plaintext token is printed once and never persisted.
  - `validateKey(plaintext, { allowAnonymous, olpHome })` — three-tier resolution per § 5 / § 7 / § 9.4: env override (`OLP_OWNER_TOKEN` → `__env_owner__` synthetic identity) → anonymous (only when `allowAnonymous: true`, returns `__anonymous__` identity) → filesystem manifest lookup (constant-time hash compare via `crypto.timingSafeEqual`). Revoked manifests return null (caller produces 401). Per § 6.3.5 — MUST hit manifest every request; no in-process validation cache.
  - `revokeKey({ id, olpHome })` — idempotent; sets `revoked_at` via atomic write inside per-key write-lock.
  - `listKeys({ olpHome })` — returns manifest objects with `token_hash` redacted.
  - `touchLastUsed(id, { olpHome })` — async best-effort lazy update per § 6.3 revoke-dominates-touch: re-reads latest manifest inside the per-key lock, NO-OPs if `revoked_at` is non-null, otherwise merges `last_used_at` preserving all other fields. Failure logs warn and never throws.
- **§ 6.4 in-process per-key write-lock** — `Map<key-id, Promise>` chain; serializes intra-process writes. External (CLI) writes not lock-protected at Phase 2; atomic-rename + § 6.3 read-before-write give the `revoke dominates touch` safety property.
- **Test-only hooks** — `__setTouchInterleaveHook` (inject deterministic pause between touch's lock acquisition and read for race tests) + `__resetWriteLocks` (test cleanup).
- **What is NOT in D44 (split per ADR §§ 6.2 / 9.1 separation):** audit ndjson append (request-layer concern; D45 server glue); keygen CLI bootstrap surface (D45+); `server.mjs` integration replacing the hardcoded `'__anonymous__'` keyId at `server.mjs:502, :531` (D45); owner-vs-guest gating for `/health` and `X-OLP-Fallback-Detail` (D46).
- **Test count:** 468 → 496 (+28 tests in new Suite 19):
  - 19a-d token generation (§ 5)
  - 19e-j manifest write+read + chmod 0600/0700 + schema validation (§ 4, § 6.1)
  - 19k-p validateKey: filesystem / wrong / missing / anonymous / revoked / env override (§ 5, § 6.3.5, § 9.4)
  - 19q-r revokeKey idempotency + non-existent id
  - 19s-t listKeys empty + redaction
  - 19u-x touchLastUsed updates + NO-OP on revoked + NO-OP on anonymous/env identities + best-effort failure
  - **19y-1 to 19y-4 acceptance criterion #7 (concurrent revoke + touch race tests)**: revoke→touch, touch→revoke, interleaved external-revoke-via-hook (deterministically reproduces the § 6.3 race the maintainer's text review caught), 30-iteration concurrent-promise stress
- **Documentation:** AGENTS.md `lib/keys.mjs` 📋 marker → 🟡 "core landed at D44"; AGENTS.md Implementation-status-note + shipped-set updated to include `lib/keys.mjs`; README.md Implementation Status row + Known limitations "Multi-key auth" note updated to "core landed, server integration pending D45".
- **Fold-in (fresh-context opus reviewer findings, 2 P2 correctness + 2 P3 polish):**
  - **P2 #1 lock-map cleanup** (`lib/keys.mjs` `_withKeyLock`): prior version stored `prev.then(() => next)` as the Map tail, but the cleanup-identity check `_writeLocks.get(id) === next` could never match the derived promise — Map entries leaked one-per-unique-key-id. Bounded impact at family scale (~5–10 entries) but a real correctness bug. Fixed by storing `next` directly. New regression tests `19x-extra` (sequential) + `19x-extra-2` (concurrent 3-key × 3-touch contention) assert `__writeLockSize() === 0` post-drain.
  - **P2 #2 `validateKey` non-string defensive coding**: prior version threw `TypeError` when called with a non-string truthy plaintext (`validateKey(42)` / `validateKey({})`), reaching `hashToken(<non-string>)` → `createHash().update(<non-string>)`. Q2 promised "bad inputs return null." Fixed via top-of-function `if (plaintextToken != null && typeof plaintextToken !== 'string') return null;`. New test `19m-extra` covers number / object / array / `allowAnonymous: true` paths.
  - **P3 #3 19y-3 test scope comment**: test simulates external revoke landing BEFORE touch's read, not BETWEEN touch's read and write (which is currently unreachable because `touchLastUsed` has synchronous read→write — no await between `readManifest` and `writeManifestAtomic`). Added explanatory comment documenting the synchronous-read-write property as the satisfaction mechanism for ADR § 10 criterion #7 scenario 3, with a note that a post-read hook + matching test would be required if a future refactor introduces an await between read and write.
  - **P3 #4 CHANGELOG line count**: corrected `~330 lines` to `~462 lines after fold-in` (matches `wc -l lib/keys.mjs`).
- **Test count after fold-in:** 468 → 499 (+31 tests: 28 initial + 3 fold-in regression tests).
- **Authority:** ADR 0007 (multi-key auth — Decision: Option 2 filesystem manifest + opaque token; §§ 5/6.1/6.3/6.3.5/6.4/9.4 implementation contracts; § 10 acceptance criteria #6/#7 partially-covered by D44 tests, full coverage requires D45+ server integration); CLAUDE.md `release_kit overlay phase_rolling_mode` — under Unreleased; Phase 2 kickoff handoff (`~/.cc-rules/memory/handoffs/2026-05-25-phase-2-kickoff.md` in cc-rules `d9da966`); PR #20 fresh-context opus reviewer findings.

### D43-B — ADR 0007 multi-key auth design draft (design-only, no code change)

Phase 2 mainline design ADR. Ratifies the storage / token / manifest / atomic-write / owner-gating / bootstrap / Node-baseline decisions ahead of D44+ implementation D-days. Pure design doc — no `.mjs` / no tests / 4 files touched.

- `docs/adr/0007-multi-key-auth.md` (new, ~420 lines after fold-ins): 13 sections covering Context / Decision (Option 2 + opaque key) / Storage layout (`~/.olp/keys/<key-id>/manifest.json` + `~/.olp/logs/audit.ndjson`) / Manifest schema (schema_version, token_hash, owner_tier, providers_enabled) / Token format (`olp_<32-byte base64url>`, SHA-256 hash) / Atomic write & audit append (manifest lifecycle-only atomic via tmpfile+fsync+rename; audit per-request append, warn + 1 retry, no memory buffer at Phase 2) / Owner-vs-guest-vs-anonymous gating (config.json `auth.allow_anonymous` default false, no env auto-detection) / Audit ndjson schema (no PII) / Bootstrap & recovery (minimal keygen command surface + `OLP_OWNER_TOKEN` env override with stable `__env_owner__` keyId) / Acceptance criteria (11 test surfaces for D44+) / Node baseline (Option 1 SQLite port rejection rationale citing `engines >=18` + CI 20/24 vs `node:sqlite` v22.5.0 with flag) / Out of scope (Dashboard, quota enforcement, audit query, file locking deferred to Phase 3+) / Future forward (Option 3 hybrid migration trigger + preconditions).
- `docs/adr/README.md` index: added ADR 0007 row with one-paragraph summary.
- `docs/v1x-roadmap.md` #2: marked **PHASE 2 ACTIVE (no longer deferred)**; "Design ADR (NOT YET RATIFIED)" → "Design ADR (ratified) → ADR 0007"; trigger updated to "already fired 2026-05-25"; code anchors pinned to exact line numbers (cache/store.mjs:77-79/:287, server.mjs:502/:531/:392/:1072/:1101).
- `CHANGELOG.md` Unreleased: this entry.
- **Fold-in #1 (fresh-context opus reviewer findings, 2 P2 + 3 P3, all polish):** § 6.2 step 1 — pin audit serialization timing to after status_code + latency_ms are known (resolves §10 #2 testability gap); new § 6.3.5 — explicit "no in-process validation cache at Phase 2" rule (resolves §10 #6 implicit-contract gap); § 6.1 — document deliberate omission of directory fsync after rename (single-process trade-off); § 9.4 — token-collision policy between `OLP_OWNER_TOKEN` and filesystem keys declared undefined behaviour; §10 #4 — test rephrased to assert against config-driven `owner_only_endpoints` rather than hardcoded payload shape.
- **Fold-in #2 (maintainer text-review findings, 1 P1 + 1 P2 + 1 P3):** § 6.3 rewritten to `last_used_at` revoke-dominates-touch semantics (P1 — fixes safety bug where lazy touch could overwrite revoke and silently clear `revoked_at`, breaking acceptance criterion #6 under concurrent CLI revoke + in-flight server request); § 6.4 reframed from "both states are valid" / "observability-grade" to "revoke dominates touch" with §6.3 as the load-bearing discipline; § 10 criterion #7 expanded to test all three orderings (revoke→touch, touch→revoke, interleaved) with explicit MUST: `revoked_at` non-null after revoke regardless of ordering; § 11 forward path step (1) corrected Node version history — minimum non-flag-gated baseline is v22.13.0 (LTS) / v23.4.0 (current), RC since v25.7.0, stable TBD (previous wording "Node v22.5.0+ for unflagged but RC" was factually wrong per https://nodejs.org/download/release/v22.12.0/docs/api/sqlite.html and https://nodejs.org/api/sqlite.html); this CHANGELOG entry line-count corrected from "~270 lines" to "~420 lines after fold-ins".
- **Test count:** 468 → 468 (design-only, no test change).
- **Authority:** Phase 2 kickoff handoff (`~/.cc-rules/memory/handoffs/2026-05-25-phase-2-kickoff.md` in cc-rules `d9da966`); OLP v0.1 spec § 4.5 (planning authority for `~/.olp/` layout); OCP `keys.mjs` (prior-art for opaque-key + per-key isolation model); Node `node:sqlite` docs (https://nodejs.org/api/sqlite.html — Option 1 rejection rationale per ADR 0007 § 11); CC 开发铁律 v1.6 § 10 — fresh-context opus reviewer required for design ADR per Iron Rule 10.

### D43-A — Phase 2 doc alignment (no code change)

Phase 1 was closed at v0.1.1; this commit aligns documentation surfaces to the Phase 2 reality before D43-B (ADR 0007 draft) lands. Pure doc cleanup; no `.mjs` or test changes.

- `CLAUDE.md release_kit.current_phase` Phase 1 → Phase 2; `current_pre_release_identifier` `0.1.0-bootstrap` → `0.2.0-phase2`.
- `README.md` status header + Implementation Status + Phase plan rewritten to reflect actually-shipped reality (v0.1.0 + v0.1.1 bundled the three Tier-D plugins + cache + fallback into a single Phase 1 milestone, not one phase per plugin as the original v0.1 spec planned). `lib/keys.mjs` row + "Multi-key auth not yet implemented" note updated to "Phase 2 active per ADR 0007 (drafting at D43-B)".
- `AGENTS.md` § Key files to know — `lib/keys.mjs` 📋 marker updated to "Phase 2 active per ADR 0007 (drafting at D43-B)"; Implementation-status-note paragraph dated 2026-05-25 + reflects Phase 1 close + Phase 2 active scope.
- `ALIGNMENT.md` § Provider Inventory — added one-paragraph "Note on phase terminology" clarifying that "Phase" in the Provider Inventory tables + § One-shot Triggered Audits "OpenAI Codex ToS formal pin" refers to the original per-plugin enablement plan, orthogonal to the milestone phase numbering in README. Fold-in for D43-A reviewer P2 finding; no governance-text change, no Speculative-Candidate plugin reclassification.
- **Test count:** 468 → 468 (no test change).
- **Authority:** `CLAUDE.md release_kit overlay phase_rolling_mode` — under Unreleased; Phase 2 kickoff handoff at `~/.cc-rules/memory/handoffs/2026-05-25-phase-2-kickoff.md`; ADR 0007 forthcoming at D43-B.

## v0.1.1 — 2026-05-25

### Phase 1 cleanup — pre-Phase-2 batch (D35–D42, closes 16 of 17 issues)

**Overview.** v0.1.1 closes the post-v0.1.0 cleanup batch covering all 17 pre-Phase-2 issues raised during the 6-round cold-audit cycle on the Phase 1 deliverable. 8 D-day commits (D35–D42) shipped between 2026-05-24 and 2026-05-25. 16 issues closed; issue #16 (streaming singleflight) stays OPEN as the v1.x tracker with its design ratified in ADR 0005 Amendment 8.

**Test count: 416 (v0.1.0) → 468 (v0.1.1).** +52 tests across the cleanup batch.

### D35 — pre-Phase-2 batch #1 (issues #4 #9 #10 #11 #12)

- **#4 — X-OLP-Latency-Ms uniform.** Audit confirmed already-correct via D32; D35 adds the `#4-audit` regression test pinning the 5-header invariant on the 503 no-provider sendError so future drift is caught immediately.
- **#9 — Streaming empty-then-clean-exit headers.** Zero-chunk streaming path now guards `!res.headersSent` and emits Content-Type=text/event-stream, Cache-Control=no-cache, Connection=keep-alive, X-Accel-Buffering=no, plus all 5 X-OLP-* headers via olpHeaders before writing `SSE_DONE`. Zero-chunk path correctly does NOT cache.
- **#10 — Streaming post-first-chunk error truncation marker.** Two sibling fixes: catch-block-firstChunkEmitted=true and error-chunk-after-first-chunk both now emit synthetic `{type:'stop', finish_reason:'length'}` via `irChunkToOpenAISSE` + `SSE_DONE` + `res.end()`. Per ADR 0004 § Fallback safety: post-first-chunk truncation surfaces as `length` finish, never a hang.
- **#11 — `validateIRRequest` irVersion strict check.** ADR 0003 IR contract pins irVersion to `'1.0'`. Validator now: `obj.irVersion !== undefined && obj.irVersion !== '1.0'` → rejection. Strict string match — `undefined` accepted (back-compat), `'1.0'` accepted, `'2.0'` rejected, numeric `1.0` rejected (`1.0 !== '1.0'`).
- **#12 — `alignment.yml` scripts/** trigger removal.** Removed from both `push.paths` and `pull_request.paths` since the `scripts/` directory does not currently exist (planned for Phase 7).
- **Test count:** 416 → 424 (+8).

### D36 — pre-Phase-2 batch #2 (issues #2 #5 #6 #13 #14 #15)

- **#2 — cache_control partial-noop debug log.** `server.mjs handleChatCompletions` fires `logEvent('debug', 'cache_control_partial_noop', { chain, marker_count })` at most once per request when markers present AND chain has at least one non-Anthropic hop. Per ADR 0005 § D2.
- **#5 — ADR 0002 vibe.mjs → mistral.mjs.** § Decision filesystem layout corrected to match the shipped file naming convention (file named after provider key, not CLI binary). Amendment 5 documents the correction + makes the convention statement explicit for future contributors.
- **#6 — mistral.mjs A5 flip + ALIGNMENT.md table update.** Header A5 (model flag) flipped from `UNPINNED-D-later-verifies` to `CONFIRMED-NOT-APPLICABLE` with DeepWiki citation; ALIGNMENT.md Speculative-Candidate table mistral row updated to remove A5.
- **#13 — /v1/models alias governance.** ALIGNMENT.md gains "Controlled deviations (entry-surface scope)" subsection documenting the alias surface as a controlled Rule 2(b) deviation; `docs/openai-spec-pin.md` gains the alias-surfacing subsection with full 4-field contract table.
- **#14 — cache_control slot determinism regression test.** 4 tests in test-features.mjs construct hand-built IRs with synthetic markers (bypassing openAIToIR which strips them at v0.1) and verify the cache key SHA-256 is deterministic. Per ALIGNMENT.md Rule 2 (No Invention), no `sortMarkers` helper shipped — the slot is dead-code at v0.1.
- **#15 — Anthropic v2.1.89 transcript artifact.** New file `docs/provider-audits/anthropic.md` as a single living version-capture artifact. Records observed `claude --version` (2.1.132 at capture date 2026-05-24), pinned version (v2.1.89 from D4), drift note, sample invocation, flag-surface table for 5 OLP-consumed flags. Closes the circular ALIGNMENT.md ↔ plugin header citation by anchoring on an external artifact.
- **Test count:** 424 → 431 (+7).

### D37 — release.yml phase_rolling_mode gate (issue #17)

- **CI gate enforcing phase_rolling_mode promotion discipline.** New "Enforce phase_rolling_mode (Unreleased must be promoted)" step in `release.yml` between the version-match check and the CHANGELOG extraction step. Awk extracts content between `## Unreleased` and the next `## ` heading; sed strips blank lines and parenthetical-sentinel-only lines. Non-trivial remaining content fails the workflow with `::error::` instructing the maintainer to promote Unreleased → `## v<version>` per CLAUDE.md release_kit.phase_rolling_mode.
- **Dry-run validated against 4 cases:** current sentinel-only Unreleased → PASS; synthetic non-trivial Unreleased → FIRES with offending lines reported; no Unreleased section → PASS; multi-sentinel + blank lines → PASS.
- **Gate is purely additive** — fires only on tag push to `v*.*.*`, does not affect normal push/PR CI.
- **Test count:** 431 → 431 (no test change — CI workflow only).

### D38 — maxConcurrent runtime enforcement (issue #1)

- **Spawn lifecycle gate** — `hints.maxConcurrent` is now enforced at runtime per ADR 0002 Amendment 6: `lib/providers/index.mjs` exports a per-provider `tryAcquireSpawn` / `releaseSpawn` / `getActiveSpawnCount` semaphore; `server.mjs` gates both the buffered and streaming spawn call sites in `handleChatCompletions` with a try/finally release. Saturation surfaces as `ProviderError(CONCURRENCY_LIMIT)` which the fallback engine treats as a hard trigger (ADR 0004 Amendment 4) — the chain advances to the next hop instead of queueing. If the entire chain is saturated, the user receives a chain-exhausted error via the existing exhaustion path. Closes #1. Queue+timeout deferred (see ADR 0002 Amendment 6 § Design choice). Test count 431 → 447.

- **Spawn lifecycle gate** — `hints.maxConcurrent` is now enforced at runtime per ADR 0002 Amendment 6: `lib/providers/index.mjs` exports a per-provider `tryAcquireSpawn` / `releaseSpawn` / `getActiveSpawnCount` semaphore; `server.mjs` gates both the buffered and streaming spawn call sites in `handleChatCompletions` with a try/finally release. Saturation surfaces as `ProviderError(CONCURRENCY_LIMIT)` which the fallback engine treats as a hard trigger (ADR 0004 Amendment 4) — the chain advances to the next hop instead of queueing. If the entire chain is saturated, the user receives a chain-exhausted error via the existing exhaustion path. Closes #1. Queue+timeout deferred (see ADR 0002 Amendment 6 § Design choice). Test count 431 → 447.

### D39 — D16 follow-ups (issue #3): explicit cache delete + eviction log + SPAWN_TIMEOUT asymmetry doc

- **Part 1 — `CacheStore.delete(keyId, cacheKey)`** — adds an explicit eviction primitive to `lib/cache/store.mjs`. Returns `boolean` (true if entry present and removed; false otherwise) and removes empty per-keyId namespace `Map` entries from the outer store for memory hygiene (matches the D38 `_activeSpawns` pattern). `server.mjs` D16 salvage path replaces `cacheStore.set(..., ttlMs=0)` (lazy tombstone that lived in the namespace `Map` until the next `get`/`peek` purged it) with `cacheStore.delete(...)` (immediate removal). Cache semantics unchanged — truncated responses still don't persist. ADR 0005 § "Cache write conditions" item 1 authority.
- **Part 2 — `cache_evicted_truncated` observability log** — adds an `info`-level structured log event fired immediately after the D16 eviction in `executeHopFn`. Carries `{ provider, model }` so dashboards can surface salvage frequency per (provider, model) pair. P3 polish; no semantic change.
- **Part 3 — sticky-cache regression test** — defense-in-depth test asserting two consecutive identical buffered requests that both trigger SPAWN_FAILED-with-chunks salvage each invoke a fresh spawn (spawnCount=2 across the two requests; second request reports `X-OLP-Cache: miss`). Catches any future regression where the eviction is dropped or the gate condition flips.
- **Part 4 — SPAWN_TIMEOUT salvage asymmetry documented (no code change)** — ADR 0004 Amendment 1 gains a new sub-section "Why SPAWN_TIMEOUT is excluded from salvage" with a 4-point rationale: (1) SPAWN_FAILED is a terminal signal, SPAWN_TIMEOUT is a deadline signal; (2) the next hop is a different provider with different speed characteristics, plausibly full-response-soon-after-T; (3) the "user paid for partial" framing applies to SPAWN_FAILED only — for SPAWN_TIMEOUT the user paid for "result within T"; (4) code inspection confirms the catch block matches only `code === 'SPAWN_FAILED'`. Includes hard-trigger-taxonomy completeness note and v1.x re-evaluation trigger (opt-in salvage-on-timeout for long deadlines).
- **Authority:** ADR 0005 § Cache layer / CacheStore API extension (Part 1); ADR 0004 Amendment 1 (Part 4); GitHub issue #3 — closed by this commit; D16 commit `bafa6d1` non-blocking suggestions — batched here.
- **Test count:** 447 → 452 (3 unit tests for `CacheStore.delete` + 1 log-event integration test + 1 sticky-cache regression test).

### D40 — `X-OLP-Fallback-Detail` header (issue #7)

- **New debug header on responses with a non-empty failure trail** — `lib/fallback/engine.mjs#executeWithFallback` now returns a `fallbackDetail` array of per-hop tuples on every code path. `server.mjs` emits `X-OLP-Fallback-Detail: <JSON-stringified array>` on any response where at least one hop failed before the chain resolved or exhausted (chain-exhausted, non-trigger-error, client-error, AUTH_MISSING, and success-with-prior-failure paths). Header is absent on clean primary success (no failure trail to report).
- **Tuple schema** — `{ hop, provider, model, code, error_message, trigger_type }` per failed hop. `code` is the `ProviderError` code or `'UNKNOWN'` for non-`ProviderError` exceptions; `error_message` is truncated to 200 chars with a U+2026 ellipsis on truncation; `trigger_type` matches D28's `classifyTrigger` output (`'hard'` / `'soft'` / `'auth_missing'` / `'client_error'` / `'non_trigger'`). Field shapes reuse D28's per-hop structured log event keys so logs and the header pivot on the same surface.
- **4KB UTF-8 byte cap** — if the JSON-stringified array exceeds 4096 bytes, tail tuples are dropped and a `{ truncated: true, omitted_hops: N }` sentinel is appended such that the total fits under the cap. Cap calculation uses `Buffer.byteLength('utf8')`, not string length.
- **RFC 7230 hygiene** — non-ASCII code points (e.g. the em dash in the D38 `CONCURRENCY_LIMIT` synthesised error message) are escaped as `\uXXXX` so the header value is pure ASCII. Node's HTTP header validator rejects multi-byte UTF-8 in field values; without this step, em-dash-bearing error messages would crash `res.writeHead`. `JSON.parse` round-trips the escaped form correctly.
- **Gating posture — ungated at v0.1** — the original ADR 0004 § Chain advancement step 4 specified owner-only gating. Per the maintainer decision in issue #7, v0.1 ships the header **ungated** (single-tenant family-scale per ALIGNMENT.md; no PII risk in error details). **Phase 2 will re-introduce owner-vs-non-owner gating when `lib/keys.mjs` lands** — explicit follow-up tracked in AGENTS.md § Key files to know and ADR 0004 Amendment 5.
- **Authority:** ADR 0004 § Decision § Chain advancement step 4 (original promise — D40 fulfils it); ADR 0004 Amendment 5 (D40 ratification); D18 (5 standard X-OLP-* headers; D40 builds on the convention); D28 (per-hop structured log fields; D40 reuses the field shapes); GitHub issue #7 — closed by this commit.
- **Test count:** 452 → 468 (7 engine-level tuple-shape tests + 6 serialiser unit tests including the 4KB cap + non-ASCII regression + 3 HTTP integration tests).

### D41 — `X-OLP-Provider-Used` semantics documented (issue #8)

- **Doc-only clarification.** On a chain-exhausted response, `X-OLP-Provider-Used` identifies the chain's configured primary entry (`chain[0].provider`), not necessarily the first hop where `spawn()` was actually invoked. At v0.1 this is unobservable because soft triggers are deferred (ADR 0004 Amendment 2) — every hop is attempted in order, so chain-origin and first-attempted are equivalent. When soft triggers reactivate in v1.x, a soft-skipped hop 0 followed by hard-failed hops 1+N would still report `providerUsed=chain[0]` despite chain[0] never being spawned.
- **Option B (document chain-origin) chosen over Option A (track `firstAttemptedProvider`).** Rationale: Option A would add state to `executeWithFallback` for an unreachable v0.1 code path (ALIGNMENT.md Rule 2 — No Invention). The D40 `X-OLP-Fallback-Detail` header already carries precise per-hop spawn history (including soft-skip records with `trigger_type: 'soft'`), so the disambiguation channel exists on the wire without needing `providerUsed` to handle it.
- **Updates:** ADR 0004 Amendment 6 documents the semantics; `README.md` § Observability headers replaces "which provider's plugin served the request" with the chain-origin wording; `lib/fallback/engine.mjs` chain-exhausted return site gains an inline comment citing the amendment and the v1.x re-evaluation note.
- **No code-behavior change. No new tests** — the relevant scenario is dead-by-config at v0.1; the v1.x soft-trigger reactivation work should add a test that exercises the soft-skip + chain-exhausted edge case and pins whichever option the v1.x maintainer chooses (the amendment names Option A as the likely v1.x preference).
- **Authority:** ADR 0004 Amendment 6 (this commit); ADR 0004 § Decision § Chain advancement step 4; ADR 0004 Amendment 2 (soft triggers deferred — precondition); ADR 0004 Amendment 5 (per-hop attribution channel via `X-OLP-Fallback-Detail`); ALIGNMENT.md Rule 2 (No Invention rationale); GitHub issue #8 — closed by this commit.
- **Test count:** 468 → 468 (no test change).

### D42 — Streaming singleflight design ADR + v1.x roadmap (issue #16)

- **Design-only ratification of the v1.x streaming singleflight implementation.** ADR 0005 Amendment 6 (D34) had deferred this work with a "design alone warrants a dedicated ADR" note. D42 fulfils the note as ADR 0005 Amendment 8, ratifying the `cacheStore.getOrComputeStreaming(...)` API shape, per-(keyId, cacheKey) inflight Map, tee fan-out with bounded per-client backpressure queues, late-joiner replay buffer, AbortController propagation on all-disconnect, D38 `tryAcquireSpawn` coordination (only the first caller's spawn counts against the semaphore), cache TTL race handling, the new `STREAM_BACKPRESSURE` error code (NOT a hard trigger), and the new `X-OLP-Streaming-Inflight: source | attached | solo` header. Implementation acceptance criteria are enumerated in Amendment 8 §13.
- **Multi-layer safeguards to ensure the v1.x work is not forgotten.** New file `docs/v1x-roadmap.md` is a single living landing page for every Phase-1 deferral (streaming SF, multi-key auth, soft-trigger reactivation, `/health` activeSpawns, provider-level `cacheKeyFields`, streaming-path SPAWN_FAILED salvage, D40 AUTH_MISSING tuple test). Each entry names the ratifying ADR, the load-bearing code anchor, and a concrete trigger to start. Cross-references added at: `lib/cache/store.mjs#getOrCompute` JSDoc (sibling API TODO), `server.mjs` streaming-branch entry (~line 810, the peek+spawn pattern Amendment 8 replaces), `README.md § Known limitations` (user-facing surface), and `docs/adr/0005-cache-cross-provider.md` Amendment 8 § "Cross-references and safeguards".
- **Issue #16 status.** STAYS OPEN as the v1.x implementation tracker. The body of the issue is updated post-D42 to reference Amendment 8 and clarify scope ("design ratified; implementation pending"). DO NOT close the issue until Amendment 8 §13's test surface is green against an actual implementation.
- **No code-behavior change. No new tests.** Amendment 8 is design-only. The implementation will go through full Iron Rule 10 (fresh-context opus reviewer + acceptance-criteria-gated test pass) when the v1.x sprint kicks off.
- **Authority:** ADR 0005 Amendment 8 (this commit); ADR 0005 Amendment 6 (D34 — original deferral note); GitHub issue #16 (round-6 F13 — sibling TOCTOU); ADR 0002 Amendment 6 (D38 — `tryAcquireSpawn` semantics that §7 coordination builds on); ADR 0004 Amendment 5 (D40 — observability pattern §11 extends); `CLAUDE.md` release_kit_overlay phase_rolling_mode — under Unreleased; CC 开发铁律 v1.6 § 10.x (design-only amendment; fresh-context reviewer not required per the Iron Rule 10 implementation-phase scope, documented in the amendment's procedural mechanism).
- **Test count:** 468 → 468 (no test change — design-only).

### Phase 1 cleanup release_kit checklist

- [x] All 8 D-day deliverables landed on main (D35-D42)
- [x] CI green on every D-day commit + on this release commit's head
- [x] Cold-audit round 7 (fresh-context opus full-pass) — PASS_WITH_MINOR, 0 P1/P2 findings
- [x] 16 of 17 pre-Phase-2 GitHub issues closed (#1-#15 and #17); #16 stays OPEN as v1.x tracker
- [x] Issue #16 status comment posted referencing ADR 0005 Amendment 8 design ratification
- [x] CHANGELOG "Unreleased" promoted to "## v0.1.1 — 2026-05-25" with D35-D42 entries
- [x] `package.json` bumped from 0.1.0 → 0.1.1
- [x] `docs/v1x-roadmap.md` created — 7 deferred items with anchors + start triggers
- [ ] Tag pushed (next step in this PR's lifecycle)
- [ ] `release.yml` triggered + GitHub Release created (auto on tag push; D37 phase_rolling_mode gate will pass because Unreleased is now sentinel-only)

### Known limitations carried to v1.x

Full list with code anchors + start triggers in [`docs/v1x-roadmap.md`](./docs/v1x-roadmap.md):
- Streaming-path singleflight (issue #16, ADR 0005 Amendment 8 design ratified)
- Multi-key auth (`lib/keys.mjs`)
- Soft-trigger reactivation (ADR 0004 Amendment 2)
- `/health` activeSpawns integration (ADR 0002 Amendment 6 forward note)
- Provider-level `cacheKeyFields` mask (ADR 0005 Amendment 7 forward note)
- Streaming-path SPAWN_FAILED salvage (bundled with #1 in v1.x)
- D40 AUTH_MISSING tuple test coverage (test polish)

## v0.1.0 — 2026-05-24

### Phase 1 Close — Multi-provider proxy core

**Overview.** Phase 1 delivers the OLP minimum-viable multi-provider proxy: OpenAI-compatible HTTP entry surface, plugin architecture for 3 Tier-D providers (Anthropic Claude / OpenAI Codex / Mistral Vibe), cache layer (D1 per-key isolation + D4 buffered-path singleflight + size cap + cacheable opt-out), fallback engine with first-chunk safety + spawn-timeout hard trigger + structured per-hop log observability, IR↔OpenAI translation honoring the Rule 2(b) no-invention constraint, and a 416-test suite covering all of it.

Released under `phase_rolling_mode` (CLAUDE.md release_kit overlay): 25 D-day commits accumulated on `main` between 2026-05-23 and 2026-05-24 before this version bump + tag.

**Provider posture.** Three Tier D plugins ship as **Candidate** (per ALIGNMENT.md § Provider Inventory) — runnable via `providers.enabled` config but not Enabled by default. Five additional Tier B/C plugin slots exist in `models-registry.json` as Speculative-Candidate / candidate stubs awaiting CLI authority pins. Zero Enabled providers at v0.1; transition to Enabled requires Phase audit + primary-source pin per ADR 0002.

### What landed (D10–D34 commit index)

The per-commit detail is in the git log; this index summarizes the deliverables.

**Phase 1 core hardening:**
- **D10** (`2cfd0b1`) — P1 round-3: providers.enabled config wiring + real SSE streaming on single-hop cache-miss + spawn-timeout hard trigger across all 3 plugins.

**Round-1 fold-in batch (cold audit caught 17 findings):**
- **D11** (`f659e29`) — ADR 0002 Amendment 1: `maxSpawnTimeMs` ratified into Provider contract hints.
- **D12** (`4b1a9c8`) — IR translator Rule 2(b) compliance: removed invented top-level `error` field on `chat.completion` shapes.
- **D13** (`f34b690`) — Per-hop `cache_control` bypass evaluation (was request-global).
- **D14** (`a7085d9`) — Defer `res.writeHead(200)` until first chunk; early-error returns 502 JSON instead of 200 empty SSE.
- **D15** (`8ae77c3`) — ADR 0005 Amendment 2: cache key includes `max_tokens` / `top_p` / `stop` / `tool_choice`.
- **D16** (`bafa6d1`) — ADR 0004 Amendment 1: SPAWN_FAILED-with-chunks salvage (don't discard partial responses).
- **D17** (`cb86807`) — Alias routing SPOT via `models-registry.json`; `getProviderForModel` canonicalizes.
- **D18** (`82ff007`) — `/v1/models` populated from registry; 5 standard X-OLP-* headers on error responses.
- **D19** (`ed82e65`) — Cleanup batch: finish_reason validator, dead alignment.yml KNOWN_PROVIDERS removal, unused imports.
- **D20** (`d85a2dc`) — Docs drift: README/AGENTS/ADR forward-references annotated `📋 Planned`.

**Round-2 fold-in batch (13 findings):**
- **D21** (`1466d3a`) — `validateProvider` enforces `maxSpawnTimeMs` contract field.
- **D22** (`e10b7d7`) — ADR 0004 Amendment 2: soft triggers deferred to v1.x.
- **D23** (`7ef5510`) — `hints.cacheable` opt-out + 10MB cache entry size cap (ADR 0002 Amendment 3, ADR 0005 Amendment 3).
- **D24** (`f8348ad`) — Spawn-timeout race fix: post-loop `if (spawnTimedOut) throw SPAWN_TIMEOUT` closes the rejectNext-null window across all 3 plugins.
- **D25** (`cd391b1`) — Round-2 P3 docs batch.

**Round-3 fold-in batch (13 findings):**
- **D26** (`a281d3e`) — Soft-trigger startup warning, stderr propagation on error-chunk SPAWN_FAILED (codex+mistral), anthropic D4-observation header, streaming truncation marker.
- **D27** (`c3ba751`) — IR validator response_format + tool_choice checks, ADR 0005 Amendment 4 (cache_control IR vs body), `/v1/models` alias surfacing.
- **D28** (`4a238c9`) — Per-hop log observability: `chain_id`, `trigger_type`, `ir_request_hash`, `next_provider` on all 8 fallback log events.
- **D29** (`de9f3ca`) — Suite 17 port-collision flake fix: 16 test sites switched to OS-assigned `listen(0)`.
- **D30** (`5119b42`) — README env vars correctness, `docs/openai-spec-pin.md` v0.1 baseline.
- **D31** (`d6347e3`) — ADR amendment trio: F5 (ADR 0003 Amendment 1 substitute test strategy), F11 (ADR 0005 Amendment 5 Anthropic wire limitation), F13+F14 (ALIGNMENT.md Speculative-Candidate exception class).

**Round-4 fold-in batch (10 findings):**
- **D32** (`30de965`) — Provider auth env vars in README, X-OLP-* on early-return paths, ADR 0002 Amendment 4 ratifying `contractVersion`, dead OUTPUT_PARSE_ERROR removal, codex parser inline assumption labels.

**Round-5 fold-in batch (12 findings):**
- **D33** (`f784fdb`) — ALIGNMENT mistral `--output streaming` pin correction, deterministic `function_call` ID (cache key stability), `/health` per-provider snapshot, fallback-hop cache-hit X-OLP-Cache correctness, `CLAUDE.md` `phase_rolling_mode` policy formalization, `/v1/models` stable `created` timestamps.

**Round-6 final batch (14 findings; 4 closed, 9 filed as issues):**
- **D34** (`60570ef`) — ADR 0005 Amendment 6 (streaming singleflight v1.x deferral), array-field cache key normalization (`tools:[]` / `stop:[]` now collide with omitted), QUOTA_EXHAUSTED + RATE_LIMITED dead code removal (ADR 0004 Amendment 3), ADR 0005 Amendment 7 (conservative cache-key v0.1 trade-off).

### ADRs in scope

- **ADR 0001** — Project founding (Phase 1 founding doc; no amendments)
- **ADR 0002** — Plugin architecture (4 amendments — `maxSpawnTimeMs`, `cacheable`, `contractVersion` ratifications)
- **ADR 0003** — IR design (1 amendment — `__irRoundTripTest` removal + substitute test strategy)
- **ADR 0004** — Fallback engine (3 amendments — SPAWN_FAILED salvage, soft trigger deferral, hard-trigger taxonomy narrowing)
- **ADR 0005** — Cache layer (7 amendments — cache key expansions, cache_control IR-vs-body, cacheable + size cap, Anthropic wire limitation, streaming singleflight deferral, conservative cache-key v0.1 trade-off)
- **ADR 0006** — Provider inclusion (Tier framework; no amendments)
- **ALIGNMENT.md** — Speculative-Candidate plugin Rule 4 exception class added (D31)
- **CLAUDE.md** — `phase_rolling_mode` overlay added (D33)
- **`docs/openai-spec-pin.md`** — v0.1 baseline pinned (D30)

### Test growth

277 (pre-D10) → 416 (post-D34). 6 cold audit rounds reviewed code against ADR claims. Iron Rule v1.6 § 10.x dual-mode review discipline (Diff Review + Cold Audit) caught 78+ findings of which ~50 closed via implementation and ~28 deferred to GitHub issues.

### Known limitations carried to v1.x

17 GitHub issues filed for follow-up. Notably:
- **Streaming singleflight** (#16) — multi-concurrent identical streaming requests each spawn fresh CLI; buffered path participates in D4, streaming path doesn't (deferred via ADR 0005 Amendment 6).
- **maxConcurrent runtime enforcement** (#1) — declarative-only at v0.1.
- **X-OLP-Fallback-Detail debug header** (#7) — documented in ADR 0004, never emitted.
- **Soft triggers** (per ADR 0004 Amendment 2) — evaluation code exists but `quotaStatus()` polling not wired; configured thresholds inert at v0.1.

### Migration from OCP

OLP supersedes OCP per ADR 0001. The `scripts/migrate-from-ocp.mjs` migration tool is 📋 Planned (Phase 7).

## v0.1.0-bootstrap — 2026-05-23

### Phase 0 — Repo bootstrap (founding + post-codex-review hardening)

This is the founding commit set of OLP (Open LLM Proxy), a personal- and family-scale multi-provider LLM proxy that supersedes OCP. The trigger was Anthropic's 2026-05-14 announcement (effective 2026-06-15) splitting `claude -p` / Agent SDK / third-party agent traffic out of the Pro/Max subscription pool into a separate fixed monthly Agent SDK Credit pool.

**What lands at v0.1.0-bootstrap (final state on `main` as of 2026-05-23):**

- `ALIGNMENT.md` — OLP constitution. Three concurrent authorities (per-provider CLI / OpenAI spec / IR contract), 5 Rules, 4-tier Risk Tier Framework, Candidate-vs-Enabled provider inventory, one-shot triggered audits (2026-06-16 Anthropic post-split; 90-day Antigravity primary-source pin).
- `AGENTS.md` — multi-tool agent guidelines (inherits `~/.cc-rules/AGENTS.md`).
- `CLAUDE.md` — Claude-Code-specific session instructions + machine-readable `release_kit` overlay (Iron Rule 5.5).
- `README.md` — phase-aware skeleton with Candidate-vs-Enabled provider tables, API endpoint table, environment-variables table, response-headers spec, architecture overview, phase plan, migration-from-OCP outline. Placeholder content marked as such per phase.
- `docs/adr/` — 6 founding ADRs:
  - `0001-project-founding.md` — Mission, non-mission, narrow-scope supersession of OCP ADR 0005 (single-provider-sufficiency premise only; BYOK / no-spawn parts of ADR 0005 not inherited).
  - `0002-plugin-architecture.md` — `lib/providers/<name>.mjs` plug-in model with the Provider contract (name / models / auth / spawn / estimateCost / quotaStatus / healthCheck / hints). 8 candidate providers declared, 0 Enabled at v0.1.
  - `0003-intermediate-representation.md` — OLP-internal canonical IR between OpenAI-compat entry and provider plugins.
  - `0004-fallback-engine.md` — Trigger taxonomy (Hard / Soft / Deterministic-deferred / Cost-aware-deferred), idempotent-failure safety (first-chunk rule), chain advancement one-at-a-time, observability headers.
  - `0005-cache-cross-provider.md` — Cache key composition over `(provider, model, messages, ...)`, D1+D2+D3+D4 port from OCP v3.13.0.
  - `0006-provider-inclusion.md` — 4-tier Risk Framework, Candidate-vs-Enabled distinction, 8-provider candidate classification, Antigravity Tier A (evidence-backed, pending primary-source pin) — exclusion rests on (named prohibition + no cost advantage + reinstatement friction) combination; primary-source URL not yet pinned, follow-up tracked.
- `.github/PULL_REQUEST_TEMPLATE.md` — 8-radio Change Type taxonomy + per-type Authority Evidence sections + Iron Rule 10 reviewer checklist.
- `.github/workflows/alignment.yml` — CI blacklist (transitive `api.anthropic.com/api/oauth/usage` from OCP 2026-04-11 drift; Antigravity provider exclusion enforcement) + `models-registry.json` validator + commit-citation soft check (process-substitution form, no Bash subshell trap).
- `.github/workflows/release.yml` — Auto-release on tag push with `package.json`-vs-tag version match check (Iron Rule 5).
- `.github/workflows/test.yml` — Node 20/24 matrix; tolerates bootstrap-phase absence of `test-features.mjs` AND `scripts.test`.
- `models-registry.json` — minimal v0.1 stub with empty `providers: {}`, matching the 0-Enabled posture; populated by Phase audits as providers transition Candidate → Enabled.
- `package.json` — minimal: no `main`, no `scripts.test`, no `scripts.start` (those entries land alongside the real files in Phase 1).
- `.gitignore`, `LICENSE` (MIT), `CHANGELOG.md` — standard project boilerplate.

**Provider posture at v0.1.0-bootstrap (per ALIGNMENT.md § Provider Inventory):**

| Tier | Anticipated providers | v0.1 default state |
|---|---|---|
| D (eligible-for-default-enabled) | Anthropic, OpenAI Codex, Mistral Vibe | Candidate (transition gate: authority pin + plugin + Phase audit) |
| C (opt-in) | xAI Grok, Moonshot Kimi | Candidate |
| B (opt-in + consent) | MiniMax, Zhipu GLM, Alibaba Qwen | Candidate |
| A (excluded by default; constitutional-amendment-only re-inclusion) | Google Antigravity | Excluded; pending primary-source pin |

**Total Enabled at v0.1.0-bootstrap: 0.** Enablement is a Phase audit deliverable, not a bootstrap claim. This explicit zero is intentional and codified — a constitution that names providers as "default-enabled" while their CLI versions, output shapes, auth artifacts, and exit-code semantics are still TBD would violate Rules 1 (Cite First) and 3 (Match the Implementation).

**Review history for this version:**

1. **Initial internal review (Claude Opus, fresh-context, Iron Rule 10).** Verdict: APPROVE_WITH_MINOR — 2 minor items (alignment.yml heredoc indent breaking bash parse on failure path; AGENTS.md cross-reference to ADR 0003 imprecise). Both folded in before the founding commit.

2. **External review #1 (OpenAI Codex CLI, no spec framing).** Verdict: 6 substantive findings beyond internal review.
   - Provider Inventory split into Candidate vs Enabled (the v0.1 constitution had declared `anthropic` / `openai` / `mistral` as Tier D default-enabled while their Authority pins were still `TBD at Phase N spawn` — direct violation of Rule 1 / Rule 3 against the constitution's own text).
   - Antigravity Tier A downgraded to "evidence-backed, pending primary-source pin" (secondary reports disagree on blast radius; Google FAQ URL not yet primary-source-pinned).
   - ADR 0001 supersession scope narrowed (OLP rejects ADR 0005's "BYOK + no spawn" qualifiers, which originally applied to a commercial pivot; OLP is non-commercial and spawn-binary by design).
   - Anthropic post-2026-06-15 one-shot audit scheduled (annual May 14 audit would leave Anthropic re-eval ~year late after the split takes effect).
   - Tier A "permanent" language unified across docs (constitution and ADR 0006 had disagreed).
   - OpenAI Tier D wording softened ("maintainer signal indicates low risk; formal ToS pin pending" — Discussion #8338 is a posture statement, not a formal ToS blessing).

3. **External review #2 (OpenAI Codex CLI, second pass after review #1 fold-in).** Verdict: 6 additional substantive findings — the self-consistency trap recurred when fold-in of review #1 was scoped only to files codex explicitly named. Round #2 caught:
   - ADR 0002 still claimed "three default-enabled" while ALIGNMENT.md said zero Enabled — accepted ADR contradicting constitution.
   - `release.yml` would publish stale `## v0.1.0-bootstrap` notes that ignored the "Unreleased" amendments — fixed by consolidating amendments into the v0.1.0-bootstrap section (this entry).
   - `package.json` advertised `main` / `scripts.test` / `scripts.start` for files that don't exist — `npm test` / `npm start` failed locally. Removed all three; will return in Phase 1 alongside the real files.
   - `models-registry.json` documented as SPOT but missing — minimal stub added.
   - `alignment.yml` commit-citation soft check had a Bash subshell trap (`while` in pipe loses `WARN=1` mutation) — fixed via process substitution `< <(...)`.
   - Tier A "permanent" wording still inconsistent across `alignment.yml` workflow text, ADR 0006 Consequences section, and the rest of the docs — unified throughout.

   All 6 round-#2 findings folded in this consolidated v0.1.0-bootstrap state.

**Reviewer framing learning (recorded permanently in `~/.cc-rules/memory/learnings/ai_reviewer_self_consistency_trap.md`):** Internal AI reviewers framed on a shared source-of-truth miss bugs in the source-of-truth itself. The self-consistency trap recurred during the fold-in of round #1 — when an external reviewer surfaces findings, the fold-in must grep the entire repo for the same concept, not only edit the files the reviewer named. Round #2 caught what round #1's fold-in missed for exactly this reason. Both lessons updated in the cross-machine memory.

**Iron Rule 10 status:** Satisfied. Initial reviewer = internal opus (independent from drafters). Round #1 reviewer = external codex (independent from drafters and from internal opus). Round #2 reviewer = external codex (independent from the round #1 fold-in implementer). The maintainer's role across all three reviews was approver, not author. The drafting agents and fold-in agents were never the same as the reviewers for any of the three passes.

**Next:** Phase 1 lands `server.mjs` skeleton + IR + Anthropic provider plugin + cache D1+D4 port from OCP. At that point, `package.json` regains `main` + `scripts.test` + `scripts.start`, `test-features.mjs` lands, `models-registry.json` populates its first `providers.anthropic` entry, and Anthropic transitions Candidate → Enabled. Per spec §6 phase plan.

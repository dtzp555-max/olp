# OLP — Open LLM Proxy

A personal- and family-scale multi-provider LLM proxy. One HTTP endpoint, many subscriptions behind it, automatic routing, automatic fallback, content-addressed caching — so your IDEs and family clients keep working as long as *any* of your subscriptions has quota left.

> **Status:** v0.1 — bootstrap. Most of this README is a skeleton; sections marked _placeholder_ land alongside the relevant phase of work (see [phase plan](#phase-plan)).

---

## Why OLP

On 2026-05-14, Anthropic announced (effective 2026-06-15) that `claude -p`, the Agent SDK, and third-party agent traffic move out of the Pro/Max subscription pool into a separate fixed monthly Agent SDK Credit pool. [OCP](https://github.com/dtzp555-max/ocp), OLP's predecessor, was a proxy around a single CLI — its core assumption was *"subscription = unlimited within rate limits"*. That assumption breaks for Anthropic on the effective date.

The structural response is to stop relying on one provider's subscription terms remaining favourable. OLP spreads risk across multiple providers whose subscriptions still include CLI/programmatic use, routes intelligently between them, and caches aggressively so every request that does spawn a CLI counts.

OLP is **not**: a commercial multi-tenant SaaS; an enterprise gateway competing with LiteLLM / OpenCode / CLIProxyAPI on breadth; a model-capability router ("route to the smartest model" — you pick the model); a conversation-state store (your client handles that).

See [`ALIGNMENT.md`](./ALIGNMENT.md) for OLP's constitution and [`docs/adr/`](./docs/adr/) for the founding ADRs.

---

## Quick Start

_placeholder — lands with Phase 1._

Anticipated shape:

```bash
# install
npm install -g @dtzp555-max/olp

# run setup (writes ~/.olp/config.json, asks which providers to enable)
olp setup

# start the proxy (default port 3456 — same as OCP if you migrate)
olp start

# point your IDE at http://localhost:3456/v1/chat/completions with the OLP API key from `olp keys list`.
```

---

## Supported Providers

Source of truth: [`models-registry.json`](./models-registry.json). This table is regenerated from the registry per the [`release_kit`](./CLAUDE.md) overlay; do not edit it out of sync.

OLP distinguishes **Candidate Providers** (declared as intended, not yet pinned) from **Enabled Providers** (authority pin filled + plugin landed + Phase audit passed). The v0.1 founding commit ships **zero Enabled Providers** — enablement is a Phase audit deliverable, not a bootstrap claim. See [`ALIGNMENT.md` § Provider Inventory](./ALIGNMENT.md) for the transition gate.

### Candidate Providers

| Provider key | CLI | Subscription / auth | Anticipated Tier | Anticipated Phase |
|---|---|---|---|---|
| `anthropic` | `claude -p` | Pro / Max OAuth (pre-2026-06-15); Agent SDK Credit pool after | D (re-eval post-2026-06-15) | Phase 1 |
| `openai` | `codex exec --json` | ChatGPT Pro OAuth or API key | D | Phase 2 |
| `mistral` | `vibe --prompt --output json` | Le Chat Pro API key | D | Phase 3 |
| `grok` | `grok -p --output-format streaming-json` | xAI Build `xai-...` API key | C | Phase 8+ |
| `kimi` | `kimi -p --output-format stream-json` | Moonshot Kimi API key | C | Phase 8+ |
| `minimax` | TBD | MiniMax Token Plan (¥29+/mo) | B | Phase 8+ |
| `glm` | TBD | Zhipu Coding Plan ($10+/mo) | B | Phase 8+ |
| `qwen` | TBD | Alibaba Coding Plan ($50/mo) | B | Phase 8+ |

**Risk tier guide.** D = permissive / safe (eligible for default-enabled); C = tightening signal, no enforcement history (opt-in); B = service-level key revocation risk (opt-in + consent); A = excluded by default (cannot be opt-in enabled). Tier B providers prompt for explicit consent on first enable and record consent in `~/.olp/config.json`. See [`ALIGNMENT.md` § Risk Tier Framework](./ALIGNMENT.md#risk-tier-framework).

**Excluded by default (Tier A — evidence-backed, pending primary-source pin).** Google Antigravity. See [ADR 0006](./docs/adr/0006-provider-inclusion.md) for the named-prohibition + no-cost-advantage + reinstatement-friction rationale, and for the primary-source pinning follow-up that may force a Tier reconsideration if the Google FAQ language cannot be sourced within 90 days of 2026-05-23.

---

## Configuration

_placeholder — full configuration reference lands with Phase 4 (fallback engine)._

OLP reads its config from `~/.olp/config.json`. The minimum useful shape:

```json
{
  "routing": {
    "chains": {
      "<requested-model>": [
        { "provider": "<key>", "model": "<provider-model-id>" },
        { "provider": "<key>", "model": "<provider-model-id>" }
      ]
    },
    "soft_triggers": {
      "<provider-key>": { "<trigger>": <threshold> }
    }
  }
}
```

> **Note:** `routing.soft_triggers` thresholds are parsed and stored but have **no runtime effect at v0.1** — the quota polling path (`quotaStatus()` per hop) is deferred to v1.x per [ADR 0004 Amendment 2](./docs/adr/0004-fallback-engine.md#amendment-2--2026-05-24-soft-triggers-deferred-to-v1x-d22). The evaluation logic exists and is tested; only the production data ingestion path is deferred.

Trigger types, fallback safety, idempotency rules, and the full example config land here when Phase 4 ships. See [ADR 0004 (Fallback Engine Semantics & Safety)](./docs/adr/0004-fallback-engine.md) for the design.

---

## API Endpoints

_placeholder — full table lands as each endpoint lands._

| Endpoint | Method | Phase | Status | Description |
|---|---|---|---|---|
| `/v1/chat/completions` | POST | 1 | ✅ Shipped | OpenAI-compatible Chat Completions entry. Internally normalized to IR, dispatched to a provider plugin, response shape converted back. |
| `/v1/models` | GET | 1 | ✅ Shipped | Lists models from `models-registry.json`. |
| `/health` | GET | 1 | ✅ Shipped | Per-provider health snapshot (owner-only). |
| `/cache/stats` | GET | 5 | 📋 Planned | Cache hit rate, by-provider breakdown. |
| `/v0/management/quota` | GET | 6 | 📋 Planned | Per-provider quota / credit pool status (best-effort). |
| `/dashboard` | GET | 6 | 📋 Planned | Owner-only dashboard (localhost-bound by default). |

---

## Environment Variables

_placeholder — full table lands per-phase as variables are introduced._

| Variable | Default | Description |
|---|---|---|
| `OLP_PORT` | `3456` | HTTP listener port. |
| `OLP_CLAUDE_BIN` | `claude` (from PATH) | Override path to the `claude` binary (Anthropic provider). Useful when multiple `claude` installs are present. |
| `OLP_CODEX_BIN` | `codex` (from PATH) | Override path to the `codex` binary (OpenAI provider). |
| `OLP_VIBE_BIN` | `vibe` (from PATH) | Override path to the `vibe` binary (Mistral provider). |

### Per-provider auth env vars

These variables configure credential discovery for each provider plugin. Setting the correct one for your provider is usually required for OLP to make successful requests.

**Anthropic (`claude -p`)**

| Variable | Default behavior | Description |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Searches `~/.claude/.credentials.json` first, then macOS keychain (darwin only) | Directly supplies the OAuth access token. Highest-precedence override; bypasses all credential-discovery logic. Useful in CI/headless environments where the keychain is unavailable. |

**OpenAI Codex (`codex exec --json`)**

| Variable | Default behavior | Description |
|---|---|---|
| `OPENAI_CODEX_AUTH_PATH` | `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`) | Overrides the full path to the Codex auth artifact. When set, no other path is tried; missing or malformed file returns null (no auth). Useful for CI test fixtures. |
| `CODEX_HOME` | `~/.codex` | Overrides the Codex home directory. `$CODEX_HOME/auth.json` becomes the default auth path. Ignored when `OPENAI_CODEX_AUTH_PATH` is set explicitly. |

**Mistral Vibe (`vibe --prompt`)**

| Variable | Default behavior | Description |
|---|---|---|
| `MISTRAL_API_KEY` | Reads `$VIBE_HOME/.env` (default `~/.vibe/.env`) | Directly supplies the Mistral API key. Highest-precedence override per DOCS-2; bypasses `.env` file lookup. |
| `MISTRAL_VIBE_AUTH_PATH` | `~/.vibe/.env` (or `$VIBE_HOME/.env`) | Overrides the full path to the Vibe `.env` auth file. Evaluated only when `MISTRAL_API_KEY` is not set. When set, no other path is tried; missing or malformed file returns null (no auth). |
| `VIBE_HOME` | `~/.vibe` | Overrides the Vibe home directory. `$VIBE_HOME/.env` becomes the default auth path. Ignored when `MISTRAL_API_KEY` or `MISTRAL_VIBE_AUTH_PATH` is set explicitly. |

> **📋 Planned (Phase 2) — not yet read by the codebase:**
> - `OLP_HOME` (`~/.olp`) — Config, providers, keys, cache, logs root. Currently hardcoded to `~/.olp/config.json` in `loadFallbackConfigSync`; the env override path is a Phase 2 config-layer deliverable.
> - `OLP_LOG_LEVEL` (`info`) — Log level filter (`error`/`warn`/`info`/`debug`). `logEvent` currently writes unconditionally; level filtering is a Phase 2 observability deliverable.

See also the [Implementation status](#implementation-status-as-of-2026-05-24) table.

---

## Response Headers

Every response served through OLP carries:

- `X-OLP-Provider-Used: <provider-key>` — which provider's plugin served the request.
- `X-OLP-Model-Used: <model-id>` — which model the served provider used.
- `X-OLP-Fallback-Hops: <n>` — number of fallback hops (`0` if served by the primary chain entry).
- `X-OLP-Cache: hit | miss | bypass` — cache layer outcome.
- `X-OLP-Latency-Ms: <ms>` — end-to-end latency observed at the proxy.

If a fallback chain is exhausted, `X-OLP-Fallback-Exhausted` lists the tried providers in order.

---

## Implementation status (as of 2026-05-24)

Phase 1 is in progress. This table reflects what is currently shipped vs. what is designed for later phases.

| File / artifact | Status | Notes |
|---|---|---|
| `server.mjs` | ✅ Shipped | HTTP listener + dispatcher |
| `lib/ir/` | ✅ Shipped | IR definition + serializers (ADR 0003) |
| `lib/providers/anthropic.mjs` | ✅ Shipped | `claude -p` spawn-binary plugin |
| `lib/providers/codex.mjs` | ✅ Shipped | `codex exec --json` plugin |
| `lib/providers/mistral.mjs` | ✅ Shipped | `vibe --prompt` plugin |
| `lib/cache/keys.mjs` | ✅ Shipped | Content-addressed key computation |
| `lib/cache/store.mjs` | ✅ Shipped | In-memory Map (file-backed layout: 📋 Phase 2 storage adapter) |
| `lib/fallback/engine.mjs` | ✅ Shipped | Trigger evaluation + chain advancement (ADR 0004) |
| Soft trigger data path (`quotaStatus()` polling) | 📋 Planned (v1.x) | Evaluation logic shipped + tested; data ingestion deferred per ADR 0004 Amendment 2 |
| `models-registry.json` | ✅ Shipped | SPOT for `(provider, model)` metadata |
| `test-features.mjs` | ✅ Shipped | Comprehensive test suite covering IR, cache, fallback, and integration paths (CI: `test.yml`) |
| `lib/keys.mjs` | 📋 Planned (Phase 2) | Multi-key auth, per-key namespacing, audit log |
| `dashboard.html` | 📋 Planned (Phase 6) | Owner-only multi-provider dashboard |
| `docs/provider-caveats.md` | 📋 Planned (Phase 3+) | Lossy-translation reference; for now documented inline in each plugin header |
| `docs/openai-spec-pin.md` | ✅ Shipped (D30) | OpenAI spec snapshot for annual audit; v0.1 baseline pinned 2026-05-24 |
| `docs/alignment-audits/` | 📋 Planned | Output directory for annual alignment audits (first audit: 2027-05-14) |
| `scripts/migrate-from-ocp.mjs` | 📋 Planned (Phase 7) | OCP → OLP migration tool |
| `setup.mjs` | 📋 Planned | Setup wizard / initial config |

---

## Architecture

OLP is a Node.js (ESM, `.mjs`) HTTP proxy with no build step and minimal dependencies. The high-level shape:

- **Entry surface** — `server.mjs` handles `/v1/chat/completions` and the administrative endpoints. Governed by OpenAI's `/v1/chat/completions` specification as the wire authority. See [`ALIGNMENT.md` § Authorities](./ALIGNMENT.md#authorities).
- **Intermediate Representation (IR)** — `lib/ir/` normalizes between the entry surface and provider-native shapes. The IR is the lingua franca; any extension is an [ADR 0003](./docs/adr/0003-intermediate-representation.md) amendment.
- **Provider plugins** — `lib/providers/<name>.mjs`. Each plugin implements the contract in [ADR 0002 (Plugin Architecture for Providers)](./docs/adr/0002-plugin-architecture.md), spawns its CLI, and translates between IR and provider-native IO.
- **Cache layer** — `lib/cache/` is a content-addressed cache keyed on the 11-field tuple defined in [ADR 0005 § "Cache key composition (v1.0)"](./docs/adr/0005-cache-cross-provider.md#decision) (provider, model, messages, tools, temperature, response_format, cache_control, max_tokens, top_p, stop, tool_choice — as of Amendment 2/D15). Per-key isolation, prompt-caching bypass, chunked stream replay, and singleflight. See [ADR 0005 (Cache Layer Cross-Provider Design)](./docs/adr/0005-cache-cross-provider.md). Current backing store is an in-memory Map; file-backed storage is planned for Phase 2.
- **Fallback engine** — `lib/fallback/` advances a configured chain one provider at a time on configured triggers, never retrying after the first response chunk has been emitted to the client. See [ADR 0004](./docs/adr/0004-fallback-engine.md).
- **Multi-key auth** — `lib/keys.mjs` (📋 planned, Phase 2) will carry OCP's per-OLP-key namespace isolation forward. Each OLP API key will have independent quota, cache namespace, and audit log; each key declares which providers it can access.

Read the ADRs in `docs/adr/` in order before proposing structural changes.

---

## Phase plan

OLP lands in phases. Each phase has its own PR series and Iron-Rule-10 reviewer; this README's placeholders are filled per-phase via the [`release_kit`](./CLAUDE.md) overlay.

- Phase 0 — Repo bootstrap, `ALIGNMENT.md`, founding ADRs, CI workflows, PR template. **(current)**
- Phase 1 — `server.mjs` skeleton, IR, Anthropic plugin, cache D1+D4. Port from OCP.
- Phase 2 — OpenAI Codex plugin.
- Phase 3 — Mistral Vibe plugin.
- Phase 4 — Fallback engine + routing chains config + quota poll worker.
- Phase 5 — Cache cross-provider hardening (D2+D3).
- Phase 6 — Dashboard + observability (`/v0/management/quota`).
- Phase 7 — Release v0.1, OCP enters maintenance.
- Phase 8+ — Optional Grok / Kimi / tier-2 plugins; provider-native protocol endpoints; deterministic triggers.

Full spec (decision rationale, open questions, risks): `~/.cc-rules/memory/projects/olp_v0_1_spec.md` on the maintainer's workstations.

---

## Migration from OCP

_placeholder — `scripts/migrate-from-ocp.mjs` lands with Phase 7 (📋 planned, not yet authored)._

Anticipated user-facing flow (target: <5 minutes):

1. Stop OCP (`launchctl bootout` the OCP service or `ocp stop`).
2. Install OLP.
3. Run `olp migrate-from-ocp` — copies `~/.ocp/keys/` to `~/.olp/keys/` and points provider plugins at OCP's existing auth artifacts where applicable.
4. Start OLP. Clients pointing at port 3456 keep working; their existing OLP API keys remain valid.

OCP's cache directory is *not* migrated: OLP's cache key format includes provider+model and warms cold naturally. OCP enters maintenance mode (stability fixes only) when OLP v0.1 ships; new development happens in OLP.

---

## License

MIT.

---

## Acknowledgements

OLP evolved from [OCP (Open Claude Proxy)](https://github.com/dtzp555-max/ocp). OCP's per-key isolation model, cache-layer design (D1–D4), dashboard, and alignment-constitution discipline are all carried forward. The structural generalization from single-CLI to multi-provider is what makes this a new project rather than an OCP minor version — see [`ALIGNMENT.md` § Reference: How OCP's `cli.js` discipline maps to OLP](./ALIGNMENT.md#reference-how-ocps-clijs-discipline-maps-to-olp).

Authors: project maintainer (with AI drafting assistance).

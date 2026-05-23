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

| Provider key | CLI | Subscription / auth | Risk Tier (per [ADR 0006](./docs/adr/0006-provider-inclusion.md)) | Default state |
|---|---|---|---|---|
| `anthropic` | `claude -p` | Pro / Max OAuth (pre-2026-06-15); Agent SDK Credit pool after | D (re-eval post-2026-06-15) | Enabled |
| `openai` | `codex exec --json` | ChatGPT Pro OAuth or API key | D | Enabled |
| `mistral` | `vibe --prompt --output json` | Le Chat Pro API key | D | Enabled |
| `grok` | `grok -p --output-format streaming-json` | xAI Build `xai-...` API key | C | Disabled (opt-in) |
| `kimi` | `kimi -p --output-format stream-json` | Moonshot Kimi API key | C | Disabled (opt-in) |
| `minimax` | TBD | MiniMax Token Plan (¥29+/mo) | B | Disabled (consent required) |
| `glm` | TBD | Zhipu Coding Plan ($10+/mo) | B | Disabled (consent required) |
| `qwen` | TBD | Alibaba Coding Plan ($50/mo) | B | Disabled (consent required) |

**Risk tier guide.** D = permissive / safe; C = tightening signal, no enforcement history; B = service-level key revocation risk, vendor may extend across that vendor's AI services; A = permanently excluded. Tier B providers prompt for explicit consent on first enable and record consent in `~/.olp/config.json`. See [`ALIGNMENT.md` § Risk Tier Framework](./ALIGNMENT.md#risk-tier-framework).

**Excluded permanently (Tier A).** Google Antigravity. See [ADR 0006](./docs/adr/0006-provider-inclusion.md) for the named-prohibition + no-cost-advantage + reinstatement-friction rationale.

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

Trigger types, fallback safety, idempotency rules, and the full example config land here when Phase 4 ships. See [ADR 0004 (Fallback Engine Semantics & Safety)](./docs/adr/0004-fallback-engine.md) for the design.

---

## API Endpoints

_placeholder — full table lands as each endpoint lands._

| Endpoint | Method | Phase | Description |
|---|---|---|---|
| `/v1/chat/completions` | POST | 1 | OpenAI-compatible Chat Completions entry. Internally normalized to IR, dispatched to a provider plugin, response shape converted back. |
| `/v1/models` | GET | 1 | Lists models from `models-registry.json`. |
| `/health` | GET | 1 | Per-provider health snapshot (owner-only). |
| `/cache/stats` | GET | 5 | Cache hit rate, by-provider breakdown. |
| `/v0/management/quota` | GET | 6 | Per-provider quota / credit pool status (best-effort). |
| `/dashboard` | GET | 6 | Owner-only dashboard (localhost-bound by default). |

---

## Environment Variables

_placeholder — full table lands per-phase as variables are introduced._

| Variable | Default | Description |
|---|---|---|
| `OLP_PORT` | `3456` | HTTP listener port. |
| `OLP_HOME` | `~/.olp` | Config, providers, keys, cache, logs root. |
| `OLP_LOG_LEVEL` | `info` | One of `error`, `warn`, `info`, `debug`. |

Further variables (per-provider auth path overrides, cache size limits, fallback-engine knobs) land with the relevant phase.

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

## Architecture

OLP is a Node.js (ESM, `.mjs`) HTTP proxy with no build step and minimal dependencies. The high-level shape:

- **Entry surface** — `server.mjs` handles `/v1/chat/completions` and the administrative endpoints. Governed by OpenAI's `/v1/chat/completions` specification as the wire authority. See [`ALIGNMENT.md` § Authorities](./ALIGNMENT.md#authorities).
- **Intermediate Representation (IR)** — `lib/ir/` normalizes between the entry surface and provider-native shapes. The IR is the lingua franca; any extension is an [ADR 0003](./docs/adr/0003-intermediate-representation.md) amendment.
- **Provider plugins** — `lib/providers/<name>.mjs`. Each plugin implements the contract in [ADR 0002 (Plugin Architecture for Providers)](./docs/adr/0002-plugin-architecture.md), spawns its CLI, and translates between IR and provider-native IO.
- **Cache layer** — `lib/cache/` is a content-addressed cache keyed on `(provider, model, messages, tools, temperature, response_format, cache_control)`. Per-key isolation, prompt-caching bypass, chunked stream replay, and singleflight. See [ADR 0005 (Cache Layer Cross-Provider Design)](./docs/adr/0005-cache-cross-provider.md).
- **Fallback engine** — `lib/fallback/` advances a configured chain one provider at a time on configured triggers, never retrying after the first response chunk has been emitted to the client. See [ADR 0004](./docs/adr/0004-fallback-engine.md).
- **Multi-key auth** — `lib/keys.mjs` carries OCP's per-OLP-key namespace isolation forward. Each OLP API key has independent quota, cache namespace, and audit log; each key declares which providers it can access.

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

_placeholder — `scripts/migrate-from-ocp.mjs` lands with Phase 7._

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

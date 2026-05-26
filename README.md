# OLP — Open LLM Proxy

A personal- and family-scale multi-provider LLM proxy. One HTTP endpoint, many subscriptions behind it, automatic routing + fallback + content-addressed caching. Your IDEs and family clients keep working as long as **any** of your subscriptions has quota left.

> **Status:** v0.4.3 shipped, 714+ tests. Phase 4 (Operator + Client UX) closed; Phase 5 scope is open. Coming from [OCP](https://github.com/dtzp555-max/ocp)? See [§ Migration from OCP](#migration-from-ocp).

---

## What you get

- **OpenAI-compatible** `/v1/chat/completions` endpoint — any IDE that speaks OpenAI (Cline / Continue.dev / Cursor / Aider) plugs in
- **Multi-provider chain** — primary fails / quota dies → automatically falls back to the next provider (anthropic ↔ codex ↔ mistral by default; risk-tier framework guards which ones get enabled)
- **Content-addressed cache** — repeat requests don't re-spawn the CLI; streaming requests dedup via singleflight tee
- **Multi-key auth** — owner key with full visibility, family-member keys with per-key audit log + per-provider scoping
- **Telegram / Discord** `/olp` slash commands (read-only — for "is OLP up?" checks from anywhere)
- **AI-driven self-repair** — `olp doctor --json` emits machine-readable `next_action.ai_executable[]` so a Claude Code / Cursor / Copilot session can fix install issues for you (see [§ Install with your AI](#install-with-your-ai-the-fast-path))
- **Observability** — owner-only `/dashboard` (quota / 24h stats / 30d spend trend / top fallback chains)

---

## Install with your AI (the fast path)

If the manual steps feel like a lot, paste this verbatim into your AI coding assistant (Claude Code / Cursor / Copilot / Aider). It walks you through everything:

```
I want to install OLP (Open LLM Proxy) on this machine. The repo is at
https://github.com/dtzp555-max/olp and ships these tools that you can use:

1. `git clone` the repo to ~/olp
2. README.md § "Manual install" has the sequenced steps. Follow them in order.
3. After EACH step, run `node ~/olp/bin/olp.mjs doctor --json` (NOT `npx olp`
   — the package isn't on npm). Parse the JSON. The `kind` field tells you
   the state: noop / fresh_install / fix_server / fix_oauth / fix_provider /
   fix_config.
4. If `kind != noop`, run the commands listed in `next_action.ai_executable[]`
   verbatim. Then re-run doctor to verify.
5. STOP and ask me only when `next_action.human_required[]` is non-empty.
   That's where I need to do a browser OAuth flow you can't do for me.

The provider CLIs OLP spawns (claude / codex / vibe) need their own one-time
OAuth — those are the only steps I personally have to do (Claude.ai login,
ChatGPT login, Mistral API key). Everything else (clone, npm install of the
provider CLIs, owner-key generation, config.json bootstrap, server start) is
in your `ai_executable[]` and you should run it without asking.

Begin.
```

Then sit back and respond when it asks for OAuth confirmation. This pattern works because `olp doctor` is purpose-built for AI consumption — every failure mode has a shell-executable repair command AND a human-required step listed separately.

---

## Manual install (5-10 min)

### 0. Prerequisites

- **Node.js ≥ 18.** Verify: `node --version`
- **The provider CLIs you want OLP to spawn.** Install whichever you'll actually use:

  | Provider | Install | Subscription |
  |---|---|---|
  | `anthropic` (`claude -p`) | `npm install -g @anthropic-ai/claude-code` | Claude Pro/Max (OAuth) |
  | `openai` (`codex exec`) | `npm install -g @openai/codex` | ChatGPT Plus/Pro (OAuth) or OpenAI API key |
  | `mistral` (`vibe --prompt`) | follow the `vibe` install docs | Le Chat Pro API key |

  You only need to install the ones you'll route to. Single-provider OLP works fine.

### 1. Clone and verify the test suite

```bash
git clone https://github.com/dtzp555-max/olp.git ~/olp
cd ~/olp
npm test    # 714+ tests, ~5s, no external deps
```

(If `npm test` fails here, stop — that means your Node version or the repo state is broken. Don't proceed to step 2.)

### 2. Bootstrap the owner key

The owner key is what you (and `olp-connect`) use to authenticate to OLP. Default config has `auth.allow_anonymous: false`, so you need a key BEFORE the server starts accepting requests.

```bash
node ~/olp/bin/olp-keys.mjs keygen --owner --name=$(whoami)-laptop
# Prints the plaintext token ONCE. Copy it now — you can't recover it later.
# Example: olp_l23-PN46tDljmPATV94-KfOgOBO0Ed8theVjTdAgQoY
```

Export it so the CLI subcommands can use it:

```bash
export OLP_API_KEY=olp_l23-PN46...   # paste your real token
```

(Add to `~/.bashrc` / `~/.zshrc` to persist.)

### 3. Authenticate the providers (one-time OAuth)

Run each provider's own login flow. OLP's anthropic / openai / mistral plugins spawn these CLIs and reuse their cached credentials — OLP itself never touches the OAuth dance.

```bash
# Anthropic (Claude Pro/Max subscription)
claude setup-token
# Opens a TUI / prints a URL. Authorize in browser. Paste the returned code.
# Result: ~/.claude/.credentials.json

# OpenAI (ChatGPT subscription)
codex login --device-auth
# Prints a https://auth.openai.com/codex/device URL + 10-char code.
# Open URL in browser, enter code, authorize.
# Result: ~/.codex/auth.json

# Mistral (Le Chat API key)
export MISTRAL_API_KEY=sk-...   # add to ~/.bashrc to persist
```

### 4. Write a minimum config

`~/.olp/config.json`:

```json
{
  "auth": {
    "allow_anonymous": false,
    "owner_only_endpoints": [
      "/health",
      "/v0/management/dashboard-data",
      "/v0/management/quota",
      "/v0/management/status",
      "/cache/stats",
      "/dashboard"
    ],
    "fallback_detail_header_policy": "owner_only"
  },
  "providers": {
    "enabled": { "anthropic": true, "openai": true }
  },
  "routing": {
    "chains": {
      "claude-sonnet-4-6": [
        { "provider": "anthropic", "model": "claude-sonnet-4-6" },
        { "provider": "openai", "model": "gpt-5.5" }
      ],
      "gpt-5.5": [{ "provider": "openai", "model": "gpt-5.5" }]
    }
  },
  "streaming": { "heartbeat_interval_ms": 15000 }
}
```

(Enable only the providers you actually authenticated in step 3. Chains map `<your-IDE's-requested-model>` → ordered list of `{provider, model}` hops; the chain's per-hop `model` is what gets passed to that provider's CLI.)

### 5. Start the server

```bash
cd ~/olp
npm start
# OLP v0.4.3 listening on :4567 (2 providers enabled)
```

### 6. Smoke-test

```bash
curl -H "Authorization: Bearer $OLP_API_KEY" http://localhost:4567/health | jq
# Expect: {ok: true, providers: {enabled: 2, status: {anthropic: {ok: true...}, openai: {ok: true...}}}}

node ~/olp/bin/olp.mjs doctor
# Expect: "9 of 9 checks passed", kind=noop
```

### 7. Point your IDE at OLP

```
OPENAI_BASE_URL=http://localhost:4567/v1
OPENAI_API_KEY=$OLP_API_KEY
```

Per-IDE configuration details: [`docs/integrations/`](./docs/integrations/README.md).

---

## Family / LAN setup

To let other devices on your home network use the same OLP server, you need TWO things:

1. **Bind to the LAN interface** (not just loopback). On the SERVER:

   ```bash
   OLP_BIND=0.0.0.0 npm start   # or your specific LAN IP, e.g. 192.168.1.10
   ```

   Default is `127.0.0.1` (loopback only). See [ADR 0011 § Deployment configurations](./docs/adr/0011-anonymous-key-deployment-context.md#deployment-configurations-d76-amendment-2026-05-26) for the trust-context table — **never set `OLP_BIND=0.0.0.0` on a public-internet-facing host** (use a tunnel like Tailscale instead).

2. **Onboard each family member's device** from THEIR machine:

   ```bash
   bash <(curl -fsSL https://raw.githubusercontent.com/dtzp555-max/olp/main/bin/olp-connect) <olp-host-ip>
   ```

   Detects Cline / Continue.dev / Cursor / Aider / OpenClaw locally and writes per-tool config pointing at your OLP host. Requires `python3` on the client. Prompts for the OLP API key — OR, if the server has `auth.advertise_anonymous_key: true` AND a key was created with `olp-keys keygen --anonymous --advertise`, picks the token up from `/health.anonymousKey` (zero out-of-band paste). See [ADR 0011](./docs/adr/0011-anonymous-key-deployment-context.md) for the trusted-LAN-only invariant.

Per-IDE setup details: [`docs/integrations/`](./docs/integrations/README.md). Telegram / Discord `/olp` slash command setup: [§ Telegram / Discord Usage](#telegram--discord-usage).

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

OLP reads `~/.olp/config.json` at startup. § "[Manual install § Step 4](#4-write-a-minimum-config)" above has a working minimum example. The full schema:

```json
{
  "auth": {
    "allow_anonymous": false,
    "owner_only_endpoints": ["/health", "/dashboard", "/v0/management/..."],
    "advertise_anonymous_key": false,
    "fallback_detail_header_policy": "owner_only"
  },
  "providers": {
    "enabled": { "<provider-key>": true }
  },
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
  },
  "streaming": {
    "heartbeat_interval_ms": 0
  }
}
```

Field guide:

- **`auth.allow_anonymous`** — default `false`. When false, every request needs a Bearer token; when true, anonymous-tier requests succeed (ADR 0007 § 7). Production posture is `false`.
- **`auth.owner_only_endpoints`** — list of endpoints that REQUIRE owner-tier auth (non-owner returns 401). The defaults above are minimum sane for production.
- **`auth.advertise_anonymous_key`** — default `false`. When true (+ `allow_anonymous: true` + a key created with `olp-keys keygen --anonymous --advertise`), `/health.anonymousKey` exposes the plaintext token so `olp-connect <ip>` is zero-config. **Trusted-LAN only** — see [ADR 0011](./docs/adr/0011-anonymous-key-deployment-context.md).
- **`auth.fallback_detail_header_policy`** — controls `X-OLP-Fallback-Detail` response header emission. `owner_only` (default) only shows tuples to owner identity; debug surface to LAN family without leaking to anonymous.
- **`providers.enabled`** — flip a provider plugin on. Only enable providers whose CLI you've authenticated; OLP doesn't do its own OAuth.
- **`routing.chains`** — keyed by the model name your IDE / client requests. Each entry is an ordered list of fallback hops; each hop's `model` is what gets passed to that provider's CLI. F7 fix (D75) — the hop-level `model` field finally overrides the IR's request model during cross-provider fallback.
- **`routing.soft_triggers`** — parsed and stored but **inert at v0.4.x** — the `quotaStatus()` polling data path is deferred to v1.x per [ADR 0004 Amendment 2](./docs/adr/0004-fallback-engine.md#amendment-2--2026-05-24-soft-triggers-deferred-to-v1x-d22). Startup emits a warn if non-empty so the inert state is visible.
- **`streaming.heartbeat_interval_ms`** — default `0` (disabled). Set > 0 (e.g. `15000`) to emit SSE keepalive frames during silent windows. Required behind reverse proxies (nginx / Cloudflare Tunnel / Tailscale Funnel) with 60s idle aborts.

See [ADR 0004 (Fallback Engine)](./docs/adr/0004-fallback-engine.md), [ADR 0007 (Multi-key auth)](./docs/adr/0007-multi-key-auth.md), [ADR 0010 (Phase 4 charter)](./docs/adr/0010-phase-4-charter-operator-and-client-ux.md), [ADR 0011 (Anonymous-key deployment)](./docs/adr/0011-anonymous-key-deployment-context.md).

---

## API Endpoints

| Endpoint | Method | Phase | Status | Description |
|---|---|---|---|---|
| `/v1/chat/completions` | POST | 1 | ✅ Shipped | OpenAI-compatible Chat Completions entry. Internally normalized to IR, dispatched to a provider plugin, response shape converted back. |
| `/v1/models` | GET | 1 | ✅ Shipped | Lists models from `models-registry.json`. |
| `/health` | GET | 1 | ✅ Shipped | Per-provider health snapshot. Phase 2 owner-only-trim: full per-provider details to owner identity; trimmed `{ ok, version }` to guest / anonymous. Gate via `auth.owner_only_endpoints` config. **Optional `anonymousKey` field (D69 / Phase 4, v0.4.0)** appears in both trimmed and full payloads when `auth.advertise_anonymous_key: true` AND `auth.allow_anonymous: true` AND at least one non-revoked guest-tier key has `plaintext_advertise: true` (see [ADR 0011](./docs/adr/0011-anonymous-key-deployment-context.md) for the trusted-LAN-only invariant). Default off — field absent when prereqs unmet. |
| `/dashboard` | GET | 3 | ✅ Shipped (D50 + D51) | Owner-only multi-provider dashboard HTML (4 panels: quota / 24h request stats / 30d spend trend / top fallback chains; 30s poll with visibilitychange pause). Owner-only_block; non-owner identities receive 401. Localhost-bound by default. |
| `/v0/management/dashboard-data` | GET | 3 | ✅ Shipped (D50) | JSON aggregate consumed by the dashboard 30s poll: `{ generated_at, window_24h, cache_hit_24h, quota, spend_trend_30d, top_fallback_chains_24h, cache_stats }`. Owner-only_block. |
| `/v0/management/quota` | GET | 3 | ✅ Shipped (D50) | Per-provider quota snapshot via `provider.quotaStatus()` (subset of dashboard-data; useful for scripted monitoring). Owner-only_block. |
| `/cache/stats` | GET | 3 | ✅ Shipped (D50) | Live in-memory `cacheStore.stats()` (`{ hits, misses, size, inflightCount }` + `generated_at`). Owner-only_block. |

---

## Environment Variables

_placeholder — full table lands per-phase as variables are introduced._

| Variable | Default | Description |
|---|---|---|
| `OLP_PORT` | `4567` | HTTP listener port. Moved off `3456` at D60 / v0.4.0 to co-host with OCP — set `OLP_PORT=3456` to restore the pre-D60 default. |
| `OLP_BIND` | `127.0.0.1` | HTTP listener bind address. **Set to `0.0.0.0` or your LAN IP to accept LAN connections** (required for `olp-connect <ip>` to actually reach the server). Default loopback-only is the secure default. See [ADR 0011 § Deployment configurations](./docs/adr/0011-anonymous-key-deployment-context.md#deployment-configurations-d76-amendment-2026-05-26) for the trust-context table — never bind to a public-internet IP. |
| `OLP_API_KEY` | (none) | Owner-tier OLP API key (the `olp_...` plaintext from `olp-keys keygen --owner`) used by `olp` CLI subcommands as the bearer for management endpoints. |
| `OLP_OWNER_TOKEN` | (none) | Fallback used by `olp` CLI if `OLP_API_KEY` is absent. |
| `OLP_PROXY_URL` | `http://127.0.0.1:$OLP_PORT` | Override target URL for `olp` CLI subcommands (so the same binary works against a remote OLP via SSH tunnel or direct LAN). |
| `OLP_CLAUDE_BIN` | `claude` (from PATH) | Override path to the `claude` binary (Anthropic provider). Useful when multiple `claude` installs are present. |
| `OLP_CODEX_BIN` | `codex` (from PATH) | Override path to the `codex` binary (OpenAI provider). |
| `OLP_VIBE_BIN` | `vibe` (from PATH) | Override path to the `vibe` binary (Mistral provider). |

### `config.json` keys introduced at Phase 4

These live in `~/.olp/config.json` (not env vars) — they're documented here alongside the env-var table for discoverability.

| Config key | Default | Description |
|---|---|---|
| `streaming.heartbeat_interval_ms` | `0` (disabled) | D61 / Phase 4. SSE keepalive comment frames during stream-silent windows. Set `>0` (e.g. `15000` for 15s) when OLP runs behind nginx / Cloudflare / Tailscale Funnel with idle-abort timeouts. |
| `auth.advertise_anonymous_key` | `false` | D69 / Phase 4. When `true`, surfaces an existing guest-tier key's plaintext via `/health.anonymousKey` so `olp-connect <ip>` can self-bootstrap clients on the LAN with zero out-of-band coordination. **Requires `auth.allow_anonymous: true` AND at least one key created via `olp-keys keygen --anonymous --advertise`.** Trusted-LAN-only — see [ADR 0011](./docs/adr/0011-anonymous-key-deployment-context.md). |

### Operator CLI surfaces (Phase 4)

- `olp` (Node CLI at `bin/olp.mjs`): `status / health / usage / models / cache / providers / chain show / logs / restart / keys / doctor`. Run `npx olp --help` for full subcommand reference. `olp doctor --json` emits a machine-readable `next_action.ai_executable[]` payload designed for AI agents to self-repair OLP. See [ADR 0010](./docs/adr/0010-phase-4-charter-operator-and-client-ux.md) § Phase 4 D-day plan and [ADR 0002 Amendment 7](./docs/adr/0002-plugin-architecture.md) (per-plugin `doctorChecks()` contract).
- `olp-connect` (bash at `bin/olp-connect`): zero-config LAN client setup — detects Cline / Continue.dev / Cursor / Aider / Claude Code / OpenClaw and configures each. Run `bash bin/olp-connect --help`. Requires `python3` for JSON parsing.
- `olp-keys keygen --anonymous --advertise`: creates a guest-tier key with the plaintext stored alongside its hash so `/health.anonymousKey` can publish it. Prints an explicit ADR-0011 warning at keygen time.

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

- `X-OLP-Provider-Used: <provider-key>` — which provider's plugin served the request. On a chain-exhausted response, this identifies the chain's configured primary entry (`chain[0]`), not necessarily the first hop where `spawn()` was invoked — see ADR 0004 Amendment 6 for the v0.1 chain-origin semantics and the v1.x soft-trigger reactivation note.
- `X-OLP-Model-Used: <model-id>` — which model the served provider used.
- `X-OLP-Fallback-Hops: <n>` — number of fallback hops (`0` if served by the primary chain entry).
- `X-OLP-Cache: hit | miss | bypass` — cache layer outcome.
- `X-OLP-Latency-Ms: <ms>` — end-to-end latency observed at the proxy.

If a fallback chain is exhausted, `X-OLP-Fallback-Exhausted` lists the tried providers in order.

---

## IDE Setup

Per-tool setup pages live under [`docs/integrations/`](./docs/integrations/README.md). Index:

| Tool | Status | Notes |
|---|---|---|
| [Continue.dev](./docs/integrations/continue.md) | ✅ Supported | `config.yaml` `apiBase` (not `baseURL`); supports OLP custom headers |
| [Cline](./docs/integrations/cline.md) | ✅ Supported | "OpenAI Compatible" provider; watch Cline issue [#7128](https://github.com/cline/cline/issues/7128) |
| [Cursor](./docs/integrations/cursor.md) | ⚠️ Best-effort | "Override OpenAI Base URL" — known fragile across Cursor updates |
| [Aider](./docs/integrations/aider.md) | ✅ Supported | `OPENAI_API_BASE` env + `openai/` model prefix; no custom-header support |
| [Claude Code](./docs/integrations/claude-code.md) | ❌ Not supported | Anthropic wire format only; OLP serves OpenAI wire format. Use Cline + OLP instead |
| [OpenClaw](./docs/integrations/openclaw.md) | ✅ Supported | Telegram + Discord gateway via [`olp-plugin/`](./olp-plugin/) |

The fastest path is `olp-connect <olp-host-ip>` on the client device — it auto-detects what's installed and writes the per-tool config. See [Quick Start](#quick-start).

---

## Telegram / Discord Usage

OLP ships [`olp-plugin/`](./olp-plugin/) as a native OpenClaw gateway plugin. After install, family members get a read-only `/olp` slash command on whichever chat surfaces OpenClaw exposes (Telegram + Discord today).

**Install:**

```bash
# Option A — OpenClaw CLI
openclaw plugins install /path/to/olp/olp-plugin/

# Option B — symlink (equivalent)
mkdir -p ~/.openclaw/extensions/
ln -s /path/to/olp/olp-plugin/ ~/.openclaw/extensions/olp
```

**Configure:** edit `~/.openclaw/openclaw.json` and set the plugin's `apiKey` to an owner-tier OLP token created with:

```bash
npx olp-keys keygen --owner --name=openclaw-bot
```

Use a dedicated bot key — not the maintainer's personal owner key — so revocation is scoped.

```json
{
  "plugins": {
    "olp": {
      "proxyUrl": "http://127.0.0.1:4567",
      "apiKey": "olp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
    }
  }
}
```

**Restart:** `openclaw gateway restart`.

**Use:** `/olp status`, `/olp usage`, `/olp models`, `/olp health`, `/olp cache`, `/olp providers`, `/olp doctor`, `/olp help`.

**Read-only by design.** Mutating subcommands (`keygen`, `revoke`, `restart`, `logs`) are deliberately NOT exposed via chat — those are SSH-only via the local `olp` CLI. See [`olp-plugin/README.md`](./olp-plugin/README.md#what-you-can-not-do-from-chat-by-design) for the rationale.

---

## Implementation status (as of 2026-05-26, post-v0.4.0)

Phase 1 closed at v0.1.1 (multi-provider proxy core + pre-Phase-2 cleanup). Phase 2 closed at v0.2.0 (multi-key auth + audit + owner gating + keygen CLI; ADR 0007 § 10 all 11 acceptance criteria shipped). Phase 3 closed at v0.3.0 (Dashboard + `lib/audit-query.mjs` + daily audit rotation; ADR 0008 § 10 all 15 acceptance criteria shipped). Phase 4 closed at v0.4.0 (Operator + Client UX per ADR 0010: SSE heartbeat + `recentErrors[20]` + `/v0/management/status` / `olp` Node CLI + `olp doctor` framework + ADR 0002 Amendment 7 / `olp-connect` bash + `/health.anonymousKey` + ADR 0011 / `olp-plugin/` Telegram-Discord + 6-IDE integration docs). Phase 5 scope is open — candidates per ADR 0010 § Out-of-Phase-4-scope. This table reflects what is currently shipped vs. what is designed for later phases.

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
| `lib/keys.mjs` | ✅ Phase 2 shipped (D44 + D45 + D46) | Multi-key auth core (`createKey` / `validateKey` / `listKeys` / `revokeKey` / `touchLastUsed`) per ADR 0007 §§ 5/6.1/6.3/6.3.5/6.4/9.4 + `loadAuthConfigSync` for `auth.allow_anonymous` / `owner_only_endpoints` / `fallback_detail_header_policy`. Server wires `validateKey` per request, filters chain by `providers_enabled`, fires `touchLastUsed` post-response, trims `/health` payload for non-owner, gates `X-OLP-Fallback-Detail` emission by policy. |
| `bin/olp-keys.mjs` | ✅ Phase 2 shipped (D47) | Keygen CLI per ADR 0007 § 9.1. `npx olp-keys keygen --owner` generates an owner key + prints plaintext token once; `npx olp-keys list` enumerates keys (token_hash redacted); `npx olp-keys revoke --id=X` marks a key revoked. `--olp-home=<path>` overrides `~/.olp/`. |
| `lib/audit.mjs` | ✅ Phase 2 + 3 (D45 append + D52 rotation) | Append-only ndjson audit at `~/.olp/logs/audit.ndjson` per ADR 0007 § 6.2 + § 8. `appendAuditEvent` fires for every `/v1/*` + `/v0/management/*` request (success, 401, 403, 5xx). Warn + 1 retry on append failure; no memory buffer at Phase 2 (forward path). PII excluded. D52 adds synchronous daily rotation per ADR 0008 § 5 — first append after UTC midnight renames live → `audit-YYYY-MM-DD.ndjson`. |
| `lib/audit-query.mjs` | ✅ Phase 3 shipped (D49) | Audit ndjson aggregate query layer per ADR 0008 § 4. 5 functions: `discoverAuditFiles`, `readAuditWindow`, `aggregateRequests`, `topFallbackChains`, `spendTrendDaily`, `cacheHitRateWindow`. In-memory cross-file scan; PII guard at output. Consumed by `/v0/management/dashboard-data`. |
| `dashboard.html` | ✅ Phase 3 shipped (D50 stub + D51 full UI) | Owner-only multi-provider dashboard per ADR 0008 § 6. 4 panels (quota / 24h request stats / 30d SVG sparkline / top fallback chains). Vanilla HTML+JS+fetch (no build step). 30s page poll with `document.visibilityState` pause. Served by `/dashboard` route owner-only_block. |
| `bin/olp-audit-rotate.mjs` | ✅ Phase 3 shipped (D52) | External audit rotation cron tool per ADR 0008 § 5.2. `npx olp-audit-rotate [--olp-home=<path>]`. Idempotent + safe alongside the in-server first-append trigger. |
| `docs/provider-caveats.md` | 📋 Planned (Phase 3+) | Lossy-translation reference; for now documented inline in each plugin header |
| `docs/openai-spec-pin.md` | ✅ Shipped (D30) | OpenAI spec snapshot for annual audit; v0.1 baseline pinned 2026-05-24 |
| `docs/alignment-audits/` | 📋 Planned | Output directory for annual alignment audits (first audit: 2027-05-14) |
| `scripts/migrate-from-ocp.mjs` | 📋 Planned (Phase 7) | OCP → OLP migration tool |
| `setup.mjs` | 📋 Planned | Setup wizard / initial config |

### Known limitations

Behaviors that work correctly at personal/family scale but have ratified follow-ups for a v1.x sprint. Single landing page: [`docs/v1x-roadmap.md`](./docs/v1x-roadmap.md).

- **Streaming-path singleflight ✅ shipped (D57 + D58, 2026-05-25).** `cacheStore.getOrComputeStreaming(...)` mirrors the buffered-path `getOrCompute` and resolves the TOCTOU window between peek and spawn ([issue #16](https://github.com/dtzp555-max/olp/issues/16)). Two concurrent identical streaming requests share one CLI spawn via tee fan-out; late joiners receive accumulated replay + the live tail; per-client backpressure (`PER_CLIENT_QUEUE_CAP=1MB`) protects against slow consumers; full-disconnect aborts the source CLI via AbortController. New `X-OLP-Streaming-Inflight: source | attached` header annotates the role. New `cache_status: 'streaming_attached'` audit value tracks the singleflight win. Authority: [ADR 0005 Amendment 8](./docs/adr/0005-cache-cross-provider.md), v1.x roadmap #1.
- **Soft triggers configured but inert.** `routing.soft_triggers` in `~/.olp/config.json` is honored by the engine's evaluation logic but `quotaStatus()` polling is not wired (ADR 0004 Amendment 2). A startup warning fires if the field is non-empty so the inert state is visible.
- **Multi-key auth + owner gating + keygen CLI shipped at v0.2.0 (D44 + D45 + D46 + D47).** `lib/keys.mjs` (core), `lib/audit.mjs` (audit), owner-vs-guest `/health` payload trimming + `X-OLP-Fallback-Detail` policy gating, `bin/olp-keys.mjs` (keygen CLI). All 11 ADR 0007 § 10 acceptance criteria covered. v0.2.0 maintainer-merged 2026-05-25.

- **Phase 3 (Dashboard + audit query layer + rotation) shipped at v0.3.0 (D48–D54).** `docs/adr/0008-dashboard-and-audit-query.md` + `lib/audit-query.mjs` (D49) + 4 owner-only_block endpoints (D50) + `dashboard.html` (D51) + daily audit rotation (D52) + `tried_providers` schema fix (D53). All 15 ADR 0008 § 10 acceptance criteria covered.

- **Phase 4 (Operator + Client UX) shipped at v0.4.0 (D60 → D73).** ADR 0010 (charter) + ADR 0011 (anonymous-key trusted-LAN limits) + ADR 0002 Amendment 7 (provider `doctorChecks()` contract). Default `OLP_PORT` 3456 → 4567 so OLP and OCP can co-host. SSE heartbeat (D61) + `recentErrors[20]` + `/v0/management/status` (D62-D63). `bin/olp.mjs` Node CLI + `bin/olp-keys.mjs` + `lib/doctor.mjs` framework with `next_action.ai_executable[]` (D64-D67). `bin/olp-connect` bash zero-config IDE auto-config + opt-in `/health.anonymousKey` (D68-D70). `olp-plugin/` OpenClaw `/olp` Telegram-Discord plugin (read-only, no chat mutations) + 6 IDE integration docs at `docs/integrations/*.md` (D71-D73). Test count 623 → 696.

  **Bootstrap workflow (D47):** for first-run / production setup:

  ```bash
  # 1. Generate an owner key (prints the plaintext token ONCE — capture it now)
  npx olp-keys keygen --owner

  # 2. Set production config (defaults to allow_anonymous: false)
  # (Edit ~/.olp/config.json to enable providers + chains as usual)

  # 3. Start the server
  npm start

  # 4. Validate the key works (substitute the captured plaintext token)
  curl -H "Authorization: Bearer olp_..." http://localhost:4567/health
  ```

  **Recovery if owner token is lost:** `npx olp-keys keygen --owner --force` revokes the previous owner key + creates a fresh one (plaintext printed once).

  **New env vars consumed at D45:** `OLP_HOME` (override `~/.olp/` location, used by tests + operator deployments); `OLP_OWNER_TOKEN` (synthetic env-owner identity for headless / CI deployments — bypasses filesystem manifest lookup with stable `__env_owner__` keyId).

  **New config block consumed at D45:** `config.json auth.{ allow_anonymous, owner_only_endpoints, fallback_detail_header_policy }`. Default `allow_anonymous: false` (production-off); set true to accept requests without an OLP API key (development / single-user dev mode). Startup emits a warn when `allow_anonymous: true` so the relaxed posture is observable.
- **Provider-level `cacheKeyFields` mask not implemented.** Cache keys include every IR field including ones individual plugins drop at spawn (e.g., Anthropic plugin drops `temperature`). Spurious cache misses possible (extra spawn cost; never spurious hits). Conservative posture documented in [ADR 0005 Amendment 7](./docs/adr/0005-cache-cross-provider.md). Tracked in [v1.x roadmap #5](./docs/v1x-roadmap.md).

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

The original v0.1 spec (in `~/.cc-rules/memory/projects/olp_v0_1_spec.md` on the maintainer's workstations) planned one provider plugin per phase. The actual Phase 1 execution bundled the three Tier-D provider plugins + cache layer + fallback engine into a single shipped milestone (v0.1.0) followed by a cleanup batch (v0.1.1). The phase numbering below reflects what was actually shipped, not the original per-plugin partition.

- **Phase 0** — Repo bootstrap, `ALIGNMENT.md`, founding ADRs, CI workflows, PR template. ✅ Shipped (2026-05-23).
- **Phase 1** — Multi-provider proxy core: `server.mjs`, IR, three Tier-D provider plugins (Anthropic / OpenAI Codex / Mistral Vibe), cache (D1+D4) + cleanup (D2 bypass / D3 chunked replay / D23 size cap), fallback engine with first-chunk safety + hard triggers + per-hop log observability, IR↔OpenAI translation under Rule 2(b). ✅ Shipped — v0.1.0 (2026-05-24) + v0.1.1 cleanup (2026-05-25, D35–D42).
- **Phase 2** — Multi-key auth (`lib/keys.mjs`) per ADR 0007: opaque OLP API keys, per-key cache namespacing, owner-vs-guest tier for header gating, audit ndjson (`lib/audit.mjs`), `/health` payload trimming + `X-OLP-Fallback-Detail` emission gating, `OLP_OWNER_TOKEN` env override, keygen CLI (`bin/olp-keys.mjs`). ✅ Shipped — v0.2.0 (2026-05-25, D43-A → D47). All 11 ADR 0007 § 10 acceptance criteria covered.
- **Phase 3** — Dashboard + audit query layer + daily audit rotation per ADR 0008: in-memory ndjson aggregate query layer (`lib/audit-query.mjs`), 4 owner-only_block management endpoints (`/dashboard` + `/v0/management/dashboard-data` + `/v0/management/quota` + `/cache/stats`), multi-panel `dashboard.html` with 30s poll, synchronous daily audit rotation + `bin/olp-audit-rotate.mjs` cron tool, `tried_providers` schema fix (D45 P2 deferral). ✅ Shipped — v0.3.0 (2026-05-25, D48 → D54). All 15 ADR 0008 § 10 acceptance criteria covered.
- **Phase 4 (planned)** — Per-key per-provider auth artifact mapping (ADR 0007 § 12 deferral), audit query rotation/retention policies, SQLite hybrid migration (ADR 0007 § 13 trigger), provider-cost weights for spend trend.
- **Phase 4+ (v1.x roadmap, triggered as needed)** — Full deferred-work tracker: [`docs/v1x-roadmap.md`](./docs/v1x-roadmap.md). Includes streaming-path singleflight ([issue #16](https://github.com/dtzp555-max/olp/issues/16) + ADR 0005 Amendment 8 design ratified), soft-trigger reactivation (ADR 0004 Amendment 2), `/health` activeSpawns integration, provider-level `cacheKeyFields` mask, streaming-path SPAWN_FAILED salvage.
- **Phase N (opt-in)** — Tier-2 / Tier-C provider plugins (Grok / Kimi / MiniMax / GLM / Qwen) per [ADR 0006](./docs/adr/0006-provider-inclusion.md); provider-native protocol endpoints; deterministic triggers. Triggered by tier-2 demand, not on the bootstrap path.

Full spec (decision rationale, open questions, risks): `~/.cc-rules/memory/projects/olp_v0_1_spec.md` on the maintainer's workstations. Phase 2 kickoff handoff: `~/.cc-rules/memory/handoffs/2026-05-25-phase-2-kickoff.md`.

---

## Migration from OCP

OLP is OCP's successor. The trigger was Anthropic's 2026-05-14 announcement (effective 2026-06-15) splitting `claude -p` / Agent SDK / third-party agent traffic out of the Pro/Max subscription pool into a separate fixed $100/month Agent SDK credit pool — invalidating OCP's foundational assumption (*"subscription = unlimited within rate limits"*) for its only provider. OLP's structural response is to spread risk across multiple subscriptions whose CLI/programmatic use remains in their main subscription pool, with intelligent fallback when one runs out.

Beyond the billing trigger, OLP is intentionally NOT a commercial multi-tenant SaaS (LiteLLM / OpenRouter / Portkey already serve that market with funding + SOC2), NOT an enterprise gateway competing on provider breadth, NOT a model-capability router ("route to the smartest model" — you pick the model in `routing.chains`), and NOT a conversation-state store (your client manages its own context). See [ADR 0001](./docs/adr/0001-project-founding.md) for the founding decision and [`ALIGNMENT.md`](./ALIGNMENT.md) for the constitution that governs every plugin / IR / entry-surface change.

### Migrating an existing OCP install

_placeholder — `scripts/migrate-from-ocp.mjs` lands with Phase 7 (📋 planned, not yet authored)._

Anticipated user-facing flow (target: <5 minutes):

1. Stop OCP (`launchctl bootout` the OCP service or `ocp stop`).
2. Install OLP (per [§ Manual install](#manual-install-5-10-min) above).
3. Run `olp migrate-from-ocp` — will copy `~/.ocp/keys/` to `~/.olp/keys/` and point provider plugins at OCP's existing auth artifacts where applicable.
4. Start OLP. Clients pointing at port 4567 (or 3456 with `OLP_PORT=3456`) keep working; their existing OLP API keys remain valid.

**Default port moved 3456 → 4567 at v0.4.0** so OCP and OLP can co-host on the same machine during the migration window — set `OLP_PORT=3456` if you want the pre-D60 default. OCP's cache directory is *not* migrated: OLP's cache key format includes provider+model and warms cold naturally. OCP enters maintenance mode (stability fixes only) when OLP v0.1 ships; new development happens in OLP.

---

## License

MIT.

---

## Acknowledgements

OLP evolved from [OCP (Open Claude Proxy)](https://github.com/dtzp555-max/ocp). OCP's per-key isolation model, cache-layer design (D1–D4), dashboard, and alignment-constitution discipline are all carried forward. The structural generalization from single-CLI to multi-provider is what makes this a new project rather than an OCP minor version — see [`ALIGNMENT.md` § Reference: How OCP's `cli.js` discipline maps to OLP](./ALIGNMENT.md#reference-how-ocps-clijs-discipline-maps-to-olp).

Authors: project maintainer (with AI drafting assistance).

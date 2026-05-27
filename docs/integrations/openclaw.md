# OpenClaw + OLP

[OpenClaw](https://github.com/openclaw/openclaw) is a multi-bot gateway that exposes slash commands on Telegram, Discord, and other chat surfaces. OLP integrates with OpenClaw in two ways:

1. **`/olp` slash commands** via the [`olp-plugin/`](../../olp-plugin/) plugin (read-only parity to the local `olp` CLI).
2. **LLM routing** — OpenClaw's chat agent can route its model calls through your OLP server, giving you per-key audit + quota observability for every bot reply.

This doc covers both. **Status:** ✅ Supported.

## Two deployment modes — pick yours

The OpenClaw config differs significantly depending on whether OpenClaw runs on the same host as the OLP server or on a separate client machine talking to a remote OLP. Pick the right section.

| | **Mode A: Server-co-located** | **Mode B: Client-mode (recommended for multi-machine setups)** |
|---|---|---|
| OpenClaw runs on | the OLP server host (loopback) | a different machine (Mac mini, laptop, etc.) |
| OLP server runs on | localhost (same host) | a remote host (e.g. PI231) |
| `claude-local` baseUrl | `http://127.0.0.1:4567/v1` | `http://<server-ip>:4567/v1` |
| Auth | `authHeader: false` (loopback trusted), OR anonymous-key if `auth.allow_anonymous: true` | **must** explicitly inject `Authorization: Bearer olp_…` via the `headers` field (NOT `apiKey` — see § Gotchas below) |
| `/olp` slash plugin proxyUrl | `http://127.0.0.1:4567` | `http://<server-ip>:4567` |

## `/olp` slash commands you get

| Slash command | Maps to | Tier |
|---|---|---|
| `/olp status` | GET `/v0/management/status` | owner |
| `/olp health` | GET `/health` | public |
| `/olp usage` | GET `/v0/management/dashboard-data` | owner |
| `/olp models` | GET `/v1/models` | public |
| `/olp cache` | GET `/cache/stats` | owner |
| `/olp providers` | local registry view | public |
| `/olp chain show [model]` | local chain view | public |
| `/olp doctor` | informational (HTTP endpoint not yet shipped) | — |
| `/olp help` | usage text | — |

**Mutating subcommands are deliberately not exposed via chat.** `keygen`, `revoke`, `restart`, `logs` are SSH-only. See [`olp-plugin/README.md`](../../olp-plugin/README.md#what-you-can-not-do-from-chat-by-design) for the rationale.

---

## Mode A — Server-co-located install

OpenClaw + OLP on the same host. Auth is simpler because everything is on loopback.

### A1. Install the plugin

Two install paths — either works.

**Option A — OpenClaw CLI:**

```bash
openclaw plugins install /path/to/olp/olp-plugin/
```

**Option B — symlink:**

```bash
mkdir -p ~/.openclaw/extensions/
ln -s /path/to/olp/olp-plugin/ ~/.openclaw/extensions/olp
```

### A2. Mint a bot owner key

```bash
npx olp-keys keygen --owner --name=openclaw-bot
```

Capture the printed plaintext token — shown exactly once.

### A3. Configure (loopback recipe)

Edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["...", "olp"],
    "entries": {
      "olp": {
        "enabled": true,
        "config": {
          "proxyUrl": "http://127.0.0.1:4567",
          "apiKey": "olp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      }
    }
  }
}
```

For LLM routing through OLP, add (or update) the `claude-local` provider so the bot's default agent goes through OLP-spawned `claude -p`:

```json
{
  "models": {
    "providers": {
      "claude-local": {
        "baseUrl": "http://127.0.0.1:4567/v1",
        "api": "openai-completions",
        "authHeader": false,
        "models": [
          { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6", "input": ["text"],
            "contextWindow": 200000, "maxTokens": 16384, "api": "openai-completions",
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }
        ]
      }
    }
  }
}
```

`authHeader: false` is safe on loopback. If you set `auth.allow_anonymous: true` on the OLP server, the bot doesn't even need a key for slash commands (the `apiKey` field can be omitted). Owner-only subcommands (`/olp status`, `/olp usage`, `/olp cache`) still need an owner-tier key.

### A4. Restart the gateway

```bash
openclaw gateway restart
```

---

## Mode B — Client-mode install (OpenClaw on different host than OLP)

OpenClaw on machine X (e.g., Mac mini), OLP server on machine Y (e.g., a Raspberry Pi or any LAN host). This is the common family deployment shape.

### B1. Install the plugin

Same as Mode A:

```bash
openclaw plugins install /path/to/olp/olp-plugin/
# OR
mkdir -p ~/.openclaw/extensions/
ln -s /path/to/olp/olp-plugin/ ~/.openclaw/extensions/olp
```

### B2. Mint a bot owner key (on the OLP server, NOT on the OpenClaw host)

SSH to the OLP server:

```bash
ssh user@olp-server
cd ~/olp
node bin/olp-keys.mjs keygen --owner --name=openclaw-<hostname>-bot
```

Capture the plaintext — shown exactly once. **This token will live in `~/.openclaw/openclaw.json` on your OpenClaw host**; pick a name that makes it independently revocable if that host is lost/compromised.

### B3. Configure (remote recipe)

Edit `~/.openclaw/openclaw.json` on the OpenClaw host:

```json
{
  "plugins": {
    "allow": ["...", "olp"],
    "entries": {
      "olp": {
        "enabled": true,
        "config": {
          "proxyUrl": "http://<olp-server-ip>:4567",
          "apiKey": "olp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        }
      }
    }
  },
  "models": {
    "providers": {
      "claude-local": {
        "baseUrl": "http://<olp-server-ip>:4567/v1",
        "api": "openai-completions",
        "headers": {
          "Authorization": "Bearer olp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        },
        "models": [
          { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6 (via OLP)", "input": ["text"],
            "contextWindow": 200000, "maxTokens": 16384, "api": "openai-completions",
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } },
          { "id": "claude-opus-4-7", "name": "Claude Opus 4.7 (via OLP)", "input": ["text"],
            "contextWindow": 200000, "maxTokens": 16384, "api": "openai-completions",
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } },
          { "id": "claude-haiku-4-5", "name": "Claude Haiku 4.5 (via OLP)", "input": ["text"],
            "contextWindow": 200000, "maxTokens": 16384, "api": "openai-completions",
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }
        ]
      }
    }
  }
}
```

⚠️ **Use `headers.Authorization`, NOT `apiKey`** — see § Gotchas: OPENAI_API_KEY clobber.

### B4. Confirm the default agent model is on `claude-local`

Check `agents.defaults.model.primary` in `openclaw.json`. It should be something like:

```json
{ "agents": { "defaults": { "model": { "primary": "claude-local/claude-sonnet-4-6" } } } }
```

If it's pointing at one of OpenClaw's stock providers (`openai/...`, `anthropic/...`, `github-copilot/...`), free-text chat will **bypass OLP entirely** and hit your direct API account. You'll see no traffic in OLP's `/dashboard` and `/olp usage` will show no recent activity.

### B5. Restart the gateway

```bash
openclaw gateway restart
```

### B6. Verify routing

In Telegram or Discord, send a free-text message ("hello"). It should:
1. Return a normal LLM reply (not "Something went wrong")
2. Show up on the OLP dashboard's 24h-requests counter
3. Show up in `/olp usage` per-provider count

If you see "Something went wrong" — see § Troubleshooting below.

---

## Using codex / OpenAI models through OLP

By default the `claude-local` provider only knows about Claude models. To route OpenAI / codex models through OLP (so bot calls to `gpt-5.5` etc. spawn `codex exec --json` on the OLP server and benefit from per-key audit + quota tracking), add a second provider:

```json
{
  "models": {
    "providers": {
      "olp-openai": {
        "baseUrl": "http://<olp-server-ip>:4567/v1",
        "api": "openai-completions",
        "headers": {
          "Authorization": "Bearer olp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        },
        "models": [
          { "id": "gpt-5.5", "name": "GPT 5.5 (via OLP→codex)", "input": ["text"],
            "contextWindow": 200000, "maxTokens": 16384, "api": "openai-completions",
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } },
          { "id": "gpt-5.4-mini", "name": "GPT 5.4 mini (via OLP→codex)", "input": ["text"],
            "contextWindow": 200000, "maxTokens": 16384, "api": "openai-completions",
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } },
          { "id": "gpt-5.3-codex", "name": "GPT 5.3 codex (via OLP→codex)", "input": ["text"],
            "contextWindow": 200000, "maxTokens": 16384, "api": "openai-completions",
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "models": {
        "olp-openai/gpt-5.5": { "alias": "OLP GPT 5.5" },
        "olp-openai/gpt-5.4-mini": { "alias": "OLP GPT 5.4 mini" },
        "olp-openai/gpt-5.3-codex": { "alias": "OLP Codex" }
      }
    }
  }
}
```

After restart, `/models olp-openai/gpt-5.5` in Telegram switches the session to GPT 5.5 spawned via OLP. The available IDs are the ones OLP's `/v1/models` returns — typically `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`. Query your OLP server to see the live list:

```bash
curl -s -H "Authorization: Bearer olp_…" http://<olp-server-ip>:4567/v1/models | jq '.data[].id'
```

**Why not use OpenClaw's stock `openai` provider?** OpenClaw's built-in `openai-codex` provider uses the local ChatGPT account (via the `sk-proj-…` API key OpenClaw stores) and bypasses your OLP server entirely. You'd lose per-key audit + per-key quota visibility. `olp-openai` keeps everything routed through your central OLP for observability.

---

## Gotchas

### OpenClaw service-managed env clobbers `OPENAI_API_KEY`

If you set the OLP-routing provider with `authHeader: true` + `apiKey: "olp_…"` instead of `headers.Authorization`, OpenClaw will SOMETIMES route OK on loopback (`authHeader: false`) but in client-mode you may hit `401: OLP API key is invalid or has been revoked` even though your token is fresh.

**Root cause**: OpenClaw declares `OPENCLAW_SERVICE_MANAGED_ENV_KEYS=DEEPSEEK_API_KEY,OPENAI_API_KEY` in its gateway-process env. The service-manager strongly owns `OPENAI_API_KEY` and overwrites whatever your `launchctl setenv` set, with whatever ChatGPT key you've authed OpenClaw against. When the `openai-completions` provider implementation builds the request's `Authorization` header, it can fall back to `process.env.OPENAI_API_KEY` — which is now your ChatGPT key, not the OLP token. OLP rejects with 401.

**The fix is `headers.Authorization`** — the per-provider `headers` map is applied at request-construction time and beats whatever env-var fallback would compute. From OpenClaw source:

```javascript
const providerHeaders = sanitizeModelHeaders(providerConfig.headers, { stripSecretRefMarkers: true });
// providerHeaders merged into outgoing request — explicit override wins
```

If you want to stick with `apiKey` for stylistic reasons, you'd need to remove `OPENAI_API_KEY` from the OpenClaw service-managed list — not recommended; that key is load-bearing for OpenClaw's own model providers.

### Default agent model still points at a removed provider

If you've removed a provider (e.g., torn down a co-located OCP server) but the bot's default agent model still references that provider, free-text messages will fail with "Something went wrong while processing your request." Check `agents.defaults.model.primary` and update it to a provider that exists.

### `/new` does not reset model selection

OpenClaw's `/new` resets the **conversation context** but **preserves** the session's `/models` selection. If a session has been switched to a model that no longer works (revoked / removed), `/new` won't help — use `/reset` (resets both context and model selection) or `/models <working-model>`.

### OpenClaw v2026.5+ requires `openclaw.extensions` in `package.json`

OpenClaw versions ≥ 2026.5.22 enforce a stricter plugin-manifest validation at `openclaw plugins install` time. If `Option A` fails with `package.json missing openclaw.extensions` despite recent OLP releases, your local `olp-plugin/package.json` may predate the v0.5.x fix that adds `"extensions": ["./index.js"]` to the `openclaw` block. Pull latest OLP main (`git pull` in your OLP clone) and retry, or fall through to symlink Option B which works against any plugin shape. (Original drift event: 2026-05-27, see commit history of `olp-plugin/package.json`.)

### `openclaw gateway restart` is required after install

OpenClaw caches plugin discovery + model-provider config at gateway start. `openclaw plugins reload` does not guarantee a fresh import of the plugin module nor a fresh re-read of `models.providers.*`. Restart the gateway after every change to `~/.openclaw/openclaw.json`.

### Owner-key revocation kicks the plugin out immediately

If you revoke the bot's owner key (`npx olp-keys revoke --id=<id>`), the next `/olp status` will return `401 unauthorized`. Mint a replacement key with a new name and edit `~/.openclaw/openclaw.json`; do NOT reuse the revoked key's UUID.

### Long responses are truncated

Telegram caps messages at ~4096 characters. The plugin truncates with a `... [truncated, use SSH for full]` suffix when the rendered output would exceed ~3900 chars. Use SSH + the local `olp` CLI for full output.

---

## OLP-specific notes

The plugin honours these env vars on the OpenClaw gateway process:

- `OLP_PROXY_URL` — full URL, overrides plugin config `proxyUrl`.
- `OLP_PORT` — port only, localhost assumed; overrides `proxyUrl` when `OLP_PROXY_URL` is unset.

If you run the OpenClaw gateway under launchd or systemd with custom env vars, set `OLP_PROXY_URL` there rather than editing the plugin config — that way the same plugin install can serve multiple OLP hosts.

## Per-bot vs maintainer key

**Always create a dedicated bot key**, never the maintainer's personal owner key. The bot key:

- Has its own `id` so you can revoke it without affecting other clients.
- Has its own audit-log entries so you can attribute `/v0/management/*` traffic to the bot.
- Can be rotated routinely (every 90 days etc.) without coordinating with the maintainer's daily-driver IDE configs.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/olp status` returns 401 | bot key revoked / wrong / missing | Mint new key on OLP host; update `plugins.entries.olp.config.apiKey`; restart gateway |
| `/olp status` returns 403 | bot key is guest-tier, not owner-tier | Generate owner-tier key (`olp-keys keygen --owner --name=...`); update config |
| `OLP error: fetch failed` | `proxyUrl` unreachable from the gateway host | `curl http://<proxyUrl>/health` from the gateway host to confirm reachability; check firewall / OLP server `OLP_BIND=0.0.0.0` for LAN access |
| Bot free-text chat returns "Something went wrong" but `/olp ...` works | Default agent model points at a broken provider (e.g., a removed OCP install) | Check `agents.defaults.model.primary` in `openclaw.json`; update to `claude-local/claude-sonnet-4-6` or another working provider |
| Free-text returns `HTTP 401: OLP API key is invalid` despite fresh key | `apiKey` field is being shadowed by OpenClaw's service-managed `OPENAI_API_KEY` env var | Switch to `headers.Authorization: "Bearer olp_…"` in the provider config (see § Gotchas) |
| Bot routes to ChatGPT account directly, not through OLP | Provider config uses OpenClaw stock `openai-codex` instead of a custom OLP-pointing provider | Add `olp-openai` provider per § Using codex / OpenAI models through OLP |

## Cross-references

- [`olp-plugin/README.md`](../../olp-plugin/README.md) — full plugin docs.
- [ADR 0010 § Phase 4 D71-D73](../adr/0010-phase-4-charter-operator-and-client-ux.md) — the plugin's charter.
- [OCP `/ocp` plugin](https://github.com/dtzp555-max/ocp/tree/main/ocp-plugin) — the OCP predecessor (includes mutating subcommands that OLP deliberately drops).

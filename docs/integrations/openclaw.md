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
| `olp-claude` baseUrl | `http://127.0.0.1:4567/v1` | `http://<server-ip>:4567/v1` |
| Auth | `authHeader: false` (loopback trusted), OR anonymous-key if `auth.allow_anonymous: true` | `apiKey: "${OLP_OPENCLAW_BOT_TOKEN}"` env-var reference (NOT raw string, NOT `OPENAI_API_KEY` — see § Gotchas) |
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

For LLM routing through OLP, add (or update) the `olp-claude` provider so the bot's default agent goes through OLP-spawned `claude -p`:

```json
{
  "models": {
    "providers": {
      "olp-claude": {
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

### B3. Set the bot-token env var (`OLP_OPENCLAW_BOT_TOKEN`)

OpenClaw's canonical pattern for custom-provider auth is `apiKey: "${VAR_NAME}"` — an env-var reference, NOT a raw token. Choose a **custom** variable name (NOT `OPENAI_API_KEY` — OpenClaw service-manages that one and clobbers it with its own ChatGPT key on every restart). Convention: `OLP_OPENCLAW_BOT_TOKEN`.

**macOS (gateway under launchd)**:

```bash
launchctl setenv OLP_OPENCLAW_BOT_TOKEN olp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

Add the same `export` to `~/.zshrc` so it survives reboot:

```bash
export OLP_OPENCLAW_BOT_TOKEN=olp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

**Linux (gateway under systemd-user)**: drop a file at `~/.config/environment.d/openclaw-olp.conf`:

```
OLP_OPENCLAW_BOT_TOKEN=olp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

Restart the gateway service so it picks up the new env.

### B4. Configure `~/.openclaw/openclaw.json`

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
      "olp-claude": {
        "baseUrl": "http://<olp-server-ip>:4567/v1",
        "api": "openai-completions",
        "apiKey": "${OLP_OPENCLAW_BOT_TOKEN}",
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

Note: the `plugins.entries.olp.config.apiKey` field (line 11) IS allowed to be a raw token — it's a separate code path that doesn't suffer the service-managed-env clobber problem. Only the `models.providers.<id>.apiKey` field needs the `${VAR}` env-var-reference workaround.

### B5. Confirm the default agent model is on `olp-claude`

Check `agents.defaults.model.primary` in `openclaw.json`. It should be something like:

```json
{ "agents": { "defaults": { "model": { "primary": "olp-claude/claude-sonnet-4-6" } } } }
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

By default the `olp-claude` provider only knows about Claude models. To route OpenAI / codex models through OLP (so bot calls to `gpt-5.5` etc. spawn `codex exec --json` on the OLP server and benefit from per-key audit + quota tracking), add a second provider:

```json
{
  "models": {
    "providers": {
      "olp-codex": {
        "baseUrl": "http://<olp-server-ip>:4567/v1",
        "api": "openai-completions",
        "apiKey": "${OLP_OPENCLAW_BOT_TOKEN}",
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
        "olp-codex/gpt-5.5": { "alias": "OLP GPT 5.5" },
        "olp-codex/gpt-5.4-mini": { "alias": "OLP GPT 5.4 mini" },
        "olp-codex/gpt-5.3-codex": { "alias": "OLP Codex" }
      }
    }
  }
}
```

After restart, type `/models` in Telegram and pick `olp-codex/gpt-5.5` from the menu that appears. **`/models` is menu-driven — it does not accept inline model names**; typing `/models olp-codex/gpt-5.5` won't directly switch you. The available IDs are the ones OLP's `/v1/models` returns — typically `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`. Query your OLP server to see the live list:

```bash
curl -s -H "Authorization: Bearer olp_…" http://<olp-server-ip>:4567/v1/models | jq '.data[].id'
```

**Why not use OpenClaw's stock `openai` provider?** OpenClaw's built-in `openai-codex` provider uses the local ChatGPT account (via the `sk-proj-…` API key OpenClaw stores) and bypasses your OLP server entirely. You'd lose per-key audit + per-key quota visibility. `olp-codex` keeps everything routed through your central OLP for observability.

---

## Gotchas

### Auth must use `apiKey: "${VAR}"` env-var reference — three failure modes to avoid

Custom OpenAI-compatible providers in OpenClaw have a fragile auth path. Three patterns that **don't work** + the one that **does**:

**❌ `apiKey: "olp_<raw-token>"`** — raw string. Silently bypassed in some routing paths because OpenClaw treats `OPENAI_API_KEY` as service-managed (`OPENCLAW_SERVICE_MANAGED_ENV_KEYS=DEEPSEEK_API_KEY,OPENAI_API_KEY`), and certain model id patterns (notably `gpt-*`) fall back to that env var instead of using your explicit `apiKey`. Symptom: OLP audit shows the request as `__anonymous__` instead of your owner key. Confirmed via [openclaw#41157](https://github.com/openclaw/openclaw/issues/41157) (Gemini openai-completions Authorization not sent) and [#1669](https://github.com/openclaw/openclaw/issues/1669) (Ollama provider ignores apiKey, hardcodes Bearer). Both unresolved upstream as of OpenClaw v2026.5.

**❌ `headers: { "Authorization": "Bearer olp_<raw-token>" }`** — works for SOME provider/model combinations (e.g., model id `claude-sonnet-4-6`) but breaks for openai-shape model ids (`gpt-5.5` etc.) which take a different code path that ignores the `headers` field. Mixed behavior is worse than no behavior.

**❌ Setting `OPENAI_API_KEY=olp_…`** in the gateway env. OpenClaw service-manages that variable and overwrites your value with the user's ChatGPT key on every gateway start.

**✅ `apiKey: "${OLP_OPENCLAW_BOT_TOKEN}"`** — env-var reference with a **custom** variable name (NOT `OPENAI_API_KEY`). OpenClaw resolves the reference at request-construction time, before any service-managed-env logic runs. Both `olp-claude/*` (Claude models) and `olp-codex/*` (OpenAI models) auth correctly with this pattern. Verified end-to-end 2026-05-27: OLP audit shows requests attributed to the correct bot key for both provider blocks.

OpenClaw docs call out this as the canonical pattern: see [docs.openclaw.ai/concepts/model-providers](https://docs.openclaw.ai/concepts/model-providers) "API key or SecretRef/env reference".

### Default agent model still points at a removed provider

If you've removed a provider (e.g., torn down a co-located OCP server) but the bot's default agent model still references that provider, free-text messages will fail with "Something went wrong while processing your request." Check `agents.defaults.model.primary` and update it to a provider that exists.

### `/new` does not reset model selection — use `/reset`

OpenClaw's `/new` resets the **conversation context** but **preserves** the session's `/models` selection. If a session has been switched to a model that no longer works (revoked / removed), `/new` won't help — use `/reset` (resets both context and model selection).

### `/models` is menu-only — does not accept inline model names

The OpenClaw `/models` command in Telegram is **menu-driven**: typing `/models` pops a model-picker menu where you tap the model name. Typing `/models olp-codex/gpt-5.5` does NOT switch — it'll open the picker. The bot's own success-message after a pick may say *"Use `/model olp-codex/gpt-5.5 --runtime <runtime>` to switch harnesses."* — **that command form is not actually accepted by the bot**; ignore that line.

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
| Bot free-text chat returns "Something went wrong" but `/olp ...` works | Default agent model points at a broken provider (e.g., a removed OCP install) | Check `agents.defaults.model.primary` in `openclaw.json`; update to `olp-claude/claude-sonnet-4-6` or another working provider |
| Free-text returns `HTTP 401: OLP API key is invalid` despite fresh key | Raw-string `apiKey: "olp_..."` shadowed by service-managed env clobber; or `headers.Authorization` bypassed for `gpt-*` model ids | Switch `models.providers.<id>.apiKey` to env-var reference: `"${OLP_OPENCLAW_BOT_TOKEN}"` (see § Gotchas: Auth) |
| OLP audit shows `key_id=__anonymous__` for traffic that should be owner-attributed | Same root cause as 401 — raw-string apiKey or headers bypassed in some routing paths | Switch to env-var-reference `apiKey: "${VAR}"` pattern + verify `launchctl getenv OLP_OPENCLAW_BOT_TOKEN` returns the expected token |
| Bot routes to ChatGPT account directly, not through OLP | Provider config uses OpenClaw stock `openai-codex` instead of a custom OLP-pointing provider | Add `olp-codex` provider per § Using codex / OpenAI models through OLP |
| `/models olp-codex/gpt-5.5` typed inline doesn't work | OpenClaw `/models` is menu-only, doesn't accept inline names | Type `/models`, tap the model from the picker menu that appears |

## Cross-references

- [`olp-plugin/README.md`](../../olp-plugin/README.md) — full plugin docs.
- [ADR 0010 § Phase 4 D71-D73](../adr/0010-phase-4-charter-operator-and-client-ux.md) — the plugin's charter.
- [OCP `/ocp` plugin](https://github.com/dtzp555-max/ocp/tree/main/ocp-plugin) — the OCP predecessor (includes mutating subcommands that OLP deliberately drops).

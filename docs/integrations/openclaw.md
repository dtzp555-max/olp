# OpenClaw + OLP

[OpenClaw](https://github.com/openclaw/openclaw) is a multi-bot gateway
that exposes slash commands on Telegram, Discord, and other chat
surfaces. OLP ships [`olp-plugin/`](../../olp-plugin/) as a native
OpenClaw plugin that registers a `/olp` slash command with read-only
parity to the local `olp` CLI.

**Status:** ✅ Supported.

## What you get

After install, from Telegram or Discord:

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

**Mutating subcommands are deliberately not exposed via chat.** `keygen`,
`revoke`, `restart`, `logs` are SSH-only. See
[`olp-plugin/README.md`](../../olp-plugin/README.md#what-you-can-not-do-from-chat-by-design)
for the rationale.

## Quick setup

### 1. Install the plugin

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

### 2. Mint a bot owner key

Run on the OLP host (NOT in chat):

```bash
npx olp-keys keygen --owner --name=openclaw-bot
```

Capture the printed plaintext token — it is shown exactly once.

### 3. Configure

Edit `~/.openclaw/openclaw.json`:

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

### 4. Restart the gateway

```bash
openclaw gateway restart
```

The plugin is now active. Try `/olp help` in your bot's chat.

## Known issues

- **`openclaw gateway restart` is required after install.** OpenClaw caches
  plugin discovery at gateway start. `openclaw plugins reload` does not
  guarantee a fresh import of the plugin module.

- **Owner key revocation kicks the plugin out immediately.** If you revoke
  the bot's owner key (`npx olp-keys revoke --id=<id>`), the next `/olp
  status` will return `401 unauthorized`. Mint a replacement key with a
  new name and edit `~/.openclaw/openclaw.json`; do NOT reuse the revoked
  key's UUID.

- **Long responses are truncated.** Telegram caps messages at ~4096
  characters. The plugin truncates with a `... [truncated, use SSH for
  full]` suffix when the rendered output would exceed ~3900 chars. Use
  SSH + the local `olp` CLI for full output.

## OLP-specific notes

The plugin honours these env vars on the OpenClaw gateway process:

- `OLP_PROXY_URL` — full URL, overrides plugin config `proxyUrl`.
- `OLP_PORT` — port only, localhost assumed; overrides `proxyUrl` when
  `OLP_PROXY_URL` is unset.

If you run the OpenClaw gateway under launchd or systemd with custom env
vars, set `OLP_PROXY_URL` there rather than editing the plugin config —
that way the same plugin install can serve multiple OLP hosts.

## Per-bot vs maintainer key

**Always create a dedicated bot key**, never the maintainer's personal
owner key. The bot key:

- Has its own `id` so you can revoke it without affecting other clients.
- Has its own audit-log entries so you can attribute `/v0/management/*`
  traffic to the bot.
- Can be rotated routinely (every 90 days etc.) without coordinating with
  the maintainer's daily-driver IDE configs.

## Test it

After restart, in Telegram or Discord:

```
/olp health
/olp status
/olp models
```

Each should return a code-block-wrapped response within a few seconds.

If you see `401 unauthorized`: the configured key is missing / wrong /
revoked. If you see `403 forbidden`: the key is not owner-tier. If you
see `OLP error: fetch failed` or similar: the `proxyUrl` is unreachable
from the gateway host (test with `curl http://<proxyUrl>/health` from
that host).

## Cross-references

- [`olp-plugin/README.md`](../../olp-plugin/README.md) — full plugin docs.
- [ADR 0010 § Phase 4 D71-D73](../adr/0010-phase-4-charter-operator-and-client-ux.md) — the plugin's charter.
- [OCP `/ocp` plugin](https://github.com/dtzp555-max/ocp/tree/main/ocp-plugin) — the OCP predecessor (includes mutating subcommands that OLP deliberately drops).

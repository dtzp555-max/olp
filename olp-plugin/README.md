# olp-plugin

OpenClaw gateway plugin that exposes a `/olp` slash command on Telegram and
Discord, with subcommand parity to the local `olp` CLI (`bin/olp.mjs`) minus
mutating operations.

**Authority:** [ADR 0010 § Phase 4 D71-D73](../docs/adr/0010-phase-4-charter-operator-and-client-ux.md).

## Status

✅ Shipped at v0.4.0 (read-only subset of `olp` CLI).

## What you can do from chat

| Slash command | Maps to | Tier |
|---|---|---|
| `/olp status` | GET `/v0/management/status` | owner |
| `/olp health` | GET `/health` | public |
| `/olp usage` | GET `/v0/management/dashboard-data` | owner |
| `/olp models` | GET `/v1/models` | public |
| `/olp cache` | GET `/cache/stats` | owner |
| `/olp providers` | local registry view | public |
| `/olp chain show [model]` | local chain view (empty unless wired) | public |
| `/olp doctor` | informational only (HTTP doctor endpoint not yet shipped) | — |
| `/olp help` | usage text | — |

## What you can NOT do from chat (by design)

The following `olp` CLI subcommands are **deliberately not** ported to the
chat surface, because Telegram + Discord are shared / persistent message
streams and key material or raw audit logs should not be flowing across
them:

- `olp keys keygen` — key material would land in chat history
- `olp keys revoke` — accidental misclick could lock out clients
- `olp restart` — a misclick should not cycle the proxy
- `olp logs` — audit content may carry PII

Use SSH to the host running OLP and the local `olp` CLI for those.

## Install

The plugin is shipped inside the OLP repo at `olp-plugin/`. Two install paths:

### Option A — OpenClaw CLI

```bash
openclaw plugins install /path/to/olp/olp-plugin/
```

### Option B — symlink

```bash
mkdir -p ~/.openclaw/extensions/
ln -s /path/to/olp/olp-plugin/ ~/.openclaw/extensions/olp
```

Either path makes the plugin discoverable; restart the gateway to pick it up:

```bash
openclaw gateway restart
```

## Configure

Edit `~/.openclaw/openclaw.json` and add a config block for the `olp` plugin:

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

- `proxyUrl` — full URL of the OLP proxy. Default `http://127.0.0.1:4567`
  (OLP's default since v0.4.0 / D60). Overridable via `OLP_PROXY_URL` or
  `OLP_PORT` env if you run the gateway under launchd / systemd with custom
  env.
- `apiKey` — **owner-tier** OLP API key. Required for the subcommands marked
  `owner` in the table above. Create one with:

  ```bash
  # On the OLP host, NOT in chat:
  npx olp-keys keygen --owner --name=openclaw-bot
  # Capture the plaintext token from the output — it is printed exactly once.
  ```

  Use a dedicated bot key (the `--name=openclaw-bot` example above) so you
  can `npx olp-keys revoke --id=<id>` later without affecting the
  maintainer's personal key.

## Use

In Telegram or Discord, after the gateway picks up the plugin:

```
/olp status
/olp usage
/olp models
/olp help
```

Output is wrapped in a monospace code block. Long responses are truncated
to fit Telegram's ~4096-char per-message limit; a `... [truncated, use SSH
for full]` suffix marks where the cut happened.

## Authorization model

The plugin sends `Authorization: Bearer <apiKey>` on every request. OLP's
server enforces:

- **public-tier endpoints** (`/health`, `/v1/models`) accept any non-revoked
  key (or no key at all if `auth.allow_anonymous: true`).
- **owner-tier endpoints** (`/v0/management/*`, `/cache/stats`) reject any
  non-owner key with 403.

If you see `401 unauthorized` or `403 forbidden` in chat:

- Verify the configured `apiKey` is a non-revoked **owner**-tier key.
- Verify the key was created on the same host running the OLP server (keys
  are stored under `~/.olp/keys/` and validated by hash on the server side).
- Check the OLP server's `/health` directly with `curl` to confirm
  reachability.

## Port resolution priority

1. `OLP_PROXY_URL` env (full URL) — useful when the gateway runs on a
   different host than OLP and you proxy in via Tailscale.
2. `OLP_PORT` env (port only; localhost assumed).
3. Plugin config `proxyUrl`.
4. Fallback `http://127.0.0.1:4567`.

## Why no Telegram/Discord SDK dependency

OpenClaw provides the transport (Telegram bot + Discord bot are gateway
features). This plugin only registers a slash command — it does not open
its own websocket / long-poll connection. That means:

- No new npm dependency.
- No bot tokens stored in plugin config.
- Plugin works for any OpenClaw-supported chat surface (currently Telegram +
  Discord; future surfaces inherit automatically).

## Cross-references

- [Local `olp` CLI](../bin/olp.mjs) — the full mutating-capable surface.
- [OCP `/ocp` plugin](https://github.com/dtzp555-max/ocp/tree/main/ocp-plugin) — the OCP predecessor this is ported from.
- [ADR 0010](../docs/adr/0010-phase-4-charter-operator-and-client-ux.md) — Phase 4 charter.
- [ADR 0007](../docs/adr/0007-multi-key-auth.md) — multi-key auth model that gates owner-tier subcommands.

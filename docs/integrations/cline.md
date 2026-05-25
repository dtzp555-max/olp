# Cline + OLP

[Cline](https://github.com/cline/cline) is an autonomous-coder VS Code
extension. It speaks OpenAI's `/v1/chat/completions` wire format via its
"OpenAI Compatible" provider option.

**Status:** ✅ Supported.

**Tested against:** Cline v3.x (extension version visible in VS Code's
extension panel). Cline's settings UI has shipped multiple variants of the
base-URL field across 2025-2026; if your version doesn't show the field
described below, see the Known Issues section.

## Quick setup

1. Open the Cline panel in VS Code (sidebar icon).
2. Click the settings gear → "API Provider".
3. Select **OpenAI Compatible**.
4. Fill the fields:

   | Field | Value |
   |---|---|
   | Base URL | `http://127.0.0.1:4567/v1` |
   | API Key | `olp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX` |
   | Model ID | `claude-sonnet-4-5` |

5. Save. Cline shows the model name in the bottom-right corner of the panel.

Replace the API key with the plaintext token printed by `olp-keys keygen
--name=cline`. Family members on the LAN should substitute the OLP host's
IP for `127.0.0.1` (or use `olp-connect <ip>`).

## Known issues

- **Cline issue [#7128](https://github.com/cline/cline/issues/7128) —
  base-URL UI field intermittently disappears.** Several Cline releases in
  2025-2026 shipped a settings UI where the "Base URL" field is hidden when
  the "OpenAI Compatible" provider is freshly selected. Workaround: switch
  to a different provider, save, switch back to "OpenAI Compatible" — the
  field returns. Verify the field is visible in your version BEFORE
  troubleshooting OLP itself.

- **Cline writes settings to `.vscode/settings.json` under a
  `cline.apiConfiguration` key (workspace-scoped) and to the VS Code global
  state (machine-scoped) depending on the "save to workspace" toggle.** If
  Cline keeps "forgetting" the OLP base URL across VS Code restarts, the
  workspace state is overriding the global state. Either save to workspace
  explicitly, or clear the workspace key and use global state.

- **Cline sometimes lowercases the model ID before sending.** OLP's
  `models-registry.json` uses canonical case (e.g. `claude-sonnet-4-5`).
  This is fine — OLP's router lowercases the requested model for chain
  lookup. But if you see `unknown model` errors, double-check the exact
  string Cline sent via the OLP response headers (curl test below).

## OLP-specific notes

Cline does not expose a custom-headers field in its OpenAI Compatible
provider UI as of v3.x. The OLP routing chain is selected purely from the
model ID — pick the canonical name (e.g. `claude-sonnet-4-5`) that matches
a `routing.chains` key in your `~/.olp/config.json`.

OLP's response headers (`X-OLP-Provider-Used`, `X-OLP-Cache`,
`X-OLP-Latency-Ms`) are not visible in Cline's UI but are captured by VS
Code's Developer Tools Network panel when Cline runs the request.

## Test it

```bash
# 1. Verify OLP accepts Cline-shape requests
curl -sI -X POST http://127.0.0.1:4567/v1/chat/completions \
  -H "Authorization: Bearer olp_XXXXXX" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"ok"}],"max_tokens":5,"stream":false}' \
  | grep -i x-olp
```

Expect `X-OLP-Provider-Used: anthropic` (or whichever provider serves
sonnet in your chain) and `X-OLP-Cache: miss` on first request.

## Why not /v1/messages?

Cline supports Anthropic-shape requests via a separate "Anthropic" provider
in its UI. OLP does not implement `/v1/messages`. Use Cline's **OpenAI
Compatible** option pointed at OLP rather than Cline's **Anthropic** option
pointed at api.anthropic.com — the OLP chain gives you fallback to OpenAI
Codex / Mistral / etc. when the Anthropic subscription hits its quota
ceiling. See [ADR 0010 § /v1/messages defer rationale](../adr/0010-phase-4-charter-operator-and-client-ux.md).

## Cross-references

- Cline issue tracker: https://github.com/cline/cline/issues
- [`olp-connect`](../../bin/olp-connect) automates writing the Cline workspace
  state.

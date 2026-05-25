# Continue.dev + OLP

[Continue.dev](https://continue.dev) is an open-source autocomplete +
chat extension for VS Code and JetBrains IDEs. It speaks OpenAI's
`/v1/chat/completions` wire format, so it works against OLP with no
shim layer.

**Status:** ✅ Supported.

**Tested against:** Continue.dev v0.10.x (`config.yaml` schema). The
older `config.json` schema (≤ v0.8) is **not** documented here — Continue
deprecated it in late 2025 and emits a one-shot migration warning.

## Quick setup

Edit `~/.continue/config.yaml` (or open the Continue config from the IDE's
extension panel and paste this in):

```yaml
models:
  - name: olp-chat
    provider: openai
    model: claude-sonnet-4-5
    apiBase: http://127.0.0.1:4567/v1
    apiKey: olp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
    roles:
      - chat
    requestOptions:
      headers:
        # Optional: pin which routing chain key applies. If omitted, OLP
        # looks up the chain via the model name above.
        X-OLP-Chain: claude-sonnet-4-5
  - name: olp-autocomplete
    provider: openai
    model: claude-haiku-4-5
    apiBase: http://127.0.0.1:4567/v1
    apiKey: olp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
    roles:
      - autocomplete
```

Replace the API key with the plaintext token printed by `olp-keys keygen
--name=continue-dev`. Family members on the LAN should substitute the OLP
host's IP for `127.0.0.1` (or use `olp-connect <ip>` to do this for them
automatically).

## Known issues

- **`apiBase`, NOT `baseURL`.** Continue's YAML schema uses `apiBase` (no
  `URL` casing). The older `config.json` `baseURL` key was renamed during the
  v0.10 schema cut. If you copy a snippet from a 2024 blog post and it
  silently routes to api.openai.com, this is why.
- **Trailing `/v1` matters.** OLP's chat-completions endpoint is at
  `/v1/chat/completions`; Continue appends `/chat/completions` to whatever
  `apiBase` resolves to. Set `apiBase: http://host:4567/v1` (with `/v1`),
  not the bare host.
- **Provider stays `openai`.** Continue's `provider: anthropic` would send
  Anthropic-shape requests to `/v1/messages`, which OLP does not implement
  (see [`claude-code.md`](./claude-code.md) for the rationale).

## OLP-specific notes

Continue's `requestOptions.headers` lets you pin OLP-specific routing
behaviour without altering the model name itself. Useful headers:

- `X-OLP-Chain: <chain-key>` — explicitly select the routing chain.
- `X-OLP-Bypass-Cache: true` — force a fresh spawn for the next request
  (debugging cache-poisoning suspicions).

OLP's response headers (`X-OLP-Provider-Used`, `X-OLP-Cache`, etc.) are
visible via VS Code's `Developer: Toggle Developer Tools` → Network panel
when Continue runs the request.

## Test it

After config save, open the Continue chat panel and send a one-word
message ("ok"). Then on the terminal:

```bash
curl -sI -X POST http://127.0.0.1:4567/v1/chat/completions \
  -H "Authorization: Bearer olp_XXXXXX" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"ok"}],"max_tokens":5}' \
  | grep -i x-olp
```

Expect `X-OLP-Provider-Used: anthropic` (or whichever provider your chain
routes haiku to) and `X-OLP-Cache: miss` on first request, `hit` on the
second.

## Cross-references

- Continue.dev config reference: https://docs.continue.dev/customization/models
- [`olp-connect`](../../bin/olp-connect) automates the Continue.dev branch
  of this setup.

# Aider + OLP

[Aider](https://aider.chat) is a terminal-native pair programmer that
edits files in your local git repo and commits each change. It speaks
OpenAI's `/v1/chat/completions` wire format via the `openai/` model
prefix.

**Status:** ✅ Supported.

**Tested against:** Aider v0.6x. Aider's OpenAI integration has been stable
across many releases — this is the most reliable IDE/CLI binding to OLP.

## Quick setup

Three knobs, all environment variables or `.env`:

```bash
# Required: point Aider at OLP's chat-completions endpoint
export OPENAI_API_BASE=http://127.0.0.1:4567/v1

# Required: OLP plaintext token
export OPENAI_API_KEY=olp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# Then invoke Aider with an OLP-routable model, prefixed `openai/`:
aider --model openai/claude-sonnet-4-5
```

The `openai/` prefix tells Aider to use its OpenAI-compatible adapter for
the named model. Aider's litellm layer parses this and sends the request
to whatever `OPENAI_API_BASE` resolves to.

Replace the API key with the plaintext token printed by `olp-keys keygen
--name=aider`. Family members on the LAN should substitute the OLP host's
IP for `127.0.0.1` (or use `olp-connect <ip>`).

## Aider's `.env` support

Aider auto-loads a `.env` file from the current directory or the git repo
root. The accepted keys are:

```bash
# .env at the project root
OPENAI_API_BASE=http://127.0.0.1:4567/v1
OPENAI_API_KEY=olp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# Optional: Aider's own AIDER_-prefixed equivalents work too
AIDER_OPENAI_API_BASE=http://127.0.0.1:4567/v1
```

The `AIDER_` prefix wins over the bare prefix when both are set. Pick one;
mixing them invites surprises during debugging.

**Hygiene:** add `.env` to `.gitignore` if your repo doesn't already. The
OLP token is plaintext-recoverable from disk only because the chat surface
explicitly opts into it (see [ADR 0011](../adr/0011-anonymous-key-deployment-context.md))
— do not let your IDE bind unintentionally.

## Known issues

- **No custom-headers support.** Aider does not expose a way to set extra
  HTTP headers on outgoing requests. OLP's optional `X-OLP-Chain` /
  `X-OLP-Bypass-Cache` headers are therefore not available via Aider —
  routing is determined by the model name alone.

- **`/v1` trailing matters.** `OPENAI_API_BASE` must end at `/v1` (without
  `/chat/completions`); Aider appends the remainder. Setting it to the bare
  host or with a trailing `/chat/completions` causes 404s.

- **Aider sends `max_tokens` by default.** OLP forwards `max_tokens` to
  every provider. If you see "model X does not support max_tokens" errors,
  the underlying provider rejects it — check `X-OLP-Provider-Used` and
  filter that provider out of the chain for the affected model.

## OLP-specific notes

Aider's request shape is faithful to OpenAI's `/v1/chat/completions`
spec — `messages`, `model`, `max_tokens`, `stream`, `temperature`,
`tools`. All map cleanly into OLP's IR with no lossy-translation warnings.

For long-context work (codebase summaries, large diffs), set
`streaming.heartbeat_interval_ms: 15000` in `~/.olp/config.json` (see
[README § Environment Variables](../../README.md#configjson-keys-introduced-at-phase-4))
so the SSE stream stays alive through reverse proxies during silent
windows.

## Test it

```bash
# In a scratch dir:
aider --model openai/claude-haiku-4-5 --no-stream --message "say ok"
```

Then check OLP's audit log:

```bash
npx olp logs 5
```

The most recent entry should show `provider: anthropic` (or whatever
provider haiku routes to in your chain) and `cache_status: miss`.

## Cross-references

- Aider model config docs: https://aider.chat/docs/llms/openai-compat.html
- [`olp-connect`](../../bin/olp-connect) writes `~/.aider/.env` if Aider is
  detected on PATH.

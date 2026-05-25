# OLP IDE & client integrations

This directory documents per-tool setup for the IDEs and AI clients OLP
supports. Every page follows the same shape: one-line description, status
icon, copy-paste-able config block, known issues, OLP-specific notes, and a
one-line verification command.

## Index

| Tool | Status | Path | Notes |
|---|---|---|---|
| [Continue.dev](./continue.md) | ✅ Supported | VS Code / JetBrains extension | `config.yaml` (NOT `config.json`); supports custom headers |
| [Cline](./cline.md) | ✅ Supported | VS Code extension | OpenAI-compatible provider; UI field occasionally vanishes (Cline #7128) |
| [Cursor](./cursor.md) | ⚠️ Best-effort | Cursor editor | "Override OpenAI Base URL" — known fragile across releases |
| [Aider](./aider.md) | ✅ Supported | terminal CLI | `OPENAI_API_BASE` env + `openai/` model prefix |
| [Claude Code](./claude-code.md) | ❌ Not supported | terminal CLI | Anthropic wire format only; OLP serves OpenAI wire format. Use Cline instead. |
| [OpenClaw](./openclaw.md) | ✅ Supported | Telegram + Discord gateway | `/olp` slash command via the [`olp-plugin/`](../../olp-plugin/) plugin |

## Status legend

- ✅ **Supported** — works against OLP's OpenAI-compatible `/v1/chat/completions`
  endpoint; the tool's IR fields flow through OLP's IR without lossy translation
  warnings on the documented chain.
- ⚠️ **Best-effort** — works in current versions but the tool has known
  upstream bugs around base-URL configuration; expect occasional weirdness.
- ❌ **Not supported** — the tool's wire protocol or transport is incompatible
  with what OLP serves; recommended alternative is documented on the page.

## How OLP's response headers help debugging

Every response carries (see [README § Response Headers](../../README.md#response-headers)):

- `X-OLP-Provider-Used` — which provider's plugin served the request
- `X-OLP-Model-Used` — which model the served provider used
- `X-OLP-Fallback-Hops` — `0` = primary chain entry served it
- `X-OLP-Cache` — `hit | miss | bypass`
- `X-OLP-Latency-Ms` — end-to-end latency at the proxy

When something looks wrong in an IDE, the first sanity check is `curl -i`
against `/v1/chat/completions` with the same key — those headers tell you
whether the IDE config is broken or OLP routed somewhere unexpected.

## Cross-references

- [ADR 0010](../adr/0010-phase-4-charter-operator-and-client-ux.md) — Phase 4 charter; documents why `/v1/messages` is not supported and points to Cline as the recommended Anthropic-CLI replacement.
- [ADR 0011](../adr/0011-anonymous-key-deployment-context.md) — trusted-LAN-only invariant for `auth.advertise_anonymous_key`.
- [`bin/olp-connect`](../../bin/olp-connect) — automated client setup helper (D68-D70).

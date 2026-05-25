# Cursor + OLP

[Cursor](https://cursor.com) is an AI-first VS Code fork. It has an
"Override OpenAI Base URL" setting that, when populated, routes its
default-model traffic to your URL using the OpenAI wire format.

**Status:** ⚠️ Best-effort.

**Reason:** Cursor's base-URL override is known to be fragile across
releases. Multiple 2025-2026 forum threads document the setting silently
reverting, model-list dropdowns not populating from the override URL, and
streaming responses falling back to the default backend on parse errors.
The behaviour is not specific to OLP — every OpenAI-compatible proxy
maintainer documents the same caveats — but Cursor's release cadence is
faster than most third-party proxies can test against.

## Quick setup

1. Open Cursor → Settings → "Models" → enable **OpenAI API Key**.
2. Paste your OLP plaintext token into the **API Key** field.
3. Click "Override OpenAI Base URL" and paste:

   ```
   http://127.0.0.1:4567/v1
   ```

4. Click "Verify". Cursor sends a probe; on success the indicator turns
   green.

5. **Crucial step:** in the model list, disable every model that is NOT
   in your `~/.olp/config.json` `routing.chains`. Cursor's chat will round-
   robin across enabled models and any model OLP can't route will error.

Replace the API key with the plaintext token printed by `olp-keys keygen
--name=cursor`. Family members on the LAN should substitute the OLP host's
IP for `127.0.0.1` (or use `olp-connect <ip>`).

## Known issues

- **Override URL silently reverts on Cursor update.** Two reported variants:
  (a) the field empties; (b) the field shows the OLP URL but Cursor still
  hits api.openai.com under the hood. Workaround: after every Cursor
  update, re-open settings, click "Verify" again, and check the OLP
  server's `/health` for incoming probe requests.

- **Model-list dropdown does not populate from the override URL.** Cursor
  hardcodes its model list rather than reading `GET /v1/models`. This is
  why step 5 above is required — there is no way to make Cursor "discover"
  your models. You have to disable each model individually that OLP can't
  serve.

- **Streaming response parsing is stricter than OpenAI's actual SSE spec.**
  Cursor occasionally falls back to the default backend if the SSE stream
  contains a slightly malformed chunk (e.g. an empty `data:` line that
  OpenAI's API does emit but Cursor's parser doesn't expect). OLP's SSE
  emitter follows the spec; this is on Cursor's side. If you see traffic
  hitting api.openai.com despite the override, this is the most likely
  cause.

- **Cursor's "Tab" autocomplete is NOT covered by the override.** Tab
  completion uses a Cursor-proprietary endpoint that is not affected by the
  OpenAI base URL setting. Only the chat panel is. This is documented
  Cursor behaviour and is not a bug.

## OLP-specific notes

Cursor sends `model: "gpt-4"` or `model: "gpt-3.5-turbo"` (legacy aliases)
unless you explicitly select another from its dropdown. Add aliases to
your `~/.olp/config.json` `routing.chains` so these route somewhere sane:

```json
{
  "routing": {
    "chains": {
      "gpt-4":         [ { "provider": "openai", "model": "gpt-5" } ],
      "gpt-3.5-turbo": [ { "provider": "openai", "model": "gpt-5-mini" } ]
    }
  }
}
```

(Substitute the OpenAI Codex model names listed by `olp models`.)

## Recommendation

**Do not engineer workarounds for Cursor-side bugs.** Cursor's release
cadence will fix or re-break the override URL handling at unpredictable
intervals. If your daily-driver flow is unreliable, switch to Cline (see
[`cline.md`](./cline.md)) — it has a stable OpenAI-compatible provider
that does not break across releases.

## Test it

```bash
curl -sI -X POST http://127.0.0.1:4567/v1/chat/completions \
  -H "Authorization: Bearer olp_XXXXXX" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"ok"}],"max_tokens":5}' \
  | grep -i x-olp
```

After hitting "Send" in Cursor's chat, check the OLP server's recent
requests via:

```bash
npx olp logs 10
```

If you don't see Cursor's request in the audit log, traffic isn't reaching
OLP — re-check the override URL.

## Cross-references

- Cursor forum threads on base-URL fragility: https://forum.cursor.com/ (search "OpenAI base URL")
- [`olp-connect`](../../bin/olp-connect) writes Cursor's `cursorrc` if
  detected, but cannot guarantee the override survives a Cursor update.

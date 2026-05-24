# OpenAI Spec Pin (v0.1 baseline)

- **Date pinned:** 2026-05-24 (D30)
- **Status:** v0.1 baseline — annual audit per ALIGNMENT.md § Annual Alignment Audit
- **Authority:** OpenAI Chat Completions API + Models API

This document is the spec-diff baseline against which OLP's annual audit will compare
future OpenAI spec changes. It enumerates the specific spec sections OLP currently
implements as the entry surface, verified against `lib/ir/openai-to-ir.mjs` and
`lib/ir/ir-to-openai.mjs` at the time of pinning.

---

## Endpoints implemented

### POST /v1/chat/completions

- Spec section: https://platform.openai.com/docs/api-reference/chat/create
- Retrieval timestamp: 2026-05-24

**Request body fields supported** (translated into IR by `openAIToIR` in
`lib/ir/openai-to-ir.mjs`):

| Field | Type | Required | Notes |
|---|---|---|---|
| `model` | string | required | Passed through to IR; validated non-empty |
| `messages` | array | required | Non-empty; each element translated via `translateMessage` |
| `messages[i].role` | string | required | `system` / `user` / `assistant` / `tool`; deprecated `function` normalized to `tool` |
| `messages[i].content` | string\|null | required | `null` normalized to `''` |
| `messages[i].name` | string | optional | Passed through to IR |
| `messages[i].tool_call_id` | string | optional | Passed through to IR |
| `messages[i].tool_calls` | array | optional | `{id, type:'function', function:{name, arguments}}` |
| `messages[i].function_call` | object | optional | Deprecated field; mapped to a single `tool_calls` entry |
| `stream` | boolean | optional | Default `false`; `true` triggers SSE path |
| `temperature` | number | optional | Range `[0, 2]`; passed to IR |
| `max_tokens` | integer | optional | Must be a positive integer; passed to IR |
| `top_p` | number | optional | Range `[0, 1]`; passed to IR |
| `stop` | string \| array | optional | Passed to IR as-is |
| `tools` | array | optional | Only `type:'function'` tools supported; translated via `translateTools` |
| `tools[i].function.name` | string | required (in tool) | Passed through |
| `tools[i].function.description` | string | optional | Passed through if present |
| `tools[i].function.parameters` | object | optional | Passed through if present |
| `tool_choice` | `'auto'`\|`'none'`\|`'required'`\|`{type:'function',function:{name}}` | optional | Passed to IR verbatim |
| `response_format` | object | optional | Passed to IR verbatim |

**Request body fields NOT yet supported** (silently dropped by entry surface — not
read in `openAIToIR`):

- `n` — multiple completions; OLP is single-completion only
- `seed` — deterministic sampling
- `frequency_penalty`, `presence_penalty`
- `logit_bias`
- `logprobs`, `top_logprobs`
- `user`
- `service_tier`
- `parallel_tool_calls`
- `stream_options`

**Response shape (non-streaming)** — `object: 'chat.completion'`
(assembled by `irResponseToOpenAINonStream` in `lib/ir/ir-to-openai.mjs`):

```json
{
  "id": "chatcmpl-<base64url>",
  "object": "chat.completion",
  "created": <unix-epoch-seconds>,
  "model": "<model-string-from-request>",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "<string-or-null>",
      "tool_calls": [ ... ]
    },
    "finish_reason": "<stop|length|tool_calls|content_filter|function_call|null>"
  }],
  "usage": { ... }
}
```

- `usage` is included only when the provider surfaces token counts on the final chunk.
- `message.tool_calls` is included only when tool calls are present.
- `message.content` is `null` when there is no text content and tool calls are present.

**Response shape (streaming)** — `object: 'chat.completion.chunk'`
(emitted by `irChunkToOpenAISSE` in `lib/ir/ir-to-openai.mjs`):

```json
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":<ts>,"model":"<m>","choices":[{"index":0,"delta":{"role":"assistant","content":"..."},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":<ts>,"model":"<m>","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

- `delta` carries `role` (first chunk only), `content` (text chunks), or `tool_calls` (tool call chunks).
- Final stop chunk has `finish_reason` set and empty `delta`.
- `usage` is included in the stop chunk only when the provider surfaces token counts.
- Stream terminator: `data: [DONE]\n\n`.

**`finish_reason` enum honored** (normalized by `normalizeFinishReason`; non-spec values
normalized to `'stop'`):

- `stop` — natural completion
- `length` — truncated at `max_tokens` or synthesized on truncation (D19/D16)
- `tool_calls` — model stopped to emit a tool call
- `content_filter` — provider-side content filter
- `function_call` — deprecated; preserved for backwards compatibility
- `null` — in-progress (streaming delta chunks)

**Error response shape:**

HTTP 4xx/5xx with body:
```json
{ "error": { "message": "<string>", "type": "<string>" } }
```

No invented top-level `error` field on `chat.completion` objects (per ALIGNMENT.md
Rule 2 — D12 finding). Errors surface exclusively via HTTP status codes with the above
body shape.

---

### GET /v1/models

- Spec section: https://platform.openai.com/docs/api-reference/models/list
- Retrieval timestamp: 2026-05-24

Response shape (`handleModels` in `server.mjs`):

```json
{ "object": "list", "data": [ ... ] }
```

Each entry: `{ "id": "<model-id>", "object": "model", "created": <ts>, "owned_by": "<provider-key>" }` —
no invented fields (per D27 F15). Alias entries are also surfaced as separate list members
(per D27 F15 alias surfacing).

---

### GET /health

OLP-specific endpoint (not in OpenAI spec). Returns:
```json
{ "ok": true, "version": "<semver>", "providers": { "enabled": <n>, "available": <n> } }
```

---

## Streaming SSE semantics

- MIME: `text/event-stream`
- Per-chunk framing: `data: <json>\n\n`
- Terminator: `data: [DONE]\n\n`
- Truncation marker: `finish_reason: 'length'` synthesized when the provider generator
  exhausts without a natural stop chunk (D26 F19 — mirrors D16 buffered-path semantics)
- Response headers on stream: `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
  `Connection: keep-alive`, `X-Accel-Buffering: no` plus OLP diagnostic headers

---

## Audit method

Annual audit (target 2027-05-14): re-fetch each cited URL above, diff against the field
lists above, file an ADR amendment for any newly-shipped OpenAI field or changed semantic
that OLP should implement. Consult `lib/ir/openai-to-ir.mjs` and `lib/ir/ir-to-openai.mjs`
as the implementation source of truth.

---

## Scope note: v0.1 baseline

This is a minimal baseline. v1.0+ should expand coverage to include the "NOT yet
supported" fields above where OLP intends to support them (via `openAIToIR` amendments +
ADR 0003 updates).

/**
 * lib/ir/ir-to-openai.mjs — IR v1.0 → OpenAI Chat Completions response translation
 *
 * Authority: ADR 0003 § "Translation direction model" (symmetric)
 * Entry-surface authority: OpenAI Chat Completions API response shape
 *   https://platform.openai.com/docs/api-reference/chat/object
 *   https://platform.openai.com/docs/api-reference/chat/streaming
 *
 * Produces OpenAI-shaped responses from IR response chunks so that the
 * entry surface (server.mjs) can emit them to clients without knowing
 * which provider generated them.
 */

import { randomBytes } from 'node:crypto';

// ── ID generation ─────────────────────────────────────────────────────────

/**
 * Generates a random chat-completion request ID.
 * OpenAI format: chatcmpl-<alphanumeric>
 * @returns {string}
 */
export function generateRequestId() {
  return `chatcmpl-${randomBytes(12).toString('base64url')}`;
}

// ── Streaming translation ─────────────────────────────────────────────────

/**
 * Converts a single IRResponseChunk to an OpenAI SSE event string.
 *
 * Per OpenAI streaming spec, each chunk is a `chat.completion.chunk` object
 * with a `choices[0].delta` field.
 *
 * @param {import('./types.mjs').IRResponseChunk} irChunk
 * @param {string} requestId - from generateRequestId()
 * @param {string} model - the model string from the IR request
 * @returns {string} SSE line in the form `data: {...}\n\n`
 */
export function irChunkToOpenAISSE(irChunk, requestId, model) {
  const created = Math.floor(Date.now() / 1000);

  if (irChunk.type === 'stop') {
    const chunk = {
      id: requestId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: irChunk.finish_reason ?? 'stop',
      }],
    };
    // Include usage if the provider surfaced token counts on the final chunk
    if (irChunk.usage) {
      chunk.usage = irChunk.usage;
    }
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  // Note: type === 'error' is intentionally not handled here.
  // Error chunks are converted to thrown ProviderError in server.mjs before
  // they reach this translator (see collectAllChunks and the real-streaming
  // error path). Per ALIGNMENT.md Rule 2 (b), adding a top-level `error`
  // field on chat.completion.chunk objects is a spec violation — OpenAI errors
  // surface via HTTP 4xx/5xx with {error: {...}} body, not in-band SSE fields.
  // If an error chunk somehow reaches here it falls through to the delta path
  // which is a no-op (no content/role/tool_calls), producing an empty delta.

  // type === 'delta'
  const delta = {};
  if (irChunk.role !== undefined) {
    delta.role = irChunk.role;
  }
  if (typeof irChunk.content === 'string' && irChunk.content !== '') {
    delta.content = irChunk.content;
  } else if (irChunk.content === '') {
    // Empty string delta is valid — pass through (first chunk often role-only + empty content)
    delta.content = '';
  }
  if (Array.isArray(irChunk.tool_calls) && irChunk.tool_calls.length > 0) {
    delta.tool_calls = irChunk.tool_calls;
  }

  const chunk = {
    id: requestId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{
      index: 0,
      delta,
      finish_reason: null,
    }],
  };

  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** SSE stream terminator per OpenAI spec */
export const SSE_DONE = 'data: [DONE]\n\n';

// ── Non-streaming translation ─────────────────────────────────────────────

/**
 * Assembles a non-streaming OpenAI chat.completion object from an array of
 * IR response chunks (all chunks already collected from the provider).
 *
 * @param {import('./types.mjs').IRResponseChunk[]} irChunks
 * @param {string} requestId
 * @param {string} model
 * @returns {object} OpenAI chat.completion object
 */
export function irResponseToOpenAINonStream(irChunks, requestId, model) {
  let content = '';
  let finish_reason = 'stop';
  let usage = null;
  const tool_calls = [];

  for (const chunk of irChunks) {
    if (chunk.type === 'delta') {
      if (typeof chunk.content === 'string') {
        content += chunk.content;
      }
      if (Array.isArray(chunk.tool_calls)) {
        tool_calls.push(...chunk.tool_calls);
      }
    } else if (chunk.type === 'stop') {
      if (chunk.finish_reason) {
        finish_reason = chunk.finish_reason;
      }
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }
    // Note: type === 'error' is intentionally not handled here.
    // Error chunks are converted to thrown ProviderError in server.mjs
    // (collectAllChunks) before this function is ever called. Adding a
    // top-level `error` field on chat.completion objects violates
    // ALIGNMENT.md Rule 2 (b) — OpenAI errors surface via HTTP 4xx/5xx
    // with {error: {...}} body, not as invented response fields.
  }

  const message = {
    role: 'assistant',
    content: content || null,
  };
  if (tool_calls.length > 0) {
    message.tool_calls = tool_calls;
    if (!content) message.content = null;
  }

  const response = {
    id: requestId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason,
    }],
  };

  if (usage) {
    response.usage = usage;
  }

  return response;
}

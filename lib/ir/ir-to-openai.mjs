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

  if (irChunk.type === 'error') {
    // SSE error chunk. ALIGNMENT.md Rule 2 (b) forbids inventing
    // `finish_reason` values not in OpenAI's enum
    // (https://platform.openai.com/docs/api-reference/chat/streaming
    //  enumerates: stop, length, tool_calls, content_filter, function_call,
    //  null). Surface the error via the top-level `error` object and use
    //  finish_reason: 'stop' on the choice — clients that respect the
    //  enum see a valid terminator; clients that read the `error` field
    //  see the failure detail.
    const chunk = {
      id: requestId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{
        index: 0,
        delta: { content: '' },
        finish_reason: 'stop',
      }],
      error: { message: irChunk.error ?? 'Unknown provider error', type: 'provider_error' },
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

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
  let errorChunk = null;
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
    } else if (chunk.type === 'error') {
      // Surface provider errors via the top-level `error` annotation on the
      // response object below + an inline content marker. `finish_reason`
      // stays 'stop' because ALIGNMENT.md Rule 2 (b) forbids inventing
      // enum values OpenAI's spec does not define
      // (https://platform.openai.com/docs/api-reference/chat/object —
      //  finish_reason ∈ {stop, length, tool_calls, content_filter,
      //  function_call, null}).
      content += chunk.error ? `[provider error: ${chunk.error}]` : '[provider error]';
      errorChunk = chunk;
    }
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

  if (errorChunk) {
    response.error = {
      message: errorChunk.error ?? 'Unknown provider error',
      type: 'provider_error',
    };
  }

  return response;
}

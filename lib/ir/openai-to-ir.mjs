/**
 * lib/ir/openai-to-ir.mjs — OpenAI Chat Completions → IR v1.0 translation
 *
 * Authority: ADR 0003 § "Translation direction model" and § "Required/Optional fields"
 * Entry-surface authority: OpenAI Chat Completions API
 *   https://platform.openai.com/docs/api-reference/chat/create
 *
 * This is the entry adapter — the single point where an OpenAI-shaped request
 * is normalized into the IR. Provider plugins never see the OpenAI shape;
 * they receive only the IR (ADR 0003 § "IR is not exposed externally").
 */

import { createHash } from 'node:crypto';
import { IR_VERSION, validateIRRequest } from './types.mjs';

// ── Custom error ──────────────────────────────────────────────────────────

export class BadRequestError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'BadRequestError';
    this.statusCode = 400;
  }
}

// ── Role normalization ────────────────────────────────────────────────────

/**
 * OpenAI deprecated role='function' in favour of role='tool'.
 * Per ADR 0003, IR supports system/user/assistant/tool.
 * @param {string} role
 * @returns {string}
 */
function normalizeRole(role) {
  if (role === 'function') return 'tool';
  return role;
}

// ── Message translation ───────────────────────────────────────────────────

/**
 * @param {object} msg - an OpenAI message object
 * @returns {import('./types.mjs').IRMessage}
 */
function translateMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    throw new BadRequestError('Each message must be an object');
  }

  const irMsg = {
    role: normalizeRole(msg.role),
    content: msg.content ?? '',
  };

  // content can be null for tool/function calls in OpenAI shape — normalise to ''
  if (irMsg.content === null) {
    irMsg.content = '';
  }

  if (msg.name !== undefined) {
    irMsg.name = String(msg.name);
  }
  if (msg.tool_call_id !== undefined) {
    irMsg.tool_call_id = String(msg.tool_call_id);
  }
  // OpenAI also uses function_call (deprecated) — treat as equivalent to tool_calls
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    irMsg.tool_calls = msg.tool_calls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.function?.name ?? '',
        arguments: tc.function?.arguments ?? '',
      },
    }));
  } else if (msg.function_call && typeof msg.function_call === 'object') {
    // Deprecated OpenAI function_call field — map to single tool_calls entry.
    // ID is deterministic: sha256(name + NUL + arguments).slice(0,16) so that
    // two identical function_call requests produce the same IR → same cache key.
    // Using Date.now() here would violate ADR 0005 invariant "same inputs → same key,
    // no random, no timestamp" (F3 cold-audit finding, round-5).
    const fcName = msg.function_call.name ?? '';
    // Canonicalize empty-args to '{}' BEFORE hashing so the hash input matches the
    // emitted IR field exactly. Otherwise `arguments: ''` and `arguments: '{}'` would
    // emit identical IR but compute different ids → different cache keys for
    // semantically-identical requests. Folded in per D33 F3 reviewer non-blocking #1.
    const fcArgs = msg.function_call.arguments || '{}';
    const fcKey = createHash('sha256')
      .update(`${fcName}\0${fcArgs}`)
      .digest('hex')
      .slice(0, 16);
    irMsg.tool_calls = [{
      id: `fc-${fcKey}`,   // deterministic — same input → same id
      type: 'function',
      function: {
        name: fcName,
        arguments: fcArgs,
      },
    }];
  }

  return irMsg;
}

// ── Tool definitions ──────────────────────────────────────────────────────

/**
 * @param {object[]} tools - OpenAI tools array
 * @returns {import('./types.mjs').IRToolDefinition[]}
 */
function translateTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((t, i) => {
    if (t.type !== 'function' || !t.function) {
      throw new BadRequestError(`tools[${i}]: only type='function' tools are supported in IR v1.0`);
    }
    return {
      type: 'function',
      function: {
        name: t.function.name,
        ...(t.function.description !== undefined && { description: t.function.description }),
        ...(t.function.parameters !== undefined && { parameters: t.function.parameters }),
      },
    };
  });
}

// ── Main translator ───────────────────────────────────────────────────────

/**
 * Translates an OpenAI Chat Completions request body into IR v1.0.
 *
 * Throws BadRequestError on validation failure.
 *
 * @param {object} openAIRequest - parsed JSON body from POST /v1/chat/completions
 * @returns {import('./types.mjs').IRRequest}
 */
export function openAIToIR(openAIRequest) {
  if (!openAIRequest || typeof openAIRequest !== 'object') {
    throw new BadRequestError('Request body must be a JSON object');
  }

  if (!openAIRequest.model || typeof openAIRequest.model !== 'string') {
    throw new BadRequestError('Request body must include a non-empty "model" string');
  }

  if (!Array.isArray(openAIRequest.messages) || openAIRequest.messages.length === 0) {
    throw new BadRequestError('Request body must include a non-empty "messages" array');
  }

  /** @type {import('./types.mjs').IRRequest} */
  const ir = {
    irVersion: IR_VERSION,
    model: openAIRequest.model,
    stream: openAIRequest.stream === true,
    messages: openAIRequest.messages.map((m, i) => {
      try {
        return translateMessage(m);
      } catch (e) {
        throw new BadRequestError(`messages[${i}]: ${e.message}`);
      }
    }),
  };

  // Optional numeric fields — type-coerce if needed
  if (openAIRequest.max_tokens !== undefined && openAIRequest.max_tokens !== null) {
    const v = Number(openAIRequest.max_tokens);
    if (!Number.isInteger(v) || v <= 0) {
      throw new BadRequestError('max_tokens must be a positive integer');
    }
    ir.max_tokens = v;
  }

  if (openAIRequest.temperature !== undefined && openAIRequest.temperature !== null) {
    const v = Number(openAIRequest.temperature);
    if (isNaN(v) || v < 0 || v > 2) {
      throw new BadRequestError('temperature must be a number in [0, 2]');
    }
    ir.temperature = v;
  }

  if (openAIRequest.top_p !== undefined && openAIRequest.top_p !== null) {
    const v = Number(openAIRequest.top_p);
    if (isNaN(v) || v < 0 || v > 1) {
      throw new BadRequestError('top_p must be a number in [0, 1]');
    }
    ir.top_p = v;
  }

  if (openAIRequest.stop !== undefined && openAIRequest.stop !== null) {
    if (typeof openAIRequest.stop !== 'string' && !Array.isArray(openAIRequest.stop)) {
      throw new BadRequestError('stop must be a string or array of strings');
    }
    ir.stop = openAIRequest.stop;
  }

  if (openAIRequest.tools !== undefined && openAIRequest.tools !== null) {
    ir.tools = translateTools(openAIRequest.tools);
  }

  if (openAIRequest.tool_choice !== undefined && openAIRequest.tool_choice !== null) {
    ir.tool_choice = openAIRequest.tool_choice;
  }

  if (openAIRequest.response_format !== undefined && openAIRequest.response_format !== null) {
    ir.response_format = openAIRequest.response_format;
  }

  // Validate the constructed IR — belt-and-suspenders
  const { valid, errors } = validateIRRequest(ir);
  if (!valid) {
    throw new BadRequestError(`IR validation failed: ${errors.join('; ')}`);
  }

  return ir;
}

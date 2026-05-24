/**
 * lib/ir/types.mjs — IR v1.0 type definitions and validators
 *
 * Authority: ADR 0003 § "Required fields" and "Optional fields"
 * The IR is OLP-internal; there is no external IR endpoint.
 * Per ADR 0003, the IR encodes the common subset that every provider
 * plugin can consume, with lossy edges documented per-provider.
 */

// ── Constants ──────────────────────────────────────────────────────────────

export const IR_VERSION = '1.0';

/** Per ADR 0003 § Required fields. role='function' is OpenAI-deprecated; openai-to-ir.mjs maps it to 'tool'. */
export const VALID_ROLES = ['system', 'user', 'assistant', 'tool'];

// ── JSDoc typedefs ────────────────────────────────────────────────────────

/**
 * @typedef {Object} IRToolCall
 * @property {string} id
 * @property {'function'} type
 * @property {{ name: string, arguments: string }} function
 */

/**
 * @typedef {Object} IRMessage
 * @property {'system'|'user'|'assistant'|'tool'} role
 * @property {string|Array<{type:string,[key:string]:any}>} content
 * @property {string} [name]
 * @property {IRToolCall[]} [tool_calls]
 * @property {string} [tool_call_id]
 */

/**
 * @typedef {Object} IRToolDefinition
 * @property {'function'} type
 * @property {{ name: string, description?: string, parameters?: object }} function
 */

/**
 * @typedef {Object} IRRequest
 * @property {string} [irVersion] - optional; when present must equal IR_VERSION ('1.0'). Pre-D35 IRs lack this field and remain valid.
 * @property {IRMessage[]} messages
 * @property {string} model
 * @property {boolean} stream
 * @property {number} [max_tokens]
 * @property {number} [temperature]
 * @property {number} [top_p]
 * @property {string|string[]} [stop]
 * @property {IRToolDefinition[]} [tools]
 * @property {string|object} [tool_choice]
 * @property {object} [response_format]
 */

/**
 * @typedef {Object} IRResponseChunk
 * @property {'delta'|'stop'|'error'} type
 * @property {string} [content]  - present when type==='delta'
 * @property {string} [role]     - present on first delta
 * @property {IRToolCall[]} [tool_calls] - present when provider emits tool-use in stream
 * @property {string} [finish_reason]   - present when type==='stop'
 * @property {string} [error]           - present when type==='error'
 * @property {Object} [usage]
 * @property {number} [usage.prompt_tokens]
 * @property {number} [usage.completion_tokens]
 * @property {number} [usage.total_tokens]
 */

// ── Validators ────────────────────────────────────────────────────────────

/**
 * @param {*} obj
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateIRMessage(obj) {
  const errors = [];
  if (obj === null || typeof obj !== 'object') {
    errors.push('message must be an object');
    return { valid: false, errors };
  }
  if (!VALID_ROLES.includes(obj.role)) {
    errors.push(`role must be one of ${VALID_ROLES.join('|')}, got ${JSON.stringify(obj.role)}`);
  }
  if (obj.content === undefined || obj.content === null) {
    errors.push('content is required');
  } else if (typeof obj.content !== 'string' && !Array.isArray(obj.content)) {
    errors.push('content must be a string or array of content parts');
  }
  if (obj.name !== undefined && typeof obj.name !== 'string') {
    errors.push('name must be a string when present');
  }
  if (obj.tool_call_id !== undefined && typeof obj.tool_call_id !== 'string') {
    errors.push('tool_call_id must be a string when present');
  }
  if (obj.tool_calls !== undefined) {
    if (!Array.isArray(obj.tool_calls)) {
      errors.push('tool_calls must be an array when present');
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * @param {*} obj
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateIRRequest(obj) {
  const errors = [];
  if (obj === null || typeof obj !== 'object') {
    errors.push('IR request must be an object');
    return { valid: false, errors };
  }

  // Required: messages
  if (!Array.isArray(obj.messages)) {
    errors.push('messages must be an array');
  } else {
    obj.messages.forEach((m, i) => {
      const r = validateIRMessage(m);
      if (!r.valid) {
        r.errors.forEach(e => errors.push(`messages[${i}]: ${e}`));
      }
    });
    if (obj.messages.length === 0) {
      errors.push('messages must not be empty');
    }
  }

  // Required: model
  if (typeof obj.model !== 'string' || obj.model.trim() === '') {
    errors.push('model must be a non-empty string');
  }

  // Required: stream
  if (typeof obj.stream !== 'boolean') {
    errors.push('stream must be a boolean');
  }

  // Optional: max_tokens
  if (obj.max_tokens !== undefined && (!Number.isInteger(obj.max_tokens) || obj.max_tokens <= 0)) {
    errors.push('max_tokens must be a positive integer when present');
  }

  // Optional: temperature [0,2]
  if (obj.temperature !== undefined) {
    if (typeof obj.temperature !== 'number' || obj.temperature < 0 || obj.temperature > 2) {
      errors.push('temperature must be a number in [0,2] when present');
    }
  }

  // Optional: top_p [0,1]
  if (obj.top_p !== undefined) {
    if (typeof obj.top_p !== 'number' || obj.top_p < 0 || obj.top_p > 1) {
      errors.push('top_p must be a number in [0,1] when present');
    }
  }

  // Optional: stop
  if (obj.stop !== undefined) {
    if (typeof obj.stop !== 'string' && !Array.isArray(obj.stop)) {
      errors.push('stop must be a string or array of strings when present');
    }
  }

  // Optional: tools
  if (obj.tools !== undefined && !Array.isArray(obj.tools)) {
    errors.push('tools must be an array when present');
  }

  // Optional: response_format — object with .type (string)
  if (obj.response_format !== undefined) {
    if (typeof obj.response_format !== 'object' || obj.response_format === null) {
      errors.push('response_format must be an object');
    } else if (typeof obj.response_format.type !== 'string') {
      errors.push('response_format.type must be a string');
    }
  }

  // Optional: irVersion — must be '1.0' if present; undefined accepted for pre-existing IRs
  // Per ADR 0003 § Required fields: analogous to contractVersion='1.0' in base.mjs.
  // Decision: undefined accepted because openai-to-ir.mjs sets irVersion on construction;
  // pre-existing IRs without it still validate. Strict '1.0' rejection only when explicitly
  // set wrong.
  if (obj.irVersion !== undefined && obj.irVersion !== '1.0') {
    errors.push(`irVersion must be '1.0' (got: ${JSON.stringify(obj.irVersion)})`);
  }

  // Optional: tool_choice — 'auto' | 'none' | 'required' | {type:'function', function:{name}}
  if (obj.tool_choice !== undefined) {
    if (typeof obj.tool_choice === 'string') {
      if (!['auto', 'none', 'required'].includes(obj.tool_choice)) {
        errors.push("tool_choice string must be 'auto' | 'none' | 'required'");
      }
    } else if (typeof obj.tool_choice === 'object' && obj.tool_choice !== null) {
      if (obj.tool_choice.type !== 'function') {
        errors.push("tool_choice.type must be 'function'");
      } else if (typeof obj.tool_choice.function !== 'object' || obj.tool_choice.function === null) {
        errors.push('tool_choice.function must be an object');
      } else if (typeof obj.tool_choice.function.name !== 'string') {
        errors.push('tool_choice.function.name must be a string');
      }
    } else {
      errors.push('tool_choice must be a string or an object');
    }
  }

  return { valid: errors.length === 0, errors };
}

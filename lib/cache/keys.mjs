/**
 * lib/cache/keys.mjs — Cache key generation for OLP
 *
 * Authority: ADR 0005 § Cache key composition (v1.0) — amended 2026-05-24 by Amendment 2 (D15)
 *
 * Cache keys are computed over the IR (ADR 0003), not over the raw OpenAI
 * request shape, so key stability is governed by OLP's own release cadence.
 *
 * Key composition:
 *   sha256(JSON.stringify({
 *     provider,
 *     model,
 *     messages: normalizeMessages(ir.messages),
 *     tools: ir.tools ?? null,
 *     temperature: ir.temperature ?? null,
 *     response_format: ir.response_format ?? null,
 *     cache_control: extractCacheControlMarkers(ir.messages),
 *     // Added by D15 (Amendment 2) — ADR 0003 § Optional fields that affect output:
 *     max_tokens: ir.max_tokens ?? null,
 *     top_p: ir.top_p ?? null,
 *     stop: ir.stop ?? null,
 *     tool_choice: ir.tool_choice ?? null,
 *   }))
 *
 * Per ADR 0005 § Per-model isolation: (provider, model) is part of the key.
 * Cross-provider cache contamination is structurally impossible.
 *
 * Ported from OCP keys.mjs cacheHash() — generalized to include provider +
 * model, uses JSON stable-key approach instead of incremental hash-update to
 * support content arrays and tool definitions.
 */

import { createHash } from 'node:crypto';

// ── Message normalization ─────────────────────────────────────────────────

/**
 * Normalizes an IR message array for stable cache-key hashing.
 * Strips unknown fields, normalizes content arrays to stable-keyed JSON.
 *
 * Fields kept per IR contract (ADR 0003):
 *   role, content, name, tool_calls, tool_call_id
 *
 * @param {Array<object>} messages
 * @returns {Array<object>}
 */
function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];

  return messages.map(msg => {
    if (!msg || typeof msg !== 'object') return msg;

    const norm = {};

    // role is mandatory
    if (msg.role !== undefined) norm.role = msg.role;

    // content: string as-is; array → normalized recursive form
    if (typeof msg.content === 'string') {
      norm.content = msg.content;
    } else if (Array.isArray(msg.content)) {
      norm.content = normalizeContentArray(msg.content);
    } else if (msg.content !== undefined) {
      norm.content = msg.content;
    }

    // Optional fields carried in IR
    if (msg.name !== undefined) norm.name = msg.name;
    if (msg.tool_calls !== undefined) norm.tool_calls = normalizeToolCalls(msg.tool_calls);
    if (msg.tool_call_id !== undefined) norm.tool_call_id = msg.tool_call_id;

    return norm;
  });
}

/**
 * Normalizes a content array into stable-keyed JSON form.
 * Each part is serialized with keys in sorted order so that
 * equivalent parts are byte-identical regardless of property insertion order.
 *
 * @param {Array<object>} parts
 * @returns {string} — JSON string with sorted keys per part
 */
function normalizeContentArray(parts) {
  if (!Array.isArray(parts)) return parts;
  return parts.map(part => {
    if (!part || typeof part !== 'object') return part;
    // Sort keys for stable serialization
    return Object.fromEntries(
      Object.keys(part).sort().map(k => [k, part[k]])
    );
  });
}

/**
 * Normalizes tool_calls arrays, keeping only fields relevant to cache key.
 *
 * @param {Array<object>|undefined} toolCalls
 * @returns {Array<object>|undefined}
 */
function normalizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return toolCalls;
  return toolCalls.map(tc => {
    if (!tc || typeof tc !== 'object') return tc;
    const norm = {};
    if (tc.id !== undefined) norm.id = tc.id;
    if (tc.type !== undefined) norm.type = tc.type;
    if (tc.function !== undefined) norm.function = tc.function;
    return norm;
  });
}

// ── cache_control marker extraction ──────────────────────────────────────

/**
 * Extracts Anthropic cache_control markers from an IR messages array.
 * Used as a prerequisite for D2 (cache_control bypass).
 *
 * Searches messages and nested content arrays for cache_control objects.
 * Per ADR 0005 § D2: Anthropic cache_control markers in the IR request
 * bypass OLP's response cache when the active provider is Anthropic.
 *
 * @param {Array<object>} messages
 * @returns {Array<object>} — array of found cache_control marker objects
 */
export function extractCacheControlMarkers(messages) {
  const markers = [];

  for (const msg of messages ?? []) {
    if (!msg || typeof msg !== 'object') continue;

    // Top-level cache_control on the message itself
    if (msg.cache_control && typeof msg.cache_control === 'object') {
      markers.push(msg.cache_control);
    }

    // Nested cache_control inside content array parts
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && typeof part === 'object' && part.cache_control && typeof part.cache_control === 'object') {
          markers.push(part.cache_control);
        }
      }
    }
  }

  return markers;
}

/**
 * Returns true if the IR request contains any Anthropic cache_control markers.
 * Shortcut for the D2 bypass check in the server dispatch path.
 *
 * Ported from OCP keys.mjs hasCacheControl() — extended to check IR request
 * shape (ir.messages) rather than raw OpenAI messages array.
 *
 * @param {object} ir — IR request object (ADR 0003)
 * @returns {boolean}
 */
export function hasCacheControl(ir) {
  if (!ir || !Array.isArray(ir.messages)) return false;
  return extractCacheControlMarkers(ir.messages).length > 0;
}

// ── Per-request fingerprint (provider-agnostic) ───────────────────────────

/**
 * Computes a stable per-request fingerprint over IR fields that define the
 * request semantics (independent of provider/model). Used by fallback engine
 * (D28 round-3 F2) to correlate per-hop log events from the same logical
 * request. Returns first 16 hex characters of SHA-256 for compact log lines.
 *
 * Fields included (must mirror the cache key composition without (provider, model)):
 *   messages (normalized), tools, temperature, max_tokens, top_p, stop,
 *   tool_choice, response_format
 *
 * Note: cache_control is intentionally excluded here — it is a routing hint,
 * not a semantic field that changes the request's logical identity for
 * observability purposes.
 *
 * @param {object} ir
 * @returns {string} — 16-character hex digest
 */
export function computeIRRequestHash(ir) {
  // Use normalizeMessages so semantically-identical message arrays produce
  // identical hashes (e.g. content array vs string normalization).
  const subset = {
    messages: normalizeMessages(ir.messages ?? []),
    tools: ir.tools ?? null,
    temperature: ir.temperature ?? null,
    max_tokens: ir.max_tokens ?? null,
    top_p: ir.top_p ?? null,
    stop: ir.stop ?? null,
    tool_choice: ir.tool_choice ?? null,
    response_format: ir.response_format ?? null,
  };
  return createHash('sha256').update(JSON.stringify(subset)).digest('hex').slice(0, 16);
}

// ── Cache key computation ─────────────────────────────────────────────────

/**
 * Computes a content-addressed SHA-256 cache key over the IR request.
 *
 * Per ADR 0005 § Cache key composition (v1.0) — amended 2026-05-24 by Amendment 2 (D15):
 *   key = sha256(JSON.stringify({
 *     provider, model, messages, tools, temperature, response_format, cache_control,
 *     max_tokens, top_p, stop, tool_choice
 *   }))
 *
 * The key is deterministic: same inputs → same key. No random, no timestamp.
 * Numbers are included if non-default (null/undefined excluded to keep keys narrow).
 *
 * Cross-provider contamination is impossible: (provider, model) is part of every key.
 *
 * @param {string} provider — provider name, e.g. 'anthropic'
 * @param {string} model — model string, e.g. 'claude-haiku-4-5'
 * @param {object} ir — IR request (ADR 0003): { messages, tools?, temperature?, response_format?, cache_control?, max_tokens?, top_p?, stop?, tool_choice? }
 * @param {object} [_options] — reserved for future options (not used at D5)
 * @returns {string} — 64-character hex SHA-256 digest
 */
export function computeCacheKey(provider, model, ir, _options = {}) {
  const normalized = normalizeMessages(ir.messages ?? []);
  const cacheControlMarkers = extractCacheControlMarkers(ir.messages ?? []);

  // Only include fields that affect model output. Omit null/undefined to keep
  // keys narrow (a request with no temperature and one with temperature=null
  // produce the same key).
  //
  // Note on `cache_control`: this slot is in the key for forward-compatibility
  // with a future ADR 0003 amendment that preserves cache_control markers in
  // the IR. In v1.0 IR (the current schema), openAIToIR() strips cache_control
  // because it's not an IR field, so this extractCacheControlMarkers(ir.messages)
  // call always returns [] and the slot is always `null` here. The D2 bypass
  // path in server.mjs side-channels through the raw body to compensate. Do
  // NOT remove the slot — once IR carries cache_control, this key composition
  // is already correct.
  const keyObj = {
    provider,
    model,
    messages: normalized,
    tools: ir.tools ?? null,
    temperature: ir.temperature ?? null,
    response_format: ir.response_format ?? null,
    cache_control: cacheControlMarkers.length > 0 ? cacheControlMarkers : null,
    // D15 (ADR 0005 Amendment 2): IR fields from ADR 0003 § Optional fields that affect output.
    // Appended after the existing seven fields to avoid invalidating ordering-dependent keys.
    max_tokens: ir.max_tokens ?? null,
    top_p: ir.top_p ?? null,
    stop: ir.stop ?? null,
    tool_choice: ir.tool_choice ?? null,
  };

  return createHash('sha256').update(JSON.stringify(keyObj)).digest('hex');
}

# ADR 0003 — Intermediate Representation (IR) Design

- **Date:** 2026-05-23
- **Status:** Accepted (bootstrap)
- **Authors:** project maintainer (with AI drafting assistance)
- **Related:** OLP v0.1 spec §4.1, §4.2 (IR subsection); ADR 0002 (plugin architecture); ADR 0004 (fallback engine — requires shape-stable requests for safe replay)

## Context

OLP exposes exactly one external API surface: OpenAI-compatible `/v1/chat/completions` (per spec §4.1). Internally, OLP fans out to N providers, each with its own native protocol — Anthropic Messages API, OpenAI Chat Completions, Mistral La Plateforme, xAI Grok, Moonshot Kimi, etc. The combinatorial fact is unavoidable: a request entering as OpenAI shape must exit as Anthropic shape (or Mistral shape, or whatever the routing chain advances to), and the response on the way back must travel the inverse path.

The ad-hoc approach is per-provider entry-to-native translation:

```
provider.spawn(openAIRequest) {
  const native = openAIToProviderNative(openAIRequest);  // per-provider impl
  ...
  const openAIResponse = providerNativeToOpenAI(nativeResponse);  // per-provider impl
  return openAIResponse;
}
```

At three providers, that's six translation functions (three forward + three reverse). At eight providers it's sixteen. None of them share code — Anthropic-to-OpenAI and Mistral-to-OpenAI have different shape mismatches, different tool-calling translations, different streaming-event mappings. The "OpenAI-shape canonical" assumption privileges one provider's protocol as the lingua franca, which is wrong: OpenAI's Chat Completions is OLP's *entry* surface, not OLP's *internal* representation. Anchoring internal logic on the entry surface means every entry-surface change (a new OpenAI field, a deprecated OpenAI field, a new OpenAI streaming-event variant) ripples through every provider plugin.

The structural answer is an **Intermediate Representation (IR)**: a canonical OLP-internal shape that *all* provider plugins consume (forward) and produce (reverse). The entry adapter translates OpenAI → IR once. Each provider plugin translates IR → native and native → IR. The combinatorial cost goes from N² to 2N: one entry adapter + N provider translators.

The IR is not OpenAI Chat Completions, and it is not Anthropic Messages. It is a *deliberately-OLP-owned* shape, normalized to be expressible in every provider's native shape with documented lossy fields where a provider's expressiveness is narrower than the IR. Choosing IR shape carefully — neither so rich it cannot round-trip through Mistral, nor so narrow it loses Anthropic's tool_use semantics — is the load-bearing design decision of this ADR.

The fallback engine (ADR 0004) is a second consumer of IR's shape stability. When a request fails over from Anthropic to OpenAI, the IR that was constructed at the entry point is replayed against the next provider. If the IR were a thin OpenAI wrapper, replay against OpenAI would be trivial but replay against Mistral or xAI would re-run the same shape-translation pain. A properly-OLP-owned IR makes replay symmetric across providers.

## Decision

OLP defines an Intermediate Representation (IR) as the canonical internal shape between the OpenAI-compat entry surface and each provider plugin. Per spec §4.2 (IR subsection), the IR v1.0 encodes:

**Required fields:**
- `messages[]` — each with `role`, `content`, optional `name`, optional `tool_calls`, optional `tool_call_id`. Roles supported: `system`, `user`, `assistant`, `tool`.
- `model` — the user-requested model string. The provider plugin maps this to the provider-native model identifier (e.g., `claude-sonnet-4-6` → `claude-sonnet-4-6-20260301` for Anthropic).
- `stream` — boolean. SSE expected on the entry side iff true.

**Optional fields:**
- `max_tokens` — integer; provider plugins clamp to provider-supported maxima.
- `temperature` — float [0, 2]; provider plugins map to provider-native range (e.g., Anthropic uses [0, 1]).
- `top_p` — float [0, 1].
- `stop` — string or string[]; provider plugins handle the single-vs-array shape difference per native protocol.
- `tools[]` + `tool_choice` — function-calling subset. v1.0 supports basic function definitions (`name`, `description`, `parameters` JSON-schema); advanced features (parallel tool use, tool result handling beyond single round-trip) are per-provider documented as caveats per spec §8 Q-C.
- `response_format` — best-effort; provider-specific (e.g., Anthropic does not natively honor a `response_format: json_object` field, so this becomes a system-prompt augmentation on that provider).

**Translation direction model.** Each provider plugin owns two translation functions:

```js
// IR → provider-native shape
const nativeRequest = provider.irToNative(irRequest);

// provider-native response chunk → IR response chunk
const irChunk = provider.nativeToIR(nativeChunk);
```

The entry adapter (`server.mjs`'s `/v1/chat/completions` handler) owns the inverse:

```js
const irRequest = openAIToIR(openAIRequest);
const irResponseStream = await provider.spawn(irRequest, authContext);
for await (const irChunk of irResponseStream) {
  res.write(irToOpenAI(irChunk));
}
```

**Lossy-translation documentation requirement.** When a provider plugin's `irToNative` or `nativeToIR` cannot losslessly carry an IR field (e.g., Mistral Vibe does not support `tool_choice: "required"`), the lossy edge is documented in the provider plugin's header comment AND in `docs/provider-caveats.md` (📋 planned — not yet authored; until it exists, lossy translations are recorded only in the provider plugin header comments). The caveats document is referenced from `/v1/models` response metadata so clients can see provider-specific limits without reading source.

**IR is versioned.** This ADR ratifies IR v1.0. Future additions (e.g., a `reasoning_effort` field if reasoning-model behavior diverges enough across providers to warrant explicit modeling) require an amendment ADR. Removals are breaking changes and require a major-version bump of OLP.

**The IR is not exposed externally.** It is OLP-internal. There is no `/v1/ir/*` endpoint, no client SDK in IR shape, no documented external IR contract. The only public contract is OpenAI `/v1/chat/completions`; the IR is an implementation detail that the maintainer (and the maintainer's reviewers) reason about, not a contract with clients.

## Consequences

**Positive**
- Adding a provider is N translation functions (one IR→native, one native→IR), not 2N (one openai→native, one native→openai for every provider). The maintenance burden of "OpenAI shipped a new field" is one entry-adapter change, not one change per provider.
- The fallback engine (ADR 0004) replays the same IR object across providers in a chain. Replay correctness depends on IR being a fixed-shape data structure; there is no per-provider state leaking through that the next chain hop has to re-derive.
- Lossy translations are documented per-provider and surfaced to clients via `docs/provider-caveats.md` (📋 planned) + `/v1/models` metadata. A client choosing a fallback chain can see "this chain's third hop is Mistral, which does not support tool_choice=required" *before* they hit the failure mode.
- The IR is OLP's source of truth for "what was actually requested" for cache-key generation (ADR 0005). Caching on OpenAI shape would couple cache keys to OpenAI field naming; caching on IR makes the cache key provider-agnostic.

**Negative**
- Two translation layers per request: openai→IR at entry, IR→native at provider. That's two passes of object construction per request, plus the inverse on the way back. For family-scale traffic this is unmeasurable; at higher scale the overhead would need profiling.
- IR design decisions are sticky. Choosing the wrong shape for `tool_calls` in v1.0 (e.g., privileging OpenAI's parallel-tool-call shape over Anthropic's single-tool shape) would force every provider plugin to work around the bad choice forever. IR v1.0 is intentionally narrow (basic function calling only) to give the maintainer space to expand the IR with informed amendments rather than commit too early.
- The IR is a third concept (alongside OpenAI shape and per-provider native shape) that every contributor must internalize. Onboarding a new contributor means teaching three shapes, not two. The PR template and OLP ALIGNMENT.md call out the IR explicitly so contributors know which shape applies in which layer of code.

**Mitigations**
- IR v1.0 is deliberately a subset, not a superset, of what providers can do. Where providers diverge in expressive power (tool calling, structured outputs, reasoning modes), the IR encodes the *common subset* in v1.0, with caveats documenting provider extensions. Expanding the IR to cover provider extensions is an explicit amendment, not a silent generalization.
- Each provider plugin includes a `__irRoundTripTest()` export that exercises the plugin's `irToNative` + `nativeToIR` pair against a fixture set in `test-features.mjs`. Round-trip discrepancies fail CI. This is the structural counter-measure against the silent-lossy-translation failure mode.
- The IR has no external surface. If IR v1.0 turns out to be the wrong shape and IR v2.0 is incompatible, the migration is OLP-internal: provider plugins are updated, the entry adapter is updated, no client code changes. The cost of being wrong is bounded by the project's own codebase.

## Alternatives considered

**(a) Full pass-through with no normalization — OpenAI request goes straight to each provider plugin.** Provider plugins each implement their own openai→native + native→openai. Rejected: this is the N² shape the IR exists to avoid. Worse, it makes the fallback engine (ADR 0004) harder, because each fallback hop has to redo openai→native; there is no canonical "what was requested" object to replay. The shape-stability invariant the fallback engine depends on becomes per-provider rather than systemic.

**(b) Per-provider entry endpoints — `/v1/anthropic/messages`, `/v1/openai/chat/completions`, `/v1/mistral/...`.** Each entry endpoint speaks its provider's native shape; no translation. Rejected: this just relocates the N² problem to the client side — each client now needs N integrations (one per provider's wire format), and the unified-endpoint value proposition (spec §1: "one HTTP endpoint, multiple subscriptions behind it") is dead on arrival. Cross-provider fallback also stops being client-transparent: clients have to know about the fallback because they have to switch endpoints when the primary fails.

**(c) Use Anthropic Messages format as the IR (Anthropic-native as canonical).** This privileges Anthropic's shape as OLP's internal language. Rejected on two grounds: (1) Anthropic is currently one provider in eight; privileging its shape codifies provider preference into the IR, which is the wrong abstraction layer; (2) Anthropic-shape is rich enough to be lossy when translated to spartans like Mistral Vibe, so the IR would have features no other provider could use without elaborate fallback in the translator. The IR should be neutral, with provider extensions documented per-plugin, not Anthropic-shaped with per-plugin de-features.

**(d) Use OpenAI Chat Completions as the IR (entry-surface as canonical).** Privileges OpenAI shape. Rejected: this is the implicit shape of alternative (a), just lifted into a named layer. The coupling to OpenAI's evolving spec means every OpenAI deprecation / addition is a cross-cutting change. The IR exists precisely to decouple OLP-internal logic from OpenAI's release cadence.

**(e) Defer IR design and start with two providers tightly coupled (Anthropic + OpenAI), refactor to IR when adding the third.** Rejected: this defers the architectural decision into a code-rewrite-under-pressure moment (adding Mistral while two providers are in production). The pattern of "we'll abstract it later" is what produced the hybrid awkwardness OCP ADR 0005 warned against. Pay the IR cost up front, with v1.0 deliberately narrow, and expand via amendment.

## Sources

- OLP v0.1 spec §4.1 (Single-protocol entry: OpenAI-compatible)
- OLP v0.1 spec §4.2 (Plugin-based provider system, including IR subsection)
- OLP v0.1 spec §8 Q-C (Tool-calling translation differences across providers — informs why IR v1.0 keeps tool calling to a basic subset)
- OCP ADR 0003 (`models.json` SPOT) — informs the "OLP-owned canonical shape, not external surface" framing

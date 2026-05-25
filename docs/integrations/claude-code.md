# Claude Code + OLP

[Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) is
Anthropic's official terminal-native agent. It speaks the Anthropic
`/v1/messages` wire format and cannot be configured to use an
OpenAI-compatible chat-completions endpoint.

**Status:** ❌ Not supported.

## Why

OLP serves only the OpenAI `/v1/chat/completions` wire format. Adding
`/v1/messages` (the Anthropic shape) was explicitly considered for
Phase 4 and rejected, per
[ADR 0010 § Out of Phase 4 scope](../adr/0010-phase-4-charter-operator-and-client-ux.md).

The short version of the rationale:

- **No billing benefit.** After Anthropic's 2026-06-15 split, `claude -p` /
  Agent SDK / third-party agent traffic moves out of the Pro/Max
  subscription pool and into a separate paid Agent SDK Credit pool. OLP's
  fallback discipline ("when one provider's quota runs out, try the next")
  does not save money for this traffic — it just routes the same paid
  request to a different paid backend. The subscription leverage that
  makes OLP valuable for OpenAI-shape traffic does not exist for
  Anthropic-shape traffic.

- **Degrades worse on fallback.** When OLP's primary chain entry (Anthropic)
  is exhausted, the fallback hop is typically OpenAI Codex or Mistral Vibe.
  Those providers speak OpenAI tool-calling schema; OLP would have to
  translate Anthropic's `/v1/messages` tool shape into OpenAI tool shape on
  every fallback. That translation is lossy and is what ADR 0010 calls out
  as "net non-positive under P0 failure".

- **Same outcome reachable via the recommended alternative.** Cline, Cursor,
  Aider, and Continue.dev all speak OpenAI's wire format and have parity
  with Claude Code on the "AI edits files in my repo" use case. OLP serves
  them today.

## What to use instead

**Recommended:** [Cline](./cline.md). It's an in-IDE autonomous coder that
operates on the same loop Claude Code does (read files, propose edits,
run tools, iterate). The "OpenAI Compatible" provider points cleanly at
OLP's `/v1/chat/completions` endpoint. You get OLP's full fallback chain
(Anthropic → OpenAI Codex → Mistral) instead of being pinned to one
provider.

For terminal users specifically:

- **[Aider](./aider.md)** if you want the Claude-Code-style git-aware
  pair programmer in the terminal.
- **OpenClaw** if you want Telegram/Discord-driven access to the
  fallback chain (see [`openclaw.md`](./openclaw.md)).

## Re-open trigger

ADR 0010 documents the conditions under which OLP would reconsider
`/v1/messages`:

> (a) ADR 0009 P0 confirms interactive-mode billing classification as
> subscription (≥ 2026-07-15) AND (b) maintainer explicitly opens
> Phase 5 "Anthropic-shape hub" scope with the name of at least one
> family member who wants CC access.

Until both conditions fire, OLP intentionally does not implement
`/v1/messages`. The decision is recorded in ADR 0010 § "Out of Phase 4
scope" and ADR 0009 (Anthropic interactive-mode path placeholder).

## If you absolutely must use Claude Code

Point Claude Code at api.anthropic.com directly. OLP cannot proxy that
traffic. You will:

- Burn against the Anthropic Pro/Max OAuth subscription (pre-2026-06-15) or
  the Agent SDK Credit pool (≥ 2026-06-15).
- Lose every fallback property OLP provides — when Anthropic's quota is
  exhausted, Claude Code stops working until the quota resets.
- Lose OLP's response headers (`X-OLP-Provider-Used` etc.), audit log
  entries, cache hits, and `/health` visibility.

This is documented here only so the trade-off is explicit, not as a
recommendation.

## Cross-references

- [ADR 0010](../adr/0010-phase-4-charter-operator-and-client-ux.md) § "Out of Phase 4 scope" — full defer rationale.
- [ADR 0009](../adr/0009-interactive-mode-path-placeholder.md) — Anthropic 2026-06-15 billing split and re-open trigger.
- [`cline.md`](./cline.md) — the recommended alternative for Claude-Code-style workflows.

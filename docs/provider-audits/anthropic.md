# Anthropic provider — version-capture artifact

- **Provider key:** `anthropic`
- **Plugin file:** `lib/providers/anthropic.mjs`
- **Last capture:** 2026-05-24 (D36 #15)
- **Capture host:** project maintainer's primary workstation (home-mac)
- **Status:** living artifact — re-capture at every plugin touch, or annually
  during the 14 May Annual Alignment Audit, whichever comes first.

This artifact closes the circular-citation finding from Round-6 (issue #15):
ALIGNMENT.md § Provider Authority Pins anthropic row cites `@anthropic-ai/claude-code`
v2.1.89 (observed at D4) without an independent transcript; the plugin header cited
the observation date but pointed back to ALIGNMENT.md. This file is the in-repo
transcript artifact that grounds the OLP-side claim.

---

## Observed `claude --version`

The live binary on the maintainer's workstation today is:

```
2.1.132 (Claude Code)
```

Captured by running `claude --version` in a non-interactive shell on 2026-05-24.

## Plugin-pinned version

```
@anthropic-ai/claude-code v2.1.89
```

Source: ALIGNMENT.md § Authorities § "Provider authority pins" row `anthropic`
("OLP-side pin: `@anthropic-ai/claude-code` v2.1.89 (observed at D4 —
`lib/providers/anthropic.mjs` header)"). This is the version observed inside
the OLP-side D4 work; the plugin was authored against this version's flag
surface.

## Version drift note

The pinned version (v2.1.89, D4) and the live binary (v2.1.132, today) differ
because the `claude` CLI has continued to ship updates since D4. This drift is
within tolerance for the v0.1 baseline:

- The CLI flags OLP consumes — `-p`, `--output-format=text`,
  `--no-session-persistence`, `--model`, `--debug` — are all still present and
  semantically unchanged in v2.1.132 (verified today via `claude -p --help`
  — see "Flag surface captured today" below).
- The pin in ALIGNMENT.md is conservative by design — it names the version OLP
  was authored against, not the highest version known to work. Re-pinning to
  v2.1.132 (or whichever version is current) is the right action at the next
  Anthropic-plugin touch, when a reviewer can confirm no regressions.
- Re-audit recommended at: (a) next material change to
  `lib/providers/anthropic.mjs`, OR (b) 14 May 2027 Annual Alignment Audit,
  OR (c) the post-2026-06-15 one-shot triggered audit (ALIGNMENT.md
  § One-shot Triggered Audits) — whichever comes first.

## Sample invocation

The Anthropic plugin spawns the CLI with this argument shape (see
`lib/providers/anthropic.mjs` § `buildClaudeArgs` and `_spawnAndStream`):

```
claude -p --output-format text --no-session-persistence --model <model> [--debug]
```

- `-p` puts the CLI in non-interactive (print-and-exit) mode.
- `--output-format text` selects plain-text stdout. The plugin parses stdout as
  plain text (no NDJSON envelope).
- `--no-session-persistence` disables session storage so OLP remains stateless
  (per ADR 0001 § Non-mission — OLP is not a conversation-state store).
- `--model <model>` is forwarded from the IR's `model` field.
- `--debug` is added only when `OLP_DEBUG_CLAUDE` env is set, for development.

The prompt is written to the CLI's stdin (`messagesToPrompt(ir.messages)` from
`anthropic.mjs`), not passed as a positional argument.

## Flag surface captured today

Excerpt from `claude -p --help` on host home-mac on 2026-05-24 (v2.1.132). Only
the flags relevant to OLP's invocation are reproduced; the full help is much
larger.

| Flag | Description (verbatim, abridged) |
|---|---|
| `-p, --print` | Print response and exit (useful for pipes). |
| `--output-format <format>` | Output format (only works with --print): "text" (default), "json" (single result), or "stream-json" (realtime streaming) — choices: "text", "json", "stream-json". |
| `--no-session-persistence` | Disable session persistence — sessions will not be saved to disk and cannot be resumed (only works with --print). |
| `--model <model>` | Model for the current session. Provide an alias for the latest model (e.g. 'sonnet' or 'opus') or a model's full name (e.g. 'claude-sonnet-4-6'). |
| `-d, --debug [filter]` | Enable debug mode with optional category filtering (e.g., "api,hooks" or "!1p,!file"). |

All four load-bearing flags (`-p`, `--output-format`, `--no-session-persistence`,
`--model`) are present and accept the same value formats the OLP plugin uses.
The `--debug` flag is also present with the same semantics.

## Citation cross-references

- ALIGNMENT.md § Authorities § "Provider authority pins" anthropic row — names
  this file as the transcript-artifact pin.
- `lib/providers/anthropic.mjs` header lines 1-50 — names this file as the
  version-capture artifact (D26 F18 follow-up).
- ADR 0001 § Mission inheritance — establishes `claude -p` as Authority 1
  source for the `anthropic` plugin.
- ADR 0005 Amendment 5 (D31 F11) — clarifies the wire limitation of
  `claude -p --output-format text` w.r.t. cache_control marker delegation.

## Recapture procedure

When this artifact is next refreshed (per the "Version drift note" trigger
list), the maintainer should:

1. Run `claude --version` on the project maintainer's primary workstation.
2. Run `claude -p --help` and verify that `-p`, `--output-format`,
   `--no-session-persistence`, `--model`, and `--debug` are all still present
   with the same value formats.
3. Update the "Last capture", "Observed `claude --version`", and "Flag surface
   captured today" sections with the new values.
4. If any flag's semantic has changed (not just a version bump), file an ADR
   amendment on `lib/providers/anthropic.mjs` Authority 1 source and pin the
   new version in ALIGNMENT.md.
5. If `claude -p --help` no longer enumerates one of OLP's load-bearing flags,
   the plugin is broken against the new CLI — file a deletion or migration PR
   per ALIGNMENT.md Rule 4 (Unalignable Plugins / Fields Are Deleted).

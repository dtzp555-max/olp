# ADR 0011 — Anonymous-Key Deployment-Context Limits (Trusted-LAN Invariant)

**Status:** Accepted (2026-05-26)
**Date:** 2026-05-26
**D-day:** D70 (lands alongside D68 `olp-connect` + D69 `/health.anonymousKey`)

---

## Context

ADR 0010 § Phase 4 D68-D70 charter scoped a three-deliverable bundle:

- **D68** `olp-connect <ip>` — client-side bash script that auto-configures a
  family member's machine to point at a remote OLP instance, including IDE
  detection (Cline / Continue.dev / Cursor / Aider / OpenClaw) and rc-file +
  system-level env var writes.
- **D69** `/health.anonymousKey` field — opt-in (`auth.advertise_anonymous_key:
  true` in `~/.olp/config.json`; default `false`) surface that emits the
  plaintext of a designated guest-tier key so `olp-connect` can pick it up
  with zero-config (no out-of-band token paste).
- **D70** this ADR — codifies the deployment-context limits that make D69
  safe.

The D69 mechanism is a deliberate port of OCP's clever `PROXY_ANONYMOUS_KEY` +
`/health.anonymousKey` pattern (OCP `server.mjs:148, 1454, 1488, 1555`,
shipped 2026-04 under OCP issue #12 § 14 Path A) which made family-member
onboarding go from "maintainer texts API key + edits IDE config" to
`curl -fsSL .../ocp-connect | bash -s -- <ip>`. The OCP pattern works on
trusted family LAN deployments; it would catastrophically fail on a public
internet deployment. ADR 0011 makes the trust assumption explicit before OLP
inherits the pattern.

The ADR also pins three implementation details that are NOT obvious from
reading the D69 patch alone:

1. The plaintext token must live on disk SOMEWHERE for the server to surface
   it. ADR 0007 § 5 + § 6.2 explicitly forbid plaintext storage in the
   default manifest. D69 introduces an explicit **opt-in** `plaintext_advertise`
   manifest field for ONLY the advertised key — every other key retains the
   ADR 0007 § 5 hash-only contract.
2. The advertised key is **guest-tier**, not owner-tier. Owner-tier
   advertisement is rejected at keygen time AND at config-load time —
   exposing the owner identity unauthenticated would grant any LAN caller
   `/health` full payload, `/v0/management/*` mutating access, and
   `X-OLP-Fallback-Detail` visibility — the exact inverse of the advertise
   key's intent (a low-privilege zero-config tier).
3. Three prerequisites MUST hold simultaneously for `/health.anonymousKey`
   to be emitted; missing any one is logged at startup but the server still
   boots — graceful-degrade rather than refuse-to-start.

---

## Decision

### Three-prerequisite gate (server-side)

`/health` emits the `anonymousKey` field if and only if ALL THREE hold:

1. `auth.advertise_anonymous_key === true` in `~/.olp/config.json` (default
   `false` — opt-in).
2. `auth.allow_anonymous === true` (the anonymous tier must be reachable for
   the advertised key to be meaningful to zero-config callers; advertising a
   key into a deployment that rejects anonymous requests is incoherent).
3. At least one active (`revoked_at === null`) manifest under `~/.olp/keys/`
   carries a non-empty `plaintext_advertise: "olp_..."` field.

When prerequisite (1) holds but (2) or (3) fails, the server logs a
startup warn (`anonymous_key_advertised_but_denied` or
`anonymous_key_advertised_but_no_anonymous_key_exists`) but starts normally
and simply omits the field from `/health` responses.

### Plaintext storage mechanism (`plaintext_advertise` manifest field)

ADR 0007 § 5 forbids plaintext storage anywhere. D69 introduces a single,
**explicitly opt-in** exception: the manifest of the designated advertised
key gains a `plaintext_advertise` field whose value is the plaintext token.

This field is written ONLY when the operator runs:

```
olp-keys keygen --anonymous --advertise
```

(or `--advertise` alone on a guest-tier `keygen` invocation; `--anonymous`
is a friendly shorthand for `--tier=guest --name=anonymous`). The keygen
command surfaces an explicit `WARNING` to stderr at creation time:

```
WARNING: this key's plaintext is now stored on disk + will be exposed via
         /health.anonymousKey when auth.advertise_anonymous_key=true AND
         auth.allow_anonymous=true. Use ONLY on a trusted LAN. See ADR 0011.
```

Every other key (every existing key, and every newly-created key without
`--advertise`) retains the ADR 0007 § 5 hash-only contract — `manifest.json`
contains `token_hash` and NEVER `plaintext_advertise`.

**Schema-version note (D69 reviewer P2-2).** This adds a new optional field
to the manifest. Per ADR 0007 § 4 ("Increment `schema_version` on any
non-additive change"), additive optional fields do NOT require a
`schema_version` bump — older parsers ignore unknown fields per the same
section's forward-compat rule. The manifest stays at `schema_version: 1`.
Documented here so a future archaeologist asking "why didn't D69 bump
`schema_version`?" has a one-line answer.

**`listKeys()` redaction (D69 reviewer P2-1).** `lib/keys.mjs listKeys()`
strips BOTH `token_hash` AND `plaintext_advertise` from its return value.
Callers wanting the advertised plaintext for the `/health` publication
path MUST go through `findAdvertisedKey()` — the only sanctioned read
site. This protects against a future caller of `listKeys()` accidentally
emitting the plaintext into logs / HTTP responses / dashboards.

### Tier restriction (guest only)

`createKey()` rejects `plaintext_advertise: true` for `owner_tier: 'owner'`
with the error `createKey: plaintext_advertise requires owner_tier="guest"`.
The CLI also rejects `--owner --advertise` with a clear error pointing at
this ADR.

Rationale: owner-tier confers `/health` full payload visibility,
`/v0/management/*` mutating access, and `X-OLP-Fallback-Detail` header
visibility. Advertising owner-tier plaintext unauthenticated would let any
LAN caller assume the owner identity — the exact opposite of the design
intent.

### Trusted-LAN deployment invariant

`auth.advertise_anonymous_key: true` is permitted ONLY when the OLP server
is bound to a trust-equivalent address space:

| Tier | Address space | Permitted? |
|------|---------------|------------|
| Loopback | `127.0.0.0/8` | yes |
| RFC 1918 LAN | `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` | yes |
| Tailnet | `100.64.0.0/10` (CGNAT range used by Tailscale) | yes |
| Localhost domains | `localhost`, `*.local`, `*.internal` | yes |
| Public internet | any routable IPv4/IPv6 outside the above | NO |

This is a **soft constraint** at v0.4.0 — OLP does not enforce IP-allowlist
or BIND_ADDRESS inspection. The constraint is documented here, surfaced in
README § "Anonymous-key advertise mode (trusted-LAN-only)", and warned-but-
not-blocked at server startup when `auth.advertise_anonymous_key=true` and
the bind address looks public.

Hard enforcement (refuse to start when bind is public + advertise enabled)
is deferred. The maintainer's deployments are LAN-only, the family-scale
audience cannot tolerate a startup-refuse mode that bricks the proxy on
ambiguous network topology (e.g., TLS-fronted private network where the
underlying bind IP IS public but the network itself is trusted), and the
trade-off in ADR 0010 explicitly accepted operator-discretion gates for
soft constraints of this class.

---

## Threat model

The advertised anonymous key is **public** within the boundary of "anyone
who can reach `GET /health`." Anyone within that boundary can read the
plaintext from `/health.anonymousKey` and use it for `/v1/chat/completions`,
`/v1/models`, etc.

| Deployment | Boundary | Acceptable? |
|------------|----------|-------------|
| Mac mini + Tailscale, only family devices on tailnet | family devices | YES |
| Home LAN with no guest WiFi, no port-forward | household + neighbors-within-WiFi-range | YES (within risk tolerance) |
| Home LAN with guest WiFi joined to same VLAN as proxy | EVERYONE who visits and connects to guest WiFi | borderline; treat with caution |
| Coffee shop / open WiFi | EVERYONE physically present | NO |
| Public internet via Cloudflare Tunnel / port-forward / VPS | EVERYONE on the internet | NO — instant compromise |

The capability gain for an attacker who reads `/health.anonymousKey` is
**equal to the capability the operator deliberately granted the
anonymous-tier key**:

- `providers_enabled` (when `'*'`, the attacker can dispatch any provider —
  burning the operator's subscription quotas).
- `/v1/chat/completions` access (LLM use under the operator's billing).
- Cache pollution under `__anonymous__` namespace (per ADR 0007 § 7.1; the
  advertised guest key uses its own `<key-id>` namespace — but anonymous
  callers who DON'T present the key use `__anonymous__`).

What the attacker does NOT get:

- `/health` full payload — gated to `owner_tier === 'owner'` (ADR 0007 § 7.1).
- `/v0/management/*` mutating endpoints — gated to owner (ADR 0008 § 7).
- `X-OLP-Fallback-Detail` header — `'owner_only'` policy default (ADR 0007 § 7.2).
- The owner key's plaintext (which is never stored anywhere; only its
  `token_hash` is on disk per ADR 0007 § 5).

The "burn the operator's subscription quotas" failure mode is bounded by
the per-provider quota limits AND the maintainer's monitoring (`/health`
owner-view shows quota status per provider; `/v0/management/audit` shows
per-key usage). Detection is fast; the question is how much quota the
attacker can burn between compromise and key revocation.

---

## `olp-connect` integration (D68 client-side)

`bin/olp-connect <ip>` queries `GET /health` as its first action. If the
response contains `anonymousKey: "olp_..."`, the script uses that value
silently for the rest of the run (printing a one-line `Using server-
advertised anonymous key: olp_...XXXX` notice + a pointer to this ADR).
This is what makes `olp-connect <ip>` a true zero-config command — no
out-of-band token paste needed.

If `anonymousKey` is absent (the default, when `auth.advertise_anonymous_key`
is false), the script falls back to interactive prompt or `--key` flag.

`olp-connect` does NOT perform any of the trusted-LAN soft-checks itself —
it trusts that an operator who set `auth.advertise_anonymous_key: true`
knows their deployment context. The script does, however, document the
trade-off in its `--help` output and prints the ADR 0011 reference
alongside the "using server-advertised key" notice.

---

## Deployment configurations (D76 amendment, 2026-05-26)

Original ADR 0011 referenced a `BIND_ADDRESS` concept that did not exist in the v0.4.0–v0.4.2 codebase — the server was hard-coded to `server.listen(PORT, '127.0.0.1', ...)`. D76 closes this gap by adding the `OLP_BIND` env var (default `127.0.0.1`), making the deployment-context discussion below operational rather than aspirational.

Three deployment configurations are supported:

| `OLP_BIND` value | Reachability | Anonymous-key publication |
|---|---|---|
| `127.0.0.1` (default) | Loopback only | Safe with any auth posture (no LAN exposure at all) |
| RFC1918 IP / tailnet IP / `0.0.0.0` on a trusted LAN | LAN clients only | Safe when `advertise_anonymous_key: true` — the documented "trusted-LAN" zero-config family onboarding flow |
| Public IP / `0.0.0.0` on a public-facing host | Public internet | **Incompatible with `advertise_anonymous_key: true`.** Operator MUST keep `advertise_anonymous_key: false` (default). |

The server emits a startup warn event `anonymous_key_advertised_with_lan_bind` when `OLP_BIND` is non-loopback AND `advertise_anonymous_key: true` (per the `lib/keys.mjs` + `server.mjs` checks). The warn is a **checkpoint, not a hard gate** — the server cannot tell from the bind address alone whether the operator is on a trusted LAN (RFC1918 / tailnet) or has accidentally exposed a public IP. The Re-evaluation trigger #1 below escalates to a hard gate when OLP gains a public-internet deployment mode.

`olp-connect <ip>` consumes `/health.anonymousKey` over the network — therefore requires `OLP_BIND` to include the LAN interface on the server side. Without setting `OLP_BIND=<lan-ip>` (or `0.0.0.0`), `olp-connect <ip>` will fail with `connect ECONNREFUSED` because the server only accepts loopback connections.

---

## Re-evaluation triggers

Re-open this ADR when ANY of the following fires:

1. OLP gains a "expose to public internet" deployment mode in the README
   (e.g., Cloudflare Tunnel guidance, ngrok recipe). At that point the
   soft-constraint MUST become a hard constraint (bind-address inspection
   at startup, refusal to enable `advertise_anonymous_key` when bind is
   public — likely with a separate `OLP_TRUSTED_PUBLIC_OVERRIDE=1` env
   escape hatch for operators who run their own TLS termination).
2. The OCP `/health.anonymousKey` model is found to have caused a
   real-world quota-burn incident; that learning amends this ADR.
3. Phase 5 introduces multi-tenant SaaS-like deployments (currently
   non-goal per ADR 0001); the entire family-scale assumption is
   re-examined.

---

## Consequences

**Positive.**

- Family-member onboarding becomes a single command: `olp-connect <ip>`. No
  out-of-band token paste. No "wait, what's the API key?" friction loop.
- The trust trade-off is now an explicit, single-knob config decision, not
  an implicit consequence of OCP-pattern inheritance.
- The `plaintext_advertise` field is a single auditable on-disk surface —
  `grep plaintext_advertise ~/.olp/keys/*/manifest.json` answers "which key
  is advertised?" definitively, and an operator who wants to disable the
  feature can simply revoke that key.
- Owner-tier advertisement is impossible (both at keygen and at config
  load), eliminating an entire class of foot-gun.

**Negative.**

- ADR 0007 § 5's "no plaintext on disk, ever" property is weakened to "no
  plaintext on disk except for ONE explicitly-opted-in field on ONE key."
  The exception is narrow and audit-grep-able but the property is no
  longer absolute.
- Operators who enable advertise mode then move the deployment from LAN to
  public internet (e.g., add a Cloudflare Tunnel without revisiting the
  config) silently invert the threat model. The startup warn for "public
  bind detected" does not currently fire (soft constraint per § "Trusted-
  LAN deployment invariant" above).
- The OCP precedent shows operators sometimes share `olp-connect <ip>`
  invocations in chat / docs that include their IP; an LLM training corpus
  could harvest these IPs. The advertised key is only useful while the
  network reaches the IP, but the IP-disclosure surface grows.

**Neutral.**

- The plaintext storage is per-key, not global. Revoking the advertised key
  removes the plaintext exposure within one filesystem write (the manifest
  stays on disk for audit attribution per ADR 0007 § 6.1, but `revoked_at`
  becomes non-null and `findAdvertisedKey()` skips revoked manifests).

---

## Alternatives considered

1. **Store plaintext in `config.json` directly.** Rejected. Mixes secrets
   with operational config; complicates git-crypt boundary; loses the
   per-key revocation path (you'd have to edit JSON to "revoke" the
   exposure rather than running `olp-keys revoke --id=<id>`).
2. **Add an `anonymous` owner_tier instead of using `guest` + `plaintext_
   advertise`.** Rejected. Bumps ADR 0007 § 4 schema version (a
   non-additive change), adds a third identity class that the rest of the
   codebase (cache namespacing, /health gating, audit attribution) has no
   reason to know about, and conflicts with ADR 0007 § 7.1's "anonymous =
   no auth header + allow_anonymous=true" definition. A single optional
   field on the manifest is strictly less invasive.
3. **Hard-enforce trusted-LAN bind address at startup.** Rejected for
   v0.4.0; deferred until a public-deployment-mode README section ships
   (see Re-evaluation triggers § 1). Soft constraint + startup warn is
   appropriate while OLP has zero public-internet deployment recipes.
4. **Encrypt `plaintext_advertise` at rest with a key derived from
   `OLP_HOME` path or a separate `OLP_ADVERTISE_KEY` env var.** Rejected.
   The threat model is "anyone who can read `/health` reads the plaintext
   token over the wire," not "anyone who can read `~/.olp/keys/`." Both
   require LAN-reach; encrypting on-disk doesn't change the over-the-wire
   exposure. Adds complexity for no security gain in the relevant attack
   model.
5. **Make `--advertise` allowed only when `--name` is exactly `anonymous`.**
   Rejected as over-restrictive. The CLI's `--anonymous` shorthand
   defaults `--name=anonymous`, but operators may legitimately want a
   named advertised key (e.g., `family-guest`, `lan-zero-config`). The
   discriminator is the field, not the name.

---

## Authority citations

- **ADR 0007 § 7** (Identity-class table — anonymous tier definition;
  `__anonymous__` keyId).
- **ADR 0007 § 5** (Token format — establishes hash-only on-disk; D69 is
  the explicit opt-in exception).
- **ADR 0007 § 4** (Manifest schema — D69 adds optional `plaintext_advertise`
  field; § 4 already specifies "unrecognized fields cause a warn but not a
  reject (forward-compat)" so the addition is non-breaking for older
  parsers).
- **ADR 0007 § 7.2** (Configuration — D69 adds `auth.advertise_anonymous_key`
  alongside existing `allow_anonymous` / `owner_only_endpoints` /
  `fallback_detail_header_policy`).
- **ADR 0010 § Phase 4 charter D68-D70 row** (scope authority for this ADR).
- **OCP `server.mjs:148, 1454, 1488, 1555`** (prior-art for the
  `PROXY_ANONYMOUS_KEY` env + `/health.anonymousKey` pattern; OCP v3.13.0).
- **OCP issue #12 § 14 Path A** (the original anonymous-key decision
  context for OCP; the "Path A" label is OCP-specific and not used in
  OLP).
- **`bin/olp-connect`** (D68 client-side consumer of `/health.anonymousKey`).
- **`bin/olp-keys.mjs`** (D69 keygen `--advertise` flag implementation).
- **`lib/keys.mjs` `findAdvertisedKey()`** (D69 server-side resolver).
- **`server.mjs handleHealth`** (D69 emission point + startup-warn site).

---

## Procedural mechanism

CC 开发铁律 v1.6 § 10 (independent reviewer per implementation D-day) — D68
+ D69 + D70 ship as ONE PR per Iron Rule 11 IDR (the three deliverables
are mutually constituting: `olp-connect` consumes `/health.anonymousKey`,
`/health.anonymousKey` is governed by ADR 0011, ADR 0011 documents
`olp-connect`'s trust posture). The reviewer is a fresh-context opus
subagent.

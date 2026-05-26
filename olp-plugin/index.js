/**
 * OLP Plugin — registers /olp as a native slash command in the OpenClaw gateway.
 * Calls the local OLP proxy and formats the response for Telegram/Discord.
 *
 * Authority: ADR 0010 § Phase 4 D71-D73 (operator + client UX bundle). Ports
 * OCP's ocp-plugin/index.js (https://github.com/dtzp555-max/ocp /ocp/ocp-plugin)
 * to the OLP namespace with two structural differences:
 *
 *   1. **Read-only by design.** All mutating subcommands (`keygen`, `revoke`,
 *      `restart`, `logs`) are deliberately NOT ported. Telegram + Discord are
 *      shared / persistent surfaces; rotating an owner key or pulling raw audit
 *      logs from a chat client is a security regression. Use SSH + the local
 *      `olp` CLI for those operations.
 *
 *   2. **Bearer auth required.** OLP enforces multi-key auth at every /v1/* and
 *      /v0/management/* endpoint (ADR 0007 § 7). Owner-only subcommands need an
 *      OLP API key with owner_tier="owner". The plugin config carries that key;
 *      operators are advised to mint a dedicated bot key (NOT the maintainer's
 *      personal owner key) so revocation is scoped.
 *
 * Port resolution (in priority order):
 *   1. OLP_PROXY_URL env (full URL, e.g. http://10.0.0.5:4567)
 *   2. OLP_PORT env (port only; localhost assumed)
 *   3. Plugin config `proxyUrl`
 *   4. Fallback: http://127.0.0.1:4567 (OLP default port since v0.4.0 / D60)
 *
 * Subcommand parity with the local `olp` CLI (bin/olp.mjs at D64-D67) MINUS
 * mutating operations. Mapping table is in ./README.md.
 */

// ── Output helpers (Telegram/Discord-friendly) ─────────────────────────────

/** Wrap output in a monospace code block (Telegram + Discord render this fine). */
export function mono(text) {
  return "```\n" + text + "\n```";
}

/** ASCII progress bar — `pct` ∈ [0, 1] clamped. width=16 → 16 cells. */
export function bar(pct, width = 16) {
  const p = Number.isFinite(pct) ? Math.max(0, Math.min(1, pct)) : 0;
  const filled = Math.round(p * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Status icon — used in `/olp status` summary lines. */
export function statusIcon(status) {
  if (status === "ok" || status === true) return "🟢";
  if (status === "degraded" || status === "warn") return "🟡";
  return "🔴";
}

/** Truncate to fit Telegram's 4096-char message limit (with mono wrapper). */
export function truncateForChat(text, maxChars = 3900) {
  if (text.length <= maxChars) return text;
  const SUFFIX = "\n... [truncated, use SSH for full]";
  // Reserve room for the suffix so the final string is <= maxChars.
  const room = Math.max(0, maxChars - SUFFIX.length);
  return text.slice(0, room) + SUFFIX;
}

// ── Proxy URL resolution ───────────────────────────────────────────────────

/**
 * Resolve the proxy base URL. Order: OLP_PROXY_URL env → OLP_PORT env →
 * plugin config `proxyUrl` → default http://127.0.0.1:4567.
 *
 * Exported for test injection. Pass `env` to override `process.env` and
 * `config` to override the plugin config block.
 */
export function resolveProxyUrl({ env = process.env, config = {} } = {}) {
  if (env.OLP_PROXY_URL) return env.OLP_PROXY_URL;
  if (env.OLP_PORT) return `http://127.0.0.1:${env.OLP_PORT}`;
  if (config.proxyUrl) return config.proxyUrl;
  return "http://127.0.0.1:4567";
}

// ── HTTP helper ────────────────────────────────────────────────────────────

/**
 * Fetch a JSON endpoint. Sends Authorization: Bearer <apiKey> if provided.
 *
 * Exported so unit tests can inject a fetch mock via the `fetchFn` arg.
 */
export async function fetchJSON(url, { apiKey, fetchFn = fetch, timeoutMs = 15000 } = {}) {
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const resp = await fetchFn(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (resp.status === 401) {
    throw new Error(`401 unauthorized — set plugin "apiKey" config (owner-tier required for ${new URL(url).pathname})`);
  }
  if (resp.status === 403) {
    throw new Error(`403 forbidden — the configured key is not owner-tier (${new URL(url).pathname} is owner-only)`);
  }
  if (!resp.ok) {
    throw new Error(`proxy ${resp.status}: ${resp.statusText}`);
  }
  return resp.json();
}

// ── Subcommand formatters ──────────────────────────────────────────────────
//
// Each cmdXxx() is pure: takes the JSON body the server returned, returns a
// string. The dispatcher fetches + delegates. This split makes the formatters
// unit-testable without an HTTP mock.

export function fmtStatus(body) {
  const icon = statusIcon(body.ok ? "ok" : "fail");
  let out = `${icon} OLP v${body.version ?? "?"} | up ${body.uptime_human ?? "?"}\n`;
  out += `Providers: ${body.providers?.enabled ?? "?"} enabled / ${body.providers?.available ?? "?"} available\n`;
  if (body.providers?.status && typeof body.providers.status === "object") {
    for (const [name, s] of Object.entries(body.providers.status)) {
      const i = statusIcon(s?.ok ? "ok" : "fail");
      out += `  ${i} ${name.padEnd(10)} ${s?.error ? `(${String(s.error).slice(0, 40)})` : "ok"}\n`;
    }
  }
  out += `Requests: ${body.stats?.total_requests ?? 0} total | ${body.stats?.active_requests ?? 0} active\n`;
  const c = body.stats?.cache;
  if (c) {
    out += `Cache: ${c.hits ?? 0} hit / ${c.misses ?? 0} miss / ${c.size ?? "?"} entries\n`;
  }
  if (Array.isArray(body.recent_errors) && body.recent_errors.length > 0) {
    out += `\nRecent errors (${body.recent_errors.length}):\n`;
    for (const e of body.recent_errors.slice(0, 3)) {
      const ts = (e.time || "").slice(11, 19);
      const msg = String(e.message ?? "").slice(0, 60);
      out += `  ${ts} ${e.provider ?? "?"} ${msg}\n`;
    }
  }
  return out;
}

export function fmtHealth(body) {
  const icon = statusIcon(body.ok ? "ok" : "fail");
  let out = `${icon} Status: ${body.ok ? "ok" : "fail"} | v${body.version ?? "?"}\n`;
  if (body.uptime_human || body.uptimeHuman) {
    out += `Uptime: ${body.uptime_human ?? body.uptimeHuman}\n`;
  }
  // D74 P2-4 fix: server.mjs /health full payload is
  //   body.providers = { enabled: N, available: N, status: { <name>: {...} } }
  // The plugin previously iterated Object.entries(body.providers), which
  // surfaced `enabled`, `available`, and `status` as pseudo-providers
  // (typeof status === 'object' → loop body fired with name='status').
  // Walk providers.status when present; fall back to providers.* for the
  // older OCP shape that lacks the .status wrapper.
  if (body.providers && typeof body.providers === "object") {
    const enabled = body.providers.enabled;
    const available = body.providers.available;
    if (typeof enabled === "number" || typeof available === "number") {
      out += `Providers: ${enabled ?? "?"} enabled / ${available ?? "?"} available\n`;
    }
    const statusMap = body.providers.status && typeof body.providers.status === "object"
      ? body.providers.status
      : body.providers;
    const entries = Object.entries(statusMap).filter(
      ([name, s]) => typeof s === "object" && s !== null && name !== "enabled" && name !== "available" && name !== "status"
    );
    if (entries.length > 0) {
      out += `\nProviders:\n`;
      for (const [name, s] of entries) {
        const i = statusIcon(s?.ok ? "ok" : "fail");
        const spawn = typeof s?.activeSpawns === "number" ? `  spawns=${s.activeSpawns}` : "";
        out += `  ${i} ${name}${spawn}\n`;
      }
    }
  }
  return out;
}

export function fmtUsage(body) {
  let out = "OLP usage (24h)\n";
  out += "─────────────────────────────\n";
  const w = body.window_24h ?? body.usage_24h ?? {};
  if (w.requests !== undefined) {
    out += `Requests:  ${w.requests}\n`;
    out += `Cache hit: ${w.cache_hit_rate != null ? `${(w.cache_hit_rate * 100).toFixed(1)}%` : "?"}\n`;
    out += `Fallbacks: ${w.fallbacks ?? "?"}\n`;
  } else if (typeof body.cache_hit_24h === "number") {
    // Dashboard-data shape: cache_hit_24h is a rate ∈ [0,1]
    out += `Cache hit (24h): ${(body.cache_hit_24h * 100).toFixed(1)}%\n`;
  }
  if (Array.isArray(body.quota) && body.quota.length > 0) {
    out += `\nPer-provider quota:\n`;
    for (const q of body.quota) {
      const pct = typeof q.percent_used === "number" ? q.percent_used : null;
      const bar0 = pct != null ? ` ${bar(pct / 100, 12)} ${pct.toFixed(0)}%` : " no quota api";
      out += `  ${String(q.name ?? "?").padEnd(10)}${bar0}\n`;
    }
  }
  if (Array.isArray(body.top_fallback_chains_24h) && body.top_fallback_chains_24h.length > 0) {
    out += `\nTop fallback chains (24h):\n`;
    for (const f of body.top_fallback_chains_24h.slice(0, 5)) {
      out += `  ${String(f.count ?? "?").padStart(5)}  ${(f.chain ?? []).join(" → ")}\n`;
    }
  }
  return out;
}

export function fmtModels(body) {
  const data = body.data ?? [];
  if (data.length === 0) return "No models.";
  let out = `Models (${data.length})\n`;
  out += "─────────────────────────────\n";
  for (const m of data) {
    out += `  ${m.id}${m.owned_by ? `  (${m.owned_by})` : ""}\n`;
  }
  return out;
}

export function fmtCache(body) {
  let out = "OLP cache\n";
  out += "─────────────────────────────\n";
  out += `Entries:        ${body.size ?? body.entries ?? "?"}\n`;
  out += `Hits:           ${body.hits ?? 0}\n`;
  out += `Misses:         ${body.misses ?? 0}\n`;
  out += `Inflight:       ${body.inflightCount ?? 0}\n`;
  if (typeof body.evictions === "number") {
    out += `Evictions:      ${body.evictions}\n`;
  }
  return out;
}

export function fmtProviders(registry, configEnabled) {
  const providers = registry?.providers ?? {};
  const names = Object.keys(providers);
  let out = `OLP providers (${names.length} in registry)\n`;
  out += "─────────────────────────────\n";
  for (const name of names) {
    const p = providers[name];
    const enabled = configEnabled?.[name] === true ? "enabled " : "disabled";
    const tier = p?.tier ?? "?";
    const modelCount = (p?.models ?? []).length;
    const candidate = p?.candidate === true ? " (candidate)" : "";
    out += `  ${name.padEnd(10)} ${enabled}  tier ${tier}  models ${String(modelCount).padStart(2)}${candidate}\n`;
  }
  return out;
}

export function fmtChainShow(chains, target) {
  if (!chains || Object.keys(chains).length === 0) {
    return "No chains configured.";
  }
  if (target) {
    const chain = chains[target];
    if (!chain) {
      return `Model "${target}" not in routing.chains.\nConfigured: ${Object.keys(chains).join(", ")}`;
    }
    let out = `${target}:\n`;
    for (const hop of chain) {
      out += `  → ${typeof hop === "string" ? hop : JSON.stringify(hop)}\n`;
    }
    return out;
  }
  let out = "OLP routing.chains\n";
  out += "─────────────────────────────\n";
  for (const [model, chain] of Object.entries(chains)) {
    out += `${model}:\n`;
    for (const hop of chain) {
      out += `  → ${typeof hop === "string" ? hop : JSON.stringify(hop)}\n`;
    }
  }
  return out;
}

export function fmtDoctor(body) {
  // body shape: { checks, fail_count, warn_count, ok_count, kind, summary, next_action }
  let out = `OLP doctor — ${body.summary ?? "?"}\n`;
  out += "─────────────────────────────\n";
  for (const c of (body.checks ?? []).slice(0, 20)) {
    const icon = c.status === "ok" ? "🟢" : c.status === "warn" ? "🟡" : "🔴";
    out += `  ${icon} ${String(c.id ?? "?").padEnd(34)} ${String(c.message ?? "").slice(0, 60)}\n`;
  }
  if ((body.checks ?? []).length > 20) {
    out += `  ... (${body.checks.length - 20} more — use SSH 'olp doctor' for full output)\n`;
  }
  out += `\nfail=${body.fail_count ?? 0} warn=${body.warn_count ?? 0} ok=${body.ok_count ?? 0}  kind=${body.kind ?? "?"}\n`;
  if (body.next_action?.ai_executable?.length > 0) {
    out += `\nNext (AI-executable):\n`;
    for (const cmd of body.next_action.ai_executable.slice(0, 5)) {
      out += `  $ ${cmd}\n`;
    }
  }
  if (body.next_action?.human_required?.length > 0) {
    out += `\nNext (human-required):\n`;
    for (const step of body.next_action.human_required.slice(0, 5)) {
      out += `  • ${step}\n`;
    }
  }
  return out;
}

// ── Help text ──────────────────────────────────────────────────────────────

export function cmdHelp() {
  return `OLP Commands (read-only)
─────────────────────────────
/olp status              Process + provider + cache snapshot
/olp health              /health endpoint (public-ok)
/olp usage               24h request stats + per-provider quota
/olp models              Available models
/olp cache               Cache stats
/olp providers           Provider registry + enabled flags
/olp chain show [model]  Routing chain(s) from server config
/olp doctor              Diagnostic checks + suggested next action
/olp help                This message

Mutating commands (keygen / revoke / restart / logs) are NOT
available from chat by design — use SSH + the local 'olp' CLI.`;
}

// ── Dispatcher ─────────────────────────────────────────────────────────────

/**
 * Pure subcommand dispatcher. Returns `{ text }` always — caller wraps in
 * mono() for the chat surface.
 *
 * Exported for unit tests. Injects:
 *   - fetchFn (default global fetch)
 *   - proxyUrl (resolved upstream so tests can pin)
 *   - apiKey (from plugin config)
 *   - registry (models-registry.json — caller provides since this module
 *     ships in `olp-plugin/` and the file is a sibling concept living at
 *     the repo root)
 *   - chainsLocal (local routing.chains override — usually empty; the
 *     server-side /v0/management/status already exposes provider+chain
 *     state, but chain-show is the one local-config touch that mirrors
 *     `olp chain show`)
 */
export async function dispatch(rawArgs, opts) {
  const {
    proxyUrl,
    apiKey,
    registry,
    chainsLocal = {},
    fetchFn = fetch,
  } = opts;

  const raw = (rawArgs || "").trim();
  const spaceIdx = raw.indexOf(" ");
  const subcmd = spaceIdx === -1 ? raw : raw.slice(0, spaceIdx);
  const subargs = spaceIdx === -1 ? "" : raw.slice(spaceIdx + 1).trim();

  try {
    switch (subcmd) {
      case "status": {
        const body = await fetchJSON(`${proxyUrl}/v0/management/status`, { apiKey, fetchFn });
        return { text: fmtStatus(body) };
      }
      case "health": {
        const body = await fetchJSON(`${proxyUrl}/health`, { apiKey, fetchFn });
        return { text: fmtHealth(body) };
      }
      case "usage": {
        const body = await fetchJSON(`${proxyUrl}/v0/management/dashboard-data`, { apiKey, fetchFn });
        return { text: fmtUsage(body) };
      }
      case "models": {
        const body = await fetchJSON(`${proxyUrl}/v1/models`, { apiKey, fetchFn });
        return { text: fmtModels(body) };
      }
      case "cache": {
        const body = await fetchJSON(`${proxyUrl}/cache/stats`, { apiKey, fetchFn });
        return { text: fmtCache(body) };
      }
      case "providers": {
        // models-registry.json + (optionally) the server's idea of which are
        // enabled. /v0/management/status carries that and is owner-gated, but
        // /v1/models lists what's exposed publicly. For the chat surface we
        // use the public registry shape — config.enabled is a local-config
        // concept and the plugin doesn't have filesystem access to
        // ~/.olp/config.json by design.
        return { text: fmtProviders(registry, {}) };
      }
      case "chain": {
        // /olp chain show [model]
        const inner = subargs.trim();
        const parts = inner.split(/\s+/).filter(Boolean);
        if (parts[0] !== "show") {
          return { text: `Usage: /olp chain show [model]` };
        }
        const target = parts[1] ?? null;
        return { text: fmtChainShow(chainsLocal, target) };
      }
      case "doctor": {
        // /v0/management/doctor doesn't exist yet — D67 added doctor as a CLI
        // surface only. The plugin reports that explicitly so families know
        // to use SSH + `olp doctor` rather than waiting for a chat response.
        return {
          text: `/olp doctor is not yet wired through HTTP (planned for Phase 5+).\n` +
                `Run \`olp doctor\` over SSH on the host running the OLP server\n` +
                `for the full diagnostic output.`,
        };
      }
      case "help":
      case "--help":
      case "-h":
      case "":
        return { text: cmdHelp() };
      default:
        return { text: `Unknown subcommand: ${subcmd}\n\n${cmdHelp()}` };
    }
  } catch (err) {
    return { text: `OLP error: ${err.message ?? String(err)}` };
  }
}

// ── Plugin entry point (consumed by OpenClaw gateway) ──────────────────────

/**
 * OpenClaw plugin entry. The gateway calls this with its `api` registration
 * object; we register the `/olp` slash command and a handler that resolves
 * the proxy URL + API key from plugin config + env, then delegates to
 * `dispatch()`.
 *
 * The `registry` (models-registry.json) is read lazily inside the handler
 * so that a stale plugin install doesn't bind to an old snapshot — and so
 * the plugin module stays import-time-pure for tests.
 */
export default function (api) {
  api.registerCommand({
    name: "olp",
    description: "OLP — usage, health, status, doctor, etc. (read-only)",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const cfg = ctx.config ?? {};
      const apiKey = cfg.apiKey ?? process.env.OLP_API_KEY ?? null;
      const proxyUrl = resolveProxyUrl({ env: process.env, config: cfg });
      // Lazy load to avoid binding the import to the OpenClaw gateway's
      // ESM cache (which may pre-resolve at plugin-discovery time).
      let registry;
      try {
        // Convert file path to URL for ESM `import(...)`.
        const { fileURLToPath, pathToFileURL } = await import("node:url");
        const { dirname, resolve: pathResolve } = await import("node:path");
        const here = dirname(fileURLToPath(import.meta.url));
        const registryUrl = pathToFileURL(pathResolve(here, "..", "models-registry.json")).href;
        registry = (await import(registryUrl, { with: { type: "json" } })).default;
      } catch (e) {
        registry = { providers: {} };
      }
      // Local chains config is not currently surfaced through HTTP. For
      // chat-side chain-show we fall back to an empty map; operators
      // wanting the live config view should use `olp chain show` over SSH.
      const chainsLocal = {};
      const { text } = await dispatch(ctx.args ?? "", {
        proxyUrl,
        apiKey,
        registry,
        chainsLocal,
      });
      return { text: mono(truncateForChat(text)) };
    },
  });
}

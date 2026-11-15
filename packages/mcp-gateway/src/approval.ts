// Which tools run without asking. Claude Code asks you before any MCP tool that isn't on the session's allow list.
// Landlens's own server is allowed whole: every one of its tools reads through the front door, which refuses writes.
// A remote server's tools all ask, unless you turned on "Run read-only tools without asking" for it: then the tools
// that say they only read (annotations.readOnlyHint === true) and that the model may call run without asking, but
// only while its tool listing is the one you saw when you turned it on (pinned by a hash of names, descriptions,
// annotations and schemas). A server's readOnlyHint is its own claim, so it is never trusted by default.
// A connection's server (GitHub, Linear) is told apart by the vendor's read-only endpoint instead (providers/): its
// reads run without asking when you leave "Reads run without asking" on, while its listing is the one you accepted,
// and readOnlyHint plays no part.
import { createHash } from "node:crypto";
import { BUILTIN_MCP_SERVER, type McpToolInfo } from "@landlens/contracts";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProviderRules } from "./providers/index.js";

/** The MCP Apps `_meta.ui` of a tool (and the deprecated flat key), read leniently. */
export function toolUi(t: Pick<Tool, "_meta">): { resourceUri?: string; visibility: ("model" | "app")[] } {
  const meta = (t._meta ?? {}) as Record<string, unknown>;
  const ui = (meta.ui && typeof meta.ui === "object" ? meta.ui : {}) as { resourceUri?: unknown; visibility?: unknown };
  const uri = typeof ui.resourceUri === "string" ? ui.resourceUri : typeof meta["ui/resourceUri"] === "string" ? (meta["ui/resourceUri"] as string) : undefined;
  const vis = Array.isArray(ui.visibility) ? ui.visibility.filter((v): v is "model" | "app" => v === "model" || v === "app") : [];
  return {
    ...(uri && /^ui:\/\/[^\s]{1,300}$/.test(uri) ? { resourceUri: uri } : {}),
    visibility: vis.length ? vis : ["model", "app"],
  };
}

export const isReadOnly = (t: Pick<Tool, "annotations">) => t.annotations?.readOnlyHint === true;
export const modelMayCall = (t: Pick<Tool, "_meta">) => toolUi(t).visibility.includes("model");
export const appMayCall = (t: Pick<Tool, "_meta">) => toolUi(t).visibility.includes("app");

/** Tool names Claude Code accepts in a permission rule; anything else is left to ask. */
const RULE_TOOL = /^[A-Za-z0-9_-]{1,64}$/;

/** JSON with keys sorted at every level, so equal listings hash equally. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * A server's tool listing as one hash: every tool's name, title, description, annotations, input and output schema,
 * and MCP Apps visibility and view. Everything the model reads about a tool is in it, so a server that rewrites a
 * description, flips readOnlyHint or adds a tool gets a new hash.
 */
export function listingHash(tools: Pick<Tool, "name" | "title" | "description" | "annotations" | "inputSchema" | "outputSchema" | "_meta">[]): string {
  const rows = tools
    .map((t) => ({ name: t.name, title: t.title, description: t.description, annotations: t.annotations, inputSchema: t.inputSchema, outputSchema: t.outputSchema, ui: toolUi(t) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createHash("sha256").update(canonical(rows)).digest("hex");
}

/**
 * A server in a session: its listing now, the listing you allowed its read-only tools for, if you did, and for a
 * connection's server, its rules.
 */
export type ListedServer = { name: string; tools: Tool[]; pin?: string; provider?: ProviderRules };

/** Whether a tool only reads: by the vendor's read-only listing for a connection's server, else by its own word. */
export const readsOnly = (t: Pick<Tool, "name" | "annotations">, provider?: ProviderRules) => (provider ? provider.readTools.has(t.name) : isReadOnly(t));

/**
 * Permission rules for one session: the built-in server whole, and, for each proxied server you let run its
 * read-only tools without asking, those tools by name, if its listing is still the one you pinned. Everything else
 * (writes, unknowns, tools that don't say, servers you didn't opt in, listings that changed) makes Claude Code ask,
 * and the dock shows it.
 */
export function preAllowed(servers: ListedServer[]): string[] {
  const allow = [`mcp__${BUILTIN_MCP_SERVER}`];
  for (const s of servers) {
    if (s.name === BUILTIN_MCP_SERVER || !s.pin || listingHash(s.tools) !== s.pin) continue;
    if (s.provider && !s.provider.readsAuto) continue;
    for (const t of s.tools) if (readsOnly(t, s.provider) && modelMayCall(t) && RULE_TOOL.test(t.name)) allow.push(`mcp__${s.name}__${t.name}`);
  }
  return allow;
}

/** The servers whose listing no longer matches the one you pinned. */
export function drifted(servers: ListedServer[]): string[] {
  return servers.filter((s) => s.name !== BUILTIN_MCP_SERVER && s.pin && listingHash(s.tools) !== s.pin).map((s) => s.name);
}

/** A tool as the MCP page shows it; for a connection's server, readOnly is the vendor's read-only listing's answer. */
export function toolInfo(t: Tool, provider?: Pick<ProviderRules, "readTools">): McpToolInfo {
  const ui = toolUi(t);
  const required = Array.isArray((t.inputSchema as { required?: unknown })?.required) ? ((t.inputSchema as { required: unknown[] }).required.filter((r) => typeof r === "string") as string[]) : [];
  return {
    name: t.name,
    ...(t.title ?? t.annotations?.title ? { title: (t.title ?? t.annotations?.title)! } : {}),
    ...(t.description ? { description: t.description.slice(0, 600) } : {}),
    readOnly: provider ? provider.readTools.has(t.name) : isReadOnly(t),
    ...(ui.resourceUri ? { app: ui.resourceUri } : {}),
    visibility: ui.visibility,
    required,
  };
}

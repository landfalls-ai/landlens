// Which tools run without asking. Claude Code asks you before any MCP tool that isn't on the session's allow list;
// Landlens lists only tools that say they only read (annotations.readOnlyHint === true) and that the model may call.
// Landlens's own server is allowed whole: every one of its tools reads through the front door, which refuses writes.
import { BUILTIN_MCP_SERVER, type McpToolInfo } from "@landlens/contracts";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

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

/**
 * Permission rules for one session: the built-in server whole, and each proxied server's read-only, model-visible
 * tools by name. Everything else (writes, unknowns, tools that don't say) makes Claude Code ask, and the dock shows it.
 */
export function preAllowed(servers: { name: string; tools: Tool[] }[]): string[] {
  const allow = [`mcp__${BUILTIN_MCP_SERVER}`];
  for (const s of servers) {
    if (s.name === BUILTIN_MCP_SERVER) continue;
    for (const t of s.tools) if (isReadOnly(t) && modelMayCall(t) && RULE_TOOL.test(t.name)) allow.push(`mcp__${s.name}__${t.name}`);
  }
  return allow;
}

/** A tool as the MCP page shows it. */
export function toolInfo(t: Tool): McpToolInfo {
  const ui = toolUi(t);
  const required = Array.isArray((t.inputSchema as { required?: unknown })?.required) ? ((t.inputSchema as { required: unknown[] }).required.filter((r) => typeof r === "string") as string[]) : [];
  return {
    name: t.name,
    ...(t.title ?? t.annotations?.title ? { title: (t.title ?? t.annotations?.title)! } : {}),
    ...(t.description ? { description: t.description.slice(0, 600) } : {}),
    readOnly: isReadOnly(t),
    ...(ui.resourceUri ? { app: ui.resourceUri } : {}),
    visibility: ui.visibility,
    required,
  };
}

// landlens-views (D205): the five tools of a session started from the Views page, built per gateway session by main's
// ViewService and bound to that session's one working view. None touches the cluster or a connected service: they
// hand a document to main, which validates it whole and runs its sources with the view's own read-only token. What
// comes back to Claude is states and counts (status.ts), never a row. view_data is the app blocks' one tool: the
// gateway refuses it to the model (visibility ["app"]), and main answers it for a frame from the view's own sources.
import type { SourceData } from "@landlens/contracts";
import { VIEWS_MCP_SERVER } from "@landlens/contracts";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { issueLine, issuesOf, MAX_ISSUES, type Issue } from "./errors.js";
import { VIEW_CARD_HTML, VIEW_CARD_URI } from "./app/page.js";
import { Id } from "./schema.js";

/** What a render or patch answers: Claude's text, and for the dock's card the view's id, title, version and blocks. */
export type ViewAnswer =
  | { ok: true; text: string; card: { id: string; title: string; version: number; blocks: number } }
  | { ok: false; issues: Issue[] };

/** The working view a session's tools act on (main's ViewService). */
export interface ViewBinding {
  /** view_context's text: the cluster's facts, then the catalog. */
  context(): string | Promise<string>;
  render(document: unknown, note: string | undefined): Promise<ViewAnswer>;
  patch(base: number, ops: unknown, note: string | undefined): Promise<ViewAnswer>;
  /** get_view's text: the document as JSON, its version, the status lines; or why there is none. */
  get(): string;
  /** A source's data for one of this view's frames, or undefined when the view has no such source. */
  data(source: string): SourceData | undefined;
}

// Each tool's arguments, checked here so a bad one comes back in D222's words (the SDK's own check would answer zod's).
const Note = z.string().max(200);
export const ToolArgs = {
  view_context: z.object({}).strict(),
  render_view: z.object({ document: z.record(z.string(), z.unknown()), note: Note.optional() }).strict(),
  patch_view: z.object({ base: z.number().int().min(0), ops: z.unknown(), note: Note.optional() }).strict(),
  get_view: z.object({}).strict(),
  view_data: z.object({ source: Id }).strict(),
} as const;
export type ViewToolName = keyof typeof ToolArgs;
export const VIEW_TOOLS = Object.keys(ToolArgs) as ViewToolName[];

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/** D222's answer for refused input: at most 20 lines, each `<pointer>: <sentence>`. */
export function refusal(issues: readonly Issue[]): CallToolResult {
  const shown = issues.slice(0, MAX_ISSUES);
  const head = `The view wasn't changed: ${issues.length} ${issues.length === 1 ? "problem" : "problems"}.`;
  return text([head, ...shown.map(issueLine)].join("\n"), true);
}

/** Check a tool's arguments; the issues' pointers are under the arguments (`/document/…`, `/ops/…`). */
export function checkArgs<N extends ViewToolName>(name: N, args: unknown): { ok: true; args: z.output<(typeof ToolArgs)[N]> } | { ok: false; issues: Issue[] } {
  const r = ToolArgs[name].safeParse(args ?? {}, { reportInput: true });
  return r.success ? { ok: true, args: r.data as z.output<(typeof ToolArgs)[N]> } : { ok: false, issues: issuesOf(r.error) };
}

function answer(a: ViewAnswer): CallToolResult {
  if (!a.ok) return refusal(a.issues);
  return { content: [{ type: "text", text: a.text }], structuredContent: { view: a.card } };
}

// The SDK validates against inputSchema before our handler runs: each property is described for Claude but left
// open, so our own check (ToolArgs) is the one that speaks, in D222's words.
const any = (d: string) => z.unknown().describe(d);
const NOTE = "Optional: what this version changes, in a few words (at most 200 characters).";
const SHAPES = {
  none: {},
  render: { document: any("The view document: { schema: 1, title, params?, sources, blocks } (view_context says how)."), note: any(NOTE).optional() },
  patch: { base: any("The shown version's number."), ops: any("JSON Patch ops: [{ op: add|remove|replace|move, path, value?, from? }], 1 to 50."), note: any(NOTE).optional() },
  data: { source: any("One of the view's source ids.") },
};

export function viewsMcpServer(bind: ViewBinding): McpServer {
  const server = new McpServer({ name: VIEWS_MCP_SERVER, title: "Landlens views", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });
  const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const card = { ui: { resourceUri: VIEW_CARD_URI } };

  server.registerTool("view_context", {
    title: "What a view can show here",
    description: "Call first. The cluster's facts (context, namespaces this view may read, kinds, where usage comes from) and how to write a view document: sources, transform steps, blocks and limits.",
    inputSchema: SHAPES.none,
    annotations: { ...ro, idempotentHint: true },
  }, async (args) => {
    const c = checkArgs("view_context", args);
    if (!c.ok) return refusal(c.issues);
    return text(await bind.context());
  });

  server.registerTool("render_view", {
    title: "Show a view",
    description: "Show a new view document on the person's Views page (it replaces the shown one, as a new version). Landlens reads its sources live with the view's own read-only access. Answers the version and each source's state and row count.",
    inputSchema: SHAPES.render,
    annotations: ro,
    _meta: card,
  }, async (args) => {
    const c = checkArgs("render_view", args);
    if (!c.ok) return refusal(c.issues);
    return answer(await bind.render(c.args.document, c.args.note));
  });

  server.registerTool("patch_view", {
    title: "Change the view",
    description: "Change the shown view with JSON Patch ops (add, remove, replace, move; paths like /blocks/0/columns/-). base must be the shown version. Answers as render_view.",
    inputSchema: SHAPES.patch,
    annotations: ro,
    _meta: card,
  }, async (args) => {
    const c = checkArgs("patch_view", args);
    if (!c.ok) return refusal(c.issues);
    return answer(await bind.patch(c.args.base, c.args.ops, c.args.note));
  });

  server.registerTool("get_view", {
    title: "Read the view",
    description: "The shown view's document as JSON, its version, and each source's state and row count.",
    inputSchema: SHAPES.none,
    annotations: { ...ro, idempotentHint: true },
  }, async (args) => {
    const c = checkArgs("get_view", args);
    if (!c.ok) return refusal(c.issues);
    return text(bind.get());
  });

  server.registerTool("view_data", {
    title: "A source's data",
    description: "For the view's own app blocks only.",
    inputSchema: SHAPES.data,
    annotations: { ...ro, idempotentHint: true },
    _meta: { ui: { visibility: ["app"] } },
  }, async (args) => {
    const c = checkArgs("view_data", args);
    if (!c.ok) return refusal(c.issues);
    const d = bind.data(c.args.source);
    if (!d) return text(`This view has no source ${c.args.source}.`, true);
    return { content: [{ type: "text", text: `${c.args.source}: ${d.state}` }], structuredContent: d as unknown as Record<string, unknown> };
  });

  registerAppResource(server, "View", VIEW_CARD_URI, { description: "A view's card: its title, version and Open view.", mimeType: RESOURCE_MIME_TYPE, _meta: { ui: { prefersBorder: false } } }, async () => ({
    contents: [{ uri: VIEW_CARD_URI, mimeType: RESOURCE_MIME_TYPE, text: VIEW_CARD_HTML, _meta: { ui: { prefersBorder: false } } }],
  }));
  return server;
}

/// <reference path="./raw.d.ts" />
// landlens-kube's MCP Apps (the io.modelcontextprotocol/ui extension, 2026-01-26): four views, each one self-contained
// HTML document (inline style and script, no network, nothing loaded from anywhere) served as a ui:// resource with
// the mimeType text/html;profile=mcp-app. A host renders one under the tool call it belongs to and hands it the call's
// arguments and result; the views draw from the result's structuredContent and theme themselves from the spec's
// standard CSS variables. Hosts without MCP Apps just get the text result.
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import css from "./apps/base.css?raw";
import health from "./apps/health.js?raw";
import logs from "./apps/logs.js?raw";
import metrics from "./apps/metrics.js?raw";
import object from "./apps/object.js?raw";
import runtime from "./apps/runtime.js?raw";

export const APP_URI = {
  health: "ui://landlens-kube/health",
  object: "ui://landlens-kube/object",
  logs: "ui://landlens-kube/logs",
  metrics: "ui://landlens-kube/metrics",
} as const;

export { RESOURCE_MIME_TYPE };

const VIEWS: { uri: string; name: string; title: string; description: string; script: string }[] = [
  { uri: APP_URI.health, name: "health", title: "Cluster health", description: "cluster_overview as a card: the verdict, counts and problems worst first.", script: health },
  { uri: APP_URI.object, name: "object", title: "Object", description: "describe as a card: state, containers, owners, events, and Open in Landlens.", script: object },
  { uri: APP_URI.logs, name: "logs", title: "Logs", description: "get_logs with the lines that look like the failure highlighted.", script: logs },
  { uri: APP_URI.metrics, name: "metrics", title: "CPU and memory", description: "metrics as two line charts with requests and limits.", script: metrics },
];

/** `</script` inside a script would end it early; none of ours has one, and this keeps it that way. */
const inline = (js: string) => js.replace(/<\/(script)/gi, "<\\/$1");

function page(title: string, script: string): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="dark light">',
    `<title>${title}</title>`,
    `<style>${css}</style>`,
    '</head><body><main id="app" aria-live="polite"><div class="empty"><span class="dim">Loading…</span></div></main>',
    `<script>${inline(runtime)}</script>`,
    `<script>${inline(script)}</script>`,
    "</body></html>",
  ].join("\n");
}

/** Each view's HTML by URI. */
export const APP_HTML: Record<string, string> = Object.fromEntries(VIEWS.map((v) => [v.uri, page(v.title, v.script)]));

/** The views as ui:// resources on a server (no extra network, so no csp; the host draws no border of its own). */
export function registerApps(server: McpServer) {
  for (const v of VIEWS) {
    const meta = { ui: { prefersBorder: false } };
    registerAppResource(server, v.title, v.uri, { description: v.description, mimeType: RESOURCE_MIME_TYPE, _meta: meta }, async () => ({
      contents: [{ uri: v.uri, mimeType: RESOURCE_MIME_TYPE, text: APP_HTML[v.uri]!, _meta: meta }],
    }));
  }
}

// The only bridge between the sandboxed page and main: invoke the listed channels, listen on the listed pushes.
import type { Channel, LandlensBridge, PushChannel } from "@landlens/contracts";
import { contextBridge, ipcRenderer } from "electron";

// Kept in step with @landlens/contracts (a sandboxed preload can't import zod at run time).
const CHANNELS: readonly Channel[] = [
  "catalog:list", "cluster:connect", "cluster:disconnect", "cluster:discovery", "cluster:access",
  "cluster:health", "doctor:list", "doctor:evidence", "resource:get", "resource:events", "watch:subscribe", "watch:unsubscribe",
  "agent:start", "agent:prompt", "agent:cancel", "agent:mode", "agent:config", "agent:answer", "agent:decide", "agent:close", "agent:history", "agent:resume", "agent:forget", "agent:settings", "agent:skills", "link:open",
  "metrics:series", "metrics:settings", "metrics:configure", "metrics:test", "metrics:disconnect",
  "clickland:logs", "clickland:traces", "clickland:trace", "clickland:open",
  "mcp:servers", "mcp:save", "mcp:test", "mcp:enable", "mcp:auto-run", "mcp:remove", "mcp:calls", "mcp:try",
  "mcp:app-open", "mcp:app-call", "mcp:app-close", "mcp:app-link",
  "logs:open", "logs:close", "terminal:open", "terminal:local", "terminal:input", "terminal:resize", "terminal:ack", "terminal:close",
  "edit:review", "edit:create", "edit:apply", "edit:discard", "action:review", "action:apply", "action:discard", "action:stop", "action:runs", "action:log",
  "secret:unlock", "secret:lock", "secret:reveal", "secret:copy", "secret:certs",
  "forward:list", "forward:suggest", "forward:check", "forward:start", "forward:stop", "forward:resume", "forward:remove", "forward:open",
  "helm:list", "helm:get", "search:index", "metrics:prometheus",
  "conn:list", "conn:github-device", "conn:linear-signin", "conn:token", "conn:cancel", "conn:set", "conn:test", "conn:repin", "conn:disconnect",
  "family:list", "family:connect", "family:signin", "family:set", "family:test", "family:repin", "family:disconnect",
  "landflow:alert", "landflow:triage", "landflow:flows", "landflow:input", "landflow:run", "landflow:follow", "landflow:sent", "landflow:open",
  "telemetry:set", "telemetry:recent", "telemetry:open", "brain:draft", "brain:ask", "brain:cancel", "brain:send", "brain:remove",
  "agent:autonomy",
  "gcp:status", "gcp:projects", "gcp:choose", "gcp:agent-read", "gcp:types", "gcp:resources", "gcp:resource", "gcp:clusters",
];
const PUSH: readonly PushChannel[] = [
  "watch:event", "cluster:status", "agent:update", "agent:permission", "agent:status", "agent:change", "mcp:call",
  "logs:lines", "logs:end", "terminal:data", "terminal:status", "forward:update", "conn:update", "agent:autonomy",
  "family:update", "action:progress",
];

/** Main sends errors as JSON {status, message} inside Electron's "Error invoking remote method" wrapper. */
function unwrap(err: unknown): Error {
  const text = err instanceof Error ? err.message : String(err);
  const m = /(\{"status":\d+,"message":.*\})$/s.exec(text);
  const parsed = m ? (JSON.parse(m[1]!) as { status: number; message: string }) : { status: 500, message: text };
  // contextBridge copies only an Error's message into the page (custom properties such as `status` are dropped), so
  // the status rides in the message as JSON and the renderer's api.ts reads it back (apiError.ts).
  return new Error(JSON.stringify({ status: parsed.status, message: parsed.message }));
}

const bridge: LandlensBridge = {
  async invoke(channel, request) {
    if (!CHANNELS.includes(channel)) throw new Error(JSON.stringify({ status: 400, message: `unknown channel ${channel}` }));
    try {
      return await ipcRenderer.invoke(channel, request);
    } catch (err) {
      throw unwrap(err);
    }
  },
  on(channel, listener) {
    if (!PUSH.includes(channel)) throw new Error(`unknown push channel ${channel}`);
    const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld("landlens", bridge);

// The platform as data, for the CSS (macOS draws its traffic lights over the page). No new power: an attribute.
// (The preload is compiled without the DOM library; these are the two globals it touches.)
declare const document: { documentElement: { setAttribute(name: string, value: string): void } | null };
declare const window: { addEventListener(type: string, listener: () => void): void };
const markPlatform = () => document.documentElement?.setAttribute("data-platform", process.platform);
markPlatform();
window.addEventListener("DOMContentLoaded", markPlatform);

// The only bridge between the sandboxed page and main: invoke the listed channels, listen on the listed pushes.
import type { Channel, LandlensBridge, PushChannel } from "@landlens/contracts";
import { contextBridge, ipcRenderer } from "electron";

// Kept in step with @landlens/contracts (a sandboxed preload can't import zod at run time).
const CHANNELS: readonly Channel[] = [
  "catalog:list", "cluster:connect", "cluster:disconnect", "cluster:discovery", "cluster:access",
  "cluster:health", "resource:get", "resource:events", "watch:subscribe", "watch:unsubscribe",
  "agent:start", "agent:prompt", "agent:cancel", "agent:mode", "agent:config", "agent:answer", "agent:close",
  "metrics:series", "metrics:settings", "metrics:configure", "metrics:test", "metrics:disconnect",
];
const PUSH: readonly PushChannel[] = ["watch:event", "cluster:status", "agent:update", "agent:permission", "agent:status"];

/** Main sends errors as JSON {status, message} inside Electron's "Error invoking remote method" wrapper. */
function unwrap(err: unknown): Error & { status: number } {
  const text = err instanceof Error ? err.message : String(err);
  const m = /(\{"status":\d+,"message":.*\})$/s.exec(text);
  const parsed = m ? (JSON.parse(m[1]!) as { status: number; message: string }) : { status: 500, message: text };
  return Object.assign(new Error(parsed.message), { status: parsed.status });
}

const bridge: LandlensBridge = {
  async invoke(channel, request) {
    if (!CHANNELS.includes(channel)) throw Object.assign(new Error(`unknown channel ${channel}`), { status: 400 });
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

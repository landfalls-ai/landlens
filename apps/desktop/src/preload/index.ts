// The only bridge between the sandboxed page and main: invoke the listed channels, listen on the listed pushes.
import type { Channel, LandlensBridge, PushChannel } from "@landlens/contracts";
import { contextBridge, ipcRenderer } from "electron";

// Kept in step with @landlens/contracts (a sandboxed preload can't import zod at run time).
const CHANNELS: readonly Channel[] = [
  "catalog:list", "cluster:connect", "cluster:disconnect", "cluster:discovery", "cluster:access",
  "resource:get", "resource:events", "watch:subscribe", "watch:unsubscribe",
];
const PUSH: readonly PushChannel[] = ["watch:event", "cluster:status"];

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

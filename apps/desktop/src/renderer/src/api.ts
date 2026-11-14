// The renderer's side of IPC: the typed bridge, and a hook that keeps a live list of objects from a watch.
import type { KubeObject, LandlensBridge, WatchEvent, WatchRequest } from "@landlens/contracts";
import { useEffect, useState } from "react";

declare global {
  interface Window {
    landlens: LandlensBridge;
  }
}

export const api = window.landlens;
export type ApiError = Error & { status?: number };

// One listener for all watch events. Main may send a subscription's first snapshot before invoke() returns its id,
// so events for ids we don't know yet wait briefly in a buffer.
const handlers = new Map<string, (e: WatchEvent) => void>();
const early = new Map<string, WatchEvent[]>();
api.on("watch:event", (e: WatchEvent) => {
  const h = handlers.get(e.subscription);
  if (h) return h(e);
  const list = early.get(e.subscription) ?? [];
  list.push(e);
  early.set(e.subscription, list);
  setTimeout(() => early.delete(e.subscription), 10_000);
});

export type WatchState = { items: KubeObject[]; loading: boolean; error?: { status: number; message: string } };

export function useWatch(req: WatchRequest | undefined): WatchState {
  const [state, setState] = useState<WatchState>({ items: [], loading: true });
  const key = req ? JSON.stringify(req) : "";
  useEffect(() => {
    if (!req) return;
    setState({ items: [], loading: true });
    let byUid = new Map<string, KubeObject>();
    let id: string | undefined;
    let closed = false;
    const apply = (e: WatchEvent) => {
      if (e.type === "error") return setState((s) => ({ ...s, loading: false, error: { status: e.status, message: e.message } }));
      if (e.type === "snapshot") byUid = new Map(e.items.map((o) => [o.metadata.uid, o]));
      else {
        for (const o of e.upserted) byUid.set(o.metadata.uid, o);
        for (const uid of e.removed) byUid.delete(uid);
      }
      setState({ items: [...byUid.values()], loading: false });
    };
    api.invoke("watch:subscribe", req).then(
      ({ subscription }) => {
        if (closed) return void api.invoke("watch:unsubscribe", { subscription });
        id = subscription;
        handlers.set(subscription, apply);
        for (const e of early.get(subscription) ?? []) apply(e);
        early.delete(subscription);
      },
      (err: ApiError) => setState({ items: [], loading: false, error: { status: err.status ?? 500, message: err.message } }),
    );
    return () => {
      closed = true;
      if (id) {
        handlers.delete(id);
        void api.invoke("watch:unsubscribe", { subscription: id });
      }
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

/** Re-render every few seconds so ages stay current. */
export function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

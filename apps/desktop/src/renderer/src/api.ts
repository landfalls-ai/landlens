// The renderer's side of IPC: the typed bridge, and a hook that keeps a live list of objects from a watch.
import type { KubeObject, LandlensBridge, WatchEvent, WatchRequest } from "@landlens/contracts";
import { useEffect, useState } from "react";
import { toApiError, type ApiError } from "./apiError";
import { watchPlan } from "./tableState";

declare global {
  interface Window {
    landlens: LandlensBridge;
  }
}

export type { ApiError } from "./apiError";

// Every invoke rejects with an ApiError whose `status` is main's (403, 404, 409…): the bridge's raw errors carry it
// only inside their message.
const bridge = window.landlens;
export const api: LandlensBridge = {
  invoke: ((channel: string, request: unknown) =>
    (bridge.invoke as (c: string, r: unknown) => Promise<unknown>)(channel, request).catch((e: unknown) => {
      throw toApiError(e);
    })) as LandlensBridge["invoke"],
  on: bridge.on,
};

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

/**
 * One watch: `on` hears the list after each event (or the error), until the returned close is called. Main may send a
 * subscription's first snapshot before invoke() returns its id; those events wait in the buffer above.
 */
function subscribe(req: WatchRequest, on: (s: WatchState) => void): () => void {
  let byUid = new Map<string, KubeObject>();
  let id: string | undefined;
  let closed = false;
  const apply = (e: WatchEvent) => {
    if (closed) return;
    if (e.type === "error") return on({ items: [...byUid.values()], loading: false, error: { status: e.status, message: e.message } });
    if (e.type === "snapshot") byUid = new Map(e.items.map((o) => [o.metadata.uid, o]));
    else {
      for (const o of e.upserted) byUid.set(o.metadata.uid, o);
      for (const uid of e.removed) byUid.delete(uid);
    }
    on({ items: [...byUid.values()], loading: false });
  };
  api.invoke("watch:subscribe", req).then(
    ({ subscription }) => {
      if (closed) return void api.invoke("watch:unsubscribe", { subscription });
      id = subscription;
      handlers.set(subscription, apply);
      for (const e of early.get(subscription) ?? []) apply(e);
      early.delete(subscription);
    },
    (err: ApiError) => !closed && on({ items: [], loading: false, error: { status: err.status ?? 500, message: err.message } }),
  );
  return () => {
    closed = true;
    if (id) {
      handlers.delete(id);
      void api.invoke("watch:unsubscribe", { subscription: id });
    }
  };
}

export function useWatch(req: WatchRequest | undefined): WatchState {
  const key = req ? JSON.stringify(req) : "";
  // Tagged with the request it answers, so a new request never shows the previous one's items.
  const [state, setState] = useState<WatchState & { key: string }>({ items: [], loading: true, key: "" });
  useEffect(() => {
    if (!req) return;
    setState({ items: [], loading: true, key });
    return subscribe(req, (s) => setState(s.error ? { ...s, key } : { items: s.items, loading: false, key }));
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return state.key === key ? state : STALE;
}

const STALE: WatchState = { items: [], loading: true };

/**
 * A list in several namespaces (wave 8 part 3, D158), as `watchPlan` says: none chosen, the whole cluster; one, that
 * namespace; two to eight, one watch each merged by uid (which also works for a role that can't list across
 * namespaces); more, the whole cluster filtered here, and if that is refused (403) the first eight, with `cut` saying
 * how many were left out. `failed`: namespaces whose own watch was refused while others answered.
 */
export type ManyState = WatchState & { cut?: number; failed?: number };
export function useWatchMany(base: WatchRequest | undefined, namespaces: readonly string[]): ManyState {
  const key = base ? JSON.stringify([base, namespaces]) : "";
  const [state, setState] = useState<ManyState & { key: string }>({ items: [], loading: true, key: "" });
  useEffect(() => {
    if (!base) return;
    setState({ items: [], loading: true, key });
    const { namespace: _one, ...whole } = base;
    let closers: (() => void)[] = [];
    const closeAll = () => {
      for (const c of closers) c();
      closers = [];
    };
    const start = (plan: ReturnType<typeof watchPlan>) => {
      if ("all" in plan) {
        const only = plan.filter ? new Set(plan.filter) : undefined;
        closers.push(subscribe(whole, (s) => {
          // The account can't list across namespaces: watch the first eight one by one (D158).
          if (only && s.error?.status === 403) return (closeAll(), start(watchPlan([...namespaces], true)));
          setState({ ...s, items: only ? s.items.filter((o) => only.has(o.metadata.namespace ?? "")) : s.items, key });
        }));
        return;
      }
      const per = new Map<string, WatchState>();
      const merge = () => {
        const answered = [...per.values()];
        const errors = answered.filter((x) => x.error);
        const byUid = new Map<string, KubeObject>();
        for (const x of answered) for (const o of x.items) byUid.set(o.metadata.uid, o);
        const allFailed = errors.length === plan.each.length;
        setState({
          items: [...byUid.values()], loading: answered.length < plan.each.length, key,
          ...(allFailed ? { error: errors[0]!.error! } : {}),
          ...(plan.cut ? { cut: plan.cut } : {}),
          ...(errors.length && !allFailed ? { failed: errors.length } : {}),
        });
      };
      for (const ns of plan.each) closers.push(subscribe({ ...whole, namespace: ns }, (s) => (per.set(ns, s), merge())));
    };
    start(watchPlan([...namespaces]));
    return closeAll;
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return state.key === key ? state : STALE;
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

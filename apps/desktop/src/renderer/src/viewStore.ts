// The Views page's state in the window (wave 10 part 2, docs/views.md): the one working view, its session, its sources'
// data as main pushed it, and the agent updates that came before the dock was there to hear them. Main is the record:
// every change goes through a views:* channel and comes back as a views:state push; a data push carries the version it
// belongs to, and one for another version is dropped (part 1's review). Outside React, so the page and the dock share
// it and it outlives a move to another page; useView() reads it.
import type { AgentPermissionRequest, AgentSessionInfo, AgentStatus, AgentUpdate, ResourceRef, RowRef, SourceData, ViewDataPush, ViewState } from "@landlens/contracts";
import { useState, useSyncExternalStore } from "react";
import type { Sort } from "./tableState";
import { api } from "./api";

export type ViewSnapshot = {
  /** The working view, its state and its session, once views:start answered. */
  view?: {
    id: string; session: AgentSessionInfo; ask: string; state?: ViewState; data: Record<string, { version: number; data: SourceData }>;
    /**
     * Objects on the composer as chips (wave 10 part 3): a row's Ask Claude, or a block's ask intent (D219). They go
     * with the next question as references (the session reads each with its own token); nothing is sent by adding one.
     */
    chips?: RowRef[];
    /**
     * Rows chosen for the selection bar (D156, D218): by the person's checkboxes, or by a block's select intent (D219),
     * which never offers Delete.
     */
    selection?: { refs: RowRef[]; by: "you" | "block" };
  };
  /** Sending the first ask (views:start hasn't answered). */
  starting?: string;
  error?: string;
};

let snap: ViewSnapshot = {};
const listeners = new Set<() => void>();
const set = (next: ViewSnapshot) => {
  snap = next;
  for (const l of listeners) l();
};

/** Agent updates of the last minute, any session: a dock bound later replays its own session's (D213). */
const RECENT_MAX = 2_000;
const recent: { at: number; u: AgentUpdate }[] = [];
/** The person's questions to the view's session, from the page's strip or the dock: the dock shows each. */
const askListeners = new Set<(session: string, text: string) => void>();
/**
 * Questions any session put to the person and nobody has answered yet: the view's dock mounts after its session
 * starts, and opens when its session asks (a question nobody sees would hold Claude for good).
 */
let pending: AgentPermissionRequest[] = [];
const permissionListeners = new Set<(p: AgentPermissionRequest) => void>();
/** Each source's newest data, for the frames of the view's app blocks. */
const dataListeners = new Set<(source: string, data: SourceData) => void>();

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  api.on("agent:update", (u: AgentUpdate) => {
    recent.push({ at: Date.now(), u });
    const cut = Date.now() - 60_000;
    while (recent.length && (recent.length > RECENT_MAX || recent[0]!.at < cut)) recent.shift();
  });
  api.on("agent:permission", (p: AgentPermissionRequest) => {
    pending = [...pending.slice(-49), p];
    for (const l of permissionListeners) l(p);
  });
  api.on("agent:status", (s: AgentStatus) => {
    if (s.state === "answered") pending = pending.filter((p) => p.request !== s.request);
  });
  api.on("views:state", (s: ViewState) => {
    const v = snap.view;
    if (!v || v.id !== s.id) return;
    // A new version's data starts empty: what the older one had isn't this one's.
    const data = Object.fromEntries(Object.entries(v.data).filter(([, d]) => d.version === s.version));
    set({ ...snap, view: { ...v, state: s, data, session: s.session === v.session.session ? v.session : { ...v.session, session: s.session } } });
  });
  api.on("views:data", (p: ViewDataPush) => {
    const v = snap.view;
    if (!v || v.id !== p.view) return;
    if (v.state && p.version !== v.state.version) return;
    set({ ...snap, view: { ...v, data: { ...v.data, [p.source]: { version: p.version, data: p.data } } } });
    for (const l of dataListeners) l(p.source, p.data);
  });
}

export const viewStore = {
  get: () => snap,
  subscribe(l: () => void) {
    wire();
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  /** The updates of one session that arrived before the dock bound to it. */
  recent: (session: string) => recent.filter((r) => r.u.session === session).map((r) => r.u),
  /** The questions of one session nobody has answered. */
  asks: (session: string) => pending.filter((p) => p.session === session),
  onPermission(l: (p: AgentPermissionRequest) => void) {
    wire();
    permissionListeners.add(l);
    return () => void permissionListeners.delete(l);
  },
  onAsk(l: (session: string, text: string) => void) {
    askListeners.add(l);
    return () => void askListeners.delete(l);
  },
  onData(l: (source: string, data: SourceData) => void) {
    dataListeners.add(l);
    return () => void dataListeners.delete(l);
  },
  /** The data of a source for the shown version, if any arrived. */
  data(source: string): SourceData | undefined {
    const v = snap.view;
    const d = v?.data[source];
    return d && v?.state && d.version === v.state.version ? d.data : undefined;
  },

  async start(handle: string, text: string): Promise<void> {
    wire();
    const old = snap.view?.id;
    set({ starting: text });
    if (old) void api.invoke("views:close", { view: old }).catch(() => {});
    try {
      const r = await api.invoke("views:start", { handle, text });
      for (const l of askListeners) l(r.session.session, text);
      set({ view: { id: r.view, session: r.session, ask: text, data: {} } });
      const st = await api.invoke("views:get", { view: r.view });
      if (snap.view?.id === r.view && !snap.view.state) set({ view: { ...snap.view, state: st } });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  /**
   * A follow-up, from the page's strip or the dock (D213): the shown version goes with it (main attaches it). A block
   * asked about goes with the version it was chosen in, which main checks is still the one shown (review of part 2, L6).
   */
  async send(text: string, context: ResourceRef[] = [], block?: { block: string; version: number }): Promise<{ stopReason: string } | undefined> {
    const v = snap.view;
    if (!v || !text.trim()) return undefined;
    for (const l of askListeners) l(v.state?.session ?? v.session.session, text);
    return api.invoke("views:prompt", { view: v.id, text, ...(context.length ? { context } : {}), ...(block ? { block: block.block, version: block.version } : {}) });
  },

  /** A row's object on the composer, at most 10 (views:prompt's context limit); a Secret never (main refuses it too). */
  chip(ref: RowRef) {
    const v = snap.view;
    if (!v || (ref.group === "" && ref.resource === "secrets")) return;
    const chips = v.chips ?? [];
    if (chips.some((c) => sameRef(c, ref)) || chips.length >= 10) return;
    set({ ...snap, view: { ...v, chips: [...chips, ref] } });
  },
  unchip(ref?: RowRef) {
    const v = snap.view;
    if (v) set({ ...snap, view: { ...v, chips: ref ? (v.chips ?? []).filter((c) => !sameRef(c, ref)) : [] } });
  },
  /** The selection bar's rows, and who chose them; none clears it. */
  select(refs: RowRef[], by: "you" | "block" = "you") {
    const v = snap.view;
    if (!v) return;
    const { selection: _, ...rest } = v;
    set({ ...snap, view: refs.length ? { ...rest, selection: { refs: refs.slice(0, 50), by } } : rest });
  },

  async version(to: number) {
    const v = snap.view;
    if (v) await api.invoke("views:version", { view: v.id, to });
  },

  async param(name: string, value: string) {
    const v = snap.view;
    if (v) await api.invoke("views:param", { view: v.id, name, value });
  },

  /** New view: the working one closes (its reads, token, frames and session), and the page is blank again. */
  async close() {
    const v = snap.view;
    set({});
    if (v) await api.invoke("views:close", { view: v.id }).catch(() => {});
  },
};

export const sameRef = (a: RowRef, b: RowRef) => a.group === b.group && a.resource === b.resource && (a.namespace ?? "") === (b.namespace ?? "") && a.name === b.name;
/** A row's object as views:prompt's context takes it (ResourceRef: no kind). */
export const resourceRef = (r: RowRef): ResourceRef => ({ group: r.group, version: r.version, resource: r.resource, name: r.name, ...(r.namespace ? { namespace: r.namespace } : {}) });

export function useView(): ViewSnapshot {
  return useSyncExternalStore(viewStore.subscribe, viewStore.get);
}

/** A block's key for "Ask about this block" and the frames: an app block's id, else `block-<index>`. */
export const blockKey = (b: { type: string; id?: string }, i: number) => (b.type === "app" && b.id ? b.id : `block-${i}`);

/**
 * The person's own tweaks to a block (D214: a table's sort), kept in the window per view and block until the view
 * closes; they change nothing in the document and nothing goes to Claude. Saving them with the view is part 4's.
 */
export type Tweak = { sort?: Sort };
const tweaks = new Map<string, Tweak>();
export function useTweak(view: string, block: string): [Tweak, (t: Tweak) => void] {
  const key = `${view}/${block}`;
  const [t, setT] = useState<Tweak>(() => tweaks.get(key) ?? {});
  return [t, (n: Tweak) => (tweaks.set(key, n), setT(n))];
}

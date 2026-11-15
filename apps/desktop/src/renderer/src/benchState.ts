// The panel's state (docs/workbench.md): its tabs, which one shows, whether it shows, and how tall it is. Tabs hold
// what to open; each tab's view opens its own session and ends it when the tab closes.
import { useCallback, useMemo, useState } from "react";

export type Shell = "auto" | "bash" | "sh";

/** A pod shell: which container, and enough about the pod to find its replacement when it goes. */
export type ShellTarget = {
  namespace: string;
  pod: string;
  container: string;
  shell: Shell;
  /** The pod's labels, without the hashes a rollout changes: a replacement pod has the same ones. */
  labels?: Record<string, string>;
};

/** What a logs view follows: one pod, or a workload's pods (by its selector). */
export type LogSource = {
  namespace: string;
  kind: string;
  name: string;
  /** For a workload: its pods' labels (spec.selector.matchLabels). */
  selector?: Record<string, string>;
  /** The container to start on. */
  container?: string;
};

export type BenchTab =
  | { id: string; kind: "shell"; target: ShellTarget }
  | { id: string; kind: "local" }
  | { id: string; kind: "logs"; source: LogSource };

type NewTab = BenchTab extends infer T ? (T extends BenchTab ? Omit<T, "id"> : never) : never;

const HEIGHT_KEY = "landlens.bench.height";
let seq = 0;
const newId = () => `t${++seq}`;

export const BENCH_MIN = 160;

export function useBench() {
  const [tabs, setTabs] = useState<BenchTab[]>([]);
  const [active, setActive] = useState<string>();
  const [open, setOpen] = useState(false);
  const [max, setMax] = useState(false);
  const [height, setHeightState] = useState<number | undefined>(() => {
    const n = Number(sessionStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(n) && n >= BENCH_MIN ? n : undefined;
  });
  /** Which tabs have a live session (shells and local terminals; logs tabs count while open). */
  const [live, setLiveMap] = useState<Record<string, boolean>>({});

  const add = useCallback((t: NewTab) => {
    const tab = { ...t, id: newId() } as BenchTab;
    setTabs((ts) => [...ts, tab]);
    setActive(tab.id);
    setOpen(true);
    return tab.id;
  }, []);

  const close = useCallback((id: string) => {
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.id === id);
      const rest = ts.filter((t) => t.id !== id);
      setActive((a) => (a === id ? rest[Math.min(i, rest.length - 1)]?.id : a));
      if (!rest.length) setMax(false);
      return rest;
    });
    setLiveMap((m) => {
      const { [id]: _, ...rest } = m;
      return rest;
    });
  }, []);

  const setLive = useCallback((id: string, on: boolean) => setLiveMap((m) => (m[id] === on ? m : { ...m, [id]: on })), []);
  const setHeight = useCallback((h: number) => {
    setHeightState(h);
    sessionStorage.setItem(HEIGHT_KEY, String(Math.round(h)));
  }, []);

  const step = useCallback((by: 1 | -1) => setActive((a) => {
    if (!tabs.length) return a;
    const i = Math.max(0, tabs.findIndex((t) => t.id === a));
    return tabs[(i + by + tabs.length) % tabs.length]!.id;
  }), [tabs]);

  const sessions = useMemo(() => tabs.filter((t) => (t.kind === "logs" ? true : live[t.id])).length, [tabs, live]);
  const terminals = useMemo(() => tabs.filter((t) => t.kind !== "logs" && live[t.id]).length, [tabs, live]);

  return {
    tabs, active, open, max, height, live, sessions, terminals,
    add, close, setActive, setOpen, setMax, setHeight, setLive, step,
    openShell: (target: ShellTarget) => add({ kind: "shell", target }),
    openLocal: () => add({ kind: "local" }),
    openLogs: (source: LogSource) => add({ kind: "logs", source }),
  };
}

export type BenchState = ReturnType<typeof useBench>;

/** Labels that a rollout or a pod's own identity changes; without them, a replacement pod has the same labels. */
const VOLATILE = new Set(["pod-template-hash", "controller-revision-hash", "statefulset.kubernetes.io/pod-name", "apps.kubernetes.io/pod-index", "batch.kubernetes.io/controller-uid", "controller-uid", "batch.kubernetes.io/job-name", "job-name"]);
export function stableLabels(labels: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!labels) return undefined;
  const out = Object.fromEntries(Object.entries(labels).filter(([k]) => !VOLATILE.has(k)));
  return Object.keys(out).length ? out : undefined;
}

export function matches(labels: Record<string, string> | undefined, selector: Record<string, string>): boolean {
  return Object.entries(selector).every(([k, v]) => labels?.[k] === v);
}

/** "catalog-api-7d9f8b6c5-x2x9q" → "catalog-api…x2x9q" when it is long. */
export function elide(name: string, max = 22): string {
  if (name.length <= max) return name;
  const tail = name.slice(name.lastIndexOf("-") + 1);
  const head = name.slice(0, Math.max(4, max - tail.length - 1));
  return `${head}…${tail}`;
}

// Whether Clickland's history can be offered in the IDE (wave 7 part 3, D118), shared by every view: its card's state
// and whether a console address is set, from family:list and kept live from family:update. The key never comes here.
import type { ClicklandScope, FamilyInfo } from "@landlens/contracts";
import { useEffect, useState } from "react";
import { api } from "./api";

export type ClicklandState = { ready: boolean; console?: string };

let state: ClicklandState = { ready: false };
let loaded = false;
const listeners = new Set<(s: ClicklandState) => void>();
const put = (i: FamilyInfo) => {
  state = { ready: i.state === "ready", ...(i.console ? { console: i.console } : {}) };
  for (const l of listeners) l(state);
};

function load() {
  if (loaded) return;
  loaded = true;
  api.on("family:update", (i: FamilyInfo) => i.sibling === "clickland" && put(i));
  void api.invoke("family:list", {}).then((l) => put(l.clickland), () => (loaded = false));
}

export function useClickland(): ClicklandState {
  const [s, setS] = useState(state);
  useEffect(() => {
    load();
    listeners.add(setS);
    setS(state);
    return () => void listeners.delete(setS);
  }, []);
  return s;
}

/** What Clickland's history is asked about for a kind the drawer shows; none for other kinds. */
export function clicklandScope(kind: string, namespace: string | undefined, name: string, container?: string): ClicklandScope | undefined {
  const k = ({ Pod: "pod", Deployment: "deployment", StatefulSet: "statefulset", DaemonSet: "daemonset" } as const)[kind as "Pod"];
  if (!k || !namespace || !/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(name)) return undefined;
  return { kind: k, namespace, name, ...(container ? { container } : {}) };
}

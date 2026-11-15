// Picking a shell (D5–D8): which pod (for a workload), which container, and which shell. One running container opens
// at once. A role that can't exec gets disabled buttons that say so, not a refusal after the click.
import type { KubeObject } from "@landlens/contracts";
import { Box, ChevronLeft, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, useWatch } from "./api";
import { matches, stableLabels, type Shell, type ShellTarget } from "./benchState";
import { Ic } from "./icons";

const canCache = new Map<string, Promise<boolean>>();
/** Whether the person's role may exec into pods in this namespace (pods/exec create), asked once per namespace. */
export function useCanExec(handle: string, namespace: string | undefined): boolean | undefined {
  const [can, setCan] = useState<boolean>();
  useEffect(() => {
    if (!namespace) return;
    const key = `${handle}/${namespace}`;
    let p = canCache.get(key);
    if (!p) {
      p = api.invoke("cluster:access", { handle, checks: [{ verb: "create", group: "", resource: "pods", subresource: "exec", namespace }] }).then((r) => r.allowed[0] === true, () => true);
      canCache.set(key, p);
      setTimeout(() => canCache.delete(key), 60_000);
    }
    let alive = true;
    void p.then((v) => alive && setCan(v));
    return () => {
      alive = false;
    };
  }, [handle, namespace]);
  return can;
}

const ready = (o: KubeObject) => (o.status?.conditions ?? []).some((c: { type: string; status: string }) => c.type === "Ready" && c.status === "True");

/** A container that can take a shell: running, and not an init container. */
export function shellable(pod: KubeObject): { name: string; running: boolean; why?: string }[] {
  const st = new Map<string, any>((pod.status?.containerStatuses ?? []).map((s: any) => [s.name, s]));
  const init = ((pod.spec?.initContainers ?? []) as { name: string }[]).map((c) => ({ name: c.name, running: false, why: "init container" }));
  const main = ((pod.spec?.containers ?? []) as { name: string }[]).map((c) => {
    const s = st.get(c.name);
    const running = !!s?.state?.running;
    return { name: c.name, running, ...(running ? {} : { why: s?.state?.waiting?.reason ?? s?.state?.terminated?.reason ?? "not running" }) };
  });
  return [...main, ...init];
}

export function targetOf(pod: KubeObject, container: string, shell: Shell): ShellTarget {
  const labels = stableLabels(pod.metadata.labels);
  return { namespace: pod.metadata.namespace!, pod: pod.metadata.name, container, shell, ...(labels ? { labels } : {}) };
}

/**
 * The menu: for a workload, its pods (ready first, newest first); for a pod, its containers. The foot picks the shell.
 * Opening with one running container and no choice to make skips the menu (the caller checks `direct`).
 */
export function ShellMenu(props: {
  handle: string;
  pod?: KubeObject;
  workload?: { namespace: string; selector: Record<string, string> };
  onPick: (t: ShellTarget) => void;
  onClose: () => void;
}) {
  const [shell, setShell] = useState<Shell>("auto");
  const [pod, setPod] = useState<KubeObject | undefined>(props.pod);
  const self = useRef<HTMLDivElement>(null);
  const pods = useWatch(props.workload ? { handle: props.handle, group: "", version: "v1", resource: "pods", namespace: props.workload.namespace } : undefined);
  const list = useMemo(() => (props.workload ? pods.items.filter((o) => matches(o.metadata.labels, props.workload!.selector) && !o.metadata.deletionTimestamp)
    .sort((a, b) => Number(ready(b)) - Number(ready(a)) || (b.metadata.creationTimestamp ?? "").localeCompare(a.metadata.creationTimestamp ?? "")) : []), [pods.items, props.workload]);

  useEffect(() => {
    const close = (e: MouseEvent) => !self.current?.contains(e.target as Node) && props.onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), props.onClose());
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key, true);
    setTimeout(() => self.current?.querySelector<HTMLButtonElement>(".cluster-option:not(:disabled)")?.focus(), 0);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key, true);
    };
  }, [pod]); // eslint-disable-line react-hooks/exhaustive-deps

  const arrows = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(self.current?.querySelectorAll<HTMLButtonElement>(".cluster-option:not(:disabled)") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  };

  return (
    <div ref={self} className="menu shell-menu" role="menu" aria-label="Open shell" onKeyDown={arrows}>
      {!pod ? (
        <>
          <div className="menu-label">Open a shell in</div>
          {pods.loading ? <div className="menu-label">Loading pods…</div> : !list.length ? <div className="menu-label">No pods.</div> : null}
          {list.slice(0, 20).map((p) => (
            <button key={p.metadata.uid} className="cluster-option" role="menuitem" onClick={() => {
              const cs = shellable(p).filter((c) => c.running);
              if (cs.length === 1 && (p.spec?.containers ?? []).length === 1) return props.onPick(targetOf(p, cs[0]!.name, shell));
              setPod(p);
            }}>
              <Ic icon={Box} size={13} /><span className="name mono">{p.metadata.name}</span>{ready(p) ? null : <small className="why">not ready</small>}
            </button>
          ))}
        </>
      ) : (
        <>
          <div className="menu-label">
            {props.workload ? <button className="icon-btn" aria-label="Back to pods" onClick={() => setPod(undefined)} style={{ width: 20, height: 20, marginRight: 4 }}><Ic icon={ChevronLeft} size={12} /></button> : null}
            Container in <span className="mono">{pod.metadata.name}</span>
          </div>
          {shellable(pod).map((c) => (
            <button key={c.name} className="cluster-option" role="menuitem" disabled={!c.running} title={c.why} onClick={() => props.onPick(targetOf(pod, c.name, shell))}>
              <Ic icon={SquareTerminal} size={13} /><span className="name mono">{c.name}</span>{c.why ? <small className="why">{c.why}</small> : null}
            </button>
          ))}
        </>
      )}
      <div className="menu-foot">
        Shell
        <div className="seg" role="radiogroup" aria-label="Shell">
          {(["auto", "bash", "sh"] as const).map((s) => (
            <button key={s} role="radio" aria-checked={shell === s} className={shell === s ? "on" : ""} onClick={() => setShell(s)}>{s === "auto" ? "Auto" : s}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The shell to open right away, when there is nothing to choose: a pod with one running container. */
export function direct(pod: KubeObject): ShellTarget | undefined {
  const cs = shellable(pod);
  return cs.length === 1 && cs[0]!.running ? targetOf(pod, cs[0]!.name, "auto") : undefined;
}

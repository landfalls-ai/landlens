// One menu for an object (wave 8, D146), from a row's right-click, its ⋯ key, or the drawer's ⋯ button: Open (Logs,
// Open shell, Edit YAML), Actions (Scale…, Restart, Trigger now, Suspend/Resume), Ask Claude, Copy name, and Delete…
// last, in the bad colour. An action the person's role can't take is shown disabled with the reason; RBAC is read
// through `cluster:access` (SelfSubjectAccessReview as you) and kept 60 seconds. A Secret has Delete only, and no
// Ask Claude. Arrow keys, Home and End, type-ahead, Esc.
import type { ActionKind, KubeObject, ResourceType } from "@landlens/contracts";
import { Ban, Copy, Pause, Pencil, Play, RotateCcw, Scale, ScrollText, Sparkles, SquareTerminal, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { accessFor, actionsFor, isSecretType } from "./actionAsks";
import { api } from "./api";
import { copyText } from "./present";
import { Ic, type LucideIcon } from "./icons";
import { logSourceOf } from "./LogsView";

const cache = new Map<string, Promise<boolean>>();

/** Whether your role allows each action on this kind here, read once a minute (D146). Unknown counts as allowed. */
export function useCanAct(handle: string, type: ResourceType, namespace: string | undefined, kinds: ActionKind[]): Partial<Record<ActionKind, boolean>> {
  const [can, setCan] = useState<Partial<Record<ActionKind, boolean>>>({});
  const sig = kinds.join(",");
  useEffect(() => {
    let alive = true;
    const out: Partial<Record<ActionKind, boolean>> = {};
    void Promise.all(kinds.map(async (k) => {
      const a = accessFor(k, type);
      const key = `${handle}/${namespace ?? ""}/${a.verb}/${a.group}/${a.resource}`;
      let p = cache.get(key);
      if (!p) {
        p = api.invoke("cluster:access", { handle, checks: [{ verb: a.verb, group: a.group, resource: a.resource, ...(namespace && type.namespaced ? { namespace } : {}) }] })
          .then((r) => r.allowed[0] !== false, () => true);
        cache.set(key, p);
        setTimeout(() => cache.delete(key), 60_000);
      }
      out[k] = await p;
    })).then(() => alive && setCan(out));
    return () => void (alive = false);
  }, [handle, type.group, type.resource, namespace, sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return can;
}

const ICON: Record<ActionKind | "resume", LucideIcon> = { scale: Scale, restart: RotateCcw, trigger: Play, suspend: Pause, resume: Play, delete: Trash2 };
/** "Your role can't patch deployments in landlens-dev" (D146): the check's own verb and resource. */
const cant = (k: ActionKind, type: ResourceType, ns?: string) => {
  const a = accessFor(k, type);
  return `Your role can't ${a.verb} ${a.resource}${ns && type.namespaced ? ` in ${ns}` : ""}`;
};

type Item = { key: string; label: string; icon: LucideIcon; kbd?: string; disabled?: boolean; why?: string; tone?: "bad"; run: () => void; section: string };

export function ObjectMenu({ at, handle, type, object: o, pods, onOpen, onAction, onAsk, onClose, label }: {
  at: { x: number; y: number };
  handle: string;
  type: ResourceType;
  object: KubeObject;
  pods: boolean;
  /** The drawer's own menu leaves out what its tabs already are (Logs, shell, Edit). */
  onOpen?: (a: "logs" | "shell" | "edit") => void;
  onAction: (kind: ActionKind, suspend?: boolean) => void;
  onAsk: () => void;
  onClose: () => void;
  label?: string;
}) {
  const self = useRef<HTMLDivElement>(null);
  const secret = isSecretType(type);
  const acts = actionsFor(type, o);
  const can = useCanAct(handle, type, o.metadata.namespace, acts.map((a) => a.kind));
  const typed = useRef({ s: "", t: 0 });
  const logs = !!logSourceOf(type.kind, o);
  const shell = pods || !!logSourceOf(type.kind, o)?.selector;
  const run = (f: () => void) => () => (onClose(), f());
  const items: Item[] = [];
  if (onOpen) {
    items.push({ section: "Open", key: "logs", label: "Logs", icon: ScrollText, kbd: "L", disabled: !logs, run: run(() => onOpen("logs")) });
    items.push({ section: "Open", key: "shell", label: "Open shell", icon: SquareTerminal, kbd: "S", disabled: !shell, run: run(() => onOpen("shell")) });
    items.push({ section: "Open", key: "edit", label: "Edit YAML", icon: Pencil, kbd: "E", disabled: secret, ...(secret ? { why: "Secrets stay locked" } : {}), run: run(() => onOpen("edit")) });
  }
  for (const a of acts.filter((x) => x.kind !== "delete")) {
    const no = can[a.kind] === false;
    items.push({ section: "Actions", key: a.kind, label: a.label, icon: ICON[a.kind === "suspend" && !a.suspend ? "resume" : a.kind], disabled: no, ...(no ? { why: cant(a.kind, type, o.metadata.namespace) } : {}), run: run(() => onAction(a.kind, a.suspend)) });
  }
  if (!secret) items.push({ section: "Ask", key: "ask", label: "Ask Claude", icon: Sparkles, run: run(onAsk) });
  items.push({ section: "Ask", key: "copy", label: "Copy name", icon: Copy, run: run(() => void copyText(o.metadata.name)) });
  if (acts.some((a) => a.kind === "delete")) {
    const no = can.delete === false;
    items.push({ section: "Delete", key: "delete", label: "Delete…", icon: no ? Ban : Trash2, kbd: "⌫", tone: "bad", disabled: no, ...(no ? { why: cant("delete", type, o.metadata.namespace) } : {}), run: run(() => onAction("delete")) });
  }

  useEffect(() => {
    const close = (e: MouseEvent) => !self.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      const btns = [...(self.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Escape") return (e.preventDefault(), e.stopPropagation(), onClose());
      if (e.key === "Tab") return (e.preventDefault(), onClose());
      if (e.key === "ArrowDown" || e.key === "ArrowUp") return (e.preventDefault(), btns[(i + (e.key === "ArrowDown" ? 1 : btns.length - 1)) % btns.length]?.focus());
      if (e.key === "Home" || e.key === "End") return (e.preventDefault(), (e.key === "Home" ? btns[0] : btns.at(-1))?.focus());
      if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Type-ahead: letters typed within a second find the next item starting with them.
        const now = Date.now();
        typed.current = { s: (now - typed.current.t < 1000 ? typed.current.s : "") + e.key.toLowerCase(), t: now };
        const order = [...btns.slice(i + 1), ...btns.slice(0, i + 1)];
        const hit = order.find((b) => (b.dataset.label ?? "").toLowerCase().startsWith(typed.current.s));
        if (hit) (e.preventDefault(), hit.focus());
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key, true);
    self.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key, true);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const height = 32 + items.length * 31 + items.filter((i) => i.why).length * 14;
  const left = Math.max(8, Math.min(at.x, window.innerWidth - 248));
  const top = Math.max(8, Math.min(at.y, window.innerHeight - height - 8));
  let last = "";
  return (
    <div ref={self} className="menu row-menu object-menu" role="menu" aria-label={label ?? `${type.kind} ${o.metadata.name}`} style={{ left, top }}>
      {items.map((it) => {
        const hr = last && last !== it.section;
        last = it.section;
        return (
          <div key={it.key} className="menu-group" role="none">
            {hr ? <hr /> : null}
            <button className={`cluster-option${it.tone === "bad" ? " bad" : ""}${it.why ? " with-why" : ""}`} role="menuitem" data-label={it.label} disabled={!!it.disabled} title={it.why} onClick={it.run}>
              <Ic icon={it.icon} size={14} />
              <span className="name">{it.label}{it.why ? <small className="why-line">{it.why}</small> : null}</span>
              {!it.why && it.kbd ? <kbd>{it.kbd}</kbd> : null}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// One menu for an object (wave 8, D146), from a row's right-click, its ⋯ key, or the drawer's ⋯ button: Open (Logs,
// Open shell, Edit YAML), Actions (Scale…, Restart, Trigger now, Suspend/Resume), Ask Claude, Copy name, and Delete…
// last, in the bad colour. An action the person's role can't take is shown disabled with the reason; RBAC is read
// through `cluster:access` (SelfSubjectAccessReview as you) and kept 60 seconds. A Secret has Delete only, and no
// Ask Claude. Arrow keys, Home and End, type-ahead, Esc.
// Part 3 (D159): Ask Claude opens a submenu of the kind's preset asks (→ or a click or hover; ← or Esc goes back),
// with "Why is this failing?" first on a row in trouble; its first item attaches the object without a question.
import type { ActionKind, KubeObject, ResourceType } from "@landlens/contracts";
import type { Tone } from "@landlens/kube/status";
import { Ban, ChevronRight, CircleCheck, CircleSlash, Copy, LogOut, Paperclip, Pause, Pencil, Play, RotateCcw, Scale, ScrollText, Sparkles, SquareTerminal, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { presetsFor, type PresetId } from "./askPresets";
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
      const key = `${handle}/${namespace ?? ""}/${a.verb}/${a.group}/${a.resource}/${a.subresource ?? ""}`;
      let p = cache.get(key);
      if (!p) {
        p = api.invoke("cluster:access", { handle, checks: [{ verb: a.verb, group: a.group, resource: a.resource, ...(a.subresource ? { subresource: a.subresource } : {}), ...(namespace && type.namespaced ? { namespace } : {}) }] })
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

const ICON: Record<ActionKind | "resume" | "uncordon", LucideIcon> = { scale: Scale, restart: RotateCcw, trigger: Play, suspend: Pause, resume: Play, delete: Trash2, cordon: CircleSlash, uncordon: CircleCheck, drain: LogOut };
/** "Your role can't patch deployments in landlens-dev" (D146): the check's own verb and resource. */
const cant = (k: ActionKind, type: ResourceType, ns?: string) => {
  const a = accessFor(k, type);
  return `Your role can't ${a.verb} ${a.resource}${a.subresource ? `/${a.subresource}` : ""}${ns && type.namespaced ? ` in ${ns}` : ""}`;
};

type Item = { key: string; label: string; icon: LucideIcon; kbd?: string; disabled?: boolean; why?: string; tone?: "bad"; run: () => void; section: string; sub?: true };

export function ObjectMenu({ at, handle, type, object: o, pods, onOpen, onAction, onAsk, onPreset, tone, onClose, label }: {
  at: { x: number; y: number };
  handle: string;
  type: ResourceType;
  object: KubeObject;
  pods: boolean;
  /** The drawer's own menu leaves out what its tabs already are (Logs, shell, Edit). */
  onOpen?: (a: "logs" | "shell" | "edit") => void;
  /** `flag`: suspend (true) or resume for Suspend; cordon (true) or uncordon for Cordon. */
  onAction: (kind: ActionKind, flag?: boolean) => void;
  onAsk: () => void;
  /** A preset ask (D159): its fixed question, with the object attached as Ask Claude attaches it. */
  onPreset?: (id: PresetId) => void;
  /** The row's tone: "Why is this failing?" comes first when it is bad or warn. */
  tone?: Tone;
  onClose: () => void;
  label?: string;
}) {
  const self = useRef<HTMLDivElement>(null);
  const subBox = useRef<HTMLDivElement>(null);
  const [sub, setSubNow] = useState<{ top: number }>();
  const subOpen = useRef(false);
  const setSub = (v: { top: number } | undefined) => ((subOpen.current = !!v), setSubNow(v));
  const presets = onPreset ? presetsFor(type, tone) : [];
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
    const icon = ICON[a.kind === "suspend" && !a.suspend ? "resume" : a.kind === "cordon" && !a.on ? "uncordon" : a.kind];
    items.push({ section: "Actions", key: a.kind, label: a.label, icon, disabled: no, ...(no ? { why: cant(a.kind, type, o.metadata.namespace) } : {}), run: run(() => onAction(a.kind, a.kind === "cordon" ? a.on : a.suspend)) });
  }
  if (!secret) {
    items.push(presets.length
      ? { section: "Ask", key: "ask", label: "Ask Claude", icon: Sparkles, sub: true, run: () => openSub() }
      : { section: "Ask", key: "ask", label: "Ask Claude", icon: Sparkles, run: run(onAsk) });
  }
  items.push({ section: "Ask", key: "copy", label: "Copy name", icon: Copy, run: run(() => void copyText(o.metadata.name)) });
  if (acts.some((a) => a.kind === "delete")) {
    const no = can.delete === false;
    items.push({ section: "Delete", key: "delete", label: "Delete…", icon: no ? Ban : Trash2, kbd: "⌫", tone: "bad", disabled: no, ...(no ? { why: cant("delete", type, o.metadata.namespace) } : {}), run: run(() => onAction("delete")) });
  }

  /** The Ask submenu, beside its item; focus on its first preset. */
  const openSub = () => {
    const item = self.current?.querySelector<HTMLElement>('[data-key="ask"]');
    setSub({ top: item ? item.offsetTop - 4 : 0 });
    setTimeout(() => subBox.current?.querySelector<HTMLButtonElement>("button[data-sub]:not([data-attach])")?.focus(), 0);
  };
  /** Hover opens the submenu without moving focus. */
  const openSubQuiet = () => {
    const item = self.current?.querySelector<HTMLElement>('[data-key="ask"]');
    setSub({ top: item ? item.offsetTop - 4 : 0 });
  };
  const closeSub = () => {
    setSub(undefined);
    self.current?.querySelector<HTMLButtonElement>('[data-key="ask"]')?.focus();
  };

  useEffect(() => {
    const close = (e: MouseEvent) => !self.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      // Inside the Ask submenu the keys move among its items; ← or Esc goes back to Ask Claude.
      const inSub = subOpen.current;
      const btns = [...(self.current?.querySelectorAll<HTMLButtonElement>(inSub ? "button[data-sub]:not(:disabled)" : "button[data-main]:not(:disabled)") ?? [])];
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      if (inSub && (e.key === "Escape" || e.key === "ArrowLeft")) return (e.preventDefault(), e.stopPropagation(), closeSub());
      if (!inSub && e.key === "ArrowRight" && (document.activeElement as HTMLElement | null)?.dataset.key === "ask" && presets.length) return (e.preventDefault(), openSub());
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
    self.current?.querySelector<HTMLButtonElement>("button[data-main]:not(:disabled)")?.focus();
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
            <button className={`cluster-option${it.tone === "bad" ? " bad" : ""}${it.why ? " with-why" : ""}${it.sub && sub ? " on" : ""}`} role="menuitem" data-main="" data-key={it.key} data-label={it.label} disabled={!!it.disabled} title={it.why}
              {...(it.sub ? { "aria-haspopup": "menu" as const, "aria-expanded": !!sub } : {})}
              onClick={it.run} onMouseEnter={() => (it.sub ? !sub && openSubQuiet() : sub && setSub(undefined))}>
              <Ic icon={it.icon} size={14} />
              <span className="name">{it.label}{it.why ? <small className="why-line">{it.why}</small> : null}</span>
              {it.sub ? <Ic icon={ChevronRight} size={13} className="sub-chev" /> : !it.why && it.kbd ? <kbd>{it.kbd}</kbd> : null}
            </button>
          </div>
        );
      })}
      {sub ? (
        <div ref={subBox} className={`menu object-menu ask-sub${left + 240 + 236 > window.innerWidth ? " to-left" : ""}`} role="menu" aria-label="Ask Claude" style={{ top: sub.top }}>
          <button className="cluster-option" role="menuitem" data-sub="" data-attach="" data-label="Attach" onClick={run(onAsk)}>
            <Ic icon={Paperclip} size={14} /><span className="name">Attach to a question</span>
          </button>
          <hr />
          {presets.map((p) => (
            <button key={p.id} className="cluster-option" role="menuitem" data-sub="" data-label={p.label} onClick={run(() => onPreset!(p.id))}>
              <Ic icon={Sparkles} size={14} /><span className="name">{p.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The drawer's Ask Claude caret (D159): the kind's preset asks as a small menu under it. Arrow keys, Home and End,
 * Esc; a click outside closes it.
 */
export function PresetMenu({ at, type, tone, onPick, onClose }: { at: { x: number; y: number }; type: ResourceType; tone?: Tone; onPick: (id: PresetId) => void; onClose: () => void }) {
  const self = useRef<HTMLDivElement>(null);
  const presets = presetsFor(type, tone);
  useEffect(() => {
    const close = (e: MouseEvent) => !self.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      const btns = [...(self.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Escape" || e.key === "Tab") return (e.preventDefault(), e.stopPropagation(), onClose());
      if (e.key === "ArrowDown" || e.key === "ArrowUp") return (e.preventDefault(), btns[(i + (e.key === "ArrowDown" ? 1 : btns.length - 1)) % btns.length]?.focus());
      if (e.key === "Home" || e.key === "End") return (e.preventDefault(), (e.key === "Home" ? btns[0] : btns.at(-1))?.focus());
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key, true);
    self.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key, true);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const left = Math.max(8, Math.min(at.x, window.innerWidth - 228));
  return (
    <div ref={self} className="menu row-menu object-menu preset-menu" role="menu" aria-label="Preset asks" style={{ left, top: at.y }}>
      {presets.map((p) => (
        <button key={p.id} className="cluster-option" role="menuitem" onClick={() => (onClose(), onPick(p.id))}>
          <Ic icon={Sparkles} size={14} /><span className="name">{p.label}</span>
        </button>
      ))}
    </div>
  );
}

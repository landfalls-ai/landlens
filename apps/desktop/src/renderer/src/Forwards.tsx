// Port-forwards in the window (D33–D37): a Forward link on each port (a pod's containers, a Service's ports), its
// popover, the running forward on its port line, and the panel's pinned Forwards tab. Main owns the forwards; the
// window shows them and asks.
import type { ForwardInfo } from "@landlens/contracts";
import { age } from "@landlens/kube/status";
import { ArrowLeftRight, CircleX, Copy, ExternalLink, Play, ShieldCheck, Square, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, type ApiError } from "./api";
import { Ic } from "./icons";
import { copyText } from "./present";

// --- the store: one list from main, shared by every view ---

let all: ForwardInfo[] = [];
const listeners = new Set<() => void>();
const set = (l: ForwardInfo[]) => {
  all = l;
  listeners.forEach((f) => f());
};
api.on("forward:update", (p: { forwards: ForwardInfo[] }) => set(p.forwards));
void api.invoke("forward:list", {}).then((r) => set(r.forwards), () => {});
const subscribe = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));

/** This cluster's forwards (by context: a reconnect gets a new handle). */
export function useForwards(context: string): ForwardInfo[] {
  const list = useSyncExternalStore(subscribe, () => all);
  return list.filter((f) => f.context === context);
}

/** Whether your role may port-forward in a namespace (undefined while asking). */
const canCache = new Map<string, Promise<boolean>>();
export function useCanForward(handle: string, namespace: string | undefined): boolean | undefined {
  const [can, setCan] = useState<boolean>();
  useEffect(() => {
    if (!namespace) return;
    const key = `${handle}/${namespace}`;
    let p = canCache.get(key);
    if (!p) {
      p = api.invoke("cluster:access", { handle, checks: [{ verb: "create", group: "", resource: "pods", subresource: "portforward", namespace }] }).then((r) => r.allowed[0] === true, () => true);
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

export type ForwardTarget = { namespace: string; kind: "pod" | "service"; name: string; port: number };
const address = (f: Pick<ForwardInfo, "localPort">) => `127.0.0.1:${f.localPort}`;
const live = (f: ForwardInfo) => f.state === "running" || f.state === "starting" || f.state === "reconnecting";

// --- a port line ---

/** One port: "8080/TCP http", then Forward, or the running forward's address with Open and Stop (D34). */
export function PortLine(props: { handle: string; context: string; target: ForwardTarget; label?: string; protocol?: string; can: boolean | undefined; ready: boolean; notReady?: string }) {
  const t = props.target;
  const forwards = useForwards(props.context);
  const mine = forwards.find((f) => live(f) && f.namespace === t.namespace && f.kind === t.kind && f.name === t.name && f.port === t.port);
  const [pop, setPop] = useState(false);
  const tcp = (props.protocol ?? "TCP") === "TCP";
  const why = !tcp ? "Only TCP ports can be forwarded" : props.can === false ? `Your role can't port-forward in ${t.namespace}` : !props.ready ? props.notReady ?? "Not running" : undefined;
  return (
    <div className="port">
      <span className="mono">{t.port}/{props.protocol ?? "TCP"}</span>
      {props.label ? <span className="to">{props.label}</span> : null}
      {mine ? (
        <span className="fw-on">
          <span title={mine.state === "running" ? "Forwarding" : mine.message}>{address(mine)}</span>
          {mine.state !== "running" ? <span className="tone-warn">{mine.state === "reconnecting" ? "reconnecting" : "starting"}</span> : null}
          <button className="icon-btn sm" aria-label={`Open ${address(mine)} in your browser`} title="Open in browser" onClick={() => void api.invoke("forward:open", { id: mine.id })}><Ic icon={ExternalLink} size={12} /></button>
          <button className="icon-btn sm" aria-label={`Stop forwarding ${address(mine)}`} title="Stop" onClick={() => void api.invoke("forward:stop", { id: mine.id })}><Ic icon={Square} size={12} /></button>
        </span>
      ) : (
        <span className="fw-anchor">
          <button className="link-btn" disabled={!!why} title={why ?? "Forward this port to 127.0.0.1"} aria-label={`Forward ${t.name} port ${t.port}`} aria-haspopup="dialog" aria-expanded={pop} onClick={() => setPop((p) => !p)}>
            <Ic icon={ArrowLeftRight} size={12} />Forward
          </button>
          {pop ? <ForwardPop handle={props.handle} target={t} onClose={() => setPop(false)} /> : null}
        </span>
      )}
    </div>
  );
}

// --- the popover (D33) ---

export function ForwardPop(props: { handle: string; target: ForwardTarget; onClose: () => void }) {
  const t = props.target;
  const [port, setPort] = useState("");
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState<{ next?: number; message: string }>();
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const self = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api.invoke("forward:suggest", { port: t.port }).then((r) => setPort(String(r.port)), () => {});
    setTimeout(() => input.current?.focus(), 0);
    const away = (e: MouseEvent) => !self.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.(".fw-anchor") && props.onClose();
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const n = Number(port);
  const valid = /^\d+$/.test(port) && n >= 1024 && n <= 65535;
  const pickFree = () => void api.invoke("forward:suggest", { port: 49152 + Math.floor(Math.random() * 1000) }).then((r) => (setPort(String(r.port)), setBusy(undefined)));
  const start = async () => {
    if (!valid || starting) return;
    setStarting(true);
    setError(undefined);
    try {
      await api.invoke("forward:start", { handle: props.handle, namespace: t.namespace, kind: t.kind, name: t.name, port: t.port, localPort: n, keep });
      props.onClose();
    } catch (e) {
      // The status doesn't survive the context bridge (only the message does), so the words say it.
      const m = /^Port \d+ is in use\.(?: (\d+) is free\.)?$/.exec((e as ApiError).message);
      if (m) setBusy({ message: `Port ${n} is in use.`, ...(m[1] ? { next: Number(m[1]) } : {}) });
      else setError((e as ApiError).message);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div ref={self} className="pop fw-pop" role="dialog" aria-label={`Forward ${t.name}:${t.port}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") (e.stopPropagation(), props.onClose());
        if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type !== "checkbox") (e.preventDefault(), void start());
      }}>
      <h4>Forward {t.kind === "service" ? "service" : "pod"} {t.name}:{t.port}</h4>
      <div className="row">
        <span className="fixed">127.0.0.1 :</span>
        <label className="field"><span className="sr-only">Local port</span>
          <input ref={input} inputMode="numeric" value={port} aria-invalid={!valid && port !== ""} onChange={(e) => (setPort(e.target.value.replace(/\D/g, "").slice(0, 5)), setBusy(undefined))} />
        </label>
        <button className="link-btn" onClick={pickFree}>Pick a free port</button>
      </div>
      {busy ? (
        <div className="change-fact warn" role="alert"><Ic icon={TriangleAlert} size={12} />{busy.message}{busy.next ? <> <button className="link-btn" onClick={() => (setPort(String(busy.next)), setBusy(undefined))}>Use {busy.next}</button></> : null}</div>
      ) : !valid && port !== "" ? <div className="change-fact warn">Use a port from 1024 to 65535.</div> : null}
      {error ? <div className="change-fact bad" role="alert"><Ic icon={CircleX} size={12} />{error}</div> : null}
      <small>Only this Mac can reach it. It runs as you, through Landlens.</small>
      <label className="check-box"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />Keep after restart</label>
      <div className="row">
        <button className="primary" disabled={!valid || starting} onClick={() => void start()}>{starting ? <><span className="spinner" />Starting…</> : <>Start<kbd aria-hidden="true">⏎</kbd></>}</button>
        <button className="secondary" onClick={props.onClose}>Cancel</button>
      </div>
    </div>
  );
}

// --- the panel's Forwards tab (D35) ---

const STATE: Record<ForwardInfo["state"], [string, string]> = {
  running: ["Running", "tone-ok"], starting: ["Starting", "tone-warn"], reconnecting: ["Reconnecting", "tone-warn"],
  failed: ["Failed", "tone-bad"], stopped: ["Stopped", "tone-muted"],
};

export function ForwardsList(props: { handle: string; context: string }) {
  const forwards = useForwards(props.context);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  const act = (p: Promise<unknown>) => void p.then(() => setError(undefined), (e: ApiError) => setError(e.message));
  if (!forwards.length) {
    return (
      <div className="empty">
        <strong>No forwards</strong>
        <span>Forward a port from a pod's containers or a Service's ports in the drawer.</span>
      </div>
    );
  }
  return (
    <>
      {error ? <div className="change-fact bad fw-error" role="alert"><Ic icon={CircleX} size={12} />{error}</div> : null}
      <div className="fw-list" role="list" aria-label="Port forwards">
        {forwards.map((f) => {
          const on = live(f);
          const [word, tone] = STATE[f.state];
          const to = f.pod ? `pod/${f.pod}:${f.podPort}` : `${f.kind}/${f.name}:${f.port}`;
          return (
            <div key={f.id} className={"fw-row" + (on ? "" : " off")} role="listitem" aria-label={`${word}: ${address(f)} to ${f.kind} ${f.name} port ${f.port}`}>
              <span className={`st ${tone}`}>{f.state === "starting" || f.state === "reconnecting" ? <span className="spinner" /> : <i className="dot" />}{word}</span>
              <span className="fw-map" title={f.kind === "service" ? `service/${f.name}:${f.port}${f.pod ? ` through pod/${f.pod}:${f.podPort}` : ""}` : undefined}>
                <span className="addr">{address(f)}</span><span className="to">→</span>
                <span>{f.kind === "service" ? `service/${f.name}:${f.port}${f.pod ? ` · ${f.pod}` : ""}` : to}</span>
              </span>
              <span className="ns">
                {f.message && f.state !== "running" ? <span className={f.state === "failed" ? "fw-why" : "tone-warn"}>{f.message}</span>
                  : f.lastError ? <span className="tone-warn" title={f.lastError}>{f.lastError}</span>
                  : f.namespace}
              </span>
              <span className="age">{on ? age(f.since, now) : ""}</span>
              <span className="fw-acts">
                {on ? (
                  <>
                    <button className="icon-btn" aria-label={`Open ${address(f)} in your browser`} title="Open in browser" disabled={f.state !== "running"} onClick={() => act(api.invoke("forward:open", { id: f.id }))}><Ic icon={ExternalLink} size={14} /></button>
                    <button className="icon-btn" aria-label={copied === f.id ? "Address copied" : `Copy ${address(f)}`} title={copied === f.id ? "Copied" : "Copy address"}
                      onClick={() => void copyText(address(f)).then(() => (setCopied(f.id), setTimeout(() => setCopied(undefined), 1200)))}><Ic icon={Copy} size={14} /></button>
                    <button className="icon-btn" aria-label={`Stop forwarding ${address(f)}`} title="Stop" onClick={() => act(api.invoke("forward:stop", { id: f.id }))}><Ic icon={Square} size={14} /></button>
                  </>
                ) : (
                  <>
                    <button className="icon-btn" aria-label={`Start forwarding ${address(f)} again`} title="Start" onClick={() => act(api.invoke("forward:resume", { id: f.id, handle: props.handle }))}><Ic icon={Play} size={14} /></button>
                    <button className="icon-btn" aria-label={`Remove the forward on ${address(f)}`} title="Remove" onClick={() => act(api.invoke("forward:remove", { id: f.id }))}><Ic icon={Trash2} size={14} /></button>
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <div className="fw-foot"><Ic icon={ShieldCheck} size={12} />Forwards listen on 127.0.0.1 only. Kept ones come back when you reconnect to {props.context}.</div>
    </>
  );
}

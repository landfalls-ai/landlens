// The panel (D1–D4, D22): under the table and the drawer, beside the dock. Tabs are pod shells, local terminals and
// logs. Hiding it never ends a session; closing a tab does. Every tab stays mounted while it lives, so a hidden
// shell keeps running and keeps its screen.
import type { ClusterInfo } from "@landlens/contracts";
import { ArrowLeftRight, ChevronDown, CircleDashed, Maximize2, Minimize2, Plus, ScrollText, SquareTerminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AskContext } from "./AgentDock";
import { BENCH_MIN, elide, FORWARDS, type BenchState, type BenchTab } from "./benchState";
import { ForwardsList, useForwards } from "./Forwards";
import { Ic, MOD } from "./icons";
import { LogsView } from "./LogsView";
import { TerminalView } from "./TerminalView";

export function Bench(props: { bench: BenchState; cluster: ClusterInfo; onAsk: (c: AskContext) => void; appHeight: number }) {
  const b = props.bench;
  const [menu, setMenu] = useState(false);
  const [drag, setDrag] = useState(false);
  const self = useRef<HTMLElement>(null);
  const forwards = useForwards(props.cluster.context);
  const running = forwards.filter((f) => f.state === "running" || f.state === "starting" || f.state === "reconnecting").length;
  const pinned = forwards.length > 0 || b.active === FORWARDS;

  // The tallest it may be: the toolbar and four rows stay.
  const maxH = Math.max(BENCH_MIN, props.appHeight - 48 - 4 * 32 - 26);
  const resize = (h: number) => b.setHeight(Math.min(maxH, Math.max(BENCH_MIN, h)));
  const current = () => self.current?.getBoundingClientRect().height ?? 300;

  const onGrip = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = current();
    setDrag(true);
    const move = (ev: PointerEvent) => resize(startH + (startY - ev.clientY));
    const up = () => {
      setDrag(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest(".bench-acts") && setMenu(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  return (
    <section ref={self} className="bench" role="region" aria-label="Panel" hidden={!b.open}>
      {!b.max ? (
        <div className={"bench-grip" + (drag ? " drag" : "")} role="separator" aria-orientation="horizontal" aria-label="Resize the panel" tabIndex={0}
          aria-valuemin={BENCH_MIN} aria-valuemax={maxH} aria-valuenow={Math.round(b.height ?? 300)}
          onPointerDown={onGrip} onDoubleClick={() => b.setMax(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") (e.preventDefault(), resize(current() + 16));
            if (e.key === "ArrowDown") (e.preventDefault(), resize(current() - 16));
          }} />
      ) : null}
      <div className="bench-head">
        <div className="bench-tabs" role="tablist" aria-label="Panel tabs">
          {b.tabs.map((t) => (
            <TabButton key={t.id} tab={t} on={t.id === b.active} live={t.kind === "logs" || !!b.live[t.id]} onPick={() => b.setActive(t.id)} onClose={() => b.close(t.id)} />
          ))}
          {pinned ? (
            <>
              {b.tabs.length ? <span className="bench-sep" aria-hidden="true" /> : null}
              <div className={"bench-tab pinned" + (b.active === FORWARDS ? " on" : "")} title="Port forwards">
                <button role="tab" id={`tab-${FORWARDS}`} aria-selected={b.active === FORWARDS} aria-controls={`pane-${FORWARDS}`} className="bt-name" onClick={() => b.setActive(FORWARDS)}>
                  <Ic icon={ArrowLeftRight} size={13} /> <b>Forwards</b>
                </button>
                {running ? <span className="count" aria-label={`${running} running`}>{running}</span> : null}
              </div>
            </>
          ) : null}
        </div>
        <div className="bench-acts">
          <button className="icon-btn" aria-label="New" aria-haspopup="menu" aria-expanded={menu} title="New terminal" onClick={() => setMenu((m) => !m)}><Ic icon={Plus} size={14} /></button>
          {menu ? (
            <div className="menu" role="menu">
              <button className="cluster-option" role="menuitem" onClick={() => (setMenu(false), b.openLocal())}>
                <Ic icon={SquareTerminal} size={14} /><span className="name">New local terminal</span><kbd>⌃⇧`</kbd>
              </button>
              <div className="menu-foot">Pod shells open from a pod: its drawer, a container, or a row's menu.</div>
            </div>
          ) : null}
          <button className="icon-btn" aria-label={b.max ? "Restore the panel" : "Maximise the panel"} title={b.max ? "Restore" : "Maximise"} onClick={() => b.setMax(!b.max)}>
            <Ic icon={b.max ? Minimize2 : Maximize2} size={14} />
          </button>
          <button className="icon-btn" aria-label="Hide the panel" title={`Hide (${MOD}\`)`} onClick={() => b.setOpen(false)}><Ic icon={ChevronDown} size={15} /></button>
        </div>
      </div>
      <div className="bench-body">
        {!b.tabs.length && b.active !== FORWARDS ? (
          <div className="empty">
            <strong>Nothing open</strong>
            <span>Open a shell or logs from a pod, or a terminal on this Mac.</span>
            <button className="secondary" onClick={b.openLocal}><Ic icon={SquareTerminal} size={13} />New local terminal</button>
          </div>
        ) : null}
        {b.active === FORWARDS ? (
          <div className="bench-pane" role="tabpanel" id={`pane-${FORWARDS}`} aria-labelledby={`tab-${FORWARDS}`}>
            <ForwardsList handle={props.cluster.handle} context={props.cluster.context} />
          </div>
        ) : null}
        {b.tabs.map((t) => (
          <div key={t.id} className="bench-pane" role="tabpanel" id={`pane-${t.id}`} aria-labelledby={`tab-${t.id}`} hidden={t.id !== b.active}>
            {t.kind === "logs" ? (
              <LogsView handle={props.cluster.handle} source={t.source} place="panel" onAsk={props.onAsk} />
            ) : (
              <TerminalView
                kind={t.kind}
                {...(t.kind === "shell" ? { target: t.target } : {})}
                cluster={props.cluster}
                visible={b.open && t.id === b.active}
                onLive={(on) => b.setLive(t.id, on)}
                onClose={() => b.close(t.id)}
                onAsk={props.onAsk}
                onShell={b.openShell}
                {...(t.kind === "shell" ? { onLogs: () => b.openLogs({ namespace: t.target.namespace, kind: "Pod", name: t.target.pod, container: t.target.container }) } : {})}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function TabButton({ tab, on, live, onPick, onClose }: { tab: BenchTab; on: boolean; live: boolean; onPick: () => void; onClose: () => void }) {
  const icon = !live ? CircleDashed : tab.kind === "logs" ? ScrollText : SquareTerminal;
  const [word, rest, full] = tab.kind === "shell" ? [tab.target.container, elide(tab.target.pod), `Shell: ${tab.target.container} in ${tab.target.namespace}/${tab.target.pod}`]
    : tab.kind === "local" ? ["terminal", "local", "Local terminal"]
    : ["logs", elide(tab.source.name), `Logs: ${tab.source.kind} ${tab.source.namespace}/${tab.source.name}`];
  return (
    <div className={"bench-tab" + (on ? " on" : "") + (live ? "" : " ended")} title={full + (live ? "" : " (ended)")}>
      <button role="tab" id={`tab-${tab.id}`} aria-selected={on} aria-controls={`pane-${tab.id}`} aria-label={full} className="bt-name" onClick={onPick}
        onAuxClick={(e) => e.button === 1 && onClose()}>
        <Ic icon={icon} size={13} /> <b>{word}</b> {rest}
      </button>
      <button className="icon-btn" aria-label={`Close ${full}`} title="Close tab" onClick={onClose}><Ic icon={X} size={12} /></button>
    </div>
  );
}

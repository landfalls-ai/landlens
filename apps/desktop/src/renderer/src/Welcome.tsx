// The first screen: your kubeconfig's contexts as one centred list. ↑/↓ move, Enter or the number connects.
import type { KubeContext } from "@landlens/contracts";
import { ArrowRight, Cable, CircleX, FileText, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Ic } from "./icons";
import { Mark } from "./Mark";
import { clusterTile } from "./present";

export function Welcome(props: {
  contexts?: KubeContext[];
  catalogError?: string;
  connecting?: string;
  error?: { context: string; message: string };
  onConnect: (c: string) => void;
  /** Open the Connections page (GitHub, Linear), which needs no cluster. */
  onConnections?: () => void;
}) {
  // The current context first: it has the focus, so Enter connects to it.
  const list = props.contexts && [...props.contexts].sort((a, b) => Number(b.current) - Number(a.current));
  const cards = useRef<(HTMLButtonElement | null)[]>([]);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!list?.length || focused) return;
    cards.current[0]?.focus();
    setFocused(true);
  }, [list, focused]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!list?.length || props.connecting || e.metaKey || e.ctrlKey || e.altKey) return;
      const at = cards.current.findIndex((c) => c === document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = at < 0 ? 0 : (at + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length;
        cards.current[next]?.focus();
      } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= list.length) {
        props.onConnect(list[Number(e.key) - 1]!.name);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [list, props.connecting]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="welcome">
      <div className="welcome-bar" />
      <div className="rings" aria-hidden="true"><i /><i /><i /><i /></div>
      <div className="welcome-col">
        <Mark />
        <h1>Pick a cluster</h1>
        <p className="lede">
          These are the contexts in your kubeconfig. Landlens connects with your own credentials, kept in a separate process;
          nothing else on this machine can use them.
        </p>
        {list === undefined ? (
          <div className="cards" aria-busy="true" aria-label="Loading contexts">
            {[0, 1].map((i) => (
              <div key={i} className="card skeleton">
                <span className="skel" style={{ width: 36, height: 36, borderRadius: 9 }} />
                <span className="card-text"><span className="skel" style={{ width: "40%" }} /><span className="skel" style={{ width: "60%", marginTop: 6 }} /></span>
              </div>
            ))}
          </div>
        ) : list.length === 0 ? (
          <div className="welcome-empty">
            <strong>No contexts in ~/.kube/config</strong>
            <p>{props.catalogError ?? "Add a context with kubectl, or point KUBECONFIG at another file, then restart Landlens."}</p>
          </div>
        ) : (
          <div className="cards">
            {list.map((c, i) => {
              const t = clusterTile(c.name);
              const busy = props.connecting === c.name;
              const failed = props.error?.context === c.name;
              return (
                <button
                  key={c.name}
                  ref={(el) => void (cards.current[i] = el)}
                  className={"card" + (props.connecting && !busy ? " dimmed" : "") + (failed ? " failed" : "")}
                  onClick={() => props.onConnect(c.name)}
                  disabled={!!props.connecting}
                  aria-busy={busy}
                >
                  <span className={`cl-tile lg ${t.g}`} aria-hidden="true">{t.initials}</span>
                  <span className="card-text">
                    <span className="card-name">{c.name}{c.current ? <span className="pill">current</span> : null}</span>
                    {busy ? <span className="card-server">Connecting…</span>
                      : failed ? <span className="card-error">{props.error!.message}</span>
                      : <span className="mono card-server">{c.server}</span>}
                  </span>
                  {failed ? <span className="retry">Try again</span> : list.length > 1 && i < 9 ? <kbd aria-hidden="true">{i + 1}</kbd> : null}
                  {busy ? <span className="spinner" aria-hidden="true" /> : <Ic icon={failed ? CircleX : ArrowRight} size={15} className={failed ? "tone-bad" : "go"} />}
                </button>
              );
            })}
          </div>
        )}
        {list?.length ? (
          <div className="welcome-foot">
            <span><Ic icon={FileText} size={13} />{list.length} context{list.length === 1 ? "" : "s"} in your kubeconfig</span>
            <span className="grow" />
            <span aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> move</span>
            <span aria-hidden="true"><kbd>↵</kbd> connect</span>
          </div>
        ) : null}
        {props.catalogError && list?.length ? <p className="small tone-bad">{props.catalogError}</p> : null}
        {props.onConnections ? (
          <button className="link-btn welcome-link" onClick={props.onConnections}><Ic icon={Cable} size={13} />Connections<span className="dim">GitHub and Linear for Claude sessions</span></button>
        ) : null}
      </div>
      <div className="trust"><Ic icon={ShieldCheck} size={13} />Credentials stay in an isolated process · Claude Code sessions are read-only</div>
    </main>
  );
}

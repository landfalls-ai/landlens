// A terminal tab (D8–D12, D21): a pod shell or your local shell. Who it runs as is said above it, every time; when it
// ends, the output stays and a bar says what happened and what can be done. Claude never reads or types here: the
// only way its text reaches the agent is the person selecting it and pressing Ask Claude.
import type { ClusterInfo, KubeObject, TerminalStatus } from "@landlens/contracts";
import { ArrowDown, ArrowUp, CircleX, Copy, RotateCw, Search, Sparkles, SquareTerminal, Unplug, User, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AskContext } from "./AgentDock";
import { api, useWatch, type ApiError } from "./api";
import { matches, type ShellTarget } from "./benchState";
import { Ic, MOD } from "./icons";
import { copyText } from "./present";
import { XTerm, type XTermHandle } from "./XTerm";

type End = { ended: "exit" | "lost" | "refused"; code?: number; status?: number; message?: string; at: number; podGone?: boolean };

const MAX_ASK_LINES = 200;
const MAX_ASK_BYTES = 16 * 1024;

/** At most 200 lines or 16 KB, as get_logs does; says whether it cut. */
export function capForAsk(lines: string[]): { text: string; cut: boolean } {
  let out = lines.slice(-MAX_ASK_LINES);
  let cut = out.length < lines.length;
  let text = out.join("\n");
  while (new TextEncoder().encode(text).length > MAX_ASK_BYTES && out.length > 1) {
    out = out.slice(1);
    text = out.join("\n");
    cut = true;
  }
  if (new TextEncoder().encode(text).length > MAX_ASK_BYTES) (text = text.slice(-MAX_ASK_BYTES / 2), cut = true);
  return { text, cut };
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export function TerminalView(props: {
  kind: "shell" | "local";
  target?: ShellTarget;
  cluster: ClusterInfo;
  visible: boolean;
  onLive: (on: boolean) => void;
  onClose: () => void;
  onAsk: (c: AskContext) => void;
  /** Open a shell in another pod (the replacement), in a new tab. */
  onShell: (t: ShellTarget) => void;
  onLogs?: () => void;
}) {
  const { target, cluster } = props;
  const pod = props.kind === "shell" && target ? target : undefined;
  const [session, setSession] = useState(0);
  const [terminal, setTerminal] = useState<string>();
  const [state, setState] = useState<"starting" | "open" | "ended">("starting");
  const [end, setEnd] = useState<End>();
  const [error, setError] = useState<string>();
  const [paste, setPaste] = useState<string>();
  const [sel, setSel] = useState("");
  const [find, setFind] = useState<string>();
  const [found, setFound] = useState<{ index: number; count: number }>();
  const [shell, setShell] = useState("zsh");
  const xterm = useRef<XTermHandle>(null);
  const pasteBtn = useRef<HTMLButtonElement>(null);
  const findBox = useRef<HTMLInputElement>(null);
  /** The start of this session's output: a container without a shell says so there, then exits 126 or 127. */
  const head = useRef("");
  const live = useRef(props.onLive);
  live.current = props.onLive;

  // One session per `session`: opened here, ended when the tab closes or a new one starts.
  useEffect(() => {
    let alive = true;
    let id: string | undefined;
    setState("starting");
    setEnd(undefined);
    setError(undefined);
    setTerminal(undefined);
    head.current = "";
    const open = pod
      ? api.invoke("terminal:open", { handle: cluster.handle, namespace: pod.namespace, pod: pod.pod, container: pod.container, shell: pod.shell })
      : api.invoke("terminal:local", { handle: cluster.handle });
    open.then(
      (r) => {
        if (!alive) return void api.invoke("terminal:close", { terminal: r.terminal }).catch(() => {});
        id = r.terminal;
        const name = (r as { shell?: string }).shell;
        if (name) setShell(name);
        setTerminal(r.terminal);
      },
      (e: ApiError) => {
        if (!alive) return;
        setError(e.message);
        setState("ended");
      },
    );
    return () => {
      alive = false;
      if (id) void api.invoke("terminal:close", { terminal: id }).catch(() => {});
      live.current(false);
    };
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  const onStatus = (s: TerminalStatus) => {
    if (s.state === "open") {
      setState("open");
      live.current(true);
      return;
    }
    setState("ended");
    live.current(false);
    setEnd({ ended: s.ended ?? "lost", ...(s.code !== undefined ? { code: s.code } : {}), ...(s.status ? { status: s.status } : {}), ...(s.message ? { message: s.message } : {}), at: Date.now() });
  };

  // When a pod shell ends, is the pod still there? If not, its replacement is offered (D10).
  useEffect(() => {
    if (!pod || state !== "ended" || !end || end.podGone !== undefined) return;
    api.invoke("resource:get", { handle: cluster.handle, ref: { group: "", version: "v1", resource: "pods", namespace: pod.namespace, name: pod.pod } }).then(
      () => setEnd((e) => e && { ...e, podGone: false }),
      (err: ApiError) => setEnd((e) => e && { ...e, podGone: err.status === 404 }),
    );
  }, [state, end, pod, cluster.handle]);
  const others = useWatch(pod && end?.podGone && pod.labels ? { handle: cluster.handle, group: "", version: "v1", resource: "pods", namespace: pod.namespace } : undefined);
  const replacement = useMemo(() => {
    if (!pod?.labels || !end?.podGone) return undefined;
    const ready = (o: KubeObject) => (o.status?.conditions ?? []).some((c: { type: string; status: string }) => c.type === "Ready" && c.status === "True");
    return others.items
      .filter((o) => o.metadata.name !== pod.pod && !o.metadata.deletionTimestamp && matches(o.metadata.labels, pod.labels!) && (o.spec?.containers ?? []).some((c: { name: string }) => c.name === pod.container))
      .sort((a, b) => Number(ready(b)) - Number(ready(a)) || (b.metadata.creationTimestamp ?? "").localeCompare(a.metadata.creationTimestamp ?? ""))[0];
  }, [others.items, pod, end?.podGone]);

  const restart = () => {
    xterm.current?.note(`── new session · ${clock(Date.now())} ──`);
    setSession((n) => n + 1);
    setTimeout(() => xterm.current?.focus(), 0);
  };

  // A multi-line paste into a pod asks first (D9); a local terminal never does.
  const onPaste = (text: string) => {
    if (!pod) return true;
    const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
    if (lines.length < 2) return true;
    setPaste(text);
    setTimeout(() => pasteBtn.current?.focus(), 0);
    return false;
  };
  const doPaste = (yes: boolean) => {
    if (yes && paste) xterm.current?.paste(paste);
    setPaste(undefined);
    xterm.current?.focus();
  };

  useEffect(() => {
    if (props.visible) setTimeout(() => xterm.current?.focus(), 0);
  }, [props.visible]);

  const runFind = (next: boolean, text = find ?? "") => setFound(xterm.current?.find(text, next));
  const closeFind = () => {
    setFind(undefined);
    setFound(undefined);
    xterm.current?.clearFind();
    xterm.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "f" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      setFind((f) => f ?? xterm.current?.selection() ?? "");
      setTimeout(() => findBox.current?.select(), 0);
    }
    if (state === "ended" && e.key === "Enter" && !find && end?.ended !== "refused" && !(e.target as HTMLElement).closest("button, input")) {
      e.preventDefault();
      restart();
    }
  };

  const ask = () => {
    const lines = sel.replace(/\n$/, "").split("\n");
    const { text } = capForAsk(lines);
    const where = pod ? `${pod.container} in ${pod.namespace}/${pod.pod}` : `local terminal (${cluster.context})`;
    props.onAsk({ label: `Terminal selection · ${lines.length} line${lines.length === 1 ? "" : "s"}`, text, source: where, kind: "terminal" });
    xterm.current?.clearSelection();
    setSel("");
  };

  const noShell = pod && state === "ended" && end?.ended === "exit" && (end.code === 126 || end.code === 127 || !end.code) && /OCI runtime exec failed|executable file not found|exec failed: unable to start container process/i.test(`${head.current}\n${end.message ?? ""}`);
  const lostLine = end?.ended === "lost";
  const refused = error ?? (end?.ended === "refused" ? end.message : undefined);
  const forbidden = end?.status === 403 || /forbidden/i.test(error ?? "");

  return (
    <div className="term-wrap" onKeyDownCapture={onKey}>
      <div className="term-id">
        {pod ? (
          <span className="who"><Ic icon={SquareTerminal} size={13} /><b>{pod.container}</b> in <span className="mono">{pod.pod}</span><span className="sep">·</span>{pod.namespace}<span className="sep">·</span>{pod.shell === "auto" ? "bash or sh" : pod.shell}</span>
        ) : (
          <span className="who"><Ic icon={SquareTerminal} size={13} /><b>{shell}</b> on this Mac<span className="sep">·</span>kubectl points at {cluster.context} through Landlens</span>
        )}
        <span className="badge warn" title="This session uses your own access to the cluster. Everything it does is in the front door's audit trail as you."><Ic icon={User} size={12} />Runs as you</span>
        <span className="not-claude">{cluster.context} · Claude Code can't see or type here</span>
      </div>
      {noShell ? (
        <div className="term-empty" role="status">
          <Ic icon={SquareTerminal} size={20} />
          <strong>No shell in this container</strong>
          <span>Neither bash nor sh is in {pod!.container}'s image.</span>
          <div className="row">
            {props.onLogs ? <button className="secondary" onClick={props.onLogs}>Open logs</button> : null}
            <button className="ask-btn" onClick={() => props.onAsk({ label: `${pod!.container} in ${pod!.pod}`, text: `The container ${pod!.container} in pod ${pod!.namespace}/${pod!.pod} has no shell (bash or sh). How can I debug it?`, kind: "terminal" })}><Ic icon={Sparkles} size={14} />Ask Claude</button>
          </div>
        </div>
      ) : (
        <XTerm
          ref={xterm}
          {...(terminal ? { terminal } : {})}
          dead={state === "ended"}
          onStatus={onStatus}
          onPaste={onPaste}
          onSelection={setSel}
          onOutput={(t) => {
            if (head.current.length < 2048) head.current += t;
          }}
          {...(pod ? { banner: `Shell in ${pod.namespace}/${pod.pod} (${pod.container}), as you through Landlens's front door. It is audited, and ends when this tab closes.` } : {})}
        />
      )}
      {find !== undefined ? (
        <div className="term-find" role="dialog" aria-label="Search">
          <label className="field"><Ic icon={Search} size={13} /><input ref={findBox} aria-label="Find in terminal" value={find} onChange={(e) => (setFind(e.target.value), runFind(true, e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.preventDefault(), runFind(!e.shiftKey));
              if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), closeFind());
            }} /></label>
          <span className="find-count" aria-live="polite">{find ? (found?.count ? `${found.index} of ${found.count}` : "No matches") : ""}</span>
          <button className="icon-btn" aria-label="Previous match" onClick={() => runFind(false)}><Ic icon={ArrowUp} size={13} /></button>
          <button className="icon-btn" aria-label="Next match" onClick={() => runFind(true)}><Ic icon={ArrowDown} size={13} /></button>
          <button className="icon-btn" aria-label="Close search" onClick={closeFind}><Ic icon={X} size={13} /></button>
        </div>
      ) : null}
      {sel && state !== "starting" ? (
        <div className="sel-bar" role="toolbar" aria-label="Selection">
          <span>{sel.replace(/\n$/, "").split("\n").length} lines</span>
          <button className="secondary" onClick={() => void copyText(sel)}><Ic icon={Copy} size={12} />Copy</button>
          <button className="ask-btn" onClick={ask}><Ic icon={Sparkles} size={13} />Ask Claude</button>
        </div>
      ) : null}
      {paste !== undefined ? (
        <div className="term-bar warn paste-bar" role="alertdialog" aria-label="Paste into the pod"
          onKeyDown={(e) => {
            if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), doPaste(false));
          }}>
          <Ic icon={SquareTerminal} size={14} />
          <span className="msg"><b>Paste {paste.replace(/\r?\n$/, "").split(/\r?\n/).length} lines into {pod?.container}?</b><small>Each line runs in the pod as you.</small></span>
          <button className="primary" ref={pasteBtn} onClick={() => doPaste(true)}>Paste<kbd>⏎</kbd></button>
          <button className="secondary" onClick={() => doPaste(false)}>Cancel<kbd>Esc</kbd></button>
        </div>
      ) : null}
      {state === "ended" && !noShell ? (
        refused ? (
          <div className={"term-bar " + (forbidden ? "warn" : "bad")} role="status">
            <Ic icon={CircleX} size={14} />
            <span className="msg">
              <b>{forbidden ? `Your role can't exec in ${pod?.namespace ?? cluster.context}.` : end?.status === 404 || /not found/i.test(refused) ? (pod ? "The pod is gone." : "Couldn't start the terminal.") : pod ? "Couldn't open a shell." : "Couldn't start the terminal."}</b>
              <small>{refused}</small>
            </span>
            {replacement ? <button className="primary" onClick={() => props.onShell({ ...pod!, pod: replacement.metadata.name })}>Open shell in the new pod</button> : null}
            {!forbidden && !(end?.podGone) ? <button className="secondary" onClick={restart}><Ic icon={RotateCw} size={12} />Try again</button> : null}
            <button className="secondary" onClick={props.onClose}>Close tab</button>
          </div>
        ) : (
          <div className={"term-bar" + (lostLine ? " warn" : "")} role="status">
            <Ic icon={lostLine ? Unplug : SquareTerminal} size={14} />
            <span className="msg">
              {lostLine ? (
                <><b>Connection lost.</b><small>A shell can't be resumed: a new session starts clean{pod ? ", in the same container" : ""}.</small></>
              ) : end?.podGone ? (
                <><b>The pod is gone{replacement ? "; another one runs the same container" : ""}.</b><small>The session ended at {clock(end.at)}.</small></>
              ) : (
                <><b>The {pod ? "shell" : "terminal"} exited{end?.code ? ` (code ${end.code})` : ""} at {clock(end?.at ?? Date.now())}.</b><small>{pod ? "The output stays until you close the tab." : "Your shell ended."}</small></>
              )}
            </span>
            {replacement ? <button className="primary" onClick={() => props.onShell({ ...pod!, pod: replacement.metadata.name })}>Open shell in the new pod</button> : null}
            {!end?.podGone ? <button className={replacement ? "secondary" : "primary"} onClick={restart}>{lostLine ? "New session" : pod ? "Reconnect" : "New session"}<kbd>⏎</kbd></button> : null}
            <button className="secondary" onClick={props.onClose}>Close tab<kbd>{MOD}W</kbd></button>
          </div>
        )
      ) : null}
    </div>
  );
}

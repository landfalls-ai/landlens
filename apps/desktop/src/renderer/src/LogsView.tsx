// Logs (D13–D20): a followed stream, not a poll. One pod, or a workload's pods merged by timestamp. It follows at the
// bottom and pauses when you scroll up; a dropped stream picks up where it left off; search, wrap, timestamps,
// the previous run, download, and Ask Claude about lines you choose.
import { FAILURE_LINE, type KubeObject } from "@landlens/contracts";
import { ArrowDown, ArrowUp, ChevronDown, Clock, Copy, Download, History, PanelBottom, Pause, Search, Sparkles, WrapText, X } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AskContext } from "./AgentDock";
import { api, useNow, useWatch, type ApiError } from "./api";
import { elide, matches, type LogSource } from "./benchState";
import { Ic, MOD } from "./icons";
import { copyText, duration } from "./present";
import { onLogEnd, onLogLines } from "./streams";
import { capForAsk } from "./TerminalView";
import { ansi, matcher, mergeRows, plain, tsKey, type Row } from "./logRows";

const TAIL = 500;
const KEEP = 10_000;
const SHOW_STEP = 2000;
const MAX_PODS = 10;
const RETRY = [1000, 2000, 5000, 10_000];
/** Chart slots (charts.css): a pod's colour is its identity, as a series is in a chart. */
const SLOTS = ["s1", "s2", "s3", "s4"];

const localTime = (ts: string) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : `${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

export function LogsView(props: {
  handle: string;
  source: LogSource;
  place: "drawer" | "panel";
  onAsk: (c: AskContext) => void;
  onOpenInPanel?: (s: LogSource) => void;
}) {
  const { source } = props;
  const now = useNow();
  const pods = useWatch({ handle: props.handle, group: "", version: "v1", resource: "pods", namespace: source.namespace });
  const many = !!source.selector;
  const allPods = useMemo(() => {
    const list = pods.items.filter((o) => (many ? matches(o.metadata.labels, source.selector!) : o.metadata.name === source.name));
    return list.sort((a, b) => (b.metadata.creationTimestamp ?? "").localeCompare(a.metadata.creationTimestamp ?? ""));
  }, [pods.items, many, source.selector, source.name]);
  const shownPods = allPods.slice(0, MAX_PODS);
  const [onePod, setOnePod] = useState("");
  const first = (onePod && allPods.find((p) => p.metadata.name === onePod)) || shownPods[0];
  const containers: string[] = useMemo(() => [
    ...((first?.spec?.initContainers ?? []) as { name: string }[]).map((c) => c.name),
    ...((first?.spec?.containers ?? []) as { name: string }[]).map((c) => c.name),
  ], [first]);
  const [container, setContainer] = useState(source.container ?? "");
  useEffect(() => {
    if (source.container) setContainer(source.container);
  }, [source.container]);
  const cName = container && containers.includes(container) ? container : ((first?.spec?.containers ?? [])[0] as { name: string } | undefined)?.name ?? "";
  const [previous, setPrevious] = useState(false);
  const [wrap, setWrap] = useState(props.place === "drawer");
  const [stamps, setStamps] = useState(true);
  const [query, setQuery] = useState<string>();
  const [cur, setCur] = useState(0);
  const [following, setFollowing] = useState(true);
  const [fresh, setFresh] = useState(0);
  const [show, setShow] = useState(SHOW_STEP);
  const [picked, setPicked] = useState<{ from: number; to: number }>();
  const [selText, setSelText] = useState("");
  const [ended, setEnded] = useState<string>();
  const [version, setVersion] = useState(0);
  const rows = useRef<Row[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const findBox = useRef<HTMLInputElement>(null);
  const followRef = useRef(true);
  followRef.current = following;

  // Which pods stream: one, or the workload's newest ten (or the one picked).
  const streamPods = many ? (onePod ? [onePod] : shownPods.map((p) => p.metadata.name)) : first ? [first.metadata.name] : [];
  const prevOK = !many || !!onePod;
  const status = (first?.status?.initContainerStatuses ?? []).concat(first?.status?.containerStatuses ?? []).find((s: { name: string }) => s.name === cName);
  const restarted = (status?.restartCount ?? 0) > 0 || !!status?.lastState?.terminated;
  const usePrevious = previous && prevOK && restarted;
  const slot = useMemo(() => new Map(shownPods.map((p, i) => [p.metadata.name, SLOTS[i] ?? "so"])), [shownPods.map((p) => p.metadata.name).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const streamKey = JSON.stringify([streamPods, cName, usePrevious]);

  // The streams: one per pod, each reconnecting from its last line when it drops.
  useEffect(() => {
    if (!cName || !streamPods.length) return;
    rows.current = [];
    setEnded(undefined);
    setFresh(0);
    setPicked(undefined);
    setVersion((v) => v + 1);
    let seq = 0;
    let frame = 0;
    const bump = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setVersion((v) => v + 1);
      });
    };
    const add = (batch: Row[]) => {
      let next = mergeRows(rows.current, batch);
      if (next.length > KEEP) next = next.slice(next.length - KEEP);
      rows.current = next;
      if (!followRef.current) setFresh((n) => n + batch.filter((r) => !r.mark).length);
      bump();
    };
    const marker = (text: string, pod?: string) => {
      const last = rows.current[rows.current.length - 1];
      add([{ key: ++seq, k: last?.k ?? "", ts: "", text, ...(pod ? { pod } : {}), mark: true }]);
    };
    const followers = streamPods.map((pod) => {
      let stopped = false;
      let lastK = "";
      let lastTs = "";
      let tries = 0;
      let dropped = false;
      let stream: string | undefined;
      let off: (() => void)[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const start = () => {
        api.invoke("logs:open", {
          handle: props.handle, namespace: source.namespace, pod, container: cName,
          ...(usePrevious ? { previous: true } : {}),
          ...(lastTs ? { sinceTime: lastTs.replace(/(\.\d+)?Z$/, "Z") } : { tailLines: many ? Math.ceil(TAIL / Math.min(streamPods.length, 5)) : TAIL }),
        }).then(({ stream: s }) => {
          if (stopped) return void api.invoke("logs:close", { stream: s }).catch(() => {});
          stream = s;
          off = [
            onLogLines(s, (e) => {
              const batch: Row[] = [];
              for (const l of e.lines) {
                const k = tsKey(l.ts);
                if (lastK && l.ts && k <= lastK) continue; // seen before the reconnect
                if (l.ts) (lastK = k, lastTs = l.ts);
                batch.push({ key: ++seq, k: k || lastK, ts: l.ts, text: l.text, ...(many ? { pod } : {}) });
              }
              if (dropped && batch.length) {
                dropped = false;
                marker(`Following again${many ? ` · ${pod}` : ""}`, many ? pod : undefined);
              }
              tries = 0;
              add(batch);
            }),
            onLogEnd(s, (e) => ended(e.status, e.message)),
          ];
        }, (err: ApiError) => ended(err.status, err.message));
      };
      const ended = (code?: number, message?: string) => {
        off.forEach((f) => f());
        off = [];
        stream = undefined;
        if (stopped) return;
        if (usePrevious) return setEnded(message ? `Logs couldn't be read: ${message}` : undefined);
        if (code === 404 && !many) return setEnded(`The pod is gone${message ? `: ${message}` : "."}`);
        if (code === 404) return marker(`${pod} is gone`, pod);
        if (code === 403) return setEnded(`You can't read this log: ${message ?? "forbidden"}`);
        if (!dropped) marker(message ? `Stream dropped (${message.slice(0, 120)}). Reconnecting…` : `The stream ended. Following again when there is more…`, many ? pod : undefined);
        dropped = true;
        timer = setTimeout(start, RETRY[Math.min(tries++, RETRY.length - 1)]);
      };
      start();
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        off.forEach((f) => f());
        if (stream) void api.invoke("logs:close", { stream }).catch(() => {});
      };
    });
    return () => {
      cancelAnimationFrame(frame);
      followers.forEach((stop) => stop());
    };
  }, [streamKey, props.handle]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = rows.current;
  const re = useMemo(() => matcher(query ?? ""), [query]);
  const hits = useMemo(() => (re ? all.flatMap((r, i) => (!r.mark && (re.lastIndex = 0, re.test(plain(r.text))) ? [i] : [])) : []), [re, all, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const curRow = hits.length ? all[hits[Math.min(cur, hits.length - 1)]!] : undefined;
  const from = Math.max(0, all.length - show);
  const visible = all.slice(from);

  // Follow: stay at the bottom while following.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && following && !query) el.scrollTop = el.scrollHeight;
  }, [version, following, query, wrap, stamps]);
  useEffect(() => {
    if (!curRow) return;
    const i = all.indexOf(curRow);
    if (i >= 0 && i < from) setShow(all.length - i + 50);
    requestAnimationFrame(() => box.current?.querySelector(`[data-key="${curRow.key}"]`)?.scrollIntoView({ block: "center" }));
  }, [curRow?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const follow = () => {
    setFollowing(true);
    setFresh(0);
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    if (bottom && !following && !query) follow();
    else if (!bottom && following) setFollowing(false);
  };

  const openFind = () => {
    setQuery((q) => q ?? "");
    setFollowing(false);
    setTimeout(() => findBox.current?.select(), 0);
  };
  const closeFind = () => {
    setQuery(undefined);
    setCur(0);
    box.current?.focus();
  };
  const onKey = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "f") return e.preventDefault(), e.stopPropagation(), openFind();
    if (mod && e.key === "Enter" && (picked || selText)) return e.preventDefault(), ask();
    if (e.key === "End" && !(e.target as HTMLElement).closest("input")) return e.preventDefault(), follow();
    if (e.key === "Escape" && (picked || selText)) {
      e.stopPropagation();
      setPicked(undefined);
      setSelText("");
      getSelection()?.removeAllRanges();
    }
  };

  const pickRow = (key: number, range: boolean) => {
    setSelText("");
    getSelection()?.removeAllRanges();
    setPicked((p) => (range && p ? { from: Math.min(p.from, key), to: Math.max(p.from, key) } : p && p.from === key && p.to === key ? undefined : { from: key, to: key }));
    setFollowing(false);
  };
  const chosen = (): string[] => {
    if (selText) return selText.replace(/\n$/, "").split("\n");
    if (!picked) return [];
    return all.filter((r) => !r.mark && r.key >= picked.from && r.key <= picked.to).map((r) => `${r.ts ? `${r.ts} ` : ""}${r.pod ? `[${r.pod}] ` : ""}${plain(r.text)}`);
  };
  const count = chosen().length;
  const label = `${source.kind === "Pod" ? "" : `${source.kind.toLowerCase()} `}${source.name}`;
  const ask = () => {
    const lines = chosen();
    if (!lines.length) return;
    const { text } = capForAsk(lines);
    props.onAsk({ label: `${lines.length} log line${lines.length === 1 ? "" : "s"} · ${elide(source.name, 18)}`, text, source: `${source.namespace}/${label}, container ${cName}${usePrevious ? ", previous run" : ""}`, kind: "logs" });
    setPicked(undefined);
    setSelText("");
  };
  const onMouseUp = () => {
    const s = getSelection();
    const t = s && !s.isCollapsed && box.current?.contains(s.anchorNode) ? s.toString() : "";
    if (t) setPicked(undefined);
    setSelText(t);
  };

  const download = () => {
    const text = all.filter((r) => !r.mark).map((r) => `${r.ts ? `${r.ts} ` : ""}${r.pod ? `[${r.pod}] ` : ""}${plain(r.text)}`).join("\n") + "\n";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = `${source.name}_${cName}${usePrevious ? "_previous" : ""}_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };

  const last = status?.lastState?.terminated;
  const notFound = !pods.loading && !allPods.length;

  return (
    <div className="logs-pane" onKeyDownCapture={onKey}>
      <div className="logs-tools" role="toolbar" aria-label="Log tools">
        {containers.length > 1 ? (
          <label className="pill-select" title="Container">
            <span className="sr-only">Container</span>
            <select value={cName} onChange={(e) => (setContainer(e.target.value), setPrevious(false))}>
              {containers.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <Ic icon={ChevronDown} size={11} />
          </label>
        ) : <span className="pill-select mono" style={{ padding: "0 8px" }} title="Container">{cName || "…"}</span>}
        {many ? (
          <label className="pill-select" title="Pods">
            <span className="sr-only">Pods</span>
            <select value={onePod} onChange={(e) => (setOnePod(e.target.value), setPrevious(false))}>
              <option value="">{allPods.length > MAX_PODS ? `${MAX_PODS} of ${allPods.length} pods` : `All ${allPods.length} pods`}</option>
              {allPods.map((p) => <option key={p.metadata.uid} value={p.metadata.name}>{p.metadata.name}</option>)}
            </select>
            <Ic icon={ChevronDown} size={11} />
          </label>
        ) : null}
        <button className={"tog" + (usePrevious ? " on" : "")} aria-pressed={usePrevious} disabled={!prevOK || !restarted}
          title={!prevOK ? "Pick one pod to see its previous run" : restarted ? "The run before the last restart" : "The container hasn't restarted"}
          onClick={() => setPrevious((p) => !p)}><Ic icon={History} size={12} />Previous</button>
        <span className="grow" />
        <button className={"icon-btn" + (query !== undefined ? " on" : "")} aria-label="Search logs" title={`Search (${MOD}F)`} onClick={() => (query === undefined ? openFind() : closeFind())}><Ic icon={Search} size={14} /></button>
        <button className={"icon-btn" + (wrap ? " on" : "")} aria-pressed={wrap} aria-label="Wrap lines" title="Wrap lines" onClick={() => setWrap((w) => !w)}><Ic icon={WrapText} size={14} /></button>
        <button className={"icon-btn" + (stamps ? " on" : "")} aria-pressed={stamps} aria-label="Timestamps" title="Timestamps (local time)" onClick={() => setStamps((s) => !s)}><Ic icon={Clock} size={14} /></button>
        <button className="icon-btn" aria-label="Download logs" title="Download what's shown" disabled={!all.length} onClick={download}><Ic icon={Download} size={14} /></button>
        {props.onOpenInPanel ? (
          <button className="icon-btn" aria-label="Open in the panel" title="Open in the panel" onClick={() => props.onOpenInPanel!({ ...source, container: cName })}><Ic icon={PanelBottom} size={14} /></button>
        ) : null}
      </div>
      {query !== undefined ? (
        <div className="logs-find" role="search">
          <label className="field"><Ic icon={Search} size={13} />
            <input ref={findBox} aria-label="Find in logs" placeholder="Text, or /regex/" value={query}
              onChange={(e) => (setQuery(e.target.value), setCur(0), setFollowing(false))}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.preventDefault(), setCur((c) => (hits.length ? (c + (e.shiftKey ? hits.length - 1 : 1)) % hits.length : 0)));
                if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), closeFind());
              }} />
          </label>
          <span className="find-count" aria-live="polite">{query ? (hits.length ? `${Math.min(cur, hits.length - 1) + 1} of ${hits.length}` : re ? "No matches" : "Not a regex") : ""}</span>
          <button className="icon-btn" aria-label="Previous match" onClick={() => setCur((c) => (hits.length ? (c + hits.length - 1) % hits.length : 0))}><Ic icon={ArrowUp} size={13} /></button>
          <button className="icon-btn" aria-label="Next match" onClick={() => setCur((c) => (hits.length ? (c + 1) % hits.length : 0))}><Ic icon={ArrowDown} size={13} /></button>
          <button className="icon-btn" aria-label="Close search" onClick={closeFind}><Ic icon={X} size={13} /></button>
        </div>
      ) : null}
      {usePrevious ? (
        <div className="logs-note"><Ic icon={History} size={13} />Previous run of {cName}.{last ? ` Exited with code ${last.exitCode}${last.finishedAt ? `, ${duration(now - Date.parse(last.finishedAt))} ago` : ""}.` : ""}</div>
      ) : null}
      <div className="logs-wrap">
        <div ref={box} className={"logs" + (wrap ? "" : " nowrap")} role="log" aria-label="Logs" aria-live="off" tabIndex={0} onScroll={onScroll} onMouseUp={onMouseUp}>
          {notFound ? <div className="logs-end">{many ? "No pods match this workload's selector." : "The pod is gone."}</div> : null}
          {from > 0 ? <button className="link-btn more" onClick={() => (setShow((s) => s + SHOW_STEP), setFollowing(false))}>Show {Math.min(SHOW_STEP, from)} earlier lines</button> : null}
          {visible.map((r) => (
            <Line key={r.key} row={r} stamps={stamps} colour={r.pod ? slot.get(r.pod) : undefined} re={re}
              current={r === curRow} picked={!!picked && r.key >= picked.from && r.key <= picked.to} onPick={pickRow} />
          ))}
          {!all.length && !notFound && !ended ? <div className="logs-end">{pods.loading || !cName ? "Loading…" : usePrevious ? "The previous run wrote nothing." : "Waiting for lines…"}</div> : null}
          {ended ? <div className="logs-end" role="status">{ended}</div> : null}
        </div>
        {!following && fresh > 0 ? (
          <button className="logs-pill" onClick={follow}><Ic icon={ArrowDown} size={13} />{fresh} new line{fresh === 1 ? "" : "s"}</button>
        ) : null}
        {count ? (
          <div className="sel-bar" role="toolbar" aria-label="Selection" style={{ bottom: 10 }}>
            <span>{count} line{count === 1 ? "" : "s"}{count > 200 ? " · the first 200 are cut" : ""}</span>
            <button className="secondary" onClick={() => void copyText(chosen().join("\n"))}><Ic icon={Copy} size={12} />Copy</button>
            <button className="ask-btn" onClick={ask} title={`Ask Claude (${MOD}⏎)`}><Ic icon={Sparkles} size={13} />Ask Claude</button>
          </div>
        ) : null}
      </div>
      <div className="logs-foot">
        {usePrevious ? <span>Previous run · not followed</span>
          : following ? <span className="live"><i className="dot tone-ok" aria-hidden="true" />Following</span>
          : <span className="paused"><Ic icon={Pause} size={11} />Paused · End to follow</span>}
        <span>{all.filter((r) => !r.mark).length.toLocaleString()} lines{all.length >= KEEP ? " (the last 10,000)" : ""}</span>
        {many && !onePod ? (
          <span className="legend-pods">{shownPods.map((p) => <span key={p.metadata.uid} className={slot.get(p.metadata.name)}><i />{p.metadata.name.slice(-5)}</span>)}</span>
        ) : null}
      </div>
    </div>
  );
}

const Line = memo(function Line({ row, stamps, colour, re, current, picked, onPick }: {
  row: Row; stamps: boolean; colour?: string | undefined; re?: RegExp | undefined; current: boolean; picked: boolean; onPick: (key: number, range: boolean) => void;
}) {
  if (row.mark) return <div className="ll mk" data-key={row.key}>{row.text}</div>;
  const loud = FAILURE_LINE.test(plain(row.text));
  return (
    <div className={"ll" + (colour ? ` ${colour}` : "") + (loud ? " err" : "") + (picked ? " sel" : "")} data-key={row.key}>
      {stamps && row.ts ? <span className="ts" title={row.ts} onClick={(e) => onPick(row.key, e.shiftKey)}>{localTime(row.ts)}</span> : null}
      {!stamps ? <span className="ts" title={row.ts} onClick={(e) => onPick(row.key, e.shiftKey)} aria-hidden="true">·</span> : null}
      {row.pod ? <span className="pod" title={row.pod}>{row.pod.slice(-5)}</span> : null}
      <span className="tx">{re ? highlight(plain(row.text), re, current) : ansi(row.text).map((s, i) => (s.cls ? <span key={i} className={s.cls}>{s.text}</span> : s.text))}</span>
    </div>
  );
});

function highlight(text: string, re: RegExp, current: boolean) {
  const out: React.ReactNode[] = [];
  let at = 0, n = 0;
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    if (!m[0]) break;
    if (m.index! > at) out.push(text.slice(at, m.index));
    out.push(<mark key={n} className={current && n === 0 ? "cur" : undefined}>{m[0]}</mark>);
    n++;
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** The pod a workload's logs default to, and the selector they use. */
export function logSourceOf(kind: string, o: KubeObject): LogSource | undefined {
  const ns = o.metadata.namespace;
  if (!ns) return undefined;
  if (kind === "Pod") return { namespace: ns, kind, name: o.metadata.name };
  const sel = o.spec?.selector?.matchLabels as Record<string, string> | undefined;
  if (["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"].includes(kind) && sel && Object.keys(sel).length) return { namespace: ns, kind, name: o.metadata.name, selector: sel };
  return undefined;
}

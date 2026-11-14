// The landing page: is this cluster healthy? One verdict, four tiles, the problems worst first, the recent warnings,
// and the nodes. All from cluster:health (packages/kube/src/health.ts), which the agent's cluster_overview shares.
import type { ClusterHealth, HealthEvent, HealthProblem } from "@landlens/contracts";
import { age } from "@landlens/kube/status";
import { ChevronRight, CircleCheck, CircleDashed, CircleX, Clock, Lock, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Ic, iconOfKind, kindIcon } from "./icons";
import { plural } from "./health";
import { shortName, splitByShape } from "./present";
import type { ApiError } from "./api";

export function Overview(props: {
  health?: ClusterHealth;
  error?: ApiError;
  now: number;
  onOpenList: (resource: "nodes" | "pods" | "deployments", failing?: boolean) => void;
  onOpenProblem: (p: HealthProblem) => void;
  onAskProblem: (p: HealthProblem) => void;
  onAskAll: () => void;
}) {
  const { health: h, now } = props;
  if (!h && props.error) {
    return (
      <div className="ov">
        <div className="notice" role="alert">
          <Ic icon={props.error.status === 403 ? Lock : CircleX} size={15} className={props.error.status === 403 ? "dim" : "tone-bad"} />
          <div className="notice-body">
            <strong>{props.error.status === 403 ? "You don't have access to this cluster's health." : "Couldn't check this cluster's health."}</strong>
            <p>{props.error.message}</p>
          </div>
        </div>
      </div>
    );
  }
  if (!h) return <OverviewSkeleton />;

  const p = h.pods;
  return (
    <div className="ov">
      <Verdict h={h} onAsk={props.onAskAll} />
      <div className="tiles">
        {h.nodes ? (
          <a className="tile" role="link" tabIndex={0} aria-label={`Open nodes: ${h.nodes.ready} of ${h.nodes.total} ready`} onClick={() => props.onOpenList("nodes")} onKeyDown={(e) => e.key === "Enter" && props.onOpenList("nodes")}>
            <div className="tile-label"><Ic icon={kindIcon("nodes")} size={13} />Nodes</div>
            <div className="tile-num">{h.nodes.ready}<span>/{h.nodes.total}</span></div>
            <div className="tile-sub">
              {h.nodes.ready === h.nodes.total ? <><Ic icon={CircleCheck} size={12} className="tone-ok" />all ready</> : <><Ic icon={CircleX} size={12} className="tone-bad" />{h.nodes.total - h.nodes.ready} not ready</>}
            </div>
          </a>
        ) : null}
        <a className="tile wide" role="link" tabIndex={0} aria-label={`Open pods: ${p.total}`} onClick={() => props.onOpenList("pods", p.failing > 0)} onKeyDown={(e) => e.key === "Enter" && props.onOpenList("pods", p.failing > 0)}>
          <div className="tile-label"><Ic icon={kindIcon("pods")} size={13} />Pods</div>
          <div className="tile-row">
            <div className="tile-num">{p.total}</div>
            <div className="podbar-wrap">
              <div className={"podbar" + (p.total ? "" : " empty")} role="img" aria-label={`${p.running} running, ${p.succeeded} succeeded, ${p.pending} pending, ${p.failing} failing`}>
                {([["ok", p.running], ["muted", p.succeeded], ["warn", p.pending], ["bad", p.failing]] as const)
                  .filter(([, n]) => n > 0)
                  .map(([cls, n]) => <i key={cls} className={cls} style={{ flex: n }} />)}
              </div>
              <div className="legend">
                <span><Ic icon={CircleCheck} size={12} className="tone-ok" /><b>{p.running}</b> running</span>
                <span><Ic icon={CircleDashed} size={12} className="tone-muted" /><b>{p.succeeded}</b> succeeded</span>
                <span><Ic icon={Clock} size={12} className="tone-warn" /><b>{p.pending}</b> pending</span>
                <span><Ic icon={CircleX} size={12} className="tone-bad" /><b>{p.failing}</b> failing</span>
              </div>
            </div>
          </div>
        </a>
        {h.deployments ? (
          <a className="tile" role="link" tabIndex={0} aria-label={`Open deployments: ${h.deployments.available} of ${h.deployments.total} available`} onClick={() => props.onOpenList("deployments")} onKeyDown={(e) => e.key === "Enter" && props.onOpenList("deployments")}>
            <div className="tile-label"><Ic icon={kindIcon("deployments")} size={13} />Deployments</div>
            <div className="tile-num">{h.deployments.available}<span>/{h.deployments.total}</span></div>
            <div className="tile-sub">
              {h.deployments.available === h.deployments.total
                ? <><Ic icon={CircleCheck} size={12} className="tone-ok" />all available</>
                : <><Ic icon={CircleX} size={12} className="tone-bad" />{h.deployments.total - h.deployments.available} unavailable</>}
            </div>
          </a>
        ) : null}
        <section className="tile" aria-label="Restarts">
          <div className="tile-label"><Ic icon={RefreshCw} size={13} />Restarts</div>
          <div className="tile-num">{p.restarts}</div>
          <div className="tile-sub">all pods · {plural(h.namespaces, "namespace")}</div>
        </section>
      </div>
      <div className="ov-cols">
        <section className="panel" aria-label="Problems">
          <header className="panel-head"><h3>Problems</h3><span className="count-badge">{h.problems.length}</span><span className="grow" /><span className="dim small">worst first</span></header>
          {h.problems.length ? (
            <ul className="ov-list">{h.problems.map((x) => <ProblemRow key={`${x.kind}/${x.namespace}/${x.name}/${x.reason}`} p={x} onOpen={props.onOpenProblem} onAsk={props.onAskProblem} />)}</ul>
          ) : (
            <div className="ov-empty"><Ic icon={CircleCheck} size={20} /><span>No problems found</span></div>
          )}
        </section>
        <section className="panel" aria-label="Recent warnings">
          <header className="panel-head"><h3>Recent warnings</h3><span className="count-badge">{h.warnings.length}</span><span className="grow" /><span className="dim small">last hour</span></header>
          {h.warnings.length ? (
            <ul className="ov-list">{h.warnings.slice(0, 8).map((e, i) => <WarningRow key={i} e={e} now={now} />)}</ul>
          ) : (
            <div className="ov-empty"><Ic icon={CircleCheck} size={20} /><span>No warning events in the last hour.</span></div>
          )}
        </section>
      </div>
      {h.nodes ? <Nodes nodes={h.nodes.items} /> : null}
    </div>
  );
}

function Verdict({ h, onAsk }: { h: ClusterHealth; onAsk: () => void }) {
  const bad = h.problems.filter((p) => p.tone === "bad");
  const warn = h.problems.filter((p) => p.tone === "warn");
  if (!h.problems.length) {
    return (
      <section className="verdict ok" aria-label="Verdict">
        <span className="verdict-icon"><Ic icon={CircleCheck} size={22} /></span>
        <div className="verdict-text">
          <h2>All clear</h2>
          <p>{plural(h.pods.running, "pod")} running{h.nodes ? ` on ${plural(h.nodes.total, "node")}` : ""}.</p>
        </div>
      </section>
    );
  }
  const tone = bad.length ? "bad" : "warn";
  const lead = (bad.length ? bad : warn).slice(0, 2);
  const rest = h.problems.length - lead.length;
  const sentence = lead.map((p, i) => <span key={i}>{i ? " and " : ""}{describe(p, i ? lead[0] : undefined)}</span>);
  return (
    <section className={`verdict ${tone}`} aria-label="Verdict">
      <span className="verdict-icon"><Ic icon={tone === "bad" ? CircleX : TriangleAlert} size={22} /></span>
      <div className="verdict-text">
        <h2>{bad.length ? `${plural(bad.length, "problem")} need${bad.length === 1 ? "s" : ""} attention` : `Nothing is broken; ${plural(warn.length, "thing")} to watch`}</h2>
        <p>{sentence}.{rest > 0 ? ` ${plural(rest, "more thing")} ${rest === 1 ? "is" : "are"} worth watching.` : ""}</p>
      </div>
      <button className="primary" onClick={onAsk}><Ic icon={Sparkles} size={14} />Ask Claude what's wrong</button>
    </section>
  );
}

/** "A pod is crash-looping in landlens-dev": one clause for the verdict; the second one leans on the first. */
function describe(p: HealthProblem, before?: HealthProblem): ReactNode {
  const a = before ? "a" : "A";
  const where = p.namespace && p.namespace !== before?.namespace ? <> in <b>{p.namespace}</b></> : null;
  if (p.kind === "Node") return <>node <b>{p.name}</b> is {p.reason === "NotReady" ? "not ready" : `under ${p.reason}`}</>;
  if (p.kind === "Deployment") {
    const its = before?.kind === "Pod" && before.namespace === p.namespace && before.name.startsWith(`${p.name}-`);
    return <>{its ? "its" : a} deployment{its ? null : where} has {p.tone === "bad" ? "no available replicas" : "too few replicas"}</>;
  }
  const what: Record<string, string> = {
    CrashLoopBackOff: "is crash-looping", ImagePullBackOff: "can't pull its image", ErrImagePull: "can't pull its image",
    OOMKilled: "ran out of memory", Pending: "is stuck pending", NotReady: "is running but not ready", Restarts: "keeps restarting",
    CreateContainerConfigError: "has a broken container config",
  };
  return <>{a} pod {what[p.reason] ?? `is failing (${p.reason})`}{where}</>;
}

function ProblemRow({ p, onOpen, onAsk }: { p: HealthProblem; onOpen: (p: HealthProblem) => void; onAsk: (p: HealthProblem) => void }) {
  const { base, hash } = p.kind === "Pod" ? splitByShape(p.name) : { base: p.name, hash: "" };
  return (
    <li className="ov-row" tabIndex={0} onClick={() => onOpen(p)} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onOpen(p)} aria-label={`${p.kind} ${p.namespace ? `${p.namespace}/` : ""}${p.name}: ${p.reason}`}>
      <span className={`kind-tile sm ${p.tone}`}><Ic icon={iconOfKind(p.kind)} size={14} /></span>
      <div className="ov-main">
        <div className="ov-name">
          <span className="ov-kind">{p.kind}</span>
          {p.namespace ? <span className="dim">{p.namespace} /</span> : null}
          <span>{base}{hash ? <span className="hash">{hash}</span> : null}</span>
        </div>
        <div className="ov-detail" title={p.detail}>{p.detail.replace(/; back-off .*$/, "")}</div>
      </div>
      <span className={`badge ${p.tone}`}><Ic icon={p.tone === "bad" ? CircleX : Clock} size={13} />{p.reason}</span>
      <button className="ghost-btn" onClick={(e) => (e.stopPropagation(), onAsk(p))} aria-label={`Ask Claude about ${p.name}`}><Ic icon={Sparkles} size={13} />Ask</button>
      <Ic icon={ChevronRight} size={14} className="chev" />
    </li>
  );
}

function WarningRow({ e, now }: { e: HealthEvent; now: number }) {
  return (
    <li className="ov-ev">
      <i className="diamond" aria-hidden="true" />
      <div className="ov-main">
        <div className="ov-name"><strong>{e.reason}</strong><span className="dim mono">{e.kind} {e.namespace ? `${e.namespace}/` : ""}{shortName(e.name)}</span></div>
        <div className="ov-detail" title={e.message}>{e.message}</div>
      </div>
      <span className="ev-meta">×{e.count} · {age(Date.parse(e.at), now)}</span>
    </li>
  );
}

function Nodes({ nodes }: { nodes: NonNullable<ClusterHealth["nodes"]>["items"] }) {
  const [all, setAll] = useState(false);
  const shown = nodes.length > 6 && !all ? nodes.filter((n) => !n.ready).slice(0, 6) : nodes;
  return (
    <section className="panel nodes" aria-label="Nodes">
      <header className="panel-head"><h3>Nodes</h3><span className="count-badge">{nodes.length}</span></header>
      {shown.map((n) => (
        <div key={n.name} className="node-row">
          <span className={`kind-tile sm ${n.ready ? "ok" : "bad"}`}><Ic icon={kindIcon("nodes")} size={14} /></span>
          <strong>{n.name}</strong>
          {n.roles.map((r) => <span key={r} className="chip">{r}</span>)}
          <span className="mono ver">{n.version}</span>
          <span className="grow" />
          {n.ready ? <span className="st tone-ok"><i className="dot" />Ready</span> : <span className="badge bad"><Ic icon={CircleX} size={13} />NotReady</span>}
        </div>
      ))}
      {shown.length < nodes.length ? <button className="show-all" onClick={() => setAll(true)}>Show all {nodes.length}</button> : null}
    </section>
  );
}

function OverviewSkeleton() {
  return (
    <div className="ov" aria-busy="true" aria-label="Loading health">
      <div className="skel" style={{ height: 76, borderRadius: 12 }} />
      <div className="tiles">{[0, 1, 2, 3].map((i) => <div key={i} className="skel" style={{ height: 112, borderRadius: 12 }} />)}</div>
      <div className="ov-cols">{[0, 1].map((i) => <div key={i} className="skel" style={{ height: 220, borderRadius: 12 }} />)}</div>
    </div>
  );
}

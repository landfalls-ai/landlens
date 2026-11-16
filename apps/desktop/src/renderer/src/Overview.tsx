// The landing page: is this cluster healthy? One verdict, four tiles, the worst five problems (the Problems page has
// them all), the recent warnings, and the nodes. All from cluster:health (packages/kube/src/health.ts), which the agent's cluster_overview shares.
import type { ClusterHealth, HealthEvent, HealthProblem, MetricsRange, MetricsSeries } from "@landlens/contracts";
import { age } from "@landlens/kube/status";
import { ChevronRight, CircleCheck, CircleDashed, CircleX, Clock, Layers, Lock, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Ic, iconOfKind, kindIcon } from "./icons";
import { plural } from "./health";
import { shortName, splitByShape } from "./present";
import type { ApiError } from "./api";
import { Sparkline } from "./charts/Sparkline";
import { useMetrics } from "./metrics";
import { Usage } from "./Usage";
import { ChecksStrip } from "./Problems";
import { missingChecks } from "@landlens/kube/checks";

/** The Overview shows the worst few; the Problems page has them all. */
const OV_PROBLEMS = 5;

export function Overview(props: {
  handle: string;
  /** Changes when the Clickland settings do. */
  metricsVersion: number;
  onSettings: () => void;
  health?: ClusterHealth;
  error?: ApiError;
  /** A namespace is chosen; when not, a 403 means the account can't read across all namespaces. */
  scoped?: boolean;
  /** Several namespaces are chosen (D158): this page still shows the whole cluster, and says so. */
  several?: number;
  onNamespace?: (ns: string) => void;
  now: number;
  onOpenList: (resource: "nodes" | "pods" | "deployments", failing?: boolean) => void;
  /** A row opens the problem's drawer on the Problems page (D57). */
  onOpenProblem: (p: HealthProblem) => void;
  onAskProblem: (p: HealthProblem) => void;
  onSeeAll: () => void;
  onAskAll: () => void;
}) {
  const { health: h, now } = props;
  const [range, setRange] = useState<MetricsRange>("1h");
  const usage = useMetrics({ handle: props.handle, scope: "cluster" }, range, props.metricsVersion);
  if (!h && props.error && props.error.status === 403 && !props.scoped && props.onNamespace) {
    return <div className="ov"><NamespaceNeeded message={props.error.message} onNamespace={props.onNamespace} /></div>;
  }
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
      {props.several ? <div className="chip ov-scope" role="note"><Ic icon={Layers} size={12} />{props.several} namespaces selected: this page shows the whole cluster</div> : null}
      <Verdict h={h} onAsk={props.onAskAll} />
      <ChecksStrip h={h} />
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
          <header className="panel-head"><h3>Problems</h3><span className="count-badge">{h.problems.length}</span><span className="grow" /><button className="link-btn small" onClick={props.onSeeAll}>Open Problems</button></header>
          {h.problems.length ? (
            <>
              <ul className="ov-list">{h.problems.slice(0, OV_PROBLEMS).map((x) => <ProblemRow key={x.id} p={x} onOpen={props.onOpenProblem} onAsk={props.onAskProblem} />)}</ul>
              {h.problems.length > OV_PROBLEMS ? <button className="show-all" onClick={props.onSeeAll}>See all {h.problems.length}{h.cut ? "+" : ""}</button> : null}
            </>
          ) : (
            <div className="ov-empty"><Ic icon={CircleCheck} size={20} /><span>{missingChecks(h.checks).length ? "No problems found in what was checked" : "No problems found"}</span></div>
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
      <Usage state={usage} range={range} onRange={setRange} onSettings={props.onSettings} />
      {h.nodes ? <Nodes nodes={h.nodes.items} usage={usage.data?.source === "none" ? undefined : usage.data} /> : null}
    </div>
  );
}

function Verdict({ h, onAsk }: { h: ClusterHealth; onAsk: () => void }) {
  const bad = h.problems.filter((p) => p.tone === "bad");
  const warn = h.problems.filter((p) => p.tone === "warn");
  if (!h.problems.length) {
    // "All clear" only when every check was made (part 3 review, M2): otherwise the strip below says what wasn't.
    const skipped = missingChecks(h.checks).length > 0;
    return (
      <section className={`verdict ${skipped ? "warn" : "ok"}`} aria-label="Verdict">
        <span className="verdict-icon"><Ic icon={skipped ? TriangleAlert : CircleCheck} size={22} /></span>
        <div className="verdict-text">
          <h2>{skipped ? "No problems found, but some checks were skipped" : "All clear"}</h2>
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

/** "orders-api is crash-looping in landlens-dev": one clause for the verdict, from the doctor's title. */
function describe(p: HealthProblem, before?: HealthProblem): ReactNode {
  const where = p.namespace && p.namespace !== before?.namespace ? <> in <b>{p.namespace}</b></> : null;
  return <>{p.title}{where}</>;
}

function ProblemRow({ p, onOpen, onAsk }: { p: HealthProblem; onOpen: (p: HealthProblem) => void; onAsk: (p: HealthProblem) => void }) {
  const { base, hash } = p.kind === "Pod" ? splitByShape(p.name) : { base: p.name, hash: "" };
  return (
    <li className="ov-row" tabIndex={0} onClick={() => onOpen(p)} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onOpen(p)} aria-label={`${p.title}. ${p.kind} ${p.namespace ? `${p.namespace}/` : ""}${p.name}: ${p.reason}`}>
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

function Nodes({ nodes, usage }: { nodes: NonNullable<ClusterHealth["nodes"]>["items"]; usage?: MetricsSeries }) {
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
          {usage ? <NodeSparks name={n.name} usage={usage} one={nodes.length === 1} /> : null}
          {n.ready ? <span className="st tone-ok"><i className="dot" />Ready</span> : <span className="badge bad"><Ic icon={CircleX} size={13} />NotReady</span>}
        </div>
      ))}
      {shown.length < nodes.length ? <button className="show-all" onClick={() => setAll(true)}>Show all {nodes.length}</button> : null}
    </section>
  );
}

/** CPU and memory for one node over the Usage card's range; against allocatable when it is the only node. */
function NodeSparks({ name, usage, one }: { name: string; usage: MetricsSeries; one: boolean }) {
  const line = (k: "cpu" | "memory") => usage[k].series.find((s) => s.key === name);
  const common = { from: usage.from, to: usage.to, step: usage.step };
  return (
    <span className="sparks">
      <Sparkline label="CPU" unit="cpu" line={line("cpu")} {...common} {...(one && usage.cpu.allocatable ? { of: usage.cpu.allocatable } : {})} />
      <Sparkline label="Mem" unit="memory" line={line("memory")} {...common} {...(one && usage.memory.allocatable ? { of: usage.memory.allocatable } : {})} />
    </span>
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

/**
 * The account can't list pods across all namespaces (a namespace-limited role, a GKE workload identity): say so in
 * plain words, and open a namespace it can read. The cluster's own message stays underneath.
 */
function NamespaceNeeded(props: { message: string; onNamespace: (ns: string) => void }) {
  const [ns, setNs] = useState("");
  const valid = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(ns);
  return (
    <div className="notice" role="alert">
      <Ic icon={Lock} size={15} className="dim" />
      <div className="notice-body">
        <strong>Your account can't read the whole cluster.</strong>
        <p>The Overview reads pods in every namespace, and the cluster refused. Open a namespace you can read, or pick one at the top.</p>
        <form className="ns-needed" onSubmit={(e) => (e.preventDefault(), valid && props.onNamespace(ns))}>
          <label className="field"><input aria-label="Namespace" placeholder="namespace" value={ns} spellCheck={false} autoCapitalize="off" onChange={(e) => setNs(e.target.value.trim())} /></label>
          <button type="submit" className="secondary" disabled={!valid}>Open</button>
        </form>
        <p className="dim">{props.message}</p>
      </div>
    </div>
  );
}

// The Overview's Usage card: cluster CPU and memory over time against what the nodes can allocate, stacked per node;
// and the namespaces using the most. One range switch above it scopes everything below, the node sparklines too.
import type { MetricsRange, MetricsSeries } from "@landlens/contracts";
import { CircleX } from "lucide-react";
import { useState } from "react";
import { Bars } from "./charts/Bars";
import { TimeChart } from "./charts/TimeChart";
import { Ic } from "./icons";
import type { MetricsState } from "./metrics";
import { MetricsSource, MetricsUnavailable, RangeSwitch } from "./MetricsNotice";

const TOP = 6;

export function Usage(props: { state: MetricsState; range: MetricsRange; onRange: (r: MetricsRange) => void; onSettings: () => void }) {
  const { data, error, stale } = props.state;
  return (
    <section className="panel usage" aria-label="Usage">
      <header className="panel-head usage-head">
        <h3>Usage</h3>
        {data ? <MetricsSource data={data} onSettings={props.onSettings} /> : null}
        <span className="grow" />
        <RangeSwitch value={props.range} onChange={props.onRange} label="Usage range" />
      </header>
      {error && !data ? (
        <div className="usage-body unavailable">
          <div className="notice metrics-notice" role="alert"><Ic icon={CircleX} size={15} className="tone-bad" /><div className="notice-body"><strong>Couldn't read metrics.</strong><p>{error.message}</p></div></div>
        </div>
      ) : !data ? (
        <div className="usage-body" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 196 }} />)}</div>
      ) : data.source === "none" ? (
        <div className="usage-body unavailable"><MetricsUnavailable data={data} onSettings={props.onSettings} /></div>
      ) : (
        <div className="usage-body">
          <TimeChart title="CPU" unit="cpu" panel={data.cpu} from={data.from} to={data.to} step={data.step} stacked by="node" stale={stale} />
          <TimeChart title="Memory" unit="memory" panel={data.memory} from={data.from} to={data.to} step={data.step} stacked by="node" stale={stale} />
          <Namespaces data={data} stale={stale} />
        </div>
      )}
    </section>
  );
}

function Namespaces({ data, stale }: { data: MetricsSeries; stale: boolean }) {
  const [measure, setMeasure] = useState<"cpu" | "memory">("cpu");
  const all = [...(data.namespaces ?? [])].filter((n) => n.key !== "other").sort((a, b) => b[measure] - a[measure]);
  const rows = all.slice(0, TOP).map((n) => ({ key: n.key, value: n[measure] }));
  const rest = [...all.slice(TOP), ...(data.namespaces ?? []).filter((n) => n.key === "other")];
  if (rest.length) rows.push({ key: "other", value: rest.reduce((a, n) => a + n[measure], 0) });
  return (
    <div className={"usage-ns chart" + (stale ? " stale" : "")}>
      <div className="chart-head">
        <span className="chart-title">Top namespaces</span>
        <span className="dim small">mean</span>
        <div className="seg range" role="radiogroup" aria-label="Measure">
          {(["cpu", "memory"] as const).map((m) => (
            <button key={m} role="radio" aria-checked={measure === m} className={measure === m ? "on" : ""} onClick={() => setMeasure(m)}>{m === "cpu" ? "CPU" : "Memory"}</button>
          ))}
        </div>
      </div>
      {rows.length ? <Bars rows={rows} unit={measure} label={`Namespaces by ${measure === "cpu" ? "CPU" : "memory"}`} /> : <p className="chart-note">No pod samples in this range.</p>}
    </div>
  );
}

// The drawer's Metrics tab, for a pod (stacked per container) or a workload (a line per pod): CPU and memory with the
// request and limit lines, the range switch, and what is missing when nothing can be drawn.
import type { KubeObject, MetricsRange, MetricsScope, ResourceType } from "@landlens/contracts";
import { podStatus } from "@landlens/kube/status";
import { useState } from "react";
import { TimeChart } from "./charts/TimeChart";
import { format } from "./charts/scale";
import { useMetrics } from "./metrics";
import { MetricsSource, MetricsUnavailable, RangeSwitch } from "./MetricsNotice";

const SCOPES: Record<string, MetricsScope> = { "/pods": "pod", "apps/deployments": "deployment", "apps/statefulsets": "statefulset", "apps/daemonsets": "daemonset" };
export const metricsScope = (t: ResourceType): MetricsScope | undefined => SCOPES[`${t.group}/${t.resource}`];

export function MetricsTab(props: { handle: string; type: ResourceType; object: KubeObject; version: number; onSettings: () => void }) {
  const [range, setRange] = useState<MetricsRange>("1h");
  const scope = metricsScope(props.type)!;
  const o = props.object;
  const { data, error, stale } = useMetrics({ handle: props.handle, scope, namespace: o.metadata.namespace!, name: o.metadata.name }, range, props.version);
  const pod = scope === "pod";
  const by = pod ? "container" : "pod";

  let body;
  if (error && !data) body = <p className="tone-bad small" role="alert">Couldn't read metrics: {error.message}</p>;
  else if (!data) body = <div className="skel" style={{ height: 380 }} aria-busy="true" />;
  else if (data.source === "none") body = <MetricsUnavailable data={data} onSettings={props.onSettings} />;
  else if (!data.cpu.series.length && !data.memory.series.length) {
    const state = pod ? podStatus(o).text : undefined;
    const refs = [data.cpu.request !== undefined ? `CPU request ${format(data.cpu.request, "cpu")}` : "", data.memory.limit !== undefined ? `memory limit ${format(data.memory.limit, "memory")}` : ""].filter(Boolean);
    body = (
      <div className="mtab-empty" role="status">
        <strong>No usage samples for this {pod ? "pod" : props.type.kind.toLowerCase()} in the last {range} yet.</strong>
        <span>
          {data.source === "clickland" ? "Clickland stores kubelet stats every 30s, for running containers only" : "metrics-server reports running containers only"}
          {state && state !== "Running" ? `; its status is ${state}, so no container ran long enough to be sampled.` : "; a new pod shows up within a minute."}
        </span>
        {refs.length ? <span className="dim">{refs.join(" · ")}{pod ? " (from its spec)" : " per pod"}.</span> : null}
      </div>
    );
  } else
    body = (
      <>
        <TimeChart title="CPU" unit="cpu" panel={data.cpu} from={data.from} to={data.to} step={data.step} stacked={pod} by={by} height={140} stale={stale} />
        <TimeChart title="Memory" unit="memory" panel={data.memory} from={data.from} to={data.to} step={data.step} stacked={pod} by={by} height={140} stale={stale} />
        <p className="chart-note">
          {pod ? "Stacked per container: the top edge is the pod. " : "One line per pod, against one pod's request and limit. "}
          {data.cpu.limit === undefined ? "No CPU limit line: not every container sets one." : ""}
        </p>
      </>
    );

  return (
    <div className="mtab" aria-label="Metrics">
      <div className="mtab-head">
        {data ? <MetricsSource data={data} onSettings={props.onSettings} /> : <span className="dim small">Loading…</span>}
        <span className="grow" />
        <RangeSwitch value={range} onChange={setRange} label="Metrics range" />
      </div>
      {body}
    </div>
  );
}

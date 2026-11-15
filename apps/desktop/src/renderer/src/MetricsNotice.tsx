// What a chart says when it can't draw: which source is missing, why, and the action that fixes it. And, when it can,
// a quiet line naming the source.
import type { MetricsReason, MetricsSeries } from "@landlens/contracts";
import { ChartLine, CircleX, Database, Flame, History, PlugZap } from "lucide-react";
import { Ic } from "./icons";
import { RANGES } from "./metrics";
import type { MetricsRange } from "@landlens/contracts";

const TITLE: Partial<Record<MetricsReason["code"], string>> = {
  "clickland-unreachable": "Clickland isn't answering",
  "clickland-unauthorized": "Clickland refused the key",
  "clickland-failed": "Clickland couldn't answer",
  "clickland-no-cluster": "Clickland has no data for this cluster",
};

/** Nothing to draw: no Clickland (or it failed) and no metrics-server. */
export function MetricsUnavailable({ data, onSettings }: { data: MetricsSeries; onSettings: () => void }) {
  const off = data.reasons.some((r) => r.code === "clickland-off");
  const clickland = data.reasons.find((r) => r.code.startsWith("clickland-") && r.code !== "clickland-off");
  // The cluster's Prometheus answered nothing usable either; its reason is in the list.
  return (
    <div className="notice metrics-notice" role="status" aria-label="Metrics unavailable">
      <Ic icon={clickland ? CircleX : ChartLine} size={15} className={clickland ? "tone-bad" : "dim"} />
      <div className="notice-body">
        <strong>{clickland ? TITLE[clickland.code] : "No metrics source for this cluster"}</strong>
        <ul className="reasons">{data.reasons.map((r) => <li key={r.code}>{r.message}</li>)}</ul>
        <p>
          {off ? "Connect Clickland for history (it stores kubelet stats every 30s), " : "Check Clickland's address and key, "}
          or install metrics-server in the cluster for live samples while Landlens is open.
        </p>
        <button className={off ? "primary" : "secondary"} onClick={onSettings}><Ic icon={PlugZap} size={14} />{off ? "Connect Clickland" : "Clickland settings"}</button>
      </div>
    </div>
  );
}

/** Where the numbers come from; for metrics-server, also why not Clickland, with the fix one click away. */
export function MetricsSource({ data, onSettings }: { data: MetricsSeries; onSettings: () => void }) {
  if (data.source === "clickland")
    return <span className="metrics-src" title={`Clickland, k8s.cluster.name “${data.cluster}”, ${data.step}s steps`}><Ic icon={Database} size={12} />Clickland<span className="dim mono">{data.cluster}</span></span>;
  if (data.source === "prometheus")
    return <span className="metrics-src" title={`The cluster's Prometheus (${data.prometheus}), cAdvisor series, ${data.step}s steps`}><Ic icon={Flame} size={12} />Prometheus<span className="dim mono">{data.prometheus?.split("/")[1]}</span></span>;
  if (data.source !== "metrics-server") return null;
  const why = data.reasons.find((r) => r.code !== "live-only");
  return (
    <span className="metrics-src live" title={data.reasons.map((r) => r.message).join("\n")}>
      <Ic icon={History} size={12} />Live from metrics-server, no history
      {why ? <button className="link-btn" onClick={onSettings}>{why.code === "clickland-off" ? "Connect Clickland" : "Clickland settings"}</button> : null}
    </span>
  );
}

export function RangeSwitch({ value, onChange, label }: { value: MetricsRange; onChange: (r: MetricsRange) => void; label: string }) {
  return (
    <div className="seg range" role="radiogroup" aria-label={label}>
      {RANGES.map((r) => (
        <button key={r} role="radio" aria-checked={value === r} className={value === r ? "on" : ""} onClick={() => onChange(r)}>{r}</button>
      ))}
    </div>
  );
}

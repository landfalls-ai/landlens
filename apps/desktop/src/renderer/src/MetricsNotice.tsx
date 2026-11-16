// What a chart says when it can't draw: which source is missing, why, and the action that fixes it. And, when it can,
// a quiet line naming the source.
import type { MetricsReason, MetricsSeries } from "@landlens/contracts";
import { ChartLine, CircleX, Cloud, Database, Flame, History, PlugZap } from "lucide-react";
import { useState } from "react";
import { copyableCommand, sentenceParts } from "./googleRules";
import { Ic } from "./icons";
import { RANGES } from "./metrics";
import { copyText } from "./present";
import type { MetricsRange } from "@landlens/contracts";

/** "Open Google Cloud" from a chart (wave 9 D184): the workspace opens the Google Cloud page. No address, no project. */
export const OPEN_GCP_EVENT = "landlens:open-gcp";
const openGcp = () => window.dispatchEvent(new CustomEvent(OPEN_GCP_EVENT));

/** What a Cloud Monitoring reason offers: Open Google Cloud for an unchosen project, Copy for an enable command. */
function CloudMonitoringFix({ reasons, block }: { reasons: MetricsReason[]; block?: boolean }) {
  const [done, setDone] = useState(false);
  const notChosen = reasons.some((r) => r.code === "cloud-monitoring-not-chosen");
  const failed = reasons.find((r) => r.code === "cloud-monitoring-failed");
  const cmd = failed ? copyableCommand(failed.message) : undefined;
  if (!notChosen && !cmd) return null;
  const Wrap = block ? "p" : "span";
  return (
    <Wrap className={block ? "small" : undefined}>
      {notChosen ? <button className="link-btn" onClick={openGcp}>Open Google Cloud</button> : null}
      {cmd ? (
        <button className="link-btn" title={cmd} onClick={() => void copyText(cmd).then(() => (setDone(true), setTimeout(() => setDone(false), 1200)))}>
          {done ? "Copied" : "Copy command"}
        </button>
      ) : null}
    </Wrap>
  );
}

/** Choosing the Prometheus Landlens found, or no longer using it: the workspace asks main and redraws every chart. */
export const PROMETHEUS_EVENT = "landlens:prometheus";
const choosePrometheus = (use: string | null) => window.dispatchEvent(new CustomEvent(PROMETHEUS_EVENT, { detail: use }));

/** A found Prometheus, offered (security review, wave 4 part 4, finding 4): it is used only once you choose it. */
function PrometheusOffer({ found }: { found: string }) {
  return (
    <button className="link-btn prom-offer" title={`Landlens found a Prometheus at ${found}. Anyone who can make a Service with Prometheus's labels could pose as one, so it is used only once you choose it.`} onClick={() => choosePrometheus(found)}>
      Use Prometheus <span className="mono">{found}</span>
    </button>
  );
}

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
        <ul className="reasons">{data.reasons.map((r) => <li key={r.code}>{sentenceParts(r.message).map((p, i) => (p.code ? <code key={i} className="mono">{p.text}</code> : <span key={i}>{p.text}</span>))}</li>)}</ul>
        <p>
          {off ? "Connect Clickland for history (it stores kubelet stats every 30s), " : "Check Clickland's address and key, "}
          or install metrics-server in the cluster for live samples while Landlens is open.
        </p>
        <button className={off ? "primary" : "secondary"} onClick={onSettings}><Ic icon={PlugZap} size={14} />{off ? "Connect Clickland" : "Clickland settings"}</button>
        {data.prometheusFound ? <p className="small">This cluster has a Prometheus: <PrometheusOffer found={data.prometheusFound} /></p> : null}
        <CloudMonitoringFix reasons={data.reasons} block />
      </div>
    </div>
  );
}

/** Where the numbers come from; for metrics-server, also why not Clickland, with the fix one click away. */
export function MetricsSource({ data, onSettings, onOpenClickland }: { data: MetricsSeries; onSettings: () => void; onOpenClickland?: (() => void) | undefined }) {
  if (data.source === "clickland")
    return (
      <span className="metrics-src" title={`Clickland, k8s.cluster.name “${data.cluster}”, ${data.step}s steps`}>
        <Ic icon={Database} size={12} />Clickland<span className="dim mono">{data.cluster}</span>
        {onOpenClickland ? <button className="link-btn" onClick={onOpenClickland}>Open in Clickland</button> : null}
      </span>
    );
  if (data.source === "prometheus")
    return <span className="metrics-src" title={`The cluster's Prometheus (${data.prometheus}), cAdvisor series, ${data.step}s steps`}><Ic icon={Flame} size={12} />Prometheus<span className="dim mono">{data.prometheus?.split("/")[1]}</span><button className="link-btn" onClick={() => choosePrometheus(null)}>Stop using</button></span>;
  if (data.source === "cloud-monitoring" && data.gke) {
    const g = data.gke;
    return (
      <span className="metrics-src" title={`Cloud Monitoring, GKE system metrics of ${g.name} in ${g.project} (${g.location}), ${data.step}s steps`}>
        <Ic icon={Cloud} size={12} />Cloud Monitoring<span className="dim mono">{g.name}</span>
        {data.prometheusFound ? <PrometheusOffer found={data.prometheusFound} /> : null}
      </span>
    );
  }
  if (data.source !== "metrics-server") return null;
  const why = data.reasons.find((r) => r.code !== "live-only");
  return (
    <span className="metrics-src live" title={data.reasons.map((r) => r.message).join("\n")}>
      <Ic icon={History} size={12} />Live from metrics-server, no history
      {why ? <button className="link-btn" onClick={onSettings}>{why.code === "clickland-off" ? "Connect Clickland" : "Clickland settings"}</button> : null}
      {data.prometheusFound ? <PrometheusOffer found={data.prometheusFound} /> : null}
      <CloudMonitoringFix reasons={data.reasons} />
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

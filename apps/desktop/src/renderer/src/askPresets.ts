// Preset asks (wave 8 part 3, D159) and "Ask Claude about these N" (D160): Landlens's own questions, each with the
// kinds it fits. A preset sends its fixed question with the object attached exactly as Ask Claude attaches it (a
// reference the agent reads with the session's token: scrubbed, namespace-limited, never a Secret), so no new data
// path exists. The selection's ask quotes names and the table's Status and Ready words only, as data. Neither is
// offered on Secrets. Lens Desktop's presets (public docs only) were the reference for the names.
import type { KubeObject, ResourceType } from "@landlens/contracts";
import type { Tone } from "@landlens/kube/status";
import type { Column } from "./kinds";
import type { AskContext } from "./quotes";

export type PresetId = "summarize" | "failing" | "logs" | "metrics" | "related" | "drain";
export type Preset = { id: PresetId; label: string; question: string; fits: (key: string) => boolean };

const WORKLOADS = new Set(["deployments.apps", "statefulsets.apps", "daemonsets.apps", "replicasets.apps"]);
const JOBS = new Set(["jobs.batch", "cronjobs.batch"]);
const isPod = (k: string) => k === "pods";
const isWorkload = (k: string) => WORKLOADS.has(k);
const isJob = (k: string) => JOBS.has(k);

/** The presets, in menu order; "Why is this failing?" moves first on a row in trouble. The words are fixed. */
export const PRESETS: readonly Preset[] = [
  { id: "summarize", label: "Summarize", fits: () => true,
    question: "Summarize this object: what it is, what state it is in, and anything unusual. Six lines at most." },
  { id: "failing", label: "Why is this failing?", fits: (k) => isPod(k) || isWorkload(k) || isJob(k) || k === "nodes" || k === "persistentvolumeclaims",
    question: "Why is this failing? Give the cause first, then the evidence you checked, then one proposed change." },
  { id: "logs", label: "Analyze logs", fits: (k) => isPod(k) || isWorkload(k) || isJob(k),
    question: "Read its recent logs (and the previous run's if it restarted). What errors repeat, since when, and what do they point to?" },
  { id: "metrics", label: "Analyze metrics", fits: (k) => isPod(k) || isWorkload(k) || k === "nodes",
    question: "Look at its CPU and memory over the last 6 hours against its requests and limits. Is it sized right?" },
  { id: "related", label: "Review related resources", fits: (k) => isPod(k) || isWorkload(k) || k === "services" || k === "ingresses.networking.k8s.io",
    question: "Check what this depends on and what depends on it (Services, Ingresses, ConfigMaps, claims, autoscalers, budgets). What is misconfigured or missing?" },
  { id: "drain", label: "Is it safe to drain?", fits: (k) => k === "nodes",
    question: "Would draining this node cause an outage? Check single-replica workloads, disruption budgets, bare pods and emptyDir data on it." },
];

const keyOf = (t: Pick<ResourceType, "group" | "resource">) => (t.group ? `${t.resource}.${t.group}` : t.resource);
const secret = (t: Pick<ResourceType, "group" | "resource">) => t.group === "" && t.resource === "secrets";

/** The presets a kind has, in order; "Why is this failing?" first when the row's tone is bad or warn. None on Secrets. */
export function presetsFor(t: Pick<ResourceType, "group" | "resource">, tone?: Tone | "muted"): Preset[] {
  if (secret(t)) return [];
  const k = keyOf(t);
  const fit = PRESETS.filter((p) => p.fits(k));
  const failing = fit.find((p) => p.id === "failing");
  return failing && (tone === "bad" || tone === "warn") ? [failing, ...fit.filter((p) => p !== failing)] : fit;
}

export const presetById = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id);

/** The object Ask Claude attaches (D159): a reference, read by the agent with the session's token. */
export function objectContext(t: Pick<ResourceType, "group" | "version" | "resource" | "kind">, o: Pick<KubeObject, "metadata">): AskContext {
  return {
    ref: { group: t.group, version: t.version, resource: t.resource, name: o.metadata.name, ...(o.metadata.namespace ? { namespace: o.metadata.namespace } : {}) },
    label: `${t.kind} ${o.metadata.namespace ? `${o.metadata.namespace}/` : ""}${o.metadata.name}`,
  };
}

/** The first message of "Ask Claude about these N" (D160): left in the box, selected, for you to overwrite. */
export const SELECTION_QUESTION = "What do these have in common?";
export const MAX_SELECTION_LINES = 50;
/** A status or Ready word the selection quotes: short, plain words; anything else reads "Unknown". */
export const STATUS_WORD = /^[A-Za-z][A-Za-z0-9 :/()-]{0,60}$/;
/** A Ready count ("1/2"). */
export const READY_WORD = /^\d{1,6}\/\d{1,6}$/;
const NAME = /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/;
const KIND = /^[A-Z][A-Za-z0-9]{0,62}$/;
const word = (s: string | undefined, re = STATUS_WORD) => (s !== undefined && re.test(s) ? s : "Unknown");

/**
 * "Ask Claude about these N" (D160): one quoted context, a line per object (at most 50): `namespace/name`, then the
 * table's Status and Ready words where it has them. No labels, annotations or spec; no object attached (the agent reads
 * what it needs with its own token). Undefined for Secrets, and for nothing selected.
 */
export function selectionContext(t: Pick<ResourceType, "group" | "resource" | "kind">, objects: KubeObject[], columns: Column[], now: number): AskContext | undefined {
  if (secret(t) || !objects.length) return undefined;
  const status = columns.find((c) => c.id === "status");
  const ready = columns.find((c) => c.id === "ready");
  const lines = objects.slice(0, MAX_SELECTION_LINES).map((o) => {
    const ns = o.metadata.namespace && NAME.test(o.metadata.namespace) ? `${o.metadata.namespace}/` : "";
    const name = NAME.test(o.metadata.name) ? o.metadata.name : "(unreadable name)";
    const parts = [`${ns}${name}`];
    if (status) parts.push(`status ${word(status.cell(o, now).text)}`);
    if (ready) parts.push(`ready ${word(ready.cell(o, now).text, READY_WORD)}`);
    return parts.join(" · ");
  });
  const cut = objects.length - lines.length;
  const kind = KIND.test(t.kind) ? t.kind : "object";
  return {
    label: `${objects.length} ${kind}${objects.length === 1 ? "" : "s"} selected`,
    text: lines.join("\n") + (cut > 0 ? `\n(and ${cut} more not listed)` : ""),
    kind: "selection",
    source: `${objects.length} ${kind}`,
  };
}

// What an imported view runs only after the person's yes (D217; security review of wave 10 part 4, M2, M3, M5): its
// custom (app) blocks and its connection sources. Each is a trust item with a key over exactly what it is (an app block:
// its id, title, uses, html and js, and every source it reaches, joins included; a connection source: what it reads),
// so a yes covers exactly what main's dialog named, and a later version that adds or changes one asks again. The words
// are the dialog's: every source a block reaches, each with its kind and target.
import { createHash } from "node:crypto";
import { cellText } from "./text.js";
import { CONNECTION_KINDS, type Block, type Source, type ViewDocument } from "./schema.js";

export type AppBlock = Extract<Block, { type: "app" }>;
export type TrustItem =
  | { kind: "block"; id: string; key: string; title: string; reaches: string[] }
  | { kind: "source"; id: string; key: string };

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** The sources a source joins (its pipe's `join.with`). */
export const joinsOf = (s: Source | undefined): string[] =>
  s && "pipe" in s ? (s.pipe ?? []).flatMap((st) => ("join" in st ? [st.join.with] : [])) : [];

/** `ids` and every source they reach through joins, transitively, each once, in the order first reached. */
export function reach(document: ViewDocument, ids: readonly string[]): string[] {
  const out: string[] = [];
  const visit = (id: string) => {
    if (out.includes(id) || !document.sources[id]) return;
    out.push(id);
    for (const j of joinsOf(document.sources[id])) visit(j);
  };
  for (const id of ids) visit(id);
  return out;
}

/**
 * An imported document's trust items: each app block (its key over the block and the sources it reaches, so a block
 * that comes to read more asks again) and each connection source (its key over what it reads). A document's other
 * sources (its cluster's, read with the view's own token) aren't held (D217).
 */
export function trustItems(document: ViewDocument): TrustItem[] {
  const out: TrustItem[] = [];
  for (const b of document.blocks) {
    if (b.type !== "app") continue;
    const reaches = reach(document, b.uses);
    out.push({ kind: "block", id: b.id, title: b.title ?? b.id, reaches, key: `b:${sha([b, reaches.map((r) => [r, document.sources[r]])])}` });
  }
  for (const [id, s] of Object.entries(document.sources)) {
    if (CONNECTION_KINDS.has(s.kind)) out.push({ kind: "source", id, key: `s:${sha({ ...s, pipe: undefined, fields: undefined })}` });
  }
  return out;
}

/** A trust key's shape (as saved with a view). */
export const TRUST_KEY = /^[bs]:[0-9a-f]{64}$/;

const nsWords = (n: unknown): string =>
  n === undefined ? "" : n === "*" ? " in every namespace" : typeof n === "string" ? ` in ${n}` : " in the namespace you choose";

const argWords = (args: Record<string, unknown> | undefined): string => {
  const e = Object.entries(args ?? {});
  if (!e.length) return " with no arguments";
  // Whole: an argument is at most 500 characters and a tool at most 12 of them (the schema), so nothing is cut and the
  // person's yes covers exactly what they read.
  return ` with ${e.map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : String(v)}`).join(", ")}`;
};

/**
 * A source in words, for main's dialog: its kind and its target (namespace, object, selectors; a tool's server, tool
 * and every argument; a Google Cloud project, query or cluster; Clickland's namespace and object). Never its rows.
 */
export function sourceWords(s: Source | undefined): string {
  if (!s) return "nothing";
  const ns = "namespace" in s ? nsWords(s.namespace) : "";
  const sel = (x: { labelSelector?: string; fieldSelector?: string }) =>
    [x.labelSelector ? ` labelled ${x.labelSelector}` : "", x.fieldSelector ? ` where ${x.fieldSelector}` : ""].join("");
  const obj = (x: { pod?: string; workload?: { kind: string; name: string } }) => (x.pod ? ` of pod ${x.pod}` : x.workload ? ` of ${x.workload.kind} ${x.workload.name}` : "");
  switch (s.kind) {
    case "kube.list": return `${s.resource}${s.group ? `.${s.group}` : ""}${ns}${sel(s)}`;
    case "kube.events": return `events${ns}`;
    case "kube.logs": return `logs${obj(s)}${ns}`;
    case "kube.top": return `usage of ${s.of}${ns}`;
    case "metrics.series": return `usage over time of the ${s.scope}${s.name ? ` ${s.name}` : ""}${ns}`;
    case "doctor.problems": return `the doctor's problems${ns}`;
    case "helm.releases": return `Helm releases${ns}`;
    case "gcp.resources": return `Google Cloud resources in project ${s.project}${s.assetType ? ` of type ${s.assetType}` : ""}${s.query ? ` matching ${JSON.stringify(s.query)}` : ""}`;
    case "gcp.clusters": return `Google Cloud's GKE clusters${s.project ? ` in project ${s.project}` : " in every project you chose"}`;
    case "gcp.alerts": return `Google Cloud alerts in project ${s.project}${s.cluster ? ` on ${s.cluster}` : ""}`;
    case "gcp.recommendations": return `Google Cloud recommendations in project ${s.project}${s.cluster ? ` on ${s.cluster}` : ""}`;
    case "gcp.metrics": return `Google Cloud Monitoring usage of the ${s.scope}${s.name ? ` ${s.name}` : ""} on ${s.cluster}${ns}`;
    case "clickland.logs": return `Clickland logs${obj(s)}${ns}${s.filter ? ` matching ${JSON.stringify(cellText(s.filter, 200))}` : ""}`;
    case "clickland.traces": return `Clickland traces${obj(s)}${ns}`;
    case "tool": return `${s.server} · ${s.tool}${argWords(s.arguments)}`;
  }
}

// D206: the view document, validated in main by a strict schema before anything is shown. Every object is strict
// (an unknown key is refused by name), every name meets Kubernetes's own rules (contracts), Claude's text may hold no
// control or invisible character, and the document is checked whole: blocks name sources that exist and are the right
// kind, joins form no cycle, parameters exist and are the right type, and every limit of D225 holds. Views can't read
// Secrets, and nothing here names a URL, a path, a query language string for the cluster, a verb or code to run in main.
import { GroupName, MetricsRange, MetricsScope, NamespaceName, ObjectName, ResourceName, VersionName } from "@landlens/contracts";
import { z } from "zod";
import { issueWords, issuesOf, SENTENCES, type Issue } from "./errors.js";
import { VIEW_LIMITS } from "./limits.js";
import { parsePath } from "./path.js";
import { docText } from "./text.js";

export const VIEW_SCHEMA = 1;

const custom = (ctx: z.core.$RefinementCtx<unknown>, path: PropertyKey[], message: string) =>
  ctx.addIssue({ code: "custom", message, path });

export const Id = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,30}$/, "not an id: a lowercase letter, then letters, digits or -, at most 31")
  // Never a name every object inherits (security review of wave 10 part 1, L5).
  .refine((f) => f !== "constructor" && f !== "prototype", "not an id Landlens allows");
/**
 * Names every object has (toString, valueOf, hasOwnProperty, …): a row that owned one would break code that turns a
 * row into text, in the page or in Claude's script (security review of wave 10 part 1, a note for part 2).
 */
const INHERITED: ReadonlySet<string> = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype"]);
export const Field = z
  .string()
  .regex(/^[a-z][A-Za-z0-9_]{0,40}$/, "not a field name: a lowercase letter, then letters, digits or _, at most 41")
  .refine((f) => !INHERITED.has(f), "not a field name Landlens allows");

/** Claude's text: no control or invisible character (refused, so Claude sees why); variation selectors dropped. */
export const Text = (max: number, opts: { min?: number; lines?: boolean } = {}) =>
  z
    .string()
    .min(opts.min ?? 0)
    .max(max)
    .superRefine((s, ctx) => {
      if (docText(s, opts.lines).invisible) ctx.addIssue({ code: "custom", message: "text can't hold control or invisible characters" });
    })
    .transform((s) => docText(s, opts.lines).text);

export const ParamRef = z.object({ param: Id }).strict();
/** Everything a view may read, or a namespace, or a parameter that names one. */
const Namespaces = z.union([z.literal("*"), NamespaceName, ParamRef]);
const OneNamespace = z.union([NamespaceName, ParamRef]);
const Value = z.union([Text(100), z.number(), z.boolean(), ParamRef]);
/** A container's name is a DNS label. */
const ContainerName = z.string().max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, "not a container name");
/** Selectors are sent as query parameters, never in a path: their characters only, no %, ?, # or &. */
const Selector = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_./=!,() -]+$/, "a selector may only use letters, digits and _ . / = ! , ( ) - and spaces");
const PathString = z
  .string()
  .max(200)
  .superRefine((p, ctx) => {
    if (docText(p).invisible) return void ctx.addIssue({ code: "custom", message: "text can't hold control or invisible characters" });
    const parsed = parsePath(p);
    if ("error" in parsed) ctx.addIssue({ code: "custom", message: parsed.error });
  });

// ---- params -------------------------------------------------------------------------------------------------------

export const Param = z.discriminatedUnion("type", [
  z.object({ name: Id, type: z.literal("namespace"), label: Text(40).optional(), default: NamespaceName.optional() }).strict(),
  z.object({
    name: Id, type: z.literal("choice"), label: Text(40).optional(),
    options: z.array(Text(60, { min: 1 })).min(1).max(20), default: Text(60).optional(),
  }).strict(),
  z.object({ name: Id, type: z.literal("text"), label: Text(40).optional(), default: Text(100).optional() }).strict(),
]);

// ---- pipe steps (D208) --------------------------------------------------------------------------------------------

const Cond = z.object({
  field: Field,
  op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "contains", "startsWith", "endsWith", "in", "exists"]),
  value: z.union([Value, z.array(Value).min(1).max(50)]).optional(),
}).strict().superRefine((c, ctx) => {
  if (c.op === "exists" && c.value !== undefined) custom(ctx, ["value"], "exists takes no value");
  if (c.op !== "exists" && c.value === undefined) custom(ctx, ["value"], "required");
  if (c.op !== "in" && Array.isArray(c.value)) custom(ctx, ["value"], "only in takes a list");
});
const Agg = z.object({
  fn: z.enum(["count", "sum", "avg", "min", "max", "first", "countDistinct"]),
  field: Field.optional(),
}).strict().superRefine((a, ctx) => {
  if (a.fn !== "count" && !a.field) custom(ctx, ["field"], "required");
});
const count = (min: number, max: number) => (r: Record<string, unknown>, ctx: z.core.$RefinementCtx<unknown>) => {
  const n = Object.keys(r).length;
  if (n < min) custom(ctx, [], `at least ${min} entries`);
  if (n > max) custom(ctx, [], `at most ${max} entries`);
};
const STEPS = {
  filter: z.object({ filter: z.array(Cond).min(1).max(8) }).strict(),
  sort: z.object({ sort: z.array(z.object({ field: Field, dir: z.enum(["asc", "desc"]).optional() }).strict()).min(1).max(3) }).strict(),
  limit: z.object({ limit: z.number().int().min(1).max(VIEW_LIMITS.rows) }).strict(),
  group: z.object({
    group: z.object({ by: z.array(Field).max(3), agg: z.record(Field, Agg).superRefine(count(1, 8)) }).strict(),
  }).strict(),
  join: z.object({
    join: z.object({
      with: Id,
      on: z.union([z.object({ left: Field, right: Field }).strict(), z.object({ selector: Field, labels: Field }).strict()]),
      take: z.record(Field, Field).superRefine(count(1, 8)).optional(),
      agg: z.record(Field, Agg).superRefine(count(1, 8)).optional(),
    }).strict().superRefine((j, ctx) => {
      if (!j.take && !j.agg) custom(ctx, [], "a join takes fields (take) or aggregates (agg) from the other source");
    }),
  }).strict(),
  derive: z.object({
    derive: z.record(Field, z.object({ fn: z.enum(["ratio", "percent", "diff", "sum"]), of: z.tuple([Field, Field]) }).strict()).superRefine(count(1, 4)),
  }).strict(),
  rename: z.object({ rename: z.record(Field, Field).superRefine(count(1, 16)) }).strict(),
  pick: z.object({ pick: z.array(Field).min(1).max(VIEW_LIMITS.fields) }).strict(),
} as const;
type StepOut = { [K in keyof typeof STEPS]: z.output<(typeof STEPS)[K]> }[keyof typeof STEPS];

/** A step is one of eight shapes, told apart by its one key, so its errors are that shape's, not "no shape matched". */
export const Step = z.unknown().transform((v, ctx): StepOut => {
  const keys = v !== null && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : [];
  if (keys.length !== 1) {
    custom(ctx, [], `a step is an object with exactly one of ${Object.keys(STEPS).join(", ")}`);
    return z.NEVER;
  }
  const key = keys[0]!;
  if (!Object.hasOwn(STEPS, key)) {
    custom(ctx, [key], SENTENCES.noSuchField);
    return z.NEVER;
  }
  const r = STEPS[key as keyof typeof STEPS].safeParse(v, { reportInput: true });
  if (r.success) return r.data as StepOut;
  relay(ctx, r.error);
  return z.NEVER;
});

/** Another schema's issues, as ours, at their place under this one. */
function relay(ctx: z.core.$RefinementCtx<unknown>, error: z.ZodError) {
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") for (const k of issue.keys) custom(ctx, [...issue.path, k], SENTENCES.noSuchField);
    else custom(ctx, [...issue.path], issueWords(issue)[0]?.message ?? "not valid here");
  }
}

// ---- sources (D207) -----------------------------------------------------------------------------------------------

const fieldsAndPipe = {
  fields: z.record(Field, PathString).superRefine(count(1, VIEW_LIMITS.fields)).optional(),
  pipe: z.array(Step).max(VIEW_LIMITS.steps).optional(),
};
export const Source = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("kube.list"), resource: ResourceName.refine((r) => r !== "secrets", SENTENCES.secrets), group: GroupName.optional(), version: VersionName.optional(),
    namespace: Namespaces.optional(), labelSelector: Selector(500).optional(), fieldSelector: Selector(300).optional(), ...fieldsAndPipe,
  }).strict(),
  z.object({
    kind: z.literal("kube.events"), namespace: Namespaces.optional(), warningsOnly: z.boolean().optional(),
    sinceMinutes: z.number().int().min(1).max(1440).optional(), ...fieldsAndPipe,
  }).strict(),
  z.object({
    kind: z.literal("kube.logs"), namespace: OneNamespace, pod: ObjectName.optional(),
    workload: z.object({ kind: z.enum(["Deployment", "StatefulSet", "DaemonSet", "Job"]), name: ObjectName }).strict().optional(),
    container: ContainerName.optional(), tailLines: z.number().int().min(10).max(VIEW_LIMITS.logLines).optional(), previous: z.boolean().optional(),
  }).strict(),
  z.object({ kind: z.literal("kube.top"), of: z.enum(["pods", "nodes"]), namespace: Namespaces.optional(), ...fieldsAndPipe }).strict(),
  z.object({
    kind: z.literal("metrics.series"), scope: MetricsScope, namespace: OneNamespace.optional(), name: ObjectName.optional(),
    range: MetricsRange, ...fieldsAndPipe,
  }).strict(),
  z.object({ kind: z.literal("doctor.problems"), namespace: Namespaces.optional(), ...fieldsAndPipe }).strict(),
  z.object({ kind: z.literal("helm.releases"), namespace: Namespaces.optional(), ...fieldsAndPipe }).strict(),
]);

// ---- blocks (D206) ------------------------------------------------------------------------------------------------

/** Tags a fragment may not hold (D204): the CSP stops each; refusing them tells Claude instead of failing silently. */
export const REFUSED_TAGS = ["!doctype", "html", "head", "base", "meta", "iframe", "object", "embed", "link", "form"] as const;
// HTML allows no whitespace between `<` (or `</`) and a tag's name: `< iframe>` is text, not a tag. Without the two
// `\s*` the check is linear (security review of wave 10 part 1, M4: `<` and 140,000 spaces took 8 s).
const REFUSED = new RegExp(`</?(${REFUSED_TAGS.join("|")})(?![A-Za-z0-9-])`, "i");
/** One part of an app block's fragment (html, css or js): checked on its own, so its error comes with any other. */
const Fragment = z.string().max(VIEW_LIMITS.appChars).superRefine((s, ctx) => {
  const m = REFUSED.exec(s);
  if (m) ctx.addIssue({ code: "custom", message: SENTENCES.refusedTag(m[1]!.toLowerCase()) });
});

const place = {
  span: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(6), z.literal(12)]).optional(),
  title: Text(80).optional(),
};
const Format = z.enum(["text", "number", "age", "bytes", "cpu", "percent", "status", "ref", "mono"]);
const Column = z.object({
  field: Field, header: Text(80).optional(), format: Format.optional(), width: z.number().int().min(60).max(600).optional(), toneField: Field.optional(),
}).strict();
export const Block = z.discriminatedUnion("type", [
  z.object({ type: z.literal("table"), source: Id, columns: z.array(Column).min(1).max(VIEW_LIMITS.columns), rowActions: z.boolean().optional(), select: z.boolean().optional(), ...place }).strict(),
  z.object({ type: z.literal("stat"), source: Id, field: Field, label: Text(80, { min: 1 }), format: Format.optional(), toneField: Field.optional(), sparkField: Field.optional(), ...place }).strict(),
  z.object({
    type: z.literal("chart"), source: Id, kind: z.enum(["line", "area", "bar"]), x: Field.optional(), y: z.array(Field).min(1).max(6),
    unit: z.enum(["cpu", "bytes", "count", "percent"]).optional(), ...place,
  }).strict(),
  z.object({ type: z.literal("list"), source: Id, primary: Field, secondary: Field.optional(), toneField: Field.optional(), max: z.number().int().min(1).max(200).optional(), ...place }).strict(),
  z.object({ type: z.literal("logs"), source: Id, failuresOnly: z.boolean().optional(), ...place }).strict(),
  z.object({ type: z.literal("problems"), source: Id, ...place }).strict(),
  z.object({ type: z.literal("text"), markdown: Text(8_000, { min: 1, lines: true }), ...place }).strict(),
  z.object({
    type: z.literal("app"), id: Id, uses: z.array(Id).max(8), html: Fragment, css: Fragment.optional(),
    js: Fragment.optional(), fill: z.boolean().optional(), minHeight: z.number().int().min(48).max(2000).optional(), ...place,
  }).strict(),
]);


// ---- the document -------------------------------------------------------------------------------------------------

const DocumentShape = z.object({
  schema: z.literal(VIEW_SCHEMA),
  title: Text(80, { min: 1 }),
  params: z.array(Param).max(6).optional(),
  sources: z.record(Id, Source),
  blocks: z.array(Block),
}).strict();

export type ViewDocument = z.output<typeof DocumentShape>;
export type Source = z.output<typeof Source>;
export type SourceKind = Source["kind"];
export type Block = z.output<typeof Block>;
export type Param = z.output<typeof Param>;
export type Step = StepOut;

/** Whether a kube.list source names `$workload` in a field: it then needs the hidden ReplicaSet and Job watches. */
export const usesWorkload = (s: Source) => (s.kind === "kube.list" || s.kind === "kube.events") && Object.values(s.fields ?? {}).includes("$workload");
/** A Namespaces value as a key (two sources reading the same namespaces share a hidden watch). */
const nsKey = (n: unknown) => JSON.stringify(n ?? "*");

/** The watches and streams a view counts toward its eight sources: its own, and the hidden ones `$workload` adds. */
export function countedSources(sources: Record<string, Source>): number {
  const hidden = new Set<string>();
  for (const s of Object.values(sources)) if (usesWorkload(s)) hidden.add(nsKey((s as { namespace?: unknown }).namespace));
  return Object.keys(sources).length + hidden.size * 2;
}

const KUBE_ROWS: ReadonlySet<SourceKind> = new Set(["kube.list", "kube.events"]);
const ROWLESS: ReadonlySet<SourceKind> = new Set(["kube.logs"]);

export const ViewDocument = DocumentShape.superRefine((d, ctx) => {
  const ids = Object.keys(d.sources);
  const L = VIEW_LIMITS;
  // Counts first, in D222's words.
  const counted = countedSources(d.sources);
  if (ids.length < 1) custom(ctx, ["sources"], "at least 1 source");
  if (counted > L.sources) custom(ctx, ["sources"], SENTENCES.overLimit("sources (with the hidden ones $workload adds)", counted, L.sources));
  if (d.blocks.length < 1) custom(ctx, ["blocks"], "at least 1 block");
  if (d.blocks.length > L.blocks) custom(ctx, ["blocks"], SENTENCES.overLimit("blocks", d.blocks.length, L.blocks));
  const apps = d.blocks.filter((b) => b.type === "app");
  if (apps.length > L.appBlocks) custom(ctx, ["blocks"], SENTENCES.overLimit("app blocks", apps.length, L.appBlocks));
  const logs = ids.filter((id) => d.sources[id]!.kind === "kube.logs");
  if (logs.length > L.logsSources) custom(ctx, ["sources"], SENTENCES.overLimit("kube.logs sources", logs.length, L.logsSources));

  // Parameters: unique, and each reference names one of the right type.
  const params = new Map<string, Param>();
  (d.params ?? []).forEach((p, i) => {
    if (params.has(p.name)) custom(ctx, ["params", i, "name"], "another parameter has this name");
    params.set(p.name, p);
    if (p.type === "choice" && p.default !== undefined && !p.options.includes(p.default)) custom(ctx, ["params", i, "default"], "not one of the options");
  });
  const ref = (v: unknown, path: PropertyKey[], type?: Param["type"]) => {
    if (v === null || typeof v !== "object" || !("param" in v)) return;
    const p = params.get((v as { param: string }).param);
    if (!p) custom(ctx, [...path, "param"], "no such parameter");
    else if (type && p.type !== type) custom(ctx, [...path, "param"], `a ${type} parameter is needed here`);
  };

  for (const id of ids) {
    const s = d.sources[id]!;
    const at: PropertyKey[] = ["sources", id];
    if ("namespace" in s) ref(s.namespace, [...at, "namespace"], "namespace");
    if (s.kind === "kube.logs") {
      if (!!s.pod === !!s.workload) custom(ctx, at, "a kube.logs source names a pod or a workload (one of them)");
    }
    if (s.kind === "kube.top" && s.of === "nodes" && s.namespace !== undefined) custom(ctx, [...at, "namespace"], "nodes have no namespace");
    if (s.kind === "metrics.series") {
      const needsNs = s.scope !== "cluster" && s.scope !== "node";
      const needsName = s.scope !== "cluster" && s.scope !== "namespace";
      if (needsNs && s.namespace === undefined) custom(ctx, [...at, "namespace"], "required");
      if (!needsNs && s.namespace !== undefined) custom(ctx, [...at, "namespace"], `a ${s.scope} series has no namespace`);
      if (needsName && s.name === undefined) custom(ctx, [...at, "name"], "required");
      if (!needsName && s.name !== undefined) custom(ctx, [...at, "name"], `a ${s.scope} series has no name`);
    }
    if (!ROWLESS.has(s.kind) && "fields" in s && s.fields && !KUBE_ROWS.has(s.kind)) {
      for (const [f, p] of Object.entries(s.fields)) if (p.startsWith("$")) custom(ctx, [...at, "fields", f], "computed names read Kubernetes objects: only kube.list and kube.events rows have them");
    }
    // Pipes: parameters in filters, joins to another source of this view.
    const pipe = "pipe" in s ? (s.pipe ?? []) : [];
    pipe.forEach((step, i) => {
      if ("filter" in step) {
        step.filter.forEach((c, j) => {
          const vals = Array.isArray(c.value) ? c.value : c.value !== undefined ? [c.value] : [];
          vals.forEach((v, k) => ref(v, [...at, "pipe", i, "filter", j, "value", ...(Array.isArray(c.value) ? [k] : [])]));
        });
      }
      if ("join" in step) {
        const w = step.join.with;
        if (w === id) custom(ctx, [...at, "pipe", i, "join", "with"], "a source can't join itself");
        else if (!Object.hasOwn(d.sources, w)) custom(ctx, [...at, "pipe", i, "join", "with"], "no such source");
        else if (ROWLESS.has(d.sources[w]!.kind)) custom(ctx, [...at, "pipe", i, "join", "with"], "a kube.logs source has no rows to join");
      }
    });
  }
  // Joins form no cycle (a join's right side is read before the source that joins it).
  const cycle = joinCycle(d.sources);
  if (cycle) custom(ctx, ["sources", cycle[0]!], `these sources join each other in a circle: ${cycle.join(" → ")}`);

  // Blocks: each names a source that exists and is the right kind.
  const appIds = new Set<string>();
  d.blocks.forEach((b, i) => {
    const at: PropertyKey[] = ["blocks", i];
    if (b.type === "text") return;
    if (b.type === "app") {
      if (appIds.has(b.id)) custom(ctx, [...at, "id"], "another app block has this id");
      appIds.add(b.id);
      b.uses.forEach((u, j) => {
        if (!Object.hasOwn(d.sources, u)) custom(ctx, [...at, "uses", j], "no such source");
      });
      const size = b.html.length + (b.css?.length ?? 0) + (b.js?.length ?? 0);
      if (size > L.appChars) custom(ctx, at, SENTENCES.overLimit("characters in this block's html, css and js", size, L.appChars));
      return;
    }
    const src = Object.hasOwn(d.sources, b.source) ? d.sources[b.source] : undefined;
    if (!src) return custom(ctx, [...at, "source"], "no such source");
    if (b.type === "logs" && src.kind !== "kube.logs") return custom(ctx, [...at, "source"], "a logs block needs a kube.logs source");
    if (b.type === "problems" && src.kind !== "doctor.problems") return custom(ctx, [...at, "source"], "a problems block needs a doctor.problems source");
    if (b.type !== "logs" && src.kind === "kube.logs") return custom(ctx, [...at, "source"], "a kube.logs source is shown by a logs block");
    if (b.type === "chart" && src.kind !== "metrics.series" && !b.x) custom(ctx, [...at, "x"], "required (only a metrics.series chart is over time without one)");
  });
});

/** A circle of joins, as source ids, if there is one. */
export function joinCycle(sources: Record<string, Source>): string[] | undefined {
  const edges = new Map<string, string[]>();
  for (const [id, s] of Object.entries(sources)) {
    const pipe = "pipe" in s ? (s.pipe ?? []) : [];
    edges.set(id, pipe.flatMap((st) => ("join" in st && st.join.with !== id && Object.hasOwn(sources, st.join.with) ? [st.join.with] : [])));
  }
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 2) return undefined;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const n of edges.get(id) ?? []) {
      const c = visit(n);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 2);
    return undefined;
  };
  for (const id of edges.keys()) {
    const c = visit(id);
    if (c) return c;
  }
  return undefined;
}

export type Parsed = { ok: true; document: ViewDocument } | { ok: false; issues: Issue[] };

/**
 * Validate a document whole (D206, D222): its JSON at most 400,000 characters, then the schema. A document that
 * can't be written as JSON (a cycle, a BigInt) is refused. At most 20 issues come back.
 */
export function parseDocument(input: unknown): Parsed {
  let json: string;
  try {
    json = JSON.stringify(input) ?? "";
  } catch {
    return { ok: false, issues: [{ pointer: "", message: "the document isn't JSON" }] };
  }
  if (json.length > VIEW_LIMITS.documentChars) {
    return { ok: false, issues: [{ pointer: "", message: SENTENCES.overLimit("characters in the document", json.length, VIEW_LIMITS.documentChars) }] };
  }
  // Parse the JSON text, not the object: what is validated is exactly what can be stored and sent, with no getters,
  // prototypes or undefined left in it.
  const r = ViewDocument.safeParse(JSON.parse(json), { reportInput: true });
  return r.success ? { ok: true, document: r.data } : { ok: false, issues: issuesOf(r.error) };
}

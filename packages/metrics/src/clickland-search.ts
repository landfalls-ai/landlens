// Clickland's history beside the graphs (docs/metrics.md#logs-and-traces, wave 7 part 3, D115–D116): a pod's or a
// workload's log lines, a service's traces and one trace's spans, through the same ClicklandClient (the key only to the
// stored origin, no redirects, 8 s).
//
// Landlens writes every search itself. Names are checked against Kubernetes's own rule and each goes in as a quoted
// term (`k8s.pod.name:"ledger-worker-…"`); the person's filter words go in as one quoted phrase, with `"` and `\`
// escaped, so nothing they type is read as Clickland's search syntax (clickland/libs/query/src/parse.ts). "Errors
// only" is the fixed group `(level:error OR level:fatal OR level:critical)` for logs (SeverityText, matched without
// case: compile.ts) and `status:error` for traces (StatusCode, the same).
//
// What comes back is workload-written. Each answer is checked with zod and capped: at most 500 rows a page, a body
// scrubbed with redactText past the cut and then cut at 8,192 characters (so a line never crosses IPC unscrubbed, nor
// with half a secret), a private key logged row by row blanked, ids hex, times real ISO times, the
// service and severity kept only as short single lines, and of the attributes only k8s.pod.name, k8s.container.name
// and log.iostream. Anything else of the row is dropped; an answer that isn't one is refused whole, in Landlens's words.
import type { ClicklandRange, ClicklandScope, ClRow, ClSpan, ClTrace } from "@landlens/contracts";
import { KEY_REDACTED, scrubCut } from "@landlens/kube/redact";
import { z } from "zod";
import { ClicklandClient, ClicklandError } from "./clickland.js";

export const CL = {
  /** Rows asked for a page of logs (Clickland takes at most 500). */
  page: 200,
  /** The most rows a page may have. */
  maxRows: 500,
  /** Rows the window keeps for one view, paging included. */
  keep: 2000,
  body: 8192,
  /** Span rows read to find a service's last traces, and the traces kept. */
  spanRows: 500,
  traces: 50,
  spans: 500,
  filter: 200,
} as const;

export const CL_RANGE_MS: Record<ClicklandRange, number> = { "1h": 3_600_000, "6h": 6 * 3_600_000, "24h": 24 * 3_600_000, "7d": 7 * 24 * 3_600_000 };

/** A Kubernetes name (DNS subdomain), as the collectors record pods, workloads and namespaces. */
const K8S = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
/** A cluster's name in Clickland (ClicklandClusterName) or a service name: a label value. */
const LABEL_VALUE = /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;

const WORKLOAD_FIELD: Record<ClicklandScope["kind"], string> = {
  pod: "k8s.pod.name",
  deployment: "k8s.deployment.name",
  statefulset: "k8s.statefulset.name",
  daemonset: "k8s.daemonset.name",
};

/** A value as one quoted term of Clickland's language: `"` and `\` escaped, so it can't end the quote. */
export function quoted(v: string): string {
  return `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

function name(v: string, what: string, re = K8S): string {
  if (v.length > 253 || !re.test(v)) throw new ClicklandError("failed", `Not a ${what} Landlens asks Clickland about.`);
  return v;
}

/**
 * "Errors only" for logs: the levels the view marks as failures (security review of part 3, L7). Each is an exact,
 * case-blind match on SeverityText (compile.ts), so a FATAL crash line isn't left out.
 */
export const ERRORS_TERM = "(level:error OR level:fatal OR level:critical)";

/** The search for a scope's log lines (D115). */
export function logsQuery(cluster: string, scope: ClicklandScope, opts: { filter?: string; errors?: boolean } = {}): string {
  const terms = [
    `k8s.cluster.name:${quoted(name(cluster, "cluster name", LABEL_VALUE))}`,
    `k8s.namespace.name:${quoted(name(scope.namespace, "namespace"))}`,
    `${WORKLOAD_FIELD[scope.kind]}:${quoted(name(scope.name, "name"))}`,
  ];
  if (scope.container) terms.push(`k8s.container.name:${quoted(name(scope.container, "container"))}`);
  if (opts.errors) terms.push(ERRORS_TERM);
  const words = (opts.filter ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, CL.filter);
  if (words) terms.push(quoted(words));
  return terms.join(" ");
}

/** The search for a service's spans (D115): the service as its collector names it, errors when asked. */
export function tracesQuery(service: string, errors?: boolean): string {
  return `service:${quoted(name(service, "service", LABEL_VALUE))}${errors ? " status:error" : ""}`;
}

/** Clickland's console search for the same thing (D118), as `/search?…`; the caller puts the console's origin first. */
export function consolePath(signal: "logs" | "traces", query: string, range: ClicklandRange, now = Date.now()): string {
  const q = new URLSearchParams({ signal, query, from: new Date(now - CL_RANGE_MS[range]).toISOString(), to: new Date(now).toISOString() });
  return `/search?${q}`;
}

// ---- What Landlens keeps of an answer -------------------------------------------------------------------------

// A time that matches the pattern but isn't one (month 13) would throw in toISOString: refused as not a time (L2).
const ISO = z.string().max(40).regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/, "not a time").refine((v) => Number.isFinite(Date.parse(v)), "not a time");
const Cursor = z.string().regex(/^\d{1,20}$/);
const Attrs = z.record(z.string(), z.unknown()).optional();
const LogRowIn = z.object({
  cursor: Cursor,
  timestamp: ISO,
  service: z.string(),
  severity: z.string(),
  body: z.string(),
  attributes: Attrs,
  resource: Attrs,
});
const SpanRowIn = z.object({
  timestamp: ISO,
  service: z.string(),
  name: z.string(),
  kind: z.string().optional(),
  durationMs: z.number().finite().min(0),
  status: z.string(),
  traceId: z.string().regex(/^[0-9a-fA-F]{1,64}$/),
  spanId: z.string().regex(/^[0-9a-fA-F]{0,32}$/),
  parentSpanId: z.string().regex(/^[0-9a-fA-F]{0,32}$/),
  attributes: Attrs,
  resource: Attrs,
});
const SearchIn = z.object({ rows: z.array(z.unknown()).max(CL.maxRows), nextCursor: Cursor.nullable().optional() });
const TraceIn = z.object({
  spans: z.array(SpanRowIn.extend({ depth: z.number().int().min(0).max(10_000), offsetMs: z.number().finite() })).max(10_000),
  durationMs: z.number().finite().min(0),
});

/** A short single line (no control or format characters), else nothing. */
function short(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(v) ? v : undefined;
}
const k8sName = (v: unknown) => (typeof v === "string" && v.length <= 253 && K8S.test(v) ? v : undefined);
const attr = (r: { attributes?: Record<string, unknown> | undefined; resource?: Record<string, unknown> | undefined }, k: string) =>
  r.resource && Object.hasOwn(r.resource, k) ? r.resource[k] : r.attributes && Object.hasOwn(r.attributes, k) ? r.attributes[k] : undefined;

/**
 * Workload-written text as it may cross: one trailing newline off, scrubbed past the cut and then cut (security review
 * of part 3, M1: a secret across the cut is taken whole, a private key the cut leaves open is taken to the end).
 * `opened`: the text ends inside a private key.
 */
function scrub(text: string, max: number): { text: string; cut: boolean; opened: boolean } {
  return scrubCut(text.replace(/\r?\n$/, ""), max);
}

/** Rows after a private key's head, in one pod's and container's stream, blanked until its end (at most 100: L9). */
const KEY_ROWS = 100;
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;

const notLogs = () => new ClicklandError("failed", "Clickland's answer didn't look like log lines, so Landlens didn't use it.");
const notTraces = () => new ClicklandError("failed", "Clickland's answer didn't look like traces, so Landlens didn't use it.");

/** A page of log rows, newest first as Clickland answers, checked and reduced (D116). */
export function parseLogRows(raw: unknown): { rows: ClRow[]; next?: string; cut: boolean } {
  const page = SearchIn.safeParse(raw);
  if (!page.success) throw notLogs();
  const parsed = page.data.rows.map((x) => {
    const r = LogRowIn.safeParse(x);
    if (!r.success) throw notLogs();
    return r.data;
  });
  // A key logged line by line (L9): each row alone has only a head, base64, or an end, so oldest first, per pod and
  // container, the rows after an unclosed head are blanked up to and with its end (at most 100 rows).
  const bodies: { text: string; cut: boolean }[] = new Array(parsed.length);
  const open = new Map<string, number>();
  for (let i = parsed.length - 1; i >= 0; i--) {
    const r = parsed[i]!;
    const stream = `${String(attr(r, "k8s.pod.name") ?? "")}/${String(attr(r, "k8s.container.name") ?? "")}`;
    const left = open.get(stream);
    if (left !== undefined) {
      const ended = KEY_END.test(r.body);
      const s = ended ? scrub(r.body, CL.body) : { text: KEY_REDACTED, cut: false, opened: true };
      bodies[i] = { text: ended ? s.text : KEY_REDACTED, cut: s.cut };
      if (ended ? s.opened : left > 1) open.set(stream, ended ? KEY_ROWS : left - 1);
      else open.delete(stream);
      continue;
    }
    const s = scrub(r.body, CL.body);
    bodies[i] = { text: s.text, cut: s.cut };
    if (s.opened) open.set(stream, KEY_ROWS);
  }
  let cut = false;
  const rows = parsed.map((r, i): ClRow => {
    const body = bodies[i]!;
    if (body.cut) cut = true;
    const stream = attr(r, "log.iostream");
    const pod = k8sName(attr(r, "k8s.pod.name"));
    const container = k8sName(attr(r, "k8s.container.name"));
    const severity = short(r.severity, 16);
    const service = short(r.service, 100);
    return {
      at: new Date(r.timestamp).toISOString(),
      body: body.text,
      ...(severity ? { severity } : {}),
      ...(service ? { service } : {}),
      ...(pod ? { pod } : {}),
      ...(container ? { container } : {}),
      ...(stream === "stdout" || stream === "stderr" ? { stream } : {}),
      ...(body.cut ? { cut: true as const } : {}),
    };
  });
  const next = page.data.nextCursor ?? undefined;
  return { rows, ...(next ? { next } : {}), cut };
}

const isError = (status: string) => status.toLowerCase() === "error" || status === "STATUS_CODE_ERROR";
// Scrubbed before the cut at 200, as a body is (M1).
const spanName = (v: string) => short(scrubCut(v.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " "), 200).text, 200) ?? "(no name)";

/** Where the window's object is: its cluster's name in Clickland and its namespace (M3). */
export type TraceWhere = { cluster: string; namespace: string };

/**
 * A service's last traces from a page of its spans (newest first): one entry per trace, in that order, at most 50.
 * Its name and duration are the trace's top span of this service (no parent among them), its time the earliest.
 *
 * The search is by service name alone (D115), so a span that names its cluster or namespace (the resource's
 * k8s.cluster.name, k8s.namespace.name) and names another is dropped, and its trace isn't listed (security review of
 * part 3, M3). `scoped` is true only when every span kept named both: else the list is by service name, in any
 * cluster, and the window says so.
 */
export function parseTraceList(raw: unknown, service: string, where?: TraceWhere): { traces: ClTrace[]; scoped: boolean } {
  const page = SearchIn.safeParse(raw);
  if (!page.success) throw notTraces();
  const byTrace = new Map<string, z.infer<typeof SpanRowIn>[]>();
  let scoped = true;
  let kept = 0;
  for (const x of page.data.rows) {
    const r = SpanRowIn.safeParse(x);
    if (!r.success) throw notTraces();
    const cluster = attr(r.data, "k8s.cluster.name");
    const namespace = attr(r.data, "k8s.namespace.name");
    if (where && cluster !== undefined && cluster !== where.cluster) continue;
    if (where && namespace !== undefined && namespace !== where.namespace) continue;
    kept++;
    if (!where || cluster === undefined || namespace === undefined) scoped = false;
    const id = r.data.traceId.toLowerCase();
    const list = byTrace.get(id);
    if (list) list.push(r.data);
    else if (byTrace.size < CL.traces) byTrace.set(id, [r.data]);
  }
  const traces = [...byTrace].map(([id, spans]) => {
    const ids = new Set(spans.map((s) => s.spanId));
    const tops = spans.filter((s) => !s.parentSpanId || !ids.has(s.parentSpanId));
    const top = tops.reduce((a, b) => (b.durationMs > a.durationMs ? b : a), tops[0] ?? spans[0]!);
    const at = spans.map((s) => Date.parse(s.timestamp)).reduce((a, b) => Math.min(a, b));
    return { id, name: spanName(top.name), service, at: new Date(at).toISOString(), ms: top.durationMs, error: spans.some((s) => isError(s.status)) };
  });
  return { traces, scoped: scoped && kept > 0 };
}

/** One trace's spans as Clickland ordered them (depth first), at most 500 (`cut` past that). */
export function parseTrace(raw: unknown): { spans: ClSpan[]; ms: number; cut: boolean } {
  const t = TraceIn.safeParse(raw);
  if (!t.success) throw notTraces();
  const spans = t.data.spans.slice(0, CL.spans).map((s): ClSpan => {
    const service = short(s.service, 100) ?? "(unknown)";
    const kind = short(s.kind, 16);
    return {
      id: s.spanId.toLowerCase(),
      name: spanName(s.name),
      service,
      ...(kind ? { kind } : {}),
      depth: Math.min(s.depth, 64),
      offsetMs: Math.max(0, s.offsetMs),
      ms: s.durationMs,
      error: isError(s.status),
    };
  });
  return { spans, ms: t.data.durationMs, cut: t.data.spans.length > CL.spans };
}

/** The three reads, each its search built here and its answer checked. */
export class ClicklandSearch {
  constructor(private readonly client: ClicklandClient, private readonly now: () => number = Date.now) {}

  /** The range's start and now; `since` (a time in ms) starts it later, never earlier. */
  private bounds(range: ClicklandRange, since?: number) {
    const to = this.now();
    const from = Math.max(to - CL_RANGE_MS[range], since !== undefined && Number.isFinite(since) ? Math.min(since, to) : -Infinity);
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  }

  async logs(cluster: string, scope: ClicklandScope, range: ClicklandRange, opts: { filter?: string; errors?: boolean; before?: string; limit?: number; since?: number } = {}) {
    if (opts.before !== undefined && !/^\d{1,20}$/.test(opts.before)) throw new ClicklandError("failed", "Not a cursor.");
    const limit = Math.min(Math.max(1, opts.limit ?? CL.page), CL.maxRows);
    const raw = await this.client.search({ signal: "logs", query: logsQuery(cluster, scope, opts), ...this.bounds(range, opts.since), limit, ...(opts.before ? { before: opts.before } : {}) });
    return parseLogRows(raw);
  }

  async traces(service: string, range: ClicklandRange, errors?: boolean, where?: TraceWhere): Promise<{ traces: ClTrace[]; scoped: boolean }> {
    const raw = await this.client.search({ signal: "traces", query: tracesQuery(service, errors), ...this.bounds(range), limit: CL.spanRows });
    return parseTraceList(raw, service, where);
  }

  async trace(id: string) {
    return parseTrace(await this.client.trace(id));
  }
}

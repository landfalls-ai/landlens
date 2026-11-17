// What ties a view's document to one cluster (D216), in one place for main (save, import) and the window's Save sheet
// (security review of wave 10 part 4, L1: the window had its own copy, which missed half the literals). Imports nothing
// with a runtime, so the window can use it (`@landlens/views/literal`).

/** A source as plain JSON: this reads only what it names, whatever else it holds. */
type Loose = Record<string, unknown>;

/** A field selector's terms on an object's own name or namespace (or its node), as `field=value` words. */
const SELECTOR_FIELDS = new Set(["metadata.name", "metadata.namespace", "spec.nodeName"]);

function selectorNames(sel: unknown): string[] {
  if (typeof sel !== "string") return [];
  const out: string[] = [];
  for (const term of sel.split(",")) {
    const m = /^\s*([A-Za-z0-9_.]+)\s*(==|!=|=)\s*(.*?)\s*$/.exec(term);
    if (m && SELECTOR_FIELDS.has(m[1]!) && m[3]) out.push(`${m[1]} ${m[2] === "!=" ? "not " : ""}${m[3]}`);
  }
  return out;
}

/**
 * What ties a document to one cluster (D216): a source naming a literal namespace or an object, in any of the places a
 * source can name one: its namespace (or namespaces), a pod, a workload, a series' object, a field selector on an
 * object's name, namespace or node, a GKE cluster (gcp.metrics, gcp.alerts and gcp.recommendations name one by its
 * context), and every argument of a tool source (a tool doesn't know which cluster is open, so whatever it is given
 * is literal). A view saved for "Any cluster" may have none, so it can't read the same names on another cluster by
 * surprise; a parameter is fine.
 */
export function literalNames(document: { sources?: Record<string, unknown> } | undefined): { source: string; what: string }[] {
  const out: { source: string; what: string }[] = [];
  for (const [id, raw] of Object.entries(document?.sources ?? {})) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Loose;
    const add = (what: string) => out.push({ source: id, what });
    if (typeof s.namespace === "string" && s.namespace !== "*") add(`namespace ${s.namespace}`);
    if (Array.isArray(s.namespace)) for (const n of s.namespace) if (typeof n === "string") add(`namespace ${n}`);
    if (typeof s.pod === "string") add(`pod ${s.pod}`);
    const w = s.workload as { kind?: unknown; name?: unknown } | undefined;
    if (w && typeof w === "object" && typeof w.name === "string") add(`${typeof w.kind === "string" ? w.kind : "workload"} ${w.name}`);
    if ((s.kind === "metrics.series" || s.kind === "gcp.metrics") && typeof s.name === "string") add(`${String(s.scope)} ${s.name}`);
    for (const t of selectorNames(s.fieldSelector)) add(t);
    if (typeof s.kind === "string" && s.kind.startsWith("gcp.") && typeof s.cluster === "string") add(`cluster ${s.cluster}`);
    if (s.kind === "tool" && s.arguments && typeof s.arguments === "object") {
      for (const [k, v] of Object.entries(s.arguments as Loose)) add(`${String(s.server)} · ${String(s.tool)} argument ${k}=${JSON.stringify(v)}`);
    }
  }
  return out;
}

/** The words for the Save sheet and main's refusal: each literal once. */
export const literalWords = (document: { sources?: Record<string, unknown> } | undefined): string[] => [...new Set(literalNames(document).map((l) => l.what))];

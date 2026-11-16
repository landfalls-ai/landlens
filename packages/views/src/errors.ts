// D222: everything Claude or the person sees of a view's errors is a fixed sentence, plus, for a schema error, the
// JSON Pointer of the place in Claude's own input. Zod's issues are mapped by their code to words of ours: zod's own
// text never reaches anyone, and nothing from the cluster is in any of these (names in them are checked names).
import type { z } from "zod";
import { cellText } from "./text.js";

export const SENTENCES = {
  noSuchField: "no such field",
  unknownKind: (resource: string, group?: string) => `This cluster has no ${resource}${group ? `.${group}` : ""}.`,
  secrets: "Views can't read Secrets.",
  scope: (namespace: string, limit: readonly string[]) => `This view can't read namespace ${namespace}: its session is limited to ${limit.join(", ")}.`,
  /** Not in the spec's table: a cluster-wide read (cluster or node metrics, nodes' usage) in a namespace-limited view. */
  scopeCluster: (limit: readonly string[]) => `This view can't read the whole cluster: its session is limited to ${limit.join(", ")}.`,
  rbac: (resource: string) => `You can't list ${resource} here (your cluster access).`,
  connectionOff: (name: string) => `${name} isn't readable by Claude right now. Turn it on in Connections.`,
  toolNotFree: (server: string, tool: string) => `${server} · ${tool} isn't a read that runs without asking.`,
  overLimit: (things: string, n: number, m: number) => `Too many ${things}: ${n}, the limit is ${m}.`,
  failed: (source: string, status: number) => `${source} couldn't be read (HTTP ${status}).`,
  noAnswer: "The cluster didn't answer.",
  /** Shown after its pointer, as every schema issue is: `<pointer>: a block's html can't contain <tag>.` */
  refusedTag: (tag: string) => `a block's html can't contain <${tag}>.`,
  stale: (version: number) => `The view is at v${version}; read it with get_view and patch that.`,
  // The runtime's own (part 1), in the same voice.
  noMetricsServer: "This cluster has no metrics-server, so there's no usage now.",
  watchCut: (n: number) => `Only the first ${n.toLocaleString("en-US")} of more objects are read.`,
  rowsCut: (shown: number, total: number) => `The first ${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} rows are shown.`,
  logGone: "This pod's log can't be read now (the pod or its container is gone).",
  logNoPods: "No pods of this workload are running.",
  logPodsCut: (n: number, total: number) => `Following ${n} of this workload's ${total} pods.`,
  logOlder: "Older lines aren't kept.",
  helmUnreadable: (n: number) => `${n} ${n === 1 ? "release" : "releases"} couldn't be read.`,
  doctorOff: "Landlens's own check isn't running for this cluster.",
  metricsOff: "Usage over time isn't available here.",
  helmOff: "Helm's releases aren't read here.",
  notReadable: "This view's sources stopped: open it again.",
  joinMissing: (source: string) => `${source} isn't read yet or couldn't be read, so what this source joins from it is missing.`,
  joinCut: (source: string) => `${source} was cut, so what this source joins from it may be missing.`,
  // Security review of wave 10 part 1 (M3, M5).
  joinTooBig: (source: string) => `Joining ${source} here is too much work to do live: filter or limit either side first.`,
  viewCut: "This view keeps too many objects in all, so some are left out: read fewer kinds or namespaces.",
  computeFailed: "Landlens couldn't work out this source's rows.",
  rowsTooBig: (shown: number) => `Only the first ${shown.toLocaleString("en-US")} rows fit: this source's rows hold too much text.`,
} as const;

export type Issue = { pointer: string; message: string };

/** At most 20 issues go back (D222). */
export const MAX_ISSUES = 20;

/** A JSON Pointer from a zod path: `~` and `/` escaped; a key is cleaned and cut, as it is Claude's input. */
export function pointer(path: readonly PropertyKey[]): string {
  return path.map((p) => `/${typeof p === "number" ? p : cellText(String(p), 64).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

const TYPE_WORDS: Record<string, string> = {
  string: "text", number: "a number", int: "a whole number", boolean: "true or false", object: "an object", array: "a list",
  record: "an object",
};

/** One zod issue as D222's words. Our own schema messages (custom checks, formats) are fixed strings of ours. */
export function issueWords(issue: z.core.$ZodIssue): Issue[] {
  const at = pointer(issue.path);
  switch (issue.code) {
    case "unrecognized_keys":
      return issue.keys.map((k) => ({ pointer: `${at}/${pointer([k]).slice(1)}`, message: SENTENCES.noSuchField }));
    case "invalid_type":
      return [{ pointer: at, message: issue.input === undefined ? "required" : `expected ${TYPE_WORDS[issue.expected] ?? issue.expected}` }];
    case "too_big":
      return [{ pointer: at, message: `at most ${String(issue.maximum)}${unit(issue.origin)}` }];
    case "too_small":
      return [{ pointer: at, message: `at least ${String(issue.minimum)}${unit(issue.origin)}` }];
    case "invalid_value":
      return [{ pointer: at, message: `expected ${issue.values.map((v) => JSON.stringify(v)).join(" or ")}` }];
    case "invalid_union": {
      const d = (issue as { discriminator?: string }).discriminator;
      // Zod already ends the path at the discriminator; older shapes didn't.
      const where = d && issue.path[issue.path.length - 1] !== d ? `${at}/${d}` : at;
      return [{ pointer: where, message: d ? `not a known ${d}` : "doesn't match any allowed shape" }];
    }
    case "invalid_key":
      return [{ pointer: at, message: "not a valid name here" }];
    case "invalid_format":
    case "custom":
      return [{ pointer: at, message: issue.message }];
    default:
      return [{ pointer: at, message: "not valid here" }];
  }
}

function unit(origin: string | undefined): string {
  return origin === "string" ? " characters" : origin === "array" || origin === "set" ? " items" : origin === "object" || origin === "record" || origin === "map" ? " entries" : "";
}

/** Zod's issues as at most MAX_ISSUES of ours, each `<pointer>: <message>` when shown. */
export function issuesOf(error: z.ZodError): Issue[] {
  return error.issues.flatMap(issueWords).slice(0, MAX_ISSUES);
}

export const issueLine = (i: Issue) => (i.pointer ? `${i.pointer}: ${i.message}` : i.message);

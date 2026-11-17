// What a custom block may ask Landlens for (D219, wave 10 part 3), as `ui/open-link` addresses under `landlens://`.
// One strict parser, used by the window's host (app-host.ts) before anything reaches main and by main (views.ts) again
// before anything is shown. Imports nothing with a runtime, so the window can use it.
//
//   landlens://object/<Kind>/<ns|_>/<name>            open the object (its drawer over the view)
//   landlens://logs/<Kind>/<ns|_>/<name>              open its logs in the panel (pods and the workloads that have them)
//   landlens://ask/<Kind>/<ns|_>/<name>               put it on the view's composer as a chip; sends nothing
//   landlens://select/<Kind>(/<ns|_>/<name>){1,50}    choose rows of one kind (the selection bar, no Delete)
//   landlens://action/<verb>/<Kind>/<ns|_>/<name>     open the action's sheet: scale, restart, trigger, suspend, resume,
//                                                     cordon, uncordon. Never delete or drain.
//
// Anything else, an extra or missing segment, a character outside the patterns, a bad escape or a name that isn't a
// Kubernetes name after decoding, is refused (undefined). Main then looks each target up among the block's own rows.
import { FRAME_VERBS, type FrameVerb } from "@landlens/contracts";

export type IntentTarget = { kind: string; namespace?: string; name: string };
export type ParsedIntent = { kind: "object" | "logs" | "ask" | "select" | "action"; verb?: FrameVerb; targets: IntentTarget[] };

/** The most objects one select may name (wave 8's bulk limit, D141). */
export const SELECT_MAX = 50;
/** Kinds whose logs Landlens follows (LogsView's logSourceOf): a pod, or a workload with a selector. */
export const LOG_KINDS: ReadonlySet<string> = new Set(["Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"]);

const KIND = /^[A-Za-z][A-Za-z0-9]{0,62}$/;
const NAMESPACE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const NAME = /^[a-z0-9]([a-z0-9.:-]{0,251}[a-z0-9])?$/;
/** One segment as it travels: what encodeURIComponent makes of a Kubernetes name (`:` as `%3A`). */
const SEGMENT = /^[A-Za-z0-9._:%-]{1,760}$/;
const VERBS: ReadonlySet<string> = new Set(FRAME_VERBS);

function decode(s: string): string | undefined {
  if (!SEGMENT.test(s)) return undefined;
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}

function target(kind: string, ns: string, name: string): IntentTarget | undefined {
  const n = decode(ns);
  const m = decode(name);
  if (n === undefined || m === undefined) return undefined;
  if (n !== "_" && !NAMESPACE.test(n)) return undefined;
  if (!NAME.test(m)) return undefined;
  return { kind, name: m, ...(n !== "_" ? { namespace: n } : {}) };
}

/** A `landlens://` intent from a frame, or undefined for anything not in the allowlist. */
export function parseIntent(url: unknown): ParsedIntent | undefined {
  if (typeof url !== "string" || url.length > 2_000 || !url.startsWith("landlens://")) return undefined;
  const parts = url.slice("landlens://".length).split("/");
  const what = parts.shift();
  let verb: FrameVerb | undefined;
  if (what === "action") {
    const v = parts.shift() ?? "";
    if (!VERBS.has(v)) return undefined;
    verb = v as FrameVerb;
  }
  const kind = decode(parts.shift() ?? "");
  if (!kind || !KIND.test(kind)) return undefined;
  switch (what) {
    case "object":
    case "logs":
    case "ask":
    case "action": {
      if (parts.length !== 2) return undefined;
      if (what === "logs" && !LOG_KINDS.has(kind)) return undefined;
      const t = target(kind, parts[0]!, parts[1]!);
      return t ? { kind: what, ...(verb ? { verb } : {}), targets: [t] } : undefined;
    }
    case "select": {
      if (parts.length < 2 || parts.length % 2 || parts.length / 2 > SELECT_MAX) return undefined;
      const targets: IntentTarget[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < parts.length; i += 2) {
        const t = target(kind, parts[i]!, parts[i + 1]!);
        if (!t) return undefined;
        const k = `${t.namespace ?? ""}/${t.name}`;
        if (!seen.has(k)) (seen.add(k), targets.push(t));
      }
      return { kind: "select", targets };
    }
    default:
      return undefined;
  }
}

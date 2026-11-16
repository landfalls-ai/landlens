// What a view keeps of each object it watches (security review of wave 10 part 1, M5): only what its document reads.
// A watch kept whole objects (a ConfigMap can be 1 MB) although a source reads at most 24 fields; now each object is
// trimmed, as it arrives, to the metadata a row and its `_ref` need, what the computed names read (every row's `_tone`
// included), and what each field path of the sources on that watch reads. Reading a trimmed object gives the
// same cell as reading the whole one (projection.test.ts holds that for every computed name and path).
import type { ParsedPath } from "./path.js";

/** `true`: keep the value whole. An object: keep these keys of it (of each element, for a list). */
export type Keep = true | { readonly [key: string]: Keep };

const CONTAINER: Keep = { name: true, image: true, resources: true };
const CONTAINER_STATUS: Keep = {
  name: true, ready: true, restartCount: true,
  state: { running: true, waiting: { reason: true }, terminated: { reason: true, exitCode: true, signal: true } },
};

/** What every row reads: its name and `_ref`, `$workload`'s owners, and each computed name (kubectl's words). */
export const BASE_KEEP: Keep = {
  apiVersion: true,
  kind: true,
  metadata: {
    name: true, namespace: true, uid: true, resourceVersion: true, labels: true, ownerReferences: true,
    creationTimestamp: true, deletionTimestamp: true,
  },
  spec: {
    replicas: true, suspend: true, unschedulable: true, nodeName: true, selector: true,
    containers: CONTAINER, initContainers: { name: true },
    template: { spec: { containers: CONTAINER } },
    jobTemplate: { spec: { template: { spec: { containers: CONTAINER } } } },
  },
  status: {
    phase: true, reason: true, conditions: { type: true, status: true },
    containerStatuses: CONTAINER_STATUS, initContainerStatuses: CONTAINER_STATUS,
    readyReplicas: true, numberReady: true, desiredNumberScheduled: true,
  },
  // An Event's: `$status`, `$object`, `$last`.
  type: true,
  involvedObject: { kind: true, name: true, namespace: true },
  lastTimestamp: true, eventTime: true, series: { lastObservedTime: true }, firstTimestamp: true,
};

/** Two Keeps as one: whatever either keeps. */
export function mergeKeep(a: Keep, b: Keep): Keep {
  if (a === true || b === true) return true;
  const out: Record<string, Keep> = {};
  for (const k of Object.keys(a)) out[k] = a[k]!;
  for (const k of Object.keys(b)) out[k] = Object.hasOwn(out, k) ? mergeKeep(out[k]!, b[k]!) : b[k]!;
  return out;
}

/**
 * BASE_KEEP and, for each path, what it reads: its names in order, `[n]` and `[*]` passed through (project keeps a
 * list's elements each by the same Keep), the value at its end kept whole.
 */
export function keepFor(fields: readonly (readonly [string, ParsedPath])[]): Keep {
  let keep = BASE_KEEP;
  for (const [, p] of fields) {
    if ("computed" in p) continue;
    const names = p.segments.flatMap((s) => ("key" in s ? [s.key] : []));
    // A path that starts with an index reads nothing of an object: nothing to keep for it.
    if (!names.length) continue;
    let k: Keep = true;
    for (let i = names.length - 1; i >= 0; i--) k = { [names[i]!]: k };
    keep = mergeKeep(keep, k);
  }
  return keep;
}

/** A stable text of a Keep (keys sorted): two watches of one target share only when they keep the same. */
export function keepKey(k: Keep): string {
  if (k === true) return "1";
  return `{${Object.keys(k).sort().map((n) => `${JSON.stringify(n)}:${keepKey(k[n]!)}`).join(",")}}`;
}

/** The object trimmed to `keep`: own properties only; a list's elements each trimmed; a scalar kept as it is. */
export function project<T>(v: T, keep: Keep): T {
  if (keep === true || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => project(x, keep)) as T;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(keep)) if (Object.hasOwn(v, k)) out[k] = project((v as Record<string, unknown>)[k], keep[k]!);
  return out as T;
}

// The YAML an edit works on, and the patch it sends: pure, so the renderer uses it too (to rebase your edit when
// someone else changes the object while you edit).
import { stringify } from "yaml";

/** Fields the editor never shows, and so never sends: server bookkeeping and status. */
const HIDDEN_META = ["managedFields", "resourceVersion", "uid", "creationTimestamp", "generation", "selfLink"];
const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";

/** The object as the editor shows it: no status, no bookkeeping, no last-applied annotation. */
export function editable(o: any): any {
  const c = structuredClone(o);
  delete c.status;
  for (const k of HIDDEN_META) delete c.metadata?.[k];
  if (c.metadata?.annotations) {
    delete c.metadata.annotations[LAST_APPLIED];
    if (!Object.keys(c.metadata.annotations).length) delete c.metadata.annotations;
  }
  // apiVersion, kind and metadata first, as people write them; the rest in the server's order.
  const { apiVersion, kind, metadata, ...rest } = c;
  return { ...(apiVersion !== undefined ? { apiVersion } : {}), ...(kind !== undefined ? { kind } : {}), ...(metadata !== undefined ? { metadata } : {}), ...rest };
}

export function editableYaml(o: any): string {
  return stringify(editable(o), { lineWidth: 0 });
}

export const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
/** Set an own key, even `__proto__`, which plain assignment would treat as the prototype. */
const put = (o: Record<string, unknown>, k: string, v: unknown) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

/** RFC 7386: what turns `a` into `b`. Removed keys are null; anything but a map is replaced whole. */
export function mergePatch(a: unknown, b: unknown): unknown {
  if (!isObj(a) || !isObj(b)) return b;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(a)) if (!has(b, k)) put(out, k, null);
  for (const [k, v] of Object.entries(b)) {
    if (!has(a, k)) put(out, k, v);
    else if (!same(a[k], v)) put(out, k, isObj(a[k]) && isObj(v) ? mergePatch(a[k], v) : v);
  }
  return out;
}

/** The paths a merge patch touches, as ["spec", "replicas"]. A replaced list is one path. */
export function patchPaths(p: unknown, at: string[] = []): string[][] {
  if (!isObj(p)) return [at];
  return Object.entries(p).flatMap(([k, v]) => (isObj(v) && Object.keys(v).length ? patchPaths(v, [...at, k]) : [[...at, k]]));
}

/** RFC 7386 applied: `patch` onto `target`. */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isObj(patch)) return patch;
  const out: Record<string, unknown> = isObj(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else put(out, k, applyMergePatch(has(out, k) ? out[k] : undefined, v));
  }
  return out;
}

/** Paths both lists touch, where one is the other or inside it: "spec.replicas". */
export function overlaps(a: string[][], b: string[][]): string[] {
  const inside = (x: string[], y: string[]) => x.length <= y.length && x.every((k, i) => y[i] === k);
  return [...new Set(a.filter((x) => b.some((y) => inside(x, y) || inside(y, x))).map((x) => x.join(".")))];
}

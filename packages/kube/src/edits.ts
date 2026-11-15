// Your edits (wave 4, part 2): YAML you change in the drawer, or objects you create from YAML. Like the agent's
// changes, nothing reaches the cluster without a dry run you have seen: Review dry-runs the exact request and shows
// the live object against the dry run's result; Apply sends that same request, which carries the version you
// started from, so a change someone made meanwhile is refused instead of overwritten.
//
// An edit sends only what you changed: a JSON merge patch from the YAML you started with to the YAML you ended with
// (a removed field is a null, a changed list is sent whole). Fields you didn't touch are left to whoever owns them.
// Requests go through the front door with a token issued for the edit ("you · <context> · edit"), so they are in the
// audit trail as yours.
import { randomBytes } from "node:crypto";
import type { ChangeOperation, EditProblem, EditOwner, EditReview } from "@landlens/contracts";
import { isMap, isSeq, LineCounter, parseAllDocuments, parseDocument, stringify, type Document } from "yaml";
export { applyMergePatch, editable, editableYaml, mergePatch, overlaps, patchPaths } from "./edit-yaml.js";
import { apiPath, toKubeError } from "./client.js";
import { clean, risks, type ChangeTarget, type Send } from "./changes.js";
import { editable, isObj, mergePatch, patchPaths } from "./edit-yaml.js";
import { diffLines } from "./diff.js";

export const EDIT_FIELD_MANAGER = "landlens";
export const EDIT_TTL_MS = 15 * 60_000;
export const MAX_DOCUMENTS = 10;
const MAX_YAML = 512 * 1024;

/**
 * Who else manages a path you changed, from managedFields (fieldsV1): "spec.replicas is managed by
 * kube-controller-manager". Landlens's own manager and kubectl's client-side ones aren't counted.
 */
export function ownersOf(current: any, paths: string[][]): { path: string; manager: string }[] {
  const out: { path: string; manager: string }[] = [];
  for (const m of current?.metadata?.managedFields ?? []) {
    const manager = String(m.manager ?? "");
    if (!manager || manager === EDIT_FIELD_MANAGER || manager === "landlens-agent" || manager.startsWith("kubectl") || manager === "before-first-apply") continue;
    for (const p of paths) {
      if (p[0] === "metadata") continue;
      let node: any = m.fieldsV1;
      let owned = !!node;
      for (const k of p) {
        node = node?.[`f:${k}`];
        if (node === undefined) {
          owned = false;
          break;
        }
      }
      if (owned && !out.some((o) => o.path === p.join(".") && o.manager === manager)) out.push({ path: p.join("."), manager });
    }
  }
  return out;
}

/** The 1-based line of a field path ("spec.template.spec.containers[0].image") in a YAML text, if it is there. */
export function lineOf(text: string, field: string, doc = 0): number | undefined {
  const lc = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter: lc });
  const d = (Array.isArray(docs) ? docs : [docs])[doc] as Document | undefined;
  if (!d) return undefined;
  const parts = field.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  // Walk as far as the path goes (a field the server names but the text lacks marks its parent), and answer the
  // key's line for a map entry, the item's for a list entry.
  let node: any = d.contents;
  let at: any;
  for (const p of parts) {
    if (isMap(node)) {
      const pair = node.items.find((i: any) => String(i.key?.value ?? i.key) === p);
      if (!pair) break;
      at = pair.key;
      node = pair.value;
    } else if (isSeq(node) && /^\d+$/.test(p)) {
      const item = node.items[Number(p)];
      if (!item) break;
      at = item;
      node = item;
    } else break;
  }
  const range = at?.range ?? node?.range;
  return range ? lc.linePos(range[0]).line : undefined;
}

/** A YAML text's syntax errors, with lines. */
export function yamlProblems(text: string): EditProblem[] {
  const lc = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter: lc });
  const all = Array.isArray(docs) ? docs : [docs];
  return all.flatMap((d: any) => (d.errors ?? []).map((e: any) => ({ message: String(e.message).split("\n")[0]!, line: lc.linePos(e.pos[0]).line })));
}

type Pending = {
  requests: { method: string; path: string; contentType: string; body: string; describe: string }[];
  expires: number;
};

/** What the API server's refusal says, cause by cause, with lines where it names a field. */
export function refusal(status: number, text: string, yaml: string, doc = 0): EditProblem[] {
  try {
    const s = JSON.parse(text) as { message?: string; details?: { causes?: { field?: string; message?: string; reason?: string }[] } };
    const causes = s.details?.causes ?? [];
    if (causes.length) {
      return causes.slice(0, 20).map((c) => {
        const line = c.field ? lineOf(yaml, c.field, doc) : undefined;
        return { message: c.message ?? c.reason ?? "refused", ...(c.field ? { field: c.field } : {}), ...(line ? { line } : {}) };
      });
    }
    return [{ message: s.message ?? `HTTP ${status}` }];
  } catch {
    return [{ message: `HTTP ${status}: ${text.slice(0, 300)}` }];
  }
}

export class EditError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/**
 * Reviews and applies the person's edits. Each review is kept for 15 minutes under its id, holding exactly the
 * requests its dry run sent; Apply sends those, nothing else.
 */
export class EditBroker {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly opts: { now?: () => number; ttlMs?: number } = {}) {}
  private now = () => (this.opts.now ?? Date.now)();

  /** Your change to one object: from the YAML you started with (`original`) to the YAML you ended with. */
  async reviewEdit(send: Send, r: { type: ChangeTarget; namespace?: string; name: string; base: string; original: string; edited: string }): Promise<EditReview> {
    if (r.edited.length > MAX_YAML || r.original.length > MAX_YAML) throw new EditError("the YAML is over 512 KB");
    if (r.type.group === "" && r.type.resource === "secrets") throw new EditError("Secrets are edited outside Landlens for now: their values stay hidden here");
    const syntax = yamlProblems(r.edited);
    if (syntax.length) return { problems: syntax };
    const before = parseDocument(r.original).toJS();
    const after = parseDocument(r.edited).toJS();
    if (!isObj(after)) return { problems: [{ message: "The YAML must be one object", line: 1 }] };
    const problems: EditProblem[] = [];
    const apiVersion = r.type.group ? `${r.type.group}/${r.type.version}` : r.type.version;
    if (after.apiVersion !== apiVersion) problems.push({ message: `apiVersion must stay ${apiVersion}`, field: "apiVersion", ...line(r.edited, "apiVersion") });
    if (after.kind !== r.type.kind) problems.push({ message: `kind must stay ${r.type.kind}`, field: "kind", ...line(r.edited, "kind") });
    if (after.metadata?.name !== r.name) problems.push({ message: "metadata.name can't change: that would be another object", field: "metadata.name", ...line(r.edited, "metadata.name") });
    if ((after.metadata?.namespace ?? r.namespace) !== r.namespace) problems.push({ message: "metadata.namespace can't change", field: "metadata.namespace", ...line(r.edited, "metadata.namespace") });
    if (problems.length) return { problems };

    const objectPath = apiPath(r.type, r.namespace, r.name);
    const got = await send({ method: "GET", path: objectPath });
    if (got.status !== 200) throw toKubeError(got.status, got.text);
    const current = JSON.parse(got.text);
    const patch = mergePatch(editable(before), editable(after)) as Record<string, any>;
    const paths = patchPaths(patch);
    if (!Object.keys(patch).length) return { problems: [{ message: "Nothing changed" }] };
    // The version you started from: if the object has moved on, the API server refuses with a conflict.
    const body = JSON.stringify({ ...patch, metadata: { ...(patch.metadata ?? {}), resourceVersion: r.base } });
    const q = new URLSearchParams({ fieldManager: EDIT_FIELD_MANAGER });
    const dry = new URLSearchParams(q);
    dry.set("dryRun", "All");
    const res = await send({ method: "PATCH", path: `${objectPath}?${dry}`, contentType: "application/merge-patch+json", body });
    if (res.status === 409) return { conflict: true, problems: [{ message: "Someone changed it since you started editing" }] };
    if (res.status < 200 || res.status >= 300) return { problems: refusal(res.status, res.text, r.edited) };
    const result = JSON.parse(res.text);
    const op: ChangeOperation = {
      verb: "patch", kind: r.type.kind, group: r.type.group, ...(r.namespace ? { namespace: r.namespace } : {}), name: r.name,
      diff: diffLines(stringify(clean(current), { lineWidth: 0 }), stringify(clean(result), { lineWidth: 0 })),
      warnings: res.warnings.slice(0, 20),
      risk: risks({ verb: "patch", type: r.type, ...(r.namespace ? { namespace: r.namespace } : {}), name: r.name, body: patch, patchType: "merge" }, current, result),
    };
    const owners: EditOwner[] = ownersOf(current, paths).map((o) => ({ ...o, ...line(r.edited, o.path) }));
    const id = this.keep([{ method: "PATCH", path: `${objectPath}?${q}`, contentType: "application/merge-patch+json", body, describe: `${r.type.kind.toLowerCase()} ${r.namespace ? `${r.namespace}/` : ""}${r.name}` }]);
    return { id, operations: [op], ...(owners.length ? { owners } : {}), changed: paths.map((p) => p.join(".")) };
  }

  /** New objects from YAML (one or more documents), each created in its namespace (or `namespace`). */
  async reviewCreate(send: Send, r: { yaml: string; namespace?: string; types: ChangeTarget[] }): Promise<EditReview> {
    if (r.yaml.length > MAX_YAML) throw new EditError("the YAML is over 512 KB");
    const syntax = yamlProblems(r.yaml);
    if (syntax.length) return { problems: syntax };
    const docs = parseAllDocuments(r.yaml);
    // Keep each object's document index, so problems mark lines in the right document.
    const objs = (Array.isArray(docs) ? docs : [docs]).map((d: any, doc) => ({ o: d.toJS(), doc })).filter((x) => x.o !== null && x.o !== undefined);
    if (!objs.length) return { problems: [{ message: "Write an object first", line: 1 }] };
    if (objs.length > MAX_DOCUMENTS) return { problems: [{ message: `At most ${MAX_DOCUMENTS} objects at once` }] };
    const problems: EditProblem[] = [];
    const ops: ChangeOperation[] = [];
    const requests: Pending["requests"] = [];
    for (const [i, { o, doc }] of objs.entries()) {
      const where = (field: string) => line(r.yaml, field, doc);
      if (!isObj(o) || typeof o.apiVersion !== "string" || typeof o.kind !== "string") {
        problems.push({ message: `Object ${i + 1} needs apiVersion and kind`, ...where("kind") });
        continue;
      }
      const [group, version] = o.apiVersion.includes("/") ? o.apiVersion.split("/") as [string, string] : ["", o.apiVersion];
      const type = r.types.find((t) => t.group === group && t.version === version && t.kind === o.kind);
      if (!type) {
        problems.push({ message: `This cluster doesn't serve ${o.apiVersion} ${o.kind}`, field: "kind", ...where("kind") });
        continue;
      }
      if (type.group === "" && type.resource === "secrets") {
        problems.push({ message: "Secrets are created outside Landlens for now", ...where("kind") });
        continue;
      }
      const name = o.metadata?.name;
      if (typeof name !== "string" || !name) {
        problems.push({ message: `${o.kind} needs metadata.name`, field: "metadata.name", ...where("metadata") });
        continue;
      }
      const namespace = type.namespaced ? (o.metadata?.namespace ?? r.namespace) : undefined;
      if (type.namespaced && !namespace) {
        problems.push({ message: `${o.kind} ${name} needs a namespace`, field: "metadata.namespace", ...where("metadata") });
        continue;
      }
      if (!type.namespaced && o.metadata?.namespace) {
        problems.push({ message: `${o.kind} is cluster-scoped: remove metadata.namespace`, field: "metadata.namespace", ...where("metadata.namespace") });
        continue;
      }
      const body = JSON.stringify({ ...o, metadata: { ...o.metadata, ...(namespace ? { namespace } : {}) } });
      const path = apiPath(type, namespace);
      const q = new URLSearchParams({ fieldManager: EDIT_FIELD_MANAGER });
      const dry = new URLSearchParams(q);
      dry.set("dryRun", "All");
      const res = await send({ method: "POST", path: `${path}?${dry}`, contentType: "application/json", body });
      if (res.status === 409) {
        problems.push({ message: `${o.kind} ${namespace ? `${namespace}/` : ""}${name} already exists: open it and edit it instead`, ...where("metadata.name") });
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        problems.push(...refusal(res.status, res.text, r.yaml, doc));
        continue;
      }
      const result = JSON.parse(res.text);
      ops.push({
        verb: "create", kind: type.kind, group: type.group, ...(namespace ? { namespace } : {}), name,
        diff: diffLines("", stringify(clean(result), { lineWidth: 0 })),
        warnings: res.warnings.slice(0, 20),
        risk: risks({ verb: "create", type, ...(namespace ? { namespace } : {}), name, body: o }, null, result),
      });
      requests.push({ method: "POST", path: `${path}?${q}`, contentType: "application/json", body, describe: `${type.kind.toLowerCase()} ${namespace ? `${namespace}/` : ""}${name}` });
    }
    if (problems.length) return { problems };
    return { id: this.keep(requests), operations: ops };
  }

  /** Send what the review dry-ran. A conflict (the object moved on) comes back as status 409. */
  async apply(send: Send, id: string): Promise<{ results: string[] }> {
    this.sweep();
    const p = this.pending.get(id);
    if (!p) throw new EditError("This review has expired or was applied; review again", 410);
    this.pending.delete(id);
    const results: string[] = [];
    for (const q of p.requests) {
      const res = await send(q);
      if (res.status === 409) throw new EditError(`${q.describe} changed after your review${results.length ? ` (${results.join("; ")} applied)` : ""}; review again`, 409);
      if (res.status < 200 || res.status >= 300) {
        const e = toKubeError(res.status, res.text);
        throw new EditError(`${q.describe}: ${e.message}${results.length ? ` (${results.join("; ")} applied first)` : ""}`, res.status);
      }
      results.push(`${q.method === "POST" ? "Created" : "Applied"} ${q.describe}`);
    }
    return { results };
  }

  discard(id: string) {
    this.pending.delete(id);
  }

  private keep(requests: Pending["requests"]): string {
    this.sweep();
    const id = `ed${randomBytes(12).toString("base64url")}`;
    this.pending.set(id, { requests, expires: this.now() + (this.opts.ttlMs ?? EDIT_TTL_MS) });
    return id;
  }

  private sweep() {
    for (const [k, v] of this.pending) if (v.expires <= this.now()) this.pending.delete(k);
  }
}

function line(text: string, field: string, doc = 0): { line?: number } {
  const n = lineOf(text, field, doc);
  return n ? { line: n } : {};
}

// Your edits (wave 4, part 2): YAML you change in the drawer, or objects you create from YAML. Like the agent's
// changes, nothing reaches the cluster without a dry run you have seen: Review dry-runs the exact request and shows
// the live object against the dry run's result; Apply sends that same request, which carries the version you
// started from, so a change someone made meanwhile is refused instead of overwritten.
//
// An edit sends only what you changed: a JSON merge patch from the YAML you started with to the YAML you ended with
// (a removed field is a null, a changed list is sent whole). Fields you didn't touch are left to whoever owns them.
// Requests go through the front door with a token issued for the edit ("you · <context> · edit"), so they are in the
// audit trail as yours.
import { createHash, randomBytes } from "node:crypto";
import type { ChangeOperation, EditProblem, EditOwner, EditReview } from "@landlens/contracts";
import { isMap, isSeq, LineCounter, parseAllDocuments, stringify, visit, type Document } from "yaml";
export { applyMergePatch, editable, editableYaml, mergePatch, overlaps, patchPaths } from "./edit-yaml.js";
import { apiPath, toKubeError } from "./client.js";
import { clean, prepareOp, risks, type ChangeOp, type ChangeTarget, type Prepared, type Send } from "./changes.js";
import { editable, isObj, mergePatch, patchPaths } from "./edit-yaml.js";
import { diffLines } from "./diff.js";
import { redactObject } from "./redact.js";

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
  const { docs, lc } = parsed(text);
  const d = docs[doc];
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

/**
 * A text parsed once, with its line counter: a review looks lines up many times (a refusal names up to 20 fields),
 * and one parse of a wide 500 KB map takes seconds (security review, wave 4 part 2, finding 3).
 */
let last: { text: string; docs: Document[]; lc: LineCounter } | undefined;
function parsed(text: string): { docs: Document[]; lc: LineCounter } {
  if (last?.text === text) return last;
  const lc = new LineCounter();
  const d = parseAllDocuments(text, { lineCounter: lc, keepSourceTokens: true });
  last = { text, docs: (Array.isArray(d) ? d : [d]) as Document[], lc };
  return last;
}

/** The objects in a text, keeping each one's document index (empty documents are skipped). */
function objectsOf(text: string): { o: any; doc: number }[] {
  return parsed(text).docs.map((d, doc) => ({ o: d.toJS(), doc })).filter((x) => x.o !== null && x.o !== undefined);
}

/**
 * A YAML text's syntax errors, with lines. Also a plain number with a leading zero (`0600`): YAML 1.2 reads it as
 * decimal 600, Kubernetes tooling (YAML 1.1) as octal 384, so a file mode would come out wrong (finding 4).
 */
export function yamlProblems(text: string): EditProblem[] {
  const { docs, lc } = parsed(text);
  const syntax = docs.flatMap((d: any) => (d.errors ?? []).map((e: any) => ({ message: String(e.message).split("\n")[0]!, line: lc.linePos(e.pos[0]).line })));
  if (syntax.length) return syntax;
  const octal: EditProblem[] = [];
  for (const d of docs) {
    visit(d, {
      Scalar(_k, n) {
        const src = (n.srcToken as { type?: string; source?: string } | undefined);
        if (src?.type === "scalar" && /^[-+]?0\d+$/.test(src.source ?? "") && n.range) {
          octal.push({ message: `${src.source} is ambiguous: write 0o${src.source!.replace(/^[-+]?0+/, "")} for octal or drop the leading zero`, line: lc.linePos(n.range[0]).line });
        }
      },
    });
  }
  return octal.slice(0, 20);
}

/** Text from the cluster, cut: a cause's message and field, a warning (finding 5). */
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

type Pending = {
  requests: { method: string; path: string; contentType: string; body: string; describe: string }[];
  expires: number;
  /** SHA-256 over the requests, as hex (actions): Apply must name it. */
  digest: string;
};

/** One kept request's end, when several independent objects are applied (`apply(…, { each: true })`). */
export type EachResult = { target: string; outcome: "applied" | "conflict" | "failed" | "gone"; message?: string };

/** The SHA-256 of a review's requests, as hex: what an action's Apply must name (D144). */
export const reviewDigest = (requests: Pending["requests"]) => createHash("sha256").update(JSON.stringify(requests)).digest("hex");

/** Runs `f` over `xs`, at most `n` at a time, answers in the order of `xs`. */
export async function inOrder<T, R>(xs: T[], n: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let next = 0;
  const worker = async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await f(xs[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, worker));
  return out;
}

const describeOp = (op: ChangeOp) => `${op.type.kind.toLowerCase()} ${op.namespace ? `${op.namespace}/` : ""}${op.name}`;

/** What the API server's refusal says, cause by cause, with lines where it names a field. */
export function refusal(status: number, text: string, yaml: string, doc = 0): EditProblem[] {
  try {
    const s = JSON.parse(text) as { message?: string; details?: { causes?: { field?: string; message?: string; reason?: string }[] } };
    const causes = s.details?.causes ?? [];
    if (causes.length) {
      return causes.slice(0, 20).map((c) => {
        const field = c.field ? cut(String(c.field), 300) : undefined;
        const line = field ? lineOf(yaml, field, doc) : undefined;
        return { message: cut(String(c.message ?? c.reason ?? "refused"), 500), ...(field ? { field } : {}), ...(line ? { line } : {}) };
      });
    }
    return [{ message: cut(String(s.message ?? `HTTP ${status}`), 500) }];
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
    const edited = objectsOf(r.edited);
    // One object: a second document would be dropped without a word (finding 9).
    if (edited.length !== 1 || !isObj(edited[0]!.o)) return { problems: [{ message: "The YAML must be one object, in one document", line: 1 }] };
    const before = objectsOf(r.original)[0]?.o;
    const after = edited[0]!.o;
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
    // Removing every annotation you can see leaves the hidden ones (last-applied) alone: null each visible key
    // rather than the whole map (finding 9).
    if (patch.metadata?.annotations === null) {
      const shown = editable(before)?.metadata?.annotations ?? {};
      patch.metadata.annotations = Object.fromEntries(Object.keys(shown).map((k) => [k, null]));
      if (!Object.keys(patch.metadata.annotations).length) delete patch.metadata.annotations;
      if (!Object.keys(patch.metadata).length) delete patch.metadata;
    }
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
      warnings: res.warnings.slice(0, 20).map((w) => cut(w, 300)),
      risk: risks({ verb: "patch", type: r.type, ...(r.namespace ? { namespace: r.namespace } : {}), name: r.name, body: patch, patchType: "merge" }, current, result),
    };
    const owners: EditOwner[] = ownersOf(current, paths).slice(0, 20).map((o) => ({ ...o, ...line(r.edited, o.path) }));
    // What "Ask Claude to check it" may send: the same diff, scrubbed as the agent's own reads are (finding 1).
    const agent = forAgent(diffLines(stringify(clean(redactObject(current)), { lineWidth: 0 }), stringify(clean(redactObject(result)), { lineWidth: 0 })));
    const id = this.keep([{ method: "PATCH", path: `${objectPath}?${q}`, contentType: "application/merge-patch+json", body, describe: `${r.type.kind.toLowerCase()} ${r.namespace ? `${r.namespace}/` : ""}${r.name}` }]);
    return { id, operations: [op], ...(owners.length ? { owners } : {}), changed: paths.map((p) => p.join(".")), agent };
  }

  /** New objects from YAML (one or more documents), each created in its namespace (or `namespace`). */
  async reviewCreate(send: Send, r: { yaml: string; namespace?: string; types: ChangeTarget[] }): Promise<EditReview> {
    if (r.yaml.length > MAX_YAML) throw new EditError("the YAML is over 512 KB");
    const syntax = yamlProblems(r.yaml);
    if (syntax.length) return { problems: syntax };
    // Keep each object's document index, so problems mark lines in the right document.
    const objs = objectsOf(r.yaml);
    if (!objs.length) return { problems: [{ message: "Write an object first", line: 1 }] };
    if (objs.length > MAX_DOCUMENTS) return { problems: [{ message: `At most ${MAX_DOCUMENTS} objects at once` }] };
    const problems: EditProblem[] = [];
    const ops: ChangeOperation[] = [];
    const agentParts: string[] = [];
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
      agentParts.push(`${type.kind} ${namespace ? `${namespace}/` : ""}${name}:\n${stringify(clean(redactObject(result)), { lineWidth: 0 })}`);
      ops.push({
        verb: "create", kind: type.kind, group: type.group, ...(namespace ? { namespace } : {}), name,
        diff: diffLines("", stringify(clean(result), { lineWidth: 0 })),
        warnings: res.warnings.slice(0, 20).map((w) => cut(w, 300)),
        risk: risks({ verb: "create", type, ...(namespace ? { namespace } : {}), name, body: o }, null, result),
      });
      requests.push({ method: "POST", path: `${path}?${q}`, contentType: "application/json", body, describe: `${type.kind.toLowerCase()} ${namespace ? `${namespace}/` : ""}${name}` });
    }
    if (problems.length) return { problems };
    return { id: this.keep(requests), operations: ops, agent: agentParts.join("\n---\n") };
  }

  /**
   * Your actions (D140): each operation through the same preparation as the agent's changes (read, pin, dry-run, diff,
   * risks), as you (`landlens`), four at a time, in the list's order. The exact requests are kept under an `ed…` id for
   * 15 minutes. `agent` is the diff scrubbed as the agent's reads are, unless an operation is on Secrets. A 409 at the
   * dry run is a conflict; any other refusal is a problem naming the object. With `leaveOut` (bulk, part 3), refused
   * objects are problems and the rest is kept; without it, any problem means nothing is kept.
   */
  async reviewOps(send: Send, ops: ChangeOp[], extra: { leaveOut?: boolean } = {}): Promise<EditReview & { prepared: Prepared[]; digest?: string }> {
    type Tried = { ok: Prepared } | { op: ChangeOp; err: { status?: number; message?: string } };
    const tried = await inOrder(ops, 4, async (op): Promise<Tried> => {
      try {
        return { ok: await prepareOp(send, op, { fieldManager: EDIT_FIELD_MANAGER, hideSecrets: true, keepObjects: true }) };
      } catch (err) {
        return { op, err: err as { status?: number; message?: string } };
      }
    });
    const prepared: Prepared[] = [];
    const problems: EditProblem[] = [];
    let conflict = false;
    for (const t of tried) {
      if ("ok" in t) {
        prepared.push(t.ok);
        continue;
      }
      if (t.err?.status === 409) conflict = true;
      problems.push({ message: `${describeOp(t.op)}: ${cut(String(t.err?.message ?? "refused"), 500)}` });
    }
    if (problems.length && (!extra.leaveOut || !prepared.length)) return { problems, ...(conflict ? { conflict: true } : {}), prepared: [] };
    const secret = ops.some((op) => op.type.group === "" && op.type.resource === "secrets");
    const agent = secret ? undefined : prepared.map((x) => {
      const d = forAgent(diffLines(
        x.current ? stringify(clean(redactObject(x.current as any)), { lineWidth: 0 }) : "",
        x.after ? stringify(clean(redactObject(x.after as any)), { lineWidth: 0 }) : "",
      ));
      return prepared.length > 1 ? `${x.op.verb} ${describeOp(x.op)}:\n${d}` : d;
    }).join("\n---\n");
    const requests = prepared.map((x) => ({ method: x.method, path: x.path, contentType: x.contentType ?? "application/json", body: x.body ?? "", describe: describeOp(x.op) }));
    const id = this.keep(requests);
    return {
      id, digest: this.pending.get(id)!.digest, operations: prepared.map((x) => ({ ...x.shown, warnings: x.shown.warnings.map((w) => cut(w, 300)) })),
      ...(agent !== undefined ? { agent } : {}), ...(problems.length ? { problems } : {}), prepared,
    };
  }

  /**
   * Send what the review dry-ran. A conflict (the object moved on) comes back as status 409. With `each` (actions on
   * several independent objects), every kept request is sent and each answers for itself: applied, conflict (409), gone
   * (a 404 on a delete) or failed with the cluster's message cut. With `digest`, a review whose requests don't hash to
   * it is refused and dropped.
   */
  async apply(send: Send, id: string, o: { each?: boolean; digest?: string } = {}): Promise<{ results: string[]; each?: EachResult[] }> {
    this.sweep();
    const p = this.pending.get(id);
    if (!p) throw new EditError("This review has expired or was applied; review again", 410);
    this.pending.delete(id);
    if (o.digest !== undefined && o.digest !== p.digest) throw new EditError("This isn't the review that was shown; review again", 409);
    if (o.each) {
      const each: EachResult[] = [];
      for (const q of p.requests) {
        let res: Awaited<ReturnType<Send>>;
        try {
          res = await send(q);
        } catch (e) {
          // A request that timed out may have reached the cluster (L12): say so, not "couldn't reach".
          const late = (e as { status?: number }).status === 504;
          each.push({ target: q.describe, outcome: "failed", message: late ? "The cluster didn't answer in time; it may have been applied. Check it." : "Landlens couldn't reach the cluster." });
          continue;
        }
        if (res.status >= 200 && res.status < 300) each.push({ target: q.describe, outcome: "applied" });
        // A create's 409 is a name taken, not a change since the review (L9).
        else if (res.status === 409 && q.method === "POST") each.push({ target: q.describe, outcome: "conflict", message: "One of that name already exists; review again." });
        else if (res.status === 409) each.push({ target: q.describe, outcome: "conflict", message: "It changed after your review." });
        else if (res.status === 404 && q.method === "DELETE") each.push({ target: q.describe, outcome: "gone", message: "It was already gone." });
        else each.push({ target: q.describe, outcome: "failed", message: cut(toKubeError(res.status, res.text).message, 500) });
      }
      return { results: each.filter((e) => e.outcome === "applied").map((e) => `Applied ${e.target}`), each };
    }
    const results: string[] = [];
    for (const q of p.requests) {
      const res = await send(q);
      if (res.status === 409) throw new EditError(`${q.describe} changed after your review${results.length ? ` (${results.join("; ")} applied)` : ""}; review again`, 409);
      if (res.status < 200 || res.status >= 300) {
        const e = toKubeError(res.status, res.text);
        throw new EditError(`${q.describe}: ${cut(e.message, 500)}${results.length ? ` (${results.join("; ")} applied first)` : ""}`, res.status);
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
    this.pending.set(id, { requests, expires: this.now() + (this.opts.ttlMs ?? EDIT_TTL_MS), digest: reviewDigest(requests) });
    return id;
  }

  private sweep() {
    for (const [k, v] of this.pending) if (v.expires <= this.now()) this.pending.delete(k);
  }
}

/** A diff as text for the agent: changed lines with three lines around them, "…" between. */
function forAgent(d: ReturnType<typeof diffLines>): string {
  return d.lines.map((l) => (l.t === "…" ? "…" : `${l.t === "+" ? "+" : l.t === "-" ? "-" : " "} ${l.text}`)).join("\n");
}

function line(text: string, field: string, doc = 0): { line?: number } {
  const n = lineOf(text, field, doc);
  return n ? { line: n } : {};
}

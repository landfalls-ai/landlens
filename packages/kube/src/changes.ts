// The approval broker: the only way an agent's change reaches a cluster.
//
// A landlens-kube write tool turns what the agent asked for into operations (ProposedChange). The broker checks them,
// dry-runs each on the API server (dryRun=All: admission and validation run, nothing is stored), shows you the
// object as it is against what the dry run says it will be, and waits. Nothing is applied unless you approve. What is
// applied is the very request the dry run checked, carrying the object's resourceVersion (or uid and resourceVersion
// for a delete) as a precondition, so if the object changed while you looked, the API server refuses it with a
// conflict instead of applying something you didn't see.
//
// Requests go through the front door with a token only main holds (the session's "approved" token), so dry runs and
// applied writes are in the same audit trail as the agent's reads. The agent's own token stays read-only.
import { randomBytes } from "node:crypto";
import type { AgentChange, ChangeOperation, ChangeRisk, ChangeState, ChangeVerb } from "@landlens/contracts";
import { stringify } from "yaml";
import { apiPath, toKubeError } from "./client.js";
import { diffLines } from "./diff.js";
import { redactText } from "./redact.js";

export type ChangeTarget = { group: string; version: string; resource: string; kind: string; namespaced: boolean };
export type PatchType = "strategic" | "merge" | "json" | "apply";

/** One object to change, as a write tool asks for it. */
export type ChangeOp = {
  verb: ChangeVerb;
  type: ChangeTarget;
  namespace?: string;
  name: string;
  /** create and update: the object. patch: the patch (an object, or for "json" an array of operations). */
  body?: unknown;
  patchType?: PatchType;
  /**
   * Roll a Deployment back: the broker reads its ReplicaSets itself (the agent's reads are scrubbed, so a template
   * it read can't be written back) and patches the Deployment's template to that revision's. A revision number, or
   * "previous".
   */
  undo?: number | "previous";
};

export type ProposedChange = {
  tool: string;
  /** "Scale deployment landlens-dev/orders-api to 3 replicas" */
  title: string;
  reason: string;
  operations: ChangeOp[];
  /** The MCP gateway's call id, for pairing with the dock's tool card. */
  call?: string;
};

export type Outcome =
  | { state: "applied"; results: string[] }
  | { state: "rejected"; note?: string }
  | { state: "failed"; stage: "check" | "dry-run" | "apply"; error: string; applied?: string[] }
  | { state: "expired" }
  | { state: "withdrawn" };

/** A request through the front door with the session's approved token. */
export type Send = (r: { method: string; path: string; contentType?: string; body?: string }) =>
  Promise<{ status: number; text: string; warnings: string[] }>;

export type ChangeDecision = { decision: "approve" | "reject"; note?: string };

export const MAX_OPERATIONS = 10;
export const CHANGE_TTL_MS = 15 * 60_000;
export const FIELD_MANAGER = "landlens-agent";

const CONTENT_TYPE: Record<PatchType, string> = {
  strategic: "application/strategic-merge-patch+json",
  merge: "application/merge-patch+json",
  json: "application/json-patch+json",
  apply: "application/apply-patch+yaml",
};

/** What the front door's scrubbing leaves in place of values (redact.ts): never written back to a cluster. */
const HIDDEN = /<redacted[^>]*>|… \(\d+ more characters\)/;

/** Kinds the agent may never change, whatever you'd approve: it can't read them, so it can't show you a true diff. */
const NEVER = new Set(["secrets"]);

type Prepared = {
  op: ChangeOp;
  /** It didn't exist at the dry run (a create by apply): if it exists when you approve, nothing is sent. */
  absent?: boolean;
  method: string;
  path: string;
  contentType?: string;
  body?: string;
  shown: ChangeOperation;
};

export class ChangeError extends Error {}

/** JSON patch operations the agent may send. copy, move and test read values the agent can't see (the broker adds its own test). */
const JSON_PATCH_OPS = new Set(["add", "replace", "remove"]);
/** Proposals that fail their checks or dry run, per session, before the broker stops trying them. */
export const MAX_REFUSED = 20;

/**
 * An API server's error, as the agent may hear it. The broker reads and dry-runs unscrubbed, and a validation error
 * quotes the value it refused, so quoted values and "Invalid value: …" are cut, then credential-shaped text.
 */
export function agentSafe(text: string): string {
  return redactText(
    text
      .replace(/"(?:[^"\\]|\\.)*"/g, '"…"')
      .replace(/\b((?:Invalid|Unsupported|Duplicate|Forbidden|Required) value): (?!"…")[^:\n]*:/g, "$1: …:"),
  ).slice(0, 2000);
}

export class ChangeBroker {
  private readonly now: () => number;
  private readonly ttl: number;
  private refused = 0;

  constructor(private readonly opts: {
    /** Claude Code's session id, for the dock. */
    session: string;
    send: Send;
    /** Namespaces the session is limited to, if any. */
    namespaces?: string[];
    /** Show the change and wait for your decision. Abort the signal to take the question back. */
    ask: (change: AgentChange, signal: AbortSignal) => Promise<ChangeDecision>;
    /** The change's state moved on (applying, applied, failed…). */
    update: (change: AgentChange) => void;
    ttlMs?: number;
    now?: () => number;
  }) {
    this.now = opts.now ?? Date.now;
    this.ttl = opts.ttlMs ?? CHANGE_TTL_MS;
  }

  /**
   * Check, dry-run, ask, and apply on approval. A change that fails its checks or its dry run never reaches you: the
   * agent gets the reason and can propose again. `signal` withdraws the question (the turn was cancelled, the session
   * closed).
   */
  async propose(p: ProposedChange, signal?: AbortSignal): Promise<Outcome> {
    // Each refusal answers the agent without asking you, so it could be used to probe: there's a limit per session.
    if (this.refused >= MAX_REFUSED) {
      return { state: "failed", stage: "check", error: `${MAX_REFUSED} proposals in this session were refused; Landlens takes no more from it. Tell the person what you'd change` };
    }
    try {
      this.check(p);
    } catch (err) {
      this.refused++;
      return { state: "failed", stage: "check", error: message(err) };
    }
    const prepared: Prepared[] = [];
    for (const op of p.operations) {
      try {
        prepared.push(await this.prepare(op));
      } catch (err) {
        this.refused++;
        return { state: "failed", stage: "dry-run", error: agentSafe(`${describe(op)}: ${message(err)}`) };
      }
    }

    const created = this.now();
    const change: AgentChange = {
      id: `ch${randomBytes(12).toString("base64url")}`,
      session: this.opts.session,
      ...(p.call ? { call: p.call } : {}),
      tool: p.tool,
      title: p.title,
      reason: p.reason,
      operations: prepared.map((x) => x.shown),
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + this.ttl).toISOString(),
      state: "waiting",
    };
    const set = (state: ChangeState, result?: string) => {
      change.state = state;
      if (result !== undefined) change.result = result;
      this.opts.update({ ...change });
    };

    const ask = new AbortController();
    const timer = setTimeout(() => ask.abort("expired"), this.ttl);
    const onAbort = () => ask.abort("withdrawn");
    signal?.addEventListener("abort", onAbort, { once: true });
    let decision: ChangeDecision | undefined;
    try {
      decision = await this.opts.ask({ ...change }, ask.signal);
    } catch {
      decision = undefined;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (!decision || ask.signal.aborted) {
      const why = ask.signal.reason === "expired" ? "expired" : "withdrawn";
      set(why, why === "expired" ? "No answer in 15 minutes; nothing was applied." : "The turn ended before you answered; nothing was applied.");
      return { state: why };
    }
    if (decision.decision === "reject") {
      set("rejected", decision.note ? `Rejected: ${decision.note}` : "Rejected; nothing was applied.");
      return { state: "rejected", ...(decision.note ? { note: decision.note } : {}) };
    }

    set("applying");
    const results: string[] = [];
    for (const x of prepared) {
      try {
        if (x.absent) {
          const now = await this.opts.send({ method: "GET", path: apiPath(x.op.type, x.op.namespace, x.op.name) });
          if (now.status === 200) throw Object.assign(new ChangeError("it was created by someone else after the dry run"), { status: 409 });
          if (now.status !== 404) throw toKubeError(now.status, now.text);
        }
        const r = await this.opts.send({ method: x.method, path: x.path, ...(x.contentType ? { contentType: x.contentType } : {}), ...(x.body !== undefined ? { body: x.body } : {}) });
        if (r.status < 200 || r.status >= 300) throw toKubeError(r.status, r.text);
        results.push(appliedLine(x, r.text));
      } catch (err) {
        const error = `${describe(x.op)}: ${message(err)}${conflictHint(err)}`;
        set("failed", results.length ? `${results.join("; ")}; then ${error}` : error);
        return { state: "failed", stage: "apply", error: agentSafe(error), ...(results.length ? { applied: results } : {}) };
      }
    }
    set("applied", results.join("; "));
    return { state: "applied", results };
  }

  private check(p: ProposedChange) {
    if (!p.operations.length) throw new ChangeError("a change needs at least one operation");
    if (p.operations.length > MAX_OPERATIONS) throw new ChangeError(`a change may have at most ${MAX_OPERATIONS} operations`);
    for (const op of p.operations) {
      if (!op.name || op.name.includes("/")) throw new ChangeError("each operation names one object");
      if (op.verb === "update") throw new ChangeError("Landlens doesn't take whole-object updates; use apply_manifest or patch");
      const k = op.type.group ? `${op.type.resource}.${op.type.group}` : op.type.resource;
      if (NEVER.has(k)) throw new ChangeError(`Landlens never lets the agent change ${op.type.resource}; propose the change for the person to make`);
      if (op.type.namespaced && !op.namespace) throw new ChangeError(`${describe(op)} needs a namespace`);
      if (!op.type.namespaced && op.namespace) throw new ChangeError(`${op.type.kind} is cluster-scoped; leave out the namespace`);
      if (this.opts.namespaces && (!op.namespace || !this.opts.namespaces.includes(op.namespace))) {
        throw new ChangeError(`this session may only change namespaces ${this.opts.namespaces.join(", ")}`);
      }
      if (op.body !== undefined && HIDDEN.test(JSON.stringify(op.body))) {
        throw new ChangeError(`${describe(op)} contains text Landlens hid from you (<redacted …>, or a string cut with "more characters"). Leave those fields out: apply and patches keep the fields you don't name`);
      }
      if (op.undo !== undefined && (op.type.resource !== "deployments" || op.type.group !== "apps" || op.verb !== "patch")) {
        throw new ChangeError("only a Deployment can be rolled back");
      }
      if (op.verb === "patch" && !op.patchType) throw new ChangeError("a patch needs a patch type");
      if (op.verb !== "patch" && op.patchType) throw new ChangeError("only a patch has a patch type");
      if (op.verb === "create" || op.patchType === "apply") checkObject(op);
      if (op.patchType === "json" && op.undo === undefined) {
        if (!Array.isArray(op.body)) throw new ChangeError("a JSON patch is a list of operations");
        for (const o of op.body) {
          if (!isObject(o) || !JSON_PATCH_OPS.has(o.op) || "from" in o) throw new ChangeError("a JSON patch may only add, replace and remove (copy, move and test read values hidden from you)");
        }
      }
      if ((op.patchType === "strategic" || op.patchType === "merge") && !isObject(op.body)) throw new ChangeError("a merge patch is an object");
    }
  }

  /** A Deployment's pod template at a revision, from its ReplicaSets, read unscrubbed with the approved token. */
  private async revisionTemplate(d: any, undo: number | "previous"): Promise<unknown> {
    const sel = Object.entries(d.spec?.selector?.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`).join(",");
    const q = new URLSearchParams({ limit: "200", ...(sel ? { labelSelector: sel } : {}) });
    const r = await this.opts.send({ method: "GET", path: `${apiPath({ group: "apps", version: "v1", resource: "replicasets" }, d.metadata.namespace)}?${q}` });
    if (r.status !== 200) throw toKubeError(r.status, r.text);
    const rev = (x: any) => Number(x.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? 0);
    const mine = (JSON.parse(r.text).items ?? [])
      .filter((x: any) => (x.metadata?.ownerReferences ?? []).some((o: any) => o.uid === d.metadata.uid))
      .sort((a: any, b: any) => rev(b) - rev(a));
    const now = rev(d) || rev(mine[0]);
    const target = undo === "previous" ? mine.find((x: any) => rev(x) < now) : mine.find((x: any) => rev(x) === undo);
    if (!target) throw new ChangeError(undo === "previous" ? "there is no earlier revision" : `there is no revision ${undo}`);
    if (rev(target) === now) throw new ChangeError(`revision ${undo} is the current one`);
    const t = structuredClone(target.spec.template);
    if (t.metadata?.labels) delete t.metadata.labels["pod-template-hash"];
    return t;
  }

  /** Read the object, build the exact request, dry-run it and show the difference. */
  private async prepare(op: ChangeOp): Promise<Prepared> {
    const objectPath = apiPath(op.type, op.namespace, op.name);
    const got = await this.opts.send({ method: "GET", path: objectPath });
    let current: any = null;
    if (got.status === 200) current = JSON.parse(got.text);
    else if (got.status !== 404) throw toKubeError(got.status, got.text);

    if (op.undo !== undefined) {
      if (!current) throw new ChangeError("it doesn't exist");
      op = { ...op, patchType: "json", body: [{ op: "replace", path: "/spec/template", value: await this.revisionTemplate(current, op.undo) }] };
    }
    const rv: string | undefined = current?.metadata?.resourceVersion;
    const uid: string | undefined = current?.metadata?.uid;
    const q = new URLSearchParams({ fieldManager: FIELD_MANAGER });
    let method: string;
    let path = objectPath;
    let contentType: string | undefined = "application/json";
    let body: unknown;

    switch (op.verb) {
      case "create":
        if (current) throw new ChangeError("it already exists; propose a patch or apply instead");
        method = "POST";
        path = apiPath(op.type, op.namespace);
        body = withMeta(op.body, op.namespace);
        break;
      case "update":
        if (!current) throw new ChangeError("it doesn't exist");
        method = "PUT";
        body = withMeta(op.body, op.namespace, rv);
        break;
      case "delete":
        if (!current) throw new ChangeError("it doesn't exist");
        method = "DELETE";
        body = { kind: "DeleteOptions", apiVersion: "v1", propagationPolicy: "Background", preconditions: { uid, resourceVersion: rv } };
        q.delete("fieldManager");
        break;
      case "patch": {
        method = "PATCH";
        contentType = CONTENT_TYPE[op.patchType!];
        if (op.patchType === "apply") {
          q.set("force", "true"); // you approve the result shown, whoever managed those fields before
          body = withMeta(op.body, op.namespace, rv);
        } else {
          if (!current) throw new ChangeError("it doesn't exist; to create it, use apply_manifest");
          body = op.patchType === "json"
            ? [{ op: "test", path: "/metadata/resourceVersion", value: rv }, ...(op.body as unknown[])]
            : withResourceVersion(op.body, rv);
        }
        break;
      }
    }
    const text = JSON.stringify(body);
    const dry = new URLSearchParams(q);
    dry.set("dryRun", "All");
    // A DELETE with a body takes its options from the body and ignores the query, dryRun included: the dry run of a
    // delete must say so in its DeleteOptions, or it deletes.
    const dryBody = op.verb === "delete" ? JSON.stringify({ ...(body as object), dryRun: ["All"] }) : text;
    const r = await this.opts.send({ method, path: `${path}?${dry}`, ...(contentType ? { contentType } : {}), body: dryBody });
    if (r.status < 200 || r.status >= 300) throw toKubeError(r.status, r.text);
    const after = op.verb === "delete" ? null : JSON.parse(r.text);
    const before = clean(current);
    const afterClean = clean(after);
    const diff = diffLines(before ? stringify(before, { lineWidth: 0 }) : "", afterClean ? stringify(afterClean, { lineWidth: 0 }) : "");
    // A change that would change nothing still goes to you: answering the agent at once would tell it that a value
    // it can't see equals the one it guessed.
    const qs = q.toString();
    return {
      op,
      ...(op.verb === "patch" && op.patchType === "apply" && !current ? { absent: true } : {}),
      method,
      path: qs ? `${path}?${qs}` : path,
      ...(contentType ? { contentType } : {}),
      body: text,
      shown: {
        verb: op.verb === "patch" && !current ? "create" : op.verb,
        kind: op.type.kind,
        group: op.type.group,
        ...(op.namespace ? { namespace: op.namespace } : {}),
        name: op.name,
        diff,
        warnings: r.warnings.slice(0, 20),
        risk: risks(op, current, after),
      },
    };
  }
}

function isObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** The object a create, update or apply sends must be the object the operation names. */
function checkObject(op: ChangeOp) {
  const o = op.body;
  if (!isObject(o)) throw new ChangeError("the manifest must be one object");
  const apiVersion = op.type.group ? `${op.type.group}/${op.type.version}` : op.type.version;
  if (o.apiVersion !== apiVersion || o.kind !== op.type.kind) throw new ChangeError(`the manifest is ${o.apiVersion} ${o.kind}, not ${apiVersion} ${op.type.kind}`);
  if (o.metadata?.name !== op.name) throw new ChangeError("the manifest's metadata.name doesn't match");
  if (o.metadata?.namespace !== undefined && o.metadata.namespace !== op.namespace) throw new ChangeError("the manifest's metadata.namespace doesn't match");
  if (o.metadata?.generateName !== undefined) throw new ChangeError("generateName isn't supported; give the object a name");
}

function withMeta(body: unknown, namespace: string | undefined, rv?: string): Record<string, any> {
  const o = structuredClone(body) as Record<string, any>;
  o.metadata = { ...(o.metadata ?? {}) };
  if (namespace) o.metadata.namespace = namespace;
  delete o.metadata.uid;
  delete o.metadata.managedFields;
  delete o.metadata.creationTimestamp;
  if (rv) o.metadata.resourceVersion = rv;
  else delete o.metadata.resourceVersion;
  delete o.status;
  return o;
}

/** A merge patch that names the resourceVersion is refused with a conflict if the object has moved on. */
function withResourceVersion(patch: unknown, rv: string | undefined): Record<string, any> {
  const o = structuredClone(patch) as Record<string, any>;
  o.metadata = { ...(o.metadata ?? {}), resourceVersion: rv };
  return o;
}

const BOOKKEEPING = ["managedFields", "resourceVersion", "generation", "uid", "creationTimestamp", "selfLink"];

/**
 * The object without server bookkeeping. Status and every annotation stay: a kind without a status subresource takes
 * status from a write, so a change to it is shown like any other (unchanged runs fold away).
 */
export function clean(o: any): any {
  if (!o) return null;
  const c = structuredClone(o);
  if (c.metadata) for (const k of BOOKKEEPING) delete c.metadata[k];
  return c;
}

/** Every pod spec in an object, wherever its kind keeps it (a Pod, a template, a CronJob's, a custom resource's). */
export function podSpecs(o: any): any[] {
  const out: any[] = [];
  const walk = (v: any, depth: number) => {
    if (!v || typeof v !== "object" || depth > 12) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (Array.isArray(v.containers) && v.containers.some((c: any) => c && typeof c === "object" && "image" in c)) out.push(v);
    for (const [k, x] of Object.entries(v)) if (k !== "status" && k !== "metadata") walk(x, depth + 1);
  };
  walk(o?.spec, 0);
  return out;
}

const containersOf = (s: any): any[] => [...(s.initContainers ?? []), ...(s.containers ?? []), ...(s.ephemeralContainers ?? [])];

/** What a pod spec could do beyond its own container, as sets of strings so before and after can be compared. */
function powers(o: any) {
  const secrets = new Set<string>();
  const privileged = new Set<string>();
  const host = new Set<string>();
  const accounts = new Set<string>();
  for (const s of podSpecs(o)) {
    for (const c of containersOf(s)) {
      for (const e of c.env ?? []) if (e?.valueFrom?.secretKeyRef) secrets.add(`env ${e.valueFrom.secretKeyRef.name}`);
      for (const e of c.envFrom ?? []) if (e?.secretRef) secrets.add(`envFrom ${e.secretRef.name}`);
      const sc = c.securityContext ?? {};
      if (sc.privileged) privileged.add(`${c.name} privileged`);
      if (sc.allowPrivilegeEscalation) privileged.add(`${c.name} escalation`);
      for (const cap of sc.capabilities?.add ?? []) privileged.add(`${c.name} ${cap}`);
      for (const port of c.ports ?? []) if (port?.hostPort) host.add(`hostPort ${port.hostPort}`);
    }
    for (const v of s.volumes ?? []) {
      if (v?.secret) secrets.add(`volume ${v.secret.secretName}`);
      for (const src of v?.projected?.sources ?? []) if (src?.secret) secrets.add(`projected ${src.secret.name}`);
      if (v?.hostPath) host.add(`hostPath ${v.hostPath.path}`);
    }
    for (const k of ["hostNetwork", "hostPID", "hostIPC"]) if (s[k]) host.add(k);
    if (s.serviceAccountName || s.serviceAccount) accounts.add(s.serviceAccountName ?? s.serviceAccount);
  }
  return { secrets, privileged, host, accounts };
}

const grows = (before: Set<string>, after: Set<string>) => [...after].some((x) => !before.has(x));

export function risks(op: ChangeOp, before: any, after: any): ChangeRisk[] {
  const out = new Set<ChangeRisk>();
  if (op.verb === "delete") out.add("deletes");
  if (op.type.group === "rbac.authorization.k8s.io") out.add("rbac");
  if (op.type.resource === "namespaces" && !op.type.group) out.add("namespace");
  if (!op.type.namespaced) out.add("cluster-scoped");
  if (after) {
    const b = powers(before);
    const a = powers(after);
    if (grows(b.secrets, a.secrets)) out.add("reads-secret");
    if (grows(b.privileged, a.privileged)) out.add("privileged");
    if (grows(b.host, a.host)) out.add("host-access");
    if (grows(b.accounts, a.accounts)) out.add("service-account");
    const specsAfter = podSpecs(after);
    if (!before && specsAfter.length) out.add("new-workload");
    if (before && specsAfter.length) {
      const images = (o: any) => JSON.stringify(podSpecs(o).flatMap(containersOf).map((c: any) => `${c.name}=${c.image}`));
      if (images(before) !== images(after)) out.add("changes-image");
      // A template's metadata (kubectl rollout restart's annotation) restarts pods as much as its spec does.
      const tmpl = (o: any) => JSON.stringify([o?.spec?.template ?? o?.spec?.jobTemplate ?? null, podSpecs(o)]);
      if (op.type.resource !== "pods" && tmpl(before) !== tmpl(after)) out.add("restarts-pods");
    }
    if (typeof after.spec?.replicas === "number" && after.spec.replicas === 0 && (before?.spec?.replicas ?? 1) !== 0) out.add("scales-to-zero");
  }
  const order: ChangeRisk[] = [
    "deletes", "rbac", "namespace", "cluster-scoped", "reads-secret", "privileged", "host-access", "service-account",
    "new-workload", "scales-to-zero", "changes-image", "restarts-pods",
  ];
  return order.filter((r) => out.has(r));
}

function describe(op: ChangeOp): string {
  return `${op.verb} ${op.type.kind.toLowerCase()} ${op.namespace ? `${op.namespace}/` : ""}${op.name}`;
}

function appliedLine(x: Prepared, text: string): string {
  let gen = "";
  try {
    const o = JSON.parse(text);
    if (typeof o?.metadata?.generation === "number" && x.op.verb !== "delete") gen = ` (generation ${o.metadata.generation})`;
  } catch {
    // a delete may answer with a Status
  }
  const done = { create: "created", update: "updated", patch: "patched", delete: "deleted" }[x.op.verb];
  return `${x.op.type.kind.toLowerCase()} ${x.op.namespace ? `${x.op.namespace}/` : ""}${x.op.name} ${done}${gen}`;
}

function message(err: unknown): string {
  const e = err as { status?: number; message?: string };
  return e?.status ? `${e.status}: ${e.message}` : err instanceof Error ? err.message : String(err);
}

function conflictHint(err: unknown): string {
  return (err as { status?: number })?.status === 409 ? " (it changed after the dry run you approved; nothing of this operation was applied; read it again and propose anew)" : "";
}

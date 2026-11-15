// An in-memory Kubernetes API behind `Send` (wave 8, D169), grown from changes.test.ts's fakeCluster, for the parts of
// the API a drain touches: objects with uid and resourceVersion, `dryRun=All` in the query and DeleteOptions' `dryRun`
// (the two must match, as the API server requires), uid and resourceVersion preconditions (409), lists by namespace
// and all namespaces with `fieldSelector=spec.nodeName=` and paging, merge patches, PodDisruptionBudgets whose
// `disruptionsAllowed` it recomputes, and the eviction subresource (201; 429 with a `DisruptionBudget` cause; 500 for
// two budgets; the uid precondition; terminal pods without a budget check). It records every request. This is where a
// full drain runs in tests: no real node is ever cordoned or drained.
import { applyMergePatch } from "../src/edit-yaml.js";
import type { Send } from "../src/changes.js";
import { selects } from "../src/actions.js";

export type Recorded = { method: string; path: string; body?: any };

const status = (code: number, message: string, extra: object = {}) => ({ status: code, text: JSON.stringify({ kind: "Status", apiVersion: "v1", status: "Failure", code, message, ...extra }), warnings: [] as string[] });
const ok = (o: unknown, code = 200) => ({ status: code, text: JSON.stringify(o), warnings: [] as string[] });

export class FakeApi {
  /** Objects by their path (no query). */
  readonly objects = new Map<string, any>();
  readonly requests: Recorded[] = [];
  private rv = 100;
  private uids = 0;
  /** Refuse a request with this status before the fake looks at it. */
  refuse?: (r: Recorded) => number | undefined;
  /** After a real eviction: what a controller would do (make a replacement pod elsewhere). */
  onEvict?: (pod: any) => void;
  /** Lists of the node's pods an evicted pod stays in (terminating) before it is gone. */
  linger = 0;
  private lingering = new Map<string, number>();

  node(name: string, extra: { unschedulable?: boolean; ready?: boolean } = {}) {
    this.put(`/api/v1/nodes/${name}`, {
      apiVersion: "v1", kind: "Node", metadata: { name, labels: {} },
      spec: extra.unschedulable ? { unschedulable: true } : {},
      status: { conditions: [{ type: "Ready", status: extra.ready === false ? "False" : "True" }] },
    });
    return this;
  }

  pod(namespace: string, name: string, o: { node?: string; labels?: Record<string, string>; owner?: { kind: string; name: string }; emptyDir?: string[]; phase?: string; mirror?: boolean; deleting?: boolean; ready?: boolean } = {}) {
    const uid = `uid-${name}-${++this.uids}`;
    this.put(`/api/v1/namespaces/${namespace}/pods/${name}`, {
      apiVersion: "v1", kind: "Pod",
      metadata: {
        name, namespace, uid, labels: o.labels ?? { app: name },
        ...(o.owner ? { ownerReferences: [{ apiVersion: "apps/v1", kind: o.owner.kind, name: o.owner.name, uid: `owner-${o.owner.name}`, controller: true }] } : {}),
        ...(o.mirror ? { annotations: { "kubernetes.io/config.mirror": "abc" } } : {}),
        ...(o.deleting ? { deletionTimestamp: "2026-11-16T00:00:00Z" } : {}),
      },
      spec: { nodeName: o.node ?? "node-1", containers: [{ name: "c", image: "pause" }], volumes: (o.emptyDir ?? []).map((v) => ({ name: v, emptyDir: {} })) },
      status: { phase: o.phase ?? "Running", conditions: [{ type: "Ready", status: o.ready === false ? "False" : "True" }] },
    });
    return uid;
  }

  pdb(namespace: string, name: string, o: { selector: Record<string, string>; minAvailable?: number; maxUnavailable?: number }) {
    this.put(`/apis/policy/v1/namespaces/${namespace}/poddisruptionbudgets/${name}`, {
      apiVersion: "policy/v1", kind: "PodDisruptionBudget", metadata: { name, namespace, generation: 1 },
      spec: { selector: { matchLabels: o.selector }, ...(o.minAvailable !== undefined ? { minAvailable: o.minAvailable } : {}), ...(o.maxUnavailable !== undefined ? { maxUnavailable: o.maxUnavailable } : {}) },
      status: { observedGeneration: 1, disruptionsAllowed: 0, currentHealthy: 0, desiredHealthy: 0, expectedPods: 0, disruptedPods: {} },
    });
    this.recompute();
    return this;
  }

  get(path: string) {
    return this.objects.get(path);
  }

  podsOn(node: string) {
    return [...this.objects.values()].filter((o) => o.kind === "Pod" && o.spec?.nodeName === node);
  }

  private put(path: string, o: any) {
    o.metadata.resourceVersion = String(++this.rv);
    o.metadata.uid ??= `uid-${o.metadata.name}-${++this.uids}`;
    this.objects.set(path, o);
  }

  /** The disruption controller's arithmetic, for integer minAvailable and maxUnavailable. */
  recompute() {
    for (const b of this.objects.values()) {
      if (b.kind !== "PodDisruptionBudget") continue;
      const pods = [...this.objects.values()].filter((p) => p.kind === "Pod" && p.metadata.namespace === b.metadata.namespace && selects(b.spec.selector, p.metadata.labels));
      const healthy = pods.filter((p) => !p.metadata.deletionTimestamp && (p.status?.conditions ?? []).some((c: any) => c.type === "Ready" && c.status === "True") && !b.status.disruptedPods?.[p.metadata.name]).length;
      const desired = b.spec.minAvailable !== undefined ? b.spec.minAvailable : Math.max(0, pods.length - (b.spec.maxUnavailable ?? 0));
      b.status = { ...b.status, currentHealthy: healthy, desiredHealthy: desired, expectedPods: pods.length, disruptionsAllowed: Math.max(0, healthy - desired) };
    }
  }

  private list(prefix: (path: string) => boolean, q: URLSearchParams, filter: (o: any) => boolean = () => true) {
    const field = q.get("fieldSelector");
    const node = field?.startsWith("spec.nodeName=") ? field.slice("spec.nodeName=".length) : undefined;
    let items = [...this.objects.entries()].filter(([p, o]) => prefix(p) && filter(o) && (node === undefined || o.spec?.nodeName === node)).map(([, o]) => o);
    // Pods leaving after an eviction stay in the list for `linger` reads.
    if (node !== undefined) {
      for (const [k, n] of this.lingering) {
        if (n <= 0) {
          this.lingering.delete(k);
          this.objects.delete(k);
        } else this.lingering.set(k, n - 1);
      }
      items = items.filter((o) => this.objects.has(`/api/v1/namespaces/${o.metadata.namespace}/pods/${o.metadata.name}`));
    }
    const limit = Number(q.get("limit") ?? 0) || items.length;
    const from = Number(q.get("continue") ?? 0);
    const page = items.slice(from, from + limit);
    const next = from + limit < items.length ? String(from + limit) : undefined;
    return ok({ kind: "List", metadata: { resourceVersion: String(this.rv), ...(next ? { continue: next } : {}) }, items: page });
  }

  readonly send: Send = async (r) => {
    const rec: Recorded = { method: r.method, path: r.path, ...(r.body ? { body: JSON.parse(r.body) } : {}) };
    this.requests.push(rec);
    const refused = this.refuse?.(rec);
    if (refused) return status(refused, `refused ${refused}`);
    const [path, query = ""] = r.path.split("?") as [string, string?];
    const q = new URLSearchParams(query);
    const dryQuery = q.get("dryRun") === "All";

    if (r.method === "GET") {
      if (path === "/api/v1/pods") return this.list((p) => /^\/api\/v1\/namespaces\/[^/]+\/pods\/[^/]+$/.test(p), q);
      if (path === "/api/v1/nodes") return this.list((p) => p.startsWith("/api/v1/nodes/"), q);
      if (path === "/apis/policy/v1/poddisruptionbudgets") return this.list((p) => p.includes("/poddisruptionbudgets/"), q);
      const nsList = /^\/apis\/policy\/v1\/namespaces\/([^/]+)\/poddisruptionbudgets$/.exec(path);
      if (nsList) return this.list((p) => p.startsWith(`${path}/`), q);
      const o = this.objects.get(path);
      return o ? ok(o) : status(404, "not found", { reason: "NotFound" });
    }

    if (r.method === "PATCH") {
      const o = this.objects.get(path);
      if (!o) return status(404, "not found");
      const body = rec.body;
      if (body?.metadata?.resourceVersion !== undefined && body.metadata.resourceVersion !== o.metadata.resourceVersion) return status(409, "the object has been modified", { reason: "Conflict" });
      const { metadata: _m, ...rest } = body ?? {};
      const next = applyMergePatch(structuredClone(o), rest) as any;
      if (!dryQuery) {
        next.metadata.resourceVersion = String(++this.rv);
        this.objects.set(path, next);
      }
      return ok(next);
    }

    const evict = /^\/api\/v1\/namespaces\/([^/]+)\/pods\/([^/]+)\/eviction$/.exec(path);
    if (r.method === "POST" && evict) {
      const body = rec.body ?? {};
      const dryBody: string[] = body.deleteOptions?.dryRun ?? [];
      if (dryQuery && dryBody.length && !dryBody.includes("All")) return status(400, "Non-matching dry-run options");
      const dry = dryQuery || dryBody.includes("All");
      const podPath = `/api/v1/namespaces/${evict[1]}/pods/${evict[2]}`;
      const pod = this.objects.get(podPath);
      if (!pod) return status(404, "not found", { reason: "NotFound" });
      const uid = body.deleteOptions?.preconditions?.uid;
      if (uid !== undefined && uid !== pod.metadata.uid) return status(409, "the UID in the precondition does not match", { reason: "Conflict" });
      const terminal = ["Succeeded", "Failed", "Pending"].includes(pod.status?.phase) || !!pod.metadata.deletionTimestamp;
      if (!terminal) {
        const budgets = [...this.objects.values()].filter((b) => b.kind === "PodDisruptionBudget" && b.metadata.namespace === pod.metadata.namespace && selects(b.spec.selector, pod.metadata.labels));
        if (budgets.length > 1) return status(500, "This pod has more than one PodDisruptionBudget, which the eviction subresource does not support.");
        const b = budgets[0];
        if (b) {
          if (b.status.disruptionsAllowed <= 0) {
            return status(429, "Cannot evict pod as it would violate the pod's disruption budget.", { reason: "TooManyRequests", details: { causes: [{ reason: "DisruptionBudget", message: `The disruption budget ${b.metadata.name} needs ${b.status.desiredHealthy} healthy pods and has ${b.status.currentHealthy} currently` }] } });
          }
          // As the API server: spend the budget only for a real eviction.
          if (!dry) b.status = { ...b.status, disruptionsAllowed: b.status.disruptionsAllowed - 1, disruptedPods: { ...b.status.disruptedPods, [pod.metadata.name]: "now" } };
        }
      }
      if (!dry) {
        pod.metadata.deletionTimestamp = "2026-11-16T00:00:01Z";
        pod.metadata.resourceVersion = String(++this.rv);
        if (this.linger > 0) this.lingering.set(podPath, this.linger);
        else this.objects.delete(podPath);
        this.onEvict?.(pod);
      }
      return ok({ kind: "Status", apiVersion: "v1", status: "Success", code: 201 }, 201);
    }

    if (r.method === "DELETE") {
      const o = this.objects.get(path);
      if (!o) return status(404, "not found");
      const body = rec.body ?? {};
      const pre = body.preconditions ?? {};
      if ((pre.uid && pre.uid !== o.metadata.uid) || (pre.resourceVersion && pre.resourceVersion !== o.metadata.resourceVersion)) return status(409, "precondition failed", { reason: "Conflict" });
      if (!(body.dryRun ?? []).includes("All") && !dryQuery) this.objects.delete(path);
      return ok({ kind: "Status", status: "Success" });
    }
    return status(405, "method not allowed");
  };
}

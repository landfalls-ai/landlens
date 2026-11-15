// Clickland's history in the IDE (docs/metrics.md#logs-and-traces, wave 7 part 3, D115–D118), in main. The window
// names an object it shows and a range; main checks the object is in the window's cluster (read as you) or in the
// doctor's report for it (so a gone pod of a known workload can be asked about, an arbitrary name can't), builds the
// search itself (clickland-search.ts) and sends it with Clickland's key, which never leaves main. What comes back is
// checked, capped and scrubbed (redactText) before it crosses IPC; failures are the graphs' fixed sentences.
//
// Open in Clickland: main builds the console's URL from the console address the person stored and the same search,
// shows the host in a native dialog and opens it only on Open. The window never supplies a URL.
// A trace is read or opened only if a traces answer for that cluster listed it, and a traces answer lists no trace
// whose spans name another cluster or namespace (security review of part 3, M3).
//
// Log lines are shown only to a person the cluster lets read pods/log in that namespace (a SelfSubjectAccessReview,
// as the doctor's fallback refuses on the kubelet's 403: review L1). Every read, the object check, the doctor's
// fallback and Open in Clickland go through the four-at-once limit, and one Open dialog per cluster at a time (L5).
// What main sends the window from Clickland is remembered (sibling-text.ts), so a question that quotes it holds the
// session's autonomy (M2).
import type { ClicklandLogs, ClicklandRange, ClicklandScope, ClicklandTrace, ClicklandTraces, KubeObject, MetricsReason } from "@landlens/contracts";
import { ClicklandClient, ClicklandError, ClicklandSearch, CL, consolePath, logsQuery, tracesQuery } from "@landlens/metrics";

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export type HistoryDeps = {
  /** Clickland's key and the origin it was saved for, while this build takes that origin (FamilyService). */
  key(): { origin: string; key: string } | undefined;
  /** The cluster's name in Clickland's data, for a kubeconfig context. */
  clusterName(context: string): string;
  /** The context of a connected cluster (throws 404 when it isn't connected). */
  context(handle: string): string;
  /** The object as the person can read it; undefined when it isn't there (404). Other failures throw. */
  object(handle: string, ref: { group: string; version: string; resource: string; namespace: string; name: string }): Promise<KubeObject | undefined>;
  /** Whether the doctor's report for this cluster names it (a problem's subject, or one of its pods). */
  known(handle: string, scope: ClicklandScope): boolean;
  /** The console's origin the person stored, while this build takes it (FamilyService.clicklandConsole). */
  console(): string | undefined;
  /** Whether the person may get pods/log in the namespace (a SelfSubjectAccessReview); false when it can't be asked. */
  canReadLogs(handle: string, namespace: string): Promise<boolean>;
  /** Text about to cross to the window: remembered, so a question that quotes it holds autonomy (M2). */
  served?(rows: { at?: string; body: string }[]): void;
  fetch?: typeof fetch;
  now?: () => number;
};

const REF: Record<ClicklandScope["kind"], { group: string; version: string; resource: string }> = {
  pod: { group: "", version: "v1", resource: "pods" },
  deployment: { group: "apps", version: "v1", resource: "deployments" },
  statefulset: { group: "apps", version: "v1", resource: "statefulsets" },
  daemonset: { group: "apps", version: "v1", resource: "daemonsets" },
};

const REASON: Record<ClicklandError["kind"], MetricsReason["code"]> = {
  unreachable: "clickland-unreachable",
  unauthorized: "clickland-unauthorized",
  failed: "clickland-failed",
  "no-cluster": "clickland-no-cluster",
};
export const CLICKLAND_OFF: MetricsReason = { code: "clickland-off", message: "Clickland isn't connected, so there is no history." };
const LABEL_VALUE = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
/** Reads at once per cluster. */
const LIMIT = 4;

/**
 * The service Clickland's collectors give an object's spans and lines (clickland/docs/sources.md): the pod's
 * `app.kubernetes.io/name` or `app` label, else its workload's name, else the container. A gone object: its name.
 */
export function serviceOf(scope: ClicklandScope, o: KubeObject | undefined): string {
  const labels = (scope.kind === "pod" ? o?.metadata.labels : (o?.spec as { template?: { metadata?: { labels?: Record<string, string> } } } | undefined)?.template?.metadata?.labels) ?? {};
  for (const k of ["app.kubernetes.io/name", "app"]) {
    const v = Object.hasOwn(labels, k) ? labels[k] : undefined;
    if (typeof v === "string" && LABEL_VALUE.test(v)) return v;
  }
  if (scope.kind !== "pod") return scope.name;
  const owner = o?.metadata.ownerReferences?.find((r) => r.controller);
  if (owner?.kind === "ReplicaSet") return owner.name.replace(/-[a-z0-9]{5,10}$/, "");
  if ((owner?.kind === "StatefulSet" || owner?.kind === "DaemonSet") && LABEL_VALUE.test(owner.name)) return owner.name;
  const first = ((o?.spec as { containers?: { name: string }[] } | undefined)?.containers ?? [])[0]?.name;
  return scope.container ?? first ?? scope.name;
}

export class ClicklandHistory {
  /** Reads in flight per cluster. */
  private readonly inflight = new Map<string, number>();
  /** Clusters with an Open in Clickland dialog up. */
  private readonly asking = new Set<string>();
  /** Trace ids a traces answer listed, per cluster (the newest 500). */
  private readonly listed = new Map<string, string[]>();
  private readonly now: () => number;

  constructor(private readonly deps: HistoryDeps) {
    this.now = deps.now ?? Date.now;
  }

  forget(handle: string) {
    this.listed.delete(handle);
    this.inflight.delete(handle);
    this.asking.delete(handle);
  }

  private search(): ClicklandSearch | undefined {
    const k = this.deps.key();
    return k ? new ClicklandSearch(new ClicklandClient({ url: k.origin, key: k.key }, this.deps.fetch), this.now) : undefined;
  }

  /** The object, if the window may ask about it: in the cluster as you read it, or in the doctor's report (D117). */
  private async check(handle: string, scope: ClicklandScope): Promise<KubeObject | undefined> {
    this.deps.context(handle);
    let o: KubeObject | undefined;
    try {
      o = await this.deps.object(handle, { ...REF[scope.kind], namespace: scope.namespace, name: scope.name });
    } catch (e) {
      const s = (e as { status?: number }).status;
      if (s === 401 || s === 403) throw fail(403, "You can't read that object, so Landlens doesn't ask Clickland about it.");
      throw fail(502, "Landlens couldn't check that object in the cluster.");
    }
    if (o || this.deps.known(handle, scope)) return o;
    throw fail(404, "Landlens doesn't know that object in this cluster, so it doesn't ask Clickland about it.");
  }

  /** At most four reads at once per cluster, the object check included (L5). */
  private async limited<T>(handle: string, f: () => Promise<T>): Promise<T> {
    const n = this.inflight.get(handle) ?? 0;
    if (n >= LIMIT) throw fail(429, "Too many Clickland reads at once; try again in a moment.");
    this.inflight.set(handle, n + 1);
    try {
      return await f();
    } finally {
      const left = (this.inflight.get(handle) ?? 1) - 1;
      if (left > 0) this.inflight.set(handle, left);
      else this.inflight.delete(handle);
    }
  }

  /** A log read only when the cluster would let the person read the pod's log (L1); nothing is sent otherwise. */
  private async mayReadLogs(handle: string, namespace: string) {
    if (!(await this.deps.canReadLogs(handle, namespace).catch(() => false)))
      throw fail(403, "You can't read pods' logs in this namespace, so Landlens doesn't show them from Clickland.");
  }

  private unavailable(e: unknown): { unavailable: MetricsReason } {
    if (e instanceof ClicklandError) return { unavailable: { code: REASON[e.kind], message: e.message } };
    throw e;
  }

  async logs(req: { handle: string; scope: ClicklandScope; range: ClicklandRange; filter?: string; errors?: boolean; before?: string }): Promise<ClicklandLogs> {
    this.deps.context(req.handle);
    return this.limited(req.handle, async () => {
      await this.check(req.handle, req.scope);
      await this.mayReadLogs(req.handle, req.scope.namespace);
      const s = this.search();
      if (!s) return { unavailable: CLICKLAND_OFF };
      const cluster = this.deps.clusterName(this.deps.context(req.handle));
      try {
        const page = await s.logs(cluster, req.scope, req.range, {
          ...(req.filter ? { filter: req.filter } : {}), ...(req.errors ? { errors: true } : {}), ...(req.before ? { before: req.before } : {}),
        });
        this.deps.served?.(page.rows);
        return { ...page, source: "clickland" as const, cluster };
      } catch (e) {
        return this.unavailable(e);
      }
    });
  }

  async traces(req: { handle: string; scope: ClicklandScope; range: ClicklandRange; errors?: boolean }): Promise<ClicklandTraces> {
    this.deps.context(req.handle);
    return this.limited(req.handle, async () => {
      const o = await this.check(req.handle, req.scope);
      const s = this.search();
      if (!s) return { unavailable: CLICKLAND_OFF };
      const service = serviceOf(req.scope, o);
      try {
        const cluster = this.deps.clusterName(this.deps.context(req.handle));
        const { traces, scoped } = await s.traces(service, req.range, req.errors, { cluster, namespace: req.scope.namespace });
        const ids = [...traces.map((t) => t.id), ...(this.listed.get(req.handle) ?? [])];
        this.listed.set(req.handle, [...new Set(ids)].slice(0, CL.spans));
        return { traces, service, scoped };
      } catch (e) {
        return this.unavailable(e);
      }
    });
  }

  async trace(req: { handle: string; id: string }): Promise<ClicklandTrace> {
    this.deps.context(req.handle);
    if (!this.listed.get(req.handle)?.includes(req.id)) throw fail(404, "That trace isn't one Landlens listed for this cluster.");
    const s = this.search();
    if (!s) return { unavailable: CLICKLAND_OFF };
    return this.limited(req.handle, async () => {
      try {
        return await s.trace(req.id);
      } catch (e) {
        return this.unavailable(e);
      }
    });
  }

  /**
   * The console's address for this object's logs or traces (or one listed trace), opened after the native dialog that
   * shows its host (D118). No console address set: refused, nothing asked. The console is the one FamilyService gives
   * (its origin rule and this build's hosts already applied: L3); a name Clickland can't be asked about is a 409 in
   * Landlens's words. One dialog per cluster at a time, inside the four-reads limit (L5).
   */
  async open(
    req: { handle: string; scope: ClicklandScope; signal: "logs" | "traces"; range: ClicklandRange; errors?: boolean; trace?: string },
    ask: { confirm(q: { message: string; detail: string; yes: string }): Promise<boolean>; openExternal(url: string): Promise<void> },
  ): Promise<{ opened: boolean }> {
    const console = this.deps.console();
    if (!console) throw fail(409, "Set Clickland's console address first (Connections → Clickland → Settings).");
    this.deps.context(req.handle);
    if (this.asking.has(req.handle)) throw fail(409, "An Open in Clickland dialog is already open.");
    this.asking.add(req.handle);
    try {
      const u = await this.limited(req.handle, async () => {
        const o = await this.check(req.handle, req.scope);
        let path: string;
        try {
          if (req.trace) {
            if (!this.listed.get(req.handle)?.includes(req.trace)) throw fail(404, "That trace isn't one Landlens listed for this cluster.");
            path = `/traces/${req.trace}`;
          } else if (req.signal === "logs") {
            path = consolePath("logs", logsQuery(this.deps.clusterName(this.deps.context(req.handle)), req.scope, { ...(req.errors ? { errors: true } : {}) }), req.range, this.now());
          } else {
            path = consolePath("traces", tracesQuery(serviceOf(req.scope, o), req.errors), req.range, this.now());
          }
        } catch (e) {
          if (e instanceof ClicklandError) throw fail(409, "Landlens can't build a Clickland search for this cluster's name or this object.");
          throw e;
        }
        const url = new URL(path, console);
        if (url.origin !== new URL(console).origin) throw fail(400, "not a console address");
        return url;
      });
      // Main's own words: the window can set the console's address, so the dialog says what it is, not who (L4).
      const yes = await ask.confirm({ message: `Open ${u.host} in your browser?`, detail: `The address saved as Clickland's console (${u.host}):\n${u.href.slice(0, 500)}`, yes: "Open" });
      if (yes) await ask.openExternal(u.href);
      return { opened: yes };
    } finally {
      this.asking.delete(req.handle);
    }
  }

  /**
   * The doctor's fallback (D118): when the kubelet has neither run of a container, its last lines from Clickland,
   * oldest first, with the newest one's time. The first of up to three pods with lines answers; nothing when Clickland
   * isn't connected or fails, or four reads are already running (L5: nothing is sent). A pod that exists is searched
   * only from its creation, so a pod name another incarnation used (db-0) doesn't bring that one's lines (L8).
   */
  async lastLines(handle: string, q: { namespace: string; pods: string[]; container: string }): Promise<{ pod: string; lines: string[]; cut: boolean; newest?: string } | undefined> {
    const s = this.search();
    if (!s) return undefined;
    let cluster: string;
    try {
      cluster = this.deps.clusterName(this.deps.context(handle));
    } catch {
      return undefined;
    }
    if ((this.inflight.get(handle) ?? 0) >= LIMIT) return undefined;
    return this.limited(handle, async () => {
      for (const pod of q.pods.slice(0, 3)) {
        try {
          const o = await this.deps.object(handle, { ...REF.pod, namespace: q.namespace, name: pod }).catch(() => undefined);
          const created = o?.metadata.creationTimestamp ? Date.parse(o.metadata.creationTimestamp) : undefined;
          const page = await s.logs(cluster, { kind: "pod", namespace: q.namespace, name: pod, container: q.container }, "7d", { limit: 200, ...(created !== undefined && Number.isFinite(created) ? { since: created } : {}) });
          if (page.rows.length) {
            this.deps.served?.(page.rows);
            return { pod, lines: page.rows.map((r) => r.body).reverse(), cut: page.cut || !!page.next, newest: page.rows[0]!.at };
          }
        } catch {
          return undefined;
        }
      }
      return undefined;
    }).catch(() => undefined);
  }
}

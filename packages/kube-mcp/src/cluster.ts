// How the MCP tools reach the cluster: through the front door, with the agent session's own read-only token, so
// every read is checked by the same policy and lands in the same audit trail as the agent's kubectl.
import { request } from "node:https";
import type { MetricsRange, MetricsScope, MetricsSeries, ResourceType } from "@landlens/contracts";
import { apiPath, KubeError, toKubeError } from "@landlens/kube";

export type AgentCluster = {
  /** e.g. "orbstack" */
  context: string;
  get(path: string, accept?: string): Promise<{ status: number; text: string }>;
  types(): Promise<ResourceType[]>;
  /** Namespaces the session is limited to, if any. */
  namespaces?: string[];
  /**
   * The same cluster, with every request tagged with one gateway call's id (X-Landlens-Call), so the front door's
   * audit can say which MCP call asked for what.
   */
  withCall?(callId: string): AgentCluster;
  /** CPU and memory over time from Landlens's metrics source (Clickland, else metrics-server), when main offers it. */
  metrics?(req: { scope: MetricsScope; namespace?: string; name?: string; range: MetricsRange }): Promise<MetricsSeries>;
};

/** The header a gateway call's id travels in to the front door. The front door reads it and never forwards it. */
export const CALL_HEADER = "X-Landlens-Call";

export function frontDoorCluster(opts: {
  url: string; // the front door's cluster URL: https://127.0.0.1:<port>/c/<handle>
  certificate: string;
  token: string;
  context: string;
  types: () => Promise<ResourceType[]>;
  namespaces?: string[];
  /**
   * Landlens's metrics source. `read` GETs JSON through this cluster (the front door, this session's token, tagged
   * with the call), for what the series needs from the cluster itself: requests, limits, allocatable, a workload's
   * pods. The usage numbers come from Clickland or the shared metrics-server sampler.
   */
  metrics?: (req: Parameters<NonNullable<AgentCluster["metrics"]>>[0], read: (path: string) => Promise<any>) => Promise<MetricsSeries>;
  /** Tags every request for the front door's audit (see withCall). */
  callId?: string;
}): AgentCluster {
  const self: AgentCluster = {
    context: opts.context,
    types: opts.types,
    ...(opts.namespaces ? { namespaces: opts.namespaces } : {}),
    withCall: (callId) => frontDoorCluster({ ...opts, callId }),
    get: (path, accept = "application/json") =>
      new Promise((resolve, reject) => {
        const headers: Record<string, string> = { Authorization: `Bearer ${opts.token}`, Accept: accept };
        if (opts.callId) headers[CALL_HEADER] = opts.callId;
        const req = request(
          opts.url + path,
          { method: "GET", ca: opts.certificate, headers, timeout: 30_000 },
          (res) => {
            let text = "";
            res.setEncoding("utf8").on("data", (d) => (text += d)).on("end", () => resolve({ status: res.statusCode ?? 0, text }));
          },
        );
        req.on("timeout", () => req.destroy(new Error("the cluster took longer than 30 s")));
        req.on("error", reject);
        req.end();
      }),
  };
  if (opts.metrics) self.metrics = (req) => opts.metrics!(req, (path) => getJson(self, path));
  return self;
}

export async function getJson(c: AgentCluster, path: string): Promise<any> {
  const r = await c.get(path);
  if (r.status < 200 || r.status >= 300) throw toKubeError(r.status, r.text);
  return JSON.parse(r.text);
}

export async function getText(c: AgentCluster, path: string): Promise<string> {
  const r = await c.get(path, "*/*"); // the log endpoint answers 406 to text/plain
  if (r.status < 200 || r.status >= 300) throw toKubeError(r.status, r.text);
  return r.text;
}

/**
 * Find the kind the agent means: "pods", "pod", "po", "Pod", "deploy", "deployments.apps", "Deployment.apps".
 * Prefers built-in groups when a name is ambiguous.
 */
export function resolveKind(types: ResourceType[], input: string): ResourceType {
  const raw = input.trim();
  const [name, ...groupParts] = raw.split(".");
  const group = groupParts.join(".");
  const n = name!.toLowerCase();
  const matches = types.filter((t) => {
    if (raw.includes(".") && t.group !== group) return false;
    const singular = t.kind.toLowerCase();
    return t.resource === n || singular === n || SHORT[n] === t.resource || t.shortNames?.includes(n);
  });
  if (!matches.length) throw new KubeError(404, `Unknown kind "${input}". Use api_resources to list the kinds this cluster serves.`);
  const rank = (t: ResourceType) => (t.group === "" ? 0 : t.group.endsWith(".k8s.io") || !t.group.includes(".") ? 1 : 2);
  return [...matches].sort((a, b) => rank(a) - rank(b))[0]!;
}

const SHORT: Record<string, string> = {
  po: "pods", deploy: "deployments", svc: "services", ns: "namespaces", no: "nodes", cm: "configmaps", ev: "events",
  rs: "replicasets", sts: "statefulsets", ds: "daemonsets", ing: "ingresses", pvc: "persistentvolumeclaims",
  pv: "persistentvolumes", sa: "serviceaccounts", hpa: "horizontalpodautoscalers", cj: "cronjobs", crd: "customresourcedefinitions",
  netpol: "networkpolicies", pdb: "poddisruptionbudgets", sc: "storageclasses", ep: "endpoints",
};

export const pathFor = apiPath;

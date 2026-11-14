// How the MCP tools reach the cluster: through the front door, with the agent session's own read-only token, so
// every read is checked by the same policy and lands in the same audit trail as the agent's kubectl.
import { request } from "node:https";
import type { ResourceType } from "@landlens/contracts";
import { apiPath, KubeError, toKubeError } from "@landlens/kube";

export type AgentCluster = {
  /** e.g. "orbstack" */
  context: string;
  get(path: string, accept?: string): Promise<{ status: number; text: string }>;
  types(): Promise<ResourceType[]>;
  /** Namespaces the session is limited to, if any. */
  namespaces?: string[];
};

export function frontDoorCluster(opts: {
  url: string; // the front door's cluster URL: https://127.0.0.1:<port>/c/<handle>
  certificate: string;
  token: string;
  context: string;
  types: () => Promise<ResourceType[]>;
  namespaces?: string[];
}): AgentCluster {
  return {
    context: opts.context,
    types: opts.types,
    ...(opts.namespaces ? { namespaces: opts.namespaces } : {}),
    get: (path, accept = "application/json") =>
      new Promise((resolve, reject) => {
        const req = request(
          opts.url + path,
          { method: "GET", ca: opts.certificate, headers: { Authorization: `Bearer ${opts.token}`, Accept: accept }, timeout: 30_000 },
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
}

export async function getJson(c: AgentCluster, path: string): Promise<any> {
  const r = await c.get(path);
  if (r.status < 200 || r.status >= 300) throw toKubeError(r.status, r.text);
  return JSON.parse(r.text);
}

export async function getText(c: AgentCluster, path: string): Promise<string> {
  const r = await c.get(path, "text/plain");
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

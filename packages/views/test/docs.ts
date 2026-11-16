// Documents for the tests: one that uses every block and source kind of part 1, and a builder for small ones.
export const full = () => ({
  schema: 1,
  title: "Everything in landlens-dev",
  params: [
    { name: "ns", type: "namespace", label: "Namespace", default: "landlens-dev" },
    { name: "tier", type: "choice", options: ["web", "worker"], default: "web" },
    { name: "q", type: "text", default: "api" },
  ],
  sources: {
    pods: {
      kind: "kube.list", resource: "pods", namespace: { param: "ns" }, labelSelector: "app in (shop, ledger),tier!=db", fieldSelector: "status.phase=Running",
      fields: { name: "$name", restarts: "$restarts", node: "$node", app: 'metadata.labels["app.kubernetes.io/name"]', images: "spec.containers[*].image" },
      pipe: [{ filter: [{ field: "name", op: "contains", value: { param: "q" } }] }, { sort: [{ field: "restarts", dir: "desc" }] }, { limit: 50 }],
    },
    deploys: { kind: "kube.list", resource: "deployments", group: "apps", namespace: "*", fields: { key: "$key", replicas: "$replicas" } },
    events: { kind: "kube.events", namespace: { param: "ns" }, warningsOnly: true, sinceMinutes: 60 },
    logs: { kind: "kube.logs", namespace: "landlens-dev", workload: { kind: "Deployment", name: "api" }, tailLines: 200 },
    top: { kind: "kube.top", of: "pods", namespace: "landlens-dev", pipe: [{ group: { by: [], agg: { cpu: { fn: "sum", field: "cpu" } } } }] },
    usage: { kind: "metrics.series", scope: "namespace", namespace: "landlens-dev", range: "1h" },
    problems: { kind: "doctor.problems", namespace: "*" },
    helm: { kind: "helm.releases" },
  },
  blocks: [
    { type: "table", source: "pods", columns: [{ field: "name" }, { field: "restarts", format: "number", width: 90 }], select: true, span: 12, title: "Pods" },
    { type: "stat", source: "top", field: "cpu", label: "CPU now", format: "cpu", span: 3 },
    { type: "chart", source: "usage", kind: "line", y: ["cpu"], unit: "cpu", span: 6 },
    { type: "chart", source: "deploys", kind: "bar", x: "key", y: ["replicas"] },
    { type: "list", source: "events", primary: "reason", secondary: "message", max: 20 },
    { type: "logs", source: "logs", failuresOnly: true },
    { type: "problems", source: "problems" },
    { type: "text", markdown: "## Notes\nRead with **Claude's** access.\n\t- indented" },
    { type: "app", id: "pod-count", uses: ["pods"], html: "<div id=n></div>", css: "#n{font-size:32px}", js: "view.onData('pods', d => n.textContent = String(d.rows.length))", fill: false, minHeight: 120 },
  ],
});

export const small = (o: { sources?: Record<string, unknown>; blocks?: unknown[]; params?: unknown[]; [k: string]: unknown } = {}) => ({
  schema: 1,
  title: "A view",
  sources: { pods: { kind: "kube.list", resource: "pods", namespace: "landlens-dev" } },
  blocks: [{ type: "table", source: "pods", columns: [{ field: "name" }] }],
  ...o,
});

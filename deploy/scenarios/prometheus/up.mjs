// Starts the Prometheus scenario in landlens-dev on OrbStack: the last 50 minutes of cAdvisor-shaped series for the
// landlens-demo chart's pods (CPU about 0.05 and 0.08 cores, memory about 20 and 30 MiB) and for the node, written as
// OpenMetrics into a ConfigMap and backfilled by prometheus.yaml's init container. Needs the demo chart installed.
// node deploy/scenarios/prometheus/up.mjs
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const kubectl = (args, input) => execFileSync("kubectl", ["--context", "orbstack", "-n", "landlens-dev", ...args], { input, encoding: "utf8" });

const pods = kubectl(["get", "pods", "-l", "app.kubernetes.io/instance=landlens-demo", "-o", "jsonpath={.items[*].metadata.name}"]).trim().split(/\s+/).filter(Boolean);
if (!pods.length) throw new Error("No landlens-demo pods: install the chart first (deploy/scenarios/helm/README.md).");
const node = kubectl(["get", "pods", pods[0], "-o", "jsonpath={.spec.nodeName}"]).trim();

const now = Math.floor(Date.now() / 1000);
const times = [];
for (let t = now - 50 * 60; t <= now - 60; t += 15) times.push(t);
const cpu = [];
const mem = [];
pods.forEach((pod, i) => {
  const rate = 0.05 + 0.03 * i;
  const labels = `namespace="landlens-dev",pod="${pod}",container="app",id="/kubepods/${pod}/app",node="${node}"`;
  times.forEach((t, k) => cpu.push(`container_cpu_usage_seconds_total{${labels}} ${(rate * 15 * k).toFixed(3)} ${t}`));
  times.forEach((t, k) => mem.push(`container_memory_working_set_bytes{${labels}} ${(20 + 10 * i) * 1048576 + (k % 7) * 65536} ${t}`));
});
times.forEach((t, k) => cpu.push(`container_cpu_usage_seconds_total{id="/",node="${node}"} ${(0.9 * 15 * k).toFixed(3)} ${t}`));
times.forEach((t) => mem.push(`container_memory_working_set_bytes{id="/",node="${node}"} ${3 * 1073741824} ${t}`));
const om = ["# TYPE container_cpu_usage_seconds_total counter", ...cpu, "# TYPE container_memory_working_set_bytes gauge", ...mem, "# EOF", ""].join("\n");

// The old Prometheus goes first, so no pod is left mounting a ConfigMap that isn't there.
kubectl(["delete", "-f", join(here, "prometheus.yaml"), "--ignore-not-found", "--wait=true"]);
kubectl(["delete", "configmap", "landlens-prometheus-data", "--ignore-not-found"]);
kubectl(["create", "configmap", "landlens-prometheus-data", "--from-file=series.om=/dev/stdin"], om);
kubectl(["apply", "-f", join(here, "prometheus.yaml")]);
kubectl(["rollout", "status", "deploy/landlens-prometheus", "--timeout=180s"]);
console.log(`Prometheus up in landlens-dev with ${pods.length} pods' series on ${node}: ${pods.join(", ")}`);

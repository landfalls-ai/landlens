// Prometheus as the metrics source against OrbStack: the scenario's Prometheus in landlens-dev (deploy/scenarios/
// prometheus), found by its Helm labels and asked through the API server's service proxy as you, through the
// sidecar. Needs the landlens-demo chart; starts the scenario and removes it afterwards.
// LANDLENS_INTEGRATION=orbstack pnpm --filter @landlens/metrics test:integration
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClusterManager, FrontDoor, loopbackCert } from "@landlens/kube";
import { findPrometheus, prometheusSeries } from "../src/prometheus.js";
import { MetricsService } from "../src/service.js";

const run = (process.env.LANDLENS_INTEGRATION ?? "").split(",").includes("orbstack");
const ROOT = resolve(__dirname, "../../..");
const SIDECAR = resolve(ROOT, "sidecar/kube-proxy/bin/landlens-kube-proxy");
const kubectl = (...args: string[]) => execFileSync("kubectl", ["--context", "orbstack", "-n", "landlens-dev", ...args], { encoding: "utf8" });

describe.runIf(run)("Prometheus on OrbStack", () => {
  let door: FrontDoor;
  let clusters: ClusterManager;
  let handle = "";
  let pods: string[] = [];
  const get = (path: string) => clusters.get(handle).client.json(path);

  beforeAll(async () => {
    execFileSync("node", [resolve(ROOT, "deploy/scenarios/prometheus/up.mjs")], { stdio: "ignore" });
    pods = kubectl("get", "pods", "-l", "app.kubernetes.io/instance=landlens-demo", "-o", "jsonpath={.items[*].metadata.name}").trim().split(/\s+/).sort();
    door = new FrontDoor(await loopbackCert(SIDECAR), () => undefined);
    clusters = new ClusterManager({ sidecarBinary: SIDECAR, frontDoor: door });
    await door.start();
    handle = (await clusters.connect("orbstack")).handle;
  }, 300_000);

  afterAll(async () => {
    await clusters?.disconnectAll();
    await door?.stop();
    if (run) {
      kubectl("delete", "-f", resolve(ROOT, "deploy/scenarios/prometheus/prometheus.yaml"), "--ignore-not-found", "--wait=true");
      kubectl("delete", "configmap", "landlens-prometheus-data", "--ignore-not-found");
    }
  }, 120_000);

  it("finds the scenario's Prometheus by the Helm chart's labels", async () => {
    expect(await findPrometheus(get)).toEqual({ namespace: "landlens-dev", service: "landlens-prometheus", port: "80", scheme: "http", provider: "helm" });
  }, 30_000);

  it("draws the demo deployment per pod, with its spec's requests and limits", async () => {
    const t = (await findPrometheus(get))!;
    const s = await prometheusSeries(get, get, t, { scope: "deployment", namespace: "landlens-dev", name: "landlens-demo", range: "1h" });
    expect(s.source).toBe("prometheus");
    expect(s.cpu.series.map((l) => l.key).sort()).toEqual(pods);
    for (const l of s.cpu.series) {
      expect(l.points.length).toBeGreaterThan(100);
      const mid = l.points[Math.floor(l.points.length / 2)]![1];
      expect(mid).toBeGreaterThan(0.04);
      expect(mid).toBeLessThan(0.09);
    }
    expect(s.memory.series.map((l) => l.key).sort()).toEqual(pods);
    expect(s.cpu.request).toBeCloseTo(0.005);
    expect(s.memory.limit).toBe(32 * 1048576);
  }, 60_000);

  it("is offered, not used, until it is chosen", async () => {
    const m = new MetricsService({ clickland: () => ({ clusterName: (x) => x }), cluster: () => ({ context: "orbstack", get }), prometheus: { chosen: () => undefined } });
    const s = await m.series({ handle, scope: "cluster", range: "1h" });
    expect(s).toMatchObject({ source: "none", prometheusFound: "landlens-dev/landlens-prometheus" });
    expect(await m.foundPrometheus(handle)).toBe("landlens-dev/landlens-prometheus");
    m.stopAll();
  }, 60_000);

  it("is the source the IDE picks with no Clickland once chosen, for a pod, a namespace and the cluster", async () => {
    const ask = (path: string) => clusters.get(handle).client.jsonCapped(path, { maxBytes: 8 * 1048576, timeoutMs: 10_000 });
    const m = new MetricsService({ clickland: () => ({ clusterName: (x) => x }), cluster: () => ({ context: "orbstack", get, ask }), prometheus: { chosen: () => "landlens-dev/landlens-prometheus" } });
    const pod = await m.series({ handle, scope: "pod", namespace: "landlens-dev", name: pods[0]!, range: "1h" });
    expect(pod).toMatchObject({ source: "prometheus", by: "container", prometheus: "landlens-dev/landlens-prometheus" });
    expect(pod.cpu.series.map((l) => l.key)).toEqual(["app"]);
    const ns = await m.series({ handle, scope: "namespace", namespace: "landlens-dev", range: "1h" });
    expect(ns.cpu.series.map((l) => l.key).sort()).toEqual(pods);
    const cluster = await m.series({ handle, scope: "cluster", range: "1h" });
    expect(cluster.cpu.series.map((l) => l.key)).toEqual(["orbstack"]);
    expect(cluster.cpu.allocatable).toBeGreaterThan(0);
    expect(cluster.namespaces?.map((n) => n.key)).toEqual(["landlens-dev"]);
    m.stopAll();
  }, 60_000);
});

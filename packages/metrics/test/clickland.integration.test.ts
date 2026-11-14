// Real series from a running Clickland for the scenario workloads in landlens-dev (deploy/scenarios/crashloop.yaml and
// metrics.yaml). Runs when LANDLENS_INTEGRATION names both `orbstack` and `clickland`:
//   LANDLENS_INTEGRATION=orbstack,clickland pnpm --filter @landlens/metrics test:integration
// LANDLENS_CLICKLAND_URL (default http://127.0.0.1:4710) must be a Clickland with metric filters (its specs/001). The
// test makes its own read-scoped key with Clickland's development bootstrap key and revokes it afterwards.
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClicklandClient, honoursFilters } from "../src/clickland.js";
import { clicklandSeries } from "../src/clickland-series.js";

const flags = (process.env.LANDLENS_INTEGRATION ?? "").split(",");
const run = flags.includes("orbstack") && flags.includes("clickland");
const URL_ = process.env.LANDLENS_CLICKLAND_URL ?? "http://127.0.0.1:4710";
const ADMIN = process.env.CLICKLAND_BOOTSTRAP_KEY ?? "ck_dev_bootstrap_key_000000000000000";
const MIB = 2 ** 20;

const podOf = (app: string) =>
  execFileSync("kubectl", ["--context", "orbstack", "-n", "landlens-dev", "get", "pods", "-l", `app=${app}`, "-o", "jsonpath={.items[0].metadata.name}"], { encoding: "utf8" }).trim();

describe.runIf(run)("Clickland series for landlens-dev (live)", () => {
  let id = "";
  let client: ClicklandClient;

  beforeAll(async () => {
    const res = await fetch(`${URL_}/api/keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "landlens-integration", scopes: ["read"] }),
    });
    expect(res.status).toBe(201);
    const key = (await res.json()) as { id: string; key: string };
    id = key.id;
    client = new ClicklandClient({ url: URL_, key: key.key });
  });

  afterAll(async () => {
    if (id) await fetch(`${URL_}/api/keys/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${ADMIN}` } });
  });

  it("is a Clickland that honours metric filters", async () => {
    expect(await honoursFilters(client)).toBe(true);
  });

  it("reads orders-api (crash-looping): its requests and limit from cluster state, no usage from a container that never runs", async () => {
    const pod = podOf("orders-api");
    const s = await clicklandSeries(client, "orbstack", { scope: "pod", namespace: "landlens-dev", name: pod, range: "1h" });
    expect(s).toMatchObject({ source: "clickland", by: "container", cluster: "orbstack" });
    expect(s.cpu.request).toBeCloseTo(0.01, 5);
    expect(s.memory.request).toBe(16 * MIB);
    expect(s.memory.limit).toBe(32 * MIB);
    expect(s.cpu.limit).toBeUndefined(); // the spec sets no CPU limit
    expect(s.cpu.byKey).toEqual({ api: { request: 0.01 } });
    for (const line of s.cpu.series) expect(line.key).toBe("api"); // never another pod's containers
    const dep = await clicklandSeries(client, "orbstack", { scope: "deployment", namespace: "landlens-dev", name: "orders-api", range: "6h" });
    expect(dep).toMatchObject({ by: "pod", memory: { request: 16 * MIB, limit: 32 * MIB } });
  });

  it("reads catalog-api: CPU and memory per container over the last hour, with the pod's request and limit", async () => {
    const pod = podOf("catalog-api");
    const s = await clicklandSeries(client, "orbstack", { scope: "pod", namespace: "landlens-dev", name: pod, range: "1h" });
    expect(s.cpu.series.map((l) => l.key).sort()).toEqual(["api", "proxy"]);
    expect(s.cpu.series.find((l) => l.key === "api")!.points.length).toBeGreaterThan(3);
    expect(s.cpu).toMatchObject({ limit: 0.25 });
    expect(s.cpu.request).toBeCloseTo(0.06, 5);
    expect(s.memory).toMatchObject({ request: 40 * MIB, limit: 112 * MIB });
    const mem = Math.max(...s.memory.series.find((l) => l.key === "api")!.points.map((p) => p[1]));
    expect(mem).toBeGreaterThan(8 * MIB); // it holds 8 to 40 MiB
    expect(mem).toBeLessThan(96 * MIB);
  });

  it("reads the cluster: per node, against allocatable, and namespaces with landlens-dev among them", async () => {
    const s = await clicklandSeries(client, "orbstack", { scope: "cluster", range: "1h" });
    expect(s.cpu.series.map((l) => l.key)).toContain("orbstack");
    expect(s.cpu.allocatable).toBeGreaterThan(0);
    expect(s.memory.allocatable).toBeGreaterThan(0);
    expect(s.namespaces!.map((n) => n.key)).toContain("landlens-dev");
  });
});

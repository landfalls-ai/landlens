// The doctor against the OrbStack cluster, read as you through the front door: LANDLENS_INTEGRATION=orbstack
// pnpm test:integration. Starts deploy/scenarios/doctor (landlens-dev only) and checks each broken scenario shows up
// as its expected problem, with Landlens's suggestion. Certificates aren't checked on this path (it reads no
// Secrets); the main-process service's tests cover them.
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClusterHealth } from "@landlens/contracts";
import { ClusterManager } from "../src/clusters.js";
import { FrontDoor } from "../src/frontdoor.js";
import { clusterHealth } from "../src/health.js";
import { loopbackCert } from "../src/sidecar.js";

const run = (process.env.LANDLENS_INTEGRATION ?? "").split(",").includes("orbstack");
const exec = promisify(execFile);
const SIDECAR = resolve(__dirname, "../../../sidecar/kube-proxy/bin/landlens-kube-proxy");
const UP = resolve(__dirname, "../../../deploy/scenarios/doctor/up.mjs");
const NS = "landlens-dev";

const EXPECTED: [name: string, cls: string, cause: RegExp, podCount?: number][] = [
  ["orders-api", "crashloop", /exits with code 1/],
  ["ledger-worker", "crashloop", /exits with code 2/, 5],
  ["gpu-trainer", "pending", /labels this pod asks for/],
  ["thumbnailer", "oom", /24Mi/],
  ["cart-api", "probe", /readiness probe \(tcp :8081\)/],
  ["search-indexer", "probe", /liveness probe/],
  ["reports", "image", /registry\.invalid/],
  ["invoice-renderer", "pending", /ConfigMap, Secret or claim/],
  ["invoice-archive", "warning", /storage class/],
];

describe.runIf(run)("the doctor on OrbStack", () => {
  let door: FrontDoor;
  let clusters: ClusterManager;
  let handle = "";

  beforeAll(async () => {
    await exec("node", [UP]);
    door = new FrontDoor(await loopbackCert(SIDECAR), () => undefined);
    clusters = new ClusterManager({ sidecarBinary: SIDECAR, frontDoor: door });
    await door.start();
    handle = (await clusters.connect("orbstack")).handle;
  }, 120_000);

  afterAll(async () => {
    await clusters?.disconnectAll();
    await door?.stop();
  });

  it("finds every broken scenario in landlens-dev, grouped, with a suggestion", async () => {
    const client = clusters.get(handle).client;
    const get = (path: string) => client.json(path);
    let h: ClusterHealth | undefined;
    const missing = () => EXPECTED.filter(([name, cls]) => !h?.problems.some((p) => p.name === name && p.class === cls)).map(([n]) => n);
    // Pending and not-ready wait 2 minutes before they count, so give a fresh start up to 4.
    for (let i = 0; i < 48; i++) {
      h = await clusterHealth(get, { namespace: NS });
      if (!missing().length) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    expect(missing()).toEqual([]);
    for (const [name, cls, cause, podCount] of EXPECTED) {
      const p = h!.problems.find((x) => x.name === name && x.class === cls)!;
      expect(p.hint.cause, name).toMatch(cause);
      if (podCount) expect(p.podCount, name).toBe(podCount);
    }
    expect(h!.problems.filter((p) => p.name === "ledger-worker")).toHaveLength(1);
    expect(h!.checks).toMatchObject({ pods: "ok", workloads: "ok", events: "ok", nodes: "off" });
  }, 300_000);
});

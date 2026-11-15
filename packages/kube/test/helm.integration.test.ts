// Helm releases against the OrbStack cluster, read as you through the front door: LANDLENS_INTEGRATION=orbstack
// pnpm test:integration. Needs the landlens-demo chart's two revisions in landlens-dev (deploy/scenarios/helm/README.md);
// writes nothing.
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClusterManager } from "../src/clusters.js";
import { FrontDoor } from "../src/frontdoor.js";
import { getRelease, listReleases } from "../src/helm.js";
import { loopbackCert } from "../src/sidecar.js";

const run = (process.env.LANDLENS_INTEGRATION ?? "").split(",").includes("orbstack");
const exec = promisify(execFile);
const SIDECAR = resolve(__dirname, "../../../sidecar/kube-proxy/bin/landlens-kube-proxy");
const NS = "landlens-dev";
// The chart's dummy development values: none may reach the window.
const DUMMIES = /demo-dev-password|demo-dev-api-key|ZGVtby1kZXYtcGFzc3dvcmQ/;

describe.runIf(run)("Helm releases on OrbStack", () => {
  let door: FrontDoor;
  let clusters: ClusterManager;
  let handle = "";

  beforeAll(async () => {
    const h = await exec("helm", ["--kube-context", "orbstack", "-n", NS, "history", "landlens-demo", "-o", "json"]);
    expect(JSON.parse(h.stdout).length, "install the demo chart first (deploy/scenarios/helm/README.md)").toBeGreaterThanOrEqual(2);
    door = new FrontDoor(await loopbackCert(SIDECAR), () => undefined);
    clusters = new ClusterManager({ sidecarBinary: SIDECAR, frontDoor: door });
    await door.start();
    handle = (await clusters.connect("orbstack")).handle;
  }, 120_000);

  afterAll(async () => {
    await clusters?.disconnectAll();
    await door?.stop();
  });

  it("lists the demo release at its latest revision, in its namespace and across all", async () => {
    const client = clusters.get(handle).client;
    const { releases, unreadable } = await listReleases(client, NS);
    expect(unreadable).toBe(0);
    const demo = releases.find((r) => r.name === "landlens-demo")!;
    expect(demo).toMatchObject({ namespace: NS, status: "deployed", chart: "landlens-demo", chartVersion: "0.1.0", appVersion: "1.0.0" });
    expect(demo.revision).toBeGreaterThanOrEqual(2);
    expect((await listReleases(client)).releases.some((r) => r.name === "landlens-demo" && r.namespace === NS)).toBe(true);
  }, 60_000);

  it("reads values, manifest, notes, objects and history with no secret value in them", async () => {
    const client = clusters.get(handle).client;
    const d = await getRelease(client, NS, "landlens-demo");
    expect(d.values.user).toMatch(/message: hi/);
    expect(d.hidden).toEqual({ user: 0, all: 2 });
    expect(d.values.all).toMatch(/adminPassword: <hidden · 17 characters>/);
    expect(d.values.all).toMatch(/apiKey: <hidden · 16 characters>/);
    expect(d.manifest).toMatch(/password: <hidden · \d+ base64 characters>/);
    expect(d.manifest).toMatch(/api-key: <hidden/);
    for (const text of [d.values.user, d.values.all, d.manifest, d.notes]) expect(text).not.toMatch(DUMMIES);
    expect(d.notes).toContain("landlens-demo is running in landlens-dev");
    expect(d.objects.map((o) => `${o.kind}/${o.name}`).sort()).toEqual(["ConfigMap/landlens-demo", "Deployment/landlens-demo", "Secret/landlens-demo-auth"]);
    expect(d.history.at(-1)).toMatchObject({ revision: 1, status: "superseded", description: "Install complete" });
    const first = await getRelease(client, NS, "landlens-demo", 1);
    expect(first.values.user).toBe("");
    expect(first.release.status).toBe("superseded");
  }, 60_000);
});

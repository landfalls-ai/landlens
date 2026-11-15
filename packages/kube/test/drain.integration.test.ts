// The drain's [check] against OrbStack (wave 8 part 2, D151, D169): LANDLENS_INTEGRATION=orbstack pnpm test:integration.
// Needs the hands scenario (node deploy/scenarios/hands/up.mjs). Does an eviction dry run report a budget's block
// without spending the budget, and change nothing? The source says so (kubernetes v1.36.0,
// pkg/registry/core/pod/storage/eviction.go: checkAndDecrement returns before UpdateStatus on a dry run, and the
// pod's delete carries the dry run); this checks it live.
//
// What it touches: no node is written to, dry run or not. Every request that isn't a GET is a dry-run eviction of a
// hands-* pod in landlens-dev, and a test-local fence refuses anything else before it leaves. The only real write is a
// throwaway PodDisruptionBudget (hands-dry-*, labelled scenario=hands) made and deleted by kubectl in landlens-dev.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { frontDoorSend } from "../../kube-mcp/src/cluster.js";
import type { Send } from "../src/changes.js";
import { ClusterManager } from "../src/clusters.js";
import { dryRunEvictions, evictionRequest, readDrain } from "../src/drain.js";
import { FrontDoor } from "../src/frontdoor.js";
import { loopbackCert } from "../src/sidecar.js";

const run = (process.env.LANDLENS_INTEGRATION ?? "").split(",").includes("orbstack");
const exec = promisify(execFile);
const SIDECAR = resolve(__dirname, "../../../sidecar/kube-proxy/bin/landlens-kube-proxy");
const NS = "landlens-dev";
const kubectl = async (...args: string[]) => (await exec("kubectl", ["--context", "orbstack", "-n", NS, ...args])).stdout;
const json = async (...args: string[]) => JSON.parse(await kubectl(...args, "-o", "json"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Only reads, and dry-run evictions of hands-* pods in landlens-dev: anything else is refused here, unsent. */
const DRY_EVICTION = /^\/api\/v1\/namespaces\/landlens-dev\/pods\/hands-[a-z0-9-]+\/eviction\?dryRun=All$/;
function fence(send: Send, sent: { method: string; path: string }[]): Send {
  return async (r) => {
    if (r.method !== "GET") {
      const body = JSON.parse(r.body ?? "{}");
      if (r.method !== "POST" || !DRY_EVICTION.test(r.path) || JSON.stringify(body.deleteOptions?.dryRun) !== '["All"]') throw new Error(`refused by the test's fence: ${r.method} ${r.path}`);
    }
    sent.push({ method: r.method, path: r.path });
    return send(r);
  };
}

/** A budget's status without the times the controller rewrites on every sync. */
const budget = (s: any) => ({ disruptionsAllowed: s.disruptionsAllowed, currentHealthy: s.currentHealthy, desiredHealthy: s.desiredHealthy, expectedPods: s.expectedPods, disruptedPods: s.disruptedPods ?? {} });

describe.runIf(run)("drain's dry runs on OrbStack", () => {
  let door: FrontDoor;
  let clusters: ClusterManager;
  let handle = "";
  const sent: { method: string; path: string }[] = [];
  const tmp = `hands-dry-${randomBytes(3).toString("hex")}`;
  let send: Send;
  let token = "";
  let unschedulable: unknown;

  beforeAll(async () => {
    door = new FrontDoor(await loopbackCert(SIDECAR), () => {});
    clusters = new ClusterManager({ sidecarBinary: SIDECAR, frontDoor: door });
    await door.start();
    handle = (await clusters.connect("orbstack")).handle;
    token = door.issueToken({ label: "you · orbstack · drain check", policy: { access: "full" }, clusters: [handle] });
    send = fence(frontDoorSend({ url: door.clusterUrl(handle), certificate: door.certificate, token }), sent);
    await kubectl("rollout", "status", "deploy/hands-web", "--timeout=120s");
    await kubectl("wait", "--for=condition=Ready", "pod/hands-bare", "--timeout=60s");
    // The scenario's budget: two of two must stay, so it allows none.
    for (let i = 0; i < 30 && (await json("get", "pdb", "hands-web-pdb")).status?.disruptionsAllowed !== 0; i++) await sleep(1000);
    unschedulable = JSON.parse((await exec("kubectl", ["--context", "orbstack", "get", "node", "orbstack", "-o", "json"])).stdout).spec?.unschedulable;
  }, 180_000);

  afterAll(async () => {
    if (token) door.revokeToken(token);
    await kubectl("delete", "pdb", tmp, "--ignore-not-found").catch(() => {});
    await clusters?.disconnectAll();
    await door?.stop();
    // Nothing reached the node.
    if (run) expect(JSON.parse((await exec("kubectl", ["--context", "orbstack", "get", "node", "orbstack", "-o", "json"])).stdout).spec?.unschedulable).toBe(unschedulable);
  }, 60_000);

  it("a dry-run eviction of hands-web's pod answers 429 for hands-web-pdb, and the budget and the pod are as they were", async () => {
    const pod = (await json("get", "pods", "-l", "app=hands-web")).items[0];
    const before = budget((await json("get", "pdb", "hands-web-pdb")).status);
    expect(before.disruptionsAllowed).toBe(0);
    const r = await send(evictionRequest({ namespace: NS, name: pod.metadata.name, uid: pod.metadata.uid }, true));
    expect(r.status).toBe(429);
    // A StatusCause's type is serialized as `reason`.
    expect(JSON.parse(r.text).details.causes.map((c: any) => c.reason)).toContain("DisruptionBudget");
    expect(budget((await json("get", "pdb", "hands-web-pdb")).status)).toEqual(before);
    const after = await json("get", "pod", pod.metadata.name);
    expect(after.metadata.uid).toBe(pod.metadata.uid);
    expect(after.metadata.deletionTimestamp).toBeUndefined();
  });

  it("a dry-run eviction allowed by a budget doesn't spend it: hands-bare under a throwaway budget that allows one", async () => {
    await exec("kubectl", ["--context", "orbstack", "-n", NS, "create", "poddisruptionbudget", tmp, "--selector=app=hands-bare", "--min-available=0"]);
    try {
      await kubectl("label", "pdb", tmp, "scenario=hands");
      // The disruption controller's first sync: one healthy pod, none required, so one disruption allowed.
      let status: any;
      for (let i = 0; i < 60; i++) {
        const b = await json("get", "pdb", tmp);
        status = b.status;
        if ((status?.observedGeneration ?? 0) >= b.metadata.generation && status?.disruptionsAllowed === 1) break;
        await sleep(1000);
      }
      expect(status.disruptionsAllowed).toBe(1);
      const before = budget(status);
      const pod = await json("get", "pod", "hands-bare");
      const r = await send(evictionRequest({ namespace: NS, name: "hands-bare", uid: pod.metadata.uid }, true));
      expect([200, 201]).toContain(r.status);
      // Spent, a real eviction would show: disruptionsAllowed 0 and hands-bare in disruptedPods (kept up to 2 min).
      const right = budget((await json("get", "pdb", tmp)).status);
      expect(right).toEqual(before);
      expect(right.disruptedPods).toEqual({});
      const after = await json("get", "pod", "hands-bare");
      expect(after.metadata.uid).toBe(pod.metadata.uid);
      expect(after.metadata.deletionTimestamp).toBeUndefined();
      expect((after.status.conditions ?? []).map((c: any) => c.type)).not.toContain("DisruptionTarget");
    } finally {
      await kubectl("delete", "pdb", tmp, "--ignore-not-found");
    }
    await expect(kubectl("get", "pdb", tmp)).rejects.toThrow();
  }, 120_000);

  it("a dry-run eviction pinned to a uid that isn't the pod's is a conflict", async () => {
    const r = await send(evictionRequest({ namespace: NS, name: "hands-bare", uid: "00000000-0000-0000-0000-000000000000" }, true));
    expect(r.status).toBe(409);
  });

  it("the plan reads the real node, and the API server agrees with it on the scenario's pods (dry runs of those only)", async () => {
    const pods = await json("get", "pods");
    const uids = Object.fromEntries(pods.items.map((p: any) => [p.metadata.name, p.metadata.uid]));
    const read = await readDrain(send, "orbstack", { bare: false, emptyDir: false });
    // Only the scenario's own pods are asked about.
    const mine = { ...read.plan, pods: read.plan.pods.filter((p) => p.namespace === NS && p.name.startsWith("hands-")) };
    const by = (name: string) => mine.pods.filter((p) => p.name.startsWith(name));
    expect(by("hands-web-").every((p) => p.blocked === "budget" && p.budget && "name" in p.budget && p.budget.name === "hands-web-pdb")).toBe(true);
    expect(by("hands-bare")[0]).toMatchObject({ bare: true, blocked: "needs-bare" });
    expect(by("hands-cache-")[0]).toMatchObject({ emptyDir: ["cache"], blocked: "needs-emptydir" });
    expect(by("hands-agent-")[0]).toMatchObject({ class: "daemonset" });
    const { plan, disagree } = await dryRunEvictions(send, mine);
    expect(disagree).toBe(0);
    for (const p of plan.pods.filter((x) => x.name.startsWith("hands-web-"))) expect(p.dry).toEqual({ status: 429, reason: "budget" });
    expect(plan.pods.find((p) => p.name === "hands-db-0")!.dry!.status).toBeLessThan(300);
    // Every write was a dry-run eviction of one of the scenario's pods, and every pod is still itself.
    expect(sent.filter((s) => s.method !== "GET").every((s) => DRY_EVICTION.test(s.path))).toBe(true);
    const now = await json("get", "pods");
    for (const p of now.items) if (uids[p.metadata.name]) expect([p.metadata.name, p.metadata.uid]).toEqual([p.metadata.name, uids[p.metadata.name]]);
    expect(Object.keys(uids).every((n) => now.items.some((p: any) => p.metadata.name === n))).toBe(true);
  }, 120_000);
});

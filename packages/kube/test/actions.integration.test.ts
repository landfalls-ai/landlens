// Your actions against the OrbStack cluster (wave 8 part 1, D169): LANDLENS_INTEGRATION=orbstack pnpm test:integration.
// Needs the hands scenario (node deploy/scenarios/hands/up.mjs). Writes only in landlens-dev, to hands-* objects, and
// puts each back: hands-web is scaled to 3 and back to 2 and restarted, hands-report suspended and resumed, and
// triggered once (its Job deleted by a delete action); a hands-tmp-* ConfigMap is made and removed.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { frontDoorSend } from "../../kube-mcp/src/cluster.js";
import { actionFacts, buildOps } from "../src/actions.js";
import type { Send } from "../src/changes.js";
import { ClusterManager } from "../src/clusters.js";
import { EditBroker } from "../src/edits.js";
import { FrontDoor, type AuditEntry } from "../src/frontdoor.js";
import { loopbackCert } from "../src/sidecar.js";

const run = (process.env.LANDLENS_INTEGRATION ?? "").split(",").includes("orbstack");
const exec = promisify(execFile);
const SIDECAR = resolve(__dirname, "../../../sidecar/kube-proxy/bin/landlens-kube-proxy");
const NS = "landlens-dev";
const kubectl = async (...args: string[]) => (await exec("kubectl", ["--context", "orbstack", "-n", NS, ...args])).stdout;
const json = async (...args: string[]) => JSON.parse(await kubectl(...args, "-o", "json"));

const T = {
  deployments: { group: "apps", version: "v1", resource: "deployments", kind: "Deployment", namespaced: true, verbs: ["get", "patch", "delete"] },
  cronjobs: { group: "batch", version: "v1", resource: "cronjobs", kind: "CronJob", namespaced: true, verbs: ["get", "patch", "delete"] },
  jobs: { group: "batch", version: "v1", resource: "jobs", kind: "Job", namespaced: true, verbs: ["create", "get", "delete"] },
  configmaps: { group: "", version: "v1", resource: "configmaps", kind: "ConfigMap", namespaced: true, verbs: ["get", "delete"] },
  secrets: { group: "", version: "v1", resource: "secrets", kind: "Secret", namespaced: true, verbs: ["get", "delete"] },
};

describe.runIf(run)("your actions on OrbStack", () => {
  const audit: AuditEntry[] = [];
  const edits = new EditBroker();
  let door: FrontDoor;
  let clusters: ClusterManager;
  let handle = "";
  const tmp = `hands-tmp-${randomBytes(3).toString("hex")}`;
  let job = "";

  /** One series as you: a token for it, revoked after (main's asYou). */
  const asYou = async <T,>(what: string, f: (send: Send) => Promise<T>): Promise<T> => {
    const token = door.issueToken({ label: `you · orbstack · ${what}`, policy: { access: "full" }, clusters: [handle] });
    try {
      return await f(frontDoorSend({ url: door.clusterUrl(handle), certificate: door.certificate, token }));
    } finally {
      door.revokeToken(token);
    }
  };
  const review = (what: string, ops: ReturnType<typeof buildOps>) => asYou(what, (send) => edits.reviewOps(send, ops));
  const apply = (what: string, id: string, digest: string) => asYou(what, (send) => edits.apply(send, id, { each: true, digest }));

  beforeAll(async () => {
    door = new FrontDoor(await loopbackCert(SIDECAR), (e) => audit.push(e));
    clusters = new ClusterManager({ sidecarBinary: SIDECAR, frontDoor: door });
    await door.start();
    handle = (await clusters.connect("orbstack")).handle;
    await kubectl("scale", "deployment/hands-web", "--replicas=2");
    await kubectl("patch", "cronjob/hands-report", "--type=merge", "-p", '{"spec":{"suspend":false}}');
  }, 120_000);

  afterAll(async () => {
    await kubectl("scale", "deployment/hands-web", "--replicas=2").catch(() => {});
    await kubectl("patch", "cronjob/hands-report", "--type=merge", "-p", '{"spec":{"suspend":false}}').catch(() => {});
    await kubectl("delete", "configmap", tmp, "--ignore-not-found").catch(() => {});
    if (job) await kubectl("delete", "job", job, "--ignore-not-found", "--wait=false").catch(() => {});
    await clusters?.disconnectAll();
    await door?.stop();
  });

  it("scales hands-web to 3 as you and back to 2; a budget's fact comes from the real PDB", async () => {
    const target = { type: T.deployments, namespace: NS, name: "hands-web" };
    const r = await review("scale landlens-dev/hands-web", buildOps({ kind: "scale", targets: [target], replicas: 3 }));
    expect(r.id).toBeTruthy();
    const out = await apply("scale landlens-dev/hands-web", r.id!, r.digest!);
    expect(out.each).toEqual([{ target: "deployment landlens-dev/hands-web", outcome: "applied" }]);
    expect((await json("get", "deployment/hands-web")).spec.replicas).toBe(3);
    expect(audit.some((a) => a.label === "you · orbstack · scale landlens-dev/hands-web" && a.method === "PATCH" && !a.path.includes("dryRun"))).toBe(true);
    const back = await review("scale landlens-dev/hands-web", buildOps({ kind: "scale", targets: [target], replicas: 2 }));
    await apply("scale landlens-dev/hands-web", back.id!, back.digest!);
    expect((await json("get", "deployment/hands-web")).spec.replicas).toBe(2);
    // Scaling to 1 would go under hands-web-pdb's minAvailable 2: the fact, from the PDB as the cluster has it.
    const pdbs = await asYou("read", async (send) => JSON.parse((await send({ method: "GET", path: `/apis/policy/v1/namespaces/${NS}/poddisruptionbudgets` })).text).items);
    const one = await review("scale landlens-dev/hands-web", buildOps({ kind: "scale", targets: [target], replicas: 1 }));
    const facts = actionFacts({ kind: "scale", replicas: 1, objects: one.prepared.map((p) => ({ group: "apps", resource: "deployments", kind: "Deployment", obj: p.current })), hpas: [], pdbs });
    expect(facts.map((f) => f.text)).toContain("PodDisruptionBudget hands-web-pdb wants 2 available.");
    edits.discard(one.id!);
    expect((await json("get", "deployment/hands-web")).spec.replicas).toBe(2); // the dry run changed nothing
  }, 60_000);

  it("restarts hands-web with kubectl's restartedAt annotation", async () => {
    const before = await json("get", "deployment/hands-web");
    const r = await review("restart landlens-dev/hands-web", buildOps({ kind: "restart", targets: [{ type: T.deployments, namespace: NS, name: "hands-web" }], now: new Date() }));
    await apply("restart landlens-dev/hands-web", r.id!, r.digest!);
    const after = await json("get", "deployment/hands-web");
    expect(after.spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(after.metadata.generation).toBeGreaterThan(before.metadata.generation);
    await kubectl("rollout", "status", "deployment/hands-web", "--timeout=120s");
  }, 150_000);

  it("suspends hands-report and resumes it", async () => {
    const target = { type: T.cronjobs, namespace: NS, name: "hands-report" };
    const s = await review("suspend landlens-dev/hands-report", buildOps({ kind: "suspend", targets: [target], suspend: true }));
    expect(s.problems).toBeUndefined();
    expect((await apply("suspend landlens-dev/hands-report", s.id!, s.digest!)).each).toEqual([{ target: "cronjob landlens-dev/hands-report", outcome: "applied" }]);
    expect((await json("get", "cronjob/hands-report")).spec.suspend).toBe(true);
    const r = await review("resume landlens-dev/hands-report", buildOps({ kind: "suspend", targets: [target], suspend: false }));
    await apply("resume landlens-dev/hands-report", r.id!, r.digest!);
    expect((await json("get", "cronjob/hands-report")).spec.suspend).toBe(false);
  }, 60_000);

  it("[check] triggers hands-report: the Job is the one `kubectl create job --from` makes, owned by the CronJob as controller", async () => {
    const cronJob = await json("get", "cronjob/hands-report");
    const suffix = randomBytes(4).toString("hex").slice(0, 5).replace(/[^a-z0-9]/g, "a");
    const ops = buildOps({ kind: "trigger", targets: [{ type: T.cronjobs, namespace: NS, name: "hands-report" }], cronJob, jobs: T.jobs, suffix });
    job = ops[0]!.name;
    const r = await review("trigger landlens-dev/hands-report", ops);
    await apply("trigger landlens-dev/hands-report", r.id!, r.digest!);
    const ours = await json("get", "job", job);
    // kubectl's, made by the API server too (a server dry run: nothing is created), from the same CronJob.
    const theirs = JSON.parse(await kubectl("create", "job", `${job}-k`, "--from=cronjob/hands-report", "--dry-run=server", "-o", "json"));
    expect(ours.metadata.ownerReferences).toEqual(theirs.metadata.ownerReferences);
    expect(ours.metadata.ownerReferences).toEqual([{ apiVersion: "batch/v1", kind: "CronJob", name: "hands-report", uid: cronJob.metadata.uid, controller: true }]);
    expect(ours.metadata.annotations).toEqual(theirs.metadata.annotations);
    expect(ours.metadata.annotations["cronjob.kubernetes.io/instantiate"]).toBe("manual");
    const userLabels = (o: any) => Object.fromEntries(Object.entries(o.metadata.labels ?? {}).filter(([k]) => !/controller-uid|job-name/.test(k)));
    expect(userLabels(ours)).toEqual(userLabels(theirs));
    const spec = (o: any) => ({ ...o.spec, selector: undefined, template: { ...o.spec.template, metadata: { ...o.spec.template.metadata, creationTimestamp: undefined /* kubectl's client sends null */, labels: userLabels({ metadata: { labels: o.spec.template.metadata.labels } }) } } });
    expect(spec(ours)).toEqual(spec(theirs));
    expect(ours.spec.template.spec.containers[0].env).toEqual([{ name: "REPORT_DAY", value: "monday" }]);
    // And the delete action removes it, pinned to its uid and version.
    const d = await review(`delete landlens-dev/${job}`, buildOps({ kind: "delete", targets: [{ type: T.jobs, namespace: NS, name: job }] }));
    expect((await apply(`delete landlens-dev/${job}`, d.id!, d.digest!)).each![0]!.outcome).toBe("applied");
    await expect.poll(async () => (await kubectl("get", "job", job, "--ignore-not-found")).trim(), { timeout: 30_000 }).toBe("");
    job = "";
  }, 90_000);

  it("a delete pinned to the version reviewed answers a conflict when the object changed, and sends nothing else", async () => {
    await kubectl("create", "configmap", tmp, "--from-literal=a=1");
    await kubectl("label", "configmap", tmp, "scenario=hands");
    const r = await review(`delete landlens-dev/${tmp}`, buildOps({ kind: "delete", targets: [{ type: T.configmaps, namespace: NS, name: tmp }] }));
    await kubectl("annotate", "configmap", tmp, "landlens.dev/touched=yes");
    const out = await apply(`delete landlens-dev/${tmp}`, r.id!, r.digest!);
    expect(out.each).toEqual([{ target: `configmap ${NS}/${tmp}`, outcome: "conflict", message: "It changed after your review." }]);
    expect((await json("get", "configmap", tmp)).metadata.annotations["landlens.dev/touched"]).toBe("yes");
    const again = await review(`delete landlens-dev/${tmp}`, buildOps({ kind: "delete", targets: [{ type: T.configmaps, namespace: NS, name: tmp }] }));
    expect((await apply(`delete landlens-dev/${tmp}`, again.id!, again.digest!)).each![0]!.outcome).toBe("applied");
    expect((await kubectl("get", "configmap", tmp, "--ignore-not-found")).trim()).toBe("");
  }, 60_000);

  it("a Secret's delete review shows keys and sizes and none of its values, and is not applied", async () => {
    const secret = await json("get", "secret", "hands-secret");
    const password = Buffer.from(secret.data.password, "base64").toString();
    expect(password).toMatch(/^LLMARK-/);
    const r = await review("delete landlens-dev/hands-secret", buildOps({ kind: "delete", targets: [{ type: T.secrets, namespace: NS, name: "hands-secret" }] }));
    const shown = JSON.stringify({ operations: r.operations, agent: r.agent, current: r.prepared.map((p) => p.current) });
    expect(shown).toContain("password: <");
    expect(shown).not.toContain(password);
    expect(shown).not.toContain(secret.data.password);
    expect(shown).not.toContain(secret.data.blob);
    expect(r.agent).toBeUndefined();
    edits.discard(r.id!);
    expect((await json("get", "secret", "hands-secret")).metadata.uid).toBe(secret.metadata.uid);
  }, 30_000);
});

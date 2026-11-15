// Logs and pod shells against the OrbStack cluster: LANDLENS_INTEGRATION=orbstack pnpm test:integration
// Writes only in landlens-dev: one test pod, deleted at the end.
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClusterManager } from "../src/clusters.js";
import { AUTO_SHELL, openExec, type ExecExit } from "../src/exec.js";
import { FrontDoor, type AuditEntry } from "../src/frontdoor.js";
import { followLogs, type LogLine } from "../src/logs.js";
import { loopbackCert } from "../src/sidecar.js";

const run = (process.env.LANDLENS_INTEGRATION ?? "").split(",").includes("orbstack");
const exec = promisify(execFile);
const SIDECAR = resolve(__dirname, "../../../sidecar/kube-proxy/bin/landlens-kube-proxy");
const NS = "landlens-dev";
const POD = "landlens-workbench-test";
const kubectl = (...args: string[]) => exec("kubectl", ["--context", "orbstack", "-n", NS, ...args]);

describe.runIf(run)("logs and pod shells on OrbStack", () => {
  const audit: AuditEntry[] = [];
  let door: FrontDoor;
  let clusters: ClusterManager;
  let handle = "";

  beforeAll(async () => {
    await kubectl("delete", "pod", POD, "--ignore-not-found", "--wait=true");
    await kubectl("run", POD, "--image=busybox:1.36", "--restart=Never", "--labels=app.kubernetes.io/part-of=landlens-scenarios", "--",
      "sh", "-c", "i=0; while true; do i=$((i+1)); echo \"tick $i\"; sleep 0.2; done");
    await kubectl("wait", "--for=condition=Ready", `pod/${POD}`, "--timeout=90s");
    door = new FrontDoor(await loopbackCert(SIDECAR), (e) => audit.push(e));
    clusters = new ClusterManager({ sidecarBinary: SIDECAR, frontDoor: door });
    await door.start();
    handle = (await clusters.connect("orbstack")).handle;
  }, 120_000);

  afterAll(async () => {
    await clusters?.disconnectAll();
    await door?.stop();
    await kubectl("delete", "pod", POD, "--ignore-not-found", "--wait=false").catch(() => {});
  });

  it("follows a container's log as it is written, with timestamps", async () => {
    const got: LogLine[] = [];
    const stop = followLogs(clusters.get(handle).client, { namespace: NS, pod: POD, container: POD, tailLines: 5 }, {
      lines: (l) => got.push(...l),
      end: () => {},
    });
    await expect.poll(() => got.length, { timeout: 10_000 }).toBeGreaterThan(10);
    stop();
    expect(got[0]!.ts).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    const n = got.map((l) => Number(/^tick (\d+)$/.exec(l.text)?.[1]));
    expect(n.every((x, i) => i === 0 || x === n[i - 1]! + 1)).toBe(true); // in order, none lost
  }, 20_000);

  it("runs a shell in the pod through the front door, with the size it's given, and reports the exit", async () => {
    const token = door.issueToken({ label: "you · orbstack · shell", policy: { access: "full" }, clusters: [handle] });
    let out = "";
    const exit = await new Promise<ExecExit>((done) => {
      const s = openExec({ url: door.clusterUrl(handle), certificate: door.certificate, token, namespace: NS, pod: POD, container: POD, command: AUTO_SHELL }, {
        open: () => {
          s.resize(91, 17);
          setTimeout(() => s.write("stty size; echo hello-$((40+2)); exit 3\n"), 300);
        },
        data: (t) => (out += t),
        exit: done,
      });
    });
    door.revokeToken(token);
    expect(out).toContain("17 91");
    expect(out).toContain("hello-42");
    expect(exit).toEqual(expect.objectContaining({ ended: "exit", code: 3 }));
    expect(audit.some((a) => a.label === "you · orbstack · shell" && a.path.includes(`/pods/${POD}/exec`) && a.status === 101)).toBe(true);
  }, 20_000);

  it("says why when the pod isn't there, and refuses a revoked token", async () => {
    const token = door.issueToken({ label: "you · orbstack · shell", policy: { access: "full" }, clusters: [handle] });
    const missing = await new Promise<ExecExit>((done) => {
      openExec({ url: door.clusterUrl(handle), certificate: door.certificate, token, namespace: NS, pod: "no-such-pod", container: "x", command: ["sh"] }, { open() {}, data() {}, exit: done });
    });
    expect(missing).toMatchObject({ ended: "refused", status: 404 });
    expect(missing.message).toMatch(/not found/);
    door.revokeToken(token);
    const revoked = await new Promise<ExecExit>((done) => {
      openExec({ url: door.clusterUrl(handle), certificate: door.certificate, token, namespace: NS, pod: POD, container: POD, command: ["sh"] }, { open() {}, data() {}, exit: done });
    });
    expect(revoked.code).toBeUndefined();
    expect(revoked).toMatchObject({ ended: "refused", status: 401 });
    expect(revoked.message).toMatch(/401|token|Unauthorized/i);
  });
});

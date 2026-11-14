// Against the OrbStack cluster on this machine: LANDLENS_INTEGRATION=orbstack pnpm test:integration
// Read-only towards every namespace; the only writes attempted are deletes of a pod that doesn't exist.
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClusterManager, WatchHub } from "../src/clusters.js";
import { checkAccess } from "../src/access.js";
import { FrontDoor, type AuditEntry } from "../src/frontdoor.js";
import { loopbackCert } from "../src/sidecar.js";
import { agentReadOnlyPolicy } from "../src/policy.js";
import { TOKEN_ENV, toolKubeconfig } from "../src/tool-kubeconfig.js";
import type { WatcherEvent } from "../src/watch.js";

const run = (process.env.LANDLENS_INTEGRATION ?? "").split(",").includes("orbstack");
const exec = promisify(execFile);
const SIDECAR = resolve(__dirname, "../../../sidecar/kube-proxy/bin/landlens-kube-proxy");

describe.runIf(run)("OrbStack cluster", () => {
  const audit: AuditEntry[] = [];
  let door: FrontDoor;
  let clusters: ClusterManager;
  let handle = "";
  let kubeconfig = "";

  beforeAll(async () => {
    door = new FrontDoor(await loopbackCert(SIDECAR), (e) => audit.push(e));
    clusters = new ClusterManager({ sidecarBinary: SIDECAR, frontDoor: door });
    await door.start();
    handle = (await clusters.connect("orbstack")).handle;
    const dir = mkdtempSync(join(tmpdir(), "landlens-it-"));
    kubeconfig = join(dir, "config");
    writeFileSync(kubeconfig, toolKubeconfig(door, [{ handle, context: "orbstack" }]), { mode: 0o600 });
  }, 30_000);

  afterAll(async () => {
    await clusters.disconnectAll();
    await door.stop();
  });

  const kubectl = (token: string | undefined, ...args: string[]) =>
    exec("kubectl", ["--kubeconfig", kubeconfig, ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...(token ? { [TOKEN_ENV]: token } : {}) },
    }).then((r) => ({ ok: true, out: r.stdout, err: r.stderr }), (e) => ({ ok: false, out: e.stdout as string, err: e.stderr as string }));

  it("connects through the sidecar and discovers the API", async () => {
    const info = clusters.list()[0]!;
    expect(info.version).toMatch(/^v1\./);
    const types = await clusters.discovery(handle);
    expect(types.find((t) => t.resource === "deployments" && t.group === "apps")).toMatchObject({ namespaced: true });
    expect(types.find((t) => t.resource === "nodes")).toMatchObject({ namespaced: false, group: "" });
  });

  it("asks the API server what the user may do", async () => {
    const [list] = await checkAccess(clusters.get(handle).client, [{ verb: "list", group: "", resource: "pods" }]);
    expect(list).toBe(true);
  });

  it("lists and watches pods across namespaces", async () => {
    const hub = new WatchHub(clusters);
    const first = await new Promise<WatcherEvent>((resolve) => {
      const id = hub.subscribe({ handle, group: "", version: "v1", resource: "pods" }, (e) => {
        hub.unsubscribe(id);
        resolve(e);
      });
    });
    expect(first.type).toBe("snapshot");
    if (first.type === "snapshot") {
      expect(first.items.some((p) => p.metadata.namespace === "kube-system")).toBe(true);
      expect(first.items[0]!.metadata).not.toHaveProperty("managedFields");
    }
    await hub.stopAll();
  });

  it("lets the agent's kubectl read pods through the front door", async () => {
    const agent = door.issueToken({ label: "agent", policy: agentReadOnlyPolicy(), clusters: [handle] });
    const r = await kubectl(agent, "get", "pods", "-n", "kube-system", "-o", "name");
    expect(r.err).toBe("");
    expect(r.out).toContain("pod/");
  });

  it("refuses the agent's kubectl writes, exec and secrets, before the cluster sees them", async () => {
    const agent = door.issueToken({ label: "agent", policy: agentReadOnlyPolicy(), clusters: [handle] });
    const before = audit.length;
    const del = await kubectl(agent, "delete", "pod", "landlens-does-not-exist", "-n", "landlens-dev", "--wait=false");
    expect(del.ok).toBe(false);
    expect(del.err).toContain("read-only token");
    const sec = await kubectl(agent, "get", "secrets", "-A");
    expect(sec.ok).toBe(false);
    expect(sec.err).toContain("may not access secrets");
    const denied = audit.slice(before).filter((a) => !a.allowed);
    expect(denied.map((a) => a.method)).toEqual(expect.arrayContaining(["DELETE", "GET"]));
  });

  it("lets the IDE's token through to the cluster's own answer", async () => {
    const ide = door.issueToken({ label: "ide", policy: { access: "full" }, clusters: [handle] });
    const del = await kubectl(ide, "delete", "pod", "landlens-does-not-exist", "-n", "landlens-dev", "--wait=false");
    expect(del.ok).toBe(false);
    expect(del.err).toMatch(/NotFound|not found/); // the API server answered, so the request got through
  });

  it("fails closed when the token variable is missing", async () => {
    const r = await kubectl(undefined, "get", "pods", "-A");
    expect(r.ok).toBe(false);
    expect(r.err).toContain("LANDLENS_TOKEN is not set");
  });
});

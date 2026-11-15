// Person edits in main (wave 4, part 2): every review and apply goes through the front door with its own token,
// labelled as you and revoked after; only the window that reviewed a change may apply it, on that cluster.
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));
const sent: { method: string; path: string; body?: string; token: string }[] = [];
vi.mock("@landlens/kube-mcp", () => ({
  frontDoorSend: ({ token }: { token: string }) => async (r: { method: string; path: string; body?: string }) => {
    sent.push({ ...r, token });
    if (r.method === "GET") return { status: 200, text: JSON.stringify(live), warnings: [] };
    return { status: 200, text: JSON.stringify({ ...live, spec: { replicas: 3 } }), warnings: [] };
  },
}));
import { WorkbenchService } from "../src/main/workbench";

const live = { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "web", namespace: "shop", resourceVersion: "7", uid: "u" }, data: { a: "1" } };
const type = { group: "", version: "v1", resource: "configmaps", kind: "ConfigMap", namespaced: true };

function window() {
  const e = new EventEmitter() as EventEmitter & { isDestroyed(): boolean; send(): void };
  e.isDestroyed = () => false;
  e.send = () => {};
  return e;
}

describe("person edits in main", () => {
  it("reviews and applies as you, with a token per call, revoked after; only the reviewing window may apply", async () => {
    let n = 0;
    const issue = vi.fn(() => String(++n).repeat(64));
    const revoke = vi.fn();
    const clusters = { get: () => ({ info: { context: "orbstack" } }), onGone: () => {}, discovery: async () => [type] };
    const door = { issueToken: issue, revokeToken: revoke, clusterUrl: () => "https://127.0.0.1:1/c/h", certificate: "", url: "https://127.0.0.1:1" };
    const svc = new WorkbenchService({ clusters: clusters as any, frontDoor: door as any, dataDir: mkdtempSync(join(tmpdir(), "wb-")) });
    const a = window();
    const b = window();
    const original = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: web\n  namespace: shop\ndata:\n  a: \"1\"\n";
    const r = await svc.reviewEdit({ handle: "h1234567", type, namespace: "shop", name: "web", base: "7", original, edited: original.replace('"1"', '"2"') }, a as any);
    expect(r.id).toMatch(/^ed/);
    expect(issue).toHaveBeenLastCalledWith({ label: "you · orbstack · edit", policy: { access: "full" }, clusters: ["h1234567"] });
    expect(revoke).toHaveBeenCalledTimes(1);
    // The dry run is a merge patch of what changed, pinned to the version you started from.
    const dry = sent.find((s) => s.method === "PATCH")!;
    expect(dry.path).toContain("dryRun=All");
    expect(JSON.parse(dry.body!)).toEqual({ data: { a: "2" }, metadata: { resourceVersion: "7" } });

    await expect(async () => svc.applyEdit({ handle: "h1234567", id: r.id! }, b as any)).rejects.toThrow(/no such review/);
    await expect(async () => svc.applyEdit({ handle: "h7654321", id: r.id! }, a as any)).rejects.toThrow(/no such review/);
    sent.length = 0;
    await svc.applyEdit({ handle: "h1234567", id: r.id! }, a as any);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).not.toContain("dryRun");
    expect(sent[0]!.body).toBe(dry.body);
    expect(sent[0]!.token).toBe("2".repeat(64));
    expect(revoke).toHaveBeenLastCalledWith("2".repeat(64));
    // Once applied, it can't be sent again.
    await expect(async () => svc.applyEdit({ handle: "h1234567", id: r.id! }, a as any)).rejects.toThrow(/no such review/);
  });

  it("forgets a window's reviews when it closes", async () => {
    const clusters = { get: () => ({ info: { context: "orbstack" } }), onGone: () => {}, discovery: async () => [type] };
    const door = { issueToken: () => "t".repeat(64), revokeToken: () => {}, clusterUrl: () => "https://127.0.0.1:1/c/h", certificate: "", url: "https://127.0.0.1:1" };
    const svc = new WorkbenchService({ clusters: clusters as any, frontDoor: door as any, dataDir: mkdtempSync(join(tmpdir(), "wb-")) });
    const a = window();
    const r = await svc.reviewCreate({ handle: "h1234567", namespace: "shop", yaml: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: new\ndata:\n  a: b\n" }, a as any);
    expect(r.operations?.[0]).toMatchObject({ verb: "create", kind: "ConfigMap", namespace: "shop", name: "new" });
    a.emit("destroyed");
    await expect(async () => svc.applyEdit({ handle: "h1234567", id: r.id! }, a as any)).rejects.toThrow(/no such review/);
  });
});

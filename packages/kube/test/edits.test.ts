import { describe, expect, it } from "vitest";
import { EditBroker, editableYaml, lineOf, mergePatch, ownersOf, patchPaths, refusal, yamlProblems } from "../src/edits.js";
import type { Send } from "../src/changes.js";

const deploy = {
  apiVersion: "apps/v1", kind: "Deployment",
  metadata: { name: "web", namespace: "shop", resourceVersion: "41", uid: "u1", generation: 3, managedFields: [
    { manager: "kube-controller-manager", operation: "Update", subresource: "scale", fieldsV1: { "f:spec": { "f:replicas": {} } } },
    { manager: "kubectl-client-side-apply", operation: "Update", fieldsV1: { "f:spec": { "f:template": {} } } },
  ], annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{}" } },
  spec: { replicas: 2, template: { spec: { containers: [{ name: "app", image: "web:1" }] } } },
  status: { readyReplicas: 2 },
};
const type = { group: "apps", version: "v1", resource: "deployments", kind: "Deployment", namespaced: true };

/** A cluster that answers GET with the object and records what was sent. */
function cluster(answer?: (r: Parameters<Send>[0]) => { status: number; text: string } | undefined) {
  const sent: Parameters<Send>[0][] = [];
  const send: Send = async (r) => {
    sent.push(r);
    const a = answer?.(r);
    if (a) return { ...a, warnings: [] };
    if (r.method === "GET") return { status: 200, text: JSON.stringify(deploy), warnings: [] };
    const body = JSON.parse(r.body ?? "{}");
    const after = structuredClone(deploy) as any;
    if (body.spec?.replicas !== undefined) after.spec.replicas = body.spec.replicas;
    if (body.spec?.template) after.spec.template = body.spec.template;
    return { status: r.method === "POST" ? 201 : 200, text: JSON.stringify(r.method === "POST" ? body : after), warnings: [] };
  };
  return { send, sent };
}

describe("your edits", () => {
  it("show no status, bookkeeping or last-applied in the editor", () => {
    const y = editableYaml(deploy);
    expect(y).not.toMatch(/status|managedFields|resourceVersion|uid|generation|last-applied/);
    expect(y).toContain("replicas: 2");
  });

  it("send only what changed, as a merge patch: removed keys are null, lists whole", () => {
    expect(mergePatch({ a: 1, b: { c: 1, d: 2 }, l: [1, 2] }, { a: 1, b: { c: 3 }, l: [1], e: "x" })).toEqual({ b: { c: 3, d: null }, l: [1], e: "x" });
    expect(patchPaths({ spec: { replicas: 3, template: { spec: { containers: [] } } } })).toEqual([["spec", "replicas"], ["spec", "template", "spec", "containers"]]);
  });

  it("name another manager of a field you changed, but not kubectl or Landlens", () => {
    expect(ownersOf(deploy, [["spec", "replicas"], ["spec", "template"]])).toEqual([{ path: "spec.replicas", manager: "kube-controller-manager" }]);
  });

  it("find a field's line, or its nearest parent's", () => {
    const y = "apiVersion: v1\nkind: Pod\nmetadata:\n  name: a\nspec:\n  containers:\n    - name: app\n      image: x\n";
    expect(lineOf(y, "spec.containers[0].image")).toBe(8);
    expect(lineOf(y, "metadata.name")).toBe(4);
    expect(lineOf(y, "spec.containers[0].ports")).toBe(7);
    expect(lineOf("a: 1\n---\nkind: X\nb: 2\n", "b", 1)).toBe(4);
    expect(yamlProblems("a: [1\n")[0]!.line).toBeGreaterThan(0);
    expect(yamlProblems("a: 1\n")).toEqual([]);
  });

  it("turn a refusal's causes into lines", () => {
    const y = "spec:\n  replicas: -1\n";
    const text = JSON.stringify({ status: "Failure", message: "invalid", details: { causes: [{ field: "spec.replicas", message: "must be greater than or equal to 0" }, { message: "no field" }] } });
    expect(refusal(422, text, y)).toEqual([{ field: "spec.replicas", line: 2, message: "must be greater than or equal to 0" }, { message: "no field" }]);
  });

  it("dry-run the merge patch with your starting version, then apply exactly that", async () => {
    const c = cluster();
    const b = new EditBroker();
    const original = editableYaml(deploy);
    const r = await b.reviewEdit(c.send, { type, namespace: "shop", name: "web", base: "41", original, edited: original.replace("replicas: 2", "replicas: 3") });
    expect(r.problems).toBeUndefined();
    expect(r.changed).toEqual(["spec.replicas"]);
    expect(r.owners).toEqual([{ path: "spec.replicas", manager: "kube-controller-manager", line: expect.any(Number) }]);
    expect(r.operations![0]!.diff.added).toBe(1);
    const dry = c.sent.find((x) => x.method === "PATCH")!;
    expect(dry.path).toBe("/apis/apps/v1/namespaces/shop/deployments/web?fieldManager=landlens&dryRun=All");
    expect(dry.contentType).toBe("application/merge-patch+json");
    expect(JSON.parse(dry.body!)).toEqual({ spec: { replicas: 3 }, metadata: { resourceVersion: "41" } });
    const out = await b.apply(c.send, r.id!);
    expect(out.results).toEqual(["Applied deployment shop/web"]);
    const sent = c.sent.at(-1)!;
    expect(sent.path).toBe("/apis/apps/v1/namespaces/shop/deployments/web?fieldManager=landlens");
    expect(sent.body).toBe(dry.body);
    await expect(b.apply(c.send, r.id!)).rejects.toMatchObject({ status: 410 });
  });

  it("refuse a changed identity, a Secret, and say when nothing changed", async () => {
    const c = cluster();
    const b = new EditBroker();
    const original = editableYaml(deploy);
    const renamed = await b.reviewEdit(c.send, { type, namespace: "shop", name: "web", base: "41", original, edited: original.replace("name: web", "name: other") });
    expect(renamed.problems![0]).toMatchObject({ field: "metadata.name", line: 4 });
    expect((await b.reviewEdit(c.send, { type, namespace: "shop", name: "web", base: "41", original, edited: original })).problems![0]!.message).toBe("Nothing changed");
    await expect(b.reviewEdit(c.send, { type: { group: "", version: "v1", resource: "secrets", kind: "Secret", namespaced: true }, namespace: "shop", name: "s", base: "1", original: "", edited: "" })).rejects.toThrow(/Secrets/);
    expect(c.sent.filter((x) => x.method === "PATCH")).toHaveLength(0);
  });

  it("report a conflict when the object moved on, and a refusal on its line", async () => {
    const original = editableYaml(deploy);
    const edited = original.replace("replicas: 2", "replicas: -1");
    const moved = cluster((r) => (r.method === "PATCH" ? { status: 409, text: "{}" } : undefined));
    expect(await new EditBroker().reviewEdit(moved.send, { type, namespace: "shop", name: "web", base: "40", original, edited })).toMatchObject({ conflict: true });
    const bad = cluster((r) => (r.method === "PATCH" ? { status: 422, text: JSON.stringify({ details: { causes: [{ field: "spec.replicas", message: "must be greater than or equal to 0" }] } }) } : undefined));
    const r = await new EditBroker().reviewEdit(bad.send, { type, namespace: "shop", name: "web", base: "41", original, edited });
    expect(r.problems).toEqual([{ field: "spec.replicas", line: edited.split("\n").findIndex((l) => l.includes("replicas")) + 1, message: "must be greater than or equal to 0" }]);
    expect(r.id).toBeUndefined();
  });

  it("create several objects from YAML, each dry-run, in the namespace given", async () => {
    const c = cluster();
    const types = [type, { group: "", version: "v1", resource: "configmaps", kind: "ConfigMap", namespaced: true }, { group: "", version: "v1", resource: "namespaces", kind: "Namespace", namespaced: false }];
    const b = new EditBroker();
    const r = await b.reviewCreate(c.send, { namespace: "shop", types, yaml: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\ndata:\n  a: b\n---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: extra\n" });
    expect(r.operations!.map((o) => `${o.verb} ${o.kind} ${o.namespace ?? "-"}/${o.name}`)).toEqual(["create ConfigMap shop/cfg", "create Namespace -/extra"]);
    expect(c.sent.map((x) => x.path)).toEqual(["/api/v1/namespaces/shop/configmaps?fieldManager=landlens&dryRun=All", "/api/v1/namespaces?fieldManager=landlens&dryRun=All"]);
    expect((await b.apply(c.send, r.id!)).results).toEqual(["Created configmap shop/cfg", "Created namespace extra"]);
    const unknown = await b.reviewCreate(c.send, { types, yaml: "apiVersion: example.com/v1\nkind: Widget\nmetadata:\n  name: w\n" });
    expect(unknown.problems![0]).toMatchObject({ message: "This cluster doesn't serve example.com/v1 Widget", line: 2 });
  });

  it("refuse Secrets, more than ten documents and a namespace on a cluster-scoped kind, before sending anything", async () => {
    const c = cluster();
    const types = [{ group: "", version: "v1", resource: "secrets", kind: "Secret", namespaced: true }, { group: "", version: "v1", resource: "configmaps", kind: "ConfigMap", namespaced: true }, { group: "", version: "v1", resource: "namespaces", kind: "Namespace", namespaced: false }];
    const b = new EditBroker();
    const secret = await b.reviewCreate(c.send, { namespace: "shop", types, yaml: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ok\n---\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: s\n" });
    // The empty document between them doesn't shift the line: the Secret's kind is on line 8.
    expect(secret.problems).toEqual([{ message: "Secrets are created outside Landlens for now", line: 8 }]);
    const many = Array.from({ length: 11 }, (_, i) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c${i}\n`).join("---\n");
    expect((await b.reviewCreate(c.send, { namespace: "shop", types, yaml: many })).problems![0]!.message).toBe("At most 10 objects at once");
    const scoped = await b.reviewCreate(c.send, { types, yaml: "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: x\n  namespace: shop\n" });
    expect(scoped.problems![0]).toMatchObject({ message: "Namespace is cluster-scoped: remove metadata.namespace", line: 5 });
    expect(c.sent.filter((x) => x.method !== "GET")).toHaveLength(1); // only "ok", dry-run, before the Secret refused the batch
  });

  it("refuse a changed apiVersion, kind or namespace, YAML over 512 KB, a second document and an ambiguous 0600", async () => {
    const c = cluster();
    const b = new EditBroker();
    const original = editableYaml(deploy);
    const review = (edited: string) => b.reviewEdit(c.send, { type, namespace: "shop", name: "web", base: "41", original, edited });
    expect((await review(original.replace("apiVersion: apps/v1", "apiVersion: apps/v2"))).problems![0]).toMatchObject({ field: "apiVersion", line: 1 });
    expect((await review(original.replace("kind: Deployment", "kind: StatefulSet"))).problems![0]).toMatchObject({ field: "kind", line: 2 });
    expect((await review(original.replace("namespace: shop", "namespace: other"))).problems![0]).toMatchObject({ field: "metadata.namespace" });
    await expect(review(original + "#".repeat(512 * 1024))).rejects.toThrow(/512 KB/);
    expect((await review(`${original}---\nkind: ConfigMap\n`)).problems![0]!.message).toMatch(/one object, in one document/);
    const mode = await review(original.replace("replicas: 2", "replicas: 0600"));
    expect(mode.problems![0]).toMatchObject({ message: expect.stringContaining("0o600"), line: original.split("\n").findIndex((l) => l.includes("replicas")) + 1 });
    expect((await review(original.replace("replicas: 2", "replicas: 0o3"))).problems).toBeUndefined();
    expect(c.sent.filter((x) => x.method === "PATCH")).toHaveLength(1);
  });

  it("forget a review after 15 minutes", async () => {
    let now = 0;
    const b = new EditBroker({ now: () => now });
    const c = cluster();
    const original = editableYaml(deploy);
    const r = await b.reviewEdit(c.send, { type, namespace: "shop", name: "web", base: "41", original, edited: original.replace("replicas: 2", "replicas: 3") });
    now = 15 * 60_000;
    await expect(b.apply(c.send, r.id!)).rejects.toMatchObject({ status: 410 });
  });

  it("keep a __proto__ key and other own keys, and leave hidden annotations when every visible one goes", () => {
    const p = mergePatch(JSON.parse('{"a":1,"toString":2}'), JSON.parse('{"__proto__":{"x":1}}')) as Record<string, unknown>;
    expect(Object.keys(p).sort()).toEqual(["__proto__", "a", "toString"]);
    expect(JSON.parse(JSON.stringify(p))).toEqual({ a: null, toString: null, ["__proto__"]: { x: 1 } });
    expect(Object.getPrototypeOf(p)).toBe(Object.prototype);
  });

  it("send only visible annotations' removal, and give the agent a scrubbed diff", async () => {
    const withEnv = structuredClone(deploy) as any;
    withEnv.metadata.annotations = { "kubectl.kubernetes.io/last-applied-configuration": "{}", team: "shop" };
    withEnv.spec.template.spec.containers[0].env = [{ name: "STRIPE_KEY", value: "rk_live_abcdefghijklmnop" }];
    const c = cluster((r) => {
      if (r.method === "GET") return { status: 200, text: JSON.stringify(withEnv) };
      const after = structuredClone(withEnv);
      after.spec.template.spec.containers[0].image = "web:2";
      return { status: 200, text: JSON.stringify(after) };
    });
    const b = new EditBroker();
    const original = editableYaml(withEnv);
    const edited = original.replace(/  annotations:\n    team: shop\n/, "").replace("image: web:1", "image: web:2");
    const r = await b.reviewEdit(c.send, { type, namespace: "shop", name: "web", base: "41", original, edited });
    const body = JSON.parse(c.sent.find((x) => x.method === "PATCH")!.body!);
    expect(body.metadata.annotations).toEqual({ team: null });
    // The person's card shows the value; what the agent may get doesn't.
    expect(r.operations![0]!.diff.lines.some((l) => l.text.includes("rk_live_abcdefghijklmnop"))).toBe(true);
    expect(r.agent).toContain("image: web:2");
    expect(r.agent).not.toContain("rk_live_abcdefghijklmnop");
  });

  it("cut what the cluster says to a readable length", () => {
    const long = "x".repeat(5000);
    const [p] = refusal(422, JSON.stringify({ details: { causes: [{ field: long, message: long }] } }), "a: 1\n");
    expect(p!.message.length).toBeLessThanOrEqual(501);
    expect(p!.field!.length).toBeLessThanOrEqual(301);
  });
});


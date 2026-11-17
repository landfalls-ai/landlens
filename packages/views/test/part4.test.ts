// Wave 10 part 4: the connections' source kinds (D207, D212), the view file (D217) and the saved view's checks (D216).
import { describe, expect, it } from "vitest";
import { issueLine, SENTENCES } from "../src/errors.js";
import { appBlocks, credentialIssues, literalNames, readViewFile, Tweaks, viewFileName, writeViewFile } from "../src/file.js";
import { VIEW_LIMITS } from "../src/limits.js";
import { parsePath, readRaw, type ParsedPath } from "../src/path.js";
import { CONNECTION_KINDS, parseDocument, type ViewDocument } from "../src/schema.js";
import { reach, sourceWords, TRUST_KEY, trustItems } from "../src/trust.js";
import { full, small } from "./docs.js";

const issues = (d: unknown) => {
  const r = parseDocument(d);
  if (r.ok) throw new Error("expected the document to be refused");
  return r.issues.map(issueLine);
};
const ok = (d: unknown): ViewDocument => {
  const r = parseDocument(d);
  if (!r.ok) throw new Error(`expected the document to pass: ${r.issues.map(issueLine).join("; ")}`);
  return r.document;
};
const one = (source: Record<string, unknown>, block: Record<string, unknown> = { type: "table", source: "s", columns: [{ field: "name" }] }) =>
  ({ schema: 1, title: "T", sources: { s: source }, blocks: [block] });
const file = (doc: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ landlensView: 1, name: "Restarts", document: doc, exportedAt: "2026-11-16T10:00:00.000Z", ...extra });

describe("the connections' sources (D207, D212)", () => {
  it("takes each part-4 kind", () => {
    ok(one({ kind: "gcp.resources", project: "my-project", assetType: "sqladmin.googleapis.com/Instance", query: "state:RUNNABLE" }));
    ok(one({ kind: "gcp.clusters" }));
    ok(one({ kind: "gcp.alerts", project: "my-project", cluster: "gke_my-project_europe-west1_prod" }));
    ok(one({ kind: "gcp.recommendations", project: "my-project" }));
    ok(one({ kind: "gcp.metrics", cluster: "gke_my-project_europe-west1_prod", scope: "namespace", namespace: "shop", range: "1h" }, { type: "chart", source: "s", kind: "line", y: ["cpu"] }));
    ok(one({ kind: "clickland.logs", namespace: "shop", workload: { kind: "Deployment", name: "api" }, range: "1h", errorsOnly: true }, { type: "logs", source: "s" }));
    ok({ ...one({ kind: "clickland.traces", namespace: { param: "ns" }, pod: "api-1", range: "6h" }), params: [{ name: "ns", type: "namespace" }] });
    ok(one({ kind: "tool", server: "github", tool: "list_pull_requests", arguments: { owner: "acme", state: "open", per_page: 20 }, rows: "items", fields: { name: "title" } }));
    expect([...CONNECTION_KINDS].sort()).toEqual(["clickland.logs", "clickland.traces", "gcp.alerts", "gcp.clusters", "gcp.metrics", "gcp.recommendations", "gcp.resources", "tool"]);
  });

  it("refuses what a connection source may not name", () => {
    expect(issues(one({ kind: "gcp.resources", project: "P!" }))).toContain("/sources/s/project: not a project id");
    // A cluster of another project: never read as this project's.
    expect(issues(one({ kind: "gcp.alerts", project: "my-project", cluster: "gke_other-proj_europe-west1_prod" }))).toEqual(["/sources/s/cluster: not a cluster of this project"]);
    expect(issues(one({ kind: "gcp.metrics", cluster: "prod", scope: "cluster", range: "1h" }, { type: "chart", source: "s", kind: "line", y: ["cpu"] }))[0]).toMatch(/^\/sources\/s\/cluster: not a GKE context/);
    expect(issues(one({ kind: "gcp.metrics", cluster: "gke_my-project_europe-west1_prod", scope: "pod", namespace: "shop", range: "1h" }, { type: "chart", source: "s", kind: "line", y: ["cpu"] }))).toEqual(["/sources/s/name: required"]);
    expect(issues(one({ kind: "clickland.logs", namespace: "shop", range: "1h" }, { type: "logs", source: "s" }))).toEqual(["/sources/s: a clickland.logs source names a pod or a workload (one of them)"]);
    expect(issues(one({ kind: "clickland.traces", namespace: "*", pod: "x", range: "1h" }))[0]).toMatch(/^\/sources\/s\/namespace/);
    // Landlens's own servers have their own kinds; a server name of the wrong shape is refused.
    expect(issues(one({ kind: "tool", server: "landlens-kube", tool: "list_resources" }))[0]).toMatch(/^\/sources\/s\/server: names starting with landlens/);
    expect(issues(one({ kind: "tool", server: "GitHub", tool: "x" }))[0]).toMatch(/^\/sources\/s\/server/);
  });

  it("refuses an argument that would carry a credential, and too many tool sources", () => {
    for (const k of ["token", "api_key", "apiKey", "password", "Authorization", "client_secret", "sessionId", "cookie"]) {
      expect(issues(one({ kind: "tool", server: "github", tool: "x", arguments: { [k]: "v" } }))[0]).toMatch(/a view can't carry credentials/);
    }
    expect(issues(one({ kind: "tool", server: "github", tool: "x", arguments: { __proto__x: 1, constructor: "y" } })).some((i) => /not an argument name Landlens allows/.test(i))).toBe(true);
    const tools = Object.fromEntries(Array.from({ length: VIEW_LIMITS.toolSources + 1 }, (_, i) => [`t${i}`, { kind: "tool", server: "github", tool: "x" }]));
    expect(issues({ schema: 1, title: "T", sources: tools, blocks: [{ type: "table", source: "t0", columns: [{ field: "name" }] }] })).toContain(
      `/sources: ${SENTENCES.overLimit("tool sources", VIEW_LIMITS.toolSources + 1, VIEW_LIMITS.toolSources)}`,
    );
  });
});

describe("the view file (D217)", () => {
  it("round-trips a document with nothing but name, document and time", () => {
    const d = ok(full());
    const w = writeViewFile("Restarts", d, Date.UTC(2026, 10, 16));
    if (!w.ok) throw new Error("expected the export to be written");
    expect(Object.keys(JSON.parse(w.text)).sort()).toEqual(["document", "exportedAt", "landlensView", "name"]);
    const r = readViewFile(w.text);
    expect(r.ok && r.document).toEqual(d);
    expect(viewFileName("Pods: restarts / today")).toBe("pods-restarts-today.landlens-view.json");
  });

  it("refuses an oversized file before parsing it", () => {
    const big = file(small(), { pad: "x".repeat(VIEW_LIMITS.importBytes) });
    const r = readViewFile(big);
    expect(!r.ok && r.issues[0]!.message).toMatch(/bytes in the view file/);
  });

  it("refuses unknown fields: a context, a token, rows", () => {
    for (const extra of [{ context: "prod" }, { server: "https://x" }, { token: "abc" }, { rows: [] }, { namespaces: ["a"] }]) {
      const r = readViewFile(file(small(), extra));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.issues.map(issueLine)).toEqual([`/${Object.keys(extra)[0]}: no such field`]);
    }
    expect(readViewFile("not json").ok).toBe(false);
    expect(!readViewFile(JSON.stringify({ landlensView: 2 })).ok).toBe(true);
  });

  it("refuses a Secret source, a block for another cluster and a token-looking string", () => {
    const secret = readViewFile(file(one({ kind: "kube.list", resource: "secrets" })));
    expect(!secret.ok && secret.issues.map(issueLine).join(" ")).toMatch(/\/document\/sources\/s\/resource/);
    const other = readViewFile(file(one({ kind: "gcp.alerts", project: "my-project", cluster: "gke_someone-else_us-east1-b_prod" })));
    expect(!other.ok && other.issues.map(issueLine)).toEqual(["/document/sources/s/cluster: not a cluster of this project"]);
    const tok = readViewFile(file({ ...small(), title: "ghp_0123456789abcdefghijABCDEFGHIJ012345" }));
    expect(!tok.ok && tok.issues.map(issueLine)).toEqual(["/document/title: holds text that looks like a credential: a view file never carries one"]);
    const deep = readViewFile(file(one({ kind: "kube.list", resource: "pods", labelSelector: "app=x" }, { type: "text", markdown: "password=hunter2hunter2" })));
    expect(!deep.ok && deep.issues.map(issueLine)[0]).toMatch(/^\/document\/blocks\/0\/markdown: holds text that looks like a credential/);
  });

  it("never writes a credential either", () => {
    const d = ok({ ...small(), title: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnopqrstuv" });
    expect(credentialIssues(d).length).toBeGreaterThan(0);
    expect(writeViewFile("x", d, 0).ok).toBe(false);
  });

  it("names a document's app blocks and its literal names", () => {
    const d = ok(full());
    expect(appBlocks(d).length).toBe(1);
    expect(literalNames(ok(one({ kind: "kube.list", resource: "pods", namespace: "shop" })))).toEqual([{ source: "s", what: "namespace shop" }]);
    expect(literalNames(ok(one({ kind: "kube.list", resource: "pods", namespace: "*" })))).toEqual([]);
    expect(literalNames(ok({ ...one({ kind: "kube.list", resource: "pods", namespace: { param: "ns" } }), params: [{ name: "ns", type: "namespace" }] }))).toEqual([]);
  });

  it("keeps tweaks to sort and widths only", () => {
    expect(Tweaks.safeParse({ "block-0": { sort: { field: "restarts", dir: "desc" }, widths: { name: 240 } } }).success).toBe(true);
    expect(Tweaks.safeParse({ "block-0": { sort: { field: "restarts", dir: "desc" }, filter: "x" } }).success).toBe(false);
    expect(Tweaks.safeParse({ "block-0": { widths: { name: 5000 } } }).success).toBe(false);
    expect(Tweaks.safeParse({ "../x": {} }).success).toBe(false);
  });
});

describe("a tool answer's rows path (D212)", () => {
  const path = (p: string) => parsePath(p) as ParsedPath;
  it("reads plain JSON through its own properties only, never an inherited one", () => {
    const answer = JSON.parse('{"data":{"items":[{"title":"a"}]}}');
    expect(readRaw(answer, path("data.items"))).toEqual([{ title: "a" }]);
    expect(readRaw(answer, path("data.items[0].title"))).toBe("a");
    for (const p of ["toString", "data.constructor", "data.items.length", "hasOwnProperty"]) {
      const pp = parsePath(p);
      if ("error" in pp) continue;
      expect(readRaw(answer, pp), p).toBeUndefined();
    }
    expect(readRaw({ a: 1 }, path("$name"))).toBeUndefined();
  });
});

// ---- security review of wave 10 part 4 (L1, L4, M2, M3, and L5's Q12, Q13) ---------------------------------------

describe("literalNames (L1): every place a source names one cluster's things", () => {
  const lit = (src: Record<string, unknown>, block?: Record<string, unknown>) => literalNames(ok(one(src, block))).map((l) => l.what);
  const chart = { type: "chart", source: "s", kind: "line", y: ["cpu"] };
  it("a field selector on a name, a namespace or a node", () => {
    expect(lit({ kind: "kube.list", resource: "pods", fieldSelector: "metadata.name=api-1" })).toEqual(["metadata.name api-1"]);
    expect(lit({ kind: "kube.list", resource: "pods", fieldSelector: "metadata.namespace=kube-system" })).toEqual(["metadata.namespace kube-system"]);
    expect(lit({ kind: "kube.list", resource: "pods", fieldSelector: "status.phase=Running,spec.nodeName!=node-1" })).toEqual(["spec.nodeName not node-1"]);
    expect(lit({ kind: "kube.list", resource: "pods", fieldSelector: "status.phase=Running" })).toEqual([]);
  });

  it("a GKE cluster and the objects gcp.metrics names", () => {
    expect(lit({ kind: "gcp.metrics", cluster: "gke_my-project_europe-west1_prod", scope: "node", name: "gke-prod-pool-1-abc", range: "1h" }, chart)).toEqual(["node gke-prod-pool-1-abc", "cluster gke_my-project_europe-west1_prod"]);
    expect(lit({ kind: "gcp.alerts", project: "my-project", cluster: "gke_my-project_europe-west1_prod" })).toEqual(["cluster gke_my-project_europe-west1_prod"]);
    expect(lit({ kind: "gcp.recommendations", project: "my-project", cluster: "gke_my-project_europe-west1_prod" })).toEqual(["cluster gke_my-project_europe-west1_prod"]);
    expect(lit({ kind: "gcp.alerts", project: "my-project" })).toEqual([]);
  });

  it("every argument of a tool source", () => {
    expect(lit({ kind: "tool", server: "clickland", tool: "search_logs", arguments: { cluster: "prod-eu", namespace: "payments" } })).toEqual([
      'clickland · search_logs argument cluster="prod-eu"', 'clickland · search_logs argument namespace="payments"',
    ]);
    expect(lit({ kind: "tool", server: "github", tool: "list_issues" })).toEqual([]);
  });
});

describe("the credential scan (L4)", () => {
  const tok = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
  const args = (a: Record<string, unknown>) => one({ kind: "tool", server: "mine", tool: "read", arguments: a });
  it("refuses a token split across two arguments, and one base64-encoded", () => {
    const split = readViewFile(file(args({ a: tok.slice(0, 20), b: tok.slice(20) })));
    expect(!split.ok && split.issues.map(issueLine)).toEqual(["/document/sources/s/arguments: holds text that looks like a credential: a view file never carries one"]);
    const b64 = readViewFile(file(args({ q: Buffer.from(tok).toString("base64") })));
    expect(!b64.ok && b64.issues.map(issueLine)).toEqual(["/document/sources/s/arguments/q: holds text that looks like a credential: a view file never carries one"]);
    const url = readViewFile(file(args({ q: Buffer.from(`password=${"h".repeat(12)}`).toString("base64url") })));
    expect(url.ok).toBe(false);
  });

  it("refuses arguments named key, pass, auth or pat, and access or private keys", () => {
    for (const k of ["key", "pass", "auth", "pat", "access_key", "accessKey", "signing_key", "auth_header", "authKey", "user_pass", "passphrase"]) {
      expect(issues(args({ [k]: "0123456789abcdef0123456789abcdef" }))[0]).toMatch(/a view can't carry credentials/);
    }
    // Names that only look alike stay: an issue key, a sort key, a bypass flag.
    ok(args({ issue_key: "ENG-1", sort_key: "created", bypass: false, compass: "n", monkey: 1 }));
  });

  it("passes ordinary text: a commit, a base64 that holds no credential, two plain arguments", () => {
    ok(args({ sha: "0123456789abcdef0123456789abcdef01234567", q: Buffer.from("just some ordinary words here").toString("base64"), owner: "acme", repo: "infra" }));
    expect(credentialIssues(ok(args({ owner: "acme", repo: "infra" })))).toEqual([]);
  });

  it("Q12, Q13: refuses a file whose name, or a key in its document, looks like a credential", () => {
    const named = readViewFile(file(small(), { name: tok }));
    expect(!named.ok && named.issues.map(issueLine)).toEqual(["/name: holds text that looks like a credential: a view file never carries one"]);
    const keyed = readViewFile(file(args({ [tok]: "x" })));
    expect(!keyed.ok && keyed.issues.map(issueLine)).toEqual(["/document/sources/s/arguments/<redacted github token>: holds text that looks like a credential: a view file never carries one"]);
  });
});

describe("trust items (M2, M3): what an imported view runs only after the person's yes", () => {
  const joined = () => ok({
    schema: 1, title: "T",
    sources: {
      pods: { kind: "kube.list", resource: "pods", fields: { name: "$name" }, pipe: [{ join: { with: "ev", on: { left: "name", right: "name" }, take: { note: "msg" } } }] },
      ev: { kind: "kube.events", fields: { name: "involvedObject.name", msg: "message" }, pipe: [{ join: { with: "gh", on: { left: "name", right: "name" }, take: { msg: "title" } } }] },
      gh: { kind: "tool", server: "github", tool: "get_file_contents", arguments: { owner: "acme", path: "prod.env" } },
      other: { kind: "kube.list", resource: "nodes" },
    },
    blocks: [{ type: "app", id: "count", title: "Count", uses: ["pods"], html: "<p></p>", js: "1" }],
  });

  it("reach: a block's sources and every source they join, transitively", () => {
    expect(reach(joined(), ["pods"])).toEqual(["pods", "ev", "gh"]);
    expect(reach(joined(), ["other"])).toEqual(["other"]);
  });

  it("one item per app block (with what it reaches) and per connection source; a change to either is a new key", () => {
    const d = joined();
    const items = trustItems(d);
    expect(items.map((t) => [t.kind, t.id])).toEqual([["block", "count"], ["source", "gh"]]);
    expect(items[0]).toMatchObject({ title: "Count", reaches: ["pods", "ev", "gh"] });
    for (const t of items) expect(t.key).toMatch(TRUST_KEY);
    const js = ok({ ...d, blocks: [{ ...d.blocks[0], js: "2" }] });
    expect(trustItems(js)[0]!.key).not.toBe(items[0]!.key);
    // A source the block reaches changes what it reads: the block's key changes too.
    const ev = ok({ ...d, sources: { ...d.sources, ev: { ...d.sources.ev!, namespace: "kube-system" } } });
    expect(trustItems(ev)[0]!.key).not.toBe(items[0]!.key);
    const arg = ok({ ...d, sources: { ...d.sources, gh: { kind: "tool", server: "github", tool: "get_file_contents", arguments: { owner: "acme", path: "other.env" } } } });
    expect(trustItems(arg)[1]!.key).not.toBe(items[1]!.key);
    expect(trustItems(ok(small()))).toEqual([]);
  });

  it("sourceWords names each kind with its target, a tool's arguments whole", () => {
    expect(sourceWords(ok(one({ kind: "tool", server: "github", tool: "get_file_contents", arguments: { owner: "acme", per_page: 5, open: true } })).sources.s)).toBe('github · get_file_contents with owner="acme", per_page=5, open=true');
    expect(sourceWords(ok(one({ kind: "gcp.resources", project: "my-project", query: "state:RUNNABLE" })).sources.s)).toBe('Google Cloud resources in project my-project matching "state:RUNNABLE"');
    expect(sourceWords(ok(one({ kind: "clickland.traces", namespace: "shop", workload: { kind: "Deployment", name: "api" }, range: "1h" })).sources.s)).toBe("Clickland traces of Deployment api in shop");
    expect(sourceWords(ok(one({ kind: "kube.list", resource: "pods", namespace: "shop", labelSelector: "app=x", fieldSelector: "metadata.name=y" })).sources.s)).toBe("pods in shop labelled app=x where metadata.name=y");
    const long = "z".repeat(500);
    expect(sourceWords(ok(one({ kind: "tool", server: "mine", tool: "t", arguments: { q: long } })).sources.s)).toBe(`mine · t with q="${long}"`);
  });
});

import { describe, expect, it } from "vitest";
import { issueLine, MAX_ISSUES, SENTENCES } from "../src/errors.js";
import { VIEW_LIMITS } from "../src/limits.js";
import { countedSources, parseDocument, REFUSED_TAGS } from "../src/schema.js";
import { full, small } from "./docs.js";

const issues = (d: unknown) => {
  const r = parseDocument(d);
  if (r.ok) throw new Error("expected the document to be refused");
  return r.issues.map(issueLine);
};
const ok = (d: unknown) => {
  const r = parseDocument(d);
  if (!r.ok) throw new Error(`expected the document to pass: ${r.issues.map(issueLine).join("; ")}`);
  return r.document;
};

describe("the view document (D206)", () => {
  it("takes every block and every part-1 source kind", () => {
    const d = ok(full());
    expect(Object.values(d.sources).map((s) => s.kind).sort()).toEqual(
      ["doctor.problems", "helm.releases", "kube.events", "kube.list", "kube.list", "kube.logs", "kube.top", "metrics.series"].sort(),
    );
    expect(d.blocks.map((b) => b.type)).toEqual(["table", "stat", "chart", "chart", "list", "logs", "problems", "text", "app"]);
  });

  it("refuses an unknown key anywhere by its pointer", () => {
    expect(issues({ ...small(), extra: 1 })).toEqual(["/extra: no such field"]);
    expect(issues(small({ sources: { pods: { kind: "kube.list", resource: "pods", url: "https://x" } } }))).toEqual(["/sources/pods/url: no such field"]);
    expect(issues(small({ blocks: [{ type: "table", source: "pods", columns: [{ field: "name", onClick: "x" }] }] }))).toEqual(["/blocks/0/columns/0/onClick: no such field"]);
    expect(issues(small({ sources: { pods: { kind: "kube.list", resource: "pods", pipe: [{ eval: "1+1" }] } } }))).toEqual(["/sources/pods/pipe/0/eval: no such field"]);
    expect(issues(small({ sources: { pods: { kind: "kube.list", resource: "pods", pipe: [{ limit: 5, sort: [] }] } } }))[0]).toMatch(/^\/sources\/pods\/pipe\/0: a step is an object with exactly one of/);
  });

  it("refuses a source kind it doesn't know (part 4's are not in part 1)", () => {
    expect(issues(small({ sources: { g: { kind: "gcp.resources", project: "p" } } }))).toEqual(["/sources/g/kind: not a known kind"]);
    expect(issues(small({ sources: { t: { kind: "tool", server: "github", tool: "x" } } }))).toEqual(["/sources/t/kind: not a known kind"]);
  });

  it("refuses a block on the wrong kind of source", () => {
    const d = full();
    expect(issues({ ...d, blocks: [{ type: "logs", source: "pods" }] })).toEqual(["/blocks/0/source: a logs block needs a kube.logs source"]);
    expect(issues({ ...d, blocks: [{ type: "problems", source: "pods" }] })).toEqual(["/blocks/0/source: a problems block needs a doctor.problems source"]);
    expect(issues({ ...d, blocks: [{ type: "table", source: "logs", columns: [{ field: "x" }] }] })).toEqual(["/blocks/0/source: a kube.logs source is shown by a logs block"]);
    expect(issues({ ...d, blocks: [{ type: "chart", source: "pods", kind: "line", y: ["restarts"] }] })).toEqual(["/blocks/0/x: required (only a metrics.series chart is over time without one)"]);
    expect(issues({ ...d, blocks: [{ type: "table", source: "nope", columns: [{ field: "x" }] }] })).toEqual(["/blocks/0/source: no such source"]);
    expect(issues({ ...d, blocks: [{ type: "app", id: "a", uses: ["nope"], html: "" }] })).toEqual(["/blocks/0/uses/0: no such source"]);
  });

  it("refuses bad ids and field names", () => {
    expect(issues(small({ sources: { Pods: { kind: "kube.list", resource: "pods" } }, blocks: [{ type: "text", markdown: "x" }] }))).toEqual(["/sources/Pods: not a valid name here"]);
    expect(issues(small({ blocks: [{ type: "app", id: "9lives", uses: [], html: "" }] }))[0]).toMatch(/^\/blocks\/0\/id: not an id/);
    expect(issues(small({ blocks: [{ type: "table", source: "pods", columns: [{ field: "constructor" }] }] }))).toEqual(["/blocks/0/columns/0/field: not a field name Landlens allows"]);
    expect(issues(small({ blocks: [{ type: "table", source: "pods", columns: [{ field: "__proto__" }] }] }))[0]).toMatch(/^\/blocks\/0\/columns\/0\/field: not a field name/);
  });

  it("refuses Secrets with D222's sentence, in any group", () => {
    expect(issues(small({ sources: { s: { kind: "kube.list", resource: "secrets" } }, blocks: [{ type: "text", markdown: "x" }] }))).toEqual([`/sources/s/resource: ${SENTENCES.secrets}`]);
    expect(issues(small({ sources: { s: { kind: "kube.list", resource: "secrets", group: "example.com" } }, blocks: [{ type: "text", markdown: "x" }] }))).toEqual([`/sources/s/resource: ${SENTENCES.secrets}`]);
  });

  it("refuses names a path couldn't carry and selectors with %, ?, # or &", () => {
    for (const ns of ["../secrets", "a/b", "kube%2fsystem", "Default"]) {
      expect(issues(small({ sources: { pods: { kind: "kube.list", resource: "pods", namespace: ns } } }))[0]).toMatch(/^\/sources\/pods\/namespace: /);
    }
    for (const sel of ["app=a%2Cb", "app=a&watch=1", "app=a?x", "app=a#x", "app=a\nb"]) {
      expect(issues(small({ sources: { pods: { kind: "kube.list", resource: "pods", labelSelector: sel } } }))[0]).toMatch(/^\/sources\/pods\/labelSelector: a selector may only use/);
    }
    expect(ok(small({ sources: { pods: { kind: "kube.list", resource: "pods", labelSelector: "app in (a, b),!canary,tier!=db" } } }))).toBeTruthy();
  });

  it("refuses a path that names __proto__, constructor or prototype, or is malformed", () => {
    for (const p of ["__proto__", "metadata.__proto__", 'metadata["constructor"]', "spec.prototype", "a..b", "a[100]", "a.b.c.d.e.f.g.h.i", "$nope", "x".repeat(201)]) {
      expect(issues(small({ sources: { pods: { kind: "kube.list", resource: "pods", fields: { f: p } } } }))[0]).toMatch(/^\/sources\/pods\/fields\/f: /);
    }
  });

  it("refuses each refused tag in a fragment's html, css or js, by name", () => {
    for (const tag of REFUSED_TAGS) {
      for (const part of ["html", "css", "js"]) {
        const block = { type: "app", id: "a", uses: [], html: "<p>x</p>", [part]: `x <${tag.toUpperCase()} y>` };
        expect(issues(small({ blocks: [block] }))).toEqual([`/blocks/0/${part}: a block's html can't contain <${tag}>.`]);
      }
    }
    expect(issues(small({ blocks: [{ type: "app", id: "a", uses: [], html: "</form >" }] }))).toEqual(["/blocks/0/html: a block's html can't contain <form>."]);
    // A tag that only starts like one is fine.
    expect(ok(small({ blocks: [{ type: "app", id: "a", uses: [], html: "<header>x</header><linked-list></linked-list>" }] }))).toBeTruthy();
  });

  it("returns an unknown key, Secrets and a <form> together (e2e 6's three sentences)", () => {
    const bad = small({
      sources: { pods: { kind: "kube.list", resource: "secrets", colour: "red" } },
      blocks: [{ type: "app", id: "a", uses: [], html: "<form></form>" }],
    });
    expect(issues(bad).sort()).toEqual(["/blocks/0/html: a block's html can't contain <form>.", "/sources/pods/colour: no such field", `/sources/pods/resource: ${SENTENCES.secrets}`].sort());
  });

  it("refuses control and invisible characters in Claude's text, and drops variation selectors", () => {
    for (const t of ["a\u0000b", "a\u202eb", "a\u200bb", "a\u2028b", "a\u{E0041}b", "a\u{F0000}b", "a\u3164b", "a\nb"]) {
      expect(issues(small({ title: t }))).toEqual(["/title: text can't hold control or invisible characters"]);
    }
    expect(ok(small({ title: "Warnings ⚠\ufe0f" })).title).toBe("Warnings ⚠");
    expect(ok(small({ blocks: [{ type: "text", markdown: "line one\r\nline\ttwo" }] })).blocks[0]).toMatchObject({ markdown: "line one\nline\ttwo" });
    expect(issues(small({ blocks: [{ type: "text", markdown: "a\n\u202eb" }] }))).toEqual(["/blocks/0/markdown: text can't hold control or invisible characters"]);
  });

  it("refuses numbers that aren't numbers", () => {
    // JSON has no NaN or Infinity: they arrive as null and are refused as not numbers.
    expect(issues(small({ blocks: [{ type: "app", id: "a", uses: [], html: "", minHeight: Number.NaN }] }))).toEqual(["/blocks/0/minHeight: expected a number"]);
    expect(issues(small({ sources: { pods: { kind: "kube.list", resource: "pods", pipe: [{ limit: Infinity }] } } }))).toEqual(["/sources/pods/pipe/0/limit: expected a number"]);
    expect(issues(small({ sources: { pods: { kind: "kube.list", resource: "pods", pipe: [{ limit: 2.5 }] } } }))).toEqual(["/sources/pods/pipe/0/limit: expected a whole number"]);
  });

  it("checks parameters and what refers to them", () => {
    expect(issues(small({ sources: { pods: { kind: "kube.list", resource: "pods", namespace: { param: "ns" } } } }))).toEqual(["/sources/pods/namespace/param: no such parameter"]);
    expect(issues(small({ params: [{ name: "ns", type: "text" }], sources: { pods: { kind: "kube.list", resource: "pods", namespace: { param: "ns" } } } }))).toEqual(["/sources/pods/namespace/param: a namespace parameter is needed here"]);
    expect(issues(small({ params: [{ name: "a", type: "text" }, { name: "a", type: "text" }] }))).toEqual(["/params/1/name: another parameter has this name"]);
    expect(issues(small({ params: [{ name: "c", type: "choice", options: ["x"], default: "y" }] }))).toEqual(["/params/0/default: not one of the options"]);
    expect(issues(small({ sources: { pods: { kind: "kube.list", resource: "pods", pipe: [{ filter: [{ field: "name", op: "in", value: ["a", { param: "q" }] }] }] } } }))).toEqual(["/sources/pods/pipe/0/filter/0/value/1/param: no such parameter"]);
  });

  it("checks joins: another source of this view, never itself, never in a circle", () => {
    const join = (w: string) => ({ join: { with: w, on: { left: "a", right: "b" }, take: { c: "d" } } });
    expect(issues(small({ sources: { pods: { kind: "kube.list", resource: "pods", pipe: [join("pods")] } } }))).toEqual(["/sources/pods/pipe/0/join/with: a source can't join itself"]);
    expect(issues(small({ sources: { pods: { kind: "kube.list", resource: "pods", pipe: [join("nope")] } } }))).toEqual(["/sources/pods/pipe/0/join/with: no such source"]);
    expect(issues(small({ sources: { pods: { kind: "kube.list", resource: "pods", pipe: [{ join: { with: "x", on: { left: "a", right: "b" } } }] } } }))).toEqual(["/sources/pods/pipe/0/join: a join takes fields (take) or aggregates (agg) from the other source"]);
    const circle = small({
      sources: {
        a: { kind: "kube.list", resource: "pods", pipe: [join("b")] },
        b: { kind: "kube.list", resource: "services", pipe: [join("c")] },
        c: { kind: "kube.list", resource: "nodes", pipe: [join("a")] },
      },
      blocks: [{ type: "text", markdown: "x" }],
    });
    expect(issues(circle)).toEqual(["/sources/a: these sources join each other in a circle: a → b → c → a"]);
  });

  it("checks a logs source, a top of nodes and a series' scope", () => {
    const d = (s: unknown) => small({ sources: { s }, blocks: [{ type: "text", markdown: "x" }] });
    expect(issues(d({ kind: "kube.logs", namespace: "a" }))).toEqual(["/sources/s: a kube.logs source names a pod or a workload (one of them)"]);
    expect(issues(d({ kind: "kube.logs", namespace: "a", pod: "p", workload: { kind: "Job", name: "j" } }))).toEqual(["/sources/s: a kube.logs source names a pod or a workload (one of them)"]);
    expect(issues(d({ kind: "kube.logs", namespace: "a", pod: "p", fields: { x: "y" } }))).toEqual(["/sources/s/fields: no such field"]);
    expect(issues(d({ kind: "kube.top", of: "nodes", namespace: "a" }))).toEqual(["/sources/s/namespace: nodes have no namespace"]);
    expect(issues(d({ kind: "metrics.series", scope: "pod", range: "1h" }))).toEqual(["/sources/s/namespace: required", "/sources/s/name: required"]);
    expect(issues(d({ kind: "metrics.series", scope: "cluster", namespace: "a", range: "1h" }))).toEqual(["/sources/s/namespace: a cluster series has no namespace"]);
    expect(issues(d({ kind: "metrics.series", scope: "workload", range: "1h" }))[0]).toMatch(/^\/sources\/s\/scope: expected /);
    expect(issues(d({ kind: "kube.top", of: "pods", fields: { n: "$name" } }))).toEqual(["/sources/s/fields/n: computed names read Kubernetes objects: only kube.list and kube.events rows have them"]);
  });

  it("returns at most 20 issues", () => {
    const columns = Array.from({ length: 16 }, () => ({ field: "x", bad: 1, worse: 2 }));
    const r = parseDocument(small({ blocks: [{ type: "table", source: "pods", columns }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toHaveLength(MAX_ISSUES);
  });

  it("refuses something that isn't JSON", () => {
    const cyclic: Record<string, unknown> = small();
    cyclic.self = cyclic;
    expect(issues(cyclic)).toEqual(["the document isn't JSON"]);
    expect(issues(small({ title: 10n as unknown as string }))).toEqual(["the document isn't JSON"]);
  });
});

describe("D225's limits, at the limit and one past", () => {
  const L = VIEW_LIMITS;
  const sourcesOf = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, { kind: "kube.list", resource: "pods" }]));
  const text = { type: "text", markdown: "x" };

  it("a document of 400,000 characters", () => {
    const base = JSON.stringify(small({ blocks: [{ type: "text", markdown: "" }] })).length;
    // Long markdown is cut by its own limit first, so the size comes from an app block's js.
    const at = (n: number) => small({ blocks: [{ type: "app", id: "a", uses: [], html: "", js: "x".repeat(n) }, ...Array.from({ length: 3 }, (_, i) => ({ type: "app", id: `b${i}`, uses: [], html: "y".repeat(n) }))] });
    const fits = (n: number) => JSON.stringify(at(n)).length;
    let n = Math.floor((L.documentChars - base) / 4) - 200;
    while (fits(n + 1) <= L.documentChars) n++;
    expect(fits(n)).toBeLessThanOrEqual(L.documentChars);
    expect(n).toBeLessThanOrEqual(L.appChars);
    // Pad the title to land exactly on the limit, then one more character.
    const doc = at(n) as Record<string, unknown>;
    const pad = L.documentChars - JSON.stringify(doc).length;
    expect(pad).toBeLessThan(80);
    doc.title = "A view" + "x".repeat(pad);
    expect(JSON.stringify(doc).length).toBe(L.documentChars);
    ok(doc);
    doc.title = "A view" + "x".repeat(pad + 1);
    expect(issues(doc)).toEqual([`Too many characters in the document: ${L.documentChars + 1}, the limit is ${L.documentChars}.`]);
  });

  it("8 sources, the hidden ones $workload adds included", () => {
    ok(small({ sources: sourcesOf(L.sources), blocks: [text] }));
    expect(issues(small({ sources: sourcesOf(L.sources + 1), blocks: [text] }))).toEqual([`/sources: ${SENTENCES.overLimit("sources (with the hidden ones $workload adds)", 9, 8)}`]);
    const withWorkload = { ...sourcesOf(5), w: { kind: "kube.list", resource: "pods", fields: { o: "$workload" } } };
    expect(countedSources(withWorkload as never)).toBe(8);
    ok(small({ sources: withWorkload, blocks: [text] }));
    // A second $workload source over the same namespaces shares the hidden watches; over others it adds two more.
    expect(countedSources({ ...withWorkload, w2: { kind: "kube.list", resource: "pods", fields: { o: "$workload" } } } as never)).toBe(9);
    expect(countedSources({ ...sourcesOf(4), w: withWorkload.w, w2: { kind: "kube.list", resource: "pods", namespace: "a", fields: { o: "$workload" } } } as never)).toBe(10);
    expect(issues(small({ sources: { ...withWorkload, x: { kind: "kube.list", resource: "nodes" } }, blocks: [text] }))[0]).toMatch(/Too many sources .*: 9, the limit is 8\./);
  });

  it("24 blocks, 4 of them app blocks", () => {
    ok(small({ blocks: Array.from({ length: L.blocks }, () => text) }));
    expect(issues(small({ blocks: Array.from({ length: L.blocks + 1 }, () => text) }))).toEqual([`/blocks: Too many blocks: 25, the limit is 24.`]);
    const app = (i: number) => ({ type: "app", id: `a${i}`, uses: [], html: "" });
    ok(small({ blocks: Array.from({ length: L.appBlocks }, (_, i) => app(i)) }));
    expect(issues(small({ blocks: Array.from({ length: L.appBlocks + 1 }, (_, i) => app(i)) }))).toEqual([`/blocks: Too many app blocks: 5, the limit is 4.`]);
  });

  it("150,000 characters of html, css and js in one app block", () => {
    const third = L.appChars / 3;
    ok(small({ blocks: [{ type: "app", id: "a", uses: [], html: "x".repeat(third), css: "y".repeat(third), js: "z".repeat(third) }] }));
    expect(issues(small({ blocks: [{ type: "app", id: "a", uses: [], html: "x".repeat(third), css: "y".repeat(third), js: "z".repeat(third + 1) }] })))
      .toEqual([`/blocks/0: Too many characters in this block's html, css and js: 150001, the limit is 150000.`]);
  });

  it("16 columns, 8 steps, 24 fields, a limit of 2,000, 2 log sources", () => {
    const cols = (n: number) => small({ blocks: [{ type: "table", source: "pods", columns: Array.from({ length: n }, () => ({ field: "x" })) }] });
    ok(cols(L.columns));
    expect(issues(cols(L.columns + 1))).toEqual(["/blocks/0/columns: at most 16 items"]);
    const steps = (n: number) => small({ sources: { pods: { kind: "kube.list", resource: "pods", pipe: Array.from({ length: n }, () => ({ limit: 5 })) } } });
    ok(steps(L.steps));
    expect(issues(steps(L.steps + 1))).toEqual(["/sources/pods/pipe: at most 8 items"]);
    const fields = (n: number) => small({ sources: { pods: { kind: "kube.list", resource: "pods", fields: Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, "$name"])) } } });
    ok(fields(L.fields));
    expect(issues(fields(L.fields + 1))).toEqual(["/sources/pods/fields: at most 24 entries"]);
    ok(small({ sources: { pods: { kind: "kube.list", resource: "pods", pipe: [{ limit: L.rows }] } } }));
    expect(issues(small({ sources: { pods: { kind: "kube.list", resource: "pods", pipe: [{ limit: L.rows + 1 }] } } }))).toEqual(["/sources/pods/pipe/0/limit: at most 2000"]);
    const logs = (n: number) => small({ sources: Object.fromEntries(Array.from({ length: n }, (_, i) => [`l${i}`, { kind: "kube.logs", namespace: "a", pod: "p" }])), blocks: [text] });
    ok(logs(L.logsSources));
    expect(issues(logs(L.logsSources + 1))).toEqual(["/sources: Too many kube.logs sources: 3, the limit is 2."]);
    const tail = (n: number) => small({ sources: { l: { kind: "kube.logs", namespace: "a", pod: "p", tailLines: n } }, blocks: [text] });
    ok(tail(L.logLines));
    expect(issues(tail(L.logLines + 1))).toEqual(["/sources/l/tailLines: at most 500"]);
  });
});

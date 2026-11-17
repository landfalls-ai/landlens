// The block runtime's `view.el` (src/app/runtime.js), run in a stand-in for the frame's window and document: the
// browser's own checks (the CSP, the sandbox) are views.e2e 4's; this is what el itself lets through.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

class FakeNode {
  readonly attrs = new Map<string, string>();
  readonly children: unknown[] = [];
  textContent = "";
  constructor(readonly tag: string) {}
  setAttribute(k: string, v: string) {
    this.attrs.set(k.toLowerCase(), v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k.toLowerCase()) ?? null;
  }
  appendChild(c: unknown) {
    this.children.push(c);
  }
  set className(v: string) {
    this.attrs.set("class", v);
  }
}

type El = (tag: string, attrs?: Record<string, unknown> | null, ...children: unknown[]) => FakeNode;

type Intents = { openObject(r: unknown): unknown; logs(r: unknown): unknown; ask(r: unknown): unknown; select(r: unknown): unknown; action(v: string, r: unknown): unknown };

function load(): { el: El; made: string[]; view: Intents; posted: { method?: string; params?: { url?: string } }[] } {
  const made: string[] = [];
  const posted: { method?: string; params?: { url?: string } }[] = [];
  const document = {
    createElement: (t: string) => (made.push(t), new FakeNode(t)),
    createTextNode: (t: string) => ({ text: t }),
    getElementById: () => null,
    documentElement: { setAttribute() {}, style: { setProperty() {} }, classList: { toggle() {}, contains: () => false } },
  };
  const window: Record<string, unknown> = { parent: { postMessage: (m: { method?: string }) => posted.push(m) }, addEventListener() {} };
  const src = readFileSync(join(__dirname, "../src/app/runtime.js"), "utf8");
  new Function("window", "document", "Node", "ResizeObserver", src)(window, document, FakeNode, class {});
  return { el: (window.view as { el: El }).el, made, view: window.view as Intents, posted };
}

describe("view.el (review of wave 10 part 2, L1)", () => {
  it("reads an address as the URL parser does: tabs, newlines and control characters don't hide javascript:", () => {
    const { el } = load();
    for (const href of ["javascript:alert(1)", "java\tscript:alert(1)", "java\nscript:alert(1)", "\x01javascript:alert(1)", " \x00jav\rascript:x", "JaVaScRiPt:x", "data:text/html,<b>x", "vbscript:x", "//evil.example/x", "http://evil.example/", "relative/path"]) {
      expect(el("a", { href }).getAttribute("href"), JSON.stringify(href)).toBeNull();
    }
    for (const src of ["java\tscript:x", "data:image/png;base64,AA", "https://x/a.png"]) {
      const kept = src.startsWith("https:");
      expect(el("img", { src }).getAttribute("src") !== null, src).toBe(kept);
    }
    expect(el("a", { formaction: "\x0ajavascript:x", ping: "java\tscript:x", poster: "data:x" }).attrs.size).toBe(0);
  });

  it("keeps https:, mailto:, landlens: and #fragment addresses", () => {
    const { el } = load();
    for (const href of ["https://kubernetes.io/docs", "mailto:ops@example.com", "landlens://object/Pod/landlens-dev/api", "#top"]) expect(el("a", { href }).getAttribute("href")).toBe(href);
  });

  it("makes no script, frame, object, link, meta or base, and sets no srcdoc or event handler", () => {
    const { el, made } = load();
    for (const tag of ["script", "SCRIPT", "iframe", "frame", "object", "embed", "link", "meta", "base", "scr\tipt"]) {
      expect(() => el(tag, null, "window.ran = 1"), tag).toThrow(/doesn't make/);
    }
    expect(made).toEqual([]);
    const d = el("div", { srcdoc: "<script>x</script>", SrcDoc: "x", onclick: "x", ONMOUSEOVER: "x", title: "kept" }, "<b>text</b>");
    expect([...d.attrs.keys()]).toEqual(["title"]);
    expect(d.children).toEqual([{ text: "<b>text</b>" }]);
  });
});

describe("view's intents (wave 10 part 3, D219)", () => {
  it("asks for each intent as a landlens:// link that parseIntent takes", async () => {
    const { parseIntent } = await import("../src/intent");
    const { view, posted } = load();
    const ref = { group: "apps", version: "v1", resource: "deployments", kind: "Deployment", namespace: "landlens-dev", name: "api" };
    view.openObject(ref);
    view.logs(ref);
    view.ask(ref);
    view.action("restart", ref);
    view.select([ref, { ...ref, name: "web" }, null]);
    view.select([{ kind: "ClusterRole", name: "system:view" }]);
    const urls = posted.filter((m) => m.method === "ui/open-link").map((m) => m.params!.url!);
    expect(urls).toEqual([
      "landlens://object/Deployment/landlens-dev/api",
      "landlens://logs/Deployment/landlens-dev/api",
      "landlens://ask/Deployment/landlens-dev/api",
      "landlens://action/restart/Deployment/landlens-dev/api",
      "landlens://select/Deployment/landlens-dev/api/landlens-dev/web",
      "landlens://select/ClusterRole/_/system%3Aview",
    ]);
    for (const u of urls) expect(parseIntent(u), u).toBeDefined();
    // A delete is spelled the same way and refused by the parser (and again by main).
    view.action("delete", ref);
    expect(parseIntent(posted.at(-1)!.params!.url)).toBeUndefined();
  });

  it("asks for at most 50 rows in a selection (L2's M16 of part 3)", async () => {
    const { parseIntent } = await import("../src/intent");
    const { view, posted } = load();
    const ref = (i: number) => ({ kind: "Deployment", namespace: "landlens-dev", name: `d${i}` });
    view.select(Array.from({ length: 60 }, (_, i) => ref(i)));
    const url = posted.at(-1)!.params!.url!;
    expect(url.split("/").length - 4).toBe(100);
    expect(url.endsWith("/landlens-dev/d49")).toBe(true);
    expect(parseIntent(url)).toBeDefined();
  });

  it("sends nothing for an empty selection", async () => {
    const { view, posted } = load();
    const n = posted.length;
    await expect(view.select([])).resolves.toEqual({ isError: true });
    expect(posted.length).toBe(n);
  });
});

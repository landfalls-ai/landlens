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

function load(): { el: El; made: string[] } {
  const made: string[] = [];
  const document = {
    createElement: (t: string) => (made.push(t), new FakeNode(t)),
    createTextNode: (t: string) => ({ text: t }),
    getElementById: () => null,
    documentElement: { setAttribute() {}, style: { setProperty() {} }, classList: { toggle() {}, contains: () => false } },
  };
  const window: Record<string, unknown> = { parent: { postMessage() {} }, addEventListener() {} };
  const src = readFileSync(join(__dirname, "../src/app/runtime.js"), "utf8");
  new Function("window", "document", "Node", "ResizeObserver", src)(window, document, FakeNode, class {});
  return { el: (window.view as { el: El }).el, made };
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

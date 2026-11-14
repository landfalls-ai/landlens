import { describe, expect, it } from "vitest";
import { forModel, preAllowed, toolInfo, toolUi } from "../src/index.js";

const tool = (name: string, extra: Record<string, unknown> = {}): any => ({ name, inputSchema: { type: "object" as const }, ...extra });

describe("approval classification", () => {
  it("pre-allows only tools that say they only read and that the model may call", () => {
    const allow = preAllowed([
      { name: "landlens-kube", tools: [tool("anything")] },
      { name: "clickland", tools: [
        tool("list_services", { annotations: { readOnlyHint: true } }),
        tool("render_view", { annotations: { readOnlyHint: false } }),
        tool("no_annotations"),
        tool("destructive_but_readonly_false", { annotations: { destructiveHint: false } }),
        tool("app_only", { annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ["app"] } } }),
        tool("weird name", { annotations: { readOnlyHint: true } }),
      ] },
    ]);
    expect(allow).toEqual(["mcp__landlens-kube", "mcp__clickland__list_services"]);
  });

  it("reads MCP Apps metadata, including the deprecated flat key, and defaults visibility to both", () => {
    expect(toolUi(tool("a", { _meta: { ui: { resourceUri: "ui://x/v" } } }))).toEqual({ resourceUri: "ui://x/v", visibility: ["model", "app"] });
    expect(toolUi(tool("a", { _meta: { "ui/resourceUri": "ui://x/old" } }))).toEqual({ resourceUri: "ui://x/old", visibility: ["model", "app"] });
    expect(toolUi(tool("a", { _meta: { ui: { resourceUri: "https://evil/x", visibility: ["app", "bogus"] } } }))).toEqual({ visibility: ["app"] });
    expect(toolInfo(tool("a", { inputSchema: { type: "object", required: ["q"] }, annotations: { readOnlyHint: true } }))).toMatchObject({ readOnly: true, required: ["q"] });
  });

  it("gives the model the text and keeps a view's structured data for the view", () => {
    const withUi = tool("a", { _meta: { ui: { resourceUri: "ui://x/v" } } });
    const r = { content: [{ type: "text" as const, text: "t" }], structuredContent: { big: 1 } };
    expect(forModel(r, withUi)).toEqual({ content: r.content });
    expect(forModel(r, tool("b"))).toBe(r);
    expect(forModel(r, { ...withUi, outputSchema: { type: "object" } } as never)).toBe(r);
    expect(forModel({ content: [], structuredContent: { x: 1 } }, withUi)).toEqual({ content: [], structuredContent: { x: 1 } });
  });
});

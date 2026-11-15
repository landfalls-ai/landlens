// The ⌘K palette's rules (wave 4, part 4; D44): actions that fit a kind, name matching, and a query's first word.
import { describe, expect, it } from "vitest";
import { parseQuery, score, verbsFor } from "../src/renderer/src/paletteRules";

const kind = (kind: string, group = "", resource = kind.toLowerCase() + "s") => ({ kind, group, resource });

describe("the ⌘K palette's rules", () => {
  it("reads a first word as an action, > as commands, and anything else as a search", () => {
    expect(parseQuery("shell catalog")).toEqual({ verb: "shell", text: "catalog", commands: false });
    expect(parseQuery("Logs  Web-1 ")).toEqual({ verb: "logs", text: "web-1", commands: false });
    expect(parseQuery("forward")).toEqual({ verb: "forward", text: "", commands: false });
    expect(parseQuery("> new term")).toEqual({ text: "new term", commands: true });
    // A name that only starts with a verb is a name.
    expect(parseQuery("shellcheck")).toEqual({ text: "shellcheck", commands: false });
    expect(parseQuery("  web ")).toEqual({ text: "web", commands: false });
  });

  it("ranks a prefix over a substring over letters in order", () => {
    expect(score("catalog-api", "cat")).toBe(0);
    expect(score("shop-catalog", "cat")).toBe(1);
    expect(score("catalog-api", "cap")).toBe(2);
    expect(score("catalog-api", "xyz")).toBeUndefined();
    expect(score("Web", "w")).toBe(0);
  });

  it("offers only the actions that fit the kind, and never editing a Secret", () => {
    expect(verbsFor(kind("Pod"))).toEqual(["logs", "shell", "forward", "edit", "ask"]);
    expect(verbsFor(kind("Deployment", "apps"))).toEqual(["logs", "shell", "edit", "ask"]);
    expect(verbsFor(kind("Service"))).toEqual(["forward", "edit", "ask"]);
    expect(verbsFor(kind("Secret"))).toEqual(["ask"]);
    expect(verbsFor(kind("ConfigMap"))).toEqual(["edit", "ask"]);
  });
});

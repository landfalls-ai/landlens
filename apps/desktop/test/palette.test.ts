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
    expect(verbsFor(kind("Pod"))).toEqual(["logs", "shell", "forward", "edit", "ask", "delete"]);
    expect(verbsFor(kind("Deployment", "apps"))).toEqual(["logs", "shell", "edit", "scale", "restart", "ask", "delete"]);
    expect(verbsFor(kind("Service"))).toEqual(["forward", "edit", "ask", "delete"]);
    expect(verbsFor(kind("Secret"))).toEqual(["ask", "delete"]);
    expect(verbsFor(kind("ConfigMap"))).toEqual(["edit", "ask", "delete"]);
  });

  it("offers your actions by kind, after edit, and delete never first (wave 8, D146)", () => {
    expect(verbsFor(kind("CronJob", "batch"))).toEqual(["edit", "trigger", "ask", "delete"]);
    expect(verbsFor(kind("DaemonSet", "apps"))).toEqual(["logs", "shell", "edit", "restart", "ask", "delete"]);
    expect(verbsFor(kind("StatefulSet", "apps"))).toEqual(["logs", "shell", "edit", "scale", "restart", "ask", "delete"]);
    // A custom kind that shares a name with a built-in one gets no built-in action.
    expect(verbsFor(kind("Deployment", "example.com"))).not.toContain("scale");
    for (const k of ["Pod", "Deployment", "Secret", "ConfigMap", "CronJob", "Namespace"]) expect(verbsFor(kind(k, k === "Deployment" ? "apps" : k === "CronJob" ? "batch" : ""))[0]).not.toBe("delete");
    expect(parseQuery("scale web")).toEqual({ verb: "scale", text: "web", commands: false });
    expect(parseQuery("Delete hands-cm-1")).toEqual({ verb: "delete", text: "hands-cm-1", commands: false });
    expect(parseQuery("trigger")).toEqual({ verb: "trigger", text: "", commands: false });
    // A name that starts with a verb is a name.
    expect(parseQuery("delete-me")).toEqual({ text: "delete-me", commands: false });
    expect(parseQuery("restarter")).toEqual({ text: "restarter", commands: false });
  });
});

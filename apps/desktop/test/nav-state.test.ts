// The sidebar's folds (D139): what a stored value may be, the defaults, fold all, the roll-up badge on a folded header,
// and the rule that a folded header still shows the page you are on.
import type { Problem } from "@landlens/contracts";
import { describe, expect, it } from "vitest";
import {
  allSections, badgeWords, isOpen, NO_FOLDS, OPEN_BY_DEFAULT, readNavFolds, rollUp, setAll, setOpen, shownRows, writeNavFolds,
} from "../src/renderer/src/navState";

const problem = (kind: string, tone: "bad" | "warn", podCount = 0): Problem =>
  ({ id: `${kind}-${tone}-${Math.random()}`, class: "crashloop", tone, kind, name: "x", group: "", version: "v1", resource: "", reason: "", title: "", podCount } as unknown as Problem);

describe("the sidebar's folds", () => {
  it("opens the known sections and folds the rest until you choose", () => {
    for (const s of ["Workspace", "Pinned", "Cloud", "Workloads", "Network", "Config", "Storage", "Access", "Cluster"]) expect(isOpen(NO_FOLDS, s)).toBe(true);
    for (const s of ["Custom resources", "core", "cert-manager.io"]) expect(isOpen(NO_FOLDS, s)).toBe(false);
    expect(OPEN_BY_DEFAULT).toContain("Workloads");
  });

  it("records a choice either way, so it outlives a changed default", () => {
    let f = setOpen(NO_FOLDS, "Workloads", false);
    expect(f).toEqual({ closed: ["Workloads"], opened: [] });
    expect(isOpen(f, "Workloads")).toBe(false);
    f = setOpen(f, "Custom resources", true);
    expect(isOpen(f, "Custom resources")).toBe(true);
    f = setOpen(f, "Workloads", true);
    expect(f).toEqual({ closed: [], opened: ["Custom resources", "Workloads"] });
    // A section that defaults open stays open when you open it, even if the default later becomes folded.
    expect(isOpen(f, "Workloads", () => false)).toBe(true);
  });

  it("folds and unfolds every section at once", () => {
    const all = allSections(["Workloads", "Network", "Custom resources"]);
    expect(all).toEqual(["Workspace", "Pinned", "Cloud", "Workloads", "Network", "Custom resources"]);
    const folded = setAll(setOpen(NO_FOLDS, "Network", true), all, false);
    expect(all.every((s) => !isOpen(folded, s))).toBe(true);
    expect(folded.opened).toEqual([]);
    const open = setAll(folded, all, true);
    expect(all.every((s) => isOpen(open, s))).toBe(true);
    expect(open.closed).toEqual([]);
  });

  it("round-trips through storage, and reads anything broken as no choices", () => {
    const f = setOpen(setOpen(NO_FOLDS, "Config", false), "Custom resources", true);
    expect(readNavFolds(writeNavFolds(f))).toEqual(f);
    for (const raw of [null, "", "  ", "{", "[]", "null", "42", '"x"', '{"closed":"Config"}', '{"closed":[1],"opened":[]}', '{"closed":[""],"opened":[]}', '{"opened":[]}'])
      expect(readNavFolds(raw)).toEqual(NO_FOLDS);
    // A section in both lists goes back to its default; duplicates and overlong names don't survive.
    expect(readNavFolds('{"closed":["Config","Config","Storage"],"opened":["Storage"]}')).toEqual({ closed: ["Config"], opened: [] });
    expect(readNavFolds(JSON.stringify({ closed: ["x".repeat(254)], opened: [] }))).toEqual(NO_FOLDS);
    expect(readNavFolds(JSON.stringify({ closed: Array.from({ length: 500 }, (_, i) => `g${i}`), opened: [] })).closed).toHaveLength(400);
  });
});

describe("a folded header's badge", () => {
  it("counts each problem about its rows' kinds once, failing before to-watch", () => {
    // A Deployment's crash loop marks Deployments and Pods (D57) but is one problem in Workloads.
    const ps = [problem("Deployment", "bad", 2), problem("Pod", "warn"), problem("Node", "bad")];
    expect(rollUp(ps, ["pods", "deployments", "statefulsets", "helm"])).toEqual({ tone: "bad", n: 1 });
    expect(rollUp([problem("Pod", "warn"), problem("Job", "warn")], ["pods", "jobs"])).toEqual({ tone: "warn", n: 2 });
    expect(rollUp(ps, ["nodes", "namespaces", "events"])).toEqual({ tone: "bad", n: 1 });
  });

  it("is nothing for a section whose rows carry no badges, or with no problems", () => {
    expect(rollUp([problem("Service", "bad")], ["services", "ingresses"])).toBeUndefined();
    expect(rollUp([], ["pods"])).toBeUndefined();
    expect(rollUp([problem("Pod", "bad")], [""])).toBeUndefined();
  });

  it("says it in words", () => {
    expect(badgeWords({ tone: "bad", n: 1 })).toBe("1 problem");
    expect(badgeWords({ tone: "bad", n: 3 })).toBe("3 problems");
    expect(badgeWords({ tone: "warn", n: 2 })).toBe("2 things to watch");
  });
});

describe("the page you are on", () => {
  const rows = [{ k: "pods", on: false }, { k: "deployments", on: true }, { k: "jobs", on: false }];
  it("stays visible under a folded header, alone", () => {
    expect(shownRows(rows, false, (r) => r.on).map((r) => r.k)).toEqual(["deployments"]);
    expect(shownRows(rows.map((r) => ({ ...r, on: false })), false, (r) => r.on)).toEqual([]);
  });
  it("is one of all the rows when the header is open", () => {
    expect(shownRows(rows, true, (r) => r.on).map((r) => r.k)).toEqual(["pods", "deployments", "jobs"]);
  });
});

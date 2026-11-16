// The Problems page's rules (wave 5, part 3; D58–D61): filters, chips, sections, which problems have logs, the drawer's
// held problem, ⌘K matching, and the `problems` first word.
import type { Problem } from "@landlens/contracts";
import { describe, expect, it } from "vitest";
import { parseQuery } from "../src/renderer/src/paletteRules";
import { badgeFor, classCounts, filterProblems, hasLogs, holdProblem, matchProblems, sections, subjectOf } from "../src/renderer/src/problemRules";


const P = (over: Partial<Problem> & Pick<Problem, "class" | "name">): Problem => ({
  id: `${over.class}|${over.name}`, tone: "bad", kind: "Deployment", namespace: "shop", group: "apps", version: "v1", resource: "deployments",
  reason: "R", title: `${over.name} is broken`, detail: "", pods: [], podCount: 0, facts: { events: [] }, hint: { cause: "c", next: [] },
  ...over,
});

// The doctor's order: bad first, then class.
const report: Problem[] = [
  P({ class: "probe", name: "cart-api", title: "cart-api's readiness probe is failing", podCount: 1, facts: { events: [], probe: { type: "readiness", how: "tcp :8081" } } }),
  P({ class: "crashloop", name: "ledger-worker", title: "ledger-worker is crash-looping", podCount: 5 }),
  P({ class: "crashloop", name: "orders-api", title: "orders-api is crash-looping", podCount: 1 }),
  P({ class: "image", name: "reports", title: "reports can't pull its image", podCount: 1 }),
  P({ class: "pending", name: "gpu-trainer", tone: "warn", title: "gpu-trainer can't be scheduled", podCount: 1, namespace: "ml" }),
  P({ class: "warning", name: "invoice-archive", tone: "warn", kind: "PersistentVolumeClaim", title: "invoice-archive: ProvisioningFailed" }),
  P({ class: "cert", name: "shop-tls", tone: "warn", kind: "Secret", title: "shop-tls expires in 3 days" }),
];

describe("the Problems page's rules", () => {
  it("filters by severity, class and words over title, kind, namespace and name, keeping the doctor's order", () => {
    expect(filterProblems(report, { severity: "all", text: "" })).toEqual(report);
    expect(filterProblems(report, { severity: "warn", text: "" }).map((p) => p.name)).toEqual(["gpu-trainer", "invoice-archive", "shop-tls"]);
    expect(filterProblems(report, { severity: "bad", cls: "crashloop", text: "" }).map((p) => p.name)).toEqual(["ledger-worker", "orders-api"]);
    expect(filterProblems(report, { severity: "all", text: "  CRASH  ledger " }).map((p) => p.name)).toEqual(["ledger-worker"]);
    expect(filterProblems(report, { severity: "all", text: "ml" }).map((p) => p.name)).toEqual(["gpu-trainer"]);
    expect(filterProblems(report, { severity: "all", text: "persistentvolumeclaim" }).map((p) => p.name)).toEqual(["invoice-archive"]);
    expect(filterProblems(report, { severity: "warn", cls: "crashloop", text: "" })).toEqual([]);
  });

  it("counts chips after the severity filter, in the doctor's order, leaving out empty classes", () => {
    expect(classCounts(report, "all")).toEqual([
      { cls: "probe", label: "Probes", n: 1 }, { cls: "crashloop", label: "Crash loops", n: 2 }, { cls: "image", label: "Images", n: 1 },
      { cls: "pending", label: "Pending", n: 1 }, { cls: "warning", label: "Warnings", n: 1 }, { cls: "cert", label: "Certificates", n: 1 },
    ]);
    expect(classCounts(report, "warn").map((c) => c.cls)).toEqual(["pending", "warning", "cert"]);
    expect(classCounts([], "all")).toEqual([]);
  });

  it("splits into Failing then To watch and drops an empty section", () => {
    expect(sections(report).map((s) => [s.label, s.items.length])).toEqual([["Failing", 4], ["To watch", 3]]);
    expect(sections(report.filter((p) => p.tone === "warn")).map((s) => s.label)).toEqual(["To watch"]);
    expect(sections([])).toEqual([]);
  });

  it("has logs only for a run that ended or was killed", () => {
    const has = (over: Partial<Problem>) => hasLogs(P({ class: "crashloop", name: "x", ...over }));
    expect(["crashloop", "oom", "start", "restarts"].every((c) => has({ class: c as Problem["class"] }))).toBe(true);
    expect(has({ class: "probe", facts: { events: [], probe: { type: "liveness", how: "exec" } } })).toBe(true);
    expect(has({ class: "probe", facts: { events: [], probe: { type: "readiness", how: "tcp :8081" } } })).toBe(false);
    expect(["image", "config", "pending", "notready", "unavailable", "node", "warning", "cert"].some((c) => has({ class: c as Problem["class"] }))).toBe(false);
  });

  it("holds the drawer's problem: updated while present, kept with the time it went, cleared when back", () => {
    const p = report[1]!;
    let held = holdProblem({ id: p.id, last: p }, report, 1000);
    expect(held).toEqual({ id: p.id, last: p });
    const newer = { ...p, podCount: 4 };
    held = holdProblem(held, [newer], 2000);
    expect(held).toEqual({ id: p.id, last: newer });
    held = holdProblem(held, [], 3000);
    expect(held).toEqual({ id: p.id, last: newer, goneAt: 3000 });
    // The first time it went is kept; a report still loading changes nothing.
    expect(holdProblem(held, [], 9000)!.goneAt).toBe(3000);
    expect(holdProblem(held, undefined, 9000)).toBe(held);
    expect(holdProblem(held, [p], 10_000)).toEqual({ id: p.id, last: p });
    expect(holdProblem(undefined, report, 1)).toBeUndefined();
  });

  it("names the subject", () => {
    expect(subjectOf(report[1]!)).toBe("Deployment shop/ledger-worker");
    expect(subjectOf({ kind: "Node", name: "orbstack" })).toBe("Node orbstack");
  });

  it("badges Pods for every problem with pods, not only Pod-kind ones", () => {
    expect(badgeFor(report, "Pod")).toEqual({ tone: "bad", n: 4 });
    expect(badgeFor(report, "Deployment")).toEqual({ tone: "bad", n: 4 });
    expect(badgeFor(report, "Secret")).toEqual({ tone: "warn", n: 1 });
    expect(badgeFor(report)).toEqual({ tone: "bad", n: 4 });
  });
});

describe("⌘K and problems (D61)", () => {
  it("reads a first word of problems as a search of problems only", () => {
    expect(parseQuery("problems cart")).toEqual({ text: "cart", commands: false, problems: true });
    expect(parseQuery("Problems")).toEqual({ text: "", commands: false, problems: true });
    expect(parseQuery("problemsx")).toEqual({ text: "problemsx", commands: false });
  });

  it("matches title and name, best first; with no text the worst few", () => {
    expect(matchProblems(report, "cart", 6).map((p) => p.name)).toEqual(["cart-api"]);
    expect(matchProblems(report, "crash", 6).map((p) => p.name)).toEqual(["ledger-worker", "orders-api"]);
    // A name that starts with it beats letters in order elsewhere; namespace/name counts as a start too.
    expect(matchProblems(report, "shop-t", 6)[0]!.name).toBe("shop-tls");
    expect(matchProblems(report, "shop/", 6).map((p) => p.name)).not.toContain("gpu-trainer");
    expect(matchProblems(report, "ml/gpu", 6).map((p) => p.name)).toEqual(["gpu-trainer"]);
    expect(matchProblems(report, "", 2).map((p) => p.name)).toEqual(["cart-api", "ledger-worker"]);
    expect(matchProblems(report, "zzz", 6)).toEqual([]);
  });
});

// Wave 9 part 3 (D188): Cloud Monitoring's alerts in the Problems page's third section.
import type { GcpAlert } from "@landlens/contracts";
import { alertInNamespaces, filterAlerts, holdAlert } from "../src/renderer/src/problemRules";

const A = (id: string, over: Partial<GcpAlert> = {}): GcpAlert => ({
  id, opened: "2026-11-16T11:18:00.000Z", policy: `Policy ${id}`, severity: "warning", resourceType: "k8s_pod", metric: "kubernetes.io/pod/x",
  subject: { kind: "Pod", namespace: "shop", name: `pod-${id}` }, ...over,
});

describe("Cloud Monitoring's alerts on the Problems page (D188)", () => {
  const pod = A("a");
  const other = A("b", { subject: { kind: "Pod", namespace: "landlens-dev", name: "web" } });
  const node = A("c", { resourceType: "k8s_node", subject: { kind: "Node", name: "gke-node-1" }, policy: "Node memory" });
  const all = [pod, other, node];

  it("All and Alerts show them; Failing, To watch, a doctor's class chip or In triage hide them", () => {
    const f = { text: "", namespaces: [] };
    expect(filterAlerts(all, { ...f, severity: "all" })).toEqual(all);
    expect(filterAlerts(all, { ...f, severity: "alerts" })).toEqual(all);
    expect(filterAlerts(all, { ...f, severity: "bad" })).toEqual([]);
    expect(filterAlerts(all, { ...f, severity: "warn" })).toEqual([]);
    expect(filterAlerts(all, { ...f, severity: "all", doctorOnly: true })).toEqual([]);
  });

  it("the namespace rule: a subject's namespace shows only when chosen; a node's or the cluster's only in all", () => {
    expect(filterAlerts(all, { severity: "all", text: "", namespaces: ["shop"] })).toEqual([pod]);
    expect(alertInNamespaces(node, [])).toBe(true);
    expect(alertInNamespaces(node, ["shop"])).toBe(false);
    const { subject: _, ...bare } = pod;
    expect(alertInNamespaces(bare, ["shop"])).toBe(false);
  });

  it("the toolbar's words match the policy, the subject and the metric", () => {
    expect(filterAlerts(all, { severity: "all", text: "memory", namespaces: [] })).toEqual([node]);
    expect(filterAlerts(all, { severity: "all", text: "landlens-dev web", namespaces: [] })).toEqual([other]);
    expect(filterAlerts(all, { severity: "all", text: "kubernetes.io/pod", namespaces: [] })).toEqual(all);
  });

  it("the doctor's counts never include alerts: the Alerts segment matches no problem", () => {
    const ps = [P({ class: "crashloop", name: "a" }), P({ class: "pending", name: "b", tone: "warn" })];
    expect(filterProblems(ps, { severity: "alerts", text: "" })).toEqual([]);
    expect(classCounts(ps, "alerts")).toEqual([]);
  });

  it("the drawer's alert is kept when it leaves the view, with when", () => {
    const held = holdAlert({ id: "a", last: pod }, [pod, other], 1);
    expect(held).toEqual({ id: "a", last: pod });
    const gone = holdAlert(held, [other], 5);
    expect(gone).toEqual({ id: "a", last: pod, goneAt: 5 });
    expect(holdAlert(gone, [other], 9)).toBe(gone);
    // Back again: open, no longer gone.
    expect(holdAlert(gone, [pod], 10)).toEqual({ id: "a", last: pod });
    // Not read (an error): kept as it is.
    expect(holdAlert(gone, undefined, 11)).toBe(gone);
  });
});

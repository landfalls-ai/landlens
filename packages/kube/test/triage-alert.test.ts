// What Landlens sends to Landflow about a problem or an object (wave 7 part 4, D120, D125): the Generic alert's shape,
// its id and dedup inputs, the description without log lines unless ticked, every part scrubbed, the caps.
import type { Problem } from "@landlens/contracts";
import { describe, expect, it } from "vitest";
import { alertFor, alertName, defaultSeverity, flowInput, TRIAGE } from "../src/triage-alert";

const crash = (over: Partial<Problem> = {}): Problem => ({
  id: "crashloop:landlens-dev/Deployment/ledger-worker", class: "crashloop", tone: "bad", kind: "Deployment", namespace: "landlens-dev", name: "ledger-worker",
  group: "apps", version: "v1", resource: "deployments", reason: "CrashLoopBackOff", title: "ledger-worker is crash-looping",
  detail: "container worker · exit 2 (Error) · 124 restarts · 5 pods", container: "worker", restarts: 124,
  pods: ["ledger-worker-1", "ledger-worker-2"], podCount: 5, since: "2026-11-15T08:00:00Z",
  facts: {
    lastState: { reason: "Error", exitCode: 2, message: "cannot parse LEDGER_SHARDS; token=supersecretvalue123" },
    image: "ghcr.io/landfalls/ledger:1.2",
    events: [{ at: "2026-11-15T09:00:00Z", reason: "BackOff", message: "Back-off restarting failed container", count: 40 }],
  },
  hint: { cause: "Landlens's own guess", next: ["Read the logs"] },
  ...over,
});

describe("the alert (D120)", () => {
  it("is Landflow's Generic shape, with the problem's names and a stable id", () => {
    const a = alertFor(crash(), "orbstack", { severity: "sev2" });
    expect(a).toMatchObject({
      source: "landlens", title: "ledger-worker is crash-looping", severity: "sev2", service: "ledger-worker", environment: "orbstack", status: "firing",
      id: "landlens:orbstack:landlens-dev/Deployment/ledger-worker:crashloop", fingerprint: "landlens:orbstack:landlens-dev/Deployment/ledger-worker:crashloop",
      labels: { cluster: "orbstack", namespace: "landlens-dev", kind: "Deployment", name: "ledger-worker", class: "crashloop", reason: "CrashLoopBackOff" },
      entity: { kind: "deployment", id: "landlens-dev/ledger-worker" },
    });
    expect(Object.keys(a).sort()).toEqual(["description", "entity", "environment", "fingerprint", "id", "labels", "service", "severity", "source", "status", "title"]);
    // None of Normalize Alert's other formats' markers (plugins/triage/src/lib/alert.ts MATCHERS): it is read as Generic.
    for (const k of ["alerts", "AlarmName", "Type", "data", "culprit", "rule", "alert", "alert_id", "alert_type", "alert_transition", "event_type"]) expect(a).not.toHaveProperty(k);
  });

  it("describes the problem by its facts and events, never Landlens's hint, and no log lines unless ticked", () => {
    const a = alertFor(crash(), "orbstack", { severity: "sev2" });
    expect(a.description.split("\n")[0]).toBe("container worker · exit 2 (Error) · 124 restarts · 5 pods");
    expect(a.description).toContain("Last run: Error, exit 2");
    expect(a.description).toContain("BackOff x40");
    expect(a.description).not.toContain("Landlens's own guess");
    expect(a.description).not.toContain("Last log lines");
  });

  it("scrubs what looks like a secret in the facts and in the log lines", () => {
    const a = alertFor(crash(), "orbstack", { severity: "sev3", logs: { container: "worker", pod: "ledger-worker-1", lines: ["starting", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123", "FATAL: cannot parse"] } });
    expect(a.description).not.toContain("supersecretvalue123");
    expect(a.description).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(a.description).toContain("<redacted auth header>");
    expect(a.description).toContain("Last log lines of worker in ledger-worker-1:\nstarting");
  });

  it("keeps the last 40 lines and the 4,000 cap, cutting the facts first", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const long = crash({ facts: { events: Array.from({ length: 8 }, (_, i) => ({ at: "x", reason: "R", message: "m".repeat(900) + i, count: 1 })) } });
    const a = alertFor(long, "orbstack", { severity: "sev2", logs: { container: "worker", pod: "p", lines } });
    expect(a.description.length).toBeLessThanOrEqual(TRIAGE.description);
    expect(a.description).toContain("line 99");
    expect(a.description).toContain("line 60");
    expect(a.description).not.toContain("line 59\n");
    expect(a.description).toContain("… (cut)");
  });

  it("holds names to one line of at most 100 characters", () => {
    expect(alertName("a\nb\u0000c‮d")).toBe("a b c d");
    expect(alertName("x".repeat(300))).toHaveLength(100);
    const a = alertFor(crash(), "arn:aws:eks:\nus-east-1", { severity: "sev1" });
    expect(a.environment).toBe("arn:aws:eks: us-east-1");
  });

  it("starts failing problems at sev2 and the ones to watch at sev3", () => {
    expect(defaultSeverity({ tone: "bad" })).toBe("sev2");
    expect(defaultSeverity({ tone: "warn" })).toBe("sev3");
  });
});

describe("a flow's input (D125)", () => {
  it("is names, the problem it came from, and the YAML only when given, cut at 32 KiB", () => {
    expect(flowInput({ cluster: "orbstack", namespace: "landlens-dev", kind: "Deployment", apiVersion: "apps/v1", name: "ledger-worker" })).toEqual({
      landlens: 1, cluster: "orbstack", namespace: "landlens-dev", kind: "Deployment", apiVersion: "apps/v1", name: "ledger-worker",
    });
    const i = flowInput({ cluster: "orbstack", kind: "Node", apiVersion: "v1", name: "n1", problem: crash(), yaml: "y".repeat(40_000) });
    expect(i.problem).toEqual({ class: "crashloop", reason: "CrashLoopBackOff", title: "ledger-worker is crash-looping" });
    expect(i.yaml!.length).toBeLessThan(33 * 1024);
    expect(i.yaml).toMatch(/cut at 32 KiB/);
  });
});

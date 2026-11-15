// What the doctor couldn't check (D56): one sentence per source, never silence over a skipped check.
import { describe, expect, it } from "vitest";
import { checkSentence, missingChecks } from "../src/checks";

describe("the check sentences", () => {
  it("says nothing for ok, off and readable pods, and one sentence for every other state", () => {
    expect(missingChecks({ pods: "ok", workloads: "ok", events: "ok", nodes: "off", certs: "ok" })).toEqual([]);
    expect(missingChecks(undefined)).toEqual([]);
    expect(checkSentence("pods", "forbidden")).toBeUndefined();
    for (const s of ["forbidden", "error", "partial", "pending", "skipped"] as const) expect(checkSentence("certs", s), s).toBeTruthy();
  });

  it("orders pods, workloads, events, nodes, certificates, and names what certificates need", () => {
    expect(missingChecks({ certs: "skipped", events: "forbidden", pods: "partial" })).toEqual([
      "Only part of the pods could be read (a limit was reached or some reads failed), so some problems may be missing.",
      "Can't read events here, so failing probes and warning events aren't checked; pods that are running but not ready are still listed.",
      "Certificates are read with the person's access only for what Landlens's window is showing (its namespace, or all of them), so they weren't checked here.",
    ]);
    expect(checkSentence("certs", "pending")).toBe("Still reading the TLS Secrets, so certificates aren't checked yet.");
    expect(checkSentence("nodes", "error")).toBe("Couldn't read the nodes just now, so they weren't checked this time.");
  });
});

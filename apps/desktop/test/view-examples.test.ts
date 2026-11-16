// The blank Views page's example chips (wave 10 part 4, D224): six fixed asks, each only when the cluster has what it
// needs, and no cluster's name in any of them.
import { describe, expect, it } from "vitest";
import { viewExamples } from "../src/renderer/src/viewExamples";

describe("viewExamples (D224)", () => {
  it("shows the three that need nothing, always", () => {
    expect(viewExamples({ metrics: false, gcpReads: false }).map((x) => x.id)).toEqual(["restarts", "images", "warnings"]);
  });

  it("adds usage with a metrics source, the doctor's count when it has problems, and Cloud SQL with Google Cloud reads on", () => {
    const all = viewExamples({ metrics: true, problems: 3, gcpReads: true });
    expect(all.map((x) => x.id)).toEqual(["restarts", "usage", "wrong", "images", "warnings", "sql"]);
    expect(all.find((x) => x.id === "wrong")!.label).toBe("Everything wrong right now, grouped by owner (3 problems)");
    // The chip fills the composer with the ask itself, not the count.
    expect(all.find((x) => x.id === "wrong")!.text).toBe("Everything wrong right now, grouped by owner");
    expect(viewExamples({ metrics: false, problems: 0, gcpReads: false }).some((x) => x.id === "wrong")).toBe(false);
    expect(viewExamples({ metrics: false, problems: 1, gcpReads: false }).find((x) => x.id === "wrong")!.label).toMatch(/\(1 problem\)$/);
  });

  it("names no cluster: the same words whatever the inputs", () => {
    const words = viewExamples({ metrics: true, problems: 2, gcpReads: true }).map((x) => x.text).join(" ");
    expect(words).not.toMatch(/orbstack|gke_|landlens-dev|namespace [a-z]/);
  });
});

// The ask card for a GitHub or Linear write (D84; M5 of the part 3 review): the table says what it cut, names a pull
// request's branches the right way round, lists every file, shows nested values, and "Show all arguments" holds every
// argument whole, with credentials cut.
import { describe, expect, it } from "vitest";
import { BODY_SHOWN, FILES_SHOWN, providerArgRows, providerArgsJson } from "../src/renderer/src/provider-args";

const row = (args: unknown, label: string) => providerArgRows(args).find((r) => r.label === label)?.value;

describe("the ask card's arguments", () => {
  it("says how much of a long body it cut", () => {
    const body = "b".repeat(BODY_SHOWN + 100);
    expect(row({ owner: "o", repo: "r", body }, "Body")).toBe(`${"b".repeat(BODY_SHOWN)}… (+100 more characters)`);
    expect(row({ body: "short" }, "Body")).toBe("short");
  });

  it("names a pull request's head as From and its base as Into, so a PR into main reads that way", () => {
    const rows = providerArgRows({ owner: "o", repo: "r", title: "t", head: "landlens/fix", base: "main" });
    expect(rows.find((r) => r.label === "From")?.value).toBe("landlens/fix");
    expect(rows.find((r) => r.label === "Into")?.value).toBe("main");
    expect(rows.some((r) => r.label === "Branch")).toBe(false);
    // A new branch: its name, and where it starts.
    expect(row({ branch: "landlens/x", from_branch: "main" }, "Branch")).toBe("landlens/x");
    expect(row({ branch: "landlens/x", from_branch: "main" }, "From")).toBe("main");
  });

  it("lists every file's path up to 20, and how many more", () => {
    const files = Array.from({ length: 6 }, (_, i) => ({ path: `src/f${i}.ts`, content: "x" }));
    expect(row({ files }, "Files")).toBe(`6: ${files.map((f) => f.path).join(", ")}`);
    const many = Array.from({ length: FILES_SHOWN + 5 }, (_, i) => ({ path: `p${i}`, content: "x" }));
    expect(row({ files: many }, "Files")).toMatch(/, and 5 more$/);
  });

  it("shows nested values as JSON, not an ellipsis, and every other argument, not the first six", () => {
    const extra = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i]));
    const rows = providerArgRows({ owner: "o", repo: "r", labels: ["automerge", "ship"], ...extra });
    expect(rows.find((r) => r.label === "labels")?.value).toBe('["automerge","ship"]');
    for (let i = 0; i < 9; i++) expect(rows.find((r) => r.label === `k${i}`)?.value, `k${i}`).toBe(String(i));
  });

  it("puts every argument, whole, under Show all arguments, with credentials cut", () => {
    const content = "c".repeat(5_000);
    const json = providerArgsJson({ owner: "o", repo: "r", files: [{ path: "a", content }], body: `token ghp_${"A".repeat(36)}` });
    expect(json).toContain(content);
    expect(json).not.toContain(`ghp_${"A".repeat(36)}`);
    expect(JSON.parse(json.replace(/<redacted[^>]*>/g, "x")).files[0].path).toBe("a");
  });
  it("names a Land family write's workflow, run, node, incident, view and panel, and shows its text as the body (wave 7)", () => {
    const rows = providerArgRows({ workflowId: "wf_1", executionId: "ex_2", nodeId: "n3", input: { a: 1 } });
    expect(rows.slice(0, 4)).toEqual([
      { label: "Workflow", value: "wf_1" }, { label: "Run", value: "ex_2" }, { label: "Node", value: "n3" }, { label: "Input", value: '{"a":1}' },
    ]);
    expect(row({ incident_id: "INC-9" }, "Incident")).toBe("INC-9");
    expect(row({ viewId: "v1", index: 2 }, "View")).toBe("v1");
    expect(row({ viewId: "v1", index: 2 }, "Panel")).toBe("2");
    const note = providerArgRows({ text: "a note for the room" });
    expect(note.at(-1)).toEqual({ label: "Body", value: "a note for the room", body: true });
  });
});

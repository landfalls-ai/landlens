// Markdown tables in the dock (wave 6): Claude answers with them, and they showed as lines of pipes.
import { describe, expect, it } from "vitest";
import { parseTable, splitRow } from "../src/renderer/src/mdTable";

const answer = [
  "| Instance | Location | State |",
  "|---|:---:|---:|",
  "| orders-db | us-central1 | RUNNABLE |",
  "| legacy-mysql | us-central1 | **SUSPENDED** |",
  "",
  "Three are running.",
];

describe("Markdown tables", () => {
  it("reads the header, the alignment and the rows, and stops at the first line without a pipe", () => {
    const t = parseTable(answer, 0)!;
    expect(t.head).toEqual(["Instance", "Location", "State"]);
    expect(t.align).toEqual([undefined, "center", "right"]);
    expect(t.rows).toEqual([["orders-db", "us-central1", "RUNNABLE"], ["legacy-mysql", "us-central1", "**SUSPENDED**"]]);
    expect(t.end).toBe(4);
  });

  it("needs a separator row as wide as the header", () => {
    expect(parseTable(["a | b", "just text"], 0)).toBeUndefined();
    expect(parseTable(["| a | b |", "|---|"], 0)).toBeUndefined();
    expect(parseTable(["| a | b |", "|--|--|"], 0)).toBeUndefined(); // three dashes at least
    expect(parseTable(["a | b", "--- | ---", "1 | 2"], 0)!.rows).toEqual([["1", "2"]]); // outer pipes are optional
  });

  it("keeps pipes inside code and escaped ones, and pads or cuts rows to the header", () => {
    expect(splitRow("| `a|b` | c \\| d |")).toEqual(["`a|b`", "c | d"]);
    const t = parseTable(["| a | b |", "| --- | --- |", "| 1 |", "| 1 | 2 | 3 |"], 0)!;
    expect(t.rows).toEqual([["1", ""], ["1", "2"]]);
  });

  it("doesn't run into a code fence", () => {
    expect(parseTable(["| a |", "| --- |", "| 1 |", "``` | x"], 0)!.end).toBe(3);
  });
});

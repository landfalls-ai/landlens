import { describe, expect, it } from "vitest";
import { canonical, Pairing } from "../src/pairing.js";

const setup = () => {
  const pairs: [string, string][] = [];
  let t = 0;
  const p = new Pairing((call, card) => pairs.push([call, card]), () => t);
  return { p, pairs, tick: (ms: number) => { t += ms; } };
};

describe("pairing dock cards with gateway calls", () => {
  it("pairs on Claude Code's tool_use id when it sends one", () => {
    const { p, pairs } = setup();
    p.card({ session: "s", toolCallId: "toolu_1", toolName: "mcp__landlens-kube__describe", rawInput: { name: "x" } });
    p.call({ id: "c1", session: "s", server: "landlens-kube", tool: "describe", args: { name: "y" }, toolUseId: "toolu_1" });
    expect(pairs).toEqual([["c1", "toolu_1"]]);
    // The card's later updates don't pair it again.
    p.card({ session: "s", toolCallId: "toolu_1", toolName: "mcp__landlens-kube__describe", rawInput: { name: "x" } });
    expect(pairs).toHaveLength(1);
  });

  it("falls back to session, tool name and input, whichever side comes first", () => {
    const { p, pairs } = setup();
    p.call({ id: "c1", session: "s", server: "landlens-kube", tool: "describe", args: { kind: "pod", name: "a" } });
    p.card({ session: "s", toolCallId: "t1", toolName: "mcp__landlens-kube__describe", rawInput: { name: "a", kind: "pod" } });
    p.card({ session: "s", toolCallId: "t2", title: "mcp__landlens-kube__describe", rawInput: { name: "b", kind: "pod" } });
    p.call({ id: "c2", session: "s", server: "landlens-kube", tool: "describe", args: { kind: "pod", name: "b" } });
    expect(pairs).toEqual([["c1", "t1"], ["c2", "t2"]]);
  });

  it("pairs the same tool and input oldest first, and never across sessions", () => {
    const { p, pairs, tick } = setup();
    p.card({ session: "other", toolCallId: "x", toolName: "mcp__fake__list", rawInput: {} });
    p.card({ session: "s", toolCallId: "t1", toolName: "mcp__fake__list", rawInput: {} });
    tick(5);
    p.card({ session: "s", toolCallId: "t2", toolName: "mcp__fake__list", rawInput: {} });
    p.call({ id: "c1", session: "s", server: "fake", tool: "list", args: {} });
    p.call({ id: "c2", session: "s", server: "fake", tool: "list", args: {} });
    expect(pairs).toEqual([["c1", "t1"], ["c2", "t2"]]);
  });

  it("takes the card's input when it arrives in a later update", () => {
    const { p, pairs } = setup();
    p.card({ session: "s", toolCallId: "t1", toolName: "mcp__fake__list" });
    p.card({ session: "s", toolCallId: "t2", toolName: "mcp__fake__list" });
    p.call({ id: "c1", session: "s", server: "fake", tool: "list", args: { q: 2 } });
    expect(pairs).toEqual([]); // two cards without input: no guessing
    p.card({ session: "s", toolCallId: "t2", rawInput: { q: 2 } });
    expect(pairs).toEqual([["c1", "t2"]]);
  });

  it("pairs a lone card whose input isn't known yet with the lone call, but not a card with other input", () => {
    const { p, pairs } = setup();
    p.card({ session: "s", toolCallId: "denied", toolName: "mcp__fake__delete", rawInput: { id: "1" } });
    p.call({ id: "c1", session: "s", server: "fake", tool: "delete", args: { id: "2" } });
    expect(pairs).toEqual([]);
    const b = setup();
    b.p.card({ session: "s", toolCallId: "t1", toolName: "mcp__fake__delete" });
    b.p.call({ id: "c1", session: "s", server: "fake", tool: "delete", args: { id: "2" } });
    expect(b.pairs).toEqual([["c1", "t1"]]);
  });

  it("ignores cards that aren't MCP tools and forgets what no one claims", () => {
    const { p, pairs, tick } = setup();
    p.card({ session: "s", toolCallId: "b1", toolName: "Bash", rawInput: {} });
    p.call({ id: "c1", session: "s", server: "fake", tool: "list", args: {} });
    tick(11 * 60_000);
    p.card({ session: "s", toolCallId: "t1", toolName: "mcp__fake__list", rawInput: {} });
    expect(pairs).toEqual([]);
  });

  it("orders keys canonically", () => {
    expect(canonical({ b: 1, a: [{ d: 2, c: 3 }], e: undefined })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });
});

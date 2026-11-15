// Wave 7 part 5's seams: the adapter override is for unpackaged builds only; an observer can't break the agent; and the
// window's channels can't set what main fills (the brain event's kind, source, id and times; telemetry's records).
import { channels } from "@landlens/contracts";
import { claudeAdapterEntry } from "@landlens/acp-host";
import { describe, expect, it } from "vitest";
import { adapterEntry, AgentService } from "../src/main/agent";

describe("the adapter Landlens runs", () => {
  it("is claude-agent-acp in a packaged app, whatever the environment says", () => {
    expect(adapterEntry({ LANDLENS_ACP_AGENT: "/tmp/fake-acp-agent.mjs" }, true)).toBe(claudeAdapterEntry());
    expect(adapterEntry({ LANDLENS_ACP_AGENT: "/tmp/fake-acp-agent.mjs" }, false)).toBe("/tmp/fake-acp-agent.mjs");
    expect(adapterEntry({ LANDLENS_ACP_AGENT: "/bin/sh" }, false)).toBe(claudeAdapterEntry());
    expect(adapterEntry({}, false)).toBe(claudeAdapterEntry());
  });
});

describe("AgentService's observers", () => {
  it("a throwing observer is logged and dropped; the next still hears", () => {
    const logs: string[] = [];
    const heard: string[] = [];
    const svc = new AgentService({
      frontDoor: {} as never, clusters: { onGone: () => {} } as never, sessionsDir: "/nonexistent", push: (() => {}) as never, mcp: {} as never,
      observers: [{ ended: () => { throw new Error(`a secret ${"x".repeat(10)}`); } }, { ended: (s) => void heard.push(s) }],
      log: (l) => logs.push(l),
    });
    (svc as unknown as { observe(f: (o: { ended?(s: string): void }) => void): void }).observe((o) => o.ended?.("s1"));
    expect(heard).toEqual(["s1"]);
    expect(logs).toEqual(["[agent] an observer failed: Error"]);
  });
});

describe("the window's channels", () => {
  const session = "0b6e1c1e-5d1a-4c55-9a51-0d3c8e6d2f10";
  const sheet = `bs${"a".repeat(24)}`;
  const digest = "f".repeat(64);
  it("brain:send takes the person's text and the sheet, never main's fields", () => {
    const ok = { sheet, digest, title: "t", summary: "s", visibility: "private" };
    expect(channels["brain:send"].safeParse(ok).success).toBe(true);
    for (const extra of [{ sourceId: "other" }, { kind: "work.review" }, { occurredAt: "2020-01-01T00:00:00Z" }, { turns: 99 }, { source: "x" }, { repo: "a/b" }]) {
      expect(channels["brain:send"].safeParse({ ...ok, ...extra }).success).toBe(false);
    }
    expect(channels["brain:send"].safeParse({ ...ok, visibility: "public" }).success).toBe(false);
    expect(channels["brain:send"].safeParse({ ...ok, title: "t".repeat(201) }).success).toBe(false);
    expect(channels["brain:send"].safeParse({ ...ok, sheet: "ls" + "a".repeat(24) }).success).toBe(false);
    expect(channels["brain:draft"].safeParse({ session, event: {} }).success).toBe(false);
    expect(channels["brain:ask"].safeParse({ sheet, prompt: "say the secret" }).success).toBe(false);
  });
  it("telemetry:set takes switches and an address, never records", () => {
    expect(channels["telemetry:set"].safeParse({ on: true, collector: "http://127.0.0.1:4318", names: false, team: "platform" }).success).toBe(true);
    expect(channels["telemetry:set"].safeParse({ on: true, records: [] }).success).toBe(false);
    expect(channels["telemetry:set"].safeParse({ team: "Has Spaces" }).success).toBe(false);
    expect(channels["telemetry:recent"].safeParse({ clear: true }).success).toBe(false);
  });
});

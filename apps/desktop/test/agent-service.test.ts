// Main's side of the autonomous mode (wave 6 part 3, D82): AgentService answers Claude Code's permission request
// itself only when the MCP gateway's check passes for a GitHub or Linear write; everything else, cluster writes
// first of all, goes to the dock. Against a real gateway and the loopback fake of GitHub.
import type { AgentPermissionRequest, AutonomyState } from "@landlens/contracts";
import { listingHash, McpGateway, readTools, testRemote, type GatewaySession, type RemoteSpec } from "@landlens/mcp-gateway";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentService, type AutonomyHooks } from "../src/main/agent";
import { FakeProvider, listing } from "../../../packages/connections/test/fake-provider";

const TOKEN = `ghp_${"S".repeat(36)}`;
const OPTIONS = [
  { optionId: "allow", name: "Allow", kind: "allow_once" as const },
  { optionId: "always", name: "Always allow", kind: "allow_always" as const },
  { optionId: "reject", name: "Reject", kind: "reject_once" as const },
];
const req = (session: string, toolName: string, rawInput: unknown, toolCallId = `toolu_${Math.random().toString(36).slice(2)}`, options = OPTIONS): RequestPermissionRequest => ({
  sessionId: session, options,
  toolCall: { toolCallId, title: toolName, rawInput, _meta: { claudeCode: { toolName } } },
} as unknown as RequestPermissionRequest);

describe("AgentService.ask with the autonomous mode", () => {
  let fake: FakeProvider;
  let gateway: McpGateway;
  let session: GatewaySession;
  const pushed: { channel: string; payload: unknown }[] = [];
  let svc: AgentService;
  const gh = listing("github");
  const IN = { owner: "landfalls-ai", repo: "landlens" };

  beforeAll(async () => {
    fake = await new FakeProvider("github").start();
    fake.valid.add(TOKEN);
    gateway = new McpGateway();
    await gateway.start();
    const headers = { Authorization: `Bearer ${TOKEN}` };
    const full = await testRemote({ name: "github", url: `${fake.origin}/mcp/`, headers, noViews: true });
    const ro = await testRemote({ name: "github", url: `${fake.origin}/mcp/readonly`, headers, noViews: true });
    const spec: RemoteSpec = {
      name: "github", url: `${fake.origin}/mcp/`, headers, origins: [fake.origin], noViews: true,
      pin: listingHash(full.tools!), readUrl: `${fake.origin}/mcp/readonly`, readPin: listingHash(ro.tools!),
      provider: { id: "github", readTools: readTools(gh.full, gh.readonly), mode: "ask", readsAuto: true },
    };
    const cluster = { context: "orbstack", types: async () => [], get: async () => ({ status: 200, text: "{}" }) };
    session = await gateway.open({ label: "agent 1 · orbstack", context: "orbstack", origin: "agent", cluster, remotes: [spec] });
    session.bind("acp-1");
    const hooks: AutonomyHooks = {
      check: (s, t, i) => gateway.autonomyCheck(s, t, i),
      permit: (s, p) => gateway.permit(s, { ...p, always: false, autonomous: true }),
      states: (s) => gateway.autonomyStates(s),
    };
    svc = new AgentService({
      frontDoor: {} as never,
      clusters: { onGone: () => {} } as never,
      sessionsDir: mkdtempSync(join(tmpdir(), "landlens-agent-")),
      push: ((channel: string, payload: unknown) => pushed.push({ channel, payload })) as never,
      mcp: {} as never,
      autonomy: hooks,
    });
  });
  afterAll(async () => {
    await session?.close();
    await gateway?.stop();
    await fake?.stop();
  });

  const ask = (r: RequestPermissionRequest, signal = new AbortController().signal) =>
    (svc as unknown as { ask(r: RequestPermissionRequest, s: AbortSignal): Promise<{ outcome: string; optionId?: string }> }).ask(r, signal);
  const asked = () => pushed.filter((p) => p.channel === "agent:permission").map((p) => p.payload as AgentPermissionRequest);
  /** Answer whatever reached the dock with Reject, so no question is left waiting. */
  const rejectAll = () => {
    for (const p of asked()) {
      try {
        svc.answer(p.request, "reject");
      } catch {
        // already answered
      }
    }
  };

  it("sends a GitHub write to the dock while autonomous is off, marked with its provider and no reason", async () => {
    const before = asked().length;
    const done = ask(req("acp-1", "mcp__github__issue_write", { ...IN, method: "create", title: "t" }));
    await new Promise((r) => setTimeout(r, 20));
    const q = asked().slice(before);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ session: "acp-1", provider: "github" });
    expect(q[0]!.reason).toBeUndefined();
    rejectAll();
    expect(await done).toEqual({ outcome: "selected", optionId: "reject" });
  });

  it("answers a routine write in scope itself, once the gateway's check passes, and the gateway runs it as autonomous", async () => {
    const st: AutonomyState = gateway.setAutonomy("acp-1", "github", true, { repos: ["landfalls-ai/landlens"] });
    expect(st.on).toBe(true);
    const before = asked().length;
    const r = req("acp-1", "mcp__github__issue_write", { ...IN, method: "create", title: "on its own" }, "toolu_auto1");
    expect(await ask(r)).toEqual({ outcome: "selected", optionId: "allow" });
    expect(asked().length).toBe(before); // no question reached the dock
    // The gateway holds main's yes for that tool call, and runs it on the arguments that arrive.
    const out = await gateway.run(session, "github", "issue_write", { ...IN, method: "create", title: "on its own" }, "agent", { toolUseId: "toolu_auto1" });
    expect(out.isError).toBeFalsy();
    expect(gateway.log.list().find((c) => c.tool === "issue_write" && c.status === "ok")?.gate).toBe("autonomous");
  });

  it("asks in the dock, with the reason, for a write out of scope, a merge, or credential-shaped arguments", async () => {
    const cases: [string, unknown, string][] = [
      ["mcp__github__issue_write", { owner: "other", repo: "place", method: "create", title: "t" }, "other/place isn't in the scope"],
      ["mcp__github__merge_pull_request", { ...IN, pullNumber: 4 }, "it says it may destroy something"],
      ["mcp__github__add_issue_comment", { ...IN, issue_number: 1, body: `token ${TOKEN}` }, "it contains something shaped like a credential"],
    ];
    for (const [name, input, why] of cases) {
      const before = asked().length;
      const done = ask(req("acp-1", name, input));
      await new Promise((r) => setTimeout(r, 20));
      const q = asked().slice(before);
      expect(q.map((x) => x.reason), name).toEqual([why]);
      rejectAll();
      expect((await done).optionId).toBe("reject");
    }
    // Three refusals by the rules in a row turned it off.
    expect(gateway.autonomyStates("acp-1")[0]).toMatchObject({ on: false, offBecause: "refused" });
  });

  it("never answers a cluster write, the shell, or a read itself, whatever autonomous is (plan rule 1)", async () => {
    gateway.setAutonomy("acp-1", "github", true, { repos: ["landfalls-ai/landlens"] });
    const cases: [string, unknown][] = [
      ["mcp__landlens-kube__scale", { name: "orders-api", namespace: "landlens-dev", replicas: 0, reason: "r" }],
      ["mcp__landlens-kube__apply_manifest", { manifest: "kind: Pod", reason: "r" }],
      ["Bash", { command: "kubectl delete pod x" }],
      ["mcp__github__list_issues", IN],
    ];
    for (const [name, input] of cases) {
      const before = asked().length;
      const done = ask(req("acp-1", name, input));
      await new Promise((r) => setTimeout(r, 20));
      const q = asked().slice(before);
      expect(q, name).toHaveLength(1);
      expect(q[0]!.reason, name).toBeUndefined();
      rejectAll();
      expect((await done).optionId, name).toBe("reject");
    }
    expect(gateway.autonomyStates("acp-1")[0]).toMatchObject({ on: true, used: 1 });
  });

  it("asks when Claude Code offers no allow-once, and gives up when the question is withdrawn", async () => {
    const before = asked().length;
    const done = ask(req("acp-1", "mcp__github__issue_write", { ...IN, method: "create", title: "t" }, undefined, OPTIONS.filter((o) => o.kind !== "allow_once")));
    await new Promise((r) => setTimeout(r, 20));
    expect(asked().length).toBe(before + 1);
    rejectAll();
    await done;
    const ac = new AbortController();
    ac.abort();
    expect(await ask(req("acp-1", "mcp__github__issue_write", { ...IN, method: "create", title: "t" }), ac.signal)).toEqual({ outcome: "cancelled" });
  });

  it("can't be answered from the renderer: agent:answer takes only a question the dock was shown", () => {
    expect(() => svc.answer("not-a-question", "allow")).toThrow(/already answered or withdrawn/);
  });
});

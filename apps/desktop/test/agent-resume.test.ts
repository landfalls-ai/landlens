// A resumed session's autonomy (review of wave 7 part 2, M1): the hold a sibling's read (or Google Cloud's) set lived in
// the gateway session that ended, while the transcript Claude Code resumes still holds what was read. So a resumed
// session always starts held: with the reason its history recorded, else a fixed one. Against a real gateway and the
// loopback fakes of Clickland and GitHub; Claude Code itself is replaced by a stand-in for startClusterSession.
import type { AutonomyState } from "@landlens/contracts";
import { familyHeld, FAMILY_READS, listingHash, McpGateway, readTools, testRemote, type GatewaySession, type RemoteSpec } from "@landlens/mcp-gateway";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CK_READ, FakeClickland } from "../../../packages/connections/test/fake-family";
import { FakeProvider, listing } from "../../../packages/connections/test/fake-provider";

const opened: { gateway?: McpGateway; remotes?: () => RemoteSpec[]; sessions: Map<string, GatewaySession> } = { sessions: new Map() };
let n = 0;

vi.mock("@landlens/acp-host", async (orig) => {
  const real = await orig<typeof import("@landlens/acp-host")>();
  return {
    ...real,
    // A stand-in for Claude Code: a gateway session bound to the ACP id (the resumed one keeps its id).
    startClusterSession: async (_deps: unknown, req: { handle: string; resume?: { sessionId: string; cwd: string } }) => {
      const id = req.resume?.sessionId ?? `acp-r${++n}`;
      const cluster = { context: "orbstack", types: async () => [], get: async () => ({ status: 200, text: "{}" }) };
      const g = await opened.gateway!.open({ label: `agent ${id} · orbstack`, context: "orbstack", origin: "agent", cluster, remotes: opened.remotes!() });
      g.bind(id);
      opened.sessions.set(id, g);
      return {
        id, label: g.label, handle: req.handle, context: "orbstack", cwd: req.resume?.cwd ?? join(tmpdir(), id), response: { sessionId: id },
        cluster, revoke: () => {}, close: () => g.close(),
      };
    },
  };
});

const { AgentService } = await import("../src/main/agent");
const { AgentHistory } = await import("../src/main/agent-history");
const { RESUMED_HELD } = await import("../src/main/agent");

describe("a resumed session's autonomy (M1)", () => {
  const TOKEN = `ghp_${"R".repeat(36)}`;
  let ck: FakeClickland;
  let gh: FakeProvider;
  let gateway: McpGateway;
  let svc: InstanceType<typeof AgentService>;
  let history: InstanceType<typeof AgentHistory>;
  const write = { owner: "landfalls-ai", repo: "landlens", method: "create", title: "after a resume" };

  beforeAll(async () => {
    ck = await new FakeClickland().start();
    gh = await new FakeProvider("github").start();
    gh.valid.add(TOKEN);
    const gl = listing("github");
    const headers = { Authorization: `Bearer ${TOKEN}` };
    const full = await testRemote({ name: "github", url: `${gh.origin}/mcp/`, headers, noViews: true });
    const ro = await testRemote({ name: "github", url: `${gh.origin}/mcp/readonly`, headers, noViews: true });
    const ckTools = (await testRemote({ name: "clickland", url: `${ck.origin}/api/mcp`, headers: { Authorization: `Bearer ${CK_READ}` } })).tools!;
    opened.remotes = () => [
      {
        name: "clickland", url: `${ck.origin}/api/mcp`, headers: { Authorization: `Bearer ${CK_READ}` }, origins: [ck.origin], pin: listingHash(ckTools),
        provider: { id: "clickland", readTools: new Set(FAMILY_READS.clickland), mode: "ask", readsAuto: true, views: true },
      },
      {
        name: "github", url: `${gh.origin}/mcp/`, headers, origins: [gh.origin], noViews: true, pin: listingHash(full.tools!), readUrl: `${gh.origin}/mcp/readonly`, readPin: listingHash(ro.tools!),
        provider: { id: "github", readTools: readTools(gl.full, gl.readonly), mode: "ask", readsAuto: true },
      },
    ];
    // As index.ts wires it: the gateway's autonomy pushes go through AgentService, which keeps a hold in the history.
    gateway = new McpGateway({ onAutonomy: (st: AutonomyState) => svc.autonomyChanged(st) });
    opened.gateway = gateway;
    await gateway.start();
    history = new AgentHistory(join(mkdtempSync(join(tmpdir(), "landlens-resume-")), "agent-history.json"));
    svc = new AgentService({
      frontDoor: {} as never,
      clusters: { onGone: () => {}, get: () => ({ info: { context: "orbstack", server: "https://127.0.0.1:6443" } }) } as never,
      sessionsDir: mkdtempSync(join(tmpdir(), "landlens-agent-")),
      push: (() => {}) as never,
      mcp: {} as never,
      history,
      autonomy: {
        check: (s, t, i) => gateway.autonomyCheck(s, t, i),
        permit: (s, p) => gateway.permit(s, { ...p, always: false, autonomous: true }),
        states: (s) => gateway.autonomyStates(s),
        hold: (s, why) => gateway.hold(s, why),
      },
    });
    (svc as unknown as { ensure: () => Promise<unknown> }).ensure = async () => ({});
  });
  afterAll(async () => {
    await gateway?.stop();
    await Promise.all([ck?.stop(), gh?.stop()]);
  });

  it("holds GitHub's autonomy in a resumed session that read from Clickland, with the recorded reason", async () => {
    const first = await svc.start("h");
    await gateway.run(opened.sessions.get(first.session)!, "clickland", "count", {}, "agent");
    expect(gateway.autonomyStates(first.session)[0]!.held).toBe(familyHeld("clickland"));
    await svc.close(first.session);
    const resumed = await svc.resume("h", first.session);
    expect(resumed.autonomy?.find((a) => a.provider === "github")?.held).toBe(familyHeld("clickland"));
    gateway.setAutonomy(first.session, "github", true, { repos: ["landfalls-ai/landlens"] });
    expect(await gateway.autonomyCheck(first.session, "mcp__github__issue_write", write)).toEqual({ ok: false, provider: "github", write: true, why: familyHeld("clickland") });
    await svc.close(first.session);
  });

  it("holds every resumed session, saying so, even one whose history recorded no hold", async () => {
    const first = await svc.start("h");
    expect(gateway.autonomyStates(first.session)[0]!.held).toBeUndefined();
    await svc.close(first.session);
    const resumed = await svc.resume("h", first.session);
    expect(resumed.autonomy?.find((a) => a.provider === "github")?.held).toBe(RESUMED_HELD);
    gateway.setAutonomy(first.session, "github", true, { repos: ["landfalls-ai/landlens"] });
    expect((await gateway.autonomyCheck(first.session, "mcp__github__issue_write", write)).why).toBe(RESUMED_HELD);
    // The page's history never carries the reason.
    expect(JSON.stringify(history.list())).not.toContain("resumed");
    await svc.close(first.session);
  });
});

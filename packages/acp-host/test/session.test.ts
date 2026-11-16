// startClusterSession's Google wiring (wave 9 part 4, D194; security review of part 4, T2): the session's kube tools pass
// a `google` to the metrics source at every call, NO_GOOGLE (no project) until the gateway has opened the session, and
// the gateway's own `google` from then on; cluster_overview's line comes from the same.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NO_GOOGLE, startClusterSession, type SessionGoogle, type SessionMcp } from "../src/session.js";

describe("startClusterSession's google (T2)", () => {
  it("is NO_GOOGLE before the gateway answers, then the gateway's, for every metrics call and the overview's line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "landlens-session-"));
    const seen: (SessionGoogle | undefined)[] = [];
    const series = { source: "none", reasons: [], step: 0, from: 0, to: 0, by: "container", cpu: { series: [] }, memory: { series: [] } } as never;
    const gateway: SessionGoogle = { projects: () => ["demo-shop"], hold: () => {}, line: () => "Cloud Monitoring has 1 open alert for this cluster" };
    const early: { line?: string | undefined; projects?: string[] } = {};
    const mcp: SessionMcp = {
      open: async ({ cluster }) => {
        // The kube tools exist before the gateway has answered: a call now reads with no project and gives no line.
        await cluster.metrics!({ scope: "cluster", range: "1h" });
        early.line = cluster.google?.();
        early.projects = seen.at(-1)?.projects();
        await new Promise((r) => setTimeout(r, 20));
        return { servers: [], allow: [], google: gateway, bind: () => {}, close: async () => {} };
      },
    };
    const s = await startClusterSession({
      host: { newSession: async () => ({ sessionId: "acp-t2" }), loadSession: async () => ({}), closeSession: async () => {} } as never,
      frontDoor: { url: "https://127.0.0.1:4443", certificate: "cert", clusterUrl: (h: string) => `https://127.0.0.1:4443/c/${h}`, issueToken: () => "tok", revokeToken: () => {} } as never,
      clusters: { get: () => ({ info: { context: "orbstack", server: "https://127.0.0.1:26443", version: "v1.33.0" } }), discovery: async () => [] } as never,
      mcp,
      metrics: async (_h, _r, _read, google) => (seen.push(google), series),
      sessionsDir: dir,
      home: dir,
      path: "/usr/bin",
    }, { handle: "hhhhhhhhhhhh" });
    try {
      expect(seen[0]).toBe(NO_GOOGLE);
      expect(early).toEqual({ line: undefined, projects: [] });
      await s.cluster.metrics!({ scope: "cluster", range: "1h" });
      expect(seen.at(-1)).toBe(gateway);
      expect(s.cluster.google!()).toBe("Cloud Monitoring has 1 open alert for this cluster");
      // A call's own copy (withCall, as every tool call gets) sees the same.
      await s.cluster.withCall!("call-1").metrics!({ scope: "cluster", range: "1h" });
      expect(seen.at(-1)).toBe(gateway);
    } finally {
      s.revoke();
    }
  });
});

// One agent session on one cluster: its own read-only front-door token, its own tool kubeconfig and working folder,
// its own MCP token, the fence, and the standing rules. Closing it revokes both tokens at once.
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NewSessionResponse } from "@agentclientprotocol/sdk";
import { agentReadOnlyPolicy, toolKubeconfig, type ClusterManager, type FrontDoor } from "@landlens/kube";
import { frontDoorCluster, MCP_SERVER_NAME, type AgentCluster, type McpHost } from "@landlens/kube-mcp";
import { sessionOptions } from "./fence.js";
import type { AcpHost } from "./host.js";
import { clusterSystemPrompt } from "./prompt.js";

export type ClusterSession = {
  id: string;
  /** "agent 3 · orbstack": how the audit trail names this session. */
  label: string;
  handle: string;
  context: string;
  namespaces?: string[];
  cwd: string;
  response: NewSessionResponse;
  /** The cluster as this session sees it: through the front door with its own token (policy, scrubbing, audit). */
  cluster: AgentCluster;
  /** Revoke both tokens and remove the folder, without asking Claude Code (for when it has gone). */
  revoke(): void;
  /** revoke(), and end the session in Claude Code. */
  close(): Promise<void>;
};

let counter = 0;

export async function startClusterSession(deps: {
  host: AcpHost;
  frontDoor: FrontDoor;
  clusters: ClusterManager;
  mcp: McpHost;
  /** Parent folder for session working folders. */
  sessionsDir: string;
  home: string;
  path: string;
  /** Your kubeconfig files ($KUBECONFIG), so the fence can deny them wherever they are. */
  userKubeconfigs?: string[];
}, req: { handle: string; namespaces?: string[] }): Promise<ClusterSession> {
  const c = deps.clusters.get(req.handle);
  const types = await deps.clusters.discovery(req.handle); // also gives the front door the kinds' scope
  const label = `agent ${++counter} · ${c.info.context}`;
  const cwd = join(deps.sessionsDir, `${Date.now()}-${randomBytes(4).toString("hex")}`);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });

  const token = deps.frontDoor.issueToken({ label, policy: agentReadOnlyPolicy(req.namespaces), clusters: [req.handle] });
  const kubeconfig = join(cwd, "kubeconfig");
  writeFileSync(kubeconfig, toolKubeconfig(
    { url: deps.frontDoor.url, certificate: deps.frontDoor.certificate },
    [{ handle: req.handle, context: c.info.context, ...(req.namespaces?.[0] ? { namespace: req.namespaces[0] } : {}) }],
  ), { mode: 0o400 }); // read-only: kubectl only reads it, and the sandbox denies writing it too
  const cluster = frontDoorCluster({
    url: deps.frontDoor.clusterUrl(req.handle),
    certificate: deps.frontDoor.certificate,
    token,
    context: c.info.context,
    types: async () => types,
    ...(req.namespaces?.length ? { namespaces: req.namespaces } : {}),
  });
  const mcpToken = deps.mcp.addSession(cluster, label);
  const revoke = () => {
    deps.frontDoor.revokeToken(token);
    deps.mcp.removeSession(mcpToken);
    rmSync(cwd, { recursive: true, force: true });
  };

  let response: NewSessionResponse;
  try {
    response = await deps.host.newSession({
      cwd,
      mcpServers: [{ type: "http", name: MCP_SERVER_NAME, url: deps.mcp.url, headers: [{ name: "Authorization", value: `Bearer ${mcpToken}` }] }],
      systemPrompt: {
        mode: "append",
        content: [{ type: "text", text: clusterSystemPrompt({ context: c.info.context, server: c.info.server, version: c.info.version, ...(req.namespaces ? { namespaces: req.namespaces } : {}) }) }],
      },
      _meta: { claudeCode: { options: sessionOptions({ home: deps.home, cwd, kubeconfig, token, path: deps.path, frontDoorPort: Number(new URL(deps.frontDoor.url).port), ...(deps.userKubeconfigs ? { userKubeconfigs: deps.userKubeconfigs } : {}) }) } },
    } as Parameters<AcpHost["newSession"]>[0]);
  } catch (err) {
    revoke();
    throw err;
  }

  const close = async () => {
    revoke();
    await deps.host.closeSession(response.sessionId).catch(() => {});
  };
  // The cluster may have gone while Claude Code was starting the session; its onGone ran before we were listed.
  try {
    deps.clusters.get(req.handle);
  } catch (err) {
    await close();
    throw err;
  }

  return {
    id: response.sessionId,
    label,
    handle: req.handle,
    context: c.info.context,
    ...(req.namespaces ? { namespaces: req.namespaces } : {}),
    cwd,
    response,
    cluster,
    revoke,
    close,
  };
}

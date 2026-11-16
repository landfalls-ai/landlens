// One agent session on one cluster: its own read-only front-door token, its own tool kubeconfig and working folder,
// its own session on the MCP gateway (Landlens's cluster tools and the remote servers turned on for the cluster),
// the fence, and the standing rules. Closing it revokes both at once.
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { NewSessionResponse } from "@agentclientprotocol/sdk";
import { agentApprovedPolicy, agentReadOnlyPolicy, type CertInput, ChangeBroker, toolKubeconfig, type ChangeDecision, type ClusterManager, type FrontDoor } from "@landlens/kube";
import type { AgentChange, DoctorCheckState, MetricsSeries } from "@landlens/contracts";
import { frontDoorCluster, frontDoorSend, type AgentCluster } from "@landlens/kube-mcp";
import { sessionOptions } from "./fence.js";
import type { AcpHost } from "./host.js";
import { clusterSystemPrompt } from "./prompt.js";
import { buildSkillsPlugin, type SkillInfo } from "./skills.js";

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

/**
 * Google Cloud for the session's own kube tools (wave 9 part 4, D194): the projects the session may read (its grant as
 * it began; none without it), `hold` (its GitHub and Linear autonomy asks from then on, before Cloud Monitoring is
 * asked), and cluster_overview's line from what main holds.
 */
export type SessionGoogle = { projects: string[]; hold(): void; line?(): string | undefined };
/** Before the gateway has answered: no project, nothing to hold. A session's metrics call never goes without one. */
export const NO_GOOGLE: SessionGoogle = Object.freeze({ projects: [], hold: () => {} });

/** The MCP gateway as a session sees it (the desktop's McpGateway, through its store of servers). */
export interface SessionMcp {
  open(s: { label: string; context: string; handle: string; cluster: AgentCluster }): Promise<{
    /** Every MCP server the session gets: all on the gateway, each with the session's token. */
    servers: { name: string; url: string; headers: { name: string; value: string }[] }[];
    /** Tools that run without asking (`mcp__landlens-kube`, and proxied tools that only read). */
    allow: string[];
    /** The connections served to the session ("GitHub", "Linear"), for the standing rules. */
    providers?: string[];
    /** Those of them (and of `family`) whose reads run without asking in this session (the standing rules say so only for these). */
    readsFree?: string[];
    /** The Land family's servers in the session ("Clickland", "Landflow", "Landfall"; wave 7 D114), for the standing rules. */
    family?: string[];
    /** The Google Cloud projects landlens-gcp reads in this session, when it has them (wave 6, D93). */
    gcp?: string[];
    /** What the session's kube tools may use of Google Cloud (D194); without it, nothing. */
    google?: SessionGoogle;
    /** Tell the gateway Claude Code's id for the session, so the call log and the dock agree. */
    bind(sessionId: string): void;
    close(): Promise<void>;
  }>;
}

let counter = 0;

export async function startClusterSession(deps: {
  host: AcpHost;
  frontDoor: FrontDoor;
  clusters: ClusterManager;
  mcp: SessionMcp;
  /**
   * CPU and memory for the cluster, from Landlens's metrics source, for the metrics tool. `read` goes through the
   * front door with the session's token, for what the series reads from the cluster itself.
   */
  metrics?: (handle: string, req: Parameters<NonNullable<AgentCluster["metrics"]>>[0], read?: (path: string) => Promise<any>, google?: SessionGoogle) => Promise<MetricsSeries>;
  /** The person's certificate facts for cluster_overview (main's DoctorService.certsFor). */
  certs?: (handle: string, namespaces?: string[]) => { state: DoctorCheckState; certs?: CertInput[] };
  /** Parent folder for session working folders. */
  sessionsDir: string;
  home: string;
  path: string;
  /** Your kubeconfig files ($KUBECONFIG), so the fence can deny them wherever they are. */
  userKubeconfigs?: string[];
  /**
   * Where the agent's proposed changes go for your decision. Without it the session has no write tools: it only
   * reads.
   */
  changes?: {
    ask(change: AgentChange, signal: AbortSignal): Promise<ChangeDecision>;
    update(change: AgentChange): void;
  };
  /** Your skills chosen for agent sessions (skills.ts). */
  skills?: SkillInfo[];
  log?: (l: string) => void;
}, req: {
  handle: string;
  namespaces?: string[];
  /** Resume an earlier session: Claude Code replays its history; it gets new tokens and the same folder path. */
  resume?: { sessionId: string; cwd: string };
}): Promise<ClusterSession> {
  const c = deps.clusters.get(req.handle);
  const types = await deps.clusters.discovery(req.handle); // also gives the front door the kinds' scope
  const label = `agent ${++counter} · ${c.info.context}`;
  const cwd = req.resume ? resumeDir(deps.sessionsDir, req.resume.cwd) : join(deps.sessionsDir, `${Date.now()}-${randomBytes(4).toString("hex")}`);
  // A resumed session starts from an empty folder (Claude Code keeps the transcript elsewhere): nothing the agent left
  // in it after a crash is loaded again. The folder holds no token, so it is made before any is issued.
  if (req.resume) rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const kubeconfig = join(cwd, "kubeconfig");
  let skillsPlugin: string | undefined;
  try {
    skillsPlugin = deps.skills?.length ? buildSkillsPlugin(cwd, deps.skills, deps.log) : undefined;
    writeFileSync(kubeconfig, toolKubeconfig(
      { url: deps.frontDoor.url, certificate: deps.frontDoor.certificate },
      [{ handle: req.handle, context: c.info.context, ...(req.namespaces?.[0] ? { namespace: req.namespaces[0] } : {}) }],
    ), { mode: 0o400 }); // read-only: kubectl only reads it, and the sandbox denies writing it too
  } catch (err) {
    rmSync(cwd, { recursive: true, force: true });
    throw err;
  }

  const token = deps.frontDoor.issueToken({ label, policy: agentReadOnlyPolicy(req.namespaces), clusters: [req.handle] });
  // The approval broker's own token: never handed to Claude Code; it sends dry runs and the changes you approve.
  const approved = deps.changes ? deps.frontDoor.issueToken({ label: `${label} · approved`, policy: agentApprovedPolicy(req.namespaces), clusters: [req.handle] }) : undefined;
  let sessionId = "";
  let broker: ChangeBroker | undefined;
  const changes = deps.changes;
  const propose: AgentCluster["propose"] = approved && changes
    ? (change, signal) => {
        broker ??= new ChangeBroker({
          session: sessionId,
          send: frontDoorSend({ url: deps.frontDoor.clusterUrl(req.handle), certificate: deps.frontDoor.certificate, token: approved }),
          ...(req.namespaces?.length ? { namespaces: req.namespaces } : {}),
          ask: (c, s) => changes.ask(c, s),
          update: (c) => changes.update(c),
        });
        return broker.propose(change, signal);
      }
    : undefined;
  const revokeTokens = () => {
    deps.frontDoor.revokeToken(token);
    if (approved) deps.frontDoor.revokeToken(approved);
  };
  // What the gateway says the session may use of Google Cloud, once it has opened the session (D194): a call before
  // that (there is none: Claude Code connects after) reads with no project.
  let google: SessionGoogle = NO_GOOGLE;
  const cluster = frontDoorCluster({
    url: deps.frontDoor.clusterUrl(req.handle),
    certificate: deps.frontDoor.certificate,
    token,
    context: c.info.context,
    types: async () => types,
    ...(req.namespaces?.length ? { namespaces: req.namespaces } : {}),
    ...(deps.metrics ? { metrics: (r, read) => deps.metrics!(req.handle, r, read, google) } : {}),
    google: () => google.line?.(),
    ...(deps.certs ? { certs: async (ns) => deps.certs!(req.handle, ns) } : {}),
    ...(propose ? { propose } : {}),
  });
  let mcp: Awaited<ReturnType<SessionMcp["open"]>>;
  try {
    mcp = await deps.mcp.open({ label, context: c.info.context, handle: req.handle, cluster });
    if (mcp.google) google = mcp.google;
  } catch (err) {
    revokeTokens();
    rmSync(cwd, { recursive: true, force: true });
    throw err;
  }
  const revoke = () => {
    revokeTokens();
    void mcp.close();
    rmSync(cwd, { recursive: true, force: true });
  };

  let response: NewSessionResponse;
  const params = {
    cwd,
    mcpServers: mcp.servers.map((m) => ({ type: "http" as const, ...m })),
    systemPrompt: {
      mode: "append",
      content: [{ type: "text", text: clusterSystemPrompt({ context: c.info.context, server: c.info.server, version: c.info.version, ...(req.namespaces ? { namespaces: req.namespaces } : {}), writes: !!deps.changes, ...(mcp.providers?.length || mcp.family?.length ? { providers: mcp.providers ?? [], readsFree: mcp.readsFree ?? [] } : {}), ...(mcp.family?.length ? { family: mcp.family } : {}), ...(mcp.gcp?.length ? { gcp: mcp.gcp } : {}) }) }],
    },
    _meta: { claudeCode: { options: sessionOptions({
      home: deps.home, cwd, kubeconfig, token, path: deps.path, frontDoorPort: Number(new URL(deps.frontDoor.url).port), mcpAllow: mcp.allow,
      ...(deps.userKubeconfigs ? { userKubeconfigs: deps.userKubeconfigs } : {}),
      ...(skillsPlugin ? { skillsPlugin } : {}),
    }) } },
  };
  try {
    if (req.resume) {
      // The same fence as a new session: the adapter builds the resumed session from these options too.
      sessionId = req.resume.sessionId;
      mcp.bind(sessionId);
      const loaded = await deps.host.loadSession({ ...params, sessionId } as Parameters<AcpHost["loadSession"]>[0]);
      response = { ...loaded, sessionId } as NewSessionResponse;
    } else {
      response = await deps.host.newSession(params as Parameters<AcpHost["newSession"]>[0]);
    }
  } catch (err) {
    revoke();
    throw err;
  }
  mcp.bind(response.sessionId);
  sessionId = response.sessionId;

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

/** A resumed session's folder must be one Landlens made: directly in the sessions folder, named as it names them. */
function resumeDir(sessionsDir: string, cwd: string): string {
  const dir = resolve(cwd);
  if (dirname(dir) !== resolve(sessionsDir) || !/^\d{10,16}-[0-9a-f]{8}$/.test(basename(dir))) {
    throw Object.assign(new Error("that session's folder isn't one of Landlens's"), { status: 400 });
  }
  return dir;
}

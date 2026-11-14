// The agent in Electron main: one Claude Code process (through claude-agent-acp) for the window, one MCP server for
// its cluster tools, and a session per cluster. Updates and permission requests go to the dock; answers come back.
import { randomBytes } from "node:crypto";
import type { AgentPermissionRequest, AgentSessionInfo, AgentStatus, AgentUpdate, ResourceRef } from "@landlens/contracts";
import { AcpHost, agentEnv, claudeAdapterEntry, loginPath, objectUri, resourceBlock, startClusterSession, which, type ClusterSession } from "@landlens/acp-host";
import { apiPath, type ClusterManager, type FrontDoor } from "@landlens/kube";
import { getJson, McpHost, redactObject, redactText } from "@landlens/kube-mcp";
import type { ContentBlock, NewSessionResponse, RequestPermissionOutcome, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { mkdirSync } from "node:fs";
import { delimiter } from "node:path";
import { homedir } from "node:os";
import { stringify } from "yaml";

type Push = {
  (channel: "agent:update", payload: AgentUpdate): void;
  (channel: "agent:permission", payload: AgentPermissionRequest): void;
  (channel: "agent:status", payload: AgentStatus): void;
};

const AGENT_TITLE = "Claude Code";
/** The modes the dock offers: Manual and Plan. Never acceptEdits, auto or bypass. */
const MODES = new Set(["default", "plan"]);

export class AgentService {
  private host: AcpHost | undefined;
  private mcp: McpHost | undefined;
  private starting: Promise<AcpHost> | undefined;
  private path = "";
  private readonly sessions = new Map<string, ClusterSession>();
  private readonly pending = new Map<string, { session: string; options: Set<string>; resolve: (o: RequestPermissionOutcome) => void }>();

  constructor(
    private readonly deps: { frontDoor: FrontDoor; clusters: ClusterManager; sessionsDir: string; push: Push; log?: (l: string) => void },
  ) {
    // A cluster that goes away takes its agent sessions with it.
    deps.clusters.onGone((handle) => {
      for (const s of this.sessions.values()) if (s.handle === handle) void this.close(s.id);
    });
  }

  private ensure(): Promise<AcpHost> {
    if (this.host?.running) return Promise.resolve(this.host);
    this.starting ??= (async () => {
      this.deps.push("agent:status", { state: "starting" });
      mkdirSync(this.deps.sessionsDir, { recursive: true, mode: 0o700 });
      this.path = await loginPath();
      const node = which("node", this.path);
      if (!node) throw Object.assign(new Error("Landlens needs Node.js to run Claude Code; none was found on your login shell's PATH."), { status: 424 });
      if (!this.mcp) {
        this.mcp = new McpHost((e) => this.deps.log?.(`[mcp] ${e.label} ${e.tool ?? ""} ${e.status}`));
        await this.mcp.start();
      }
      const host = new AcpHost(
        { title: AGENT_TITLE, command: node, args: [claudeAdapterEntry()], env: { CLAUDE_AGENT_ACP_PROTOCOL: "v1" } },
        {
          cwd: this.deps.sessionsDir,
          env: agentEnv(process.env, { PATH: this.path }),
          events: {
            update: (n) => this.deps.push("agent:update", { session: n.sessionId, update: n.update as AgentUpdate["update"] }),
            permission: (req, signal) => this.ask(req, signal),
            exit: ({ code, stderr }) => {
              // Claude Code has gone: its sessions' tokens must not outlive it.
              for (const s of this.sessions.values()) s.revoke();
              this.sessions.clear();
              for (const [id, p] of this.pending) {
                p.resolve({ outcome: "cancelled" });
                this.pending.delete(id);
              }
              this.deps.push("agent:status", { state: "stopped", message: `${AGENT_TITLE} exited (${code ?? "signal"})${stderr ? `: ${stderr}` : ""}` });
            },
            log: (l) => this.deps.log?.(`[agent] ${l}`),
          },
        },
      );
      await host.start();
      this.host = host;
      this.deps.push("agent:status", { state: "ready" });
      return host;
    })().finally(() => (this.starting = undefined));
    return this.starting;
  }

  async start(handle: string, namespaces?: string[]): Promise<AgentSessionInfo> {
    const host = await this.ensure();
    const s = await startClusterSession({
      host, frontDoor: this.deps.frontDoor, clusters: this.deps.clusters, mcp: this.mcp!,
      sessionsDir: this.deps.sessionsDir, home: homedir(), path: this.path,
      userKubeconfigs: process.env.KUBECONFIG?.split(delimiter).filter(Boolean) ?? [],
    }, { handle, ...(namespaces?.length ? { namespaces } : {}) });
    this.sessions.set(s.id, s);
    return info(s, s.response);
  }

  private session(id: string): ClusterSession {
    const s = this.sessions.get(id);
    if (!s) throw Object.assign(new Error("this agent session has ended"), { status: 404 });
    return s;
  }

  async prompt(id: string, text: string, context: ResourceRef[] = []): Promise<{ stopReason: string }> {
    const s = this.session(id);
    const blocks: ContentBlock[] = [{ type: "text", text }];
    const embedded = !!this.host?.init?.agentCapabilities?.promptCapabilities?.embeddedContext;
    for (const ref of context) {
      const { uri, body } = await this.describe(s, ref);
      blocks.push(embedded ? resourceBlock(uri, body) : { type: "text", text: `${uri}\n${body}` });
    }
    const res = await this.host!.prompt(id, blocks);
    return { stopReason: res.stopReason };
  }

  /**
   * What "Ask about this" attaches: the object and its recent events, read with the session's own token, so the
   * session's namespace limit and Secrets refusal apply and the front door scrubs it, as for the agent's own reads.
   */
  private async describe(s: ClusterSession, ref: ResourceRef): Promise<{ uri: string; body: string }> {
    const type = await this.deps.clusters.typeOf(s.handle, ref);
    const o = await getJson(s.cluster, apiPath(type, ref.namespace, ref.name));
    const q = new URLSearchParams({ fieldSelector: `involvedObject.uid=${String(o.metadata?.uid ?? "")}`, limit: "200" });
    const eventsPath = ref.namespace ? `${apiPath({ group: "", version: "v1", resource: "events" }, ref.namespace)}?${q}` : `/api/v1/events?${q}`;
    const events: any[] = await getJson(s.cluster, eventsPath).then((l) => l.items ?? [], () => []);
    const recent = events
      .sort((a: any, b: any) => Date.parse(b.lastTimestamp ?? b.eventTime ?? 0) - Date.parse(a.lastTimestamp ?? a.eventTime ?? 0))
      .slice(0, 15)
      .map((e: any) => redactText(`# ${e.type} ${e.reason} (x${e.count ?? 1}): ${String(e.message ?? "").replace(/\s+/g, " ")}`));
    const body = stringify(redactObject(o), { lineWidth: 0 }) + (recent.length ? `\n# Recent events\n${recent.join("\n")}\n` : "");
    return { uri: objectUri(s.context, type.kind, ref.name, ref.namespace), body };
  }

  async cancel(id: string) {
    this.session(id);
    this.withdrawAsks(id);
    await this.host?.cancel(id);
  }

  /** Answer every open question of a session with "cancelled". */
  private withdrawAsks(id: string) {
    for (const [rid, p] of this.pending) {
      if (p.session === id) {
        p.resolve({ outcome: "cancelled" });
        this.pending.delete(rid);
        this.deps.push("agent:status", { state: "answered", request: rid });
      }
    }
  }

  async setMode(id: string, mode: string) {
    const s = this.session(id);
    const offered = s.response.modes?.availableModes.some((m) => m.id === mode);
    if (!MODES.has(mode) || !offered) throw Object.assign(new Error(`Landlens offers only Manual and Plan, not ${JSON.stringify(mode)}`), { status: 400 });
    await this.host!.setMode(id, mode);
  }

  async setConfig(id: string, config: string, value: string) {
    const s = this.session(id);
    const option = info(s, s.response).options.find((o) => o.id === config);
    if (!option || !option.choices.some((c) => c.id === value)) {
      throw Object.assign(new Error(`${JSON.stringify(config)} can't be set to ${JSON.stringify(value)}`), { status: 400 });
    }
    await this.host!.setConfigOption(id, config, value);
  }

  answer(request: string, option: string | null) {
    const p = this.pending.get(request);
    if (!p) throw Object.assign(new Error("that question was already answered or withdrawn"), { status: 404 });
    if (option !== null && !p.options.has(option)) throw Object.assign(new Error("that isn't one of the choices offered"), { status: 400 });
    this.pending.delete(request);
    p.resolve(option ? { outcome: "selected", optionId: option } : { outcome: "cancelled" });
    this.deps.push("agent:status", { state: "answered", request });
  }

  async close(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    this.withdrawAsks(id);
    await s.close();
  }

  /** End every session: the window reloaded or went away, so no dock is left to show them. */
  async closeAll() {
    for (const id of [...this.sessions.keys()]) await this.close(id);
  }

  async stop() {
    await this.closeAll();
    await this.host?.stop();
    await this.mcp?.stop();
  }

  private ask(req: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionOutcome> {
    const request = randomBytes(9).toString("base64url");
    return new Promise((resolve) => {
      this.pending.set(request, { session: req.sessionId, options: new Set(req.options.map((o) => o.optionId)), resolve });
      signal.addEventListener("abort", () => {
        if (this.pending.delete(request)) {
          resolve({ outcome: "cancelled" });
          this.deps.push("agent:status", { state: "answered", request });
        }
      }, { once: true });
      const tc = req.toolCall;
      this.deps.push("agent:permission", {
        request,
        session: req.sessionId,
        toolCall: { toolCallId: tc.toolCallId, title: tc.title ?? null, kind: tc.kind ?? null, rawInput: tc.rawInput },
        options: req.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
      });
    });
  }
}

function info(s: ClusterSession, r: NewSessionResponse): AgentSessionInfo {
  const options = (r.configOptions ?? []).flatMap((o: any) =>
    o.type === "select" && Array.isArray(o.options) && o.id !== "mode"
      ? [{
          id: String(o.id), name: String(o.name ?? o.id), current: String(o.currentValue ?? ""),
          choices: o.options.flatMap((c: any) => ("value" in c ? [{ id: String(c.value), name: String(c.name ?? c.value), description: c.description ?? null }] : [])),
        }]
      : []);
  return {
    session: s.id,
    label: s.label,
    agent: AGENT_TITLE,
    context: s.context,
    ...(s.namespaces ? { namespaces: s.namespaces } : {}),
    ...(r.modes
      ? { mode: { current: r.modes.currentModeId, available: r.modes.availableModes.map((m) => ({ id: m.id, name: m.name, description: m.description ?? null })) } }
      : {}),
    options,
  };
}

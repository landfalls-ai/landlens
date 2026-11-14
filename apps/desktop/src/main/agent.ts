// The agent in Electron main: one Claude Code process (through claude-agent-acp) for the window, and a session per
// cluster, each with its own session on the MCP gateway (main/mcp.ts). Updates and permission requests go to the dock;
// answers come back. Tool calls in the updates are handed to the gateway too, to pair dock cards with logged calls.
import { randomBytes } from "node:crypto";
import type { AgentChange, AgentHistoryEntry, AgentPermissionRequest, AgentSessionInfo, AgentSettingsInfo, AgentStatus, AgentUpdate, ResourceRef } from "@landlens/contracts";
import { AcpHost, agentEnv, claudeAdapterEntry, listSkills, loginPath, objectUri, resourceBlock, startClusterSession, which, type ClusterSession, type SessionMcp } from "@landlens/acp-host";
import { AgentHistory, AgentSettings } from "./agent-history";
import { apiPath, type ChangeDecision, type ClusterManager, type FrontDoor } from "@landlens/kube";
import { getJson, redactObject, redactText } from "@landlens/kube-mcp";
import type { ContentBlock, NewSessionResponse, RequestPermissionOutcome, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { mkdirSync } from "node:fs";
import { delimiter } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

type Push = {
  (channel: "agent:update", payload: AgentUpdate): void;
  (channel: "agent:permission", payload: AgentPermissionRequest): void;
  (channel: "agent:status", payload: AgentStatus): void;
  (channel: "agent:change", payload: AgentChange): void;
};

const AGENT_TITLE = "Claude Code";
/** The modes the dock offers: Manual and Plan. Never acceptEdits, auto or bypass. */
const MODES = new Set(["default", "plan"]);

export class AgentService {
  private host: AcpHost | undefined;
  private starting: Promise<AcpHost> | undefined;
  private path = "";
  private readonly sessions = new Map<string, ClusterSession>();
  private readonly pending = new Map<string, {
    session: string;
    options: Set<string>;
    /** Each offered option's kind (allow_once, allow_always, reject_once, …). */
    kinds: Map<string, string>;
    toolCallId: string;
    toolName?: string;
    resolve: (o: RequestPermissionOutcome) => void;
  }>();
  /** Changes the agent proposed that wait for your decision, by change id. */
  private readonly changes = new Map<string, { session: string; resolve: (d: ChangeDecision) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly deps: {
      frontDoor: FrontDoor;
      clusters: ClusterManager;
      sessionsDir: string;
      push: Push;
      mcp: SessionMcp;
      /** A tool call seen in a session's updates, for pairing with the gateway's call log. */
      onToolCall?: (u: { session: string; toolCallId: string; toolName?: string; title?: string; rawInput?: unknown }) => void;
      /** You said yes to a permission request: the MCP gateway runs a proxied tool that asks only after this. */
      onPermit?: (p: { session: string; toolCallId: string; toolName?: string; always: boolean }) => void;
      metrics?: Parameters<typeof startClusterSession>[0]["metrics"];
      /** Past sessions and your chosen skills (agent-history.ts). */
      history?: AgentHistory;
      settings?: AgentSettings;
      /** Where your Claude Code skills are; ~/.claude/skills by default. */
      skillsDir?: string;
      log?: (l: string) => void;
    },
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
      const host = new AcpHost(
        { title: AGENT_TITLE, command: node, args: [claudeAdapterEntry()], env: { CLAUDE_AGENT_ACP_PROTOCOL: "v1" } },
        {
          cwd: this.deps.sessionsDir,
          env: agentEnv(process.env, { PATH: this.path }),
          events: {
            update: (n) => {
              const u = n.update as { sessionUpdate?: string; toolCallId?: string; title?: string; rawInput?: unknown; _meta?: { claudeCode?: { toolName?: unknown } } };
              if ((u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") && typeof u.toolCallId === "string") {
                const toolName = u._meta?.claudeCode?.toolName;
                this.deps.onToolCall?.({
                  session: n.sessionId, toolCallId: u.toolCallId,
                  ...(typeof toolName === "string" ? { toolName } : {}),
                  ...(typeof u.title === "string" ? { title: u.title } : {}),
                  ...(u.rawInput !== undefined ? { rawInput: u.rawInput } : {}),
                });
              }
              this.deps.push("agent:update", { session: n.sessionId, update: n.update as AgentUpdate["update"] });
            },
            permission: (req, signal) => this.ask(req, signal),
            exit: ({ code, stderr }) => {
              // Claude Code has gone: its sessions' tokens must not outlive it.
              for (const s of this.sessions.values()) s.revoke();
              this.sessions.clear();
              for (const [id, p] of this.pending) {
                p.resolve({ outcome: "cancelled" });
                this.pending.delete(id);
              }
              for (const [id, c] of this.changes) {
                c.reject(new Error("withdrawn"));
                this.changes.delete(id);
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
    return this.open({ handle, ...(namespaces?.length ? { namespaces } : {}) });
  }

  /** Resume a session from the history on a connected cluster with the same context. */
  async resume(handle: string, session: string): Promise<AgentSessionInfo> {
    const e = this.deps.history?.get(session);
    if (!e) throw Object.assign(new Error("Landlens has no such session in its history"), { status: 404 });
    if (this.sessions.has(session)) throw Object.assign(new Error("that session is already open"), { status: 409 });
    const c = this.deps.clusters.get(handle);
    if (c.info.context !== e.context) {
      throw Object.assign(new Error(`that session was on ${e.context}; connect to it to resume`), { status: 409 });
    }
    return this.open({ handle, ...(e.namespaces?.length ? { namespaces: e.namespaces } : {}), resume: { sessionId: session, cwd: e.cwd } });
  }

  private async open(req: Parameters<typeof startClusterSession>[1]): Promise<AgentSessionInfo> {
    const host = await this.ensure();
    const s = await startClusterSession({
      host, frontDoor: this.deps.frontDoor, clusters: this.deps.clusters, mcp: this.deps.mcp,
      ...(this.deps.metrics ? { metrics: this.deps.metrics } : {}),
      sessionsDir: this.deps.sessionsDir, home: homedir(), path: this.path,
      userKubeconfigs: process.env.KUBECONFIG?.split(delimiter).filter(Boolean) ?? [],
      changes: {
        ask: (change, signal) => this.askChange(change, signal),
        update: (change) => {
          if (change.state === "applied" || change.state === "rejected") this.deps.history?.changed(change.session, change.state);
          this.deps.push("agent:change", change);
        },
      },
      skills: this.chosenSkills(),
      ...(this.deps.log ? { log: this.deps.log } : {}),
    }, req);
    this.sessions.set(s.id, s);
    this.deps.history?.started({ session: s.id, agent: AGENT_TITLE, context: s.context, ...(s.namespaces ? { namespaces: s.namespaces } : {}), cwd: s.cwd });
    return info(s, s.response);
  }

  history(context?: string): AgentHistoryEntry[] {
    return this.deps.history?.list(context) ?? [];
  }

  /** Forget a past session: out of the list, and Claude Code deletes its transcript where it can. */
  async forget(session: string) {
    if (this.sessions.has(session)) throw Object.assign(new Error("close the session first"), { status: 409 });
    if (!this.deps.history?.forget(session)) throw Object.assign(new Error("Landlens has no such session in its history"), { status: 404 });
    if (this.host?.running) await this.host.deleteSession(session);
  }

  private get skillsDir() {
    return this.deps.skillsDir ?? join(homedir(), ".claude", "skills");
  }

  private chosenSkills() {
    const chosen = new Set(this.deps.settings?.skills() ?? []);
    return chosen.size ? listSkills(this.skillsDir).filter((s) => chosen.has(s.name)) : [];
  }

  settings(): AgentSettingsInfo {
    const chosen = new Set(this.deps.settings?.skills() ?? []);
    const skills = listSkills(this.skillsDir);
    return {
      skillsDir: this.skillsDir.replace(homedir(), "~"),
      skills: skills.map((s) => ({ name: s.name, description: s.description, chosen: chosen.has(s.name) })),
      missing: [...chosen].filter((n) => !skills.some((s) => s.name === n)),
    };
  }

  /** The skills new sessions get; a running session keeps what it started with. */
  setSkills(names: string[]) {
    const known = new Set(listSkills(this.skillsDir).map((s) => s.name));
    const unknown = names.filter((n) => !known.has(n));
    if (unknown.length) throw Object.assign(new Error(`no skill named ${unknown.join(", ")} in ${this.skillsDir}`), { status: 400 });
    this.deps.settings?.setSkills(names);
  }

  private session(id: string): ClusterSession {
    const s = this.sessions.get(id);
    if (!s) throw Object.assign(new Error("this agent session has ended"), { status: 404 });
    return s;
  }

  async prompt(id: string, text: string, context: ResourceRef[] = []): Promise<{ stopReason: string }> {
    const s = this.session(id);
    this.deps.history?.prompted(id, text);
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

  /** Show a proposed change in the dock and wait for your decision (agent:decide). */
  private askChange(change: AgentChange, signal: AbortSignal): Promise<ChangeDecision> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error("withdrawn"));
      this.changes.set(change.id, { session: change.session, resolve, reject });
      signal.addEventListener("abort", () => {
        if (this.changes.delete(change.id)) reject(new Error("withdrawn"));
      }, { once: true });
      this.deps.push("agent:change", change);
    });
  }

  /** Your decision on a change. Only a change that is waiting can be decided, and only once. */
  decide(change: string, decision: "approve" | "reject", note?: string) {
    const c = this.changes.get(change);
    if (!c) throw Object.assign(new Error("that change was already decided, expired or withdrawn"), { status: 404 });
    this.changes.delete(change);
    c.resolve({ decision, ...(note?.trim() ? { note: note.trim() } : {}) });
  }

  /** Answer every open question of a session with "cancelled", and withdraw its waiting changes. */
  private withdrawAsks(id: string) {
    for (const [cid, c] of this.changes) {
      if (c.session === id) {
        this.changes.delete(cid);
        c.reject(new Error("withdrawn"));
      }
    }
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
    const kind = option ? p.kinds.get(option) : undefined;
    if (kind === "allow_once" || kind === "allow_always") {
      this.deps.onPermit?.({ session: p.session, toolCallId: p.toolCallId, ...(p.toolName ? { toolName: p.toolName } : {}), always: kind === "allow_always" });
    }
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
  }

  private ask(req: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionOutcome> {
    const request = randomBytes(9).toString("base64url");
    return new Promise((resolve) => {
      const toolName = (req.toolCall._meta as { claudeCode?: { toolName?: unknown } } | undefined)?.claudeCode?.toolName;
      this.pending.set(request, {
        session: req.sessionId,
        options: new Set(req.options.map((o) => o.optionId)),
        kinds: new Map(req.options.map((o) => [o.optionId, o.kind])),
        toolCallId: req.toolCall.toolCallId,
        ...(typeof toolName === "string" ? { toolName } : {}),
        resolve,
      });
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

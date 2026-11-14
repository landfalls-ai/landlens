// Runs an ACP agent (Claude Code through claude-agent-acp by default) as a child process over stdio and speaks ACP v1
// to it. Landlens is the client: it creates sessions, sends prompts, relays session/update to the dock, and answers
// permission requests with the person's choice. It offers no file system and no terminals to the agent.
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  ContentBlock, InitializeResponse, LoadSessionRequest, LoadSessionResponse, NewSessionRequest, NewSessionResponse, PromptResponse, RequestPermissionOutcome,
  RequestPermissionRequest, SessionNotification,
} from "@agentclientprotocol/sdk";

export type AgentCommand = {
  /** Shown in the dock, e.g. "Claude Code". */
  title: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type HostEvents = {
  update(n: SessionNotification): void;
  /** Ask the person; resolve with their choice, or { outcome: "cancelled" }. */
  permission(req: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionOutcome>;
  exit(info: { code: number | null; stderr: string }): void;
  log?(line: string): void;
};

/** Modes a new session may start in. Anything else (auto, bypass) is switched to "default" at once. */
const SAFE_START_MODES = new Set(["default", "plan"]);

export class AcpHost {
  private child: ChildProcess | undefined;
  private conn: acp.ClientConnection | undefined;
  private stderr = "";
  init: InitializeResponse | undefined;

  constructor(
    private readonly agent: AgentCommand,
    private readonly opts: { cwd: string; env: NodeJS.ProcessEnv; events: HostEvents },
  ) {}

  get running() {
    return !!this.conn && !this.conn.signal.aborted;
  }

  async start(): Promise<InitializeResponse> {
    const child = spawn(this.agent.command, this.agent.args, {
      cwd: this.opts.cwd,
      env: { ...this.opts.env, ...this.agent.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr!.setEncoding("utf8").on("data", (d: string) => {
      this.stderr = (this.stderr + d).slice(-8000);
      for (const line of d.split("\n")) if (line.trim()) this.opts.events.log?.(line);
    });
    child.once("exit", (code) => {
      this.conn?.close();
      this.opts.events.exit({ code, stderr: this.stderr.trim().split("\n").slice(-5).join("\n") });
    });
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await spawned;

    const events = this.opts.events;
    const refuse = () => {
      throw acp.RequestError.invalidRequest(undefined, "Landlens does not offer this to agents");
    };
    this.conn = acp
      .client({ name: "landlens" })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => ({
        outcome: await events.permission(ctx.params, ctx.signal),
      }))
      .onRequest(acp.methods.client.fs.readTextFile, refuse)
      .onRequest(acp.methods.client.fs.writeTextFile, refuse)
      .onRequest(acp.methods.client.terminal.create, refuse)
      .onNotification(acp.methods.client.session.update, (ctx) => events.update(ctx.params))
      .onNotification("*", () => {}) // extensions (auth status, …) are fine to ignore
      .connect(acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>));

    this.init = await this.conn.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "landlens", title: "Landlens", version: "0.1.0" },
    });
    return this.init;
  }

  private get agentCx() {
    if (!this.conn || this.conn.signal.aborted) throw new Error(`${this.agent.title} is not running`);
    return this.conn.agent;
  }

  /** A new session, switched to "default" mode if your settings would start it in auto or bypass. */
  async newSession(req: NewSessionRequest): Promise<NewSessionResponse> {
    const res = await this.agentCx.request(acp.methods.agent.session.new, req);
    const current = res.modes?.currentModeId;
    if (current && !SAFE_START_MODES.has(current) && res.modes?.availableModes.some((m) => m.id === "default")) {
      await this.setMode(res.sessionId, "default");
      res.modes = { ...res.modes!, currentModeId: "default" };
    }
    return res;
  }

  /**
   * An earlier session, its history replayed as session updates before this answers; switched to "default" mode like
   * a new one. Needs the agent's loadSession capability.
   */
  async loadSession(req: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!this.init?.agentCapabilities?.loadSession) throw new Error(`${this.agent.title} can't resume sessions`);
    const res = await this.agentCx.request(acp.methods.agent.session.load, req);
    const current = res.modes?.currentModeId;
    if (current && !SAFE_START_MODES.has(current) && res.modes?.availableModes.some((m) => m.id === "default")) {
      await this.setMode(req.sessionId, "default");
      res.modes = { ...res.modes!, currentModeId: "default" };
    }
    return res;
  }

  /** Forget a session's transcript, where the agent can. */
  async deleteSession(sessionId: string): Promise<void> {
    if (!this.init?.agentCapabilities?.sessionCapabilities?.delete) return;
    await this.agentCx.request(acp.methods.agent.session.delete, { sessionId }).catch(() => {});
  }

  prompt(sessionId: string, prompt: ContentBlock[]): Promise<PromptResponse> {
    return this.agentCx.request(acp.methods.agent.session.prompt, { sessionId, prompt });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.agentCx.notify(acp.methods.agent.session.cancel, { sessionId });
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.agentCx.request(acp.methods.agent.session.setMode, { sessionId, modeId });
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<unknown> {
    return this.agentCx.request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value });
  }

  async closeSession(sessionId: string): Promise<void> {
    if (!this.init?.agentCapabilities?.sessionCapabilities?.close) return;
    await this.agentCx.request(acp.methods.agent.session.close, { sessionId }).catch(() => {});
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.conn?.close();
    if (!child || child.exitCode !== null) return;
    child.stdin?.end();
    const exited = new Promise((r) => child.once("exit", r));
    const t = setTimeout(() => child.kill("SIGTERM"), 2000);
    const k = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(t);
    clearTimeout(k);
  }
}

// The call log: every MCP call through the gateway, newest last, kept in memory (the last 500). What's logged is
// scrubbed the way tool results are; the full result of an app tool is kept apart, for its view, and never logged.
import { randomBytes } from "node:crypto";
import type { McpCall, McpFrontDoorRequest, McpToolResult } from "@landlens/contracts";
import { redactObject, redactText } from "@landlens/kube-mcp";

export const MAX_CALLS = 500;
export const MAX_PREVIEW = 2000;
/** App results kept for their views (by call id). */
export const MAX_APP_RESULTS = 50;
/** Front-door requests kept per call. */
export const MAX_REQUESTS = 100;

/**
 * "c" and 20 random base-36 digits (about 103 bits): what the front door accepts in X-Landlens-Call. Random, so no one
 * else holding a front-door token can guess a running call's id to file requests under it.
 */
export const newCallId = () => {
  const bytes = randomBytes(20);
  let id = "c";
  for (const b of bytes) id += (b % 36).toString(36);
  return id;
};

/** An app tool's full result, for its view, and the address of the remote server that answered (for its HTML). */
export type AppResult = { args: Record<string, unknown>; result: McpToolResult; url?: string };

export class CallLog {
  private readonly calls: McpCall[] = [];
  private readonly byId = new Map<string, McpCall>();
  private readonly results = new Map<string, AppResult>();
  private readonly listeners = new Set<(c: McpCall) => void>();

  /** Called with a copy of a call each time it starts or changes. */
  subscribe(fn: (c: McpCall) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  list(): McpCall[] {
    return this.calls.map((c) => ({ ...c, requests: [...c.requests] }));
  }

  get(id: string): McpCall | undefined {
    const c = this.byId.get(id);
    return c ? { ...c, requests: [...c.requests] } : undefined;
  }

  start(c: Omit<McpCall, "status" | "startedAt" | "requests" | "args"> & { args: unknown }): McpCall {
    const call: McpCall = { ...c, args: redactObject(c.args ?? {}), status: "running", startedAt: Date.now(), requests: [] };
    this.calls.push(call);
    this.byId.set(call.id, call);
    while (this.calls.length > MAX_CALLS) {
      const old = this.calls.shift()!;
      this.byId.delete(old.id);
      this.results.delete(old.id);
    }
    this.emit(call);
    return call;
  }

  finish(id: string, end: { status: "ok" | "error" | "refused"; result?: McpToolResult; error?: string; app?: string }) {
    const c = this.byId.get(id);
    if (!c) return;
    c.endedAt = Date.now();
    c.ms = c.endedAt - c.startedAt;
    c.status = end.status;
    if (end.result) {
      const text = textOf(end.result);
      if (text) c.preview = cut(redactText(text), MAX_PREVIEW);
    }
    if (end.error) c.error = cut(redactText(end.error), 500);
    if (end.app) c.app = end.app;
    this.emit(c);
  }

  /** How the call got to run (the gateway decided before forwarding it): read, asked, autonomous, preview. */
  gate(id: string, gate: NonNullable<McpCall["gate"]>) {
    const c = this.byId.get(id);
    if (!c || c.gate === gate) return;
    c.gate = gate;
    this.emit(c);
  }

  /** Remember an app tool's full result, for its view; only the last MAX_APP_RESULTS. */
  keepResult(id: string, r: AppResult) {
    this.results.set(id, r);
    while (this.results.size > MAX_APP_RESULTS) this.results.delete(this.results.keys().next().value!);
  }

  result(id: string): AppResult | undefined {
    return this.results.get(id);
  }

  /** The dock's tool card for a call, once known. */
  pair(id: string, toolCallId: string) {
    const c = this.byId.get(id);
    if (!c || c.toolCallId === toolCallId) return;
    c.toolCallId = toolCallId;
    this.emit(c);
  }

  /** A front-door request made for a call (from the audit trail). */
  request(id: string, r: McpFrontDoorRequest) {
    const c = this.byId.get(id);
    if (!c || c.requests.length >= MAX_REQUESTS) return;
    c.requests.push(r);
    // Requests usually land while the call runs; its finish carries them. Late ones are sent on their own.
    if (c.status !== "running") this.emit(c);
  }

  private emit(c: McpCall) {
    const copy = { ...c, requests: [...c.requests] };
    for (const l of this.listeners) l(copy);
  }
}

export function textOf(r: McpToolResult): string {
  return (r.content ?? [])
    .map((c) => (c && typeof c === "object" && (c as { type?: unknown }).type === "text" ? String((c as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

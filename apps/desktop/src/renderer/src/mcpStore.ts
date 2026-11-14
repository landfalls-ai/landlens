// The MCP call log as the renderer sees it: one list, loaded once and kept live from main's "mcp:call" pushes, shared
// by the MCP page, the call drawer and the dock (which pairs its tool cards with calls by toolCallId).
import type { McpCall } from "@landlens/contracts";
import { useEffect, useState } from "react";
import { api } from "./api";

const MAX = 500;
let calls: McpCall[] = [];
let loaded: Promise<void> | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function upsert(c: McpCall) {
  const at = calls.findIndex((x) => x.id === c.id);
  calls = at >= 0 ? calls.map((x, i) => (i === at ? c : x)) : [...calls, c].slice(-MAX);
}

api.on("mcp:call", (c: McpCall) => {
  upsert(c);
  emit();
});

function load() {
  loaded ??= api.invoke("mcp:calls", {}).then(({ calls: all }) => {
    for (const c of all) if (!calls.some((x) => x.id === c.id)) upsert(c);
    calls = [...calls].sort((a, b) => a.startedAt - b.startedAt);
    emit();
  }, () => void (loaded = undefined));
  return loaded;
}

/** Every logged call, oldest first, live. */
export function useMcpCalls(): McpCall[] {
  const [, render] = useState(0);
  useEffect(() => {
    const l = () => render((n) => n + 1);
    listeners.add(l);
    void load();
    return () => void listeners.delete(l);
  }, []);
  return calls;
}

/** A call's view can open once it returned and the gateway kept its result. */
export const hasView = (c: McpCall | undefined): c is McpCall & { app: string } => !!c?.app && c.status === "ok";

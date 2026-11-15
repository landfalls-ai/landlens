// The renderer's side of logs and terminals: one listener per push channel, with a buffer for ids nobody listens to
// yet (main may push before invoke() returns the id, or before the view that shows it mounts).
import type { LogLine, LogsEnd, LogsPush, TerminalData, TerminalStatus } from "@landlens/contracts";
import { api } from "./api";

type Sink<T> = (e: T) => void;

function hub<T extends Record<K, string>, K extends string>(channel: "logs:lines" | "logs:end" | "terminal:data" | "terminal:status", key: K, keep: number) {
  const sinks = new Map<string, Sink<T>>();
  const early = new Map<string, T[]>();
  api.on(channel, (e: T) => {
    const id = e[key];
    const s = sinks.get(id);
    if (s) return s(e);
    const list = early.get(id) ?? [];
    if (list.length < keep) list.push(e);
    early.set(id, list);
    setTimeout(() => early.delete(id), 30_000);
  });
  return (id: string, sink: Sink<T>) => {
    sinks.set(id, sink);
    for (const e of early.get(id) ?? []) sink(e);
    early.delete(id);
    return () => {
      if (sinks.get(id) === sink) sinks.delete(id);
    };
  };
}

export const onLogLines = hub<LogsPush, "stream">("logs:lines", "stream", 200);
export const onLogEnd = hub<LogsEnd, "stream">("logs:end", "stream", 1);
export const onTerminalData = hub<TerminalData, "terminal">("terminal:data", "terminal", 2000);
export const onTerminalStatus = hub<TerminalStatus, "terminal">("terminal:status", "terminal", 4);

export type { LogLine };

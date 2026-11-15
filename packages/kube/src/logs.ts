// A container's log, followed: one long GET with follow=true read as it arrives (not Lens's 10-second poll). Lines
// carry the API server's RFC 3339 timestamp so a workload's pods can be merged in order and the view can show or hide
// it. Lines are sent in batches, so a busy container doesn't flood the window.
import { toKubeError, type KubeClient } from "./client.js";

export type LogRequest = {
  namespace: string;
  pod: string;
  container: string;
  /** The run before the last restart; never followed (it has ended). */
  previous?: boolean;
  /** Lines from the end to start with. */
  tailLines?: number;
  /** Start after this time (RFC 3339), to pick up where a dropped stream left off. */
  sinceTime?: string;
  follow?: boolean;
};

export type LogLine = { ts: string; text: string };
export type LogEnd = { status?: number; message?: string };

export const MAX_TAIL = 10_000;
/** Longer lines are cut: one line can't take the window's memory. */
export const MAX_LINE = 16 * 1024;
const BATCH_MS = 100;
const BATCH_LINES = 500;

export function logPath(r: LogRequest): string {
  const q = new URLSearchParams({ container: r.container, timestamps: "true" });
  if (r.previous) q.set("previous", "true");
  else if (r.follow !== false) q.set("follow", "true");
  if (r.sinceTime) q.set("sinceTime", r.sinceTime);
  else q.set("tailLines", String(Math.min(Math.max(r.tailLines ?? 1000, 1), MAX_TAIL)));
  return `/api/v1/namespaces/${encodeURIComponent(r.namespace)}/pods/${encodeURIComponent(r.pod)}/log?${q}`;
}

/** "2026-11-15T10:00:00.123456789Z message" → its parts; a line without a timestamp keeps its text. */
export function splitLine(raw: string): LogLine {
  const sp = raw.indexOf(" ");
  const ts = sp > 0 ? raw.slice(0, sp) : "";
  const ok = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(ts);
  const text = ok ? raw.slice(sp + 1) : raw;
  return { ts: ok ? ts : "", text: text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}… (${text.length - MAX_LINE} more characters)` : text };
}

/** Follow one container's log until it ends or `stop()`; `lines` gets batches, `end` once. */
export function followLogs(client: Pick<KubeClient, "request">, r: LogRequest, on: { lines(l: LogLine[]): void; end(e: LogEnd): void }): () => void {
  const abort = new AbortController();
  let pending: LogLine[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (pending.length) {
      const batch = pending;
      pending = [];
      on.lines(batch);
    }
  };
  const push = (raw: string) => {
    if (!raw) return;
    pending.push(splitLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw));
    if (pending.length >= BATCH_LINES) flush();
    else timer ??= setTimeout(flush, BATCH_MS);
  };

  void (async () => {
    try {
      const res = await client.request(logPath(r), { signal: abort.signal, headers: { Accept: "*/*" } /* the log endpoint answers text/plain but refuses to be asked for it */ });
      if (!res.ok) throw toKubeError(res.status, await res.text());
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          push(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
        if (buf.length > MAX_LINE * 4) {
          push(buf);
          buf = "";
        }
      }
      push(buf);
      flush();
      if (!stopped) on.end({});
    } catch (err) {
      flush();
      if (stopped) return;
      const e = err as { status?: number; message?: string; name?: string };
      on.end({ ...(e.status ? { status: e.status } : {}), message: e.message ?? String(err) });
    }
  })();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    abort.abort();
  };
}

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
/** A batch is sent at 512 K characters too, and a stream is read at most 2 M characters a second. */
const BATCH_CHARS = 512 * 1024;
export const RATE = 2 * 1024 * 1024;

export function logPath(r: LogRequest): string {
  const q = new URLSearchParams({ container: r.container, timestamps: "true" });
  if (r.previous) q.set("previous", "true");
  else if (r.follow !== false) q.set("follow", "true");
  if (r.sinceTime) q.set("sinceTime", r.sinceTime);
  else q.set("tailLines", String(Math.min(Math.max(r.tailLines ?? 1000, 1), MAX_TAIL)));
  return `/api/v1/namespaces/${encodeURIComponent(r.namespace)}/pods/${encodeURIComponent(r.pod)}/log?${q}`;
}

/**
 * The last lines of a container's log, not followed, read with a time limit (the doctor's evidence, wave 5 D60). Up
 * to `readBytes` (1 MB) is read and only the last `maxBytes` kept, cut at a line start, so a long stack trace keeps its
 * end, which is the crash itself (part 2 review, finding 5). Lines keep their text only.
 */
export async function readLogTail(
  client: Pick<KubeClient, "request">, r: LogRequest, opts: { maxBytes: number; timeoutMs: number; readBytes?: number },
): Promise<{ lines: string[]; cut: boolean }> {
  const readBytes = Math.max(opts.readBytes ?? 1048576, opts.maxBytes);
  const res = await client.request(logPath({ ...r, follow: false }), { signal: AbortSignal.timeout(opts.timeoutMs), headers: { Accept: "*/*" } });
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let read = 0;
  let dropped = false; // bytes dropped from the start
  let stopped = false; // the answer was longer than readBytes
  const reader = res.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.byteLength, readBytes - read);
    chunks.push(take < value.byteLength ? value.subarray(0, take) : value);
    kept += take;
    read += take;
    // Keep only what can still be in the last maxBytes.
    while (chunks.length > 1 && kept - chunks[0]!.byteLength >= opts.maxBytes) {
      kept -= chunks.shift()!.byteLength;
      dropped = true;
    }
    if (read >= readBytes) {
      stopped = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  let buf = Buffer.concat(chunks);
  if (!res.ok) throw toKubeError(res.status, buf.subarray(0, 4096).toString("utf8"));
  if (buf.byteLength > opts.maxBytes) {
    buf = buf.subarray(buf.byteLength - opts.maxBytes);
    dropped = true;
  }
  let text = buf.toString("utf8");
  if (dropped) {
    // Start at a whole line; a single line longer than the window is kept from where the window starts.
    const nl = text.indexOf("\n");
    if (nl >= 0 && nl < text.length - 1) text = text.slice(nl + 1);
  }
  const raw = text.split("\n");
  if (stopped && raw.length > 1) raw.pop(); // its last line was cut
  return { lines: raw.filter((l) => l.length).map((l) => splitLine(l).text), cut: dropped || stopped };
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
  let pendingChars = 0;
  // A container that logs without pause is read at most RATE characters a second: past that the reader waits, and
  // the API server's stream with it (security review, wave 4 part 1, finding 9).
  let windowStart = Date.now();
  let windowChars = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (pending.length) {
      const batch = pending;
      pending = [];
      pendingChars = 0;
      on.lines(batch);
    }
  };
  const push = (raw: string) => {
    if (!raw) return;
    const line = splitLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    pending.push(line);
    pendingChars += line.text.length;
    windowChars += line.text.length;
    if (pending.length >= BATCH_LINES || pendingChars >= BATCH_CHARS) flush();
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
        if (windowChars > RATE) {
          const wait = windowStart + 1000 - Date.now();
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          if (stopped) break;
        }
        if (Date.now() - windowStart >= 1000) (windowStart = Date.now(), windowChars = 0);
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

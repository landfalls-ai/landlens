// The telemetry queue (wave 7 D128): at most 2,000 records, the oldest dropped first; a batch every 10 s, or as soon as
// 200 wait; each signal POSTed as OTLP/HTTP JSON to the one collector the person set, with a 5 s limit and no
// redirects; a batch that fails three times is dropped, and so counted. Nothing here throws into a caller or blocks
// it: push only queues, and flush catches everything. It keeps the last 100 records as queued, for "See what is sent".
import type { TelemetryRecord } from "@landlens/contracts";
import { otlpBodies, type Resource } from "./otlp.js";
import { event } from "./records.js";

export const QUEUE = { max: 2_000, batch: 200, everyMs: 10_000, timeoutMs: 5_000, tries: 3, recent: 100 } as const;

type Item = { r: TelemetryRecord; tries: number };
type Signal = "traces" | "metrics" | "logs";
const SIGNAL: Record<TelemetryRecord["signal"], Signal> = { span: "traces", metric: "metrics", log: "logs" };

export type QueueDeps = {
  /** The collector's origin, or undefined while telemetry is off (then nothing is sent). */
  collector(): string | undefined;
  resource(): Resource;
  fetch?: typeof fetch;
  now?: () => number;
  /** The collector answered, or didn't: for the card's "Sent 12:03". */
  onState?: () => void;
};

export class TelemetryQueue {
  private items: Item[] = [];
  private readonly last100: TelemetryRecord[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private sending: Promise<void> | undefined;
  /** Records dropped since start: the cap, or a batch that failed three times. */
  dropped = 0;
  private unreported = 0;
  last: { at: number; ok: boolean } | undefined;

  constructor(private readonly d: QueueDeps) {}

  private get now() {
    return (this.d.now ?? Date.now)();
  }

  get waiting() {
    return this.items.length;
  }

  /** The last 100 records exactly as queued, oldest first. */
  recent(): TelemetryRecord[] {
    return [...this.last100];
  }

  /** Queue a record (undefined, a check that failed, is nothing). Never throws, never waits. */
  push(r: TelemetryRecord | undefined) {
    if (!r) return;
    this.items.push({ r, tries: 0 });
    this.last100.push(r);
    if (this.last100.length > QUEUE.recent) this.last100.splice(0, this.last100.length - QUEUE.recent);
    this.trim();
    if (this.items.length >= QUEUE.batch) void this.flush();
  }

  private trim() {
    const over = this.items.length - QUEUE.max;
    if (over > 0) {
      this.items.splice(0, over);
      this.dropped += over;
      this.unreported += over;
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), QUEUE.everyMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Telemetry turned off: what waits is dropped unsent, and the drawer empties. */
  clear() {
    this.items = [];
    this.last100.length = 0;
    this.unreported = 0;
  }

  /** Send what waits, in batches, one signal at a time; never throws. */
  flush(): Promise<void> {
    this.sending ??= this.send().catch(() => {}).finally(() => (this.sending = undefined));
    return this.sending;
  }

  private async send() {
    const collector = this.d.collector();
    if (!collector || !this.items.length) return;
    if (this.unreported > 0) {
      const n = this.unreported;
      this.unreported = 0;
      this.push(event("telemetry.dropped", "warn", n, this.now));
    }
    const failed: Item[] = [];
    let anyOk = false;
    let anyFail = false;
    while (this.items.length) {
      const batch = this.items.splice(0, QUEUE.batch);
      for (const signal of ["traces", "metrics", "logs"] as const) {
        const part = batch.filter((i) => SIGNAL[i.r.signal] === signal);
        if (!part.length) continue;
        const ok = await this.post(collector, signal, part.map((i) => i.r));
        if (ok) anyOk = true;
        else {
          anyFail = true;
          for (const i of part) {
            if (++i.tries < QUEUE.tries) failed.push(i);
            else (this.dropped++, this.unreported++);
          }
        }
      }
      if (anyFail) {
        // The collector isn't taking records: keep the rest for the next flush, behind the failed ones.
        failed.push(...this.items.splice(0));
        break;
      }
    }
    this.items = [...failed, ...this.items];
    this.trim();
    this.last = { at: this.now, ok: anyOk && !anyFail };
    this.d.onState?.();
  }

  private async post(collector: string, signal: Signal, records: TelemetryRecord[]): Promise<boolean> {
    const body = otlpBodies(records, this.d.resource())[signal];
    if (!body) return true;
    try {
      const r = await (this.d.fetch ?? fetch)(`${collector}/v1/${signal}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(QUEUE.timeoutMs),
      });
      // The answer's body is never read: a collector's word is its status.
      await r.body?.cancel().catch(() => undefined);
      return r.ok;
    } catch {
      return false;
    }
  }
}

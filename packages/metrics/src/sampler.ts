// The fallback when Clickland isn't there: metrics-server's current usage, sampled every 15 s while a view asks for
// it, kept for an hour in a ring buffer. It stops itself when nothing has asked for a while.
import { quantity } from "./quantity.js";

export type Usage = { cpu: number; memory: number };
export type Sample = {
  t: number;
  nodes: Map<string, Usage>;
  /** "namespace/pod" → container → usage. */
  pods: Map<string, Map<string, Usage>>;
};
export type Get = (path: string) => Promise<any>;

export type SamplerOptions = {
  intervalMs?: number;
  keepMs?: number;
  /** Stop sampling this long after the last request. */
  idleMs?: number;
  now?: () => number;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void };
};

/** A fixed-size ring: pushing past capacity drops the oldest. */
export class Ring<T> {
  private items: (T | undefined)[];
  private start = 0;
  private size = 0;
  constructor(readonly capacity: number) {
    this.items = new Array(capacity);
  }
  push(item: T) {
    this.items[(this.start + this.size) % this.capacity] = item;
    if (this.size < this.capacity) this.size++;
    else this.start = (this.start + 1) % this.capacity;
  }
  toArray(): T[] {
    return Array.from({ length: this.size }, (_, i) => this.items[(this.start + i) % this.capacity]!);
  }
  get length() {
    return this.size;
  }
}

const METRICS_API = "/apis/metrics.k8s.io/v1beta1";

export class MetricsServerSampler {
  readonly intervalMs: number;
  private readonly ring: Ring<Sample>;
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly timers: NonNullable<SamplerOptions["timers"]>;
  private timer: unknown;
  private lastAsked = 0;
  private probe?: { at: number; ok: boolean; message: string };
  lastError?: string;

  constructor(private readonly get: Get, opts: SamplerOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 15_000;
    this.ring = new Ring(Math.ceil((opts.keepMs ?? 3_600_000) / this.intervalMs));
    this.idleMs = opts.idleMs ?? 90_000;
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? { set: (fn, ms) => setInterval(fn, ms), clear: (t) => clearInterval(t as NodeJS.Timeout) };
  }

  /** Whether the cluster serves metrics.k8s.io; asked at most once a minute. */
  async available(): Promise<{ ok: boolean; message: string }> {
    const now = this.now();
    if (this.probe && now - this.probe.at < 60_000) return this.probe;
    try {
      const list = await this.get(METRICS_API);
      const ok = Array.isArray(list?.resources) && list.resources.some((r: { name?: string }) => r.name === "pods");
      this.probe = { at: now, ok, message: ok ? "metrics-server answers" : "metrics.k8s.io lists no pods resource" };
    } catch (err) {
      const status = (err as { status?: number }).status;
      this.probe = {
        at: now,
        ok: false,
        message: status === 404 ? "This cluster doesn't serve metrics.k8s.io: metrics-server isn't installed." : `metrics.k8s.io didn't answer: ${(err as Error).message}`,
      };
    }
    return this.probe;
  }

  /** A view needs samples: start (with one sample now) if stopped, and stay on while asked. */
  touch(): Promise<void> | undefined {
    this.lastAsked = this.now();
    if (this.timer !== undefined) return undefined;
    this.timer = this.timers.set(() => void this.tick(), this.intervalMs);
    return this.tick();
  }

  get running() {
    return this.timer !== undefined;
  }

  stop() {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.now() - this.lastAsked > this.idleMs) return this.stop();
    try {
      const [nodes, pods] = await Promise.all([this.get(`${METRICS_API}/nodes`), this.get(`${METRICS_API}/pods`)]);
      this.ring.push(toSample(this.now(), nodes, pods));
      this.lastError = undefined;
    } catch (err) {
      this.lastError = (err as Error).message;
    }
  }

  /** Samples taken at or after `since`, oldest first. */
  samples(since = 0): Sample[] {
    return this.ring.toArray().filter((s) => s.t >= since);
  }
}

const usage = (u: { cpu?: string; memory?: string } | undefined): Usage => ({
  cpu: finite(quantity(u?.cpu)),
  memory: finite(quantity(u?.memory)),
});
const finite = (n: number) => (Number.isFinite(n) ? n : 0);

/** NodeMetricsList and PodMetricsList as one sample. */
export function toSample(t: number, nodes: any, pods: any): Sample {
  const s: Sample = { t, nodes: new Map(), pods: new Map() };
  for (const n of nodes?.items ?? []) if (n?.metadata?.name) s.nodes.set(n.metadata.name, usage(n.usage));
  for (const p of pods?.items ?? []) {
    if (!p?.metadata?.name) continue;
    s.pods.set(`${p.metadata.namespace}/${p.metadata.name}`, new Map((p.containers ?? []).map((c: any) => [String(c.name), usage(c.usage)])));
  }
  return s;
}

// List then watch one kind (optionally in one namespace), keep the current objects, and report batched changes.
//
// From the Lens study: list, then watch from the list's resourceVersion; relist on 410 Gone; ask the server to end
// the watch after timeoutSeconds and restart it; apply changes in batches. Added here (neither fork has them):
// paginated lists, so a 20k-pod cluster doesn't arrive as one response, and watch bookmarks, so a quiet watch
// restarts from a fresh resourceVersion instead of relisting.
import type { KubeObject } from "@landlens/contracts";
import { apiPath, KubeError, slim, toKubeError, type KubeClient } from "./client.js";

export type WatchTarget = {
  group: string; version: string; resource: string; namespace?: string;
  /** Sent as query parameters (never in the path), to the list and the watch alike (wave 10, D207). */
  labelSelector?: string; fieldSelector?: string;
};

export type WatcherEvent =
  | { type: "snapshot"; items: KubeObject[] }
  | { type: "delta"; upserted: KubeObject[]; removed: string[] }
  | { type: "error"; status: number; message: string; fatal: boolean };

export type WatcherOptions = {
  pageSize?: number;
  batchMs?: number;
  timeoutSeconds?: number;
  /** Backoff after a failure, doubled up to maxBackoffMs. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /**
   * The most objects kept (wave 10, D225: a view's watch keeps 10,000). Past it the list stops paging, objects the
   * watch adds are dropped, and `truncated` says so until a relist fits. Absent: no cap (the IDE's own tables).
   */
  maxItems?: number;
};

class Gone extends Error {}

export class ResourceWatcher {
  /** Set when the loop ended on its own after a fatal error (no access, unknown kind). */
  failed = false;
  private readonly items = new Map<string, KubeObject>();
  private pendingUpserts = new Map<string, KubeObject>();
  private pendingRemoved = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private abort: AbortController | undefined;
  /** Ends a backoff sleep early, so stop() doesn't wait up to maxBackoffMs. */
  private wake: (() => void) | undefined;
  private stopped = false;
  private readonly opts: Required<Omit<WatcherOptions, "maxItems">> & { maxItems: number };
  private cut = false;
  /** Resolves when the loop has ended after stop(). */
  done: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: KubeClient,
    private readonly target: WatchTarget,
    private readonly onEvent: (e: WatcherEvent) => void,
    opts: WatcherOptions = {},
  ) {
    const max = opts.maxItems;
    if (max !== undefined && !(Number.isInteger(max) && max > 0)) throw new RangeError("maxItems must be a positive integer");
    this.opts = { pageSize: 500, batchMs: 250, timeoutSeconds: 600, backoffMs: 1000, maxBackoffMs: 30_000, ...opts, maxItems: max ?? Infinity };
  }

  /** Whether objects were left out at `maxItems` since the last list that fitted. */
  get truncated(): boolean {
    return this.cut;
  }

  start(): this {
    this.done = this.loop();
    return this;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    this.wake?.();
    clearTimeout(this.flushTimer);
    await this.done.catch(() => {});
  }

  /** The current objects (for a late subscriber). */
  snapshot(): KubeObject[] {
    return [...this.items.values()];
  }

  private async loop(): Promise<void> {
    let backoff = this.opts.backoffMs;
    let gones = 0;
    while (!this.stopped) {
      try {
        let rv = await this.list();
        while (!this.stopped) {
          rv = await this.watch(rv);
          // Only a watch that ran its course counts as healthy: a server that lists fine but refuses every watch
          // must not make us relist in a tight loop.
          backoff = this.opts.backoffMs;
          gones = 0;
        }
      } catch (err) {
        if (this.stopped) return;
        if (err instanceof Gone) {
          // Relist at once the first time; if the server keeps answering 410, back off instead of spinning.
          if (gones++ === 0) continue;
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, this.opts.maxBackoffMs);
          continue;
        }
        const status = err instanceof KubeError ? err.status : 0;
        const message = err instanceof Error ? err.message : String(err);
        // No access, or the kind doesn't exist: retrying won't help.
        const fatal = status === 401 || status === 403 || status === 404;
        this.onEvent({ type: "error", status, message, fatal });
        if (fatal) {
          this.failed = true;
          return;
        }
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, this.opts.maxBackoffMs);
      }
    }
  }

  private async list(): Promise<string> {
    const items = new Map<string, KubeObject>();
    let cont: string | undefined;
    let rv = "";
    let cut = false;
    do {
      const q = this.query({ limit: String(this.opts.pageSize) });
      if (cont) q.set("continue", cont);
      this.abort = new AbortController();
      const res = await this.client.request(`${this.path()}?${q}`, { signal: this.abort.signal });
      const text = await res.text();
      if (res.status === 410) throw new Gone(); // the continue token expired mid-list
      if (!res.ok) throw toKubeError(res.status, text);
      const page = JSON.parse(text);
      for (const o of page.items ?? []) {
        if (items.size >= this.opts.maxItems) {
          cut = true;
          break;
        }
        const obj = this.withKind(o, page);
        items.set(obj.metadata.uid, obj);
      }
      cont = page.metadata?.continue || undefined;
      rv = page.metadata?.resourceVersion ?? rv;
      // Past the cap, stop paging: every page of one list shares the first page's resourceVersion, so the watch can
      // still start from it (objects it then adds are dropped below).
      if (cont && items.size >= this.opts.maxItems) cut = true;
    } while (cont && !cut && !this.stopped);

    this.cut = cut;
    this.items.clear();
    for (const [k, v] of items) this.items.set(k, v);
    this.pendingUpserts.clear();
    this.pendingRemoved.clear();
    this.onEvent({ type: "snapshot", items: [...items.values()] });
    return rv;
  }

  /** One watch request; returns the resourceVersion to resume from. */
  private async watch(rv: string): Promise<string> {
    const q = this.query({
      watch: "1",
      resourceVersion: rv,
      allowWatchBookmarks: "true",
      timeoutSeconds: String(this.opts.timeoutSeconds),
    });
    this.abort = new AbortController();
    // If the server forgets to end the watch, end it ourselves a minute later (as Lens does).
    const guard = setTimeout(() => this.abort?.abort(), (this.opts.timeoutSeconds + 60) * 1000);
    try {
      const res = await this.client.request(`${this.path()}?${q}`, { signal: this.abort.signal });
      if (res.status === 410) throw new Gone();
      if (!res.ok) throw toKubeError(res.status, await res.text());
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) rv = this.apply(JSON.parse(line), rv);
        }
      }
      return rv;
    } catch (err) {
      if (this.stopped || (err instanceof Error && err.name === "AbortError")) return rv;
      throw err;
    } finally {
      clearTimeout(guard);
    }
  }

  private apply(ev: { type: string; object: any }, rv: string): string {
    const o = ev.object;
    switch (ev.type) {
      case "ADDED":
      case "MODIFIED": {
        const obj = slim(o as KubeObject);
        if (!this.items.has(obj.metadata.uid) && this.items.size >= this.opts.maxItems) {
          this.cut = true;
          break;
        }
        this.items.set(obj.metadata.uid, obj);
        this.pendingRemoved.delete(obj.metadata.uid);
        this.pendingUpserts.set(obj.metadata.uid, obj);
        break;
      }
      case "DELETED": {
        const uid = o.metadata.uid as string;
        this.items.delete(uid);
        this.pendingUpserts.delete(uid);
        this.pendingRemoved.add(uid);
        break;
      }
      case "BOOKMARK":
        break;
      case "ERROR":
        if (o?.code === 410) throw new Gone();
        throw new KubeError(o?.code ?? 500, o?.message ?? "watch error", o?.reason);
    }
    this.scheduleFlush();
    return o?.metadata?.resourceVersion ?? rv;
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (!this.pendingUpserts.size && !this.pendingRemoved.size) return;
      const upserted = [...this.pendingUpserts.values()];
      const removed = [...this.pendingRemoved];
      this.pendingUpserts = new Map();
      this.pendingRemoved = new Set();
      this.onEvent({ type: "delta", upserted, removed });
    }, this.opts.batchMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => this.wake?.(), ms);
      this.wake = () => {
        clearTimeout(t);
        this.wake = undefined;
        resolve();
      };
    });
  }

  private path() {
    return apiPath(this.target, this.target.namespace);
  }

  /** The list's and the watch's query, with the target's selectors. */
  private query(q: Record<string, string>): URLSearchParams {
    const out = new URLSearchParams(q);
    if (this.target.labelSelector) out.set("labelSelector", this.target.labelSelector);
    if (this.target.fieldSelector) out.set("fieldSelector", this.target.fieldSelector);
    return out;
  }

  /** List items carry no apiVersion/kind; fill them from the list so the UI and YAML are complete. */
  private withKind(o: any, page: any): KubeObject {
    const kind = typeof page.kind === "string" && page.kind.endsWith("List") ? page.kind.slice(0, -4) : undefined;
    return slim({ apiVersion: page.apiVersion, kind, ...o });
  }
}


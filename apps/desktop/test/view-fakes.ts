// An in-memory front door and Kubernetes API for the view runtime's tests (as wave 8's drain tests use fake-api.ts):
// tokens with the real policy check (`authorize`), lists with label and field selectors, watches that stream the
// store's changes and close when their token is revoked, single GETs, metrics-server and followed logs. Every request
// is recorded with the token's label, so a test can say "this sent nothing". A token whose policy redacts gets its answers
// scrubbed as the front door scrubs them (redactObject for JSON and each watch event, a LineScrubber per
// followed log, scrubLines for a whole one), so the runtime's tests see what the app sees (security review, L8).
import { KubeClient, LineScrubber, authorize, parseRequest, redactObject, scrubLines, type TokenGrant } from "@landlens/kube";
import type { KubeObject, ResourceType } from "@landlens/contracts";

export type Seen = { label: string; method: string; path: string; status: number };

const KINDS: Record<string, { kind: string; group: string; version: string; namespaced: boolean }> = {
  pods: { kind: "Pod", group: "", version: "v1", namespaced: true },
  events: { kind: "Event", group: "", version: "v1", namespaced: true },
  configmaps: { kind: "ConfigMap", group: "", version: "v1", namespaced: true },
  secrets: { kind: "Secret", group: "", version: "v1", namespaced: true },
  nodes: { kind: "Node", group: "", version: "v1", namespaced: false },
  deployments: { kind: "Deployment", group: "apps", version: "v1", namespaced: true },
  replicasets: { kind: "ReplicaSet", group: "apps", version: "v1", namespaced: true },
  jobs: { kind: "Job", group: "batch", version: "v1", namespaced: true },
  // A custom resource whose kind is also Node (Longhorn's), with its own shapes (L2).
  lhnodes: { kind: "Node", group: "longhorn.io", version: "v1beta1", namespaced: false },
};

export const TYPES: ResourceType[] = [
  ...Object.entries(KINDS).map(([resource, k]) => ({ group: k.group, version: k.version, resource, kind: k.kind, namespaced: k.namespaced, verbs: ["get", "list", "watch"] })),
  // As a cluster with metrics-server discovers them (L4): nodes' usage is cluster-scoped, pods' namespaced.
  { group: "metrics.k8s.io", version: "v1beta1", resource: "nodes", kind: "NodeMetrics", namespaced: false, verbs: ["get", "list"] },
  { group: "metrics.k8s.io", version: "v1beta1", resource: "pods", kind: "PodMetrics", namespaced: true, verbs: ["get", "list"] },
];

type Stream = { token: string; resource: string; namespace?: string; label?: string; field?: string; push: (line: string) => void; close: () => void };
type LogStream = { token: string; key: string; push: (line: string) => void; raw: (text: string) => void; close: () => void };

const status = (code: number, message: string) => new Response(JSON.stringify({ kind: "Status", apiVersion: "v1", status: "Failure", code, message }), { status: code, headers: { "content-type": "application/json" } });

/** `a=b,c!=d` and `in (x, y)` enough for the tests. */
function selects(sel: string | null, labels: Record<string, string> = {}): boolean {
  if (!sel) return true;
  for (const part of sel.split(/,(?![^(]*\))/)) {
    const p = part.trim();
    let m: RegExpExecArray | null;
    if ((m = /^([^!=\s]+)\s+in\s+\(([^)]*)\)$/.exec(p))) {
      if (!m[2]!.split(",").map((x) => x.trim()).includes(labels[m[1]!] ?? "\u0000")) return false;
    } else if ((m = /^([^!=]+)!=(.*)$/.exec(p))) {
      if (labels[m[1]!] === m[2]) return false;
    } else if ((m = /^([^!=]+)==?(.*)$/.exec(p))) {
      if (labels[m[1]!] !== m[2]) return false;
    } else if ((m = /^!(.+)$/.exec(p))) {
      if (m[1]! in labels) return false;
    }
  }
  return true;
}
const fieldOk = (sel: string | null, o: any) => {
  if (!sel) return true;
  return sel.split(",").every((p) => {
    const [k, v] = p.split("=");
    const val = k!.split(".").reduce((x: any, s) => x?.[s], o);
    return String(val) === v;
  });
};

export class FakeFrontDoor {
  readonly grants = new Map<string, TokenGrant>();
  readonly revoked: string[] = [];
  readonly issued: TokenGrant[] = [];
  private n = 0;
  constructor(private readonly api: FakeApi) {}
  issueToken(g: TokenGrant): string {
    const t = `tok${++this.n}`;
    this.grants.set(t, g);
    this.issued.push(g);
    return t;
  }
  revokeToken(t: string) {
    const g = this.grants.get(t);
    this.grants.delete(t);
    if (g) this.revoked.push(g.label);
    this.api.closeToken(t);
  }
  clusterUrl(handle: string) {
    return `https://127.0.0.1:1/c/${handle}`;
  }
  get certificate() {
    return "";
  }
}

export class FakeApi {
  readonly store = new Map<string, KubeObject[]>();
  readonly seen: Seen[] = [];
  readonly door: FakeFrontDoor = new FakeFrontDoor(this);
  /** metrics-server's answers by path; absent: 404 (no metrics-server). */
  readonly metrics = new Map<string, unknown>();
  /** A request this answers instead (an RBAC 403, a 500). */
  refuse?: (path: string) => number | undefined;
  /** Hold every answer to a path that matches until released. */
  hold?: RegExp;
  /** The front door's scrub for a redacting token; off only to prove the runtime's own layer (departure 15). */
  scrubs = true;
  private held: (() => void)[] = [];
  private streams = new Set<Stream>();
  private logs = new Set<LogStream>();
  private logLines = new Map<string, string[]>();
  private rv = 100;
  private uid = 0;

  add(resource: string, o: { metadata: { name: string; namespace?: string; [k: string]: unknown }; [k: string]: unknown }): KubeObject {
    const k = KINDS[resource]!;
    const obj = { apiVersion: k.group ? `${k.group}/${k.version}` : k.version, kind: k.kind, ...o, metadata: { creationTimestamp: "2026-11-16T10:00:00Z", ...o.metadata, uid: `u${++this.uid}`, resourceVersion: String(++this.rv) } } as KubeObject;
    const list = this.store.get(resource) ?? [];
    const i = list.findIndex((x) => x.metadata.name === obj.metadata.name && x.metadata.namespace === obj.metadata.namespace);
    const type = i >= 0 ? "MODIFIED" : "ADDED";
    if (i >= 0) obj.metadata.uid = list[i]!.metadata.uid;
    if (i >= 0) list[i] = obj;
    else list.push(obj);
    this.store.set(resource, list);
    this.emit(resource, type, obj);
    return obj;
  }

  remove(resource: string, namespace: string | undefined, name: string) {
    const list = this.store.get(resource) ?? [];
    const i = list.findIndex((x) => x.metadata.name === name && x.metadata.namespace === namespace);
    if (i < 0) return;
    const [o] = list.splice(i, 1);
    this.emit(resource, "DELETED", { ...o!, metadata: { ...o!.metadata, resourceVersion: String(++this.rv) } });
  }

  /** Raw text to every open follow of a container's log, chunk by chunk (a line may be split across two). */
  logChunks(namespace: string, pod: string, ...chunks: string[]) {
    const key = `${namespace}/${pod}`;
    for (const s of this.logs) if (s.key === key) for (const c of chunks) s.raw(c);
  }

  /** A container's log: lines now (and to every open follow). */
  log(namespace: string, pod: string, ...lines: string[]) {
    const key = `${namespace}/${pod}`;
    this.logLines.set(key, [...(this.logLines.get(key) ?? []), ...lines]);
    for (const s of this.logs) if (s.key === key) for (const l of lines) s.push(l);
  }

  release() {
    const h = this.held;
    this.held = [];
    for (const r of h) r();
  }

  get openWatches() {
    return this.streams.size;
  }
  get openLogs() {
    return this.logs.size;
  }

  closeToken(token: string) {
    for (const s of [...this.streams]) if (s.token === token) s.close();
    for (const s of [...this.logs]) if (s.token === token) s.close();
  }

  private emit(resource: string, type: string, o: KubeObject) {
    for (const s of this.streams) {
      if (s.resource !== resource) continue;
      if (s.namespace && o.metadata.namespace !== s.namespace) continue;
      if (!selects(s.label ?? null, o.metadata.labels) || !fieldOk(s.field ?? null, o)) continue;
      s.push(JSON.stringify({ type, object: o }));
    }
  }

  client(token: string): KubeClient {
    return new KubeClient({ url: "https://127.0.0.1:1/c/handle-0001", secret: "" }, this.fetchFor(token));
  }

  fetchFor(token: string): typeof fetch {
    return (async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      const path = url.pathname.replace(/^\/c\/[^/]+/, "") + url.search;
      const method = init.method ?? "GET";
      const grant = this.door.grants.get(token);
      const record = (s: number) => this.seen.push({ label: grant?.label ?? "unknown", method, path, status: s });
      if (!grant) return (record(401), status(401, "Landlens: missing or unknown Landlens token"));
      const scopeOf = (k: string) => {
        const t = TYPES.find((x) => (x.group ? `${x.resource}.${x.group}` : x.resource) === k);
        return t?.namespaced;
      };
      const d = authorize(grant.policy, parseRequest(method, path), scopeOf);
      if (!d.allow) return (record(403), status(403, `Landlens: ${d.reason}`));
      const refused = this.refuse?.(path);
      if (refused) return (record(refused), status(refused, `${path} is forbidden: User "you" cannot list it`));
      record(200);
      if (this.hold?.test(path)) await new Promise<void>((r) => this.held.push(r));
      const res = this.answer(token, url, init.signal ?? undefined);
      return grant.policy.redact && this.scrubs ? scrubbed(res, url.searchParams.get("watch") === "1" || url.searchParams.get("follow") === "true") : res;
    }) as unknown as typeof fetch;
  }

  private answer(token: string, url: URL, signal?: AbortSignal): Response {
    const p = url.pathname.replace(/^\/c\/[^/]+/, "");
    const q = url.searchParams;
    if (p.startsWith("/apis/metrics.k8s.io/")) {
      const m = this.metrics.get(p);
      return m ? new Response(JSON.stringify(m), { headers: { "content-type": "application/json" } }) : status(404, "the server could not find the requested resource");
    }
    const parts = p.split("/").filter(Boolean);
    const at = parts[0] === "api" ? 2 : 3;
    let ns: string | undefined;
    let i = at;
    if (parts[i] === "namespaces" && parts.length > i + 2) {
      ns = parts[i + 1];
      i += 2;
    }
    const resource = parts[i]!;
    const name = parts[i + 1];
    const sub = parts[i + 2];
    if (!KINDS[resource]) return status(404, "the server could not find the requested resource");
    if (sub === "log") return this.logAnswer(token, `${ns}/${name}`, q, signal);
    const all = (this.store.get(resource) ?? []).filter((o) => !ns || o.metadata.namespace === ns);
    if (name) {
      const o = all.find((x) => x.metadata.name === name);
      return o ? new Response(JSON.stringify(o)) : status(404, `${resource} "${name}" not found`);
    }
    const items = all.filter((o) => selects(q.get("labelSelector"), o.metadata.labels) && fieldOk(q.get("fieldSelector"), o));
    if (q.get("watch") === "1") return this.watchAnswer(token, resource, ns, q, signal);
    const k = KINDS[resource]!;
    const limit = Number(q.get("limit") ?? 0) || items.length;
    const start = Number(q.get("continue") ?? 0);
    const page = items.slice(start, start + limit);
    const more = start + limit < items.length;
    return new Response(JSON.stringify({
      kind: `${k.kind}List`, apiVersion: k.group ? `${k.group}/${k.version}` : k.version,
      metadata: { resourceVersion: String(this.rv), ...(more ? { continue: String(start + limit) } : {}) },
      items: page.map(({ kind: _k, apiVersion: _a, ...rest }) => rest),
    }), { headers: { "content-type": "application/json" } });
  }

  private watchAnswer(token: string, resource: string, namespace: string | undefined, q: URLSearchParams, signal?: AbortSignal): Response {
    let s!: Stream;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        const enc = new TextEncoder();
        let open = true;
        s = {
          token, resource, ...(namespace ? { namespace } : {}), ...(q.get("labelSelector") ? { label: q.get("labelSelector")! } : {}), ...(q.get("fieldSelector") ? { field: q.get("fieldSelector")! } : {}),
          push: (line) => open && c.enqueue(enc.encode(line + "\n")),
          close: () => {
            if (!open) return;
            open = false;
            this.streams.delete(s);
            try {
              c.close();
            } catch {
              /* already closed */
            }
          },
        };
        this.streams.add(s);
        signal?.addEventListener("abort", () => {
          if (!open) return;
          open = false;
          this.streams.delete(s);
          c.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      },
    });
    return new Response(body, { headers: { "content-type": "application/json" } });
  }

  private logAnswer(token: string, key: string, q: URLSearchParams, signal?: AbortSignal): Response {
    const tail = Number(q.get("tailLines") ?? 1000);
    const now = (this.logLines.get(key) ?? []).slice(-tail);
    let s!: LogStream;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        const enc = new TextEncoder();
        let open = true;
        const ts = () => new Date(Date.now()).toISOString();
        for (const l of now) c.enqueue(enc.encode(`${ts()} ${l}\n`));
        if (q.get("follow") !== "true") return void c.close();
        s = {
          token, key,
          push: (l) => open && c.enqueue(enc.encode(`${ts()} ${l}\n`)),
          raw: (t) => open && c.enqueue(enc.encode(t)),
          close: () => {
            if (!open) return;
            open = false;
            this.logs.delete(s);
            c.close();
          },
        };
        this.logs.add(s);
        signal?.addEventListener("abort", () => {
          if (!open) return;
          open = false;
          this.logs.delete(s);
          c.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      },
    });
    return new Response(body, { headers: { "content-type": "text/plain" } });
  }
}

/** An answer as the front door gives it to a redacting token: JSON as objects, text as lines, streams line by line. */
async function scrubbed(res: Response, stream: boolean): Promise<Response> {
  if (!res.ok) return res;
  const text = /^text\/plain\b/.test(res.headers.get("content-type") ?? "");
  if (!stream) {
    const body = await res.text();
    return new Response(text ? scrubLines(body) : JSON.stringify(redactObject(JSON.parse(body))), { status: res.status, headers: res.headers });
  }
  const scrub = new LineScrubber();
  const batch = (lines: string[]) => (text ? scrub.push(lines) : lines.map((l) => (l.trim() ? JSON.stringify(redactObject(JSON.parse(l))) : l)));
  let pending = "";
  const lines = new TransformStream<string, string>({
    transform(chunk, c) {
      pending += chunk;
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      if (parts.length) c.enqueue(batch(parts).join("\n") + "\n");
    },
    flush(c) {
      const out = [...batch(pending ? [pending] : []), ...(text ? scrub.end() : [])];
      if (out.length) c.enqueue(out.map((l, i) => (i < out.length - 1 || !pending ? `${l}\n` : l)).join(""));
    },
  });
  const body = res.body!.pipeThrough(new TextDecoderStream()).pipeThrough(lines).pipeThrough(new TextEncoderStream());
  return new Response(body, { status: res.status, headers: res.headers });
}

/** The ClusterManager the runtime sees: one cluster, its discovery, and a way to make it go. */
export function fakeClusters(types: ResourceType[] = TYPES) {
  const gone: ((h: string, why: "disconnected" | "exited") => void)[] = [];
  let discoveries = 0;
  return {
    clusters: {
      get: (h: string) => {
        if (h !== "handle-0001") throw Object.assign(new Error("cluster is not connected"), { status: 404 });
        return { info: { handle: h, context: "orbstack", server: "https://127.0.0.1:6443", version: "v1.33.0" } } as never;
      },
      onGone: (fn: (h: string, why: "disconnected" | "exited") => void) => void gone.push(fn),
      discovery: async () => (discoveries++, types),
    },
    goneNow: (h = "handle-0001") => gone.forEach((f) => f(h, "disconnected")),
    get discoveries() {
      return discoveries;
    },
  };
}

/** Wait until `f` holds (real timers; the runtime's times are short in these tests). */
export async function until(f: () => boolean, what = "condition", ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

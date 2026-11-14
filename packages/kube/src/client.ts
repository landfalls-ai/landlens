// Talks to one cluster through its sidecar, from Electron main.
import type { KubeObject, ResourceRef } from "@landlens/contracts";
import { SIDECAR_HEADER, type Sidecar } from "./sidecar.js";

export class KubeError extends Error {
  constructor(public readonly status: number, message: string, public readonly reason?: string) {
    super(message);
  }
}

export type Fetch = typeof fetch;

export class KubeClient {
  constructor(private readonly sidecar: Pick<Sidecar, "url" | "secret">, private readonly fetchImpl: Fetch = fetch) {}

  /** Raw request; the path is an API server path such as /api/v1/pods. */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set(SIDECAR_HEADER, this.sidecar.secret);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    return this.fetchImpl(this.sidecar.url + path, { ...init, headers });
  }

  async json<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(path, init);
    const text = await res.text();
    if (!res.ok) throw toKubeError(res.status, text);
    return JSON.parse(text) as T;
  }

  async post<T = any>(path: string, body: unknown): Promise<T> {
    return this.json<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }
}

export function toKubeError(status: number, body: string): KubeError {
  try {
    const s = JSON.parse(body);
    if (s?.kind === "Status") return new KubeError(status, s.message ?? `HTTP ${status}`, s.reason);
  } catch {
    /* not JSON */
  }
  return new KubeError(status, body.trim().slice(0, 300) || `HTTP ${status}`);
}

/** The API path for a kind, optionally in a namespace and for one object. */
export function apiPath(t: { group: string; version: string; resource: string }, namespace?: string, name?: string) {
  const base = t.group ? `/apis/${t.group}/${t.version}` : `/api/${t.version}`;
  const ns = namespace ? `/namespaces/${encodeURIComponent(namespace)}` : "";
  const n = name ? `/${encodeURIComponent(name)}` : "";
  return `${base}${ns}/${t.resource}${n}`;
}

export const refPath = (r: ResourceRef) => apiPath(r, r.namespace, r.name);

/** Drop what nobody reads and what bloats IPC: managedFields. */
export function slim<T extends KubeObject>(o: T): T {
  if (!o?.metadata || !("managedFields" in o.metadata)) return o;
  const { managedFields: _drop, ...metadata } = o.metadata as KubeObject["metadata"] & { managedFields?: unknown };
  return { ...o, metadata };
}

/**
 * Secret values never leave main. Keys stay (so the UI can list them) with the value's byte length instead of the
 * value; the last-applied annotation, which holds the values in clear, is dropped.
 */
export function withoutSecretValues<T extends KubeObject>(o: T): T {
  // Lists and watches fill in kind (watch.ts withKind), so kind is always set here.
  if (o?.kind !== "Secret") return o;
  const lengths = (m: unknown) =>
    m && typeof m === "object"
      ? Object.fromEntries(Object.entries(m as Record<string, string>).map(([k, v]) => [k, `<${Buffer.from(String(v), "base64").length} bytes>`]))
      : m;
  const { data, stringData, ...rest } = o as T & { data?: unknown; stringData?: unknown };
  const annotations = { ...(o.metadata.annotations ?? {}) };
  delete annotations["kubectl.kubernetes.io/last-applied-configuration"];
  return {
    ...rest,
    metadata: { ...o.metadata, annotations },
    ...(data !== undefined ? { data: lengths(data) } : {}),
    ...(stringData !== undefined ? { stringData: lengths(stringData) } : {}),
  } as T;
}

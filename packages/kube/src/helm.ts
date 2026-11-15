// Helm releases, read-only (wave 4, part 4; D42–D43). No helm binary: a release is a Secret of type
// helm.sh/release.v1 labelled owner=helm, whose `release` key holds base64(gzip(JSON)) (Helm 3 and 4 alike). Main
// reads them as you through the sidecar, decodes them, and hands the window only what it may show: values that look
// secret are hidden, and Secrets in the manifest keep their keys and lose their values, as everywhere in Landlens.
import { gunzipSync } from "node:zlib";
import { isMap, isScalar, parseAllDocuments, stringify } from "yaml";
import type { HelmHistoryEntry, HelmObjectRef, HelmRelease, HelmReleaseDetail } from "@landlens/contracts";
import { apiPath, KubeError, type KubeClient } from "./client.js";
import { redactText } from "./redact.js";

/** A decoded release past this many bytes is refused (a gzip bomb, or a release no window should load). */
export const MAX_DECODED = 16 * 1024 * 1024;
const MAX_RELEASES = 500;
const MAX_HISTORY = 10;
const MAX_MANIFEST = 2 * 1024 * 1024;
const MAX_NOTES = 20_000;
const META = "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json;q=0.9";
const SECRETS = { group: "", version: "v1", resource: "secrets" };

type Meta = { name: string; namespace: string; labels: Record<string, string> };
/** The parts of Helm's release JSON that Landlens reads. */
type Raw = {
  name?: string; namespace?: string; version?: number;
  info?: { status?: string; description?: string; notes?: string; first_deployed?: string; last_deployed?: string };
  chart?: { metadata?: { name?: string; version?: string; appVersion?: string; description?: string }; values?: unknown };
  config?: unknown;
  manifest?: string;
};

/** The release Secrets' metadata (no data), in a namespace or everywhere, for one release name or all. */
async function metas(client: KubeClient, namespace?: string, name?: string, signal?: AbortSignal): Promise<Meta[]> {
  const q = new URLSearchParams({ labelSelector: `owner=helm${name ? `,name=${name}` : ""}`, fieldSelector: "type=helm.sh/release.v1" });
  const list = await client.json(`${apiPath(SECRETS, namespace)}?${q}`, { headers: { Accept: META }, ...(signal ? { signal } : {}) });
  return ((list?.items ?? []) as { metadata?: { name?: string; namespace?: string; labels?: Record<string, string> } }[])
    .map((i) => ({ name: i.metadata?.name ?? "", namespace: i.metadata?.namespace ?? "", labels: i.metadata?.labels ?? {} }))
    .filter((m) => m.name && m.namespace && m.labels.name && Number.isInteger(Number(m.labels.version)));
}

/** Decode one release Secret's `release` value: base64 (the API's), then Helm's base64, then gzip when it is gzip. */
export function decodeRelease(data: string): Raw {
  const inner = Buffer.from(data, "base64").toString("latin1");
  let bytes = Buffer.from(inner, "base64");
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      bytes = gunzipSync(bytes, { maxOutputLength: MAX_DECODED });
    } catch (e) {
      throw new KubeError(422, (e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? `a release over ${MAX_DECODED / 1024 / 1024} MB` : "a release Landlens can't decode");
    }
  } else if (bytes.length > MAX_DECODED) throw new KubeError(422, `a release over ${MAX_DECODED / 1024 / 1024} MB`);
  try {
    return JSON.parse(bytes.toString("utf8")) as Raw;
  } catch {
    throw new KubeError(422, "a release Landlens can't decode");
  }
}

async function readRelease(client: KubeClient, m: Meta, signal?: AbortSignal): Promise<Raw> {
  const s = await client.json(apiPath(SECRETS, m.namespace, m.name), signal ? { signal } : {});
  const data = s?.data?.release;
  if (typeof data !== "string") throw new KubeError(422, `${m.name} has no release`);
  return decodeRelease(data);
}

const str = (v: unknown, max = 300) => (typeof v === "string" ? v.slice(0, max) : "");

function summary(m: Meta, r: Raw): HelmRelease {
  const meta = r.chart?.metadata ?? {};
  const updated = str(r.info?.last_deployed) || (m.labels.modifiedAt ? new Date(Number(m.labels.modifiedAt) * 1000).toISOString() : "");
  return {
    name: m.labels.name!, namespace: m.namespace, revision: Number(m.labels.version),
    status: str(r.info?.status) || m.labels.status || "unknown",
    chart: str(meta.name, 253), chartVersion: str(meta.version, 128), appVersion: str(meta.appVersion, 128),
    ...(updated ? { updated } : {}),
  };
}

/** Run at most `n` at a time. */
async function pool<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]!);
    }
  }));
  return out;
}

/** The latest revision of each release, as `helm list -a` would show it. */
export async function listReleases(client: KubeClient, namespace?: string): Promise<{ releases: HelmRelease[]; unreadable: number }> {
  const latest = new Map<string, Meta>();
  for (const m of await metas(client, namespace)) {
    const k = `${m.namespace}/${m.labels.name}`;
    const cur = latest.get(k);
    if (!cur || Number(m.labels.version) > Number(cur.labels.version)) latest.set(k, m);
  }
  const chosen = [...latest.values()].slice(0, MAX_RELEASES);
  let unreadable = 0;
  const releases = await pool(chosen, 8, async (m) => {
    try {
      return summary(m, await readRelease(client, m, AbortSignal.timeout(15_000)));
    } catch {
      unreadable++;
      return { name: m.labels.name!, namespace: m.namespace, revision: Number(m.labels.version), status: m.labels.status || "unknown", chart: "", chartVersion: "", appVersion: "" };
    }
  });
  releases.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
  return { releases, unreadable };
}

/** One release at a revision (the latest by default): facts, notes, values, manifest and history, for the window. */
export async function getRelease(client: KubeClient, namespace: string, name: string, revision?: number): Promise<HelmReleaseDetail> {
  const all = (await metas(client, namespace, name)).filter((m) => m.labels.name === name).sort((a, b) => Number(b.labels.version) - Number(a.labels.version));
  if (!all.length) throw new KubeError(404, `no Helm release ${name} in ${namespace}`);
  const m = revision === undefined ? all[0]! : all.find((x) => Number(x.labels.version) === revision);
  if (!m) throw new KubeError(404, `${name} has no revision ${revision}`);
  const r = await readRelease(client, m);
  const user = hideSecrets(r.config ?? {});
  const merged = hideSecrets(coalesce(r.chart?.values ?? {}, r.config ?? {}));
  const manifest = typeof r.manifest === "string" ? r.manifest : "";
  const shown = manifest.length > MAX_MANIFEST ? manifest.slice(0, MAX_MANIFEST) : manifest;
  const { text, objects, hidden } = manifestForWindow(shown, namespace);
  const history: HelmHistoryEntry[] = await pool(all.slice(0, MAX_HISTORY), 4, async (h) => {
    const base = { revision: Number(h.labels.version), status: h.labels.status || "unknown" };
    try {
      const hr = h === m ? r : await readRelease(client, h, AbortSignal.timeout(15_000));
      const s = summary(h, hr);
      return { ...base, status: s.status, chart: s.chart, chartVersion: s.chartVersion, appVersion: s.appVersion, ...(s.updated ? { updated: s.updated } : {}), description: str(hr.info?.description) };
    } catch {
      return { ...base, chart: "", chartVersion: "", appVersion: "", description: "" };
    }
  });
  return {
    release: summary(m, r),
    latest: Number(all[0]!.labels.version),
    description: str(r.info?.description),
    ...(r.info?.first_deployed ? { firstDeployed: str(r.info.first_deployed) } : {}),
    notes: str(r.info?.notes, MAX_NOTES),
    chartDescription: str(r.chart?.metadata?.description, 1000),
    values: { user: toYaml(user.value), all: toYaml(merged.value) },
    hidden: { user: user.hidden, all: merged.hidden },
    manifest: text,
    manifestCut: manifest.length > MAX_MANIFEST,
    manifestHidden: hidden,
    objects,
    history,
  };
}

const toYaml = (v: unknown) => {
  if (v && typeof v === "object" && !Object.keys(v).length) return "";
  return stringify(v, { lineWidth: 0 });
};

/**
 * Helm's coalescing, enough for showing values: the user's values over the chart's, maps merged key by key, a null
 * removing the chart's key, anything else replacing it.
 */
export function coalesce(chart: unknown, user: unknown): unknown {
  if (!isPlain(chart) || !isPlain(user)) return user === undefined ? chart : user;
  const out: Record<string, unknown> = { ...chart };
  for (const [k, v] of Object.entries(user)) {
    if (k === "__proto__") continue;
    if (v === null) delete out[k];
    else out[k] = isPlain(v) && isPlain(out[k]) ? coalesce(out[k], v) : v;
  }
  return out;
}
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Keys whose values are secrets by name (a key ending in password, secret, token, apiKey, …). */
const SENSITIVE = /(password|passwd|passphrase|pwd|secret|token|apikey|accesskey|secretkey|privatekey|credential|credentials|dsn|connectionstring|webhookurl|licensekey)$/;
/** …except names of things that hold secrets, which are not secrets: `existingSecret`, `secretName`, `tokenRef`. */
const POINTER = /^(existing|use|create|enable|enabled)|(name|names|ref|key|keys|path|file|enabled|ttl|length|mount)$/;

export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_.]/g, "");
  if (!SENSITIVE.test(k)) return false;
  // `secretKey` (an S3 secret) is a secret, `apiKey` too; `secretKeyRef`, `tokenKey` (a key name) are pointers.
  if (/^(secretkey|apikey|accesskey|privatekey|licensekey)$/.test(k) || /(secretkey|apikey|accesskey|privatekey|licensekey)$/.test(k)) return !/^(existing|use)/.test(k);
  return !POINTER.test(k);
}

/** Values for the window: secret-looking keys' values hidden (with their size), credential-shaped text scrubbed. */
export function hideSecrets(input: unknown): { value: unknown; hidden: number } {
  let hidden = 0;
  const walk = (v: unknown, key?: string): unknown => {
    if (key !== undefined && isSensitiveKey(key) && (typeof v === "string" || typeof v === "number")) {
      const s = String(v);
      if (!s) return s;
      hidden++;
      return `<hidden · ${s.length} characters>`;
    }
    if (typeof v === "string") {
      const r = redactText(v);
      if (r !== v) hidden++;
      return r;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (isPlain(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (k !== "__proto__") out[k] = walk(x, k);
      return out;
    }
    return v;
  };
  return { value: walk(input), hidden };
}

/**
 * The manifest as the window may see it: each Secret's data and stringData values replaced by their size (the
 * comments and order kept), and the objects it makes, for links.
 */
export function manifestForWindow(manifest: string, namespace: string): { text: string; objects: HelmObjectRef[]; hidden: number } {
  const objects: HelmObjectRef[] = [];
  let hidden = 0;
  const parts: string[] = [];
  for (const doc of parseAllDocuments(manifest)) {
    if (!("contents" in doc) || doc.errors.length) {
      // Not YAML Landlens can read: shown without its values, so nothing a Secret held can slip through.
      parts.push("# (a document Landlens couldn't read is not shown)\n");
      continue;
    }
    const kind = doc.get("kind");
    const name = doc.getIn(["metadata", "name"]);
    if (typeof kind === "string" && typeof name === "string") {
      const ns = doc.getIn(["metadata", "namespace"]);
      objects.push({ kind, name, ...(typeof doc.get("apiVersion") === "string" ? { apiVersion: doc.get("apiVersion") as string } : {}), ...(typeof ns === "string" ? { namespace: ns } : { namespace }) });
    }
    if (kind === "Secret") {
      for (const f of ["data", "stringData"]) {
        const m = doc.get(f, true);
        if (!isMap(m)) {
          if (m !== undefined) (doc.set(f, "<hidden>"), hidden++);
          continue;
        }
        for (const item of m.items) {
          const v = isScalar(item.value) ? String(item.value.value ?? "") : "";
          item.value = doc.createNode(`<hidden · ${v.length} ${f === "data" ? "base64 characters" : "characters"}>`);
          hidden++;
        }
      }
    }
    parts.push(doc.toString({ lineWidth: 0 }));
  }
  // Each document keeps its own `---` when it had one; one is added where it didn't.
  const text = parts.map((p, i) => (i && !p.startsWith("---") ? `---\n${p}` : p)).join("");
  return { text, objects: objects.slice(0, 500), hidden };
}

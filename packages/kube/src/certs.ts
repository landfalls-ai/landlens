// Certificates in TLS Secrets (wave 5, D54): main reads a kubernetes.io/tls Secret as you and keeps only the dates and
// names of the certificates in `tls.crt`. The key, the PEM and every other value of the Secret are never decoded,
// copied, cached or passed on; the window and the agent get a CertFact.
import { X509Certificate } from "node:crypto";
import type { CertDetail, CertFact } from "@landlens/contracts";
import { apiPath, KubeError, type KubeClient } from "./client.js";
import type { CertInput } from "./doctor.js";

export const CERT_LIMITS = { pemBytes: 256 * 1024, certs: 8, sans: 20, text: 253 } as const;

const clean = (s: string) => s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim().slice(0, CERT_LIMITS.text);
/** The CN of an X.509 name ("CN=shop.example\nO=…"), else the whole name. */
const cn = (name: string) => clean(/(?:^|\n)CN=([^\n]*)/.exec(name)?.[1] ?? name);

/** PEM certificate blocks, found with indexOf (a regex over 256 KiB of repeated BEGIN lines is quadratic). */
export function pemBlocks(pem: string, max: number): string[] {
  const BEGIN = "-----BEGIN CERTIFICATE-----";
  const END = "-----END CERTIFICATE-----";
  const out: string[] = [];
  let at = 0;
  while (out.length < max) {
    const b = pem.indexOf(BEGIN, at);
    if (b < 0) break;
    const e = pem.indexOf(END, b + BEGIN.length);
    if (e < 0) break;
    out.push(pem.slice(b, e + END.length));
    at = e + END.length;
  }
  return out;
}

/**
 * Node's subjectAltName text: `DNS:a, DNS:"b,c", IP Address:10.0.0.1`; quoted values are JSON strings. Read entry by
 * entry from the start, so a value can't smuggle in another entry (`URI:http://x/DNS:bank.example`, or a quoted
 * `URI:"http://x, DNS:bank.example"`: part 2 review, finding 9). Linear: sticky patterns, no backtracking across entries.
 */
export function parseSans(s: string): string[] {
  const out: string[] = [];
  const TYPE = /([A-Za-z][A-Za-z ]{0,30}):/y;
  const QUOTED = /"(?:[^"\\]|\\.)*"/y;
  let i = 0;
  while (i < s.length && out.length < CERT_LIMITS.sans) {
    TYPE.lastIndex = i;
    const t = TYPE.exec(s);
    if (!t) break;
    i = TYPE.lastIndex;
    let v: string | undefined;
    if (s[i] === '"') {
      QUOTED.lastIndex = i;
      const q = QUOTED.exec(s);
      if (!q) break;
      i = QUOTED.lastIndex;
      try {
        v = JSON.parse(q[0]);
      } catch {
        v = undefined;
      }
    } else {
      const j = s.indexOf(", ", i);
      v = s.slice(i, j < 0 ? s.length : j);
      i = j < 0 ? s.length : j;
    }
    if ((t[1] === "DNS" || t[1] === "IP Address") && typeof v === "string" && v.trim()) out.push(v.trim());
    if (s.startsWith(", ", i)) i += 2;
    else break;
  }
  return out;
}

const UNREADABLE: CertFact = { notBefore: "", notAfter: "", which: "leaf", subject: "", issuer: "", sans: [], selfSigned: false, unreadable: true };

/** The certificate facts of a TLS Secret; nothing of the Secret's content when it can't be read. */
export function certFacts(secret: { data?: Record<string, unknown> } | undefined): CertFact {
  const b64 = secret?.data?.["tls.crt"];
  if (typeof b64 !== "string" || !b64 || b64.length > Math.ceil((CERT_LIMITS.pemBytes * 4) / 3) + 4) return UNREADABLE;
  let pem: string;
  try {
    pem = Buffer.from(b64, "base64").toString("latin1");
  } catch {
    return UNREADABLE;
  }
  const blocks = pemBlocks(pem, CERT_LIMITS.certs);
  if (!blocks.length) return UNREADABLE;
  const certs: X509Certificate[] = [];
  for (const b of blocks.slice(0, CERT_LIMITS.certs)) {
    try {
      certs.push(new X509Certificate(b));
    } catch {
      return UNREADABLE;
    }
  }
  const leaf = certs[0]!;
  const after = (c: X509Certificate) => Date.parse(c.validTo);
  // A self-signed root in the chain is the client's to trust or not (its own store decides), so its date isn't the
  // Secret's problem; the leaf's and the intermediates' are (security review, wave 5 part 1, finding 7).
  const earliest = certs.reduce((a, c) => (c !== leaf && c.subject === c.issuer ? a : after(c) < after(a) ? c : a), leaf);
  const notBefore = Date.parse(leaf.validFrom);
  const notAfter = after(earliest);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) return UNREADABLE;
  const sans = parseSans(leaf.subjectAltName ?? "").slice(0, CERT_LIMITS.sans).map(clean);
  return {
    notBefore: new Date(notBefore).toISOString(),
    notAfter: new Date(notAfter).toISOString(),
    which: earliest === leaf ? "leaf" : "chain",
    subject: cn(leaf.subject),
    issuer: cn(leaf.issuer),
    sans,
    selfSigned: leaf.subject === leaf.issuer,
  };
}

/**
 * The certificate panel (wave 8 part 4, D167): the only keys read, the public halves. `tls.key`, and every other key,
 * is never decoded, parsed or matched against a certificate: the private half never reaches this code's logic.
 */
export const CERT_KEYS = ["tls.crt", "ca.crt"] as const;
export const CERT_DETAIL_LIMITS = { keyBytes: 256 * 1024, perKey: 8, total: 16 } as const;

const hexOnly = (s: string, max: number) => (/^[0-9A-Fa-f:]*$/.test(s) ? s.replace(/:/g, "").toLowerCase().slice(0, max) : "");
const iso = (s: string) => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
};
const UNREADABLE_DETAIL = { subject: "", issuer: "", sans: [], notBefore: "", notAfter: "", serial: "", sha256: "", ca: false, selfSigned: false, unreadable: true as const };

/** One PEM block as a CertDetail; a block X509Certificate can't read is `unreadable`, with nothing of its text. */
function certDetail(key: CertDetail["key"], index: number, block: string): CertDetail {
  try {
    const c = new X509Certificate(block);
    const k = c.publicKey;
    const t = k.asymmetricKeyType;
    const d = k.asymmetricKeyDetails ?? {};
    const publicKey: CertDetail["publicKey"] = t === "rsa" || t === "rsa-pss"
      ? { type: "rsa", ...(typeof d.modulusLength === "number" ? { bits: d.modulusLength } : {}) }
      : t === "ec" ? { type: "ec", ...(typeof d.namedCurve === "string" && /^[A-Za-z0-9-]{1,32}$/.test(d.namedCurve) ? { curve: d.namedCurve } : {}) }
      : t === "ed25519" ? { type: "ed25519", bits: 256 } : { type: "other" };
    const notBefore = iso(c.validFrom);
    const notAfter = iso(c.validTo);
    if (!notBefore || !notAfter) return { key, index, ...UNREADABLE_DETAIL, sans: [] };
    return {
      key, index,
      subject: cn(c.subject), issuer: cn(c.issuer),
      sans: parseSans(c.subjectAltName ?? "").slice(0, CERT_LIMITS.sans).map(clean),
      notBefore, notAfter,
      serial: hexOnly(c.serialNumber, 64),
      sha256: hexOnly(c.fingerprint256, 64),
      ca: c.ca,
      selfSigned: c.subject === c.issuer && c.checkIssued(c),
      publicKey,
    };
  } catch {
    return { key, index, ...UNREADABLE_DETAIL, sans: [] };
  }
}

/**
 * The certificates of a Secret, for the panel (D167): CERTIFICATE blocks in `tls.crt` and `ca.crt` only, at most 8 a
 * key and 16 in all, a key over 256 KiB not read. Nothing else of the Secret is looked at; `skipped` says what was
 * left out, in Landlens's words.
 */
export function certDetails(secret: { data?: Record<string, unknown> } | undefined): { certs: CertDetail[]; skipped?: string } {
  const certs: CertDetail[] = [];
  const skipped: string[] = [];
  for (const key of CERT_KEYS) {
    const b64 = secret?.data?.[key];
    if (typeof b64 !== "string" || !b64) continue;
    if (b64.length > Math.ceil((CERT_DETAIL_LIMITS.keyBytes * 4) / 3) + 4) {
      skipped.push(`${key} is over 256 KiB and wasn't read.`);
      continue;
    }
    const blocks = pemBlocks(Buffer.from(b64, "base64").toString("latin1"), CERT_DETAIL_LIMITS.perKey + 1);
    if (blocks.length > CERT_DETAIL_LIMITS.perKey) skipped.push(`${key} holds more than ${CERT_DETAIL_LIMITS.perKey} certificates: the first ${CERT_DETAIL_LIMITS.perKey} are shown.`);
    for (const [i, b] of blocks.slice(0, CERT_DETAIL_LIMITS.perKey).entries()) {
      if (certs.length >= CERT_DETAIL_LIMITS.total) {
        skipped.push(`More than ${CERT_DETAIL_LIMITS.total} certificates: the first ${CERT_DETAIL_LIMITS.total} are shown.`);
        break;
      }
      certs.push(certDetail(key, i, b));
    }
  }
  return { certs, ...(skipped.length ? { skipped: [...new Set(skipped)].join(" ") } : {}) };
}

const SECRETS = { group: "", version: "v1", resource: "secrets" };
const META = "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json;q=0.9";
/** TLS Secrets read per scope; more are left out and the result says so. */
export const MAX_TLS_SECRETS = 500;

/**
 * The scope's TLS Secrets' certificates, as the caller (D54): a metadata-only list (`type=kubernetes.io/tls`, at
 * most 500), then one capped GET for each Secret whose version isn't in `cache`. Only the CertFact is kept; a Secret
 * that can't be read is left out. Throws the list's error (403 when Secrets can't be listed).
 */
export async function readCerts(
  client: KubeClient, namespace: string | undefined, cache: Map<string, CertInput>, opts: { signal?: AbortSignal } = {},
): Promise<{ certs: CertInput[]; cut: boolean; failed: number }> {
  const q = new URLSearchParams({ fieldSelector: "type=kubernetes.io/tls", limit: String(MAX_TLS_SECRETS) });
  const { value: list } = await client.jsonText(`${apiPath(SECRETS, namespace)}?${q}`, { maxBytes: 8 * 1048576, headers: { Accept: META }, signal: AbortSignal.timeout(15_000) });
  const metas = ((list?.items ?? []) as { metadata?: { name?: string; namespace?: string; resourceVersion?: string } }[])
    .map((i) => ({ name: String(i.metadata?.name ?? ""), namespace: String(i.metadata?.namespace ?? ""), rv: String(i.metadata?.resourceVersion ?? "") }))
    .filter((m) => m.name && m.namespace)
    .slice(0, MAX_TLS_SECRETS);
  const key = (m: { name: string; namespace: string; rv: string }) => `${m.namespace}/${m.name}@${m.rv}`;
  const todo = metas.filter((m) => !cache.has(key(m)));
  let failed = 0;
  await pool(todo, 4, async (m) => {
    // A scope that stopped (idle, replaced, disconnected) reads no more (part 2 review, finding 7).
    if (opts.signal?.aborted) return void failed++;
    try {
      const secret = await client.jsonCapped(apiPath(SECRETS, m.namespace, m.name), { maxBytes: 1048576, timeoutMs: 10_000 });
      // The Secret goes out of scope here: only its certificate's dates and names are kept.
      cache.set(key(m), { namespace: m.namespace, name: m.name, fact: certFacts(secret) });
    } catch (e) {
      if (e instanceof KubeError && e.status === 413) cache.set(key(m), { namespace: m.namespace, name: m.name, fact: { ...UNREADABLE } });
      // Gone since the list (404) is simply gone; anything else (403, 429, a timeout) is a Secret left out, and said.
      else if (!(e instanceof KubeError && e.status === 404)) failed++;
    }
  });
  // The cache may be shared by a cluster's scopes: only this scope's namespace is pruned.
  const live = new Set(metas.map(key));
  for (const k of cache.keys()) if ((!namespace || k.startsWith(`${namespace}/`)) && !live.has(k)) cache.delete(k);
  return { certs: metas.map((m) => cache.get(key(m))).filter((c): c is CertInput => !!c), cut: !!list?.metadata?.continue, failed };
}

async function pool<T>(items: T[], n: number, f: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await f(items[next++]!);
  }));
}

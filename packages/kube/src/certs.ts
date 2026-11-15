// Certificates in TLS Secrets (wave 5, D54): main reads a kubernetes.io/tls Secret as you and keeps only the dates and
// names of the certificates in `tls.crt`. The key, the PEM and every other value of the Secret are never decoded,
// copied, cached or passed on; the window and the agent get a CertFact.
import { X509Certificate } from "node:crypto";
import type { CertFact } from "@landlens/contracts";

export const CERT_LIMITS = { pemBytes: 256 * 1024, certs: 8, sans: 20, text: 253 } as const;

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim().slice(0, CERT_LIMITS.text);
/** The CN of an X.509 name ("CN=shop.example\nO=…"), else the whole name. */
const cn = (name: string) => clean(/(?:^|\n)CN=([^\n]*)/.exec(name)?.[1] ?? name);

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
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]{1,65536}?-----END CERTIFICATE-----/g) ?? [];
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
  const earliest = certs.reduce((a, c) => (after(c) < after(a) ? c : a), leaf);
  const notBefore = Date.parse(leaf.validFrom);
  const notAfter = after(earliest);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) return UNREADABLE;
  const sans = (leaf.subjectAltName ?? "")
    .split(/,\s*/)
    .map((x) => /^(?:DNS|IP Address):(.+)$/.exec(x.trim())?.[1])
    .filter((x): x is string => !!x)
    .slice(0, CERT_LIMITS.sans)
    .map(clean);
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

// GKE clusters of a project, read-only (spec D87: at most 200 a project), and the kubeconfig that puts them in the
// catalog (D91). That kubeconfig is Landlens's own, in its data folder (folder 0700, file 0600): your ~/.kube/config is
// never read for it or written. It holds no token: each cluster's user is an exec plugin that asks gcloud for one, at
// an absolute path, for the account gcloud is signed in as, checks its shape and prints an ExecCredential. Only gcloud
// is needed (not gke-gcloud-auth-plugin); client-go runs the plugin again on a 401.
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import type { GkeCluster } from "@landlens/contracts";
import { stringify } from "yaml";
import { z } from "zod";
import { ACCOUNT_SHAPE } from "./auth.js";
import { clean, checkProject } from "./assets.js";
import type { GcpClient } from "./client.js";
import { GcpError, SENTENCES } from "./errors.js";

export const MAX_CLUSTERS = 200;

const str = z.string().max(100_000);
const ClustersPage = z.object({
  clusters: z.array(z.object({
    name: str,
    location: str.optional(),
    zone: str.optional(),
    status: str.optional(),
    currentMasterVersion: str.optional(),
    endpoint: str.optional(),
    masterAuth: z.object({ clusterCaCertificate: str.optional() }).passthrough().optional(),
    controlPlaneEndpointsConfig: z.object({ dnsEndpointConfig: z.object({ endpoint: str.optional() }).passthrough().optional() }).passthrough().optional(),
  }).passthrough()).optional(),
}).passthrough();

/** A GKE cluster name and location as Google names them (D173: the only shapes that reach a path). */
export const GKE_NAME = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
const NAME = GKE_NAME;
export const GKE_LOCATION = /^[a-z]+-[a-z]+\d+(-[a-z])?$/;
const LOCATION = GKE_LOCATION;

/** gcloud's own context name for a GKE cluster: gke_<project>_<location>_<name>. */
export const gkeContext = (project: string, location: string, name: string) => `gke_${project}_${location}_${name}`;
/** A GKE context name as gkeContext makes it (what cluster:connect takes for one). */
export const GKE_CONTEXT = /^gke_[a-z][a-z0-9-]{4,28}[a-z0-9]_[a-z]+-[a-z]+\d+(-[a-z])?_[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;

/** A control plane's address: an IPv4 address or a DNS name, and a port only if the answer gave one. */
const ENDPOINT = /^(?:(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?)+)(?::\d{1,5})?$/;
/** An IPv4 address written the one canonical way: four decimal parts, 0–255, no leading zeros. */
const DOTTED_QUAD = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
/**
 * The only DNS names Landlens connects to: GKE's DNS-based control plane endpoints, which Google serves under
 * gke.goog (gke-<id>-<project number>.<location>.gke.goog) with a certificate from a public CA.
 */
const GKE_DNS = /^(?:[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?\.)+gke\.goog$/;

/**
 * Whether a canonical IPv4 address may be a control plane's: never "this network" (0/8), loopback (127/8, unless
 * `allowLocal`), link-local (169.254/16, the metadata server), multicast or reserved (224/3). Private ranges (10/8,
 * 172.16/12, 192.168/16) and 100.64/10 are allowed: private clusters live there.
 */
function ipAllowed(ip: string, allowLocal: boolean): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  if (a === 0 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 127) return allowLocal;
  return true;
}

/**
 * A control plane address Landlens will put in its kubeconfig, or "" (the cluster then can't be opened). An IP must
 * be a canonical dotted quad: a last label that is all digits or 0x… in any other form (0x7f.0.0.1, 0127.0.0.1,
 * 2130706433) is refused, as Go's resolver would read it as an address (review of part 5, L1). A DNS name must be under
 * gke.goog; metadata.google.internal, *.internal, localtest.me and every other name are refused. Loopback (127/8)
 * only with `allowLocal` (the development fake, which points a cluster at OrbStack). The sidecar checks the
 * address it actually dials as well (--refuse-local).
 */
export function checkEndpoint(raw: string, allowLocal = false): string {
  const e = raw.trim().toLowerCase();
  if (!ENDPOINT.test(e) || e.length > 253) return "";
  const host = e.replace(/:\d+$/, "");
  const port = /:(\d+)$/.exec(e)?.[1];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535 || /^0\d/.test(port))) return "";
  const last = host.split(".").at(-1) ?? "";
  if (/^\d+$/.test(last) || /^0x/.test(last)) return DOTTED_QUAD.test(host) && ipAllowed(host, allowLocal) ? e : "";
  return GKE_DNS.test(host) ? e : "";
}

/** Whether an endpoint checkEndpoint passed is an IP address (its certificate is the cluster's own CA). */
export const isIpEndpoint = (endpoint: string) => DOTTED_QUAD.test(endpoint.replace(/:\d+$/, ""));

/** A cluster CA as Google gives it: base64 of a PEM certificate. */
const CA = /^[A-Za-z0-9+/=]{20,65536}$/;

/** The CA when it is base64 of one PEM certificate that parses and is a CA; otherwise undefined (review of part 5, L2). */
export function checkCa(ca: string | undefined): string | undefined {
  if (!ca || !CA.test(ca)) return undefined;
  const pem = Buffer.from(ca, "base64").toString("latin1");
  if (!pem.startsWith("-----BEGIN CERTIFICATE-----")) return undefined;
  try {
    return new X509Certificate(pem).ca ? ca : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A CA's fingerprint as landlens-kube-proxy reports the CA a context trusts (its Ready line, review of wave 9 part 1
 * M1): the hex SHA-256 of the DER bytes of every CERTIFICATE block of the PEM, in order. `ca` is base64 of the PEM, as
 * Google lists it (masterAuth.clusterCaCertificate) and as `certificate-authority-data` carries it.
 */
export function caFingerprint(ca: string): string {
  const pem = Buffer.from(ca, "base64").toString("latin1");
  const ders = [...pem.matchAll(/-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]*?)-----END CERTIFICATE-----/g)].map((m) => Buffer.from(m[1]!.replace(/\s+/g, ""), "base64"));
  return createHash("sha256").update(Buffer.concat(ders)).digest("hex");
}

/** A GKE cluster as main keeps it: what the page gets, and the CA the kubeconfig needs (base64 PEM; not sent on). */
export type GkeClusterFull = GkeCluster & { ca?: string };

/**
 * The project's GKE clusters, at most 200; a cluster whose name or location isn't GKE's shape is left out, and one
 * that can't be opened safely keeps an empty endpoint (listed, not openable). Which address (review of part 5, L2):
 * the IP endpoint only with a valid cluster CA, which then pins it; otherwise the DNS endpoint under gke.goog, which
 * Google serves with a public CA's certificate, so the system roots check it and no CA is written. An IP endpoint
 * without a valid CA is never used with the system roots.
 */
export async function listClusters(client: GcpClient, project: string, o: { allowLocal?: boolean } = {}): Promise<GkeClusterFull[]> {
  checkProject(project);
  const r = ClustersPage.safeParse(await client.get("container", `/v1/projects/${project}/locations/-/clusters`, {}, project));
  if (!r.success) throw new GcpError(200, SENTENCES.answer, "schema");
  const out: GkeClusterFull[] = [];
  for (const c of r.data.clusters ?? []) {
    const location = c.location ?? c.zone ?? "";
    if (!NAME.test(c.name) || !LOCATION.test(location)) continue;
    const ca = checkCa(c.masterAuth?.clusterCaCertificate);
    const ip = checkEndpoint(c.endpoint ?? "", o.allowLocal);
    const dns = checkEndpoint(c.controlPlaneEndpointsConfig?.dnsEndpointConfig?.endpoint ?? "", o.allowLocal);
    // An IP with its CA; else a gke.goog name with the system roots; else none.
    const endpoint = ip && ca ? ip : dns && !isIpEndpoint(dns) ? dns : "";
    out.push({
      project, location, name: c.name,
      status: clean(c.status ?? "STATUS_UNSPECIFIED", 40),
      version: clean(c.currentMasterVersion ?? "", 60),
      endpoint,
      context: gkeContext(project, location, c.name),
      ...(endpoint && endpoint === ip ? { ca } : {}),
    });
    if (out.length >= MAX_CLUSTERS) break;
  }
  return out;
}

/**
 * The exec plugin: `/bin/sh -c <this> landlens-gke <absolute gcloud> <account>`. It asks gcloud for an access token for
 * that account (no shell quoting of either: they are arguments), refuses anything not shaped like one, and prints an
 * ExecCredential. No expiry is given, so client-go keeps the token until the API server answers 401, then asks again.
 */
export const GKE_PLUGIN_SCRIPT =
  `t="$("$1" auth print-access-token --account="$2" 2>/dev/null)"; ` +
  `case "$t" in *[!A-Za-z0-9._-]*|"") echo "Landlens: gcloud gave no access token for $2. Run gcloud auth login." >&2; exit 1;; esac; ` +
  `if [ "\${#t}" -lt 20 ] || [ "\${#t}" -gt 4096 ]; then echo "Landlens: gcloud's access token isn't the expected shape." >&2; exit 1; fi; ` +
  `printf '{"apiVersion":"client.authentication.k8s.io/v1","kind":"ExecCredential","status":{"token":"%s"}}' "$t"`;

/**
 * Landlens's GKE kubeconfig: one cluster, user and context per cluster that has an address. No token is in it; each
 * user runs gcloud (an absolute path) for `account`.
 */
export function gkeKubeconfig(clusters: GkeClusterFull[], gcloud: string, account: string): string {
  if (!isAbsolute(gcloud)) throw new Error("gcloud must be an absolute path");
  if (!ACCOUNT_SHAPE.test(account)) throw new Error("not an account");
  // An IP endpoint is written only with its CA: never one the system roots would check (L2).
  const open = clusters.filter((c) => c.endpoint && GKE_CONTEXT.test(c.context) && (c.ca || !isIpEndpoint(c.endpoint)));
  return stringify({
    apiVersion: "v1",
    kind: "Config",
    preferences: {},
    clusters: open.map((c) => ({
      name: c.context,
      cluster: { server: `https://${c.endpoint}`, ...(c.ca ? { "certificate-authority-data": c.ca } : {}) },
    })),
    users: open.map((c) => ({
      name: c.context,
      user: {
        exec: {
          apiVersion: "client.authentication.k8s.io/v1",
          command: "/bin/sh",
          args: ["-c", GKE_PLUGIN_SCRIPT, "landlens-gke", gcloud, account],
          interactiveMode: "Never",
          provideClusterInfo: false,
        },
      },
    })),
    contexts: open.map((c) => ({ name: c.context, context: { cluster: c.context, user: c.context } })),
    "current-context": "",
  });
}

/** Write the kubeconfig in `dir` (made 0700) as `kubeconfig` (0600), through a temp file and a rename. Its path. */
export function writeGkeKubeconfig(dir: string, text: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, "kubeconfig");
  const tmp = join(dir, `.kubeconfig.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
  renameSync(tmp, file);
  return file;
}

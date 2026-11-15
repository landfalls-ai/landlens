// GKE clusters of a project, read-only (spec D87: at most 200 a project), and the kubeconfig that puts them in the
// catalog (D91). That kubeconfig is Landlens's own, in its data folder (folder 0700, file 0600): your ~/.kube/config is
// never read for it or written. It holds no token: each cluster's user is an exec plugin that asks gcloud for one, at
// an absolute path, for the account gcloud is signed in as, checks its shape and prints an ExecCredential. Only gcloud
// is needed (not gke-gcloud-auth-plugin); client-go runs the plugin again on a 401.
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
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

const NAME = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
const LOCATION = /^[a-z]+-[a-z]+\d+(-[a-z])?$/;

/** gcloud's own context name for a GKE cluster: gke_<project>_<location>_<name>. */
export const gkeContext = (project: string, location: string, name: string) => `gke_${project}_${location}_${name}`;
/** A GKE context name as gkeContext makes it (what cluster:connect takes for one). */
export const GKE_CONTEXT = /^gke_[a-z][a-z0-9-]{4,28}[a-z0-9]_[a-z]+-[a-z]+\d+(-[a-z])?_[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;

/** A control plane's address: an IPv4 address or a DNS name, and a port only if the answer gave one. */
const ENDPOINT = /^(?:(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?)+)(?::\d{1,5})?$/;
/** Addresses on this machine: only the development fake may name one (it points a cluster at OrbStack). */
const LOCAL_HOST = /^(?:127\.|localhost$|.*\.localhost$)/;
/** Never a cluster's: "this network" and link-local (the metadata server, 169.254.169.254). */
const NEVER_HOST = /^(?:0\.|169\.254\.)/;
/** A cluster CA as Google gives it: base64 of a PEM certificate. */
const CA = /^[A-Za-z0-9+/=]{20,65536}$/;

/**
 * A control plane address Landlens will put in its kubeconfig, or "" (the cluster then can't be opened). A loopback or
 * link-local address is refused unless `allowLocal` (the development fake, which points a cluster at OrbStack).
 */
export function checkEndpoint(raw: string, allowLocal = false): string {
  const e = raw.trim().toLowerCase();
  if (!ENDPOINT.test(e) || e.length > 253) return "";
  const host = e.replace(/:\d+$/, "");
  if (/^[\d.]+$/.test(host) && host.split(".").some((n) => Number(n) > 255)) return "";
  if (NEVER_HOST.test(host) || (LOCAL_HOST.test(host) && !allowLocal)) return "";
  const port = /:(\d+)$/.exec(e)?.[1];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return "";
  return e;
}

/** A GKE cluster as main keeps it: what the page gets, and the CA the kubeconfig needs (base64 PEM; not sent on). */
export type GkeClusterFull = GkeCluster & { ca?: string };

/**
 * The project's GKE clusters, at most 200; a cluster whose name or location isn't GKE's shape is left out, and one whose
 * address isn't an address keeps an empty endpoint (listed, not openable).
 */
export async function listClusters(client: GcpClient, project: string, o: { allowLocal?: boolean } = {}): Promise<GkeClusterFull[]> {
  checkProject(project);
  const r = ClustersPage.safeParse(await client.get("container", `/v1/projects/${project}/locations/-/clusters`, {}, project));
  if (!r.success) throw new GcpError(200, SENTENCES.answer, "schema");
  const out: GkeClusterFull[] = [];
  for (const c of r.data.clusters ?? []) {
    const location = c.location ?? c.zone ?? "";
    if (!NAME.test(c.name) || !LOCATION.test(location)) continue;
    // The IP endpoint, or the DNS endpoint when the cluster has only that.
    const endpoint = checkEndpoint(c.endpoint || c.controlPlaneEndpointsConfig?.dnsEndpointConfig?.endpoint || "", o.allowLocal);
    const ca = c.masterAuth?.clusterCaCertificate;
    out.push({
      project, location, name: c.name,
      status: clean(c.status ?? "STATUS_UNSPECIFIED", 40),
      version: clean(c.currentMasterVersion ?? "", 60),
      endpoint,
      context: gkeContext(project, location, c.name),
      ...(ca && CA.test(ca) && Buffer.from(ca, "base64").toString("latin1").startsWith("-----BEGIN CERTIFICATE-----") ? { ca } : {}),
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
  const open = clusters.filter((c) => c.endpoint && GKE_CONTEXT.test(c.context));
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

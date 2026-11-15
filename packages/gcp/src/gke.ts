// GKE clusters of a project, read-only (spec D87: at most 200 a project). Part 4 lists them for gcp:clusters; part 5
// writes the kubeconfig that puts them in the catalog (D91), under the context name made here.
import type { GkeCluster } from "@landlens/contracts";
import { z } from "zod";
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
    controlPlaneEndpointsConfig: z.object({ dnsEndpointConfig: z.object({ endpoint: str.optional() }).passthrough().optional() }).passthrough().optional(),
  }).passthrough()).optional(),
}).passthrough();

const NAME = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
const LOCATION = /^[a-z]+-[a-z]+\d+(-[a-z])?$/;

/** gcloud's own context name for a GKE cluster: gke_<project>_<location>_<name>. */
export const gkeContext = (project: string, location: string, name: string) => `gke_${project}_${location}_${name}`;

/** The project's GKE clusters, at most 200; a cluster whose name or location isn't GKE's shape is left out. */
export async function listClusters(client: GcpClient, project: string): Promise<GkeCluster[]> {
  checkProject(project);
  const r = ClustersPage.safeParse(await client.get("container", `/v1/projects/${project}/locations/-/clusters`, {}, project));
  if (!r.success) throw new GcpError(200, SENTENCES.answer, "schema");
  const out: GkeCluster[] = [];
  for (const c of r.data.clusters ?? []) {
    const location = c.location ?? c.zone ?? "";
    if (!NAME.test(c.name) || !LOCATION.test(location)) continue;
    // The IP endpoint, or the DNS endpoint when the cluster has only that.
    const endpoint = c.endpoint || c.controlPlaneEndpointsConfig?.dnsEndpointConfig?.endpoint || "";
    out.push({
      project, location, name: c.name,
      status: clean(c.status ?? "STATUS_UNSPECIFIED", 40),
      version: clean(c.currentMasterVersion ?? "", 60),
      endpoint: clean(endpoint, 253),
      context: gkeContext(project, location, c.name),
    });
    if (out.length >= MAX_CLUSTERS) break;
  }
  return out;
}

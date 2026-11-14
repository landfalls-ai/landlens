// The clusters the user has: the contexts in their kubeconfig files, read the way kubectl merges them (KUBECONFIG
// list, else ~/.kube/config; the first file to name a cluster, user or context wins; current-context from the first
// file that sets one). Only names and server URLs are read here: credentials are the sidecar's business.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { KubeContext } from "@landlens/contracts";
import { parse } from "yaml";

export function kubeconfigPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = env.KUBECONFIG?.split(delimiter).filter(Boolean);
  return list?.length ? list : [join(homedir(), ".kube", "config")];
}

export function listContexts(paths: string[] = kubeconfigPaths()): KubeContext[] {
  const clusters = new Map<string, string>();
  const contexts = new Map<string, { cluster: string; user: string; namespace?: string }>();
  let current: string | undefined;
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const doc = parse(readFileSync(p, "utf8")) ?? {};
    for (const c of doc.clusters ?? []) {
      if (c?.name && !clusters.has(c.name)) clusters.set(c.name, c.cluster?.server ?? "");
    }
    for (const c of doc.contexts ?? []) {
      if (c?.name && !contexts.has(c.name)) {
        contexts.set(c.name, {
          cluster: c.context?.cluster ?? "",
          user: c.context?.user ?? "",
          ...(c.context?.namespace ? { namespace: c.context.namespace } : {}),
        });
      }
    }
    current ??= doc["current-context"] || undefined;
  }
  return [...contexts].map(([name, c]) => ({
    name,
    cluster: c.cluster,
    user: c.user,
    server: clusters.get(c.cluster) ?? "",
    ...(c.namespace ? { namespace: c.namespace } : {}),
    current: name === current,
  }));
}

// One request series as you (wave 4's edits, wave 8's actions): a front-door token issued for it, labelled
// `you · <context> · <what>`, full access to that one cluster, revoked when the series ends. Every request is in the
// front door's audit trail under that label, and your RBAC decides.
import type { ClusterManager, FrontDoor, Send } from "@landlens/kube";
import { frontDoorSend } from "@landlens/kube-mcp";

export type AsYouDeps = {
  clusters: Pick<ClusterManager, "get">;
  frontDoor: Pick<FrontDoor, "issueToken" | "revokeToken" | "clusterUrl" | "certificate">;
};

export async function asYou<T>(d: AsYouDeps, handle: string, what: string, f: (send: Send) => Promise<T>): Promise<T> {
  const c = d.clusters.get(handle);
  const token = d.frontDoor.issueToken({ label: `you · ${c.info.context} · ${what}`, policy: { access: "full" }, clusters: [handle] });
  try {
    return await f(frontDoorSend({ url: d.frontDoor.clusterUrl(handle), certificate: d.frontDoor.certificate, token }));
  } finally {
    d.frontDoor.revokeToken(token);
  }
}

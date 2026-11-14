// What the user may do, asked of the API server (SelfSubjectAccessReview). Lens hides views the user can't list;
// so do we, and we say why instead of showing an empty table.
import type { AccessCheck } from "@landlens/contracts";
import type { KubeClient } from "./client.js";

export async function checkAccess(client: KubeClient, checks: AccessCheck[]): Promise<boolean[]> {
  return Promise.all(
    checks.map(async (c) => {
      try {
        const res = await client.post("/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", {
          apiVersion: "authorization.k8s.io/v1",
          kind: "SelfSubjectAccessReview",
          spec: {
            resourceAttributes: {
              verb: c.verb,
              group: c.group,
              resource: c.resource,
              ...(c.namespace ? { namespace: c.namespace } : {}),
            },
          },
        });
        return res?.status?.allowed === true;
      } catch {
        return false;
      }
    }),
  );
}

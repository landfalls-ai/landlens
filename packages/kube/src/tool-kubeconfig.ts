// The kubeconfig that kubectl, helm and the agent's Bash get: every cluster points at the front door, and the
// token comes from an environment variable through an exec credential plugin, so no file ever holds it
// (as Freelens does). Without the variable, kubectl fails to authenticate instead of falling back to anything.
import { stringify } from "yaml";

export const TOKEN_ENV = "LANDLENS_TOKEN";

export type ToolCluster = { handle: string; context: string; namespace?: string };

/** The exec plugin: prints an ExecCredential with the token from $LANDLENS_TOKEN (64 hex characters). */
const PLUGIN_SCRIPT =
  `t="\${${TOKEN_ENV}:-}"; case "$t" in *[!0-9a-f]*|"") echo "Landlens: ${TOKEN_ENV} is not set; open this terminal from Landlens" >&2; exit 1;; esac; ` +
  `printf '{"apiVersion":"client.authentication.k8s.io/v1","kind":"ExecCredential","status":{"token":"%s"}}' "$t"`;

export function toolKubeconfig(
  frontDoor: { url: string; certificate: string },
  clusters: ToolCluster[],
  current?: string,
): string {
  const user = "landlens";
  const doc = {
    apiVersion: "v1",
    kind: "Config",
    preferences: {},
    clusters: clusters.map((c) => ({
      name: c.context,
      cluster: {
        server: `${frontDoor.url}/c/${c.handle}`,
        "certificate-authority-data": Buffer.from(frontDoor.certificate).toString("base64"),
      },
    })),
    users: [
      {
        name: user,
        user: {
          exec: {
            apiVersion: "client.authentication.k8s.io/v1",
            command: "/bin/sh",
            args: ["-c", PLUGIN_SCRIPT],
            interactiveMode: "Never",
            provideClusterInfo: false,
          },
        },
      },
    ],
    contexts: clusters.map((c) => ({
      name: c.context,
      context: { cluster: c.context, user, ...(c.namespace ? { namespace: c.namespace } : {}) },
    })),
    "current-context": current ?? clusters[0]?.context ?? "",
  };
  return stringify(doc);
}

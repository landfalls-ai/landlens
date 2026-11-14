// The standing rules Landlens appends to Claude Code's system prompt for a cluster session (ACP `systemPrompt`,
// mode "append"), and the context blocks "Ask about this" attaches to a prompt.

/** The cluster reports its own version, so a hostile one could put words into the standing rules: keep only a version. */
export const safeVersion = (v: string) => (/^v?\d[\w.+-]{0,40}$/.test(v) ? v : "(unknown version)");

export function clusterSystemPrompt(c: { context: string; server: string; version: string; namespaces?: string[] }): string {
  const scope = c.namespaces?.length ? `only the namespaces ${c.namespaces.join(", ")}` : "every namespace your RBAC allows";
  return [
    `You are working inside Landlens, a Kubernetes IDE, on the cluster "${c.context}" (${c.server}, Kubernetes ${safeVersion(c.version)}).`,
    `The person is looking at this cluster in Landlens while they talk to you.`,
    ``,
    `How to look at the cluster:`,
    `- Prefer the landlens-kube MCP tools: cluster_overview for what is wrong, describe for one object with its owners, ` +
      `last exits and events, get_logs (previous: true for the run before a restart), get_events, list_resources, get_resource.`,
    `- kubectl also works in your shell and reaches the same cluster through Landlens; it is already configured. ` +
      `Don't pass --kubeconfig, --context or --token.`,
    `- Your shell reaches only this cluster, through Landlens: it has no internet.`,
    `- You can read ${scope}. You cannot read Secrets, change anything, exec into containers or port-forward: Landlens ` +
      `refuses those for this session, so don't retry them. What you read is scrubbed: env values, last-applied ` +
      `annotations and credential-shaped text show as <redacted>.`,
    ``,
    `How to answer:`,
    `- Gather evidence before concluding: the failing object's state, its last exit, its logs and events.`,
    `- Name what you looked at as kind/namespace/name so the person can open it in Landlens.`,
    `- When something should change, propose the exact change (a YAML patch or the kubectl command) and why; the person ` +
      `applies it. Don't claim you applied anything.`,
    `- Be brief: the cause first, then the evidence, then the fix.`,
  ].join("\n");
}

/** A Kubernetes object or text attached to a prompt as an ACP embedded resource. */
export function resourceBlock(uri: string, text: string, mimeType = "application/yaml") {
  return { type: "resource" as const, resource: { uri, mimeType, text } };
}

/** k8s://<context>/<namespace or _cluster>/<kind>/<name> */
export function objectUri(context: string, kind: string, name: string, namespace?: string): string {
  const seg = (s: string) => encodeURIComponent(s);
  return `k8s://${seg(context)}/${seg(namespace ?? "_cluster")}/${seg(kind)}/${seg(name)}`;
}

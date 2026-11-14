// The agent's write tools. None of them writes: each turns what the agent asks for into operations and hands them to
// Landlens's approval broker (main, @landlens/kube changes.ts), which dry-runs them on the API server, shows the
// person the diff and applies them only if the person approves. The tool call waits for that answer, and the agent
// reads what happened: applied, rejected (with the person's note), failed, or no answer.
//
// The agent's own token stays read-only, so these tools are the only way its changes reach a cluster.
import type { ResourceType } from "@landlens/contracts";
import type { ChangeOp, Outcome, PatchType, ProposedChange } from "@landlens/kube";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseAllDocuments } from "yaml";
import { z } from "zod";
import { resolveKind, type AgentCluster } from "./cluster.js";
import { redactText } from "./redact.js";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
type Extra = { _meta?: Record<string, unknown>; signal?: AbortSignal };

const CALL_META = "landlens/callId";
const CALL_ID = /^c[0-9a-z]{1,24}$/;

const Reason = z.string().min(1).max(2000).describe("Why: the evidence and what this change should fix. The person reads this beside the diff.");
const Name = z.string().min(1).max(253);
const Namespace = z.string().min(1).max(63);

const WRITE = { readOnlyHint: false, openWorldHint: false } as const;

const say = (text: string, isError = false): Result => ({ content: [{ type: "text", text: redactText(text) }], ...(isError ? { isError } : {}) });

/** What the agent reads back, phrased so it doesn't claim more than happened. */
export function outcomeText(o: Outcome): Result {
  switch (o.state) {
    case "applied":
      return say(`The person approved, and Landlens applied it: ${o.results.join("; ")}. Check the effect (describe, get_events, cluster_overview) before saying it worked.`);
    case "rejected":
      return say(`The person rejected this change; nothing was applied.${o.note ? ` Their note: "${o.note}"` : ""} Don't propose it again unchanged.`);
    case "expired":
      return say("Nobody answered within 15 minutes, so nothing was applied. Say what you proposed and stop; don't propose it again unless asked.");
    case "withdrawn":
      return say("The change was withdrawn before the person answered (the turn ended); nothing was applied.");
    case "failed":
      if (o.stage === "check") return say(`Landlens didn't propose this: ${o.error}`, true);
      if (o.stage === "dry-run") return say(`The API server's dry run refused this, so the person wasn't asked: ${o.error}`, true);
      return say(`The person approved, but applying failed: ${o.error}${o.applied?.length ? `. Already applied: ${o.applied.join("; ")}` : ""}`, true);
  }
}

const label = (t: Pick<ResourceType, "kind">, name: string, namespace?: string) => `${t.kind.toLowerCase()} ${namespace ? `${namespace}/` : ""}${name}`;

export function registerWriteTools(server: McpServer, cluster: AgentCluster) {
  const propose = cluster.propose;
  if (!propose) return;
  const limit = cluster.namespaces?.length ? ` This session may only change namespaces ${cluster.namespaces.join(", ")}.` : "";
  const how = " Landlens dry-runs it, shows the person the diff, and applies it only if they approve; this call waits for their answer." + limit;

  /** Run a write tool: build the change, then wait on the broker. */
  const run = <A>(build: (a: A, types: ResourceType[]) => Promise<Omit<ProposedChange, "call">> | Omit<ProposedChange, "call">) =>
    async (a: A, extra?: Extra): Promise<Result> => {
      let change: Omit<ProposedChange, "call">;
      try {
        change = await build(a, await cluster.types());
      } catch (err) {
        return say(`Landlens didn't propose this: ${err instanceof Error ? err.message : String(err)}`, true);
      }
      const id = extra?._meta?.[CALL_META];
      const call = typeof id === "string" && CALL_ID.test(id) ? id : undefined;
      try {
        return outcomeText(await propose({ ...change, ...(call ? { call } : {}) }, extra?.signal));
      } catch (err) {
        return say(`Landlens couldn't propose this: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    };

  const target = (types: ResourceType[], kind: string, name: string, namespace?: string) => {
    const t = resolveKind(types, kind);
    if (!t.verbs.includes("patch") && !t.verbs.includes("delete")) throw new Error(`${t.kind} can't be changed`);
    return { type: { group: t.group, version: t.version, resource: t.resource, kind: t.kind, namespaced: t.namespaced }, ...(t.namespaced ? { namespace: namespace ?? "" } : {}), name, t };
  };

  server.registerTool("apply_manifest", {
    title: "Apply a manifest",
    description: "Create or change objects from YAML (one or more documents, up to 10) with server-side apply: fields you name are set, others are kept. Never include values you saw as <redacted …>; leave those fields out." + how,
    inputSchema: { manifest: z.string().min(1).max(200_000).describe("YAML, documents separated by ---"), namespace: Namespace.optional().describe("For objects that don't name one"), reason: Reason },
    annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
  }, run(async (a: { manifest: string; namespace?: string; reason: string }, types) => {
    const docs = parseAllDocuments(a.manifest);
    const objects = docs.map((d) => {
      if (d.errors.length) throw new Error(`the YAML doesn't parse: ${d.errors[0]!.message}`);
      return d.toJSON();
    }).filter((o) => o != null);
    if (!objects.length) throw new Error("the manifest is empty");
    if (objects.length > 10) throw new Error("at most 10 objects in one change");
    const operations: ChangeOp[] = objects.map((o: any) => {
      if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("each document must be one object");
      if (o.kind === "List") throw new Error("send the items as separate documents, not a List");
      const [group, version] = String(o.apiVersion ?? "").includes("/") ? String(o.apiVersion).split("/") : ["", String(o.apiVersion ?? "")];
      const t = types.find((x) => x.group === group && x.kind === o.kind) ;
      if (!t) throw new Error(`this cluster doesn't serve ${o.apiVersion} ${o.kind}`);
      const name = o.metadata?.name;
      if (typeof name !== "string" || !name) throw new Error(`a ${o.kind} needs metadata.name`);
      const namespace = t.namespaced ? (o.metadata?.namespace ?? a.namespace) : undefined;
      if (t.namespaced && !namespace) throw new Error(`${o.kind} ${name} needs a namespace`);
      return {
        verb: "patch" as const, patchType: "apply" as const,
        type: { group: t.group, version: version!, resource: t.resource, kind: t.kind, namespaced: t.namespaced },
        ...(namespace ? { namespace } : {}), name, body: o,
      };
    });
    const what = operations.map((o) => label(o.type, o.name, o.namespace));
    return { tool: "apply_manifest", title: operations.length === 1 ? `Apply ${what[0]}` : `Apply ${operations.length} objects: ${what.join(", ")}`, reason: a.reason, operations };
  }));

  server.registerTool("patch", {
    title: "Patch an object",
    description: 'Change some fields of one object. type: "strategic" (default for built-in kinds; lists of containers merge by name), "merge" (RFC 7386; default for custom resources) or "json" (RFC 6902 operations).' + how,
    inputSchema: {
      kind: z.string().min(1).max(120), name: Name, namespace: Namespace.optional(),
      patch: z.union([z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown()))]).describe("The patch: an object, or for json a list of operations"),
      type: z.enum(["strategic", "merge", "json"]).optional(),
      reason: Reason,
    },
    annotations: { ...WRITE, destructiveHint: true, idempotentHint: false },
  }, run((a: { kind: string; name: string; namespace?: string; patch: unknown; type?: "strategic" | "merge" | "json"; reason: string }, types) => {
    const x = target(types, a.kind, a.name, a.namespace);
    const builtin = !x.t.group || !x.t.group.includes(".") || x.t.group.endsWith(".k8s.io");
    const patchType: PatchType = a.type ?? (builtin ? "strategic" : "merge");
    return { tool: "patch", title: `Patch ${label(x.t, a.name, x.namespace)}`, reason: a.reason, operations: [{ verb: "patch", patchType, type: x.type, ...(x.namespace ? { namespace: x.namespace } : {}), name: a.name, body: a.patch }] };
  }));

  server.registerTool("scale", {
    title: "Scale",
    description: "Set the replicas of a Deployment, StatefulSet or ReplicaSet." + how,
    inputSchema: { kind: z.enum(["deployment", "statefulset", "replicaset"]).optional(), name: Name, namespace: Namespace, replicas: z.number().int().min(0).max(1000), reason: Reason },
    annotations: { ...WRITE, destructiveHint: false, idempotentHint: true },
  }, run((a: { kind?: string; name: string; namespace: string; replicas: number; reason: string }, types) => {
    const x = target(types, `${a.kind ?? "deployment"}s.apps`, a.name, a.namespace);
    return { tool: "scale", title: `Scale ${label(x.t, a.name, a.namespace)} to ${a.replicas} replica${a.replicas === 1 ? "" : "s"}`, reason: a.reason, operations: [{ verb: "patch", patchType: "merge", type: x.type, namespace: a.namespace, name: a.name, body: { spec: { replicas: a.replicas } } }] };
  }));

  server.registerTool("rollout_restart", {
    title: "Restart a rollout",
    description: "Replace a Deployment's, StatefulSet's or DaemonSet's pods by stamping its pod template, as kubectl rollout restart does." + how,
    inputSchema: { kind: z.enum(["deployment", "statefulset", "daemonset"]).optional(), name: Name, namespace: Namespace, reason: Reason },
    annotations: { ...WRITE, destructiveHint: false, idempotentHint: false },
  }, run((a: { kind?: string; name: string; namespace: string; reason: string }, types) => {
    const x = target(types, `${a.kind ?? "deployment"}s.apps`, a.name, a.namespace);
    const body = { spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": new Date().toISOString() } } } } };
    return { tool: "rollout_restart", title: `Restart ${label(x.t, a.name, a.namespace)}`, reason: a.reason, operations: [{ verb: "patch", patchType: "strategic", type: x.type, namespace: a.namespace, name: a.name, body }] };
  }));

  server.registerTool("rollout_undo", {
    title: "Roll back a Deployment",
    description: "Set a Deployment's pod template back to an earlier revision's (rollout_history lists them), as kubectl rollout undo does." + how,
    inputSchema: { name: Name, namespace: Namespace, toRevision: z.number().int().min(1).optional().describe("Default: the revision before the current one"), reason: Reason },
    annotations: { ...WRITE, destructiveHint: false, idempotentHint: false },
  }, run((a: { name: string; namespace: string; toRevision?: number; reason: string }, types) => {
    const x = target(types, "deployments.apps", a.name, a.namespace);
    return {
      tool: "rollout_undo", title: `Roll back ${label(x.t, a.name, a.namespace)} to ${a.toRevision ? `revision ${a.toRevision}` : "the previous revision"}`, reason: a.reason,
      operations: [{ verb: "patch", patchType: "json", type: x.type, namespace: a.namespace, name: a.name, body: [], undo: a.toRevision ?? "previous" }],
    };
  }));

  server.registerTool("delete", {
    title: "Delete an object",
    description: "Delete one object (in the background; its dependents follow)." + how,
    inputSchema: { kind: z.string().min(1).max(120), name: Name, namespace: Namespace.optional(), reason: Reason },
    annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
  }, run((a: { kind: string; name: string; namespace?: string; reason: string }, types) => {
    const x = target(types, a.kind, a.name, a.namespace);
    return { tool: "delete", title: `Delete ${label(x.t, a.name, x.namespace)}`, reason: a.reason, operations: [{ verb: "delete", type: x.type, ...(x.namespace ? { namespace: x.namespace } : {}), name: a.name }] };
  }));
}

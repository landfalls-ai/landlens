# The agent

Landlens runs **your own Claude Code** beside the cluster you are looking at. Open the dock with **Ask Claude** (⌘J) in
the toolbar, on any object's details or on a problem in the Overview (both attach that object), and ask. Claude Code reads the cluster, shows
each thing it read as a card, and answers with the cause, the evidence and a proposed fix. In this wave it can only
read: no changes, no Secrets, no exec. Writes behind your approval are wave 3.

## What you see

| In the dock | Where it comes from (ACP) |
|---|---|
| The answer, streaming, in Markdown | `agent_message_chunk` |
| "Thinking", folded | `agent_thought_chunk` |
| A row per tool call, consecutive calls grouped in one list: what it is (for example `describe pod landlens-dev/orders-api-…` or `shell kubectl logs …`), its status as an icon, and, opened, what it ran and what came back with line numbers and error lines marked | `tool_call`, `tool_call_update` |
| The plan, as a checklist | `plan` |
| "Run a shell command?" with the command and Claude Code's own choices (Yes / Yes, and don't ask again for … / No); Enter picks the first, Esc rejects, when the composer is empty | `session/request_permission` |
| Mode (Manual or Plan) and model pickers, in the composer's foot | the session's modes and config options |
| Stop | `session/cancel` |

"Ask Claude" on an object attaches its YAML and its last 15 events to your message as an embedded resource
`k8s://<context>/<namespace>/<Kind>/<name>`, so the agent starts from what you are looking at. They are read with the
session's own token, so they are scrubbed and limited exactly as the agent's own reads are. Not offered on Secrets.

Links in an answer show their host beside the text, so a link can't hide where it goes.

The cluster view stays on screen while the dock is open: the clusters rail folds to its dots and the details drawer
narrows to make room.

## How it runs

- One Claude Code process for the window: Landlens starts `claude-agent-acp` (pinned, 0.107.0) with the `node` from
  your login shell's PATH and speaks ACP v1 to it over stdio. It uses your Claude Code login, and nothing else of
  your Claude Code: no settings, CLAUDE.md, skills, plugins, hooks or MCP servers. Those run outside the sandbox (an
  MCP server or a hook is a process of yours with your full environment), so one of them could read what the
  session can't. Its environment is an allowlist, not Landlens's own. Landlens offers it no file system and no
  terminals (the adapter doesn't use them).
- One session per dock: its own working folder under Landlens's app data, its own read-only front-door token, its
  own tool kubeconfig and its own MCP token. Closing the dock, disconnecting the cluster, reloading the window, or
  Claude Code exiting ends the session, revokes both tokens and removes the folder.
- Every session starts in **Manual** mode (`default`); bypass is disabled for the session. You can switch to Plan;
  main refuses any other mode.
- The standing rules (appended to Claude Code's system prompt) name the cluster, say what the session can and can't
  do, and ask for evidence first, objects named as kind/namespace/name, and proposed changes rather than claims.
  Code: `packages/acp-host/src/prompt.ts`.

## The cluster tools (`landlens-kube` MCP server)

A loopback HTTP MCP server in Landlens main; each session has its own bearer token, and every tool call goes through
the front door with that session's token, so the same policy and audit trail apply as to its kubectl.

| Tool | What it returns |
|---|---|
| `cluster_overview` | Problems first: crash-looping, image-pull, OOM-killed, pending and unready pods; deployments short of replicas; unready nodes; recent warning events |
| `describe` | One object with its state, owner chain up to the Deployment, each container's state, last exit, env names, probes and resources, and its events |
| `get_logs` | A container's log tail; `previous: true` for the run before the last restart |
| `get_events` | Recent events, newest first, for a namespace or one object, optionally warnings only |
| `list_resources` | One kind, printed like `kubectl get` (pods, deployments, nodes have status columns) |
| `get_resource` | One object as YAML |
| `api_resources` | The kinds the cluster serves |
| `top` | CPU and memory from metrics-server |
| `rollout_history` | A Deployment's ReplicaSets by revision, with images |

All are marked read-only, and Landlens pre-allows them (`mcp__landlens-kube`), so they don't prompt.

## What the agent sees

The front door scrubs every response to an agent token, so the MCP tools and the agent's own kubectl get the same
treatment (`packages/kube/src/redact.ts`): no `managedFields`, no `last-applied-configuration`, no env values, no
Secret data, credential-shaped strings replaced, strings capped at 4 KB. Objects, lists, tables and watch events are
scrubbed as objects, logs as text; a body it can't read (protobuf, compressed) is refused, not passed on. The MCP tools
also cap a result at 200 KB.

## The fence

Claude Code also has its own shell, and Landlens can't see inside it. So each session gets, through
`_meta.claudeCode.options` (`packages/acp-host/src/fence.ts`):

1. **Nothing of yours beside it.** No settings files, hooks, plugins or MCP servers (`settingSources: []`,
   `strictMcpConfig`), and only the built-in tools Bash, Read, Grep, Glob, TodoWrite and ExitPlanMode: no web, no edits.
2. **Its kubectl reaches only the front door.** `KUBECONFIG` is the session's tool kubeconfig (read-only): the front
   door with its CA pinned, and an exec plugin that reads the session token from `LANDLENS_TOKEN`.
3. **Its shell runs in Claude Code's sandbox** (macOS Seatbelt): it can read nothing in your home folder but the
   session's folder and the tool folders on your PATH, and none of your kubeconfig files; it can write only to the
   session folder; it can't run unsandboxed; it can't see Claude Code's Anthropic credentials; and it can connect to
   one local port, the front door's, set as both its HTTP and SOCKS proxy, so it has no internet. The sandbox must
   start, or the session fails (`failIfUnavailable`).
4. **Its file tools** can't read outside the session folder (`blockReadsOutsideWorkingDirectories`).
5. **Permission rules** refuse reading the credential folders and your kubeconfigs, the usual kubectl write verbs,
   `--kubeconfig`, `--context`, `--token` and `--as`, and Helm changes. They match prefixes, so they are a courtesy.
6. **The front door** refuses writes, Secrets, exec, attach, port-forward and proxy for the session's token, and
   scrubs everything it returns, whatever gets through.

Checked live (`packages/acp-host/test/fence.integration.test.ts`, a real Claude Code session on OrbStack):

| The agent ran | What happened |
|---|---|
| `kubectl get namespaces -o name` | Worked, through the front door, audited as `agent 1 · orbstack` |
| `kubectl config get-contexts --kubeconfig ~/.kube/config` | Sandbox: `operation not permitted` |
| `head -c 300 ~/.kube/config` | Sandbox: `Operation not permitted` |
| `kubectl delete pod … -n landlens-dev` | Refused by the permission rule before it ran |
| `kubectl get secrets -A` | Front door: 403 `this token may not access secrets` |
| `curl -sk https://127.0.0.1:26443/version` (the cluster's own API) | Couldn't connect |
| `curl https://example.com` | `Proxy CONNECT aborted` |
| `env` | No Anthropic credential, nothing of Landlens's environment (a planted canary key absent) |
| `ls -la ~` | Sandbox: `Operation not permitted` |
| `curl -x "$ALL_PROXY" https://example.com` | `Proxy CONNECT aborted` |
| `kubectl get configmap orders-api-config -o yaml` | Worked, with `annotations: {}`: last-applied scrubbed by the front door |
| WebFetch `https://example.com` | "I don't have a WebFetch tool" |

## Trying it

```bash
kubectl --context orbstack apply -f deploy/scenarios/crashloop.yaml   # orders-api in landlens-dev crash-loops
pnpm dev                                                              # connect to orbstack, open the problem, Ask Claude
```

On 14 November 2026, asked "Why is this pod crashlooping?" on that pod, Claude Code (Opus 5.5) read the pod's logs and
ConfigMap, answered that the container exits with code 1 because `DATABASE_URL` isn't set (the ConfigMap has only
`DATABASE_HOST` and `DATABASE_NAME`), cited both objects, proposed adding `DATABASE_URL` from a Secret or to the
ConfigMap with the exact commands, and said it couldn't check the Secret because it can't read Secrets.

## Code

| Path | What |
|---|---|
| `packages/acp-host/src/host.ts` | `AcpHost`: spawn the adapter, ACP client, sessions, prompts, permission requests |
| `packages/acp-host/src/session.ts` | `startClusterSession`: tokens, tool kubeconfig, MCP session, fence, `session/new` |
| `packages/acp-host/src/fence.ts` | The sandbox, environment and permission rules for a session |
| `packages/acp-host/src/env.ts` | Your login shell's PATH; finding `node` and the adapter; the Claude Code process's environment |
| `packages/kube-mcp/src/server.ts`, `tools.ts` | The MCP server and its tools |
| `packages/kube/src/redact.ts`, `frontdoor.ts` (`scrubResponse`) | What the agent may see, and where it is enforced |
| `apps/desktop/src/main/agent.ts` | `AgentService`: the host, the sessions, the dock's channels |
| `apps/desktop/src/renderer/src/AgentDock.tsx`, `Markdown.tsx` | The dock |

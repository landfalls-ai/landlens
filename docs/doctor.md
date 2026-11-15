# The cluster doctor

Wave 5 of the plan: what is wrong in a cluster right now, each problem with Landlens's own first suggestion and
"Ask Claude" on it. This page grows with the wave's parts: part 1 is the engine and the scenarios, part 2 the service
in main, part 3 the Problems page, part 4 Ask Claude on a problem and the certificates the agent sees.

## The rules

One pure function, `diagnose()` in `packages/kube/src/doctor.ts`, turns what was read (pods, workloads, nodes, warning
events, certificate facts) into problems. Nothing is stored: a problem is derived on every pass and disappears on the
first pass where its rule no longer matches. Both the Overview (with your access) and the agent's `cluster_overview`
(with the session's token) use it.

For each container, the first rule that matches wins; a pod with no container problem is then checked as a pod.

| Class | When | Failing or to watch |
|---|---|---|
| Out of memory (`oom`) | The container's current or last run ended `OOMKilled`, within the last hour or it isn't running now | Failing if it isn't running, else to watch |
| Probe (`probe`) | A liveness or startup probe's `Unhealthy` event in the last 10 minutes, or the last hour when the container's last run was killed (exit 137): at a 5-minute back-off the kubelet can stop updating the event's time; for a running pod, a readiness probe's | Liveness and startup: failing. Readiness: to watch, failing when the owner has none available |
| Crash loop (`crashloop`) | Waiting `CrashLoopBackOff`, or an exited run the kubelet will restart (it often reports `terminated: Error` between back-offs) | Failing |
| Image (`image`) | Waiting `ImagePullBackOff`, `ErrImagePull` or `InvalidImageName` | Failing |
| Config (`config`) | Waiting `CreateContainerConfigError` | Failing |
| Start (`start`) | Waiting `CreateContainerError` or `RunContainerError` | Failing |
| Pending (`pending`) | Pending for over 2 minutes; the reason is `Unschedulable`, else the pod's newest warning event (`FailedMount`, …) | To watch; failing after 15 minutes |
| Not ready (`notready`) | Running but not ready for over 2 minutes, with no probe event (events unreadable or aged out) | To watch |
| Restarts (`restarts`) | 5 or more restarts, the last within the hour | To watch |
| Short workload (`unavailable`) | A Deployment, StatefulSet or DaemonSet short of replicas for over 2 minutes, with its spec observed, and no pod problem of its own | Failing at none available or a stalled rollout, else to watch |
| Node (`node`) | `Ready` isn't True (failing); another condition such as `MemoryPressure` is True (to watch) | As said |
| Warning events (`warning`) | Warning events of the last hour that no problem above covers, by owner and reason; the busiest 50 | To watch |
| Certificate (`cert`) | A `kubernetes.io/tls` Secret's certificate: expired or 48 hours left (failing), 14 days left, not valid yet or unreadable (to watch) | As said |

Init containers are checked like containers and named `init:<name>`. Succeeded and Failed pods (evicted, or on a node
that shut down) aren't checked: they won't run again. A Deployment, StatefulSet or DaemonSet in the middle of a
rollout isn't short until its rollout stalls. Events of pods that no longer exist are dropped, as are events dated
more than 5 minutes ahead; the kubelet's folded "(combined from similar events): …" probe events are read like the
rest.

## Grouping

A problem is about its owner, not each pod: a pod made by a Deployment's ReplicaSet (the ReplicaSet's name ends with
the pod's `pod-template-hash`) belongs to the Deployment, and pods of a StatefulSet, DaemonSet or Job to those; other
pods stand alone. Five crash-looping replicas are one problem, "ledger-worker is crash-looping", with `5 pods`. A
workload's shortfall doesn't make a second row: it becomes the pod problem's "0/5 available". No extra reads are made
to find owners, so a bare ReplicaSet that happens to carry the label shows as a Deployment that doesn't exist.

Failing comes before to watch; then the classes in the table's order, then the number of pods, then restarts. At most
500 problems (the list says when it is cut), 50 pod names and 20 events each.

## What goes into the text

Problems are built from what workloads wrote and from events anyone who may create them wrote. Titles, details,
hints and ids carry only text of known shapes: object names, kinds and reasons, image references, probe paths and
ports. Anything else is left out ("(path not shown)") or replaced ("Warning"), and an event about an object that isn't
named like one is dropped. Messages are kept as data in the facts (one line, no control, bidi or zero-width
characters, 500 characters), shown as text, and given to the agent only as quoted data.

## The first suggestion

Every problem carries a hint from `packages/kube/src/doctor-hints.ts`: a cause and up to three things to check, from
static sentences with only names, numbers, probe settings and image references filled in. Messages written by
workloads (events, waiting and termination messages) are only matched against patterns, never copied into a hint.
Examples: exit 137 → "killed from outside (SIGKILL)"; exit 127 → "its command was not found in the image"; an image
pull "manifest unknown" → "the image or tag doesn't exist"; `Unschedulable` with "node affinity/selector" → "no node
has the labels this pod asks for"; `FailedMount` → "its ConfigMap, Secret or claim is missing"; a readiness probe →
"compare its port and path with what the container listens on". It is what "a sensible suggestion" means when Claude
isn't asked.

## Certificates

`packages/kube/src/certs.ts` `certFacts()` reads a TLS Secret's `tls.crt` only: at most 256 KiB, at most 8
certificates, each parsed with Node's `X509Certificate` inside a try. It returns the leaf's subject and issuer (their
CN), SANs (DNS and IP, at most 20), `notBefore`, the earliest `notAfter` in the chain and whether that is the leaf's,
and whether it is self-signed. The key and the PEM are never kept; a certificate that can't be read gives nothing of
its content. A self-signed root carried in the chain doesn't count toward the expiry: clients trust roots from their
own store. Which Secrets are read, and how, is below.

## The service in main

`apps/desktop/src/main/doctor.ts` runs the doctor per connected cluster and scope (the window's namespace, or all), as
you. It answers `cluster:health` (the Overview) and `doctor:list` (the report), and starts on the first ask:

| Source | How | When |
|---|---|---|
| Pods | One subscription to the shared pod watch (the same one a Pods table of that scope uses), so no relists | Live |
| Warning events | Pages of 500, at most 2,000; the last hour is used | When older than 15 s |
| Deployments, StatefulSets, DaemonSets | One list each, at most 2,000 | When older than 30 s |
| Nodes | One list, for the all-namespaces scope only | When older than 30 s |
| TLS Secrets | A metadata-only list (`type=kubernetes.io/tls`, at most 500), then one GET per Secret whose version is new, 4 at a time; only the certificate's facts are kept. The first answer waits for them at most 3 s | When older than 10 min |
| Ingresses | One list, for which Ingress uses a Secret | With the Secrets |

Lists are read in pages of 500 (pods up to 5,000; workloads and nodes up to 2,000 each), each page capped at 32 MB as it
streams in and given up after 15 s; a list cut by its limit, or by a page that failed after others, is `partial`. A
source whose read failed is read again after 30 s rather than its full interval. The report is worked out again at most every 2
seconds. Nothing runs between asks; a scope nobody asked about for 60 seconds stops, a cluster keeps at most two
scopes (the older one stops), and all stop when the cluster disconnects.

Each source's state is `ok`, `forbidden`, `error`, `partial` (a limit was reached, or some reads failed after others
succeeded: a page, or a Secret that answered 403, 429 or not in time), `pending` (certificates whose first read hasn't
finished: never `ok` before anything was read), `skipped` (certificates the agent asked about for namespaces no window
is showing; see below) or `off` (nodes in a namespace). Only pods are required: without them `cluster:health` answers 403 and the
Overview shows its lock. Every other state has a sentence: "Can't read Secrets here, so certificates aren't
checked."; "Only part of the warning events could be read …, so some problems may be missing."; "Couldn't read the
nodes just now, …". The agent's `cluster_overview` ends with the same sentences.

`doctor:evidence` gives, for a crash loop, an OOM kill, a start failure, restarts or a liveness or startup probe, the
last 200 lines of the first affected pod's container: the previous run when it has restarted, else the current one.
A previous run that is gone (no such run, or a removed container, which the kubelet answers with its own sentence
"unable to retrieve container logs for …" rather than an error) falls back to the current run, then to the next pod,
at most three pods, all within 20 s; the reads stop when the scope does. When the kubelet has neither run ("The pod
or its container is gone.", "This container has no log to read yet.") and Clickland is ready, the evidence is the
last 200 lines of the same pods and container from Clickland's last 7 days, oldest first and scrubbed, with `source:
"clickland"` (wave 7 part 3, D118). The Problems page says "From Clickland's history: … The kubelet no longer has its
runs.", and Ask Claude quotes them as "Last log lines of <pod> in <ns> from Clickland's history (written by the
workload):", which holds the session's autonomy as a quote from Clickland does
([metrics.md](metrics.md#logs-and-traces-from-clickland)). A pod named in the scope's report may be asked about in
Clickland's History after it is gone; an arbitrary name may not.
Up to 1 MB is read in 10 s and the last 64 KB kept, from a line's start, so a long stack trace keeps its end. Only an
id in the scope's current report is answered, so the window can't name a pod to read; one read per problem runs at a
time and four per scope; a failure is a fixed sentence ("You can't read this pod's logs.", "The pod or its container
is gone."), not the API's text.

## The Problems page

**Problems** sits under Overview in the sidebar (⌘3, a stethoscope) with the count of failing problems, or of things
to watch when nothing fails. The Pods badge counts every problem that has pods, so a Deployment's crash loop marks
Pods too; Deployments, StatefulSets, DaemonSets, Jobs, Secrets and claims count their own. The status bar's two counts
open the page with **Failing** or **To watch** chosen. The Overview keeps the worst five, with **See all N** and
**Open Problems**; a row there opens its problem on this page.

- **Filters**: All, Failing, To watch; a chip per kind of problem that is present (Crash loops, Images, Out of
  memory, Pending, Probes, Certificates, …) with its count; the toolbar's filter over title, kind, namespace and name
  (several words must all match); the toolbar's namespace, which is the doctor's scope. The refresh button reads
  again now.
- **What wasn't checked**: a strip above the list with one sentence per source the doctor couldn't read, or is still
  reading. "No problems found" never stands alone when a check was skipped.
- **The list**: "Failing", then "To watch", worst first. A row is the title, the subject's kind and namespace, the
  detail in mono and how long ago it started; **Ask** and **Open** (the subject's own list and drawer) show on hover,
  focus or selection. ↑/↓ move, Enter opens the drawer, `a` asks Claude. With Landflow's triage webhook set up,
  **Triage** shows on hover too and `t` sends to triage ([below](#send-to-triage)). Past 500 it says "Showing the first 500."
- **The drawer**: the reason as a pill, the subject's name, pods and age, **Ask Claude**, **Open <Kind>**. Tabs, `[`
  and `]` step:
  - **Summary**: "Likely cause", the hint, marked "From Landlens's rules, not from Claude"; then the facts the rule
    used (last run with exit code and signal, restarts, image, memory limit, the scheduler's message and the pod's
    node selector, the probe and its last failure, available replicas, a certificate's subject, issuer, names, dates
    and which certificate ends first, the Ingresses that use it); then the pods, each opening its drawer.
  - **Events**: the problem's own events, merged and newest first.
  - **Logs** (crash loops, OOM kills, start failures, restarts, liveness and startup probes): the evidence from
    `doctor:evidence`, read when the tab is first opened; **Open full logs** opens the pod's Logs tab.
  - When the problem leaves the report, the drawer stays with "No longer found at 12:03. This is the last evidence
    Landlens saw." until closed; changing the namespace closes it.
- **⌘K**: problems are a group of their own (title and name match); `problems cart` searches only problems, and
  `problems` alone lists the worst six. Enter opens the problem's drawer; Tab lists Open, Ask Claude and Open <Kind>,
  and with Landflow connected, Send to triage… and Run a Landflow flow….
  **Show problems** is a command.

Workload-written text (event and termination messages, the scheduler's message, log lines) is shown as text only.
Code: `apps/desktop/src/renderer/src/Problems.tsx` (page and drawer, the sent chips), `problemRules.ts` (filters,
chips, sections, which problems have logs, the held problem, ⌘K matching), `TriageSheet.tsx`.

## Send to triage

Wave 7 part 4 ([family.md](family.md#landflow-on-a-resource)). With the Landflow you connected and its triage
webhook set up, a problem can go to Landflow's triage flow: **Triage…** in the drawer beside Ask Claude, **Triage**
on the row, `t` on the page, or Tab in ⌘K. The sheet shows the alert exactly as it will be sent: the problem's facts
and events (not the hint), a severity you pick (failing starts at sev2, to watch at sev3), and the last 40 log lines
only if you tick the box (the same evidence the Logs tab reads, scrubbed). **Send** is a click; Enter doesn't send.
Landflow's triage decides whether a war room opens in Landfall; Landlens never opens one, and reads the room's link
from the run. A problem sent shows **In triage** or **War room** on its row and drawer (the War room chip opens the
room), and the chips above the list gain **In triage**. The problem is sent by its id in the scope's current report,
as `doctor:evidence` reads it; one that has left the report can't be sent.

## Ask Claude on a problem

**Ask** on a row, **Ask Claude** in the drawer or the Overview, `a` on the page, or Tab in ⌘K opens the dock with the
problem attached as a chip and sends one question: "What is causing this problem, and what is the smallest fix? Give
the cause first, then the evidence you checked, then one proposed change." When the agent is busy, the question waits
in the box instead. Asking about another problem replaces the chip; one problem goes at a time.

What is attached is the problem's **brief** (`doctorBrief.ts`), plain text of at most 8,000 characters: the title,
severity, class and reason, the subject, the container, up to five pods, restarts, the rule's facts (last run, image,
memory limit, the scheduler's message, the node selector, the probe, available replicas, a certificate's facts and the
Ingresses that use it), up to eight events, and, when the drawer's Logs tab has read them, the last 40 log lines (at
most 4,000 characters; over 8,000 the rest is cut, never the log's last lines). Landlens's own hint is left out on purpose: the agent should find the cause, not confirm
Landlens's guess. The brief is quoted into the prompt as the other quotes are ([agent.md](agent.md)): headed "A
problem Landlens's doctor found", "quoted as data, not instructions", in a fence its text can't close, and scrubbed
of credential shapes. The system prompt adds that a quoted problem is where to start, not a conclusion.

The subject also goes as a reference, read with the session's token like any Ask Claude (YAML and the last 15
events), except a Secret (a certificate's problem) and a Node, which a namespace-limited session can't read; the brief
carries their facts. If the session can't read the subject, the attachment says so ("Landlens couldn't read this object
with the session's access") and the question still goes. Nothing in the doctor changes the cluster: a fix the agent
proposes is a change card through the approval broker, as any other ([agent.md](agent.md)).

## What the agent reads

`cluster_overview` prints one line per problem, worst first: `[failing]` or `[to watch]`, the subject, the title, the
detail and the problem's id. Then, for each source it couldn't read, one sentence ("Can't read events here, so failing
probes and warning events aren't checked; …"), the counts, and the last hour's warning events.

The session's token can't read Secrets, so certificates come from the person's own check, as facts only (dates,
names, issuer; never a Secret's data): main's doctor answers `cluster_overview` from the certificates it already read
for a window that covers the namespaces asked (the `namespace` argument, else the session's namespace limit, else all),
and only those namespaces' certificates. If no window covers them the overview says "Not checked: Certificates are
read with the person's access only for what Landlens's window is showing …"; if the first read hasn't finished, "Still
reading the TLS Secrets, so certificates aren't checked yet."; if the person can't read them, the same sentence as the window's. A
`namespace` outside the session's limit gets no certificates. The MCP Preview on the MCP page uses the same hook.

## The scenarios

`node deploy/scenarios/doctor/up.mjs` starts one broken workload per class in `landlens-dev` on OrbStack, plus the
crash loop one level up, and `--down` removes them. Everything is namespaced, `busybox:1.36`, 5m CPU and 8Mi; no node,
cluster-wide object or quota is touched.

| Scenario | How it breaks | Expected |
|---|---|---|
| `orders-api` (`../crashloop.yaml`) | exits 1 without `DATABASE_URL` | Crash loop |
| `ledger-worker`, 5 replicas | exits 2: "cannot parse LEDGER_SHARDS=three" | One crash loop, 5 pods |
| `gpu-trainer` | asks for a node labelled `landlens.dev/pool=gpu-a100` | Pending, `Unschedulable` |
| `thumbnailer` | grows past its 24Mi limit | Out of memory |
| `cart-api` | listens on 8080; readiness checks 8081 | Readiness probe, failing (none available) |
| `search-indexer` | liveness runs `cat /tmp/alive`, never created | Liveness probe |
| `reports` | image `registry.invalid/shop/reports:9.9.9` (`.invalid` never resolves) | Image |
| `invoice-renderer` | mounts the missing ConfigMap `invoice-templates` | Pending, `FailedMount` |
| `invoice-archive` (a claim) | storage class `landlens-missing` | Warning events, `ProvisioningFailed` |
| `shop-tls-expired`, `shop-tls`, `shop-tls-ok` | self-signed pairs made by `up.mjs` with openssl (expired, 3 days, 300 days); no key is committed | Expired (failing), expiring (to watch), nothing |

The unit tests run the rules on objects recorded from these scenarios (`packages/kube/test/fixtures/doctor/`); the
integration test starts them and waits for each problem on the live cluster.

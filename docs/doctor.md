# The cluster doctor

Wave 5 of the plan: what is wrong in a cluster right now, each problem with Landlens's own first suggestion and
"Ask Claude" on it. This page grows with the wave's parts: part 1 is the engine and the scenarios, part 2 the service
in main.

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
finished: never `ok` before anything was read) or `off` (nodes in a namespace). Only pods are required: without them `cluster:health` answers 403 and the
Overview shows its lock. Every other state has a sentence: "Can't read Secrets here, so certificates aren't
checked."; "Only part of the warning events could be read …, so some problems may be missing."; "Couldn't read the
nodes just now, …". The agent's `cluster_overview` ends with the same sentences.

`doctor:evidence` gives, for a crash loop, an OOM kill, a start failure, restarts or a liveness or startup probe, the
last 200 lines of the first affected pod's container: the previous run when it has restarted, else the current one.
Up to 1 MB is read in 10 s and the last 64 KB kept, from a line's start, so a long stack trace keeps its end. Only an
id in the scope's current report is answered, so the window can't name a pod to read; one read per problem runs at a
time and four per scope; a failure is a fixed sentence ("You can't read this pod's logs.", "The pod or its container
is gone."), not the API's text.

## What the agent reads

`cluster_overview` prints one line per problem, worst first: `[failing]` or `[to watch]`, the subject, the title, the
detail and the problem's id. Then, for each source it couldn't read, one sentence ("Can't read events here, so failing
probes and warning events aren't checked; …"), the counts, and the last hour's warning events.

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

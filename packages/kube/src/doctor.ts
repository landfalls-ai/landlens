// The cluster doctor's rules (wave 5, D46–D52, docs/doctor.md): one pure function from what was read to what is
// wrong, grouped by owner, worst first. No I/O. Main's DoctorService and the agent's cluster_overview both use it.
import type {
  CertFact, DoctorCheck, DoctorCheckState, DoctorReport, KubeObject, Problem, ProblemClass, ProblemEvent, ProblemFacts,
} from "@landlens/contracts";
import { hintFor } from "./doctor-hints.js";
import { age, nodeStatus, podReady } from "./status.js";

export type CertInput = { namespace: string; name: string; fact: CertFact };
export type DoctorInput = {
  pods: KubeObject[];
  deployments?: KubeObject[];
  statefulsets?: KubeObject[];
  daemonsets?: KubeObject[];
  nodes?: KubeObject[];
  /** Warning events; others are ignored. */
  events?: KubeObject[];
  certs?: CertInput[];
  ingresses?: KubeObject[];
  checks?: Partial<Record<DoctorCheck, DoctorCheckState>>;
};

const MIN = 60_000;
const HOUR = 60 * MIN;
export const DOCTOR_LIMITS = { problems: 500, warnings: 50, pods: 50, events: 20, text: 500 } as const;
/** Certificate thresholds (D55): failing at 48 h or less, to watch at 14 days or less. */
export const CERT_BAD_MS = 48 * HOUR;
export const CERT_WARN_MS = 14 * 24 * HOUR;

/** The order rules are tried and problems listed in, inside a tone. */
const ORDER: ProblemClass[] = ["oom", "probe", "crashloop", "image", "config", "start", "pending", "notready", "restarts", "unavailable", "node", "warning", "cert"];
const IMAGE = new Set(["ImagePullBackOff", "ErrImagePull", "InvalidImageName"]);
const START = new Set(["CreateContainerError", "RunContainerError"]);

const KINDS: Record<string, [group: string, version: string, resource: string]> = {
  Pod: ["", "v1", "pods"], Node: ["", "v1", "nodes"], Secret: ["", "v1", "secrets"], ConfigMap: ["", "v1", "configmaps"],
  Service: ["", "v1", "services"], PersistentVolumeClaim: ["", "v1", "persistentvolumeclaims"],
  PersistentVolume: ["", "v1", "persistentvolumes"], Namespace: ["", "v1", "namespaces"],
  Deployment: ["apps", "v1", "deployments"], StatefulSet: ["apps", "v1", "statefulsets"], DaemonSet: ["apps", "v1", "daemonsets"],
  ReplicaSet: ["apps", "v1", "replicasets"], Job: ["batch", "v1", "jobs"], CronJob: ["batch", "v1", "cronjobs"],
  Ingress: ["networking.k8s.io", "v1", "ingresses"], HorizontalPodAutoscaler: ["autoscaling", "v2", "horizontalpodautoscalers"],
};
/** Object names (DNS subdomains), kinds and reasons (words), API groups and versions, image references, probe paths
 * and ports: only text of these shapes is put into a title, detail, hint or id; anything else is left out (security
 * review, wave 5 part 1, findings 1 and 3). */
const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const WORD = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const GROUP = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?(\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)*$/;
const VERSION = /^v[0-9]{1,4}((alpha|beta)[0-9]{1,4})?$/;
const IMAGE_REF = /^[a-z0-9]([a-z0-9._\-/:@]{0,298}[a-z0-9])?$/i;
const PROBE_PATH = /^\/[\w\-./~%]{0,200}$/;
const PORT = /^([0-9]{1,5}|[a-z0-9]([-a-z0-9]{0,13}[a-z0-9])?)$/;
export const isName = (s: unknown): s is string => typeof s === "string" && NAME.test(s);
export const isWord = (s: unknown): s is string => typeof s === "string" && WORD.test(s);
export const isImageRef = (s: unknown): s is string => typeof s === "string" && IMAGE_REF.test(s);

/** Where the window finds a kind: known kinds exactly; others from a checked apiVersion and a plural guess, else none. */
export function resourceOf(kind: string, apiVersion?: string): { group: string; version: string; resource: string } {
  const k = KINDS[kind];
  if (k) return { group: k[0], version: k[1], resource: k[2] };
  const [g, v] = apiVersion?.includes("/") ? apiVersion.split("/") : ["", apiVersion || "v1"];
  if (!isWord(kind) || (g && !GROUP.test(g)) || !v || !VERSION.test(v)) return { group: "", version: "", resource: "" };
  const lower = kind.toLowerCase();
  return { group: g ?? "", version: v, resource: lower.endsWith("s") ? `${lower}es` : lower.endsWith("y") ? `${lower.slice(0, -1)}ies` : `${lower}s` };
}

/** Workload-written text for the window: no control characters, one line, capped. */
export function cleanText(s: unknown, max: number = DOCTOR_LIMITS.text): string {
  // Control, format (bidi overrides, zero-width, tag characters) and line/paragraph separators all go.
  const t = String(s ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const time = (s: unknown) => {
  const n = Date.parse(String(s ?? ""));
  return Number.isFinite(n) ? n : NaN;
};
const iso = (n: number) => (Number.isFinite(n) ? new Date(n).toISOString() : undefined);
/** The smallest of many numbers without spreading them as arguments. */
const least = (xs: number[]) => xs.reduce((a, x) => (x < a ? x : a), Infinity);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

type Subject = { kind: string; namespace?: string; name: string; apiVersion?: string };
const key = (s: Subject) => `${s.kind}/${s.namespace ?? ""}/${s.name}`;

/** A pod's owner, found without reading it: a ReplicaSet with the pod's template hash is its Deployment's (D50). */
export function subjectOf(pod: KubeObject): Subject {
  const ns = pod.metadata.namespace;
  const refs = Array.isArray(pod.metadata.ownerReferences) ? pod.metadata.ownerReferences : [];
  const ref = refs.find((r: any) => r?.controller && isName(r.name));
  if (ref?.kind === "ReplicaSet") {
    const hash = pod.metadata.labels?.["pod-template-hash"];
    if (typeof hash === "string" && hash && ref.name.endsWith(`-${hash}`) && ref.name.length > hash.length + 1) return { kind: "Deployment", namespace: ns, name: ref.name.slice(0, -hash.length - 1) };
    return { kind: "ReplicaSet", namespace: ns, name: ref.name };
  }
  if (ref && (ref.kind === "StatefulSet" || ref.kind === "DaemonSet" || ref.kind === "Job")) return { kind: ref.kind, namespace: ns, name: ref.name };
  return { kind: "Pod", namespace: ns, name: pod.metadata.name };
}

type Ev = ProblemEvent & { kind: string; namespace?: string; name: string; apiVersion?: string; container?: string; first: number; last: number };
/** Warning events as the rules read them: the last hour, checked shapes, newest first (also "Recent warnings"). */
export function warningRows(events: KubeObject[] | undefined, now: number): Ev[] {
  const out: Ev[] = [];
  for (const e of (events ?? []) as any[]) {
    if (!e || typeof e !== "object" || (e.type && e.type !== "Warning")) continue;
    // An event dated more than 5 minutes ahead (beyond clock skew) is dropped, so a forged one can't stay "recent"
    // for ever (security review, part 1, finding 10); a little ahead counts as now.
    const stamped = time(e.series?.lastObservedTime ?? e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp);
    if (!Number.isFinite(stamped) || stamped > now + 5 * MIN) continue;
    const last = Math.min(stamped, now);
    if (now - last > HOUR) continue;
    const first = Math.min(time(e.firstTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp), last);
    const o = e.involvedObject ?? e.regarding ?? {};
    // Events are written by anyone who may create them: an object that isn't named like one is dropped.
    if (!isWord(o.kind) || !isName(o.name) || (o.namespace !== undefined && o.namespace !== "" && !isName(o.namespace))) continue;
    const container = /^spec\.(?:initC|c)ontainers\{([a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)\}$/.exec(String(o.fieldPath ?? ""))?.[1];
    const count = Number(e.series?.count ?? e.count);
    out.push({
      at: new Date(last).toISOString(), reason: isWord(e.reason) ? e.reason : "Warning",
      // The kubelet folds similar events into one "(combined from similar events): …" (finding 6).
      message: cleanText(String(e.message ?? e.note ?? "").replace(/^\(combined from similar events\):\s*/i, "")),
      count: Number.isFinite(count) && count > 0 ? Math.min(count, 1e9) : 1,
      kind: o.kind, ...(o.namespace ? { namespace: o.namespace } : {}), name: o.name, ...(typeof o.apiVersion === "string" ? { apiVersion: o.apiVersion.slice(0, 300) } : {}),
      ...(container ? { container } : {}), first: Number.isFinite(first) ? first : last, last,
    });
  }
  return out.sort((a, b) => b.last - a.last);
}

/** Up to 20 events, newest first, with equal reason and message merged. */
function mergeEvents(evs: ProblemEvent[]): ProblemEvent[] {
  const by = new Map<string, ProblemEvent>();
  for (const e of evs) {
    const k = `${e.reason}\u0000${e.message}`;
    const had = by.get(k);
    if (!had) by.set(k, { at: e.at, reason: e.reason, message: e.message, count: e.count });
    else {
      had.count += e.count;
      if (e.at > had.at) had.at = e.at;
    }
  }
  return [...by.values()].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, DOCTOR_LIMITS.events);
}

/** A probe as one short phrase: "GET :8081/healthz/ready", "tcp :5432", "exec". The exec command is never carried. */
function probeHow(p: any): string {
  if (!p) return "";
  const port = (v: unknown) => (PORT.test(String(v ?? "")) ? String(v) : "?");
  if (p.httpGet) {
    const path = p.httpGet.path ?? "/";
    return `${p.httpGet.scheme === "HTTPS" ? "GET https " : "GET "}:${port(p.httpGet.port)}${PROBE_PATH.test(String(path)) ? path : " (path not shown)"}`;
  }
  if (p.tcpSocket) return `tcp :${port(p.tcpSocket.port)}`;
  if (p.grpc) return `grpc :${port(p.grpc.port)}`;
  return "exec";
}

type Draft = Omit<Problem, "id" | "title" | "detail" | "hint" | "group" | "version" | "resource" | "pods" | "podCount" | "facts"> & {
  pods?: string[];
  facts: Omit<ProblemFacts, "events"> & { events?: ProblemEvent[] };
  /** Tested by the hint's patterns, never shown. */
  message?: string;
  exitCode?: number;
  signal?: number;
  apiVersion?: string;
};

export function diagnose(input: DoctorInput, now: number = Date.now()): DoctorReport {
  const checks: Record<DoctorCheck, DoctorCheckState> = { pods: "ok", workloads: "ok", nodes: "ok", events: "ok", certs: "off", ...input.checks };
  const byId = new Map<string, Problem & { message?: string; exitCode?: number; signal?: number }>();
  const events = warningRows(input.events, now);
  const evOf = new Map<string, Ev[]>();
  for (const e of events) {
    const k = key(e);
    (evOf.get(k) ?? evOf.set(k, []).get(k)!).push(e);
  }

  const add = (d: Draft) => {
    const subject = { kind: d.kind, namespace: d.namespace, name: d.name };
    const id = cleanText(`${d.class}|${key(subject)}|${d.container ?? ""}|${d.reason}`, 600);
    const had = byId.get(id);
    const pods = d.pods ?? [];
    if (had) {
      for (const p of pods) if (!had.pods.includes(p) && had.pods.length < DOCTOR_LIMITS.pods) had.pods.push(p);
      had.podCount += pods.length;
      if (d.tone === "bad") had.tone = "bad";
      if ((d.restarts ?? 0) > (had.restarts ?? 0)) had.restarts = d.restarts;
      if (d.since && (!had.since || d.since < had.since)) had.since = d.since;
      had.facts.events = mergeEvents([...had.facts.events, ...(d.facts.events ?? [])]);
      return;
    }
    const { message, exitCode, signal, apiVersion, ...rest } = d;
    const r = resourceOf(d.kind, apiVersion);
    byId.set(id, {
      ...rest, id, ...r, pods: pods.slice(0, DOCTOR_LIMITS.pods), podCount: pods.length,
      facts: { ...d.facts, events: mergeEvents(d.facts.events ?? []) },
      title: "", detail: "", hint: { cause: "", next: [] },
      ...(message ? { message } : {}), ...(exitCode !== undefined ? { exitCode } : {}), ...(signal !== undefined ? { signal } : {}),
    });
  };

  // Workloads first, so a pod's problem can say how many of its owner's replicas are available.
  type Avail = { want: number; have: number; deadline: boolean; settled: number; observed: boolean; rolling: boolean; subject: Subject };
  const avail = new Map<string, Avail>();
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const workload = (kind: string, list: KubeObject[] | undefined) => {
    for (const w of (list ?? []) as any[]) {
      if (!isName(w?.metadata?.name)) continue;
      const s = w.status ?? {};
      const want = kind === "DaemonSet" ? num(s.desiredNumberScheduled, 0) : num(w.spec?.replicas, 1);
      const have = kind === "DaemonSet" ? num(s.numberAvailable, 0) : kind === "StatefulSet" ? num(s.availableReplicas ?? s.readyReplicas, 0) : num(s.availableReplicas, 0);
      const conds: any[] = Array.isArray(s.conditions) ? s.conditions.filter(Boolean) : [];
      const settled = conds.reduce((a, c) => Math.max(a, time(c.lastTransitionTime) || 0), time(w.metadata.creationTimestamp) || 0);
      // A rollout in progress is short by design (maxUnavailable); it counts only once it has stalled (finding 7).
      const rolling = kind === "Deployment" ? num(s.updatedReplicas, want) < want || num(s.replicas, want) > want
        : kind === "StatefulSet" ? !!s.updateRevision && s.currentRevision !== s.updateRevision
        : num(s.updatedNumberScheduled, want) < want;
      const subject = { kind, namespace: w.metadata.namespace, name: w.metadata.name };
      avail.set(key(subject), {
        want, have, settled, subject, rolling,
        deadline: conds.some((c) => c.type === "Progressing" && c.reason === "ProgressDeadlineExceeded"),
        observed: num(s.observedGeneration, 0) >= num(w.metadata.generation, 0),
      });
    }
  };
  workload("Deployment", input.deployments);
  workload("StatefulSet", input.statefulsets);
  workload("DaemonSet", input.daemonsets);

  const podNames = new Map<string, Subject>();
  for (const pod of input.pods) {
    // One malformed object mustn't take the whole report with it (finding 9).
    try {
      checkPod(pod);
    } catch {
      /* skipped */
    }
  }
  function checkPod(pod: KubeObject) {
    // Succeeded pods are done; Failed ones (evicted, node shutdown) won't run again, so they aren't crash loops.
    if (!pod?.metadata || !isName(pod.metadata.name) || pod.metadata.deletionTimestamp || pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed") return;
    const ns = pod.metadata.namespace;
    const subject = subjectOf(pod);
    podNames.set(key({ kind: "Pod", namespace: ns, name: pod.metadata.name }), subject);
    const podEvents = evOf.get(key({ kind: "Pod", namespace: ns, name: pod.metadata.name })) ?? [];
    const recent = (c: string | undefined, type: string, within = 10 * MIN) =>
      podEvents.filter((e) => e.reason === "Unhealthy" && now - e.last <= within && e.message.toLowerCase().startsWith(type) && (!c || !e.container || e.container === c));
    const base = { kind: subject.kind, ...(ns ? { namespace: ns } : {}), name: subject.name, pods: [pod.metadata.name] };
    const specs: any[] = [...(Array.isArray(pod.spec?.initContainers) ? pod.spec.initContainers : []), ...(Array.isArray(pod.spec?.containers) ? pod.spec.containers : [])].filter(Boolean);
    const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
    const statuses: { c: any; init: boolean }[] = [
      ...arr(pod.status?.initContainerStatuses).map((c: any) => ({ c, init: true })),
      ...arr(pod.status?.containerStatuses).map((c: any) => ({ c, init: false })),
    ].filter(({ c }) => isName(c.name));
    let matched = false;
    for (const { c, init } of statuses) {
      const spec = specs.find((x) => x.name === c.name) ?? {};
      const container = init ? `init:${c.name}` : String(c.name);
      const last = c.lastState?.terminated;
      const term = c.state?.terminated;
      const waiting: string | undefined = c.state?.waiting?.reason;
      const lastState = (t: any): ProblemFacts["lastState"] => (t ? {
        ...(t.reason ? { reason: cleanText(t.reason, 64) } : {}), ...(typeof t.exitCode === "number" ? { exitCode: t.exitCode } : {}),
        ...(typeof t.signal === "number" ? { signal: t.signal } : {}), ...(t.finishedAt ? { finishedAt: String(t.finishedAt) } : {}),
        ...(t.message ? { message: cleanText(t.message) } : {}),
      } : undefined);
      const common = {
        ...base, container, restarts: c.restartCount ?? 0,
        exitCode: (term ?? last)?.exitCode, signal: (term ?? last)?.signal,
      };
      const facts = (extra: Partial<ProblemFacts> = {}) => {
        const ls = lastState(term ?? last);
        return { ...(ls ? { lastState: ls } : {}), ...(spec.image ? { image: cleanText(spec.image, 300) } : {}), events: podEvents.filter((e) => !e.container || e.container === c.name), ...extra };
      };
      const oomed = term?.reason === "OOMKilled" ? term : last?.reason === "OOMKilled" ? last : undefined;
      const running = !!c.state?.running;
      if (oomed && (!running || now - time(oomed.finishedAt) <= HOUR)) {
        const limit = spec.resources?.limits?.memory ? cleanText(spec.resources.limits.memory, 32) : undefined;
        add({ ...common, class: "oom", reason: "OOMKilled", tone: running ? "warn" : "bad", ...(iso(time(oomed.finishedAt)) ? { since: iso(time(oomed.finishedAt)) } : {}), facts: facts(limit ? { limit } : {}) });
        matched = true;
        continue;
      }
      // A probe kill is exit 137. Once the back-off reaches minutes the kubelet may stop updating its Unhealthy event's
      // time, so for a container whose last run was killed, a probe event within the hour still counts.
      const killed = (term ?? last)?.exitCode === 137 && now - time((term ?? last)?.finishedAt) <= HOUR;
      const live = [
        ...recent(c.name, "liveness", killed && spec.livenessProbe ? HOUR : 10 * MIN),
        ...recent(c.name, "startup", killed && spec.startupProbe ? HOUR : 10 * MIN),
      ];
      if (live.length && !init) {
        const type = live[0]!.message.toLowerCase().startsWith("startup") ? "startup" : "liveness";
        const p = type === "startup" ? spec.startupProbe : spec.livenessProbe;
        add({
          ...common, class: "probe", reason: type === "startup" ? "StartupProbe" : "LivenessProbe", tone: "bad", since: iso(least(live.map((e) => e.first))),
          facts: facts({ probe: { type, how: probeHow(p), ...probeNumbers(p), lastMessage: live[0]!.message } }),
        });
        matched = true;
        continue;
      }
      // Between back-offs the kubelet often reports the exited run (terminated: Error) rather than waiting:
      // CrashLoopBackOff; a container that has restarted and will be restarted again is the same crash loop.
      const policy = pod.spec?.restartPolicy ?? "Always";
      const looping = waiting === "CrashLoopBackOff" || (!waiting && !!term && !init && (c.restartCount ?? 0) >= 1 && policy !== "Never" && !(policy === "OnFailure" && term.exitCode === 0));
      if (!waiting && !looping) continue;
      const cls: ProblemClass | undefined = looping ? "crashloop" : !waiting ? undefined : IMAGE.has(waiting) ? "image" : waiting === "CreateContainerConfigError" ? "config" : START.has(waiting) ? "start" : undefined;
      if (!cls) continue;
      add({ ...common, class: cls, reason: looping ? "CrashLoopBackOff" : waiting!, tone: "bad", ...(c.state?.waiting?.message ? { message: String(c.state.waiting.message).slice(0, 2000) } : {}), facts: facts() });
      matched = true;
    }
    if (matched) return;

    const created = time(pod.metadata.creationTimestamp);
    const phase = pod.status?.phase;
    const conds: any[] = arr(pod.status?.conditions);
    if (phase === "Pending" && now - created > 2 * MIN) {
      const unsched = conds.find((c) => c.type === "PodScheduled" && c.status === "False");
      // The reason is part of the id, so it must not flip between passes: the busiest event reason, then by name.
      const reason = unsched ? (isWord(unsched.reason) ? unsched.reason : "Unschedulable") : busiestReason(podEvents) ?? "Pending";
      add({
        ...base, class: "pending", reason, tone: now - created > 15 * MIN ? "bad" : "warn", since: iso(created),
        ...(unsched?.message ? { message: String(unsched.message).slice(0, 2000) } : {}),
        facts: { ...(unsched?.message ? { scheduling: cleanText(unsched.message) } : {}), events: podEvents },
      });
      return;
    }
    if (phase !== "Running") return;
    const ready = recent(undefined, "readiness");
    if (ready.length) {
      const c = ready[0]!.container;
      const containers: any[] = specs.filter((x) => isName(x.name));
      const spec = containers.find((x) => x.name === c) ?? containers.find((x) => x.readinessProbe) ?? {};
      const owner = avail.get(key(subject));
      add({
        ...base, class: "probe", reason: "ReadinessProbe", ...(isName(spec.name ?? c) ? { container: String(spec.name ?? c) } : {}), tone: owner && owner.have === 0 ? "bad" : "warn",
        since: iso(least(ready.map((e) => e.first))),
        facts: { probe: { type: "readiness", how: probeHow(spec.readinessProbe), ...probeNumbers(spec.readinessProbe), lastMessage: ready[0]!.message }, events: podEvents },
      });
      return;
    }
    const readyCond = conds.find((c) => c.type === "Ready");
    if (podReady(pod).tone !== "ok" && readyCond?.status !== "True" && now - (time(readyCond?.lastTransitionTime) || created) > 2 * MIN) {
      add({ ...base, class: "notready", reason: "NotReady", tone: "warn", since: iso(time(readyCond?.lastTransitionTime) || created), facts: { events: podEvents } });
      return;
    }
    const cs: any[] = arr(pod.status?.containerStatuses).filter((c: any) => isName(c.name));
    const restarts = cs.reduce((a, c) => a + (c.restartCount ?? 0), 0);
    const lastKill = cs.reduce((a, c) => Math.max(a, time(c.lastState?.terminated?.finishedAt) || 0), 0);
    if (restarts >= 5 && now - lastKill <= HOUR) {
      const worst = [...cs].sort((a, b) => (b.restartCount ?? 0) - (a.restartCount ?? 0))[0];
      const t = worst?.lastState?.terminated;
      add({
        ...base, class: "restarts", reason: "Restarts", tone: "warn", restarts, ...(worst ? { container: String(worst.name) } : {}),
        exitCode: t?.exitCode, signal: t?.signal, since: iso(lastKill),
        facts: { ...(t ? { lastState: { ...(t.reason ? { reason: cleanText(t.reason, 64) } : {}), ...(typeof t.exitCode === "number" ? { exitCode: t.exitCode } : {}), ...(t.finishedAt ? { finishedAt: String(t.finishedAt) } : {}) } } : {}), events: podEvents },
      });
    }
  }

  // A workload short of replicas: its pods' problems carry the count; with none, it is a problem of its own.
  const bySubject = new Map<string, Problem[]>();
  for (const p of byId.values()) (bySubject.get(key(p)) ?? bySubject.set(key(p), []).get(key(p))!).push(p);
  for (const a of avail.values()) {
    if (a.have >= a.want) continue;
    const available = `${a.have}/${a.want}`;
    const theirs = bySubject.get(key(a.subject));
    if (theirs) {
      for (const p of theirs) {
        p.facts.available = available;
        if (a.have === 0 && p.class === "probe") p.tone = "bad";
      }
      continue;
    }
    if (!a.observed || now - a.settled <= 2 * MIN || (a.rolling && !a.deadline && a.have > 0)) continue;
    add({
      kind: a.subject.kind, ...(a.subject.namespace ? { namespace: a.subject.namespace } : {}), name: a.subject.name, class: "unavailable",
      reason: a.deadline ? "ProgressDeadlineExceeded" : "Unavailable", tone: a.have === 0 || a.deadline ? "bad" : "warn",
      facts: { available, events: evOf.get(key(a.subject)) ?? [] },
    });
  }

  for (const n of input.nodes ?? []) {
    const name = n?.metadata?.name;
    if (!isName(name) || (n.status?.conditions !== undefined && !Array.isArray(n.status.conditions)) || (n.status?.conditions ?? []).some((c: unknown) => !c || typeof c !== "object")) continue;
    const evs = evOf.get(key({ kind: "Node", name })) ?? [];
    if (nodeStatus(n).text.startsWith("NotReady")) add({ kind: "Node", name, class: "node", reason: "NotReady", tone: "bad", facts: { events: evs } });
    for (const c of (n.status?.conditions ?? []) as any[]) {
      if (c && isWord(c.type) && c.type !== "Ready" && c.status === "True") add({ kind: "Node", name, class: "node", reason: c.type, tone: "warn", ...(iso(time(c.lastTransitionTime)) ? { since: iso(time(c.lastTransitionTime)) } : {}), facts: { events: evs } });
    }
  }

  // Warning events no problem above already covers, by owner and reason; the busiest 50.
  const covered = new Set<string>();
  for (const p of byId.values()) {
    covered.add(key(p));
    for (const pod of p.pods) covered.add(key({ kind: "Pod", namespace: p.namespace, name: pod }));
  }
  const groups = new Map<string, { subject: Subject; reason: string; evs: Ev[] }>();
  for (const e of events) {
    let subject: Subject = { kind: e.kind, namespace: e.namespace, name: e.name, apiVersion: e.apiVersion };
    if (!e.kind || !e.name) continue;
    if (e.kind === "Pod") {
      const owner = podNames.get(key(e));
      if (!owner) continue; // the pod is gone
      subject = owner;
    }
    if (covered.has(key(e)) || covered.has(key(subject))) continue;
    const g = `${key(subject)}|${e.reason}`;
    (groups.get(g) ?? groups.set(g, { subject, reason: e.reason, evs: [] }).get(g)!).evs.push(e);
  }
  const busiest = [...groups.values()].map((g) => ({ ...g, n: g.evs.reduce((a, e) => a + e.count, 0) })).sort((a, b) => b.n - a.n);
  for (const g of busiest.slice(0, DOCTOR_LIMITS.warnings)) {
    add({
      kind: g.subject.kind, ...(g.subject.namespace ? { namespace: g.subject.namespace } : {}), name: g.subject.name, ...(g.subject.apiVersion ? { apiVersion: g.subject.apiVersion } : {}),
      class: "warning", reason: g.reason || "Warning", tone: "warn", since: iso(least(g.evs.map((e) => e.first))),
      facts: { events: g.evs },
    });
  }

  const usedBy = new Map<string, string[]>();
  for (const ing of (input.ingresses ?? []) as any[]) {
    if (!isName(ing?.metadata?.name)) continue;
    for (const t of Array.isArray(ing.spec?.tls) ? ing.spec.tls : []) {
      if (!isName(t?.secretName)) continue;
      const k = `${ing.metadata.namespace}/${t.secretName}`;
      const l = usedBy.get(k) ?? usedBy.set(k, []).get(k)!;
      if (l.length < 10 && !l.includes(ing.metadata.name)) l.push(ing.metadata.name);
    }
  }
  for (const c of input.certs ?? []) {
    const f = c.fact;
    const notAfter = time(f.notAfter);
    const notBefore = time(f.notBefore);
    let reason: string | undefined;
    let tone: "bad" | "warn" = "warn";
    if (f.unreadable) reason = "Unreadable";
    else if (notAfter <= now) (reason = "Expired"), (tone = "bad");
    else if (notAfter - now <= CERT_BAD_MS) (reason = "Expiring"), (tone = "bad");
    else if (notAfter - now <= CERT_WARN_MS) reason = "Expiring";
    else if (notBefore > now) reason = "NotYetValid";
    if (!reason) continue;
    const users = usedBy.get(`${c.namespace}/${c.name}`);
    add({
      kind: "Secret", namespace: c.namespace, name: c.name, class: "cert", reason, tone,
      ...(reason === "Expired" ? { since: f.notAfter } : {}),
      facts: { cert: f, ...(users ? { usedBy: users } : {}), events: [] },
    });
  }

  const all = [...byId.values()].sort((a, b) =>
    a.tone !== b.tone ? (a.tone === "bad" ? -1 : 1)
    : a.class !== b.class ? ORDER.indexOf(a.class) - ORDER.indexOf(b.class)
    : b.podCount !== a.podCount ? b.podCount - a.podCount
    : (b.restarts ?? 0) - (a.restarts ?? 0));
  const problems = all.slice(0, DOCTOR_LIMITS.problems).map((p) => finish(p, now));
  return { at: new Date(now).toISOString(), problems, cut: all.length > DOCTOR_LIMITS.problems, checks };
}

function busiestReason(evs: Ev[]): string | undefined {
  const by = new Map<string, number>();
  for (const e of evs) by.set(e.reason, (by.get(e.reason) ?? 0) + e.count);
  return [...by.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
}

function probeNumbers(p: any) {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const period = n(p?.periodSeconds) ?? 10;
  const timeout = n(p?.timeoutSeconds) ?? 1;
  const failureThreshold = n(p?.failureThreshold) ?? 3;
  return { period, timeout, failureThreshold };
}

/** Title, detail and hint, from the facts; the hidden fields used only by the hint are dropped. */
function finish(p: Problem & { message?: string; exitCode?: number; signal?: number }, now: number): Problem {
  const { message, exitCode, signal, ...rest } = p;
  const f = p.facts;
  const pods = p.podCount > 1 ? plural(p.podCount, "pod") : "";
  const exit = f.lastState?.exitCode !== undefined ? `exit ${f.lastState.exitCode}${f.lastState.reason ? ` (${f.lastState.reason})` : ""}` : "";
  const restarts = p.restarts ? plural(p.restarts, "restart") : "";
  const container = p.container ? `container ${p.container}` : "";
  const since = p.since ? `for ${age(time(p.since), now)}` : "";
  const join = (...xs: string[]) => xs.filter(Boolean).join(" · ");
  const n = p.name;
  let title = "";
  let detail = "";
  switch (p.class) {
    case "oom": title = `${n} ran out of memory`; detail = join(container, f.limit ? `limit ${f.limit}` : "no memory limit", restarts, pods); break;
    case "crashloop": title = `${n} is crash-looping`; detail = join(container, exit, restarts, pods); break;
    case "image": title = `${n} can't pull its image`; detail = join(container, p.reason, isImageRef(f.image) ? f.image : "", pods); break;
    case "config": title = `${n} has a broken container config`; detail = join(container, p.reason, pods); break;
    case "start": title = `${n} can't start its container`; detail = join(container, p.reason, pods); break;
    case "pending": title = p.reason === "Unschedulable" ? `${n} can't be scheduled` : `${n} is stuck pending`; detail = join(p.reason, since, pods); break;
    case "probe": title = `${n} fails its ${f.probe?.type ?? "readiness"} probe`; detail = join(container, f.probe?.how ?? "", f.available ? `${f.available} available` : "", pods); break;
    case "notready": title = `${n} is running but not ready`; detail = join(since ? `not ready ${since}` : "", pods); break;
    case "restarts": title = `${n} keeps restarting`; detail = join(container, restarts, exit ? `last ${exit}` : "", pods); break;
    case "unavailable": title = `${n} is short of replicas`; detail = join(`${f.available} available`, p.reason === "ProgressDeadlineExceeded" ? "rollout stalled" : ""); break;
    case "node": title = p.reason === "NotReady" ? `Node ${n} is not ready` : `Node ${n} reports ${p.reason}`; detail = join(p.reason, since); break;
    case "warning": {
      const count = f.events.reduce((a, e) => a + e.count, 0);
      title = `${n}: ${p.reason} warnings`;
      detail = join(`${p.reason} ×${count}`, `${p.kind.toLowerCase()} ${n}`);
      break;
    }
    case "cert": {
      const c = f.cert!;
      const left = time(c.notAfter) - now;
      title = p.reason === "Expired" ? `${n} expired ${age(time(c.notAfter), now)} ago`
        : p.reason === "Expiring" ? `${n} expires in ${age(now, now + left)}`
        : p.reason === "NotYetValid" ? `${n} isn't valid yet` : `${n} can't be read`;
      // A CN is whatever the Secret's writer put there: only a host name's shape goes into the text (part 2 review, 3).
      detail = join(c.subject && isName(c.subject.replace(/^\*\./, "")) ? `CN ${c.subject}` : "", c.unreadable ? "" : `not after ${c.notAfter.slice(0, 10)}`, f.usedBy?.length ? `used by ${f.usedBy.join(", ")}` : "");
      break;
    }
  }
  const hint = hintFor({
    class: p.class, reason: p.reason, name: n, ...(exitCode !== undefined ? { exitCode } : {}), ...(signal !== undefined ? { signal } : {}),
    ...(message ? { message } : {}), ...(isImageRef(f.image) ? { image: f.image } : {}),
    ...(f.probe ? { probe: { type: f.probe.type, how: f.probe.how } } : {}), ...(f.limit ? { limit: f.limit } : {}),
    ...(f.available ? { available: f.available } : {}), ...(p.restarts !== undefined ? { restarts: p.restarts } : {}),
  });
  return { ...rest, title, detail, hint };
}

// What kubectl would print as a pod's or node's status, and short ages. Pure functions, tested. Lists are read only
// when they are lists (security review of wave 10 part 1, L2: an object of another shape never throws here).
import type { KubeObject } from "@landlens/contracts";

const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);

export type Tone = "ok" | "warn" | "bad" | "muted";

/** kubectl's STATUS column: a waiting or terminated reason beats the phase; deleting pods say Terminating. */
export function podStatus(pod: KubeObject): { text: string; tone: Tone } {
  if (pod.metadata.deletionTimestamp) return { text: "Terminating", tone: "muted" };
  const s = pod.status ?? {};
  let reason = String(s.reason ?? s.phase ?? "Unknown");
  const inits = list(s.initContainerStatuses);
  for (let i = 0; i < inits.length; i++) {
    const c = inits[i];
    if (c?.state?.terminated?.exitCode === 0) continue;
    if (c?.state?.terminated) reason = `Init:${c?.state.terminated.reason || `ExitCode:${c?.state.terminated.exitCode}`}`;
    else if (c?.state?.waiting?.reason && c?.state.waiting.reason !== "PodInitializing") reason = `Init:${c?.state.waiting.reason}`;
    else reason = `Init:${i}/${list(pod.spec?.initContainers).length}`;
    return { text: reason, tone: toneFor(reason) };
  }
  let running = false;
  for (const c of [...list(s.containerStatuses)].reverse()) {
    if (c?.state?.waiting?.reason) reason = String(c.state.waiting.reason);
    else if (c?.state?.terminated?.reason) reason = String(c.state.terminated.reason);
    else if (c?.state?.terminated) reason = c?.state.terminated.signal ? `Signal:${c?.state.terminated.signal}` : `ExitCode:${c?.state.terminated.exitCode}`;
    else if (c?.state?.running && c?.ready) running = true;
  }
  if (reason === "Completed" && running) reason = "Running";
  return { text: reason, tone: toneFor(reason) };
}

function toneFor(reason: string): Tone {
  if (reason === "Running" || reason === "Succeeded" || reason === "Completed") return "ok";
  if (reason === "Pending" || reason === "ContainerCreating" || reason.startsWith("Init:") && /^Init:\d/.test(reason)) return "warn";
  return "bad";
}

export function podReady(pod: KubeObject): { text: string; tone: Tone; sort: number } {
  const cs = list(pod.status?.containerStatuses);
  const total = list(pod.spec?.containers).length || cs.length;
  const ready = cs.filter((c) => c?.ready).length;
  const done = pod.status?.phase === "Succeeded";
  return { text: `${ready}/${total}`, tone: ready === total || done ? "ok" : "warn", sort: total - ready };
}

export function podRestarts(pod: KubeObject): { text: string; tone: Tone; sort: number } {
  const n = list(pod.status?.containerStatuses).reduce((a: number, c: any) => a + (typeof c?.restartCount === "number" && Number.isFinite(c.restartCount) ? c.restartCount : 0), 0);
  return { text: String(n), tone: n > 5 ? "bad" : n > 0 ? "warn" : "muted", sort: n };
}

export function nodeStatus(node: KubeObject): { text: string; tone: Tone } {
  const ready = list(node.status?.conditions).find((c: any) => c?.type === "Ready");
  const parts = [ready?.status === "True" ? "Ready" : "NotReady"];
  if (node.spec?.unschedulable) parts.push("SchedulingDisabled");
  return { text: parts.join(","), tone: ready?.status === "True" && !node.spec?.unschedulable ? "ok" : "bad" };
}

export function nodeRoles(node: KubeObject): string {
  const roles = Object.keys(node.metadata.labels ?? {})
    .filter((l) => l.startsWith("node-role.kubernetes.io/"))
    .map((l) => l.slice("node-role.kubernetes.io/".length));
  return roles.join(",") || "<none>";
}

/** 45s, 12m, 3h, 5d, 2y: kubectl-style. */
export function age(then: number, now: number): string {
  if (!Number.isFinite(then)) return "";
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 120) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 730 ? `${d}d` : `${Math.floor(d / 365)}y`;
}

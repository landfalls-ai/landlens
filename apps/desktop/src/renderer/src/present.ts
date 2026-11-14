// Small presentation rules shared by the table, the drawer, the overview and the dock.
import type { KubeObject } from "@landlens/contracts";
import type { Tone } from "@landlens/kube/status";

/**
 * Split a generated name into the part you read and the generated suffix, so "orders-api-846c7f64f7-68999" reads as
 * "orders-api" with the hash dimmed. From the owner when there is one, else by shape.
 */
export function splitName(o: KubeObject): { base: string; hash: string } {
  const name = o.metadata.name;
  const owner = o.metadata.ownerReferences?.[0];
  if (owner && name.startsWith(owner.name + "-")) {
    const suffix = name.slice(owner.name.length);
    if (owner.kind === "ReplicaSet") {
      const h = o.metadata.labels?.["pod-template-hash"];
      if (h && owner.name.endsWith("-" + h)) return { base: owner.name.slice(0, -h.length - 1), hash: `-${h}${suffix}` };
    }
    if (owner.kind === "StatefulSet" && /^-\d+$/.test(suffix)) return { base: name, hash: "" };
    if (owner.kind === "ReplicaSet" || owner.kind === "DaemonSet" || owner.kind === "Deployment") return { base: owner.name, hash: suffix };
  }
  return splitByShape(name);
}

export function splitByShape(name: string): { base: string; hash: string } {
  const m = /^(.*?)(-[a-z0-9]{8,10}-[a-z0-9]{5}|-[a-z0-9]{5}|-[a-f0-9]{8,10})$/.exec(name);
  if (m && m[1] && /\d/.test(m[2]!)) return { base: m[1], hash: m[2]! };
  return { base: name, hash: "" };
}

/** "orders-api-…-68999": the middle hash elided, for one-line mentions. */
export function shortName(name: string): string {
  const m = /^(.*)-[a-z0-9]{8,10}-([a-z0-9]{5})$/.exec(name);
  return m && name.length > 26 ? `${m[1]}-…-${m[2]}` : name;
}

/** How a status word looks: Completed and Unknown are quiet, not green or red. */
export function statusTone(text: string, tone: Tone): Tone {
  if (text === "Completed" || text === "Succeeded" || text === "Unknown" || text === "Terminating") return "muted";
  return tone;
}

export function restartTone(n: number): { cls: string } {
  if (n >= 10) return { cls: "tone-bad" };
  if (n >= 5) return { cls: "tone-warn" };
  if (n >= 1) return { cls: "" };
  return { cls: "zero" };
}

/** Two letters for a cluster tile, and one of six gradients hashed from the name. */
export function clusterTile(name: string): { initials: string; g: string } {
  const initials = name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2) || "?";
  let h = 2166136261; // FNV-1a
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return { initials, g: `g${h % 6}` };
}

/** Copy text without asking for clipboard permission (Landlens grants none): a user gesture and execCommand. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // fall through
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

/** "4m 12s", "38s", "2h 5m": a duration in milliseconds. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

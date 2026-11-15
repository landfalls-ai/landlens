// One icon per resource kind, so the sidebar, the drawer, the overview and the dock agree; and the one way icons are
// drawn: lucide-react, inline SVG, stroke 1.75, aria-hidden, currentColor.
import {
  Bot, Box, CircleCheck, CircleDashed, CircleX, Clock, Copy, Cylinder, Database, FileText, Folder, Gauge, Globe, HardDrive,
  KeyRound, Layers, LayoutGrid, Link, Lock, Pencil, Play, Plug, Scale, ScrollText, Server, Shapes, Share2, Shield, SquareTerminal, User, Waypoints,
  type LucideIcon,
} from "lucide-react";
import type { Tone } from "@landlens/kube/status";

export type { LucideIcon };

const BY_RESOURCE: Record<string, LucideIcon> = {
  overview: LayoutGrid,
  mcp: Plug,
  agent: Bot,
  pods: Box,
  deployments: Layers,
  statefulsets: Database,
  daemonsets: Server,
  nodes: Server,
  replicasets: Copy,
  jobs: Play,
  cronjobs: Clock,
  services: Share2,
  ingresses: Globe,
  endpointslices: Waypoints,
  networkpolicies: Shield,
  configmaps: FileText,
  secrets: KeyRound,
  horizontalpodautoscalers: Gauge,
  poddisruptionbudgets: Scale,
  persistentvolumeclaims: HardDrive,
  persistentvolumes: Cylinder,
  storageclasses: Folder,
  serviceaccounts: User,
  roles: Lock,
  clusterroles: Lock,
  rolebindings: Link,
  clusterrolebindings: Link,
  namespaces: Folder,
};

/** Kind (as in `kind: Pod`) to its plural resource, for the kinds Landlens links between. */
export const RESOURCE_OF_KIND: Record<string, string> = {
  Pod: "pods", Deployment: "deployments", StatefulSet: "statefulsets", DaemonSet: "daemonsets", ReplicaSet: "replicasets",
  Job: "jobs", CronJob: "cronjobs", Node: "nodes", Service: "services", ConfigMap: "configmaps", Secret: "secrets",
  PersistentVolumeClaim: "persistentvolumeclaims", PersistentVolume: "persistentvolumes", Namespace: "namespaces",
  Ingress: "ingresses", ServiceAccount: "serviceaccounts",
};

export function kindIcon(resource: string): LucideIcon {
  return BY_RESOURCE[resource] ?? Shapes;
}

export function iconOfKind(kind: string): LucideIcon {
  return kindIcon(RESOURCE_OF_KIND[kind] ?? "");
}

/** The status shapes: never colour alone. */
export const TONE_ICON: Record<Tone, LucideIcon> = { ok: CircleCheck, warn: Clock, bad: CircleX, muted: CircleDashed };

export function Ic({ icon: I, size = 15, className }: { icon: LucideIcon; size?: number; className?: string }) {
  return <I size={size} strokeWidth={1.75} aria-hidden="true" focusable="false" className={className ? `ic ${className}` : "ic"} />;
}

/** ⌘ on macOS, Ctrl elsewhere: for key hints. */
export const MOD = /Mac/.test(navigator.platform) ? "⌘" : "Ctrl ";

/** A dock chip's icon: the object's kind, or logs or a terminal for selected lines. */
export function contextIcon(c: { ref?: { resource: string }; kind?: "logs" | "terminal" | "edit" }): LucideIcon {
  return c.ref ? kindIcon(c.ref.resource) : c.kind === "logs" ? ScrollText : c.kind === "edit" ? Pencil : SquareTerminal;
}

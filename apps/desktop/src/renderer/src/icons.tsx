// One icon per resource kind, so the sidebar, the drawer, the overview and the dock agree; and the one way icons are
// drawn: lucide-react, inline SVG, stroke 1.75, aria-hidden, currentColor.
import {
  Bot, Box, Cable, Cloud, CircleCheck, CircleDashed, CircleX, Clock, Copy, Cylinder, Database, FileText, Folder, Gauge, Globe, HardDrive,
  KeyRound, Layers, LayoutGrid, Link, Lock, Package, Pencil, Play, Plug, Scale, ScrollText, Server, Shapes, Share2, Shield, SquareTerminal, Stethoscope, User, Waypoints, Zap,
  Workflow, type LucideIcon,
} from "lucide-react";
import type { Tone } from "@landlens/kube/status";

export type { LucideIcon };

const BY_RESOURCE: Record<string, LucideIcon> = {
  overview: LayoutGrid,
  problems: Stethoscope,
  mcp: Plug,
  connections: Cable,
  gcp: Cloud,
  agent: Bot,
  helm: Package,
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
export function contextIcon(c: { ref?: { resource: string }; kind?: "logs" | "terminal" | "edit" | "helm" | "problem" | "gcp" | "landflow" | "action" }): LucideIcon {
  return c.kind === "problem" ? Stethoscope : c.kind === "action" ? Zap : c.kind === "landflow" ? Workflow : c.kind === "gcp" ? Cloud : c.ref ? kindIcon(c.ref.resource) : c.kind === "logs" ? ScrollText : c.kind === "edit" ? Pencil : c.kind === "helm" ? Package : SquareTerminal;
}

/**
 * The Land family's marks (wave 7), drawn as GitHub's and Linear's are: one filled shape in the ink colour, 24 units.
 * Clickland a histogram tile, Landflow two nodes and their flow, Landfall a beacon.
 */
export function SiblingMark({ sibling, size = 16 }: { sibling: "clickland" | "landflow" | "landfall"; size?: number }) {
  return (
    <svg className="conn-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {sibling === "clickland" ? (
        <path fill="currentColor" fillRule="evenodd" d="M5.5 2h13A3.5 3.5 0 0 1 22 5.5v13a3.5 3.5 0 0 1-3.5 3.5h-13A3.5 3.5 0 0 1 2 18.5v-13A3.5 3.5 0 0 1 5.5 2Zm1.25 11.5v5h2.6v-5Zm4.3-4v9h2.6v-9Zm4.3-3.5v12.5h2.6V6Z" />
      ) : sibling === "landflow" ? (
        <>
          <circle cx="5" cy="5.5" r="3.25" fill="currentColor" />
          <circle cx="19" cy="18.5" r="3.25" fill="currentColor" />
          <path d="M5 5.5c9.5 0 4.5 13 14 13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="12" cy="12" r="1.9" fill="currentColor" />
        </>
      ) : (
        <path fill="currentColor" d="M12 1.5 15.6 5H8.4L12 1.5ZM8.8 6h6.4v3H8.8V6Zm.4 4h5.6l1.7 12.5H7.5L9.2 10ZM1.5 5.2l5.8 1.9v1.8l-5.8 1.9V5.2Zm21 0v5.6l-5.8-1.9V7.1l5.8-1.9Z" />
      )}
    </svg>
  );
}

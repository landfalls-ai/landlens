// Which sidebar sections are folded (D139): every labelled block folds, the choice is kept in localStorage, and a
// folded header still says where the problems are. Pure rules here, so they are tested without a DOM
// (apps/desktop/test/nav-state.test.ts); Sidebar.tsx's useNavFolds holds the state.
import type { Problem } from "@landlens/contracts";
import type { Badge } from "./problemRules";

/** The sections that fold, global for every cluster. API-group folds inside Custom resources are per context. */
export const NAV_KEY = "landlens.nav.v1";
export const navGroupsKey = (context: string) => `landlens.nav.groups.${context}`;

/** The group above Pinned: Connections, MCP and Agent. */
export const WORKSPACE = "Workspace";
export const PINNED = "Pinned";
export const CLOUD = "Cloud";

/** Open until you fold them; every other section (each extra API group, Custom resources) starts folded. */
export const OPEN_BY_DEFAULT: readonly string[] = [WORKSPACE, PINNED, CLOUD, "Workloads", "Network", "Config", "Storage", "Access", "Cluster"];

/**
 * What you chose, both ways, so a default can change later without overriding a choice, and a section discovered
 * after start keeps its default until you open it.
 */
export type NavFolds = { closed: string[]; opened: string[] };
export const NO_FOLDS: NavFolds = { closed: [], opened: [] };

const MAX_IDS = 400;
const MAX_ID = 253;
const ids = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0 && s.length <= MAX_ID) ? [...new Set(v as string[])].slice(0, MAX_IDS) : undefined;

/** A stored value, or no choices for anything unusable (bad JSON, an old or hand-edited shape). */
export function readNavFolds(raw: string | null): NavFolds {
  if (raw === null || raw.trim() === "") return NO_FOLDS;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return NO_FOLDS;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return NO_FOLDS;
  const closed = ids((v as Record<string, unknown>).closed);
  const opened = ids((v as Record<string, unknown>).opened);
  if (!closed || !opened) return NO_FOLDS;
  // A section in both lists is a broken value: drop it, so the default decides.
  return { closed: closed.filter((s) => !opened.includes(s)), opened: opened.filter((s) => !closed.includes(s)) };
}

export const writeNavFolds = (f: NavFolds): string => JSON.stringify({ closed: f.closed, opened: f.opened });

/** Is a section open: what you chose, else its default (`byDefault`, or OPEN_BY_DEFAULT). */
export function isOpen(f: NavFolds, id: string, byDefault: (id: string) => boolean = (s) => OPEN_BY_DEFAULT.includes(s)): boolean {
  if (f.opened.includes(id)) return true;
  if (f.closed.includes(id)) return false;
  return byDefault(id);
}

/** Open or fold one section; the choice is recorded either way. */
export function setOpen(f: NavFolds, id: string, open: boolean): NavFolds {
  return setAll(f, [id], open);
}

/** Open or fold several at once (option-click, the ⌘K commands). */
export function setAll(f: NavFolds, list: readonly string[], open: boolean): NavFolds {
  const these = new Set(list);
  const closed = f.closed.filter((s) => !these.has(s));
  const opened = f.opened.filter((s) => !these.has(s));
  return open ? { closed, opened: [...opened, ...these] } : { closed: [...closed, ...these], opened };
}

/** Every top-level section's id, for fold all and unfold all. */
export const allSections = (sections: readonly string[]): string[] => [WORKSPACE, PINNED, CLOUD, ...sections];

/**
 * The rows under a header: all of them when it is open; when it is folded, only the page you are on, so you never
 * lose where you are (opened from ⌘K, a link, a pin or a problem). The stored choice is not changed.
 */
export function shownRows<T>(rows: readonly T[], open: boolean, active: (row: T) => boolean): T[] {
  return open ? [...rows] : rows.filter(active);
}

/** The kinds whose rows carry a problem badge, by resource (Workspace.tsx's badges.byResource). */
export const BADGED: Readonly<Record<string, string>> = {
  pods: "Pod", deployments: "Deployment", statefulsets: "StatefulSet", daemonsets: "DaemonSet", jobs: "Job",
  nodes: "Node", secrets: "Secret", persistentvolumeclaims: "PersistentVolumeClaim",
};

/**
 * A folded header's badge: the problems about any of its rows' kinds, each counted once (a Deployment's crash loop
 * marks both Deployments and Pods, D57, but is one problem). Failing wins over to-watch, as on a row. Only kinds whose
 * rows carry a badge count, so unfolding always shows where the number came from.
 */
export function rollUp(problems: readonly Problem[], resources: readonly string[]): Badge | undefined {
  const kinds = new Set(resources.map((r) => BADGED[r]).filter((k): k is string => !!k));
  if (!kinds.size) return undefined;
  const mine = problems.filter((p) => kinds.has(p.kind) || (kinds.has("Pod") && p.podCount > 0));
  const bad = mine.filter((p) => p.tone === "bad").length;
  if (bad) return { tone: "bad", n: bad };
  return mine.length ? { tone: "warn", n: mine.length } : undefined;
}

/** "3 problems", "1 thing to watch": a badge in words, for titles and screen readers. */
export function badgeWords(b: Badge): string {
  return b.tone === "bad" ? `${b.n} ${b.n === 1 ? "problem" : "problems"}` : `${b.n} ${b.n === 1 ? "thing to watch" : "things to watch"}`;
}

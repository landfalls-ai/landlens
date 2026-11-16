// Saved views (wave 10 part 4, D216): userData/views.json, mode 0600, written whole to a temporary file and renamed, at
// most 200. Each entry is checked again when read (the document by render_view's schema and the credential check, the
// scope, the tweaks), so a hand-edited or damaged file shows fewer views, never a view that skipped a check. A saved
// view holds the document, the person's tweaks, its scope and namespaces: never rows, a token, a session or the chat.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { NamespaceName } from "@landlens/contracts";
import { credentialIssues, parseDocument, SavedName, Tweaks, VIEW_LIMITS, type ViewDocument } from "@landlens/views";
import { z } from "zod";

export type SavedScope = { kind: "cluster"; context: string; server: string } | { kind: "any" };
export type SavedView = {
  id: string;
  name: string;
  document: ViewDocument;
  tweaks?: Tweaks;
  scope: SavedScope;
  /** A cluster-scoped view's namespace limit, as the session it was built in had; an import's, as the person chose. */
  namespaces?: string[];
  origin: "claude" | "imported";
  /** An imported view's app blocks: the person said Run custom blocks in the native dialog (D217). */
  appsTrusted?: boolean;
  savedAt: number;
};
/** What the sidebar, ⌘K and the list show: names, never documents. */
export type SavedSummary = { id: string; name: string; scope: "cluster" | "any"; context?: string; origin: "claude" | "imported"; savedAt: number; apps: number; appsTrusted: boolean };

const Id = z.string().regex(/^[0-9a-f]{16}$/);
const Scope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cluster"), context: z.string().min(1).max(253), server: z.string().min(1).max(2048) }).strict(),
  z.object({ kind: z.literal("any") }).strict(),
]);
const Entry = z.object({
  id: Id, name: SavedName, document: z.unknown(), tweaks: Tweaks.optional(), scope: Scope,
  namespaces: z.array(NamespaceName).min(1).max(20).optional(), origin: z.enum(["claude", "imported"]), appsTrusted: z.boolean().optional(),
  savedAt: z.number().int().nonnegative(),
}).strict();

export const STORE_NOTES = {
  full: `You have ${VIEW_LIMITS.saved} saved views: delete one to save another.`,
  notFound: "That saved view isn't here any more.",
  badName: "A name is one line of at most 60 characters.",
  credential: "This view's text looks like it holds a credential, so Landlens doesn't keep it.",
} as const;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export class ViewStore {
  private cache?: SavedView[];
  /** How many entries the last read dropped (a damaged or hand-edited file). */
  dropped = 0;

  constructor(private readonly path: string, private readonly now: () => number = Date.now) {}

  private read(): SavedView[] {
    if (this.cache) return this.cache;
    let raw: unknown = [];
    if (existsSync(this.path)) {
      try {
        raw = JSON.parse(readFileSync(this.path, "utf8"));
      } catch {
        raw = [];
      }
    }
    const out: SavedView[] = [];
    let dropped = 0;
    for (const e of Array.isArray(raw) ? raw.slice(0, VIEW_LIMITS.saved) : []) {
      const v = checked(e);
      if (v && !out.some((o) => o.id === v.id)) out.push(v);
      else dropped++;
    }
    this.dropped = dropped + (Array.isArray(raw) ? Math.max(0, raw.length - VIEW_LIMITS.saved) : 0);
    this.cache = out;
    return out;
  }

  private write(all: SavedView[]) {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
    this.cache = all;
  }

  /** Newest first. */
  list(): SavedSummary[] {
    return [...this.read()].sort((a, b) => b.savedAt - a.savedAt).map(summary);
  }

  get(id: string): SavedView | undefined {
    const v = this.read().find((x) => x.id === id);
    return v ? structuredClone(v) : undefined;
  }

  /** A new saved view; checked as a read would check it, so what is saved can always be read back. */
  add(v: Omit<SavedView, "id" | "savedAt">): SavedView {
    const all = this.read();
    if (all.length >= VIEW_LIMITS.saved) throw fail(409, STORE_NOTES.full);
    const entry: SavedView = { ...structuredClone(v), id: randomBytes(8).toString("hex"), savedAt: this.now() };
    if (!SavedName.safeParse(entry.name).success) throw fail(400, STORE_NOTES.badName);
    if (credentialIssues(entry.document).length || credentialIssues(entry.name).length) throw fail(400, STORE_NOTES.credential);
    if (!checked(entry)) throw fail(400, "This view can't be saved.");
    this.write([...all, entry]);
    return structuredClone(entry);
  }

  /** The same view with a new document (Save again after a follow-up), keeping its id, name, scope and tweaks. */
  replace(id: string, document: ViewDocument, extra: { namespaces?: string[] } = {}): SavedView {
    const all = this.read();
    const i = all.findIndex((x) => x.id === id);
    if (i < 0) throw fail(404, STORE_NOTES.notFound);
    if (credentialIssues(document).length) throw fail(400, STORE_NOTES.credential);
    const next: SavedView = { ...all[i]!, document: structuredClone(document), savedAt: this.now(), ...(extra.namespaces && all[i]!.scope.kind === "cluster" ? { namespaces: extra.namespaces } : {}) };
    if (!checked(next)) throw fail(400, "This view can't be saved.");
    this.write(all.map((x, j) => (j === i ? next : x)));
    return structuredClone(next);
  }

  rename(id: string, name: string): SavedSummary {
    if (!SavedName.safeParse(name).success) throw fail(400, STORE_NOTES.badName);
    if (credentialIssues(name).length) throw fail(400, STORE_NOTES.credential);
    return summary(this.update(id, (v) => ({ ...v, name })));
  }

  duplicate(id: string): SavedSummary {
    const v = this.get(id);
    if (!v) throw fail(404, STORE_NOTES.notFound);
    const name = `${v.name.slice(0, 53)} (copy)`;
    const { id: _id, savedAt: _at, ...rest } = v;
    return summary(this.add({ ...rest, name }));
  }

  remove(id: string): void {
    const all = this.read();
    if (!all.some((x) => x.id === id)) throw fail(404, STORE_NOTES.notFound);
    this.write(all.filter((x) => x.id !== id));
  }

  setTweaks(id: string, tweaks: Tweaks): void {
    const t = Tweaks.safeParse(tweaks);
    if (!t.success) throw fail(400, "not a view's sort or widths");
    this.update(id, (v) => ({ ...v, tweaks: t.data }), false);
  }

  trustApps(id: string): void {
    this.update(id, (v) => ({ ...v, appsTrusted: true }), false);
  }

  private update(id: string, f: (v: SavedView) => SavedView, touch = true): SavedView {
    const all = this.read();
    const i = all.findIndex((x) => x.id === id);
    if (i < 0) throw fail(404, STORE_NOTES.notFound);
    const next = { ...f(all[i]!), ...(touch ? { savedAt: this.now() } : {}) };
    this.write(all.map((x, j) => (j === i ? next : x)));
    return structuredClone(next);
  }
}

/** An entry as it stands on disk, or undefined when any of it fails a check. */
function checked(e: unknown): SavedView | undefined {
  const r = Entry.safeParse(e);
  if (!r.success) return undefined;
  const d = parseDocument(r.data.document);
  if (!d.ok || credentialIssues(d.document).length || credentialIssues(r.data.name).length) return undefined;
  // A namespace limit is the building session's (This cluster) or the person's choice at import (D217), nothing else.
  if (r.data.namespaces && r.data.scope.kind !== "cluster" && r.data.origin !== "imported") return undefined;
  const { document: _d, ...rest } = r.data;
  return { ...rest, document: d.document } as SavedView;
}

function summary(v: SavedView): SavedSummary {
  const apps = v.document.blocks.filter((b) => b.type === "app").length;
  return {
    id: v.id, name: v.name, scope: v.scope.kind, ...(v.scope.kind === "cluster" ? { context: v.scope.context } : {}), origin: v.origin, savedAt: v.savedAt,
    apps, appsTrusted: v.origin === "claude" || !!v.appsTrusted,
  };
}

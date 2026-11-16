// D214: every change Claude makes to a view is a version, and undo is the person's. Each accepted render_view or
// patch_view is a version whose parent is the version shown when Claude made it; Undo shows the parent, Redo the newest
// version made on top of the one shown. Moving never calls Claude, and a patch must name the shown version as its base,
// so Claude never patches a version the person left. The last 20 versions are kept, in main only.
import { VIEW_LIMITS } from "./limits.js";
import type { ViewDocument } from "./schema.js";

export type Version = { version: number; parent?: number; document: ViewDocument; note?: string; at: number; by: "claude" };

export class ViewHistory {
  private readonly list: Version[] = [];
  private shownAt = 0;
  /** Who chose the shown version: Claude's newest change, or the person (Undo, Redo). */
  shownBy: "claude" | "you" = "claude";

  constructor(private readonly keep: number = VIEW_LIMITS.versions) {
    if (!Number.isInteger(keep) || keep < 1 || keep > VIEW_LIMITS.versions) throw new RangeError("versions kept must be from 1 to 20");
  }

  /** The shown version's number (0 before the first). */
  get shown(): number {
    return this.shownAt;
  }

  /** The shown version, if any. */
  current(): Version | undefined {
    return this.find(this.shownAt);
  }

  find(n: number): Version | undefined {
    return this.list.find((v) => v.version === n);
  }

  /** Every version kept, oldest first. */
  versions(): readonly Version[] {
    return this.list;
  }

  /** Claude's new version, on top of the one shown; it is shown now. The oldest goes past the cap. */
  add(document: ViewDocument, note: string | undefined, at: number): Version {
    const version = (this.list.at(-1)?.version ?? 0) + 1;
    const v: Version = { version, ...(this.shownAt ? { parent: this.shownAt } : {}), document, ...(note ? { note } : {}), at, by: "claude" };
    this.list.push(v);
    while (this.list.length > this.keep) this.list.shift();
    this.shownAt = version;
    this.shownBy = "claude";
    return v;
  }

  /** The version Undo would show: the shown one's parent, while it is still kept. */
  undoTarget(): number | undefined {
    const p = this.current()?.parent;
    return p !== undefined && this.find(p) ? p : undefined;
  }

  /** The version Redo would show: the newest kept version made on top of the shown one. */
  redoTarget(): number | undefined {
    if (!this.shownAt) return undefined;
    return this.list.filter((v) => v.parent === this.shownAt).at(-1)?.version;
  }

  /** Show a version the person chose (Undo, Redo, or one from the list): it must be kept. */
  show(n: number): Version {
    const v = this.find(n);
    if (!v) throw Object.assign(new Error("That version isn't kept any more."), { status: 404 });
    if (n !== this.shownAt) {
      this.shownAt = n;
      this.shownBy = "you";
    }
    return v;
  }
}

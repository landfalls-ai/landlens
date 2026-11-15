// The action log (wave 8, D147): one kept row per action the person applied (and, in part 4, per Secret value shown
// or copied), in userData/actions.json, the newest 500. Rows are made only by `logEntry` from checked names, numbers
// and closed words: no diff, no message from the cluster, no value. The file is mode 0600, written to a temp file and
// renamed, read through a strict schema (a row with a field it doesn't know, or a name that isn't one, is dropped), and
// moved aside if it can't be read at all (the pattern of family-sent.json). A row is written as `sent` before its
// requests go and settled when they answer (security review of part 1, M3); the schema takes every kind, context and
// count Kubernetes allows, so no applied action goes unlogged. The log is a convenience record kept on this computer,
// not evidence: anything running as you can edit it (L6); the front door's audit is the record of what was sent.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { GroupName, ObjectName, ResourceName, type ActionLogEntry } from "@landlens/contracts";
import { z } from "zod";

export const ACTION_LOG_MAX = 500;
/** A file larger than this is treated as damaged and moved aside, unread (L6). */
export const ACTION_LOG_BYTES = 4 * 1024 * 1024;
const ACTIONS = ["scale", "restart", "delete", "trigger", "suspend", "resume", "cordon", "uncordon", "drain", "reveal", "copy"] as const;
const OUTCOMES = ["sent", "applied", "partial", "failed", "conflict", "cancelled", "stopped"] as const;
/** A kind as a CRD may name it: a DNS-1035 label once lowercased (`fooBar`, `my-Kind`). */
const KIND = /^[A-Za-z](?:[-A-Za-z0-9]{0,61}[A-Za-z0-9])?$/;
const NAMESPACE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/** A Secret key's name (part 4): Kubernetes's rule. */
const KEY = /^[-._a-zA-Z0-9]{1,253}$/;
/** The closed forms a detail may take: "2 → 3 replicas" (from any count the cluster had), "5 of 6", "9 evicted, 1 blocked". */
const DETAIL = /^(?:\d{1,10} → \d{1,4} replicas?|\d{1,3} of \d{1,3}|\d{1,6} evicted, \d{1,6} blocked)$/;
/** A context name as the row keeps it: one line of printable text, at most 253 characters (fitContext). */
const CONTEXT = /^[^\u0000-\u001f\u007f]{1,253}$/;

/** A context as the log keeps it (M3): control characters become "?" and the name is cut to 253, never dropped. */
export const fitContext = (c: string) => (c.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 253) || "?");
/** A kind that isn't one becomes "Object": the row is kept (M3). */
const fitKind = (k: string) => (k.length <= 63 && KIND.test(k) ? k : "Object");

const Entry = z.object({
  id: z.string().regex(/^ac[A-Za-z0-9_-]{16}$/),
  at: z.string().datetime(),
  context: z.string().regex(CONTEXT),
  server: z.string().regex(/^[0-9a-f]{16}$/),
  who: z.literal("you"),
  action: z.enum(ACTIONS),
  kind: z.string().max(63).regex(KIND),
  group: GroupName.optional(),
  resource: ResourceName.optional(),
  namespace: z.string().max(63).regex(NAMESPACE).optional(),
  names: z.array(ObjectName).min(1).max(50),
  key: z.string().regex(KEY).optional(),
  detail: z.string().regex(DETAIL).optional(),
  outcome: z.enum(OUTCOMES),
}).strict();
const File = z.object({ version: z.literal(1), entries: z.array(z.unknown()).max(ACTION_LOG_MAX * 2) }).strict();

/** A cluster's API server address as family-sent.json keeps it: the first 16 hex digits of its SHA-256. */
export const serverHash = (server: string) => createHash("sha256").update(server).digest("hex").slice(0, 16);

export type LogInput = Omit<ActionLogEntry, "id" | "at" | "server" | "who"> & { server: string; at?: number };

/** The only way a row is made: every field checked, or nothing (throws). The context and kind are made to fit (M3). */
export function logEntry(i: LogInput): ActionLogEntry {
  return Entry.parse({
    id: `ac${randomBytes(12).toString("base64url")}`,
    at: new Date(i.at ?? Date.now()).toISOString(),
    context: fitContext(i.context),
    server: serverHash(i.server),
    who: "you",
    action: i.action,
    kind: fitKind(i.kind),
    ...(i.group !== undefined ? { group: i.group } : {}),
    ...(i.resource !== undefined ? { resource: i.resource } : {}),
    ...(i.namespace !== undefined ? { namespace: i.namespace } : {}),
    names: i.names,
    ...(i.key !== undefined ? { key: i.key } : {}),
    ...(i.detail !== undefined ? { detail: i.detail } : {}),
    outcome: i.outcome,
  }) as ActionLogEntry;
}

export class ActionLog {
  private entries: ActionLogEntry[];
  /** Rows the file couldn't take (a full disk, a read-only file): kept for this launch. */
  private failed = false;
  constructor(private readonly path: string) {
    this.entries = this.read();
  }

  private read(): ActionLogEntry[] {
    if (!existsSync(this.path)) return [];
    try {
      // A file too large to be the log is damaged: it is moved aside unread, so it can't stall launch (L6).
      if (statSync(this.path).size > ACTION_LOG_BYTES) throw new Error("too large");
      const f = File.parse(JSON.parse(readFileSync(this.path, "utf8")));
      return f.entries.flatMap((e) => {
        const r = Entry.safeParse(e);
        return r.success ? [r.data as ActionLogEntry] : [];
      }).slice(-ACTION_LOG_MAX);
    } catch {
      try {
        renameSync(this.path, `${this.path}.damaged-${Date.now()}`);
      } catch {
        // gone already
      }
      return [];
    }
  }

  private write() {
    const tmp = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, entries: this.entries }, null, 2), { mode: 0o600, flag: "wx" });
      renameSync(tmp, this.path);
      chmodSync(this.path, 0o600);
      this.failed = false;
    } catch {
      rmSync(tmp, { force: true });
      this.failed = true;
    }
  }

  /** A row made by logEntry; checked again, kept, written. */
  add(e: ActionLogEntry): ActionLogEntry {
    const checked = Entry.parse(e) as ActionLogEntry;
    this.entries = [...this.entries, checked].slice(-ACTION_LOG_MAX);
    this.write();
    return checked;
  }

  /** A `sent` row's ending (M3): its outcome, and a closed detail; checked again, written. A row that's gone is left. */
  settle(id: string, end: Pick<ActionLogEntry, "outcome"> & { detail?: string }): void {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i < 0) return;
    const { detail: _old, ...row } = this.entries[i]!;
    const next = Entry.parse({ ...row, ...(end.detail !== undefined ? { detail: end.detail } : _old !== undefined ? { detail: _old } : {}), outcome: end.outcome }) as ActionLogEntry;
    this.entries = this.entries.map((e, n) => (n === i ? next : e));
    this.write();
  }

  /** A cluster's rows, newest first: its context and its API server both match (L7). */
  list(context: string, server: string, limit = 50): ActionLogEntry[] {
    const c = fitContext(context);
    const s = serverHash(server);
    return this.entries.filter((e) => e.context === c && e.server === s).slice(-Math.max(1, Math.min(200, limit))).reverse();
  }

  /** Whether the last write failed (the rows are still here for this launch). */
  get unsaved(): boolean {
    return this.failed;
  }
}

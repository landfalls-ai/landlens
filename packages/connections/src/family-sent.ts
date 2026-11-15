// What Landlens sent to Landflow's triage (docs/family.md#what-was-sent, wave 7 D124): userData/family-sent.json, mode
// 0600, written through a new temp file and a rename. Per send: the alert's id, the cluster, the problem's id, its
// title and severity, when, Landflow's address and the run's ids, a hash of the cluster's API server address (two
// kubeconfigs may both call a context `default`: review of part 4, L6), and once the run is read, Landfall's outcome
// and the room's address. No key, secret, header or body: nothing here can reach Landflow again. The last 200 are kept, none
// older than 7 days. A damaged file is set aside and the list starts empty.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { LANDFLOW_ID } from "@landlens/contracts";
import { z } from "zod";

export const SENT = { max: 200, days: 7 } as const;

const ID = LANDFLOW_ID;
const line = (max: number) => z.string().max(max).regex(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u);
const Entry = z.object({
  run: z.string().regex(/^lr[A-Za-z0-9_-]{20,40}$/),
  alert: line(600),
  cluster: line(253),
  /** The first 16 hex digits of the SHA-256 of the cluster's API server address. */
  server: z.string().regex(/^[0-9a-f]{16}$/),
  problem: line(600),
  title: line(200),
  severity: z.enum(["sev1", "sev2", "sev3", "sev4"]),
  at: z.string().max(40),
  origin: z.string().max(300).regex(/^https?:\/\/[^/\s]+$/),
  executionId: z.string().regex(ID).optional(),
  workflowId: z.string().regex(ID).optional(),
  status: z.enum(["running", "queued", "waiting", "success", "error", "canceled"]).optional(),
  outcome: z.enum(["opened", "attached", "recorded", "ignored", "suppressed"]).optional(),
  room: z.string().max(2_000).regex(/^https?:\/\/\S+$/).optional(),
}).strict();
export type SentEntry = z.infer<typeof Entry>;
/** Whether an entry would be kept as it is (main checks before it sends: review of part 4, L1). */
export const sentEntryOk = (e: SentEntry): boolean => Entry.safeParse(e).success;
const File = z.object({ version: z.literal(1), sent: z.array(Entry).max(SENT.max) }).strict();

export class FamilySentStore {
  private entries: SentEntry[];
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {
    this.entries = this.read();
  }

  private read(): SentEntry[] {
    if (!existsSync(this.path)) return [];
    try {
      return File.parse(JSON.parse(readFileSync(this.path, "utf8"))).sent;
    } catch {
      try {
        renameSync(this.path, `${this.path}.damaged-${Date.now()}`);
      } catch {
        // gone already
      }
      return [];
    }
  }

  private fresh(): SentEntry[] {
    const after = this.now() - SENT.days * 86_400_000;
    return this.entries.filter((e) => Date.parse(e.at) >= after).slice(-SENT.max);
  }

  private write() {
    this.entries = this.fresh();
    const tmp = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(File.parse({ version: 1, sent: this.entries }), null, 2), { mode: 0o600, flag: "wx" });
      renameSync(tmp, this.path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    chmodSync(this.path, 0o600);
  }

  /** A send, recorded as it was made (checked against the file's shape first). */
  add(e: SentEntry) {
    const checked = Entry.parse(e);
    this.entries = [...this.entries.filter((x) => x.run !== checked.run), checked];
    this.write();
  }

  /** What a later read of the run found. */
  update(run: string, patch: Partial<Pick<SentEntry, "status" | "outcome" | "room" | "workflowId">>) {
    const i = this.entries.findIndex((e) => e.run === run);
    if (i < 0) return;
    const next = Entry.parse({ ...this.entries[i], ...patch });
    if (JSON.stringify(next) === JSON.stringify(this.entries[i])) return;
    this.entries[i] = next;
    this.write();
  }

  get(run: string): SentEntry | undefined {
    return this.fresh().find((e) => e.run === run);
  }

  /** The sends from one cluster (its context name and its API server's hash), newest first. */
  forCluster(cluster: string, server: string): SentEntry[] {
    return this.fresh().filter((e) => e.cluster === cluster && e.server === server).reverse();
  }
}

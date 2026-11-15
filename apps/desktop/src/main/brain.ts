// A session's summary to Landflow's brain (docs/family.md#a-sessions-summary-to-the-brain, wave 7 D134–D135). Main
// keeps each session's facts (questions, tool calls, cluster reads, changes; never their text), drafts one private
// `work.session` event by rule, and keeps it under a sheet owned by the window that asked, with the digest of the
// fields main fills. The window edits the text and sends with the sheet and the digest: main refuses a sheet it didn't
// make, another window's, an old one, or a session that moved on since; refuses text whose scrub would change it (so
// what is sent is what was shown); checks Landflow's own rules; asks in main's own dialog, showing the text, before an
// event anyone else will see (team or org; review of part 5, M4); then POSTs with the key it holds. Nothing is sent but
// on the person's click, and the person's Landflow is the only place it goes. A window's sheets go with it (L7).
import { createHash, randomBytes } from "node:crypto";
import { BRAIN_NOTES, BRAIN_PROMPT, clusterLabel, type AgentChange, type AgentHistoryEntry, type BrainDraft, type BrainSend, type McpCall, type WorkDraft, type WorkVisibility } from "@landlens/contracts";
import { checkWork, draftWork, factLines, FamilyError, recordWork, removeWork, type SessionFacts } from "@landlens/connections";
import { rawError } from "@landlens/mcp-gateway";
import { redactText } from "@landlens/kube-mcp";
import { problemTitleOf } from "@landlens/telemetry";
import type { AgentObserver } from "./agent";

export const BRAIN = { sheetMs: 30 * 60_000, sheets: 20, draftChars: 500 } as const;

/** The window that asked: its WebContents in the app, which says when it is destroyed. */
type Owner = object & { once?(event: "destroyed", f: () => void): unknown };
type Confirm = (q: { message: string; detail: string; yes: string }) => Promise<boolean>;
const AUDIENCE: Record<WorkVisibility, string> = { private: "only you", team: "your team", org: "everyone in your organisation" };
type Ledger = { tools: number; reads: number; proposed: number; problem?: string };
type Sheet = { owner: Owner; at: number; session: string; fixed: Omit<WorkDraft, "title" | "summary" | "visibility" | "team" | "initiative">; digest: string };

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const digestOf = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** The fields main fills, from the session's record: what the digest covers. */
const fixedOf = (e: WorkDraft): Sheet["fixed"] => ({
  kind: e.kind, source: e.source, sourceId: e.sourceId, occurredAt: e.occurredAt, ...(e.endedAt ? { endedAt: e.endedAt } : {}), turns: e.turns,
});

export type BrainDeps = {
  family: { landflowUse(): { origin: string; key: string; can: { brain: boolean } } | undefined; log(line: string): void };
  history: { get(session: string): AgentHistoryEntry | undefined };
  agent: { isOpen(session: string): boolean; draft(session: string, prompt: string): Promise<string>; cancelDraft?(session: string): Promise<boolean> };
  /** The name the person set for a context's graphs in Clickland, if any (the draft's title falls back by clusterLabel). */
  clusterName?(context: string): string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
};

export class BrainService {
  private readonly ledgers = new Map<string, Ledger>();
  private readonly sheets = new Map<string, Sheet>();
  /** Calls and changes already counted (each is reported more than once as it moves). */
  private readonly seen = new Set<string>();
  /** Windows whose going away already drops their sheets. */
  private readonly watched = new WeakSet<object>();
  /** One audience dialog at a time. */
  private asking = false;

  constructor(private readonly d: BrainDeps) {}

  private get now() {
    return (this.d.now ?? Date.now)();
  }

  private ledger(session: string): Ledger {
    let l = this.ledgers.get(session);
    if (!l) this.ledgers.set(session, (l = { tools: 0, reads: 0, proposed: 0 }));
    return l;
  }

  private once(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 5_000) this.seen.delete(this.seen.values().next().value!);
    return true;
  }

  /** The agent's hooks: the first problem a question was about, from the doctor's brief (a checked title, no more). */
  readonly observer: AgentObserver = {
    asked: (session, text, _refs, draft) => {
      if (draft) return;
      const l = this.ledger(session);
      l.problem ??= problemTitleOf(text);
    },
  };

  /** A gateway call that ended: a tool call, and a cluster read when landlens-kube ran it. */
  call(c: McpCall) {
    if (c.status !== "ok" || c.origin !== "agent" || !this.once(`c${c.id}`)) return;
    const l = this.ledger(c.session);
    l.tools++;
    if (c.server === "landlens-kube") l.reads++;
  }

  /** A change the agent proposed. Applied and rejected are the history's own counts. */
  change(c: AgentChange) {
    if (c.state === "waiting" && this.once(`p${c.id}`)) this.ledger(c.session).proposed++;
  }

  facts(session: string): SessionFacts | undefined {
    const e = this.d.history.get(session);
    if (!e) return undefined;
    const l = this.ledgers.get(session) ?? { tools: 0, reads: 0, proposed: 0 };
    // The cluster's name for graphs, else a plain context name; never a GKE project, an account id or a user (L3).
    const cluster = clusterLabel(this.d.clusterName?.(e.context), e.context);
    return {
      session, ...(cluster ? { cluster } : {}), ...(e.namespaces?.length ? { namespaces: e.namespaces } : {}), ...(l.problem ? { problem: l.problem } : {}),
      createdAt: e.createdAt, updatedAt: e.updatedAt, questions: e.prompts, tools: l.tools, reads: l.reads,
      proposed: Math.max(l.proposed, e.applied + e.rejected), applied: e.applied, rejected: e.rejected,
    };
  }

  private landflow() {
    const lf = this.d.family.landflowUse();
    if (!lf) throw fail(409, BRAIN_NOTES.notReady);
    if (!lf.can.brain) throw fail(403, BRAIN_NOTES.noBrain);
    return lf;
  }

  private failure(err: unknown): Error & { status: number } {
    if (err instanceof FamilyError) {
      if (err.raw !== undefined) this.d.family.log(`[brain] ${rawError(err.raw)}`);
      return fail(err.status, err.message);
    }
    if (typeof (err as { status?: unknown })?.status === "number") return err as Error & { status: number };
    this.d.family.log(`[brain] ${rawError(err)}`);
    return fail(502, "Landflow's answer wasn't what Landlens expected.");
  }

  private sheet(key: string, owner: Owner): Sheet {
    const s = this.sheets.get(key);
    if (!s || s.owner !== owner || this.now - s.at > BRAIN.sheetMs) throw fail(404, BRAIN_NOTES.noSheet);
    return s;
  }

  /** The sheet (D134): the event drafted by rule from the session's record, private, and the facts it came from. */
  draft(session: string, owner: Owner): BrainDraft {
    const lf = this.landflow();
    const f = this.facts(session);
    if (!f) throw fail(404, "Landlens has no such session in its history.");
    const event = draftWork(f);
    const fixed = fixedOf(event);
    const digest = digestOf(fixed);
    const now = this.now;
    for (const [k, v] of this.sheets) if (now - v.at > BRAIN.sheetMs) this.sheets.delete(k);
    if (this.sheets.size >= BRAIN.sheets) this.sheets.delete([...this.sheets.entries()].sort((a, b) => a[1].at - b[1].at)[0]![0]);
    const key = `bs${randomBytes(18).toString("base64url")}`;
    this.sheets.set(key, { owner, at: now, session, fixed, digest });
    // The window's sheets go when it does (L7), as its watches do.
    if (!this.watched.has(owner) && typeof owner.once === "function") {
      this.watched.add(owner);
      owner.once("destroyed", () => this.dropFor(owner));
    }
    return { sheet: key, digest, to: new URL(lf.origin).host, event, facts: factLines(f), open: this.d.agent.isOpen(session) };
  }

  /**
   * "Ask Claude to draft" (D134): one turn in the open session with main's fixed prompt; the answer goes in the box,
   * scrubbed and cut to 500 characters, still editable. The window's text never reaches the prompt. The turn runs with
   * no tool (the agent refuses each; review of part 5, L4) and can be cancelled from the sheet.
   */
  async ask(key: string, owner: Owner): Promise<{ summary: string }> {
    const s = this.sheet(key, owner);
    if (!this.d.agent.isOpen(s.session)) throw fail(409, BRAIN_NOTES.closed);
    let text: string;
    try {
      text = await this.d.agent.draft(s.session, BRAIN_PROMPT);
    } catch (err) {
      const e = err as { busy?: boolean; cancelled?: boolean; tool?: boolean };
      if (e?.busy) throw fail(409, BRAIN_NOTES.busy);
      if (e?.tool) throw fail(409, BRAIN_NOTES.draftTool);
      if (e?.cancelled) throw fail(409, BRAIN_NOTES.draftCancelled);
      throw err;
    }
    // The sheet was made before this turn: its digest still names the same fields (the history doesn't count it).
    const one = redactText(text).replace(/\s+/g, " ").trim();
    return { summary: one.length > BRAIN.draftChars ? `${one.slice(0, BRAIN.draftChars - 1)}…` : one };
  }

  /** The sheet's Cancel while Claude drafts: the draft's turn is cancelled (L4). */
  async cancel(key: string, owner: Owner): Promise<{ ok: boolean }> {
    const s = this.sheet(key, owner);
    return { ok: (await this.d.agent.cancelDraft?.(s.session)) ?? false };
  }

  /**
   * Send the sheet (D134–D135): main's fields as the sheet showed them (the digest), the person's text as typed. A
   * session that moved on since is refused (look again); text the scrub would change is refused with the scrubbed text,
   * so what goes is exactly what the person sees; then Landflow's own rules, then the POST.
   */
  async send(req: { sheet: string; digest: string; title: string; summary: string; visibility: WorkVisibility; team?: string; initiative?: string }, owner: Owner, confirm?: Confirm): Promise<BrainSend> {
    const s = this.sheet(req.sheet, owner);
    if (s.digest !== req.digest) throw fail(409, BRAIN_NOTES.changed);
    const f = this.facts(s.session);
    if (!f || digestOf(fixedOf(draftWork(f))) !== s.digest) throw fail(409, BRAIN_NOTES.changed);
    const text = { title: req.title.trim(), summary: req.summary.trim(), ...(req.team?.trim() ? { team: req.team.trim() } : {}), ...(req.initiative?.trim() ? { initiative: req.initiative.trim() } : {}) };
    const scrubbed = Object.fromEntries(Object.entries(text).map(([k, v]) => [k, redactText(v)])) as typeof text;
    if (Object.entries(text).some(([k, v]) => scrubbed[k as keyof typeof text] !== v)) return { saved: false, note: BRAIN_NOTES.scrubbed, scrubbed };
    const event: WorkDraft = { ...s.fixed, ...text, visibility: req.visibility };
    const problem = checkWork(event);
    if (problem) return { saved: false, note: problem };
    const lf = this.landflow();
    // An event others will see is the window's text under the person's name: main's own dialog shows it first (M4).
    if (req.visibility !== "private") {
      if (!confirm) return { saved: false, note: BRAIN_NOTES.declined };
      if (this.asking) throw fail(409, BRAIN_NOTES.dialogOpen);
      this.asking = true;
      let yes: boolean;
      try {
        const host = new URL(lf.origin).host;
        yes = await confirm({
          message: `Share this summary with ${AUDIENCE[req.visibility]} in ${host}'s brain?`,
          detail: [
            `Landflow at ${host} will save it under your name, and ${AUDIENCE[req.visibility]} will see it:`, "",
            `Title: ${event.title}`, "", `Summary: ${event.summary || "(none)"}`,
            ...(event.team ? ["", `Team: ${event.team}`] : []), ...(event.initiative ? ["", `Initiative: ${event.initiative}`] : []),
          ].join("\n"),
          yes: req.visibility === "team" ? "Share with my team" : "Share with everyone",
        });
      } finally {
        this.asking = false;
      }
      if (!yes) return { saved: false, note: BRAIN_NOTES.declined };
    }
    let a;
    try {
      a = await recordWork({ origin: lf.origin, key: lf.key, event, ...(this.d.fetch ? { fetch: this.d.fetch } : {}) });
    } catch (err) {
      throw this.failure(err);
    }
    if (!a.saved) return { saved: false, note: a.reason };
    return { saved: true, note: req.visibility === "team" ? BRAIN_NOTES.savedTeam : req.visibility === "org" ? BRAIN_NOTES.savedOrg : BRAIN_NOTES.saved };
  }

  /** Remove from the brain: the session's event, if Landflow has one. Only a session in Landlens's history. */
  async remove(session: string): Promise<{ ok: boolean; note: string }> {
    if (!this.d.history.get(session)) throw fail(404, "Landlens has no such session in its history.");
    const lf = this.landflow();
    try {
      const had = await removeWork({ origin: lf.origin, key: lf.key, sourceId: session, ...(this.d.fetch ? { fetch: this.d.fetch } : {}) });
      return { ok: had, note: had ? BRAIN_NOTES.removed : BRAIN_NOTES.notThere };
    } catch (err) {
      throw this.failure(err);
    }
  }

  /** A window went away: its sheets go with it. */
  dropFor(owner: Owner) {
    for (const [k, v] of this.sheets) if (v.owner === owner) this.sheets.delete(k);
  }
}

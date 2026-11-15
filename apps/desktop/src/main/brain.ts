// A session's summary to Landflow's brain (docs/family.md#a-sessions-summary-to-the-brain, wave 7 D134–D135). Main
// keeps each session's facts (questions, tool calls, cluster reads, changes; never their text), drafts one private
// `work.session` event by rule, and keeps it under a sheet owned by the window that asked, with the digest of the
// fields main fills. The window edits the text and sends with the sheet and the digest: main refuses a sheet it didn't
// make, another window's, an old one, or a session that moved on since; refuses text whose scrub would change it (so
// what is sent is what was shown); checks Landflow's own rules; then POSTs with the key it holds. Nothing is sent but
// on the person's click, and the person's Landflow is the only place it goes.
import { createHash, randomBytes } from "node:crypto";
import { BRAIN_NOTES, BRAIN_PROMPT, type AgentChange, type AgentHistoryEntry, type BrainDraft, type BrainSend, type McpCall, type WorkDraft, type WorkVisibility } from "@landlens/contracts";
import { checkWork, draftWork, factLines, FamilyError, recordWork, removeWork, type SessionFacts } from "@landlens/connections";
import { rawError } from "@landlens/mcp-gateway";
import { redactText } from "@landlens/kube-mcp";
import { problemTitleOf } from "@landlens/telemetry";
import type { AgentObserver } from "./agent";

export const BRAIN = { sheetMs: 30 * 60_000, sheets: 20, draftChars: 500 } as const;

type Owner = object;
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
  agent: { isOpen(session: string): boolean; draft(session: string, prompt: string): Promise<string> };
  fetch?: typeof fetch;
  now?: () => number;
};

export class BrainService {
  private readonly ledgers = new Map<string, Ledger>();
  private readonly sheets = new Map<string, Sheet>();
  /** Calls and changes already counted (each is reported more than once as it moves). */
  private readonly seen = new Set<string>();

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
    return {
      session, cluster: e.context, ...(e.namespaces?.length ? { namespaces: e.namespaces } : {}), ...(l.problem ? { problem: l.problem } : {}),
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
    return { sheet: key, digest, to: new URL(lf.origin).host, event, facts: factLines(f), open: this.d.agent.isOpen(session) };
  }

  /**
   * "Ask Claude to draft" (D134): one turn in the open session with main's fixed prompt; the answer goes in the box,
   * scrubbed and cut to 500 characters, still editable. The window's text never reaches the prompt.
   */
  async ask(key: string, owner: Owner): Promise<{ summary: string }> {
    const s = this.sheet(key, owner);
    if (!this.d.agent.isOpen(s.session)) throw fail(409, BRAIN_NOTES.closed);
    let text: string;
    try {
      text = await this.d.agent.draft(s.session, BRAIN_PROMPT);
    } catch (err) {
      if ((err as { busy?: boolean })?.busy) throw fail(409, BRAIN_NOTES.busy);
      throw err;
    }
    // The sheet was made before this turn: its digest still names the same fields (the history doesn't count it).
    const one = redactText(text).replace(/\s+/g, " ").trim();
    return { summary: one.length > BRAIN.draftChars ? `${one.slice(0, BRAIN.draftChars - 1)}…` : one };
  }

  /**
   * Send the sheet (D134–D135): main's fields as the sheet showed them (the digest), the person's text as typed. A
   * session that moved on since is refused (look again); text the scrub would change is refused with the scrubbed text,
   * so what goes is exactly what the person sees; then Landflow's own rules, then the POST.
   */
  async send(req: { sheet: string; digest: string; title: string; summary: string; visibility: WorkVisibility; team?: string; initiative?: string }, owner: Owner): Promise<BrainSend> {
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

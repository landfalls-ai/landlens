// Pairing the dock's tool cards (ACP tool calls) with gateway calls, so a card can show its call's app.
//
// 1. Exact: Claude Code sends the tool_use id as `_meta["claudecode/toolUseId"]` on every MCP tools/call, and the
//    ACP adapter uses the same id as the card's toolCallId. When it's there, that is the pair.
// 2. Fallback, if a Claude Code version stops sending it: within one session, the card's tool name
//    (`mcp__<server>__<tool>`, from `_meta.claudeCode.toolName` or the title) and its input, canonically ordered,
//    against the call's; the oldest unpaired of each pair first. A card whose input isn't known yet pairs with a
//    call only when each is the one unpaired entry for that tool name in the session.
// Entries no one claims are dropped after ten minutes.

export const TOOL_USE_META = "claudecode/toolUseId";
const TTL = 10 * 60_000;

type CallSide = { id: string; session: string; name: string; key: string; at: number };
type CardSide = { toolCallId: string; session: string; name: string; key?: string; at: number };

/** JSON with object keys sorted, so `{a,b}` and `{b,a}` compare equal. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export const qualified = (server: string, tool: string) => `mcp__${server}__${tool}`;

export class Pairing {
  private calls: CallSide[] = [];
  private cards = new Map<string, CardSide>(); // toolCallId → card
  private readonly paired = new Set<string>(); // toolCallIds already paired

  constructor(private readonly onPair: (callId: string, toolCallId: string) => void, private readonly now = () => Date.now()) {}

  /** A gateway call by an agent session started. */
  call(c: { id: string; session: string; server: string; tool: string; args: unknown; toolUseId?: string }) {
    this.expire();
    if (c.toolUseId && /^[A-Za-z0-9_-]{1,128}$/.test(c.toolUseId)) {
      this.cards.delete(c.toolUseId);
      this.paired.add(c.toolUseId);
      this.onPair(c.id, c.toolUseId);
      return;
    }
    const name = qualified(c.server, c.tool);
    this.calls.push({ id: c.id, session: c.session, name, key: canonical(c.args ?? {}), at: this.now() });
    this.match(c.session, name);
  }

  /** The dock saw an ACP tool call (or an update to one). */
  card(u: { session: string; toolCallId: string; toolName?: string; title?: string; rawInput?: unknown }) {
    this.expire();
    if (this.paired.has(u.toolCallId)) return;
    const name = u.toolName ?? /^(mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_.-]+)/.exec(u.title ?? "")?.[1];
    const prev = this.cards.get(u.toolCallId);
    const resolved = name ?? prev?.name;
    if (!resolved?.startsWith("mcp__")) return;
    const card: CardSide = {
      toolCallId: u.toolCallId,
      session: u.session,
      name: resolved,
      at: prev?.at ?? this.now(),
      ...(u.rawInput !== undefined ? { key: canonical(u.rawInput) } : prev?.key !== undefined ? { key: prev.key } : {}),
    };
    this.cards.set(u.toolCallId, card);
    this.match(u.session, resolved);
  }

  /** Forget a session's unpaired entries (it ended). */
  forget(session: string) {
    this.calls = this.calls.filter((c) => c.session !== session);
    for (const [id, c] of this.cards) if (c.session === session) this.cards.delete(id);
  }

  private match(session: string, name: string) {
    const calls = () => this.calls.filter((c) => c.session === session && c.name === name);
    const cards = () => [...this.cards.values()].filter((c) => c.session === session && c.name === name).sort((a, b) => a.at - b.at);
    for (const call of calls()) {
      const card = cards().find((k) => k.key === call.key);
      if (card) this.pair(call, card);
    }
    const cs = calls();
    const ks = cards();
    if (cs.length === 1 && ks.length === 1 && ks[0]!.key === undefined) this.pair(cs[0]!, ks[0]!);
  }

  private pair(call: CallSide, card: CardSide) {
    this.calls = this.calls.filter((c) => c !== call);
    this.cards.delete(card.toolCallId);
    this.paired.add(card.toolCallId);
    this.onPair(call.id, card.toolCallId);
  }

  private expire() {
    const cutoff = this.now() - TTL;
    this.calls = this.calls.filter((c) => c.at >= cutoff);
    for (const [id, c] of this.cards) if (c.at < cutoff) this.cards.delete(id);
    if (this.paired.size > 5000) this.paired.clear();
  }
}

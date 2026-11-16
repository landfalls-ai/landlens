// Secret values for the person only (wave 8 part 4, D161–D168).
//
// Today's rule stays: no Secret value reaches the window, the agent, a file, a log or telemetry. This service opens one
// door, as narrow as it can be made:
//
// - Unlock (D163): main reads the Secret once (its uid and type; the body is dropped), then asks in its own native
//   dialog on the asking window, naming the cluster (its context and API server's host), the namespace, the Secret and
//   what kind of credential it is. Yes unlocks that one Secret, by uid, for that window on that cluster, for 5 minutes.
//   An unlock ends at its time, on Lock, when the window goes, reloads or loses its renderer, when the cluster stops,
//   and when the window connects another cluster; one of those while the dialog is up (the window's epoch moved) makes
//   Yes unlock nothing. At most 5 a window; 6 asks a minute, and a pause after a Cancel.
// - Reveal (D164): one key, to the window that unlocked it, read again with a token for that one GET, the uid checked;
//   the rest of the object is dropped as it is parsed; nothing is cached. 10 reads of values a minute a window.
// - Copy (D165): the same read, written to the system clipboard by main, never to the window, with macOS's concealed
//   marker in the same write (Electron 45's ClipboardItem: one atomic write, so the marker and the text go together),
//   so clipboard managers that honour it skip it (on Windows: no clipboard history, no cloud sync, no monitors). Main
//   keeps only the SHA-256 of what it wrote and clears the clipboard 30 s later, and when Landlens quits, only if it
//   still holds that (on macOS and Windows main first checks its marker is still there, so it reads no other app's copy).
// - The guard (D166): every value revealed or copied leaves a fingerprint (its length, a rolling hash and its SHA-256,
//   of its CRLF→LF, NFC form and that form trimmed; never the value) for as long as Landlens runs; a prompt, a change's
//   note or a brain title or summary holding one is refused. Values under 8 characters leave none.
// - Certificates (D167): public halves only (certs.ts certDetails: tls.crt and ca.crt; every other key dropped as the
//   answer is parsed), no unlock, 30 reads a minute a window.
//
// Every read is one front-door token with the `object` policy (D162): one GET of that one Secret, labelled
// `you · <context> · secret <namespace>/<name>`, taken back after its one request and revoked in `finally`. Your RBAC
// decides (`get secrets`). Every error this service throws is one of its own fixed sentences: never the API's text, a
// parse error's (V8 quotes the text it couldn't parse) or anything with a value in it. Nothing here logs. One action-log
// row per reveal and per copy names the Secret, and the key once the Secret had it, never a value or a length;
// telemetry counts neither.
import { createHash } from "node:crypto";
import type { CertDetail, Revealed, SecretRef } from "@landlens/contracts";
import { CERT_KEYS, certDetails, type ClusterManager, type FrontDoor } from "@landlens/kube";
import { frontDoorSend } from "@landlens/kube-mcp";
import type { WebContents } from "electron";
import { logEntry, type ActionLog } from "./action-log";
import type { Confirm } from "./native-confirm";

export const UNLOCK_MS = 5 * 60_000;
export const MAX_UNLOCKS = 5;
/** Reads of values (reveals and copies) a window may make in a minute. */
export const VALUE_READS = 10;
export const VALUE_READS_MS = 60_000;
/** How long a copied value stays on the clipboard, and a revealed one on screen (the window's timer). */
export const CLEAR_MS = 30_000;
/** The most text a reveal shows: past it, Copy only. */
export const MAX_TEXT = 64 * 1024;
/** macOS's marker that clipboard managers skip (nspasteboard.org), as Electron 45's clipboard names a raw format. */
export const CONCEALED = 'electron application/osclipboard;format="org.nspasteboard.ConcealedType"';
/** Windows's: clipboard monitors skip it, and with the next two at 0 it stays out of Win+V's history and cloud sync. */
export const WIN_EXCLUDE = 'electron application/osclipboard;format="ExcludeClipboardContentFromMonitorProcessing"';
export const WIN_NO_HISTORY = 'electron application/osclipboard;format="CanIncludeInClipboardHistory"';
export const WIN_NO_CLOUD = 'electron application/osclipboard;format="CanUploadToCloudClipboard"';
/** Unlock dialogs a window may ask for in a minute (M5 of the security review). */
export const UNLOCK_ASKS = 6;
export const UNLOCK_ASKS_MS = 60_000;
/** The pause after a Cancel, and after two in a row. */
export const CANCEL_PAUSE_MS = 5_000;
export const CANCELS_PAUSE_MS = 30_000;
/** Certificate reads a window may make in a minute. */
export const CERT_READS = 30;
/** The shortest value the guard looks for: a shorter one would refuse every prompt that holds its letters. */
export const GUARD_MIN = 8;
/** The most fingerprints kept (the newest). */
export const GUARD_MAX = 500;

/** Main's fixed sentences: the only errors this service gives. */
export const SECRET_TEXT = {
  forbidden: (ns: string) => `You can't read Secrets in ${ns}.`,
  gone: "That Secret is gone.",
  keyGone: "That key is gone.",
  changed: "It changed since you unlocked it: unlock again.",
  locked: "Unlock this Secret first.",
  unreadable: "The cluster's answer wasn't a Secret Landlens could read.",
  unreachable: "The cluster didn't answer.",
  status: (n: number) => `The cluster answered HTTP ${n}.`,
  helm: "Helm's release record: open it under Helm.",
  cancelled: "Cancelled.",
  asking: "Landlens is already asking about a Secret in this window.",
  tooMany: `At most ${MAX_UNLOCKS} Secrets are unlocked at once in a window: lock one first.`,
  rate: `At most ${VALUE_READS} values a minute: wait a moment.`,
  notText: "It isn't text: copy it as base64.",
  logRefused: "Landlens couldn't write its action log, so nothing was read.",
  windowGone: "The window that asked has gone.",
  inPrompt: "That holds a Secret value Landlens showed or copied for you: it isn't sent to Claude.",
  asks: `At most ${UNLOCK_ASKS} unlock questions a minute: wait a moment.`,
  paused: "You said Cancel: wait a moment before asking again.",
  certRate: `At most ${CERT_READS} certificate reads a minute: wait a moment.`,
  noCluster: "That cluster isn't connected.",
  secretRef: "Secrets aren't sent to Claude.",
  clipboard: "Landlens couldn't write to the clipboard.",
} as const;

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * The clipboard as main uses it: a concealed write, whether the platform's marker is still there (so main reads no
 * other app's copy, L7), a read to compare, a clear.
 */
export type SecretClipboard = { write(text: string): Promise<void>; marked(): Promise<boolean>; readText(): Promise<string>; clear(): void };

/** The formats of main's one clipboard write (D165, L6): the text and the platform's markers, together. */
export function clipboardFormats(platform: NodeJS.Platform, text: string): Record<string, string | Blob> {
  const zero = () => new Blob([new Uint8Array(4)]); // a DWORD 0
  if (platform === "darwin") return { "text/plain": text, [CONCEALED]: "" };
  if (platform === "win32") return { "text/plain": text, [WIN_EXCLUDE]: zero(), [WIN_NO_HISTORY]: zero(), [WIN_NO_CLOUD]: zero() };
  return { "text/plain": text };
}
/** The marker main checks before it reads the clipboard back, if the platform has one. */
export const clipboardMarker = (platform: NodeJS.Platform): string | undefined => (platform === "darwin" ? CONCEALED : platform === "win32" ? WIN_EXCLUDE : undefined);

export type SecretDeps = {
  clusters: Pick<ClusterManager, "get" | "onGone">;
  frontDoor: Pick<FrontDoor, "issueToken" | "revokeToken" | "clusterUrl" | "certificate">;
  log: Pick<ActionLog, "add" | "settle"> & { readonly unsaved?: boolean };
  clipboard: SecretClipboard;
  now?: () => number;
};

type Unlock = { wc: WebContents; handle: string; namespace: string; name: string; uid: string; until: number };
type Key = { wc: WebContents; handle: string; secret: SecretRef };
/** A value as the guard knows it: its length, a rolling hash to find candidates, its SHA-256 to be sure. Never the value. */
type Print = { len: number; roll: number; hash: string };

export class SecretService {
  private readonly unlocks = new Set<Unlock>();
  private readonly asking = new WeakSet<WebContents>();
  private readonly watched = new WeakSet<WebContents>();
  private readonly reads = new WeakMap<WebContents, number[]>();
  private readonly asks = new WeakMap<WebContents, number[]>();
  private readonly cancels = new WeakMap<WebContents, { n: number; at: number }>();
  private readonly certReads = new WeakMap<WebContents, number[]>();
  /** Moves on every ending of a window's unlocks, so a dialog that was up across one unlocks nothing (M3). */
  private readonly epochs = new WeakMap<WebContents, number>();
  /** What main last wrote to the clipboard, as its SHA-256 only, and the timer that clears it. */
  private copied: { hash: string; timer: ReturnType<typeof setTimeout> } | undefined;
  /** Every value revealed or copied while Landlens runs, as fingerprints (M2). */
  private prints: Print[] = [];

  constructor(private readonly d: SecretDeps) {
    d.clusters.onGone((handle) => {
      for (const u of this.unlocks) if (u.handle === handle) this.unlocks.delete(u);
    });
  }

  private get now() {
    return (this.d.now ?? Date.now)();
  }

  /** A window's unlocks end with its page: when it goes, reloads or its renderer dies. */
  private own(wc: WebContents) {
    if (this.watched.has(wc)) return;
    this.watched.add(wc);
    const end = () => this.lockWindow(wc);
    wc.on("did-start-navigation", (e: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (e.isMainFrame && !e.isSameDocument) end();
    });
    wc.on("render-process-gone", end);
    wc.once("destroyed", () => {
      end();
      this.watched.delete(wc);
    });
  }

  /** Every unlock this window holds ends (Lock now with no Secret, a navigation, another cluster connected). */
  lockWindow(wc: WebContents) {
    this.epochs.set(wc, (this.epochs.get(wc) ?? 0) + 1);
    for (const u of this.unlocks) if (u.wc === wc) this.unlocks.delete(u);
  }

  /** A sliding minute's count for one window: true when it is full, else counted. */
  private full(map: WeakMap<WebContents, number[]>, wc: WebContents, max: number, ms: number): boolean {
    const now = this.now;
    const recent = (map.get(wc) ?? []).filter((t) => t > now - ms);
    if (recent.length >= max) return (map.set(wc, recent), true);
    map.set(wc, [...recent, now]);
    return false;
  }

  /** A connected cluster's info, or main's own sentence (L8). */
  private cluster(handle: string) {
    try {
      return this.d.clusters.get(handle).info;
    } catch {
      throw fail(404, SECRET_TEXT.noCluster);
    }
  }

  private live(wc: WebContents): Unlock[] {
    const now = this.now;
    for (const u of this.unlocks) if (u.until <= now) this.unlocks.delete(u);
    return [...this.unlocks].filter((u) => u.wc === wc);
  }

  private find(k: Key): Unlock | undefined {
    return this.live(k.wc).find((u) => u.handle === k.handle && u.namespace === k.secret.namespace && u.name === k.secret.name);
  }

  /**
   * One GET of one Secret as you (D162): a token for that request only, the `object` policy, revoked at the end.
   * Answers its uid, type and the keys in `keep` only (every other key is dropped as the answer is parsed), or one of
   * the fixed sentences; never the cluster's text.
   */
  private async read(handle: string, s: SecretRef, keep: readonly string[]): Promise<{ uid: string; type: string; data: Record<string, unknown> }> {
    const c = this.cluster(handle);
    const token = this.d.frontDoor.issueToken({
      label: `you · ${c.context} · secret ${s.namespace}/${s.name}`,
      policy: { access: "object", object: { group: "", resource: "secrets", namespace: s.namespace, name: s.name } },
      clusters: [handle],
    });
    try {
      let got: { status: number; text: string };
      try {
        got = await frontDoorSend({ url: this.d.frontDoor.clusterUrl(handle), certificate: this.d.frontDoor.certificate, token })({ method: "GET", path: `/api/v1/namespaces/${s.namespace}/secrets/${s.name}` });
      } catch {
        throw fail(504, SECRET_TEXT.unreachable);
      }
      if (got.status === 403) throw fail(403, SECRET_TEXT.forbidden(s.namespace));
      if (got.status === 404) throw fail(404, SECRET_TEXT.gone);
      if (got.status !== 200) throw fail(502, SECRET_TEXT.status(got.status));
      let o: any;
      try {
        o = JSON.parse(got.text);
      } catch {
        throw fail(502, SECRET_TEXT.unreadable);
      }
      const uid = o?.metadata?.uid;
      if (o?.kind !== "Secret" || o.metadata?.name !== s.name || o.metadata?.namespace !== s.namespace || typeof uid !== "string" || !uid) throw fail(502, SECRET_TEXT.unreadable);
      // Only the keys asked for are kept, here, as the answer is parsed: the parsed object goes with this call (M5).
      const raw = o.data && typeof o.data === "object" && !Array.isArray(o.data) ? (o.data as Record<string, unknown>) : {};
      const data: Record<string, unknown> = {};
      for (const k of keep) if (Object.hasOwn(raw, k)) data[k] = raw[k];
      const type = typeof o.type === "string" ? o.type : "";
      o = undefined;
      return { uid, type, data };
    } finally {
      this.d.frontDoor.revokeToken(token);
    }
  }

  /** Main's question on the asking window (D163); yes unlocks that Secret, by uid, for 5 minutes. */
  async unlock(r: { handle: string; secret: SecretRef }, wc: WebContents, confirm: Confirm): Promise<{ unlocked: true; until: string; left: number }> {
    this.own(wc);
    if (this.asking.has(wc)) throw fail(429, SECRET_TEXT.asking);
    // A Cancel pauses the next ask: 5 s, or 30 s after two in a row; and at most 6 asks a minute (M5).
    const c = this.cancels.get(wc);
    if (c && this.now < c.at + (c.n >= 2 ? CANCELS_PAUSE_MS : CANCEL_PAUSE_MS)) throw fail(429, SECRET_TEXT.paused);
    const others = this.live(wc).filter((u) => !(u.handle === r.handle && u.namespace === r.secret.namespace && u.name === r.secret.name));
    if (others.length >= MAX_UNLOCKS) throw fail(429, SECRET_TEXT.tooMany);
    if (this.full(this.asks, wc, UNLOCK_ASKS, UNLOCK_ASKS_MS)) throw fail(429, SECRET_TEXT.asks);
    this.asking.add(wc);
    // The window's epoch now: a navigation, a dead renderer, a lock of the window or another cluster connected while
    // the dialog is up moves it, and Yes then unlocks nothing (M3).
    const epoch = this.epochs.get(wc) ?? 0;
    try {
      const info = this.cluster(r.handle);
      const got = await this.read(r.handle, r.secret, []);
      if (got.type === "helm.sh/release.v1") throw fail(400, SECRET_TEXT.helm);
      const what = CREDENTIAL[got.type];
      const yes = await confirm({
        message: `Show values of Secret ${r.secret.namespace}/${r.secret.name}?`,
        detail: `${what ? `${what}\n` : ""}Values are shown to you only, for 30 seconds at a time. Claude never sees them. On ${oneLine(info.context)} (${hostOf(info.server)}).`,
        yes: "Show values",
      });
      if (!yes) {
        const prev = this.cancels.get(wc);
        this.cancels.set(wc, { n: (prev?.n ?? 0) + 1, at: this.now });
        throw fail(409, SECRET_TEXT.cancelled);
      }
      this.cancels.delete(wc);
      // The window, its page and the cluster may have gone while the dialog was up.
      if (wc.isDestroyed() || !this.watched.has(wc) || (this.epochs.get(wc) ?? 0) !== epoch) throw fail(410, SECRET_TEXT.windowGone);
      this.cluster(r.handle);
      for (const u of this.unlocks) if (u.wc === wc && u.handle === r.handle && u.namespace === r.secret.namespace && u.name === r.secret.name) this.unlocks.delete(u);
      const until = this.now + UNLOCK_MS;
      this.unlocks.add({ wc, handle: r.handle, namespace: r.secret.namespace, name: r.secret.name, uid: got.uid, until });
      return { unlocked: true, until: new Date(until).toISOString(), left: UNLOCK_MS };
    } finally {
      this.asking.delete(wc);
    }
  }

  lock(r: { handle: string; secret?: SecretRef }, wc: WebContents) {
    if (!r.secret) return this.lockWindow(wc);
    for (const u of this.unlocks) {
      if (u.wc === wc && u.handle === r.handle && u.namespace === r.secret.namespace && u.name === r.secret.name) this.unlocks.delete(u);
    }
  }

  /** The value's bytes, after every check: the window's unlock, its rate, the log row, one read, the same uid. */
  private async value(k: Key, key: string, action: "reveal" | "copy", use: (bytes: Buffer) => Promise<void> | void): Promise<void> {
    const u = this.find(k);
    if (!u) throw fail(403, SECRET_TEXT.locked);
    if (this.full(this.reads, k.wc, VALUE_READS, VALUE_READS_MS)) throw fail(429, SECRET_TEXT.rate);
    const info = this.cluster(k.handle);
    // The row is written before the read (as an action's before its first request); a log that can't take it reads
    // nothing. It names the key only once the Secret is seen to have it (L1): the window can't park text in the log.
    let row: string;
    try {
      row = this.d.log.add(logEntry({ context: info.context, server: info.server, action, kind: "Secret", group: "", resource: "secrets", namespace: k.secret.namespace, names: [k.secret.name], outcome: "sent" })).id;
    } catch {
      throw fail(500, SECRET_TEXT.logRefused);
    }
    let had = false;
    const settle = (outcome: "applied" | "failed" | "conflict") => {
      try {
        this.d.log.settle(row, { outcome, ...(had ? { key } : {}) });
      } catch {
        // the row stays as sent
      }
    };
    if (this.d.log.unsaved) {
      settle("failed");
      throw fail(500, SECRET_TEXT.logRefused);
    }
    try {
      const got = await this.read(k.handle, k.secret, [key]);
      if (got.uid !== u.uid) {
        this.unlocks.delete(u);
        throw fail(409, SECRET_TEXT.changed);
      }
      if (got.type === "helm.sh/release.v1") throw fail(400, SECRET_TEXT.helm);
      const b64 = got.data[key];
      if (typeof b64 !== "string") throw fail(404, SECRET_TEXT.keyGone);
      had = true;
      const bytes = Buffer.from(b64, "base64");
      try {
        await use(bytes);
      } finally {
        bytes.fill(0);
      }
      settle("applied");
    } catch (e) {
      settle((e as { status?: number }).status === 409 ? "conflict" : "failed");
      throw fixed(e);
    }
  }

  /** One key's value, to the window that unlocked it (D164): text when it is UTF-8 and at most 64 KiB, else its size. */
  async reveal(r: { handle: string; secret: SecretRef; key: string }, wc: WebContents): Promise<Revealed> {
    let out: Revealed = { kind: "binary", bytes: 0 };
    await this.value({ wc, handle: r.handle, secret: r.secret }, r.key, "reveal", (bytes) => {
      if (bytes.length > MAX_TEXT) out = { kind: "large", bytes: bytes.length };
      else {
        const text = utf8(bytes);
        if (text !== undefined) this.remember(text);
        out = text === undefined ? { kind: "binary", bytes: bytes.length } : { kind: "text", text, bytes: bytes.length };
      }
    });
    return out;
  }

  /** One key's value to the clipboard, from main (D165): the window gets `copied` and never the value. */
  async copy(r: { handle: string; secret: SecretRef; key: string; as?: "text" | "base64" }, wc: WebContents): Promise<{ copied: true; clearsIn: number }> {
    await this.value({ wc, handle: r.handle, secret: r.secret }, r.key, "copy", async (bytes) => {
      const text = r.as === "base64" ? bytes.toString("base64") : utf8(bytes);
      if (text === undefined) throw fail(415, SECRET_TEXT.notText);
      this.remember(text);
      try {
        await this.d.clipboard.write(text);
      } catch {
        throw fail(500, SECRET_TEXT.clipboard);
      }
      if (this.copied) clearTimeout(this.copied.timer);
      const hash = sha(text);
      const timer = setTimeout(() => void this.clearIfOurs(hash), CLEAR_MS);
      timer.unref?.();
      this.copied = { hash, timer };
    });
    return { copied: true, clearsIn: CLEAR_MS / 1000 };
  }

  /**
   * Clear the clipboard if it still holds what main wrote (never what the person copied since). Where the platform has
   * a marker, the clipboard is read only while it is still there: another app's copy is never read (L7).
   */
  private async clearIfOurs(hash: string): Promise<void> {
    if (this.copied?.hash === hash) {
      clearTimeout(this.copied.timer);
      this.copied = undefined;
    }
    try {
      if (!(await this.d.clipboard.marked())) return;
      if (sha(await this.d.clipboard.readText()) === hash) this.d.clipboard.clear();
    } catch {
      // a clipboard that can't be read is left alone
    }
  }

  /** Quitting: the clipboard is cleared now if it still holds a value main copied. */
  async quit(): Promise<void> {
    const c = this.copied;
    if (c) await this.clearIfOurs(c.hash);
  }

  /** A value revealed or copied, as fingerprints of its normal form and that form trimmed (M2). */
  private remember(value: string) {
    const n = normal(value);
    for (const v of new Set([n, n.trim()])) {
      if (v.length < GUARD_MIN) continue;
      const hash = sha(v);
      if (this.prints.some((p) => p.hash === hash)) continue;
      this.prints.push({ len: v.length, roll: rolling(v), hash });
    }
    if (this.prints.length > GUARD_MAX) this.prints = this.prints.slice(-GUARD_MAX);
  }

  /**
   * A guard for text on its way to Claude (the dock, a change's note, a brain title and summary): refused when it holds
   * a value Landlens revealed or copied in this run, after CRLF→LF and NFC on both sides; the clipboard isn't read.
   * Encodings (base64, URL), a value split or retyped with changes, and values under 8 characters aren't caught.
   */
  async refuseValues(texts: (string | undefined)[]): Promise<void> {
    if (!this.prints.length) return;
    if (texts.some((t) => t && holds(normal(t), this.prints))) throw fail(400, SECRET_TEXT.inPrompt);
  }

  /** A prompt for Claude (D168): no Secret attached, and no value Landlens revealed or copied. */
  async refusePrompt(p: { text: string; context?: { group: string; resource: string }[] }): Promise<void> {
    if (p.context?.some((r) => r.group === "" && r.resource === "secrets")) throw fail(400, SECRET_TEXT.secretRef);
    await this.refuseValues([p.text]);
  }

  /**
   * The certificates of a Secret (D167): public halves only, no unlock; your RBAC still decides. Only tls.crt and ca.crt
   * are kept from the answer, and a window may ask 30 times a minute (M5).
   */
  async certs(r: { handle: string; secret: SecretRef }, wc: WebContents): Promise<{ certs: CertDetail[]; skipped?: string }> {
    if (this.full(this.certReads, wc, CERT_READS, VALUE_READS_MS)) throw fail(429, SECRET_TEXT.certRate);
    try {
      return certDetails(await this.read(r.handle, r.secret, CERT_KEYS));
    } catch (e) {
      throw fixed(e);
    }
  }
}

/** Valid UTF-8 as text, else undefined (never a replacement character standing in for bytes). */
function utf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** The form the guard compares: line ends as a text box gives them (CRLF and CR → LF), then NFC. */
const normal = (s: string) => s.replace(/\r\n?/g, "\n").normalize("NFC");

// A Rabin–Karp hash over UTF-16 code units, to find the windows worth a SHA-256: every product stays under 2^53.
const P = 2_147_483_647;
const B = 131;
function rolling(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * B + s.charCodeAt(i)) % P;
  return h;
}
/** Whether any window of `text` is a remembered value: one pass a length, a SHA-256 only where the rolling hash agrees. */
function holds(text: string, prints: Print[]): boolean {
  const byLen = new Map<number, Print[]>();
  for (const p of prints) if (p.len <= text.length) byLen.set(p.len, [...(byLen.get(p.len) ?? []), p]);
  for (const [len, ps] of byLen) {
    const rolls = new Set(ps.map((p) => p.roll));
    let top = 1;
    for (let i = 1; i < len; i++) top = (top * B) % P;
    let h = rolling(text.slice(0, len));
    for (let i = 0; ; i++) {
      if (rolls.has(h)) {
        const hash = sha(text.slice(i, i + len));
        if (ps.some((p) => p.hash === hash)) return true;
      }
      if (i + len >= text.length) break;
      h = ((h - ((text.charCodeAt(i) * top) % P) + P) % P * B + text.charCodeAt(i + len)) % P;
    }
  }
  return false;
}

const SENTENCES = new Set<string>(Object.values(SECRET_TEXT as Record<string, unknown>).filter((v): v is string => typeof v === "string"));
/** Only main's own sentences cross: an error of anything else becomes "the cluster's answer wasn't readable". */
function fixed(e: unknown): Error {
  const m = (e as Error)?.message ?? "";
  const status = (e as { status?: unknown })?.status;
  const ours = typeof status === "number" && (SENTENCES.has(m) || /^You can't read Secrets in [a-z0-9-]{1,63}\.$/.test(m) || /^The cluster answered HTTP \d{3}\.$/.test(m));
  return ours ? (e as Error) : fail(500, SECRET_TEXT.unreadable);
}

/**
 * A name as one line in main's dialog (L4): control characters become "?", and format characters (bidi overrides and
 * isolates, zero-width) and line and paragraph separators are taken out, so no name reads as another.
 */
export const oneLine = (s: string) => s.replace(/[\p{Cc}]/gu, "?").replace(/[\p{Cf}\u2028\u2029]/gu, "").slice(0, 253);
/** The API server's host and port, for the dialog: the context name is yours to choose; the address is not. */
const hostOf = (server: string) => {
  try {
    return oneLine(new URL(server).host) || "unknown server";
  } catch {
    return "unknown server";
  }
};

/** What a credential Secret opens, said in the dialog (L5). The type is the Secret author's word. */
const CREDENTIAL: Record<string, string> = {
  "kubernetes.io/service-account-token": "A ServiceAccount token: it signs in to this cluster.",
  "bootstrap.kubernetes.io/token": "A bootstrap token: it joins machines to this cluster.",
  "kubernetes.io/dockerconfigjson": "A registry credential: it signs in to an image registry.",
  "kubernetes.io/dockercfg": "A registry credential: it signs in to an image registry.",
};

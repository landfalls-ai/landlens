// What the agent may see of a Kubernetes object, applied in two places: the front door scrubs every response to an
// agent token (so the agent's own kubectl gets the same treatment), and the MCP tools scrub what they print.
// The rules follow landfall-cluster-agent (README, "What leaves the cluster"): strip managedFields and
// last-applied-configuration, never env[].value, cap every string and the whole result, then scrub what looks like a
// credential. Secrets never get here: the agent's front-door token can't read them, and their data is dropped anyway.

export const MAX_STRING = 4096;
export const MAX_RESULT = 200_000;

/** Credential-shaped text, after the redactors Landfall and gitleaks use (a pinned subset; see docs/agent.md). */
const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<redacted private key>"],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, "<redacted auth header>"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<redacted jwt>"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<redacted aws key id>"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "<redacted github token>"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "<redacted github token>"],
  [/\blin_(?:api|oauth|refresh)_[A-Za-z0-9]{20,}/g, "<redacted linear key>"],
  // The Land family's keys (wave 7): Landflow's `lf_…` (and its `lf_mcp_`, `lf_dbg_` tokens, Landfall's `lf_key_…`),
  // Clickland's `ck_…`.
  [/\blf_[A-Za-z0-9_-]{20,}/g, "<redacted land family key>"],
  [/\bck_[A-Za-z0-9_-]{16,}/g, "<redacted clickland key>"],
  [/\bya29\.[A-Za-z0-9._-]{20,}/g, "<redacted google token>"],
  // Google's other shapes (review of wave 6 part 4, M2): API keys, OAuth refresh tokens, OAuth client secrets.
  [/\bAIza[0-9A-Za-z_-]{35}/g, "<redacted google api key>"],
  [/\b1\/\/[0-9A-Za-z_-]{40,}/g, "<redacted google refresh token>"],
  [/\bGOCSPX-[0-9A-Za-z_-]{10,}/g, "<redacted google client secret>"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "<redacted slack token>"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, "<redacted api key>"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "<redacted gitlab token>"],
  // A scheme is at most 32 characters, so a long run of letters and dots isn't tried from every position (quadratic).
  [/(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]{1,256}:)[^\s@/]{1,256}@/gi, "$1<redacted>@"], // password in a URL
  [/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)(?!<(?:hidden|redacted))[^\s"',}]{6,}/gi, "$1<redacted>"],
];

export function redactText(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export const KEY_REDACTED = "<redacted private key>";
/** A private key's head with no end after it (redactText has already taken every whole key). */
const OPEN_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/;
/** A private key's end with no head before it. */
const CLOSE_KEY = /^[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/;

/**
 * redactText for text that may be a piece of something longer (a cut body, one row of a key logged line by line):
 * also a private key's head with no end, to the end of the text, and a key's end with no head, from the start (security
 * review of wave 7 part 3, M1 and L9). `opened`: the text ends inside a key.
 */
export function redactPart(s: string): { text: string; opened: boolean } {
  let text = redactText(s).replace(CLOSE_KEY, KEY_REDACTED);
  const opened = OPEN_KEY.test(text);
  if (opened) text = text.replace(OPEN_KEY, KEY_REDACTED);
  return { text, opened };
}

/** The most lines a private key logged line by line is redacted for, waiting for its END (a 4096-bit RSA key is ~50). */
export const KEY_LINES = 200;
/** One stream's (one container's log's) place: inside a private key that a line opened, and for how many lines. */
export type KeyState = { open: boolean; lines: number };
export const keyState = (): KeyState => ({ open: false, lines: 0 });
const END_KEY = /-----END [A-Z ]*PRIVATE KEY-----/;
/** A log line's own RFC 3339 timestamp (`timestamps=true`), kept in front of a redacted line. */
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d) /;

/**
 * redactPart for one line of a stream that is read line by line (a followed log), remembering across lines that a
 * private key is open (security review of wave 10 part 1, M1): from the line with the key's BEGIN, every line is
 * `<redacted private key>` until the line with its END, for at most KEY_LINES lines (past them a lone BEGIN no longer
 * hides the rest of the log). A line's leading timestamp is kept. `st` is the stream's own, kept by its reader.
 */
export function scrubLine(line: string, st: KeyState): string {
  const stamp = STAMP.exec(line)?.[0] ?? "";
  const body = line.slice(stamp.length);
  if (st.open) {
    const end = END_KEY.exec(body);
    if (end) {
      const rest = redactPart(body.slice(end.index + end[0].length));
      st.open = rest.opened;
      st.lines = 0;
      return `${stamp}${KEY_REDACTED}${rest.text}`;
    }
    if (++st.lines <= KEY_LINES) return `${stamp}${KEY_REDACTED}`;
    st.open = false;
    st.lines = 0;
  }
  const r = redactPart(body);
  st.open = r.opened;
  st.lines = 0;
  return stamp + r.text;
}

const BEGIN_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
/** A line of a PEM body: base64 only. */
const BASE64_LINE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * scrubLine over a batch of lines read together (one chunk of a stream, a log read whole). Also the other way: a key's
 * END with no key open (the read began inside the key: a tail, a sinceTime) takes the base64 lines right before it in
 * the batch as the key's body, at most KEY_LINES, as redactPart takes a leading END's text.
 */
export function scrubBatch(lines: readonly string[], st: KeyState): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (!st.open) {
      const body = line.slice((STAMP.exec(line)?.[0] ?? "").length);
      const end = END_KEY.exec(body);
      const begin = BEGIN_KEY.exec(body);
      if (end && (!begin || end.index < begin.index)) {
        for (let j = out.length - 1; j >= 0 && j >= out.length - KEY_LINES; j--) {
          const stamp = STAMP.exec(out[j]!)?.[0] ?? "";
          if (!BASE64_LINE.test(out[j]!.slice(stamp.length).trim())) break;
          out[j] = stamp + KEY_REDACTED;
        }
      }
    }
    out.push(scrubLine(line, st));
  }
  return out;
}

/**
 * A text stream's scrubber, one per stream (a followed log through the front door): scrubBatch over each chunk's lines,
 * with one key state, and the stream's leading run of base64-only lines held back until a line says what they were. A
 * follow's tail can begin inside a key, and the API server sends that tail a line a chunk, so its END comes after the
 * body lines were already passed on: held, they are redacted when the END comes, released on any other line, and
 * redacted if the stream ends first. Only the stream's start is held, and only from a line of 16 or more (a key's body
 * line is 64): from its first other line on, a key is seen from its BEGIN.
 */
export class LineScrubber {
  private readonly st = keyState();
  private lead: string[] | undefined = [];
  push(lines: readonly string[]): string[] {
    const out: string[] = [];
    let i = 0;
    for (; i < lines.length && this.lead; i++) {
      const line = lines[i]!;
      const body = line.slice((STAMP.exec(line)?.[0] ?? "").length).trim();
      // A run starts on a line as long as a key's (a word like "starting" is base64 too); then any base64 line joins it.
      if (BASE64_LINE.test(body) && (this.lead.length || body.length >= 16) && this.lead.length < KEY_LINES) {
        this.lead.push(line);
        continue;
      }
      // The first other line: scrubBatch over the held lines and it says what they were.
      const held = this.lead;
      this.lead = undefined;
      out.push(...scrubBatch([...held, line], this.st));
    }
    out.push(...scrubBatch(lines.slice(i), this.st));
    return out;
  }
  /** The stream ended: lines still held, if any, are taken as a key's (redacted). */
  end(): string[] {
    const held = this.lead ?? [];
    this.lead = undefined;
    return held.map((l) => (STAMP.exec(l)?.[0] ?? "") + KEY_REDACTED);
  }
}

/** Text of many lines (a log read whole): redactText over it all, then as one batch of lines. */
export function scrubLines(text: string): string {
  return scrubBatch(redactText(text).split("\n"), keyState()).join("\n");
}

/**
 * Scrub, then cut at `max` (security review of wave 7 part 3, M1): the scrub reads past the cut, at least 4,096
 * characters of scrubbed text beyond it, so a secret that the cut would split is taken whole; then a private key left
 * open by the cut is taken to the end. `fromEnd` keeps the last `max` characters instead (a log's tail), the text
 * scrubbed whole first. `cut`: the scrubbed text was longer than `max`.
 */
export function scrubCut(s: string, max: number, fromEnd = false): { text: string; cut: boolean; opened: boolean } {
  if (fromEnd) {
    const whole = redactPart(s);
    if (whole.text.length <= max) return { ...whole, cut: false };
    return { text: whole.text.slice(whole.text.length - max), cut: true, opened: whole.opened };
  }
  const MARGIN = 4096;
  for (let w = max + MARGIN; ; w *= 2) {
    let scrubbed: string;
    if (w >= s.length) {
      const whole = redactPart(s);
      if (whole.text.length <= max) return { ...whole, cut: false };
      scrubbed = whole.text;
    } else {
      scrubbed = redactText(s.slice(0, w));
      // A replacement shortens the text: what the window cut off at its end (perhaps half a secret) must still lie
      // MARGIN past the cut, or the window grows.
      if (scrubbed.length < max + MARGIN) continue;
    }
    const kept = redactPart(scrubbed.slice(0, max));
    return { text: kept.text, cut: true, opened: kept.opened };
  }
}

const CAPPED = /… \(\d+ more characters\)$/;

function capString(s: string): string {
  // Idempotent: the front door and the MCP tools both scrub what an MCP tool reads.
  return s.length > MAX_STRING && !(s.length <= MAX_STRING + 40 && CAPPED.test(s)) ? `${s.slice(0, MAX_STRING)}… (${s.length - MAX_STRING} more characters)` : s;
}

const KEEP_ANNOTATIONS = new Set([
  "deployment.kubernetes.io/revision",
  "kubernetes.io/change-cause",
]);

/**
 * A copy of the object that is safe to hand to the agent. Works on one object, a List (kubectl get -o yaml), a Table
 * (kubectl get) or a watch event: every embedded object's metadata is scrubbed, not only the top one's.
 */
export function redactObject(input: unknown): unknown {
  const o = structuredClone(input) as any;
  if (!o || typeof o !== "object") return o;
  scrubObjects(o, o.kind === "SecretList");
  stripEnvValues(o);
  return walkStrings(o, (s) => capString(redactText(s)));
}

/** managedFields, last-applied and big annotations off every object; Secret values off every Secret. */
function scrubObjects(node: any, inSecretList: boolean) {
  if (Array.isArray(node)) return node.forEach((n) => scrubObjects(n, inSecretList));
  if (!node || typeof node !== "object") return;
  const m = node.metadata;
  if (m && typeof m === "object" && !Array.isArray(m)) {
    delete m.managedFields;
    const ann = m.annotations;
    if (ann && typeof ann === "object") {
      for (const k of Object.keys(ann)) {
        // last-applied holds the whole object as written, Secret values included; big annotations are noise.
        if (k === "kubectl.kubernetes.io/last-applied-configuration") delete ann[k];
        else if (!KEEP_ANNOTATIONS.has(k) && typeof ann[k] === "string" && ann[k].length > 512) ann[k] = `<${ann[k].length} characters omitted>`;
      }
    }
    if (node.kind === "Secret" || (inSecretList && !node.kind)) {
      for (const f of ["data", "stringData"]) {
        if (node[f] && typeof node[f] === "object") node[f] = Object.fromEntries(Object.keys(node[f]).map((k) => [k, "<redacted>"]));
      }
    }
  }
  for (const [k, v] of Object.entries(node)) if (k !== "metadata") scrubObjects(v, inSecretList || node.kind === "SecretList");
}

/** env[].value of every container template anywhere in the object (pods, workloads, jobs, cronjobs, CRDs). */
function stripEnvValues(node: any) {
  if (Array.isArray(node)) return node.forEach(stripEnvValues);
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node.env)) {
    for (const e of node.env) if (e && typeof e === "object" && "value" in e) e.value = "<redacted>";
  }
  for (const v of Object.values(node)) stripEnvValues(v);
}

function walkStrings(node: any, f: (s: string) => string): any {
  if (typeof node === "string") return f(node);
  if (Array.isArray(node)) return node.map((x) => walkStrings(x, f));
  if (node && typeof node === "object") {
    for (const k of Object.keys(node)) node[k] = walkStrings(node[k], f);
  }
  return node;
}

/** Cap a whole tool result; the agent is told what was cut. */
export function capResult(text: string, limit = MAX_RESULT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… truncated (${text.length - limit} more characters). Narrow the request (namespace, labelSelector, limit, tailLines).`;
}

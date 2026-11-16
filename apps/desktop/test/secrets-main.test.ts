// Secret values in main (wave 8 part 4, D161–D168): main's own dialog unlocks one Secret, by uid, for one window on one
// cluster, for 5 minutes; a reveal answers one key to that window; a copy goes to the clipboard from main and is
// cleared 30 s later only if the clipboard still holds it; every read is one `object` token's one GET; every error is
// a fixed sentence; nothing of a value reaches main's log, the action log or an error. A marker value (LLMARK-…) is put
// in the fake Secret and searched for everywhere.
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));
const MARK = "LLMARK-0123456789abcdef0123456789abcdef0";
type Sent = { method: string; path: string; token: string };
const sent: Sent[] = [];
let secrets: Record<string, any> = {};
/** Answers instead of the store: a status, or a raw text, or a throw. */
let answer: ((path: string) => { status: number; text: string } | Error | undefined) | undefined;
vi.mock("@landlens/kube-mcp", () => ({
  frontDoorSend: ({ token }: { token: string }) => async (r: { method: string; path: string }) => {
    sent.push({ ...r, token });
    const a = answer?.(r.path);
    if (a instanceof Error) throw a;
    if (a) return { ...a, warnings: [] };
    const o = secrets[r.path];
    return o ? { status: 200, text: JSON.stringify(o), warnings: [] } : { status: 404, text: JSON.stringify({ kind: "Status", message: `secrets "${r.path}" not found` }), warnings: [] };
  },
}));
import { ActionLog } from "../src/main/action-log";
import { CLEAR_MS, MAX_UNLOCKS, SECRET_TEXT, SecretService, UNLOCK_MS, VALUE_READS } from "../src/main/secrets";

const PATH = "/api/v1/namespaces/landlens-dev/secrets/hands-secret";
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const secret = (o: { uid?: string; type?: string; data?: Record<string, string> } = {}) => ({
  apiVersion: "v1", kind: "Secret", type: o.type ?? "Opaque",
  metadata: { name: "hands-secret", namespace: "landlens-dev", uid: o.uid ?? "u1", resourceVersion: "7" },
  data: o.data ?? { username: b64("hands"), password: b64(MARK), blob: b64(Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3])), big: b64("a".repeat(70 * 1024)) },
});
const ref = { namespace: "landlens-dev", name: "hands-secret" };

function window() {
  const e = new EventEmitter() as EventEmitter & { isDestroyed(): boolean; destroyed: boolean };
  e.destroyed = false;
  e.isDestroyed = () => e.destroyed;
  return e as any;
}

const logged: string[] = [];
function setup(o: { now?: () => number; log?: any } = {}) {
  sent.length = 0;
  answer = undefined;
  secrets = { [PATH]: secret() };
  let n = 0;
  const grants: any[] = [];
  const issue = vi.fn((g: any) => (grants.push(g), String(++n % 10).repeat(64)));
  const revoke = vi.fn();
  let gone: (h: string) => void = () => {};
  const clusters = {
    get: (h: string) => (h === "h1234567" || h === "h7654321" ? { info: { context: h === "h1234567" ? "orbstack" : "other", server: "https://127.0.0.1:26443" } } : (() => { throw Object.assign(new Error("not connected"), { status: 404 }); })()),
    onGone: (f: (h: string) => void) => (gone = f),
  };
  const rows: any[] = [];
  const log = o.log ?? {
    add: (e: any) => (rows.push(e), e),
    settle: (id: string, end: any) => {
      const i = rows.findIndex((x) => x.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...end };
    },
  };
  let board = "";
  const clipboard = { writes: [] as string[], write: vi.fn(async (t: string) => void (clipboard.writes.push(t), (board = t))), readText: vi.fn(async () => board), clear: vi.fn(() => void (board = "")), set: (t: string) => void (board = t), get: () => board };
  const svc = new SecretService({ clusters: clusters as any, frontDoor: { issueToken: issue, revokeToken: revoke, clusterUrl: () => "https://127.0.0.1:1/c/h", certificate: "" } as any, log, clipboard, ...(o.now ? { now: o.now } : {}) });
  const yes = vi.fn(async () => true);
  const no = vi.fn(async () => false);
  return { svc, issue, revoke, grants, rows, clipboard, yes, no, gone: (h: string) => gone(h) };
}
const req = (key: string, handle = "h1234567") => ({ handle, secret: ref, key });

// Main's own log: everything this service could print goes through console; every test collects it.
for (const m of ["log", "info", "warn", "error", "debug"] as const) {
  vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
}
afterEach(() => {
  vi.useRealTimers();
  expect(logged.join("\n")).not.toContain(MARK);
  expect(logged.join("\n")).not.toContain(b64(MARK));
});

describe("unlock (D163)", () => {
  it("reads the Secret with one object token, then asks in main's dialog naming the cluster, namespace and Secret", async () => {
    const { svc, grants, revoke, yes } = setup();
    const wc = window();
    const r = await svc.unlock({ handle: "h1234567", secret: ref }, wc, yes);
    expect(r).toMatchObject({ unlocked: true, left: UNLOCK_MS });
    expect(grants).toEqual([{ label: "you · orbstack · secret landlens-dev/hands-secret", policy: { access: "object", object: { group: "", resource: "secrets", namespace: "landlens-dev", name: "hands-secret" } }, clusters: ["h1234567"] }]);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([{ method: "GET", path: PATH, token: "1".repeat(64) }]);
    expect(yes).toHaveBeenCalledWith({ message: "Show values of Secret landlens-dev/hands-secret?", detail: "Values are shown to you only, for 30 seconds at a time. Claude never sees them. On orbstack.", yes: "Show values" });
    expect(JSON.stringify(r)).not.toContain(MARK);
  });

  it("Cancel unlocks nothing; a missing Secret or a 403 is a fixed sentence and asks nothing", async () => {
    const { svc, no, yes } = setup();
    const wc = window();
    await expect(svc.unlock({ handle: "h1234567", secret: ref }, wc, no)).rejects.toMatchObject({ status: 409, message: SECRET_TEXT.cancelled });
    await expect(svc.reveal(req("password"), wc)).rejects.toMatchObject({ status: 403, message: SECRET_TEXT.locked });
    answer = () => ({ status: 403, text: JSON.stringify({ kind: "Status", message: `secrets is forbidden: ${MARK}` }) });
    await expect(svc.unlock({ handle: "h1234567", secret: ref }, wc, yes)).rejects.toMatchObject({ status: 403, message: "You can't read Secrets in landlens-dev." });
    answer = undefined;
    await expect(svc.unlock({ handle: "h1234567", secret: { namespace: "landlens-dev", name: "nope" } }, wc, yes)).rejects.toMatchObject({ status: 404, message: SECRET_TEXT.gone });
    expect(yes).not.toHaveBeenCalled();
  });

  it("refuses a Helm release record, a second dialog in the same window, and a sixth Secret", async () => {
    const { svc, yes } = setup();
    const wc = window();
    secrets[PATH] = secret({ type: "helm.sh/release.v1" });
    await expect(svc.unlock({ handle: "h1234567", secret: ref }, wc, yes)).rejects.toMatchObject({ status: 400, message: SECRET_TEXT.helm });
    secrets[PATH] = secret();
    let release: (v: boolean) => void = () => {};
    const slow = vi.fn(() => new Promise<boolean>((r) => (release = r)));
    const first = svc.unlock({ handle: "h1234567", secret: ref }, wc, slow);
    await vi.waitFor(() => expect(slow).toHaveBeenCalled());
    await expect(svc.unlock({ handle: "h1234567", secret: ref }, wc, yes)).rejects.toMatchObject({ status: 429 });
    release(true);
    await first;
    for (let i = 1; i < MAX_UNLOCKS; i++) {
      secrets[`/api/v1/namespaces/landlens-dev/secrets/s${i}`] = { ...secret({ uid: `u-s${i}` }), metadata: { name: `s${i}`, namespace: "landlens-dev", uid: `u-s${i}` } };
      await svc.unlock({ handle: "h1234567", secret: { namespace: "landlens-dev", name: `s${i}` } }, wc, yes);
    }
    secrets["/api/v1/namespaces/landlens-dev/secrets/s9"] = { ...secret({ uid: "u-s9" }), metadata: { name: "s9", namespace: "landlens-dev", uid: "u-s9" } };
    await expect(svc.unlock({ handle: "h1234567", secret: { namespace: "landlens-dev", name: "s9" } }, wc, yes)).rejects.toMatchObject({ status: 429, message: SECRET_TEXT.tooMany });
    // Unlocking one already unlocked again is not a sixth.
    await expect(svc.unlock({ handle: "h1234567", secret: ref }, wc, yes)).resolves.toMatchObject({ unlocked: true });
  });

  it("a window that went while the dialog was up gets no unlock", async () => {
    const { svc } = setup();
    const wc = window();
    const confirm = vi.fn(async () => (wc.destroyed = true, wc.emit("destroyed"), true));
    await expect(svc.unlock({ handle: "h1234567", secret: ref }, wc, confirm)).rejects.toMatchObject({ status: 410 });
  });
});

describe("reveal (D164)", () => {
  const unlocked = async (o: Parameters<typeof setup>[0] = {}) => {
    const s = setup(o);
    const wc = window();
    await s.svc.unlock({ handle: "h1234567", secret: ref }, wc, s.yes);
    sent.length = 0;
    s.grants.length = 0;
    return { ...s, wc };
  };

  it("answers one key as text, binary or large, each read its own object token, revoked", async () => {
    const { svc, wc, grants, revoke } = await unlocked();
    expect(await svc.reveal(req("password"), wc)).toEqual({ kind: "text", text: MARK, bytes: 40 });
    expect(await svc.reveal(req("blob"), wc)).toEqual({ kind: "binary", bytes: 5 });
    expect(await svc.reveal(req("big"), wc)).toEqual({ kind: "large", bytes: 70 * 1024 });
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([`GET ${PATH}`, `GET ${PATH}`, `GET ${PATH}`]);
    expect(new Set(sent.map((s) => s.token)).size).toBe(3);
    expect(grants.every((g) => g.policy.access === "object")).toBe(true);
    expect(revoke).toHaveBeenCalledTimes(4);
  });

  it("only to the window that unlocked it, on that cluster, while it lasts", async () => {
    let now = 1_000_000;
    const { svc, wc } = await unlocked({ now: () => now });
    await expect(svc.reveal(req("password"), window())).rejects.toMatchObject({ status: 403, message: SECRET_TEXT.locked });
    await expect(svc.reveal(req("password", "h7654321"), wc)).rejects.toMatchObject({ status: 403 });
    await expect(svc.reveal({ handle: "h1234567", secret: { namespace: "landlens-dev", name: "other" }, key: "password" }, wc)).rejects.toMatchObject({ status: 403 });
    now += UNLOCK_MS;
    await expect(svc.reveal(req("password"), wc)).rejects.toMatchObject({ status: 403, message: SECRET_TEXT.locked });
    expect(sent).toEqual([]);
  });

  it("ends on lock, navigation, a dead renderer, a destroyed window, the cluster going and another cluster connected", async () => {
    for (const end of [
      (s: any, wc: any) => s.svc.lock({ handle: "h1234567", secret: ref }, wc),
      (s: any, wc: any) => s.svc.lock({ handle: "h1234567" }, wc),
      (_s: any, wc: any) => wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false }),
      (_s: any, wc: any) => wc.emit("render-process-gone"),
      (_s: any, wc: any) => wc.emit("destroyed"),
      (s: any) => s.gone("h1234567"),
      (s: any, wc: any) => s.svc.lockWindow(wc),
    ]) {
      const s = await unlocked();
      expect((await s.svc.reveal(req("username"), s.wc)).kind).toBe("text");
      end(s, s.wc);
      await expect(s.svc.reveal(req("username"), s.wc)).rejects.toMatchObject({ status: 403, message: SECRET_TEXT.locked });
    }
    // A same-document navigation (a hash change) is not a new page.
    const s = await unlocked();
    s.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    expect((await s.svc.reveal(req("username"), s.wc)).kind).toBe("text");
  });

  it("a Secret replaced under the same name since the unlock: refused, and the unlock is dropped", async () => {
    const { svc, wc } = await unlocked();
    secrets[PATH] = secret({ uid: "u2" });
    await expect(svc.reveal(req("password"), wc)).rejects.toMatchObject({ status: 409, message: SECRET_TEXT.changed });
    secrets[PATH] = secret();
    await expect(svc.reveal(req("password"), wc)).rejects.toMatchObject({ status: 403 });
  });

  it("every failure is a fixed sentence with nothing of the cluster's text or the value", async () => {
    const { svc, wc, issue } = await unlocked();
    const cases: [typeof answer, number, string][] = [
      [() => ({ status: 403, text: JSON.stringify({ message: `forbidden ${MARK}` }) }), 403, "You can't read Secrets in landlens-dev."],
      [() => ({ status: 500, text: `boom ${MARK}` }), 502, "The cluster answered HTTP 500."],
      [() => ({ status: 200, text: `{"kind":"Secret","data":{"password":"${MARK}` }), 502, SECRET_TEXT.unreadable],
      [() => ({ status: 200, text: `${MARK} is not json` }), 502, SECRET_TEXT.unreadable],
      [() => ({ status: 200, text: JSON.stringify({ kind: "ConfigMap", data: { password: b64(MARK) } }) }), 502, SECRET_TEXT.unreadable],
      [() => new Error(`socket hang up ${MARK}`), 504, SECRET_TEXT.unreachable],
    ];
    for (const [a, status, message] of cases) {
      answer = a;
      const e = await svc.reveal(req("password"), wc).catch((x) => x);
      expect(e).toMatchObject({ status, message });
      expect(`${e.message} ${e.stack}`).not.toContain(MARK);
    }
    answer = undefined;
    await expect(svc.reveal(req("missing"), wc)).rejects.toMatchObject({ status: 404, message: SECRET_TEXT.keyGone });
    // Anything else that throws on the way (here the token's issue) becomes main's sentence, never its own text.
    issue.mockImplementationOnce(() => { throw new Error(`boom ${MARK}`); });
    const odd = await svc.reveal(req("password"), wc).catch((x) => x);
    expect(odd).toMatchObject({ status: 500, message: SECRET_TEXT.unreadable });
    expect(`${odd.message} ${odd.stack}`).not.toContain(MARK);
  });

  it("10 values a minute a window, reveals and copies together", async () => {
    let now = 5_000_000;
    const { svc, wc } = await unlocked({ now: () => now });
    for (let i = 0; i < VALUE_READS / 2; i++) {
      await svc.reveal(req("username"), wc);
      await svc.copy(req("username"), wc);
    }
    await expect(svc.reveal(req("username"), wc)).rejects.toMatchObject({ status: 429, message: SECRET_TEXT.rate });
    now += 60_001;
    await expect(svc.reveal(req("username"), wc)).resolves.toMatchObject({ kind: "text" });
  });

  it("one action-log row per reveal and copy: the Secret and the key, never a value or a length; a log that can't take it reads nothing", async () => {
    const { svc, wc, rows } = await unlocked();
    await svc.reveal(req("password"), wc);
    await svc.copy(req("password"), wc);
    await svc.reveal(req("missing"), wc).catch(() => {});
    expect(rows.map((r) => [r.action, r.kind, r.namespace, r.names, r.key, r.outcome, r.detail])).toEqual([
      ["reveal", "Secret", "landlens-dev", ["hands-secret"], "password", "applied", undefined],
      ["copy", "Secret", "landlens-dev", ["hands-secret"], "password", "applied", undefined],
      ["reveal", "Secret", "landlens-dev", ["hands-secret"], "missing", "failed", undefined],
    ]);
    expect(JSON.stringify(rows)).not.toMatch(new RegExp(`${MARK}|${b64(MARK)}|bytes`));
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["action", "at", "context", "group", "id", "key", "kind", "names", "namespace", "outcome", "resource", "server", "who"]);
    // The real log file too.
    const dir = (await import("node:fs")).mkdtempSync(join((await import("node:os")).tmpdir(), "landlens-secrets-log-"));
    const file = join(dir, "actions.json");
    const real = await unlocked({ log: new ActionLog(file) });
    await real.svc.reveal(req("password"), real.wc);
    await real.svc.copy(req("password"), real.wc);
    const text = readFileSync(file, "utf8");
    expect(text).toContain('"key": "password"');
    expect(text).not.toContain(MARK);
    expect(text).not.toContain(b64(MARK));
    // A log that can't take the row: nothing is read.
    const broken = await unlocked({ log: { add: () => { throw new Error("disk full"); }, settle: () => {} } });
    await expect(broken.svc.reveal(req("password"), broken.wc)).rejects.toMatchObject({ status: 500, message: SECRET_TEXT.logRefused });
    const unsaved = await unlocked({ log: { add: (e: any) => e, settle: () => {}, unsaved: true } });
    await expect(unsaved.svc.copy(req("password"), unsaved.wc)).rejects.toMatchObject({ status: 500 });
    expect(sent).toEqual([]);
    expect(unsaved.clipboard.writes).toEqual([]);
  });
});

describe("copy (D165)", () => {
  const unlocked = async () => {
    const s = setup();
    const wc = window();
    await s.svc.unlock({ handle: "h1234567", secret: ref }, wc, s.yes);
    return { ...s, wc };
  };

  it("writes the value to the clipboard from main; the window's answer has no value", async () => {
    const { svc, wc, clipboard } = await unlocked();
    const r = await svc.copy(req("password"), wc);
    expect(r).toEqual({ copied: true, clearsIn: 30 });
    expect(clipboard.writes).toEqual([MARK]);
    expect(JSON.stringify(r)).not.toContain(MARK);
    // Binary only as base64; base64 of text is the exact bytes.
    await expect(svc.copy(req("blob"), wc)).rejects.toMatchObject({ status: 415, message: SECRET_TEXT.notText });
    await svc.copy({ ...req("blob"), as: "base64" }, wc);
    expect(clipboard.writes.at(-1)).toBe(b64(Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3])));
  });

  it("clears the clipboard 30 s later only if it still holds the value, and at quit", async () => {
    vi.useFakeTimers();
    const a = await unlocked();
    await a.svc.copy(req("password"), a.wc);
    await vi.advanceTimersByTimeAsync(CLEAR_MS - 10);
    expect(a.clipboard.clear).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(a.clipboard.clear).toHaveBeenCalledTimes(1);
    expect(a.clipboard.get()).toBe("");

    const b = await unlocked();
    await b.svc.copy(req("password"), b.wc);
    b.clipboard.set("something the person copied since");
    await vi.advanceTimersByTimeAsync(CLEAR_MS + 10);
    expect(b.clipboard.clear).not.toHaveBeenCalled();
    expect(b.clipboard.get()).toBe("something the person copied since");

    const c = await unlocked();
    await c.svc.copy(req("password"), c.wc);
    await c.svc.quit();
    expect(c.clipboard.clear).toHaveBeenCalledTimes(1);
    const d = await unlocked();
    await d.svc.copy(req("password"), d.wc);
    d.clipboard.set("mine");
    await d.svc.quit();
    expect(d.clipboard.clear).not.toHaveBeenCalled();
  });

  it("the copied value isn't sent to Claude while the clipboard holds it", async () => {
    const { svc, wc, clipboard } = await unlocked();
    await svc.refuseCopied([`look at ${MARK}`]); // nothing copied yet
    await svc.copy(req("password"), wc);
    await expect(svc.refuseCopied([`please check ${MARK} for me`])).rejects.toMatchObject({ status: 400, message: SECRET_TEXT.inPrompt });
    await expect(svc.refuseCopied([undefined, "hello"])).resolves.toBeUndefined();
    await expect(svc.refusePrompt({ text: `is ${MARK} right?` })).rejects.toMatchObject({ status: 400 });
    clipboard.set("something else");
    await expect(svc.refuseCopied([`please check ${MARK}`])).resolves.toBeUndefined();
    // No Secret is attached to a prompt, whatever the window sends.
    await expect(svc.refusePrompt({ text: "hi", context: [{ group: "", resource: "secrets" }] })).rejects.toMatchObject({ status: 400, message: SECRET_TEXT.secretRef });
    await expect(svc.refusePrompt({ text: "hi", context: [{ group: "", resource: "configmaps" }] })).resolves.toBeUndefined();
  });
});

describe("certificates (D167)", () => {
  it("need no unlock, read with one object token, and give public halves only", async () => {
    const { svc, grants } = setup();
    const dir = join(__dirname, "../../../packages/kube/test/fixtures/doctor");
    const leaf = readFileSync(join(dir, "leaf.crt"), "utf8");
    secrets[PATH] = secret({ type: "kubernetes.io/tls", data: { "tls.crt": b64(leaf), "tls.key": b64(`-----BEGIN PRIVATE KEY-----\n${MARK}\n-----END PRIVATE KEY-----\n`), password: b64(MARK) } });
    const r = await svc.certs({ handle: "h1234567", secret: ref });
    expect(r.certs.map((c) => c.subject)).toEqual(["shop.example.test"]);
    expect(JSON.stringify(r)).not.toMatch(new RegExp(`${MARK}|PRIVATE`));
    expect(grants[0].policy).toEqual({ access: "object", object: { group: "", resource: "secrets", namespace: "landlens-dev", name: "hands-secret" } });
    answer = () => ({ status: 403, text: `nope ${MARK}` });
    await expect(svc.certs({ handle: "h1234567", secret: ref })).rejects.toMatchObject({ status: 403, message: "You can't read Secrets in landlens-dev." });
  });
});

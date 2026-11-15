// Landflow on a resource in main (main/landflow.ts, wave 7 part 4, D119–D126) against the loopback fakes: what the
// window may send (choices and main's ids only), that main sends exactly what the sheet showed, the opt-in log lines
// and YAML, following a run to Landfall's answer, what family-sent.json keeps, the links behind the native dialog, and
// that Landlens never calls Landfall (D123, security rows 7, 8, 10).
import { channels, FAMILY_NOTES, LANDFLOW_NOTES, type DoctorEvidence, type FamilyInfo, type KubeObject, type Problem, type ResourceRef, type ResourceType } from "@landlens/contracts";
import { FamilySentStore } from "@landlens/connections";
import { KubeError } from "@landlens/kube";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClicklandSettingsStore } from "../src/main/clickland-settings";
import { FamilyService } from "../src/main/family";
import { LANDFLOW, LandflowActions, outputText, serverHash } from "../src/main/landflow";
import { FakeLandfall, FakeLandflow, LF_KEY, LF_KEY_NARROW, SHARED, TRIAGE_SECRET } from "../../../packages/connections/test/fake-family";
import { fakeCrypto, tempFile } from "../../../packages/connections/test/helpers";

let stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stops.map((s) => s()));
  stops = [];
});
const up = async <T extends { start(): Promise<T>; stop(): Promise<void> }>(f: T): Promise<T> => {
  await f.start();
  stops.push(() => f.stop());
  return f;
};

const PROBLEM: Problem = {
  id: "crashloop:landlens-dev/Deployment/ledger-worker", class: "crashloop", tone: "bad", kind: "Deployment", namespace: "landlens-dev", name: "ledger-worker",
  group: "apps", version: "v1", resource: "deployments", reason: "CrashLoopBackOff", title: "ledger-worker is crash-looping",
  detail: "container worker · exit 2 (Error) · 124 restarts · 5 pods", container: "worker", restarts: 124, pods: ["ledger-worker-a"], podCount: 5,
  facts: { lastState: { reason: "Error", exitCode: 2 }, events: [] }, hint: { cause: "c", next: [] },
};
const DEPLOY: ResourceRef = { group: "apps", version: "v1", resource: "deployments", namespace: "landlens-dev", name: "ledger-worker" };
const SECRET_LINE = "calling the ledger with Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345";

const SERVER = "https://127.0.0.1:6443";
type SetupOptions = {
  key?: string; triage?: boolean; logs?: DoctorEvidence;
  /** The log read, the object read: a test can make them wait (H1). */
  evidence?: () => Promise<DoctorEvidence>;
  getObject?: (ref: ResourceRef) => Promise<KubeObject>;
  /** The cluster's context name and API server, per handle (L1, L6). */
  context?: (handle: string) => string;
  server?: (handle: string) => string;
  fetch?: typeof fetch;
  sent?: (file: string) => FamilySentStore;
  landfall?: string;
};

async function setup(o: SetupOptions = {}) {
  const lf = await up(new FakeLandflow());
  const lfa = await up(new FakeLandfall());
  const file = tempFile("family.json");
  const crypto = fakeCrypto(true);
  const logs: string[] = [];
  const family = new FamilyService({
    file, crypto, clickland: new ClicklandSettingsStore(tempFile("clickland.json"), crypto),
    openExternal: async () => {}, push: (_i: FamilyInfo) => {}, log: (l) => logs.push(l),
  });
  await family.connectLandflow(lf.origin, o.key ?? LF_KEY);
  if (o.triage !== false) family.set("landflow", { triage: { path: "alerts", header: "x-webhook-secret", secret: TRIAGE_SECRET } });
  const asked: string[] = [];
  const read: ResourceRef[] = [];
  const served: string[] = [];
  const sentFile = tempFile("family-sent.json");
  const clock = { t: Date.now() };
  const sent = o.sent ? o.sent(sentFile) : new FamilySentStore(sentFile);
  const object: KubeObject = {
    apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "ledger-worker", namespace: "landlens-dev", annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{\"secret\":1}" } },
    spec: { template: { spec: { containers: [{ name: "worker", env: [{ name: "LEDGER_TOKEN", value: "plain-env-secret-value" }] }] } } },
  } as unknown as KubeObject;
  const types: Record<string, ResourceType> = {
    deployments: { group: "apps", version: "v1", resource: "deployments", kind: "Deployment", namespaced: true, verbs: [] } as unknown as ResourceType,
    secrets: { group: "", version: "v1", resource: "secrets", kind: "Secret", namespaced: true, verbs: [] } as unknown as ResourceType,
    configmaps: { group: "", version: "v1", resource: "configmaps", kind: "ConfigMap", namespaced: true, verbs: [] } as unknown as ResourceType,
  };
  const actions = new LandflowActions({
    family: { landflowUse: () => family.landflowUse(), log: (l) => family.log(l), landfallOrigin: () => o.landfall },
    doctor: {
      problem: (_h, ns, id) => {
        if (ns !== "landlens-dev" && ns !== undefined) throw new KubeError(404, "That problem isn't in the current report.");
        if (id !== PROBLEM.id) throw new KubeError(404, "That problem isn't in the current report.");
        return PROBLEM;
      },
      evidence: async (_h, _ns, id) => (asked.push(id), o.evidence ? await o.evidence() : o.logs ?? { log: { pod: "ledger-worker-a", container: "worker", previous: true, lines: ["starting", SECRET_LINE, "FATAL: cannot parse LEDGER_SHARDS"], cut: false } }),
    },
    clusters: {
      context: o.context ?? (() => "orbstack"),
      server: o.server ?? (() => SERVER),
      typeOf: async (_h, ref) => types[ref.resource]!,
      getObject: async (_h, ref) => (read.push(ref), o.getObject ? o.getObject(ref) : ref.name === DEPLOY.name || ref.resource === "secrets" ? object : Promise.reject(new KubeError(404, `${ref.resource} "${ref.name}" not found`))),
    },
    sent,
    served: (rows) => served.push(...rows.map((r) => r.body)),
    ...(o.fetch ? { fetch: o.fetch } : {}),
    now: () => clock.t,
  });
  // One read of a run serves 1.5 s of asks: the tests move this clock instead of waiting.
  const tick = () => void (clock.t += 2_000);
  return { lf, lfa, family, actions, asked, read, served, sent, sentFile, file, logs, tick, clock };
}
const win = {};
const other = {};
const dialog = (answer: boolean) => {
  const q: string[] = [];
  const opened: string[] = [];
  return { q, opened, ask: { confirm: async (x: { message: string; detail: string }) => (q.push(`${x.message}\n${x.detail}`), answer), openExternal: async (u: string) => void opened.push(u) } };
};

describe("what the window may send (D126, security row 8)", () => {
  it("only choices and main's ids: a title, a description, an address or a body is refused", () => {
    const base = { handle: "h1234567890", problem: PROBLEM.id, severity: "sev2", logs: false };
    expect(channels["landflow:alert"].safeParse(base).success).toBe(true);
    for (const extra of [{ title: "x" }, { description: "x" }, { alert: {} }, { url: "http://evil" }, { body: "{}" }]) {
      expect(channels["landflow:alert"].safeParse({ ...base, ...extra }).success).toBe(false);
    }
    expect(channels["landflow:alert"].safeParse({ ...base, severity: "critical" }).success).toBe(false);
    expect(channels["landflow:triage"].safeParse({ sheet: "ls" + "a".repeat(24), alert: {} }).success).toBe(false);
    expect(channels["landflow:run"].safeParse({ sheet: "ls" + "a".repeat(24), flow: "wf_x", input: {} }).success).toBe(false);
    expect(channels["landflow:run"].safeParse({ sheet: "ls" + "a".repeat(24), flow: "../x" }).success).toBe(false);
    expect(channels["landflow:input"].safeParse({ handle: "h1234567890", ref: { ...DEPLOY, kind: "x" }, yaml: false }).success).toBe(false);
    expect(channels["landflow:open"].safeParse({ run: "lr" + "a".repeat(24), what: "room", url: "https://evil.example" }).success).toBe(false);
  });

  it("a send names the body it showed; one id rule for flows (review of part 4, H1, L9)", () => {
    const sheet = "ls" + "a".repeat(24);
    const digest = "a".repeat(64);
    expect(channels["landflow:triage"].safeParse({ sheet }).success).toBe(false);
    expect(channels["landflow:triage"].safeParse({ sheet, digest }).success).toBe(true);
    expect(channels["landflow:triage"].safeParse({ sheet, digest: "A".repeat(64) }).success).toBe(false);
    expect(channels["landflow:run"].safeParse({ sheet, flow: "wf_x" }).success).toBe(false);
    // A flow Landflow lists with a 101-character id is one Landlens runs; a dotted one isn't.
    expect(channels["landflow:run"].safeParse({ sheet, digest, flow: "w".repeat(101) }).success).toBe(true);
    expect(channels["landflow:run"].safeParse({ sheet, digest, flow: "wf.x" }).success).toBe(false);
  });

  it("builds the alert from the problem in the scope's current report; another id is refused", async () => {
    const t = await setup();
    const p = await t.actions.prepareAlert({ handle: "h1", namespace: "landlens-dev", problem: PROBLEM.id, severity: "sev2", logs: false }, win);
    expect(p.alert).toMatchObject({ title: PROBLEM.title, service: "ledger-worker", environment: "orbstack", severity: "sev2", id: "landlens:orbstack:landlens-dev/Deployment/ledger-worker:crashloop" });
    expect(p).toMatchObject({ to: `${t.lf.origin}/api/webhook/alerts`, header: "x-webhook-secret" });
    expect(JSON.stringify(p)).not.toContain(TRIAGE_SECRET);
    await expect(t.actions.prepareAlert({ handle: "h1", namespace: "landlens-dev", problem: "crashloop:landlens-dev/Deployment/other", severity: "sev2", logs: false }, win)).rejects.toMatchObject({ status: 404 });
    expect(t.lf.alerts).toHaveLength(0);
  });

  it("asks for no log lines unless ticked; ticked, they are scrubbed and shown before they are sent", async () => {
    const t = await setup();
    const off = await t.actions.prepareAlert({ handle: "h1", namespace: "landlens-dev", problem: PROBLEM.id, severity: "sev2", logs: false }, win);
    expect(t.asked).toEqual([]);
    expect(off.alert.description).not.toContain("FATAL");
    const on = await t.actions.prepareAlert({ handle: "h1", namespace: "landlens-dev", problem: PROBLEM.id, severity: "sev2", logs: true, sheet: off.sheet }, win);
    expect(t.asked).toEqual([PROBLEM.id]);
    expect(on.logs).toEqual({ lines: 3 });
    expect(on.alert.description).toContain("FATAL: cannot parse LEDGER_SHARDS");
    expect(on.alert.description).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    await t.actions.sendAlert({ sheet: on.sheet, digest: on.digest }, win);
    expect(JSON.stringify(t.lf.alerts[0]!.body)).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
  });
});

describe("sending to triage (D120–D124)", () => {
  it("sends exactly the alert the sheet showed, with one Idempotency-Key per sheet, from its own window only", async () => {
    const t = await setup();
    const p1 = await t.actions.prepareAlert({ handle: "h1", namespace: "landlens-dev", problem: PROBLEM.id, severity: "sev3", logs: false }, win);
    // Another severity on the same sheet: the same sheet, a new body.
    const p = await t.actions.prepareAlert({ handle: "h1", namespace: "landlens-dev", problem: PROBLEM.id, severity: "sev1", logs: false, sheet: p1.sheet }, win);
    expect(p.sheet).toBe(p1.sheet);
    await expect(t.actions.sendAlert({ sheet: p.sheet, digest: p.digest }, other)).rejects.toThrow(LANDFLOW_NOTES.noSheet);
    expect(t.lf.alerts).toHaveLength(0);
    const r = await t.actions.sendAlert({ sheet: p.sheet, digest: p.digest }, win);
    expect(r).toMatchObject({ note: LANDFLOW_NOTES.following, follow: true, status: "running", runLink: expect.stringMatching(new RegExp(`^${t.lf.origin}/workflows/wf_triage/executions/ex`)) });
    expect(t.lf.alerts[0]!.body).toEqual(p.alert);
    expect(t.lf.alerts[0]!.headers["idempotency-key"]).toBe(`landlens-${p.sheet}-${p.digest.slice(0, 16)}`);
    // A retry of the same click: the same key, the same run; Landflow starts nothing new.
    const again = await t.actions.sendAlert({ sheet: p.sheet, digest: p.digest }, win);
    expect(again.run).toBe(r.run);
    expect(t.lf.alerts).toHaveLength(1);
    expect(t.lf.requests.filter((x) => x.path === "/api/webhook/alerts")).toHaveLength(2);
    // A sent sheet isn't reused: asked again, it is a new sheet.
    const next = await t.actions.prepareAlert({ handle: "h1", namespace: "landlens-dev", problem: PROBLEM.id, severity: "sev1", logs: false, sheet: p.sheet }, win);
    expect(next.sheet).not.toBe(p.sheet);
  });

  it("follows the run to Landfall's answer: the room's link, remembered without secrets, and Landfall never called (D122–D124)", async () => {
    const t = await setup();
    t.lf.triage = { outcome: "opened", incidentId: "inc_7", workspaceUrl: `${t.lfa.origin}/o/acme/i/7` };
    const p = await t.actions.prepareAlert({ handle: "h1", namespace: "landlens-dev", problem: PROBLEM.id, severity: "sev2", logs: true }, win);
    const r = await t.actions.sendAlert({ sheet: p.sheet, digest: p.digest }, win);
    const first = await t.actions.follow({ run: r.run! });
    expect(first).toMatchObject({ note: LANDFLOW_NOTES.following, follow: true });
    expect(first).not.toHaveProperty("room");
    t.tick();
    const done = await t.actions.follow({ run: r.run! });
    expect(done).toEqual({ run: r.run, runLink: expect.any(String), status: "success", note: LANDFLOW_NOTES.opened, tone: "bad", follow: false, outcome: "opened", room: `${t.lfa.origin}/o/acme/i/7` });
    expect(t.actions.sentFor({ handle: "h1" }).entries).toEqual([{ run: r.run, problem: PROBLEM.id, title: PROBLEM.title, severity: "sev2", at: expect.any(String), state: "room", room: `${t.lfa.origin}/o/acme/i/7` }]);
    const stored = readFileSync(t.sentFile, "utf8");
    for (const s of [LF_KEY, TRIAGE_SECRET, "x-webhook-secret", "FATAL", "description"]) expect(stored).not.toContain(s);
    expect((statSync(t.sentFile).mode & 0o777).toString(8)).toBe("600");
    expect(t.lfa.requests).toEqual([]);
    expect(t.lfa.forbidden).toEqual([]);
    // What crossed: only these keys.
    expect(Object.keys(done).sort()).toEqual(["follow", "note", "outcome", "room", "run", "runLink", "status", "tone"]);
    // The store keeps its own fields only: anything else (a header, a secret, a body) is refused, never written.
    const extra = { run: "lr" + "x".repeat(24), alert: "a", cluster: "orbstack", server: serverHash(SERVER), problem: PROBLEM.id, title: "t", severity: "sev2" as const, at: new Date().toISOString(), origin: t.lf.origin, secret: TRIAGE_SECRET };
    expect(() => t.sent.add(extra as never)).toThrow();
    expect(readFileSync(t.sentFile, "utf8")).not.toContain(TRIAGE_SECRET);
  });

  it("says each of Landfall's other answers and a waiting or failed run in D122's sentences", async () => {
    for (const [triage, note] of [
      [{ outcome: "attached", workspaceUrl: "https://landfall.example/i/1" }, LANDFLOW_NOTES.attached],
      [{ outcome: "suppressed" }, LANDFLOW_NOTES.recorded],
      ["waiting", LANDFLOW_NOTES.waiting],
      ["error", LANDFLOW_NOTES.failed],
    ] as const) {
      const t = await setup();
      t.lf.triage = triage as FakeLandflow["triage"];
      const p = await t.actions.prepareAlert({ handle: "h1", namespace: "landlens-dev", problem: PROBLEM.id, severity: "sev4", logs: false }, win);
      const r = await t.actions.sendAlert({ sheet: p.sheet, digest: p.digest }, win);
      await t.actions.follow({ run: r.run! });
      t.tick();
      expect((await t.actions.follow({ run: r.run! })).note).toBe(note);
    }
  });

  it("without executions:read, says Sent to triage with a link to the run; held alerts are said too", async () => {
    const t = await setup();
    t.lf.keys.set(LF_KEY, { scopes: ["brain:read", "run", "workflows:read"] });
    await t.family.connectLandflow(t.lf.origin, LF_KEY);
    t.family.set("landflow", { triage: { path: "alerts", header: "x-webhook-secret", secret: TRIAGE_SECRET } });
    const p = await t.actions.prepareAlert({ handle: "h1", namespace: "landlens-dev", problem: PROBLEM.id, severity: "sev2", logs: false }, win);
    const r = await t.actions.sendAlert({ sheet: p.sheet, digest: p.digest }, win);
    expect(r).toMatchObject({ note: LANDFLOW_NOTES.sent, follow: false, runLink: expect.stringContaining("/workflows/wf_triage/executions/") });
    expect(t.lf.requests.some((x) => x.path.startsWith("/api/executions/"))).toBe(false);
    t.lf.respond = "debounced";
    const p2 = await t.actions.prepareAlert({ handle: "h1", namespace: "landlens-dev", problem: PROBLEM.id, severity: "sev2", logs: false }, win);
    expect(await t.actions.sendAlert({ sheet: p2.sheet, digest: p2.digest }, win)).toEqual({ note: LANDFLOW_NOTES.held, tone: "info", follow: false });
  });

  it("has nothing to send without a triage webhook, and a refused secret is said, never echoed", async () => {
    const none = await setup({ triage: false });
    await expect(none.actions.prepareAlert({ handle: "h1", namespace: "landlens-dev", problem: PROBLEM.id, severity: "sev2", logs: false }, win)).rejects.toThrow(LANDFLOW_NOTES.noTriage);
    const t = await setup();
    const p = await t.actions.prepareAlert({ handle: "h1", namespace: "landlens-dev", problem: PROBLEM.id, severity: "sev2", logs: false }, win);
    t.lf.webhook.secret = "rotated-in-landflow";
    await expect(t.actions.sendAlert({ sheet: p.sheet, digest: p.digest }, win)).rejects.toThrow(LANDFLOW_NOTES.secretRefused);
    expect(t.logs.join("\n")).not.toContain(TRIAGE_SECRET);
  });
});

describe("links open only after main's dialog (security row 10)", () => {
  it("opens the run or the room main holds, showing the host first; No opens nothing", async () => {
    const t = await setup();
    t.lf.triage = { outcome: "opened", workspaceUrl: "https://landfall.example/o/acme/i/3" };
    const p = await t.actions.prepareAlert({ handle: "h1", namespace: "landlens-dev", problem: PROBLEM.id, severity: "sev2", logs: false }, win);
    const r = await t.actions.sendAlert({ sheet: p.sheet, digest: p.digest }, win);
    await expect(t.actions.open({ run: r.run!, what: "room" }, dialog(true).ask, win)).rejects.toMatchObject({ status: 404 });
    await t.actions.follow({ run: r.run! });
    t.tick();
    await t.actions.follow({ run: r.run! });
    const no = dialog(false);
    expect(await t.actions.open({ run: r.run!, what: "room" }, no.ask, win)).toEqual({ opened: false });
    expect(no.opened).toEqual([]);
    expect(no.q[0]).toMatch(/^Open landfall\.example in your browser\?/);
    const yes = dialog(true);
    expect(await t.actions.open({ run: r.run!, what: "run" }, yes.ask, win)).toEqual({ opened: true });
    expect(yes.opened[0]).toMatch(new RegExp(`^${t.lf.origin}/workflows/wf_triage/executions/`));
    await expect(t.actions.open({ run: "lr" + "z".repeat(24), what: "run" }, yes.ask, win)).rejects.toMatchObject({ status: 404 });
  });

  it("never keeps a room address that isn't http(s)", async () => {
    const t = await setup();
    t.lf.triage = { outcome: "opened", workspaceUrl: "javascript:alert(1)" };
    const p = await t.actions.prepareAlert({ handle: "h1", namespace: "landlens-dev", problem: PROBLEM.id, severity: "sev2", logs: false }, win);
    const r = await t.actions.sendAlert({ sheet: p.sheet, digest: p.digest }, win);
    await t.actions.follow({ run: r.run! });
    t.tick();
    expect(await t.actions.follow({ run: r.run! })).not.toHaveProperty("room");
    expect(readFileSync(t.sentFile, "utf8")).not.toContain("javascript");
    await expect(t.actions.open({ run: r.run!, what: "room" }, dialog(true).ask, win)).rejects.toMatchObject({ status: 404 });
  });

  it("checks the address again when opening: a remembered room with user info opens nothing, and asks nothing", async () => {
    const t = await setup();
    const run = "lr" + "u".repeat(24);
    // family-sent.json is the person's file: a room in it is checked again at the moment it would open.
    t.sent.add({ run, alert: "a", cluster: "orbstack", server: serverHash(SERVER), problem: PROBLEM.id, title: "t", severity: "sev2", at: new Date().toISOString(), origin: t.lf.origin, outcome: "opened", room: "https://someone:pw@landfall.example/o/x/i/1" });
    const d = dialog(true);
    await expect(t.actions.open({ run, what: "room" }, d.ask, win)).rejects.toMatchObject({ status: 400 });
    expect(d.q).toEqual([]);
    expect(d.opened).toEqual([]);
  });
});

describe("a flow on a resource (D125)", () => {
  it("builds the input from names, adds YAML only when ticked, scrubbed, and never a Secret's", async () => {
    const t = await setup();
    const plain = await t.actions.prepareInput({ handle: "h1", ref: DEPLOY, yaml: false }, win);
    expect(plain.input).toEqual({ landlens: 1, cluster: "orbstack", namespace: "landlens-dev", kind: "Deployment", apiVersion: "apps/v1", name: "ledger-worker" });
    // The object is read even without its YAML: the names sent are the cluster's (review of part 4, L4).
    expect(t.read).toEqual([DEPLOY]);
    const withYaml = await t.actions.prepareInput({ handle: "h1", ref: DEPLOY, namespace: "landlens-dev", problem: PROBLEM.id, yaml: true }, win);
    expect(withYaml.input.problem).toEqual({ class: "crashloop", reason: "CrashLoopBackOff", title: PROBLEM.title });
    expect(withYaml.input.yaml).toContain("name: LEDGER_TOKEN");
    expect(withYaml.input.yaml).not.toContain("plain-env-secret-value");
    expect(withYaml.input.yaml).not.toContain("last-applied-configuration");
    const secret = await t.actions.prepareInput({ handle: "h1", ref: { group: "", version: "v1", resource: "secrets", namespace: "landlens-dev", name: "db" }, yaml: true }, win);
    expect(secret.input).not.toHaveProperty("yaml");
    expect(secret.yaml).toEqual({ note: "A Secret's YAML is never sent." });
    expect(t.read).toHaveLength(3);
  });

  it("runs only a flow tagged landlens, with the sheet's input, and shows its output scrubbed and cut", async () => {
    const t = await setup();
    t.lf.flowOutput = { verdict: "ok", token: `Bearer ${"q".repeat(30)}`, long: "x".repeat(6_000) };
    const s = await t.actions.prepareInput({ handle: "h1", ref: DEPLOY, yaml: false }, win);
    await t.actions.flows(win);
    await expect(t.actions.run({ sheet: s.sheet, flow: "wf_other", digest: s.digest }, win)).rejects.toThrow(LANDFLOW_NOTES.noFlow);
    expect(t.lf.requests.some((x) => x.path.endsWith("/execute"))).toBe(false);
    await expect(t.actions.run({ sheet: s.sheet, flow: "wf_landlens_check", digest: s.digest }, other)).rejects.toThrow(LANDFLOW_NOTES.noSheet);
    const r = await t.actions.run({ sheet: s.sheet, flow: "wf_landlens_check", digest: s.digest }, win);
    expect(r).toMatchObject({ note: LANDFLOW_NOTES.started, follow: true });
    expect([...t.lf.inputs.values()]).toEqual([s.input]);
    await t.actions.follow({ run: r.run! });
    t.tick();
    const done = await t.actions.follow({ run: r.run! });
    expect(done).toMatchObject({ note: LANDFLOW_NOTES.finished, status: "success", follow: false });
    expect(done.output).toContain('"verdict": "ok"');
    expect(done.output).not.toContain("q".repeat(30));
    expect(done.output!.length).toBeLessThanOrEqual(4_000 + 10);
    expect(Object.keys(done).sort()).toEqual(["follow", "note", "output", "run", "runLink", "status", "tone"]);
    expect(t.lfa.requests).toEqual([]);
  });

  it("isn't offered to a key that can't list or run flows", async () => {
    const t = await setup({ key: LF_KEY_NARROW, triage: false });
    await expect(t.actions.flows(win)).rejects.toThrow(LANDFLOW_NOTES.cantList);
    await expect(t.actions.prepareInput({ handle: "h1", ref: DEPLOY, yaml: false }, win)).rejects.toThrow(LANDFLOW_NOTES.cantRun);
  });
});

describe("Landlens never calls Landfall's trigger, timeline or artifact routes (D123, security row 7)", () => {
  it("no source file names one of those routes", () => {
    const roots = [resolve(__dirname, "../src"), ...readdirSync(resolve(__dirname, "../../../packages")).map((p) => resolve(__dirname, "../../../packages", p, "src"))];
    const files: string[] = [];
    const walk = (d: string) => {
      let names: string[];
      try {
        names = readdirSync(d);
      } catch {
        return;
      }
      for (const n of names) {
        const f = join(d, n);
        if (statSync(f).isDirectory()) walk(f);
        else if (/\.(ts|tsx)$/.test(n)) files.push(f);
      }
    };
    roots.forEach(walk);
    expect(files.length).toBeGreaterThan(100);
    const hits = files.flatMap((f) =>
      readFileSync(f, "utf8").split("\n").map((l, i) => ({ f, i, l })).filter(({ l }) => !/^\s*(\/\/|\*|\/\*)/.test(l) && /["'`/](?:o\/[^"'`]*\/)?(triggers|timeline|artifacts|heartbeats)\b/.test(l) && !/\/api\/webhook/.test(l)));
    expect(hits.map((h) => `${h.f}:${h.i + 1}`)).toEqual([]);
    // No pinnedFetch is built for a Landfall address outside the MCP sign-in (mcp-oauth.ts) that Landfall's tools use
    // (review of part 4, L7): a `landfall` within two lines of a pinnedFetch( is a hit.
    const near = files.filter((f) => !f.endsWith("mcp-oauth.ts")).flatMap((f) => {
      const lines = readFileSync(f, "utf8").split("\n");
      return lines.flatMap((l, i) => (/pinnedFetch\(/.test(l) && /landfall/i.test(lines.slice(Math.max(0, i - 2), i + 3).join("\n")) ? [`${f}:${i + 1}`] : []));
    });
    expect(near).toEqual([]);
  });
});

// Security review of part 4 (H1, M1–M4, L1, L4–L6, L8, L10): each test fails with its rule removed.
const LOGS: DoctorEvidence = { log: { pod: "ledger-worker-a", container: "worker", previous: true, lines: ["starting", "FATAL: cannot parse LEDGER_SHARDS"], cut: false } } as DoctorEvidence;
const ask = (o: { severity?: "sev1" | "sev2" | "sev3" | "sev4"; logs?: boolean; sheet?: string } = {}) =>
  ({ handle: "h1", namespace: "landlens-dev", problem: PROBLEM.id, severity: o.severity ?? "sev3", logs: o.logs ?? false, ...(o.sheet ? { sheet: o.sheet } : {}) });
const deployment = (name = "ledger-worker") => ({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name, namespace: "landlens-dev" }, spec: {} }) as unknown as KubeObject;

describe("the sheet sends what it shows (H1)", () => {
  it("drops a slower, earlier prepare: the log lines unticked stay out of what is sent", async () => {
    let release!: (e: DoctorEvidence) => void;
    const t = await setup({ evidence: () => new Promise((r) => (release = r)) });
    const first = await t.actions.prepareAlert(ask(), win);
    const a = t.actions.prepareAlert(ask({ logs: true, sheet: first.sheet }), win); // waits on the log read
    const b = await t.actions.prepareAlert(ask({ logs: false, sheet: first.sheet }), win);
    release(LOGS);
    await expect(a).rejects.toThrow(LANDFLOW_NOTES.sheetChanged);
    await t.actions.sendAlert({ sheet: b.sheet, digest: b.digest }, win);
    expect(t.lf.alerts[0]!.body).toEqual(b.alert);
    expect(JSON.stringify(t.lf.alerts[0]!.body)).not.toContain("Last log lines");
  });

  it("refuses a send that names another body than the sheet keeps, and sends nothing", async () => {
    const t = await setup();
    const p1 = await t.actions.prepareAlert(ask({ severity: "sev4" }), win);
    const p2 = await t.actions.prepareAlert(ask({ severity: "sev1", sheet: p1.sheet }), win);
    expect(p2.sheet).toBe(p1.sheet);
    expect(p2.digest).not.toBe(p1.digest);
    await expect(t.actions.sendAlert({ sheet: p1.sheet, digest: p1.digest }, win)).rejects.toThrow(LANDFLOW_NOTES.sheetChanged);
    expect(t.lf.alerts).toHaveLength(0);
  });

  it("the flow sheet too: a slower prepare with the YAML doesn't replace the input shown without it", async () => {
    let calls = 0;
    let release!: () => void;
    const t = await setup({ getObject: () => (++calls === 2 ? new Promise<KubeObject>((r) => (release = () => r(deployment()))) : Promise.resolve(deployment())) });
    const first = await t.actions.prepareInput({ handle: "h1", ref: DEPLOY, yaml: false }, win);
    const a = t.actions.prepareInput({ handle: "h1", ref: DEPLOY, yaml: true, sheet: first.sheet }, win); // waits on the object read
    const b = await t.actions.prepareInput({ handle: "h1", ref: DEPLOY, yaml: false, sheet: first.sheet }, win);
    release();
    await expect(a).rejects.toThrow(LANDFLOW_NOTES.sheetChanged);
    await t.actions.flows(win);
    await t.actions.run({ sheet: b.sheet, flow: "wf_landlens_check", digest: b.digest }, win);
    expect([...t.lf.inputs.values()]).toEqual([b.input]);
    expect(b.input).not.toHaveProperty("yaml");
    await expect(t.actions.run({ sheet: b.sheet, flow: "wf_landlens_check", digest: "0".repeat(64) }, win)).rejects.toThrow(LANDFLOW_NOTES.sheetChanged);
  });
});

describe("an edited sheet gets a new Idempotency-Key (M1)", () => {
  it("after a send that got no answer, another severity starts its own run; a plain retry keeps its key", async () => {
    let drop = 1;
    // Landflow takes the first alert, and its answer is lost (Landlens's 15 s ran out).
    const f: typeof fetch = async (input, init) => {
      const r = await fetch(input, init);
      if (drop && String(input).includes("/api/webhook/")) {
        drop--;
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      }
      return r;
    };
    const t = await setup({ fetch: f });
    const p1 = await t.actions.prepareAlert(ask({ severity: "sev3" }), win);
    await expect(t.actions.sendAlert({ sheet: p1.sheet, digest: p1.digest }, win)).rejects.toThrow(FAMILY_NOTES.landflowSlow);
    const p2 = await t.actions.prepareAlert(ask({ severity: "sev1", sheet: p1.sheet }), win);
    expect(p2.sheet).toBe(p1.sheet);
    await t.actions.sendAlert({ sheet: p2.sheet, digest: p2.digest }, win);
    expect(t.lf.alerts).toHaveLength(2);
    const keys = t.lf.alerts.map((a) => a.headers["idempotency-key"]);
    expect(keys[0]).not.toBe(keys[1]);
    expect(t.lf.alerts[1]!.body).toMatchObject({ severity: "sev1" });
    // The same body sent again: the same key, the same run.
    await t.actions.sendAlert({ sheet: p2.sheet, digest: p2.digest }, win);
    expect(t.lf.alerts).toHaveLength(2);
  });
});

describe("a flow runs only as the window was shown it (M2)", () => {
  it("refuses a flow renamed or saved again since the list, and runs nothing; listed again, it runs", async () => {
    const t = await setup();
    const s = await t.actions.prepareInput({ handle: "h1", ref: DEPLOY, yaml: false }, win);
    const listed = await t.actions.flows(win);
    expect(listed.flows[0]).toEqual({ id: "wf_landlens_check", name: "Check a workload", description: "A two-node flow: Manual trigger → Set.", owner: "Fable Person", shared: false, runnable: true });
    const wf = t.lf.workflows[0]!;
    wf.name = "Check a workload (now posting it elsewhere)";
    wf.updatedAt = "2026-11-15T11:00:00.000Z";
    await expect(t.actions.run({ sheet: s.sheet, flow: "wf_landlens_check", digest: s.digest }, win)).rejects.toThrow(LANDFLOW_NOTES.flowChanged);
    // Saved again under its old name: still a change.
    wf.name = "Check a workload";
    wf.updatedAt = "2026-11-15T12:00:00.000Z";
    await expect(t.actions.run({ sheet: s.sheet, flow: "wf_landlens_check", digest: s.digest }, win)).rejects.toThrow(LANDFLOW_NOTES.flowChanged);
    expect(t.lf.requests.some((x) => x.path.endsWith("/execute"))).toBe(false);
    await t.actions.flows(win);
    await t.actions.run({ sheet: s.sheet, flow: "wf_landlens_check", digest: s.digest }, win);
    expect(t.lf.inputs.size).toBe(1);
  });

  it("marks a flow another project shared, and a window that never listed it can't run it", async () => {
    const t = await setup();
    t.lf.workflows.push({ id: "wf_ops_check", name: "Check a workload", tags: ["landlens"], updatedAt: "2026-11-15T10:00:00.000Z", ownership: SHARED });
    const { flows } = await t.actions.flows(win);
    expect(flows.find((f) => f.id === "wf_ops_check")).toMatchObject({ shared: true, owner: "Ops" });
    const s = await t.actions.prepareInput({ handle: "h1", ref: DEPLOY, yaml: false }, other);
    await expect(t.actions.run({ sheet: s.sheet, flow: "wf_landlens_check", digest: s.digest }, other)).rejects.toThrow(LANDFLOW_NOTES.flowChanged);
  });
});

describe("the object's YAML is scrubbed as text (M3)", () => {
  it("a ConfigMap's DB_PASSWORD and API_TOKEN values never leave", async () => {
    const cm = { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "ledger-config", namespace: "landlens-dev" }, data: { DB_PASSWORD: "hunter2hunter2", API_TOKEN: "abcdef123456", LOG_LEVEL: "debug" } } as unknown as KubeObject;
    const t = await setup({ getObject: async () => cm });
    const p = await t.actions.prepareInput({ handle: "h1", ref: { group: "", version: "v1", resource: "configmaps", namespace: "landlens-dev", name: "ledger-config" }, yaml: true }, win);
    expect(p.input.yaml).toContain("DB_PASSWORD:");
    expect(p.input.yaml).toContain("LOG_LEVEL: debug");
    expect(p.input.yaml).not.toContain("hunter2hunter2");
    expect(p.input.yaml).not.toContain("abcdef123456");
  });
});

describe("rules that held only by reading (M4)", () => {
  it("a sheet lives 30 minutes", async () => {
    const t = await setup();
    const p = await t.actions.prepareAlert(ask(), win);
    t.clock.t += LANDFLOW.sheetMs + 1;
    await expect(t.actions.sendAlert({ sheet: p.sheet, digest: p.digest }, win)).rejects.toThrow(LANDFLOW_NOTES.noSheet);
    expect(t.lf.alerts).toHaveLength(0);
  });

  it("at most 20 sheets: the oldest goes", async () => {
    const t = await setup();
    const sheets = [];
    for (let i = 0; i <= LANDFLOW.sheets; i++) {
      sheets.push(await t.actions.prepareAlert(ask(), win));
      t.clock.t += 1;
    }
    await expect(t.actions.sendAlert({ sheet: sheets[0]!.sheet, digest: sheets[0]!.digest }, win)).rejects.toThrow(LANDFLOW_NOTES.noSheet);
    await t.actions.sendAlert({ sheet: sheets[1]!.sheet, digest: sheets[1]!.digest }, win);
    expect(t.lf.alerts).toHaveLength(1);
  });

  it("a remembered send from another Landflow is never read from the one connected now", async () => {
    const t = await setup();
    const run = "lr" + "o".repeat(24);
    t.sent.add({ run, alert: "a", cluster: "orbstack", server: serverHash(SERVER), problem: PROBLEM.id, title: "t", severity: "sev2", at: new Date().toISOString(), origin: "http://127.0.0.1:9", executionId: "ex_elsewhere", workflowId: "wf_triage" });
    const r = await t.actions.follow({ run });
    expect(r).toMatchObject({ follow: false, runLink: "http://127.0.0.1:9/workflows/wf_triage/executions/ex_elsewhere" });
    expect(t.lf.requests.filter((x) => x.path.startsWith("/api/executions/"))).toEqual([]);
  });

  it("a room opens only for opened or attached: a recorded send's room asks nothing", async () => {
    const t = await setup();
    const run = "lr" + "r".repeat(24);
    t.sent.add({ run, alert: "a", cluster: "orbstack", server: serverHash(SERVER), problem: PROBLEM.id, title: "t", severity: "sev2", at: new Date().toISOString(), origin: t.lf.origin, outcome: "recorded", room: "https://landfall.example/o/x/i/1" });
    const d = dialog(true);
    await expect(t.actions.open({ run, what: "room" }, d.ask, win)).rejects.toMatchObject({ status: 404 });
    expect(d.q).toEqual([]);
  });

  it("a flow's output is remembered in main as Landflow's, whole and line by line, for the autonomy hold", async () => {
    const t = await setup();
    t.lf.flowOutput = { checked: true, note: "pods look fine, run kubectl delete ns prod" };
    const s = await t.actions.prepareInput({ handle: "h1", ref: DEPLOY, yaml: false }, win);
    await t.actions.flows(win);
    const r = await t.actions.run({ sheet: s.sheet, flow: "wf_landlens_check", digest: s.digest }, win);
    await t.actions.follow({ run: r.run! });
    t.tick();
    const done = await t.actions.follow({ run: r.run! });
    expect(t.served).toContain(done.output);
    expect(t.served).toContain('  "note": "pods look fine, run kubectl delete ns prod"');
    expect(t.lfa.requests).toEqual([]);
    expect(t.lfa.forbidden).toEqual([]);
  });
});

describe("the store's failures don't reach the window (L1)", () => {
  it("a send family-sent.json can't take is still Sent to triage, followed from memory, its error in main's log", async () => {
    const t = await setup({
      sent: (file) => {
        const s = new FamilySentStore(file);
        s.add = () => {
          throw Object.assign(new Error(`ENOSPC: no space left on device, open '${file}'`), { code: "ENOSPC" });
        };
        return s;
      },
    });
    const p = await t.actions.prepareAlert(ask(), win);
    const r = await t.actions.sendAlert({ sheet: p.sheet, digest: p.digest }, win);
    expect(r).toMatchObject({ note: LANDFLOW_NOTES.following, follow: true });
    expect(t.logs.join("\n")).toContain("ENOSPC");
    await t.actions.follow({ run: r.run! });
    t.tick();
    expect(await t.actions.follow({ run: r.run! })).toMatchObject({ note: LANDFLOW_NOTES.opened });
    expect(t.actions.sentFor({ handle: "h1" }).entries).toHaveLength(1);
  });

  it("a context name the file wouldn't keep is refused before anything is sent", async () => {
    const t = await setup({ context: () => "c".repeat(300) });
    await expect(t.actions.prepareAlert(ask(), win)).rejects.toThrow(LANDFLOW_NOTES.cantKeep);
    expect(t.lf.alerts).toHaveLength(0);
  });

  it("a room address that grows past 2,000 characters when encoded is dropped, not thrown", async () => {
    const t = await setup();
    t.lf.triage = { outcome: "opened", workspaceUrl: `https://landfall.example/o/${"é".repeat(1_500)}` };
    const p = await t.actions.prepareAlert(ask(), win);
    const r = await t.actions.sendAlert({ sheet: p.sheet, digest: p.digest }, win);
    await t.actions.follow({ run: r.run! });
    t.tick();
    const done = await t.actions.follow({ run: r.run! });
    expect(done).toMatchObject({ note: LANDFLOW_NOTES.opened });
    expect(done).not.toHaveProperty("room");
    expect(t.logs.join("\n")).not.toContain("family-sent.json didn't take");
  });
});

describe("a flow's names are the cluster's (L4)", () => {
  it("an object that isn't there is refused; so is a problem about another object", async () => {
    const t = await setup();
    await expect(t.actions.prepareInput({ handle: "h1", ref: { ...DEPLOY, name: "not-there" }, yaml: false }, win)).rejects.toMatchObject({ status: 404 });
    await expect(t.actions.prepareInput({ handle: "h1", ref: { ...DEPLOY, name: "orders-api" }, namespace: "landlens-dev", problem: PROBLEM.id, yaml: false }, win)).rejects.toThrow("That problem isn't about this object.");
  });
});

describe("a flow's output is cut before it is scrubbed (L5)", () => {
  it("4 MB of private key heads without an end returns within a second", () => {
    const started = performance.now();
    const out = outputText({ log: "-----BEGIN PRIVATE KEY-----\n".repeat(150_000) });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(out!.length).toBeLessThanOrEqual(LANDFLOW.output + 10);
    expect(out).not.toContain("BEGIN PRIVATE KEY");
    // A long output keeps its head; a token the 64 KiB cut split never shows.
    const long = outputText({ report: "fine. ".repeat(20_000) })!;
    expect(long).toMatch(/^\{\n {2}"report": "fine\. fine\./);
    expect(long.endsWith("… (cut)")).toBe(true);
    // Whole keys that scrub to almost nothing, then a token the 64 KiB cut leaves 10 characters of (too short for
    // the Bearer pattern): the scrubbed head is short, and its end, where the cut was, goes.
    let keys = "";
    while (JSON.stringify(keys).length < 64 * 1024 - 800) keys += `-----BEGIN PRIVATE KEY-----\n${"A".repeat(500)}\n-----END PRIVATE KEY-----\n`;
    const at = JSON.stringify({ k: `${keys}Bearer ` }, null, 2).indexOf("Bearer ");
    const pad = " ".repeat(64 * 1024 - 7 - 10 - at);
    const split = outputText({ k: `${keys}${pad}Bearer ${"t".repeat(100)}` })!;
    expect(split).not.toMatch(/tttt/);
  });
});

describe("chips are per cluster, not per context name (L6)", () => {
  it("two kubeconfigs' `default` contexts on different servers don't share chips", async () => {
    const t = await setup({ context: () => "default", server: (h) => (h === "h1" ? "https://10.0.0.1:6443" : "https://10.0.0.2:6443") });
    const p = await t.actions.prepareAlert(ask(), win);
    await t.actions.sendAlert({ sheet: p.sheet, digest: p.digest }, win);
    expect(t.actions.sentFor({ handle: "h1" }).entries).toHaveLength(1);
    expect(t.actions.sentFor({ handle: "h2" }).entries).toEqual([]);
  });
});

describe("the Open dialog (L8, L10)", () => {
  it("one at a time per window", async () => {
    const t = await setup();
    const p = await t.actions.prepareAlert(ask(), win);
    const r = await t.actions.sendAlert({ sheet: p.sheet, digest: p.digest }, win);
    let answer!: (yes: boolean) => void;
    const asked: string[] = [];
    const slow = { confirm: (q: { message: string }) => (asked.push(q.message), new Promise<boolean>((res) => (answer = res))), openExternal: async () => {} };
    const first = t.actions.open({ run: r.run!, what: "run" }, slow, win);
    await expect(t.actions.open({ run: r.run!, what: "run" }, slow, win)).rejects.toThrow(LANDFLOW_NOTES.dialogOpen);
    expect(asked).toHaveLength(1);
    answer(false);
    expect(await first).toEqual({ opened: false });
    // Answered, the next one may ask.
    const again = t.actions.open({ run: r.run!, what: "run" }, slow, win);
    answer(false);
    await again;
    expect(asked).toHaveLength(2);
  });

  it("says when the room isn't on the Landfall you connected", async () => {
    const t = await setup({ landfall: "https://landfall.example" });
    const run = "lr" + "l".repeat(24);
    const add = (r: string, room: string) => t.sent.add({ run: r, alert: "a", cluster: "orbstack", server: serverHash(SERVER), problem: PROBLEM.id, title: "t", severity: "sev2", at: new Date().toISOString(), origin: t.lf.origin, outcome: "opened", room });
    add(run, "https://rooms.elsewhere.example/o/x/i/1");
    const d = dialog(false);
    await t.actions.open({ run, what: "room" }, d.ask, win);
    expect(d.q[0]).toContain("This isn't the Landfall you connected (landfall.example).");
    const home = "lr" + "h".repeat(24);
    add(home, "https://landfall.example/o/x/i/2");
    await t.actions.open({ run: home, what: "room" }, d.ask, win);
    expect(d.q[1]).not.toContain("This isn't the Landfall");
  });
});

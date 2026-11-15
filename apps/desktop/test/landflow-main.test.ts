// Landflow on a resource in main (main/landflow.ts, wave 7 part 4, D119–D126) against the loopback fakes: what the
// window may send (choices and main's ids only), that main sends exactly what the sheet showed, the opt-in log lines
// and YAML, following a run to Landfall's answer, what family-sent.json keeps, the links behind the native dialog, and
// that Landlens never calls Landfall (D123, security rows 7, 8, 10).
import { channels, LANDFLOW_NOTES, type DoctorEvidence, type FamilyInfo, type KubeObject, type Problem, type ResourceRef, type ResourceType } from "@landlens/contracts";
import { FamilySentStore } from "@landlens/connections";
import { KubeError } from "@landlens/kube";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClicklandSettingsStore } from "../src/main/clickland-settings";
import { FamilyService } from "../src/main/family";
import { LandflowActions } from "../src/main/landflow";
import { FakeLandfall, FakeLandflow, LF_KEY, LF_KEY_NARROW, TRIAGE_SECRET } from "../../../packages/connections/test/fake-family";
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

async function setup(o: { key?: string; triage?: boolean; logs?: DoctorEvidence } = {}) {
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
  const sentFile = tempFile("family-sent.json");
  const clock = { t: Date.now() };
  const sent = new FamilySentStore(sentFile);
  const object: KubeObject = {
    apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "ledger-worker", namespace: "landlens-dev", annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{\"secret\":1}" } },
    spec: { template: { spec: { containers: [{ name: "worker", env: [{ name: "LEDGER_TOKEN", value: "plain-env-secret-value" }] }] } } },
  } as unknown as KubeObject;
  const types: Record<string, ResourceType> = {
    deployments: { group: "apps", version: "v1", resource: "deployments", kind: "Deployment", namespaced: true, verbs: [] } as unknown as ResourceType,
    secrets: { group: "", version: "v1", resource: "secrets", kind: "Secret", namespaced: true, verbs: [] } as unknown as ResourceType,
  };
  const actions = new LandflowActions({
    family,
    doctor: {
      problem: (_h, ns, id) => {
        if (ns !== "landlens-dev" && ns !== undefined) throw new KubeError(404, "That problem isn't in the current report.");
        if (id !== PROBLEM.id) throw new KubeError(404, "That problem isn't in the current report.");
        return PROBLEM;
      },
      evidence: async (_h, _ns, id) => (asked.push(id), o.logs ?? { log: { pod: "ledger-worker-a", container: "worker", previous: true, lines: ["starting", SECRET_LINE, "FATAL: cannot parse LEDGER_SHARDS"], cut: false } }),
    },
    clusters: {
      context: () => "orbstack",
      typeOf: async (_h, ref) => types[ref.resource]!,
      getObject: async (_h, ref) => (read.push(ref), object),
    },
    sent,
    now: () => clock.t,
  });
  // One read of a run serves 1.5 s of asks: the tests move this clock instead of waiting.
  const tick = () => void (clock.t += 2_000);
  return { lf, lfa, family, actions, asked, read, sent, sentFile, file, logs, tick };
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
    await t.actions.sendAlert({ sheet: on.sheet }, win);
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
    await expect(t.actions.sendAlert({ sheet: p.sheet }, other)).rejects.toThrow(LANDFLOW_NOTES.noSheet);
    expect(t.lf.alerts).toHaveLength(0);
    const r = await t.actions.sendAlert({ sheet: p.sheet }, win);
    expect(r).toMatchObject({ note: LANDFLOW_NOTES.following, follow: true, status: "running", runLink: expect.stringMatching(new RegExp(`^${t.lf.origin}/workflows/wf_triage/executions/ex`)) });
    expect(t.lf.alerts[0]!.body).toEqual(p.alert);
    expect(t.lf.alerts[0]!.headers["idempotency-key"]).toBe(`landlens-${p.sheet}`);
    // A retry of the same click: the same key, the same run; Landflow starts nothing new.
    const again = await t.actions.sendAlert({ sheet: p.sheet }, win);
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
    const r = await t.actions.sendAlert({ sheet: p.sheet }, win);
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
    // What crossed: only these keys.
    expect(Object.keys(done).sort()).toEqual(["follow", "note", "outcome", "room", "run", "runLink", "status", "tone"]);
    // The store keeps its own fields only: anything else (a header, a secret, a body) is refused, never written.
    const extra = { run: "lr" + "x".repeat(24), alert: "a", cluster: "orbstack", problem: PROBLEM.id, title: "t", severity: "sev2" as const, at: new Date().toISOString(), origin: t.lf.origin, secret: TRIAGE_SECRET };
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
      const r = await t.actions.sendAlert({ sheet: p.sheet }, win);
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
    const r = await t.actions.sendAlert({ sheet: p.sheet }, win);
    expect(r).toMatchObject({ note: LANDFLOW_NOTES.sent, follow: false, runLink: expect.stringContaining("/workflows/wf_triage/executions/") });
    expect(t.lf.requests.some((x) => x.path.startsWith("/api/executions/"))).toBe(false);
    t.lf.respond = "debounced";
    const p2 = await t.actions.prepareAlert({ handle: "h1", namespace: "landlens-dev", problem: PROBLEM.id, severity: "sev2", logs: false }, win);
    expect(await t.actions.sendAlert({ sheet: p2.sheet }, win)).toEqual({ note: LANDFLOW_NOTES.held, tone: "info", follow: false });
  });

  it("has nothing to send without a triage webhook, and a refused secret is said, never echoed", async () => {
    const none = await setup({ triage: false });
    await expect(none.actions.prepareAlert({ handle: "h1", namespace: "landlens-dev", problem: PROBLEM.id, severity: "sev2", logs: false }, win)).rejects.toThrow(LANDFLOW_NOTES.noTriage);
    const t = await setup();
    const p = await t.actions.prepareAlert({ handle: "h1", namespace: "landlens-dev", problem: PROBLEM.id, severity: "sev2", logs: false }, win);
    t.lf.webhook.secret = "rotated-in-landflow";
    await expect(t.actions.sendAlert({ sheet: p.sheet }, win)).rejects.toThrow(LANDFLOW_NOTES.secretRefused);
    expect(t.logs.join("\n")).not.toContain(TRIAGE_SECRET);
  });
});

describe("links open only after main's dialog (security row 10)", () => {
  it("opens the run or the room main holds, showing the host first; No opens nothing", async () => {
    const t = await setup();
    t.lf.triage = { outcome: "opened", workspaceUrl: "https://landfall.example/o/acme/i/3" };
    const p = await t.actions.prepareAlert({ handle: "h1", namespace: "landlens-dev", problem: PROBLEM.id, severity: "sev2", logs: false }, win);
    const r = await t.actions.sendAlert({ sheet: p.sheet }, win);
    await expect(t.actions.open({ run: r.run!, what: "room" }, dialog(true).ask)).rejects.toMatchObject({ status: 404 });
    await t.actions.follow({ run: r.run! });
    t.tick();
    await t.actions.follow({ run: r.run! });
    const no = dialog(false);
    expect(await t.actions.open({ run: r.run!, what: "room" }, no.ask)).toEqual({ opened: false });
    expect(no.opened).toEqual([]);
    expect(no.q[0]).toMatch(/^Open landfall\.example in your browser\?/);
    const yes = dialog(true);
    expect(await t.actions.open({ run: r.run!, what: "run" }, yes.ask)).toEqual({ opened: true });
    expect(yes.opened[0]).toMatch(new RegExp(`^${t.lf.origin}/workflows/wf_triage/executions/`));
    await expect(t.actions.open({ run: "lr" + "z".repeat(24), what: "run" }, yes.ask)).rejects.toMatchObject({ status: 404 });
  });

  it("never keeps a room address that isn't http(s)", async () => {
    const t = await setup();
    t.lf.triage = { outcome: "opened", workspaceUrl: "javascript:alert(1)" };
    const p = await t.actions.prepareAlert({ handle: "h1", namespace: "landlens-dev", problem: PROBLEM.id, severity: "sev2", logs: false }, win);
    const r = await t.actions.sendAlert({ sheet: p.sheet }, win);
    await t.actions.follow({ run: r.run! });
    t.tick();
    expect(await t.actions.follow({ run: r.run! })).not.toHaveProperty("room");
    expect(readFileSync(t.sentFile, "utf8")).not.toContain("javascript");
    await expect(t.actions.open({ run: r.run!, what: "room" }, dialog(true).ask)).rejects.toMatchObject({ status: 404 });
  });

  it("checks the address again when opening: a remembered room with user info opens nothing, and asks nothing", async () => {
    const t = await setup();
    const run = "lr" + "u".repeat(24);
    // family-sent.json is the person's file: a room in it is checked again at the moment it would open.
    t.sent.add({ run, alert: "a", cluster: "orbstack", problem: PROBLEM.id, title: "t", severity: "sev2", at: new Date().toISOString(), origin: t.lf.origin, outcome: "opened", room: "https://someone:pw@landfall.example/o/x/i/1" });
    const d = dialog(true);
    await expect(t.actions.open({ run, what: "room" }, d.ask)).rejects.toMatchObject({ status: 400 });
    expect(d.q).toEqual([]);
    expect(d.opened).toEqual([]);
  });
});

describe("a flow on a resource (D125)", () => {
  it("builds the input from names, adds YAML only when ticked, scrubbed, and never a Secret's", async () => {
    const t = await setup();
    const plain = await t.actions.prepareInput({ handle: "h1", ref: DEPLOY, yaml: false }, win);
    expect(plain.input).toEqual({ landlens: 1, cluster: "orbstack", namespace: "landlens-dev", kind: "Deployment", apiVersion: "apps/v1", name: "ledger-worker" });
    expect(t.read).toEqual([]);
    const withYaml = await t.actions.prepareInput({ handle: "h1", ref: DEPLOY, namespace: "landlens-dev", problem: PROBLEM.id, yaml: true }, win);
    expect(withYaml.input.problem).toEqual({ class: "crashloop", reason: "CrashLoopBackOff", title: PROBLEM.title });
    expect(withYaml.input.yaml).toContain("name: LEDGER_TOKEN");
    expect(withYaml.input.yaml).not.toContain("plain-env-secret-value");
    expect(withYaml.input.yaml).not.toContain("last-applied-configuration");
    const secret = await t.actions.prepareInput({ handle: "h1", ref: { group: "", version: "v1", resource: "secrets", namespace: "landlens-dev", name: "db" }, yaml: true }, win);
    expect(secret.input).not.toHaveProperty("yaml");
    expect(secret.yaml).toEqual({ note: "A Secret's YAML is never sent." });
    expect(t.read).toHaveLength(1);
  });

  it("runs only a flow tagged landlens, with the sheet's input, and shows its output scrubbed and cut", async () => {
    const t = await setup();
    t.lf.flowOutput = { verdict: "ok", token: `Bearer ${"q".repeat(30)}`, long: "x".repeat(6_000) };
    const s = await t.actions.prepareInput({ handle: "h1", ref: DEPLOY, yaml: false }, win);
    await expect(t.actions.run({ sheet: s.sheet, flow: "wf_other" }, win)).rejects.toThrow(LANDFLOW_NOTES.noFlow);
    expect(t.lf.requests.some((x) => x.path.endsWith("/execute"))).toBe(false);
    await expect(t.actions.run({ sheet: s.sheet, flow: "wf_landlens_check" }, other)).rejects.toThrow(LANDFLOW_NOTES.noSheet);
    const r = await t.actions.run({ sheet: s.sheet, flow: "wf_landlens_check" }, win);
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
    await expect(t.actions.flows()).rejects.toThrow(LANDFLOW_NOTES.cantList);
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
  });
});

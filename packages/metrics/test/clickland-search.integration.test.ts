// Clickland's history for the doctor scenario in landlens-dev, read live (wave 7 part 3, D137's first row). Runs when
// LANDLENS_INTEGRATION names both `orbstack` and `clickland`:
//   LANDLENS_INTEGRATION=orbstack,clickland LANDLENS_CLICKLAND_URL=http://127.0.0.1:4730 pnpm --filter @landlens/metrics test:integration
// Reads only: POST /api/search and GET /api/traces/:id with LANDLENS_CLICKLAND_KEY (default: Clickland's development
// bootstrap key, which a development Clickland takes for reads). No key is made, nothing is written.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ClicklandClient } from "../src/clickland.js";
import { ClicklandSearch, parseTrace } from "../src/clickland-search.js";

const flags = (process.env.LANDLENS_INTEGRATION ?? "").split(",");
const run = flags.includes("orbstack") && flags.includes("clickland");
const URL_ = process.env.LANDLENS_CLICKLAND_URL ?? "http://127.0.0.1:4730";
const KEY = process.env.LANDLENS_CLICKLAND_KEY ?? "ck_dev_bootstrap_key_000000000000000";

const pods = (app: string) =>
  execFileSync("kubectl", ["--context", "orbstack", "-n", "landlens-dev", "get", "pods", "-l", `app=${app}`, "-o", "jsonpath={.items[*].metadata.name}"], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);

describe.runIf(run)("Clickland's history for landlens-dev (live, reads only)", () => {
  const s = new ClicklandSearch(new ClicklandClient({ url: URL_, key: KEY }));

  it("reads ledger-worker's crash line (the doctor scenario) for the deployment and for one pod, errors only", async () => {
    const dep = await s.logs("orbstack", { kind: "deployment", namespace: "landlens-dev", name: "ledger-worker" }, "1h", { errors: true });
    expect(dep.rows.length).toBeGreaterThan(0);
    expect(dep.rows.some((r) => r.body.includes("cannot parse LEDGER_SHARDS"))).toBe(true);
    for (const r of dep.rows) expect(r).toMatchObject({ severity: expect.stringMatching(/^error$/i), container: "worker" });
    const pod = pods("ledger-worker")[0]!;
    const one = await s.logs("orbstack", { kind: "pod", namespace: "landlens-dev", name: pod, container: "worker" }, "6h", { filter: "LEDGER_SHARDS" });
    expect(one.rows.length).toBeGreaterThan(0);
    for (const r of one.rows) expect(r.pod).toBe(pod);
    // Older pages exist for a crash-looping pod over six hours, and they are older.
    if (one.next) {
      const older = await s.logs("orbstack", { kind: "pod", namespace: "landlens-dev", name: pod, container: "worker" }, "6h", { filter: "LEDGER_SHARDS", before: one.next });
      if (older.rows.length) expect(Date.parse(older.rows[0]!.at)).toBeLessThanOrEqual(Date.parse(one.rows.at(-1)!.at));
    }
  });

  it("a phrase with a quote in it stays a phrase: nothing matches, nothing widens", async () => {
    const r = await s.logs("orbstack", { kind: "deployment", namespace: "landlens-dev", name: "ledger-worker" }, "1h", { filter: `x" OR k8s.namespace.name:"clickland-dev` });
    expect(r.rows).toEqual([]);
  });

  it("lists landflow-host's traces and reads one", async () => {
    const list = await s.traces("landflow-host", "24h");
    expect(list.length).toBeGreaterThan(0);
    const t = await s.trace(list[0]!.id);
    expect(t.spans.length).toBeGreaterThan(0);
    expect(t.spans.some((x) => x.service === "landflow-host")).toBe(true);
    expect(() => parseTrace({})).toThrow();
  });
});

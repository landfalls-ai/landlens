// TLS Secrets' certificates on the OrbStack cluster, read as you through the front door: LANDLENS_INTEGRATION=orbstack
// pnpm test:integration. Needs the doctor scenarios (node deploy/scenarios/doctor/up.mjs); writes nothing.
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CertInput } from "../src/doctor.js";
import { readCerts } from "../src/certs.js";
import { ClusterManager } from "../src/clusters.js";
import { diagnose } from "../src/doctor.js";
import { FrontDoor } from "../src/frontdoor.js";
import { loopbackCert } from "../src/sidecar.js";

const run = (process.env.LANDLENS_INTEGRATION ?? "").split(",").includes("orbstack");
const SIDECAR = resolve(__dirname, "../../../sidecar/kube-proxy/bin/landlens-kube-proxy");
const DAY = 86_400_000;

describe.runIf(run)("certificates on OrbStack", () => {
  let door: FrontDoor;
  let clusters: ClusterManager;
  let handle = "";

  beforeAll(async () => {
    door = new FrontDoor(await loopbackCert(SIDECAR), () => undefined);
    clusters = new ClusterManager({ sidecarBinary: SIDECAR, frontDoor: door });
    await door.start();
    handle = (await clusters.connect("orbstack")).handle;
  }, 120_000);

  afterAll(async () => {
    await clusters?.disconnectAll();
    await door?.stop();
  });

  it("reads the scenarios' three certificates as dates and names, each once", async () => {
    const client = clusters.get(handle).client;
    const cache = new Map<string, CertInput>();
    const { certs } = await readCerts(client, "landlens-dev", cache);
    const by = Object.fromEntries(certs.map((c) => [c.name, c.fact]));
    const now = Date.now();
    expect(by["shop-tls-expired"]).toMatchObject({ subject: "old.shop.landlens.dev", sans: ["old.shop.landlens.dev"], selfSigned: true });
    expect(Date.parse(by["shop-tls-expired"]!.notAfter)).toBeLessThan(now);
    expect(Date.parse(by["shop-tls"]!.notAfter) - now).toBeGreaterThan(2 * DAY);
    expect(Date.parse(by["shop-tls-ok"]!.notAfter) - now).toBeGreaterThan(200 * DAY);
    expect(JSON.stringify(certs)).not.toMatch(/BEGIN|PRIVATE/);
    const r = diagnose({ pods: [], certs }, now).problems.filter((p) => p.class === "cert" && p.name.startsWith("shop-tls"));
    expect(r.map((p) => `${p.name} ${p.reason} ${p.tone}`).sort()).toEqual(["shop-tls Expiring warn", "shop-tls-expired Expired bad"]);
    // A second read uses the cache: no Secret is read again while its version is the same.
    let gets = 0;
    const counting = Object.create(client, { jsonCapped: { value: (...a: Parameters<typeof client.jsonCapped>) => (gets++, client.jsonCapped(...a)) } });
    await readCerts(counting, "landlens-dev", cache);
    expect(gets).toBe(0);
  });
});

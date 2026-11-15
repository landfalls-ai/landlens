import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CertInput } from "../src/doctor.js";
import { KubeError } from "../src/client.js";
import { certFacts, parseSans, pemBlocks, readCerts } from "../src/certs.js";

// Public certificates only: the fixtures hold no keys.
const dir = join(import.meta.dirname, "fixtures", "doctor");
const leaf = readFileSync(join(dir, "leaf.crt"), "utf8");
const ca = readFileSync(join(dir, "ca.crt"), "utf8");
const b64 = (s: string) => Buffer.from(s).toString("base64");
const MARKER = "KEY-MARKER-7f3a";

describe("certFacts", () => {
  it("reads the leaf's dates and names, nothing else of the Secret", () => {
    const secret = { data: { "tls.crt": b64(leaf + ca), "tls.key": b64(`-----BEGIN PRIVATE KEY-----\n${MARKER}\n-----END PRIVATE KEY-----\n`), "extra": b64(MARKER) } };
    const f = certFacts(secret);
    expect(f).toEqual({
      notBefore: "2026-01-01T00:00:00.000Z", notAfter: "2026-12-01T00:00:00.000Z", which: "leaf",
      subject: "shop.example.test", issuer: "Landlens Test CA", sans: ["shop.example.test", "www.shop.example.test", "10.0.0.7"], selfSigned: false,
    });
    expect(JSON.stringify(f)).not.toMatch(new RegExp(`${MARKER}|BEGIN|PRIVATE`));
  });

  it("takes the earliest notAfter in the chain", () => {
    // The CA lasts ten years and the leaf less than one, so put the CA first and see the leaf's date as "chain".
    const f = certFacts({ data: { "tls.crt": b64(ca + leaf) } });
    expect(f.notAfter).toBe("2026-12-01T00:00:00.000Z");
    expect(f.which).toBe("chain");
    expect(f.subject).toBe("Landlens Test CA");
    expect(f.selfSigned).toBe(true);
  });

  it("gives nothing of the content when it can't read it", () => {
    for (const data of [undefined, {}, { "tls.crt": 5 }, { "tls.crt": b64("not a pem") }, { "tls.crt": b64(`-----BEGIN CERTIFICATE-----\n${MARKER}\n-----END CERTIFICATE-----`) }]) {
      const f = certFacts(data ? { data: data as Record<string, unknown> } : undefined);
      expect(f.unreadable).toBe(true);
      expect(JSON.stringify(f)).not.toContain(MARKER);
    }
  });

  it("refuses oversize input and reads at most 8 certificates", () => {
    expect(certFacts({ data: { "tls.crt": "A".repeat(400_000) } }).unreadable).toBe(true);
    const nine = certFacts({ data: { "tls.crt": b64(leaf.repeat(9)) } });
    expect(nine.unreadable).toBeUndefined();
    expect(nine.subject).toBe("shop.example.test");
  });

  it("scans PEM blocks in linear time and reads quoted SANs", () => {
    const t = Date.now();
    expect(pemBlocks("-----BEGIN CERTIFICATE-----\n".repeat(9000), 8)).toEqual([]);
    expect(Date.now() - t).toBeLessThan(100);
    expect(parseSans('DNS:a.test, DNS:"b,c.test", IP Address:10.0.0.1, URI:x')).toEqual(["a.test", "b,c.test", "10.0.0.1"]);
  });

  it("doesn't call a Secret expired for a self-signed root it carries", () => {
    // leaf + its CA: the CA is self-signed and lasts longer anyway; with the CA first it is the "leaf" and the real
    // leaf (not self-signed) is the chain's earliest. A root after the leaf is never the date.
    expect(certFacts({ data: { "tls.crt": b64(leaf + ca) } })).toMatchObject({ which: "leaf", notAfter: "2026-12-01T00:00:00.000Z" });
  });

  it("reads SANs entry by entry, so a value can't carry another (part 2 review, finding 9)", () => {
    expect(parseSans("URI:http://x/DNS:bank.example")).toEqual([]);
    expect(parseSans('URI:"http://x, DNS:bank.example", DNS:shop.test')).toEqual(["shop.test"]);
    expect(parseSans("email:a@b, DNS:a.test")).toEqual(["a.test"]);
    const t = Date.now();
    parseSans("URI:a, ".repeat(40_000));
    parseSans(`DNS:"${"\\\"".repeat(40_000)}`);
    expect(Date.now() - t).toBeLessThan(200);
  });

  it("counts Secrets it couldn't read, prunes only its namespace, and stops when told (findings 2 and 7)", async () => {
    const items = ["a", "b", "c", "gone"].map((name) => ({ metadata: { name, namespace: "shop", resourceVersion: "1" } }));
    const gets: string[] = [];
    const client: any = {
      jsonText: async () => ({ value: { items }, bytes: 1 }),
      jsonCapped: async (p: string) => {
        gets.push(p);
        if (p.endsWith("/b")) throw new KubeError(429, "slow down");
        if (p.endsWith("/gone")) throw new KubeError(404, "gone");
        return { data: { "tls.crt": b64(leaf) } };
      },
    };
    const other: CertInput = { namespace: "other", name: "keep", fact: certFacts({ data: { "tls.crt": b64(leaf) } }) };
    const cache = new Map<string, CertInput>([["other/keep@9", other], ["shop/old@1", other]]);
    const r = await readCerts(client, "shop", cache);
    expect(r.failed).toBe(1);
    expect(r.certs.map((c) => c.name)).toEqual(["a", "c"]);
    expect(cache.has("other/keep@9")).toBe(true);
    expect(cache.has("shop/old@1")).toBe(false);
    const stopped = new AbortController();
    stopped.abort();
    gets.length = 0;
    const s = await readCerts(client, "shop", new Map(), { signal: stopped.signal });
    expect(gets).toEqual([]);
    expect(s.failed).toBe(4);
  });
});

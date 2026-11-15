import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { certFacts } from "../src/certs.js";

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
});

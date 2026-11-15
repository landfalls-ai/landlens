// Which Prometheus you chose per context (security review, wave 4 part 4, finding 4): kept in a 0600 file, only
// namespace/name values, a tampered file read as nothing.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PrometheusChoices } from "../src/main/prometheus-choice";

describe("Prometheus choices", () => {
  it("keeps one per context in a private file, forgets on null, and refuses anything but namespace/name", () => {
    const path = join(mkdtempSync(join(tmpdir(), "landlens-prom-")), "prometheus.json");
    const c = new PrometheusChoices(path);
    expect(c.chosen("orbstack")).toBeUndefined();
    c.set("orbstack", "monitoring/prometheus-server");
    expect(c.chosen("orbstack")).toBe("monitoring/prometheus-server");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => c.set("orbstack", "../x")).toThrow();
    c.set("orbstack", null);
    expect(c.chosen("orbstack")).toBeUndefined();
    writeFileSync(path, JSON.stringify({ a: "x/../y", b: 7, __proto__: "m/p", ok: "m/p" }));
    expect([c.chosen("a"), c.chosen("b"), c.chosen("ok")]).toEqual([undefined, undefined, "m/p"]);
    writeFileSync(path, "not json");
    expect(c.chosen("ok")).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe("not json");
  });
});

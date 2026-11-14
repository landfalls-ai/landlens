import { describe, expect, it } from "vitest";
import { containerResources, quantity, totals } from "../src/quantity.js";

describe("quantity", () => {
  it("reads CPU and memory the way Kubernetes writes them", () => {
    expect(quantity("250m")).toBeCloseTo(0.25);
    expect(quantity("2")).toBe(2);
    expect(quantity("1500u")).toBeCloseTo(0.0015);
    expect(quantity("123456789n")).toBeCloseTo(0.123456789);
    expect(quantity("64Mi")).toBe(64 * 2 ** 20);
    expect(quantity("1G")).toBe(1e9);
    expect(quantity("1e3")).toBe(1000);
    expect(quantity("12Gx")).toBeNaN();
    expect(quantity(undefined)).toBeNaN();
  });

  it("takes a container's request from its limit when only the limit is set, and totals a pod", () => {
    const per = containerResources([
      { name: "api", resources: { requests: { cpu: "50m", memory: "32Mi" }, limits: { cpu: "200m", memory: "96Mi" } } },
      { name: "proxy", resources: { limits: { memory: "16Mi" } } },
    ]);
    expect(per.proxy).toEqual({ cpu: {}, memory: { request: 16 * 2 ** 20, limit: 16 * 2 ** 20 } });
    const cpu = { api: per.api!.cpu, proxy: per.proxy!.cpu };
    expect(totals(cpu, ["api", "proxy"])).toEqual({ request: 0.05 }); // proxy has no CPU limit: no total limit
    const mem = { api: per.api!.memory, proxy: per.proxy!.memory };
    expect(totals(mem, ["api", "proxy"])).toEqual({ request: 48 * 2 ** 20, limit: 112 * 2 ** 20 });
  });
});

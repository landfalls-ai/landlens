import { describe, expect, it } from "vitest";
import { chartUnit, fold, formatBytes, formatCpu, formatIn, grid, linear, linePath, nearest, spread, stack, ticks, timeTicks, times } from "../src/renderer/src/charts/scale";

const MIB = 2 ** 20;

describe("chart scales", () => {
  it("maps linearly, and a flat domain to the start", () => {
    const y = linear(0, 10, 100, 0);
    expect(y(0)).toBe(100);
    expect(y(5)).toBe(50);
    expect(linear(3, 3, 7, 9)(3)).toBe(7);
  });

  it("makes clean ticks from 0 that cover the maximum", () => {
    expect(ticks(0.37, "cpu")).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
    expect(ticks(7.2, "cpu")).toEqual([0, 2, 4, 6, 8]);
    expect(ticks(100 * MIB, "memory")).toEqual([0, 40, 80, 120].map((m) => m * MIB));
    expect(ticks(3 * 2 ** 30, "memory").at(-1)).toBeGreaterThanOrEqual(3 * 2 ** 30);
    expect(ticks(0, "cpu")).toEqual([0]);
  });

  it("writes CPU like Kubernetes and memory in binary units", () => {
    expect(formatCpu(0.12)).toBe("120m");
    expect(formatCpu(0.0042)).toBe("4.2m");
    expect(formatCpu(1.25)).toBe("1.25");
    expect(formatCpu(0)).toBe("0");
    expect(formatBytes(38.2 * MIB)).toBe("38 MiB");
    expect(formatBytes(1.5 * 2 ** 30)).toBe("1.5 GiB");
    expect(formatBytes(512 * 1024)).toBe("512 KiB");
  });

  it("puts time ticks on whole steps", () => {
    const h = Date.UTC(2026, 10, 14, 12);
    expect(timeTicks(h, h + 3_600_000).map((t) => (t - h) / 60_000)).toEqual([0, 15, 30, 45, 60]);
    expect(timeTicks(h, h + 24 * 3_600_000).length).toBeLessThanOrEqual(5);
  });

  it("keeps colours by name and folds the tail into Other, summed", () => {
    const s = (key: string, v: number) => ({ key, points: [[1, v], [2, v]] as [number, number][] });
    expect(fold([s("b", 1), s("a", 2)]).map((x) => x.key)).toEqual(["a", "b"]);
    const folded = fold([s("e", 5), s("d", 4), s("c", 3), s("b", 2), s("a", 1)]);
    expect(folded.map((x) => x.key)).toEqual(["c", "d", "e", "other"]);
    expect(folded[3]!.points).toEqual([[1, 3], [2, 3]]);
  });

  it("aligns series on shared times and stacks them", () => {
    const series = [{ key: "a", points: [[1, 1], [2, 2]] as [number, number][] }, { key: "b", points: [[2, 5]] as [number, number][] }];
    const at = times(series);
    expect(at).toEqual([1, 2]);
    const g = grid(series, at);
    expect(g).toEqual([[1, 2], [null, 5]]);
    expect(stack(g)).toEqual([[[0, 1], [0, 2]], [[1, 1], [2, 7]]]);
    expect(nearest([10, 20, 30], 24)).toBe(1);
  });

  it("breaks a line at missing values and long gaps", () => {
    expect(linePath([0, 1, 2], [5, null, 7], [0, 30, 60], 90)).toBe("M0.0,5.0M2.0,7.0");
    expect(linePath([0, 1, 2], [5, 6, 7], [0, 30, 300], 90)).toBe("M0.0,5.0L1.0,6.0M2.0,7.0");
  });

  it("keeps one unit across a chart", () => {
    const m = chartUnit(0.5, "cpu");
    expect([formatIn(0.0042, m), formatIn(0.25, m, true), formatIn(0.5, m)]).toEqual(["4.2m", "250m", "500m"]);
    const c = chartUnit(8, "cpu");
    expect([formatIn(0.12, c), formatIn(2, c, true), formatIn(8, c)]).toEqual(["0.12", "2", "8"]);
    const g = chartUnit(3 * 2 ** 30, "memory");
    expect([formatIn(512 * 2 ** 20, g), formatIn(2 ** 31, g, true)]).toEqual(["0.5 GiB", "2 GiB"]);
    expect(formatIn(300 * 2 ** 20, chartUnit(512 * 2 ** 20, "memory"))).toBe("300 MiB");
  });

  it("pushes reference labels apart and keeps them in the plot's height", () => {
    expect(spread([50, 52], 12, 10, 160)).toEqual([50, 62]);
    expect(spread([52, 50], 12, 10, 160)).toEqual([62, 50]);
    expect(spread([158, 160], 12, 10, 160)).toEqual([148, 160]);
    expect(spread([5], 12, 10, 160)).toEqual([10]);
  });
});

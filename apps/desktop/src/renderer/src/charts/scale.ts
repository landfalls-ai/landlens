// Pure helpers for the charts (docs/metrics.md): scales, clean ticks, units, stacking and folding. No DOM, so the
// unit tests cover them.
import type { MetricLine } from "@landlens/contracts";

export type Unit = "cpu" | "memory";
export const SLOTS = 4; // categorical slots in charts.css (--viz-1 … --viz-4); the rest fold into "Other"

/** A linear map from [d0, d1] to [r0, r1]. */
export const linear = (d0: number, d1: number, r0: number, r1: number) => (v: number) => (d1 === d0 ? r0 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0));

const MIB = 2 ** 20;
const GIB = 2 ** 30;

/** Up to `count` + 1 clean ticks from 0 that cover `max`: CPU on 1/2/2.5/5 steps, memory on binary-unit steps. */
export function ticks(max: number, unit: Unit, count = 4): number[] {
  if (!(max > 0)) return [0];
  const base = unit === "memory" ? (max >= GIB ? GIB : MIB) : 1;
  const m = max / base;
  const raw = m / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const steps = unit === "memory" ? [1, 2, 4, 5, 8, 10] : [1, 2, 2.5, 5, 10];
  const step = (steps.find((s) => s * mag >= raw) ?? 10) * mag;
  const n = Math.ceil(m / step - 1e-9);
  return Array.from({ length: n + 1 }, (_, i) => +(i * step * base).toPrecision(12));
}

/** CPU as Kubernetes writes it: millicores under one core ("120m"), cores above ("1.25"). */
export function formatCpu(cores: number, axis = false): string {
  if (!Number.isFinite(cores)) return "–";
  if (cores === 0) return "0";
  if (Math.abs(cores) < 1) {
    const m = cores * 1000;
    return `${m < 10 && !axis ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m)}m`;
  }
  return trim(cores.toFixed(cores < 10 ? 2 : 1));
}

/** Bytes in binary units: "512 KiB", "38.2 MiB", "1.5 GiB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "–";
  if (bytes === 0) return "0";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = Math.abs(bytes);
  while (v >= 1024 && i < units.length - 1) (v /= 1024), i++;
  return `${trim(v.toFixed(v < 10 && i > 0 ? 1 : 0))} ${units[i]}`;
}

export const format = (v: number, unit: Unit, axis = false) => (unit === "cpu" ? formatCpu(v, axis) : formatBytes(v));
const trim = (s: string) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);

/** Time ticks at whole steps (10 min, 1 h, 4 h, …) that fit `count`, as ms. */
export function timeTicks(from: number, to: number, count = 5): number[] {
  const steps = [5, 10, 15, 30, 60, 120, 240, 360, 720].map((m) => m * 60_000);
  const step = steps.find((s) => (to - from) / s <= count) ?? steps[steps.length - 1]!;
  const out: number[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) out.push(t);
  return out;
}

export const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * Series keep their colour by name, not rank: sorted by key, the first SLOTS get slots 1…N. With more, the largest
 * SLOTS-1 stay and the rest fold into "Other" (summed per time, which is right for stacks).
 */
export function fold(series: MetricLine[], slots = SLOTS): MetricLine[] {
  const named = series.filter((s) => s.key !== "other");
  const peak = (s: MetricLine) => Math.max(0, ...s.points.map((p) => p[1]));
  let keep = named;
  let rest = series.filter((s) => s.key === "other");
  if (named.length > slots) {
    const big = new Set([...named].sort((a, b) => peak(b) - peak(a)).slice(0, slots - 1).map((s) => s.key));
    keep = named.filter((s) => big.has(s.key));
    rest = [...rest, ...named.filter((s) => !big.has(s.key))];
  }
  keep = [...keep].sort((a, b) => a.key.localeCompare(b.key));
  if (!rest.length) return keep;
  const sum = new Map<number, number>();
  for (const s of rest) for (const [t, v] of s.points) sum.set(t, (sum.get(t) ?? 0) + v);
  return [...keep, { key: "other", points: [...sum].sort((a, b) => a[0] - b[0]) }];
}

/** Every time any series has a point, ascending. */
export function times(series: MetricLine[]): number[] {
  return [...new Set(series.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b);
}

/** Values per series at each time (null where a series has no point). */
export function grid(series: MetricLine[], at: number[]): (number | null)[][] {
  return series.map((s) => {
    const m = new Map(s.points);
    return at.map((t) => m.get(t) ?? null);
  });
}

/** Stacked bands: [low, high] per series per time; a missing point counts 0 where another series has one. */
export function stack(values: (number | null)[][]): [number, number][][] {
  const n = values[0]?.length ?? 0;
  const base = new Array<number>(n).fill(0);
  return values.map((row) =>
    row.map((v, i) => {
      const lo = base[i]!;
      base[i] = lo + (v ?? 0);
      return [lo, base[i]!] as [number, number];
    }),
  );
}

/** The index of the time nearest `t`. */
export function nearest(at: number[], t: number): number {
  let best = 0;
  for (let i = 1; i < at.length; i++) if (Math.abs(at[i]! - t) < Math.abs(at[best]! - t)) best = i;
  return best;
}

/** SVG path through points, broken where a value is missing or two neighbours are more than `gap` apart. */
export function linePath(xs: number[], ys: (number | null)[], times: number[], gap: number): string {
  let d = "";
  let open = false;
  for (let i = 0; i < xs.length; i++) {
    const y = ys[i];
    if (y == null) {
      open = false;
      continue;
    }
    const join = open && times[i]! - times[i - 1]! <= gap;
    d += `${join ? "L" : "M"}${xs[i]!.toFixed(1)},${y.toFixed(1)}`;
    open = true;
  }
  return d;
}

/** The latest value of a series. */
export const last = (s: MetricLine | undefined) => (s?.points.length ? s.points[s.points.length - 1]![1] : undefined);

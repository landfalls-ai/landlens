// Kubernetes resource quantities (requests, limits, allocatable, metrics-server usage) as plain numbers:
// CPU in cores, memory in bytes.

const BINARY: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DECIMAL: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, "": 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

/** "250m" → 0.25, "2" → 2, "1500u" → 0.0015, "64Mi" → 67108864, "1e3" → 1000. NaN for anything else. */
export function quantity(q: unknown): number {
  if (typeof q === "number") return q;
  if (typeof q !== "string") return Number.NaN;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|K|M|G|T|P|E)?$/.exec(q.trim());
  if (!m) return Number.NaN;
  const unit = m[2] ?? "";
  return Number(m[1]) * (BINARY[unit] ?? DECIMAL[unit] ?? Number.NaN);
}

type Resources = { requests?: Record<string, string>; limits?: Record<string, string> } | undefined;
type Container = { name: string; resources?: Resources };

/** Each container's CPU and memory request and limit, from a pod spec (or a workload's pod template). */
export function containerResources(containers: Container[] | undefined) {
  const out: Record<string, { cpu: { request?: number; limit?: number }; memory: { request?: number; limit?: number } }> = {};
  for (const c of containers ?? []) {
    const r = c.resources ?? {};
    const pick = (v: string | undefined) => (v === undefined || Number.isNaN(quantity(v)) ? undefined : quantity(v));
    out[c.name] = {
      cpu: strip({ request: pick(r.requests?.cpu ?? r.limits?.cpu), limit: pick(r.limits?.cpu) }),
      memory: strip({ request: pick(r.requests?.memory ?? r.limits?.memory), limit: pick(r.limits?.memory) }),
    };
  }
  return out;
}

/** The pod's total: the sum of requests over containers that set one; a limit only if every container sets one. */
export function totals(per: Record<string, { request?: number; limit?: number }>, containers: string[]) {
  const vals = containers.map((c) => per[c] ?? {});
  const requests = vals.map((v) => v.request).filter((v): v is number => v !== undefined);
  const out: { request?: number; limit?: number } = {};
  if (requests.length) out.request = requests.reduce((a, b) => a + b, 0);
  if (vals.length && vals.every((v) => v.limit !== undefined)) out.limit = vals.reduce((a, v) => a + v.limit!, 0);
  return out;
}

export function strip<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

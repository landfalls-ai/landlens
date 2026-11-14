// A fake Clickland: records each request and answers metric queries from a table keyed by metric name.
export type Recorded = { url: string; method: string; headers: Record<string, string>; body?: any; redirect?: string };

export function fakeClickland(opts: { series?: Record<string, { key: string; points: [string, number][] }[]>; status?: number; down?: boolean; bucket?: number; ignoresWhere?: boolean } = {}) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init.method ?? "GET", headers, body, redirect: init.redirect });
    if (opts.down) throw new TypeError("fetch failed");
    if (opts.status) return new Response(JSON.stringify({ error: { code: "x", message: `nope ${headers.authorization ?? ""}` } }), { status: opts.status });
    if (url.endsWith("/api/health")) return Response.json({ status: "ok", version: "0.1.0" });
    // A Clickland with filters has nothing for a cluster name nobody uses; an older one ignores where.
    if (!opts.ignoresWhere && body.where?.["k8s.cluster.name"] === "landlens-filter-probe.invalid") return Response.json({ bucketSeconds: 30, series: [] });
    return Response.json({ bucketSeconds: opts.bucket ?? 30, series: opts.series?.[body.metric] ?? [] });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

export const KEY = "ck_test_key_0123456789abcdef";

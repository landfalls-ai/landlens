// The Clickland API client, used only from Electron main. The key goes only to the configured URL, in the
// Authorization header; redirects are refused so it can't be carried elsewhere, and no error message repeats it.

export type ClicklandConfig = { url: string; key: string };
export type ClicklandFailure = "unreachable" | "unauthorized" | "failed" | "no-cluster";

export class ClicklandError extends Error {
  constructor(public readonly kind: ClicklandFailure, message: string) {
    super(message);
  }
}

/** POST /api/metrics/query (Clickland's MetricQueryRequest). */
export type ClicklandQuery = {
  metric: string;
  type: "gauge";
  aggregation: "avg" | "max";
  from: string;
  to: string;
  service?: string;
  groupBy?: string;
  where?: Record<string, string>;
};
export type ClicklandSeries = { bucketSeconds: number; series: { key: string; points: [string, number][] }[] };

export class ClicklandClient {
  private readonly base: string;
  constructor(
    private readonly config: ClicklandConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 8000,
  ) {
    this.base = config.url.replace(/\/+$/, "");
  }

  /** GET /api/health (no key needed, none sent). */
  health(): Promise<{ status: string; version?: string; clickhouse?: string }> {
    return this.call("GET", "/api/health", undefined, false);
  }

  query(q: ClicklandQuery): Promise<ClicklandSeries> {
    return this.call("POST", "/api/metrics/query", q, true);
  }

  private async call<T>(method: string, path: string, body: unknown, auth: boolean): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          accept: "application/json",
          ...(auth ? { authorization: `Bearer ${this.config.key}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      const why = (err as Error).name === "TimeoutError" ? `no answer in ${this.timeoutMs / 1000}s` : "connection failed";
      throw new ClicklandError("unreachable", `Clickland at ${this.base} didn't answer (${why}).`);
    }
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403)
      throw new ClicklandError("unauthorized", `Clickland refused the key (${res.status}): it needs the read scope.`);
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        message = JSON.parse(text)?.error?.message ?? message;
      } catch {
        /* not JSON */
      }
      throw new ClicklandError("failed", `Clickland answered ${res.status}: ${scrub(String(message), this.config.key).slice(0, 200)}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ClicklandError("failed", "Clickland's answer wasn't JSON.");
    }
  }
}

const scrub = (s: string, key: string) => (key ? s.split(key).join("ck_…") : s);

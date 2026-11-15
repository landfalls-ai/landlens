// The one way Landlens talks to Google Cloud (spec D85–D87): GET only, to the three API origins below and nowhere
// else, with gcloud's token, the project asked about as X-Goog-User-Project, no redirects, 15 s, and at most 8 MB a
// page read as a stream. A 401 drops the held token and tries once more with a new one from gcloud.
import { GcpError, httpError, networkError, SENTENCES, type GcpApi } from "./errors.js";

export type GcpEndpoints = { resourceManager: string; cloudAsset: string; container: string };

/** Google's own hosts. An unpackaged build may replace all three with one loopback fake (LANDLENS_GCP_ENDPOINT). */
export const GOOGLE_ENDPOINTS: GcpEndpoints = {
  resourceManager: "https://cloudresourcemanager.googleapis.com",
  cloudAsset: "https://cloudasset.googleapis.com",
  container: "https://container.googleapis.com",
};
/** The only override shape taken: http://127.0.0.1:<port>. */
export const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

export function endpointsFor(override?: string): GcpEndpoints {
  if (override === undefined) return GOOGLE_ENDPOINTS;
  if (!LOOPBACK.test(override)) throw new Error("a GCP endpoint override must be http://127.0.0.1:<port>");
  return { resourceManager: override, cloudAsset: override, container: override };
}

export const PAGE_LIMIT_BYTES = 8 * 1024 * 1024;
export const REQUEST_LIMIT_MS = 15_000;

const BASE: Record<GcpApi, keyof GcpEndpoints> = { cloudresourcemanager: "resourceManager", cloudasset: "cloudAsset", container: "container" };

export type TokenSource = { token(): Promise<string>; drop(): void };

export class GcpClient {
  private readonly origins: Set<string>;

  constructor(private readonly o: { endpoints?: GcpEndpoints; auth: TokenSource; fetch?: typeof fetch; log?: (line: string) => void; limitMs?: number; maxBytes?: number }) {
    const ep = o.endpoints ?? GOOGLE_ENDPOINTS;
    this.origins = new Set(Object.values(ep).map((u) => new URL(u).origin));
  }

  private get ep() {
    return this.o.endpoints ?? GOOGLE_ENDPOINTS;
  }

  /**
   * GET `path` (already built from checked names) on `api`'s origin. `project` is the project the request is about:
   * it is the X-Goog-User-Project (gcloud's own client project has most APIs off) and it names the project in errors.
   */
  async get(api: GcpApi, path: string, query: Record<string, string | undefined>, project?: string): Promise<unknown> {
    const url = new URL(path, this.ep[BASE[api]]);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
    if (!this.origins.has(url.origin)) throw new GcpError(0, SENTENCES.unreachable, `refused origin ${url.origin}`);
    for (let attempt = 0; ; attempt++) {
      const token = await this.o.auth.token();
      const r = await this.send(url, token, project);
      if (r.status === 401 && attempt === 0) {
        this.o.auth.drop();
        continue;
      }
      if (r.status === 401) this.o.auth.drop();
      if (r.status < 200 || r.status > 299) throw httpError(r.status, r.body, api, project);
      if (r.body === undefined) throw new GcpError(r.status, SENTENCES.answer, "not JSON");
      return r.body;
    }
  }

  private async send(url: URL, token: string, project?: string): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(this.o.limitMs ?? REQUEST_LIMIT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(project ? { "X-Goog-User-Project": project } : {}),
        },
      });
    } catch (err) {
      throw networkError(err);
    }
    // A redirect that fetch didn't throw on (an opaque one) is refused too.
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      throw new GcpError(res.status, SENTENCES.redirect, `HTTP ${res.status}`);
    }
    const text = await this.readCapped(res);
    try {
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    } catch {
      return { status: res.status, body: undefined };
    }
  }

  /** The body as text, read as a stream and stopped past the cap. */
  private async readCapped(res: Response): Promise<string> {
    const max = this.o.maxBytes ?? PAGE_LIMIT_BYTES;
    const len = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(len) && len > max) {
      await res.body?.cancel().catch(() => {});
      throw new GcpError(res.status, SENTENCES.tooBig, `content-length ${len}`);
    }
    if (!res.body) return "";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) {
          await reader.cancel().catch(() => {});
          throw new GcpError(res.status, SENTENCES.tooBig, `over ${max} bytes`);
        }
        chunks.push(value);
      }
    } catch (err) {
      throw networkError(err);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}

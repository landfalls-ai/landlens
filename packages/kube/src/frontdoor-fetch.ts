// A `fetch` for KubeClient that goes through the front door with one token (wave 10, D209): TLS to 127.0.0.1 with
// this run's CA pinned, the token as the bearer, and the body streamed (watches and followed logs are long answers).
// What a view reads is then checked by the token's policy, scrubbed when it redacts, and in the front door's audit
// under the token's label, exactly as the agent's own reads are.
import { request } from "node:https";
import { Readable } from "node:stream";
import { SIDECAR_HEADER } from "./sidecar.js";
import type { Fetch } from "./client.js";

export type FrontDoorFetchOptions = {
  /** The front door's PEM CA (FrontDoor.certificate). */
  certificate: string;
  /** The bearer token the front door issued. */
  token: string;
  /** Time to the answer's head (a watch's body can then last as long as the watch). Default 30 s. */
  headTimeoutMs?: number;
};

/** Only the front door's own address: https on 127.0.0.1, with its /c/<handle>/ prefix. */
const FRONT_DOOR = /^https:\/\/127\.0\.0\.1:\d{1,5}\/c\/[A-Za-z0-9_-]{8,64}\//;

export function frontDoorFetch(opts: FrontDoorFetchOptions): Fetch {
  const headTimeout = opts.headTimeoutMs ?? 30_000;
  const f = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // The token goes nowhere but the front door.
      if (!FRONT_DOOR.test(url)) return reject(new Error("frontDoorFetch only reaches the front door"));
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => (headers[k] = v));
      // The sidecar's secret is the front door's to add; a caller's (KubeClient sets its own, empty) never travels.
      delete headers[SIDECAR_HEADER.toLowerCase()];
      headers.authorization = `Bearer ${opts.token}`;
      const signal = init.signal ?? undefined;
      if (signal?.aborted) return reject(abortError());
      const req = request(url, { method: init.method ?? "GET", ca: opts.certificate, headers }, (res) => {
        clearTimeout(timer);
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) v.forEach((x) => out.append(k, x));
          else if (v !== undefined) out.set(k, String(v));
        }
        const status = res.statusCode ?? 502;
        const empty = status === 204 || status === 304 || init.method === "HEAD";
        if (empty) res.resume();
        resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers: out }));
      });
      const timer = setTimeout(() => req.destroy(new Error("the front door didn't answer in time")), headTimeout);
      const onAbort = () => req.destroy(abortError());
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      req.on("close", () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      });
      const body = init.body;
      if (typeof body === "string") req.end(body);
      else req.end();
    });
  return f as unknown as Fetch;
}

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

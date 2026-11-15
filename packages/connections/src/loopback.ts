// The redirect for a browser sign-in (Linear): a one-shot HTTP listener on 127.0.0.1 at a port the system picks,
// path /callback. It answers exactly one GET /callback whose `state` matches (compared in constant time) with a
// static page, then closes. Anything else, including a wrong state, a wrong Host (DNS rebinding) or a second request,
// gets 404 and changes nothing. It closes after 5 minutes or when cancelled.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const LOOPBACK_TIMEOUT = 5 * 60_000;

export type LoopbackResult = { code: string };
export class LoopbackError extends Error {
  constructor(readonly kind: "denied" | "timeout" | "cancelled", message: string) {
    super(message);
  }
}

export type Loopback = {
  /** http://127.0.0.1:<port>/callback: registered as the client's one redirect. */
  redirectUri: string;
  /** The authorization code, once; rejects on a refusal at the provider, the time limit or close(). */
  result: Promise<LoopbackResult>;
  close(): void;
};

const PAGE = (text: string) =>
  `<!doctype html><meta charset="utf-8"><title>Landlens</title><body style="font:16px -apple-system,system-ui,sans-serif;margin:4rem auto;max-width:32rem">${text}</body>`;
const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  Connection: "close",
};

const digest = (s: string) => createHash("sha256").update(s).digest();
/** Equal strings, in time that doesn't depend on where they differ. */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export async function openLoopback(opts: { state: string; timeoutMs?: number }): Promise<Loopback> {
  let settle!: { resolve: (r: LoopbackResult) => void; reject: (e: Error) => void };
  const result = new Promise<LoopbackResult>((resolve, reject) => (settle = { resolve, reject }));
  result.catch(() => {});
  let done = false;
  let port = 0;

  const notFound = (res: ServerResponse) => {
    res.writeHead(404, { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (done || req.method !== "GET" || req.headers.host !== `127.0.0.1:${port}`) return notFound(res);
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    } catch {
      return notFound(res);
    }
    const state = url.searchParams.get("state");
    if (url.pathname !== "/callback" || !state || !sameSecret(state, opts.state)) return notFound(res);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    done = true;
    if (code && /^[\x21-\x7e]{1,2048}$/.test(code) && !error) {
      res.writeHead(200, HEADERS);
      res.end(PAGE("<p>Signed in. You can close this tab and go back to Landlens.</p>"));
      settle.resolve({ code });
    } else {
      res.writeHead(200, HEADERS);
      res.end(PAGE("<p>The sign-in didn't finish. You can close this tab.</p>"));
      settle.reject(new LoopbackError("denied", "the sign-in was turned down"));
    }
    res.once("finish", finish);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;

  const timer = setTimeout(() => {
    settle.reject(new LoopbackError("timeout", "the sign-in wasn't finished in time"));
    finish();
  }, opts.timeoutMs ?? LOOPBACK_TIMEOUT);

  function finish() {
    done = true;
    clearTimeout(timer);
    // Let the one answer go out, then stop listening and drop any other connection.
    server.close();
    setImmediate(() => server.closeAllConnections());
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    result,
    close() {
      if (!done) settle.reject(new LoopbackError("cancelled", "the sign-in was cancelled"));
      finish();
    },
  };
}

// The front door: the one local entry to the clusters for tools (kubectl, helm) and the agent.
//
// https://127.0.0.1:<port>/c/<handle>/<API server path>. TLS because kubectl and client-go only send credentials
// over TLS; the certificate is made fresh each run (loopbackCert) and its CA pinned in the tool kubeconfig. Every
// request needs a bearer token Landlens issued; each token names the clusters it may reach and carries a policy
// (policy.ts). Allowed requests go to that cluster's
// sidecar with the sidecar secret; the caller's token never reaches the cluster. OpenLens's proxy had no token at
// all and Freelens added one per run; here each agent session gets its own, read-only, revocable token.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { connect, type AddressInfo, type Socket } from "node:net";
import { authorize, isCanonicalPath, parseRequest, type ParsedRequest, type Policy, type ScopeOf } from "./policy.js";
import { redactObject, redactText } from "./redact.js";
import { SIDECAR_HEADER, type LoopbackCert } from "./sidecar.js";

export type Upstream = {
  url: string;
  secret: string;
  /** Whether a kind is namespaced, from the cluster's discovery; for namespace-limited tokens. */
  scopeOf?: ScopeOf;
};

export type TokenGrant = {
  /** Shown in the audit trail, e.g. "ide" or "agent session 3". */
  label: string;
  policy: Policy;
  /** Cluster handles this token may reach. */
  clusters: string[];
};

export type AuditEntry = {
  at: string;
  label: string;
  method: string;
  cluster: string;
  path: string;
  allowed: boolean;
  status?: number;
  reason?: string;
  /** The MCP gateway call this request was made for (X-Landlens-Call), when the caller said. */
  call?: string;
  /** A write sent with dryRun=All: checked by the API server, not stored. */
  dryRun?: true;
};

/** A gateway call id, as the MCP tools send it; anything else in the header is ignored. */
const CALL_ID = /^c[0-9a-z]{1,24}$/;

const PREFIX = /^\/c\/([A-Za-z0-9_-]{8,64})(\/.*)$/;
const hash = (t: string) => createHash("sha256").update(t).digest();

export class FrontDoor {
  private server: Server | undefined;
  private readonly upstreams = new Map<string, Upstream>();
  private readonly grants = new Map<string, TokenGrant>(); // sha256(token) hex → grant
  /** Each grant's open connections (streams, watches, exec, port-forward): revoking a token closes them too. */
  private readonly open = new Map<TokenGrant, Set<() => void>>();
  private port = 0;

  constructor(
    private readonly tls: LoopbackCert,
    private readonly onAudit: (e: AuditEntry) => void = () => {},
  ) {}

  /** The certificate tools must trust (PEM): this run's CA, which signed only the front door's certificate. */
  get certificate(): string {
    return this.tls.ca;
  }

  async start(): Promise<void> {
    const server = createServer({ cert: this.tls.cert, key: this.tls.key, minVersion: "TLSv1.2" }, (req, res) =>
      void this.handle(req, res));
    server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket as Socket, head));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  get url(): string {
    return `https://127.0.0.1:${this.port}`;
  }

  clusterUrl(handle: string): string {
    return `${this.url}/c/${handle}`;
  }

  addCluster(handle: string, upstream: Upstream) {
    this.upstreams.set(handle, upstream);
  }

  removeCluster(handle: string) {
    this.upstreams.delete(handle);
  }

  issueToken(grant: TokenGrant): string {
    const token = randomBytes(32).toString("hex");
    this.grants.set(hash(token).toString("hex"), grant);
    return token;
  }

  revokeToken(token: string) {
    const k = hash(token).toString("hex");
    const grant = this.grants.get(k);
    this.grants.delete(k);
    if (!grant) return;
    const closers = this.open.get(grant);
    this.open.delete(grant);
    for (const close of closers ?? []) close();
  }

  /** Close this connection when its token is revoked; returns the function to call when it ends by itself. */
  private track(grant: TokenGrant, close: () => void): () => void {
    let set = this.open.get(grant);
    if (!set) this.open.set(grant, (set = new Set()));
    set.add(close);
    return () => {
      set!.delete(close);
      if (!set!.size && this.open.get(grant) === set) this.open.delete(grant);
    };
  }

  /** Look up a grant by token without a timing side channel on the token's bytes. */
  private grantFor(header: string | undefined): TokenGrant | undefined {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(header ?? "");
    if (!m) return undefined;
    const h = hash(m[1]!);
    for (const [k, g] of this.grants) {
      if (timingSafeEqual(Buffer.from(k, "hex"), h)) return g;
    }
    return undefined;
  }

  /** The shared checks for plain and upgraded requests. */
  private check(req: IncomingMessage, upgrade = false):
    | { ok: true; grant: TokenGrant; handle: string; path: string; upstream: Upstream; parsed: ParsedRequest }
    | { ok: false; status: number; reason: string; label: string; handle: string; path: string } {
    const m = PREFIX.exec(req.url ?? "");
    const handle = m?.[1] ?? "";
    const path = m?.[2] ?? req.url ?? "";
    const grant = this.grantFor(req.headers.authorization);
    const label = grant?.label ?? "unknown";
    if (!grant) return { ok: false, status: 401, reason: "missing or unknown Landlens token", label, handle, path };
    if (!m) return { ok: false, status: 404, reason: "expected /c/<cluster>/<path>", label, handle, path };
    if (!grant.clusters.includes(handle)) {
      return { ok: false, status: 403, reason: "this token may not reach this cluster", label, handle, path };
    }
    const upstream = this.upstreams.get(handle);
    if (!upstream) return { ok: false, status: 503, reason: "cluster is not connected in Landlens", label, handle, path };
    if (!isCanonicalPath(path)) return { ok: false, status: 400, reason: "path is not canonical", label, handle, path };
    // Impersonation would act as someone else with the user's credentials (kubectl --as). The sidecar strips the
    // headers too; refusing here makes it an error rather than a silent request as the user.
    if (Object.keys(req.headers).some((h) => h.startsWith("impersonate-"))) {
      return { ok: false, status: 403, reason: "impersonation is not allowed through Landlens", label, handle, path };
    }
    const parsed = parseRequest(req.method ?? "GET", path);
    const decision = authorize(grant.policy, parsed, upstream.scopeOf);
    if (!decision.allow) return { ok: false, status: 403, reason: decision.reason, label, handle, path };
    // A forward token opens only the WebSocket port-forward (v4.channel.k8s.io), where the kubelet takes the port from
    // the query the policy checked. SPDY, and SPDY tunnelled over a WebSocket, name the port inside the stream.
    if (grant.policy.access === "forward") {
      const ws = upgrade && req.method === "GET" && String(req.headers.upgrade ?? "").toLowerCase() === "websocket"
        && String(req.headers["sec-websocket-protocol"] ?? "").trim() === "v4.channel.k8s.io";
      if (!ws) return { ok: false, status: 403, reason: "a forward token opens only a v4.channel.k8s.io WebSocket", label, handle, path };
    }
    return { ok: true, grant, handle, path, upstream, parsed };
  }

  private audit(req: IncomingMessage, c: { label: string; handle: string; path: string }, allowed: boolean, status?: number, reason?: string) {
    const call = req.headers["x-landlens-call"];
    const dryRun = new URL(c.path, "http://x").searchParams.getAll("dryRun").includes("All");
    this.onAudit({
      at: new Date().toISOString(),
      label: c.label,
      method: req.method ?? "GET",
      cluster: c.handle,
      path: c.path.split("?")[0] ?? "",
      allowed,
      ...(status !== undefined ? { status } : {}),
      ...(reason ? { reason } : {}),
      ...(typeof call === "string" && CALL_ID.test(call) ? { call } : {}),
      ...(dryRun ? { dryRun: true as const } : {}),
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const c = this.check(req);
    if (!c.ok) {
      this.audit(req, c, false, c.status, c.reason);
      return sendStatus(res, c.status, c.reason);
    }
    const target = new URL(c.path, c.upstream.url);
    const headers = { ...req.headers };
    delete headers.authorization;
    delete headers.host;
    delete headers["x-landlens-call"];
    headers[SIDECAR_HEADER.toLowerCase()] = c.upstream.secret;
    const scrub = !!c.grant.policy.redact;
    if (scrub) {
      // Ask for bodies the front door can read: uncompressed, JSON rather than protobuf.
      delete headers["accept-encoding"];
      headers.accept = jsonAccept(req.headers.accept);
    }
    const who = { label: c.grant.label, handle: c.handle, path: c.path };
    const untrack = this.track(c.grant, () => {
      up.destroy();
      res.destroy();
    });
    res.on("close", untrack);
    const up = httpRequest(target, { method: req.method, headers }, (upRes) => {
      this.audit(req, who, true, upRes.statusCode);
      if (!scrub || req.method === "HEAD") {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
        return;
      }
      const q = new URL(c.path, "http://x").searchParams;
      scrubResponse(upRes, res, c.parsed.verb === "watch" || q.get("follow") === "true" || q.get("follow") === "1");
    });
    up.on("error", () => {
      if (!res.headersSent) {
        this.audit(req, who, true, 502);
        sendStatus(res, 502, "the cluster could not be reached");
      } else res.destroy();
    });
    res.on("close", () => up.destroy());
    req.pipe(up);
  }

  /** exec/attach/port-forward use upgraded connections; same checks, then splice the sockets. */
  private handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer) {
    const c = this.check(req, true);
    if (!c.ok) {
      this.audit(req, c, false, c.status, c.reason);
      socket.end(`HTTP/1.1 ${c.status} ${c.status === 401 ? "Unauthorized" : "Forbidden"}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${statusBody(c.status, c.reason)}`);
      return;
    }
    const target = new URL(c.upstream.url);
    const who = { label: c.grant.label, handle: c.handle, path: c.path };
    let audited = false;
    const up = connect(Number(target.port), target.hostname, () => {
      const lines = [`${req.method} ${c.path} HTTP/1.1`, `Host: ${target.host}`, `${SIDECAR_HEADER}: ${c.upstream.secret}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i]!;
        if (/^(host|authorization|cookie|x-landlens-.*|impersonate-.*)$/i.test(k)) continue;
        lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
      }
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) up.write(head);
      // Audit with the cluster's answer (101, or 403 from RBAC), not before it.
      up.once("data", (first: Buffer) => {
        audited = true;
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(first.subarray(0, 32).toString("latin1"))?.[1] ?? 0);
        this.audit(req, who, true, status || undefined);
        socket.write(first);
        up.pipe(socket);
      });
      socket.pipe(up);
    });
    const close = () => {
      untrack();
      if (!audited) {
        audited = true;
        this.audit(req, who, true, 502);
      }
      up.destroy();
      socket.destroy();
    };
    const untrack = this.track(c.grant, close);
    up.on("error", close).on("close", close);
    socket.on("error", close).on("close", close);
  }
}

/** The most the front door buffers to scrub one response, and one line of a stream. */
export const MAX_SCRUBBED = 64 * 1024 * 1024;

function jsonAccept(accept: string | undefined): string {
  const kept = (accept ?? "").split(",").map((a) => a.trim()).filter((a) => a && !/protobuf/i.test(a));
  return kept.length ? kept.join(",") : "application/json";
}

/**
 * Scrub a response for a redacting token (Policy.redact): JSON as objects, plain text (logs) as text. Streams (watch,
 * logs -f) line by line. Fails closed: a body it can't read is refused, never passed through.
 */
function scrubResponse(upRes: IncomingMessage, res: ServerResponse, stream: boolean) {
  const status = upRes.statusCode ?? 502;
  const type = String(upRes.headers["content-type"] ?? "");
  const encoding = String(upRes.headers["content-encoding"] ?? "identity");
  const json = /^application\/json\b/i.test(type);
  const text = /^text\/plain\b/i.test(type);
  const empty = upRes.headers["content-length"] === "0" || status === 204 || status === 304;
  const refuse = (why: string) => {
    upRes.destroy();
    if (!res.headersSent) sendStatus(res, 502, why);
    else res.destroy();
  };
  if (empty) {
    res.writeHead(status, upRes.headers);
    return void upRes.pipe(res);
  }
  if (encoding !== "identity") return refuse(`Landlens can't scrub a ${encoding} response for this token`);
  if (!json && !text) return refuse(`Landlens can't scrub a ${type || "untyped"} response for this token`);
  const headers = { ...upRes.headers };
  delete headers["content-length"];
  delete headers["content-encoding"];
  delete headers["transfer-encoding"];
  const scrubLine = (line: string): string | undefined => {
    if (text) return redactText(line);
    if (!line.trim()) return line;
    try {
      return JSON.stringify(redactObject(JSON.parse(line)));
    } catch {
      return undefined; // not a whole JSON event: drop it rather than pass it through unscrubbed
    }
  };

  if (stream) {
    res.writeHead(status, headers);
    let pending = "";
    upRes.setEncoding("utf8");
    upRes.on("data", (chunk: string) => {
      pending += chunk;
      if (pending.length > MAX_SCRUBBED) return refuse("a line too long to scrub");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      const out = lines.map(scrubLine).filter((l): l is string => l !== undefined);
      if (out.length) res.write(out.join("\n") + "\n");
    });
    upRes.on("end", () => {
      const last = pending ? scrubLine(pending) : undefined;
      res.end(last ?? "");
    });
    upRes.on("error", () => res.destroy());
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  upRes.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_SCRUBBED) return refuse("the response is too large to scrub; narrow the request (namespace, labelSelector, limit, tailLines)");
    chunks.push(chunk);
  });
  upRes.on("end", () => {
    if (res.headersSent || res.destroyed) return;
    const body = Buffer.concat(chunks).toString("utf8");
    let out: string;
    if (text) out = redactText(body);
    else {
      try {
        out = JSON.stringify(redactObject(JSON.parse(body)));
      } catch {
        return refuse("the cluster's answer was not valid JSON");
      }
    }
    res.writeHead(status, { ...headers, "content-length": Buffer.byteLength(out) });
    res.end(out);
  });
  upRes.on("error", () => res.destroy());
}

function statusBody(code: number, message: string) {
  const reason = code === 401 ? "Unauthorized" : code === 403 ? "Forbidden" : code === 404 ? "NotFound" : code === 400 ? "BadRequest" : "ServiceUnavailable";
  return JSON.stringify({ kind: "Status", apiVersion: "v1", status: "Failure", reason, message: `Landlens: ${message}`, code });
}

function sendStatus(res: ServerResponse, code: number, message: string) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(statusBody(code, message));
}

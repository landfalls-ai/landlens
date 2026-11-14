// The remote MCP servers you added, kept in userData/mcp-servers.json (mode 0600). A server's header value (its
// bearer token or API key) is encrypted with Electron's safeStorage, like the Clickland key, and is decrypted only
// here, in main, when the gateway connects: no channel returns it, and it never reaches Claude Code's environment.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { McpServerInfo, McpToolInfo } from "@landlens/contracts";
import type { RemoteSpec } from "@landlens/mcp-gateway";
import type { Crypto } from "./clickland-settings";

type Stored = {
  id: string;
  name: string;
  url: string;
  header?: { name: string; value?: string };
  appOrigins: string[];
  /** The clusters (kubeconfig contexts) whose agent sessions get this server. */
  contexts: string[];
  tools?: McpToolInfo[];
  status?: McpServerInfo["status"];
  detail?: string;
};

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export class McpServerStore {
  constructor(private readonly path: string, private readonly crypto: Crypto) {}

  private read(): Stored[] {
    if (!existsSync(this.path)) return [];
    try {
      const s = JSON.parse(readFileSync(this.path, "utf8"));
      return Array.isArray(s?.servers) ? s.servers : [];
    } catch {
      return [];
    }
  }

  private write(servers: Stored[]) {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ servers }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }

  get canStore(): boolean {
    return this.crypto.isEncryptionAvailable();
  }

  /** What the renderer may know: never a header value, only whether one is stored. */
  list(context?: string): McpServerInfo[] {
    return this.read().map((s) => view(s, context));
  }

  info(id: string, context?: string): McpServerInfo {
    return view(this.get(id), context);
  }

  private get(id: string): Stored {
    const s = this.read().find((x) => x.id === id);
    if (!s) throw fail(404, "no such MCP server");
    return s;
  }

  /** Add or change a server. A header without a value keeps the stored value if the header name is unchanged. */
  save(input: { id?: string; name: string; url: string; header?: { name: string; value?: string }; appOrigins?: string[] }): Stored {
    const all = this.read();
    const prev = input.id ? all.find((s) => s.id === input.id) : undefined;
    if (input.id && !prev) throw fail(404, "no such MCP server");
    if (all.some((s) => s.name === input.name && s.id !== input.id)) throw fail(409, `There's already a server named ${input.name}.`);
    let header: Stored["header"];
    if (input.header) {
      if (input.header.value !== undefined) {
        if (!this.canStore) throw fail(409, "This machine can't encrypt the header (safeStorage is unavailable), so Landlens won't store it.");
        header = { name: input.header.name, value: this.crypto.encryptString(input.header.value).toString("base64") };
      } else if (prev?.header?.name.toLowerCase() === input.header.name.toLowerCase() && prev.header.value) {
        header = { name: input.header.name, value: prev.header.value };
      } else {
        header = { name: input.header.name };
      }
    }
    // A new address or credential means the old listing no longer says anything.
    const changed = !prev || prev.url !== input.url || input.header?.value !== undefined || prev.header?.name !== input.header?.name;
    const next: Stored = {
      id: prev?.id ?? `s_${randomBytes(12).toString("base64url")}`,
      name: input.name,
      url: input.url,
      ...(header ? { header } : {}),
      appOrigins: [...new Set(input.appOrigins ?? prev?.appOrigins ?? [])],
      contexts: prev?.contexts ?? [],
      ...(!changed && prev?.tools ? { tools: prev.tools, status: prev.status, ...(prev.detail ? { detail: prev.detail } : {}) } : {}),
    };
    this.write(prev ? all.map((s) => (s.id === prev.id ? next : s)) : [...all, next]);
    return next;
  }

  enable(id: string, context: string, on: boolean): McpServerInfo {
    const all = this.read();
    const s = all.find((x) => x.id === id);
    if (!s) throw fail(404, "no such MCP server");
    s.contexts = on ? [...new Set([...s.contexts, context])] : s.contexts.filter((c) => c !== context);
    this.write(all);
    return view(s, context);
  }

  remove(id: string) {
    this.write(this.read().filter((s) => s.id !== id));
  }

  /** The result of the last test or listing. */
  status(id: string, r: { status: McpServerInfo["status"]; detail?: string; tools?: McpToolInfo[] }) {
    const all = this.read();
    const s = all.find((x) => x.id === id);
    if (!s) return;
    s.status = r.status;
    if (r.detail) s.detail = r.detail;
    else delete s.detail;
    if (r.tools) s.tools = r.tools;
    this.write(all);
  }

  /** Main only: a server with its header decrypted, for a test or a connection. */
  spec(id: string): RemoteSpec & { id: string } {
    return this.toSpec(this.get(id));
  }

  /** Main only: the servers turned on for a cluster, with their headers decrypted. */
  remotesFor(context: string): (RemoteSpec & { id: string })[] {
    return this.read().filter((s) => s.contexts.includes(context)).map((s) => this.toSpec(s));
  }

  /** The stored header value for an id, decrypted, if any (for Test of a saved server). */
  headerValue(id: string): string | undefined {
    const v = this.read().find((s) => s.id === id)?.header?.value;
    if (!v || !this.canStore) return undefined;
    try {
      return this.crypto.decryptString(Buffer.from(v, "base64"));
    } catch {
      return undefined;
    }
  }

  private toSpec(s: Stored): RemoteSpec & { id: string } {
    const value = this.headerValue(s.id);
    return { id: s.id, name: s.name, url: s.url, ...(s.header && value ? { headers: { [s.header.name]: value } } : {}) };
  }

  /** The app origins a server's views may connect to (what its resources declare is cut to these). */
  appOriginsOf(name: string): string[] {
    return this.read().find((s) => s.name === name)?.appOrigins ?? [];
  }
}

function view(s: Stored, context?: string): McpServerInfo {
  return {
    id: s.id,
    name: s.name,
    builtin: false,
    url: s.url,
    ...(s.header ? { header: { name: s.header.name, stored: !!s.header.value } } : {}),
    enabled: context ? s.contexts.includes(context) : false,
    appOrigins: s.appOrigins,
    ...(s.tools ? { tools: s.tools } : {}),
    status: s.status ?? "unknown",
    ...(s.detail ? { detail: s.detail } : {}),
  };
}

// The remote MCP servers you added, kept in userData/mcp-servers.json (mode 0600). A server's header value (its
// bearer token or API key) is encrypted with Electron's safeStorage, like the Clickland key, and is decrypted only
// here, in main, when the gateway connects: no channel returns it, and it never reaches Claude Code's environment.
// A stored value belongs to the origin and header name it was typed for: it is never sent to another origin or under
// another name, and saving a new origin or name without typing it again drops it.
//
// "Run read-only tools without asking" is off for every server you add. Turning it on pins the tool listing the MCP
// page showed you (its hash); a session that finds another listing, or a Test that does, turns it off again.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { RESERVED_MCP_NAMES, type McpServerInfo, type McpToolInfo } from "@landlens/contracts";
import type { RemoteSpec } from "@landlens/mcp-gateway";
import type { Crypto } from "./clickland-settings";

type Stored = {
  id: string;
  name: string;
  url: string;
  header?: { name: string; value?: string };
  /** The hash of the tool listing the last Test or session saw: what the MCP page shows. */
  listing?: string;
  /** You let its read-only tools run without asking, for the listing with this hash. */
  autoRun?: { pin: string };
  /** Why auto-run was turned off, to show beside the switch. */
  autoRunNote?: string;
  appOrigins: string[];
  /** The clusters (kubeconfig contexts) whose agent sessions get this server. */
  contexts: string[];
  tools?: McpToolInfo[];
  status?: McpServerInfo["status"];
  detail?: string;
};

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/** scheme://host:port of an address; a stored secret is bound to it. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export const DRIFT_NOTE = "Its tools changed since you allowed them, so every tool asks again. Check them, then turn this on again.";

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

  /**
   * Add or change a server. A header without a value keeps the stored value only if the header name and the
   * address's origin are unchanged; otherwise the stored value is dropped and has to be typed again.
   */
  save(input: { id?: string; name: string; url: string; header?: { name: string; value?: string }; appOrigins?: string[] }): Stored {
    const all = this.read();
    const prev = input.id ? all.find((s) => s.id === input.id) : undefined;
    if (input.id && !prev) throw fail(404, "no such MCP server");
    // github, linear and landlens-gcp are Connections' servers. One you already saved under such a name keeps it.
    if ((RESERVED_MCP_NAMES as readonly string[]).includes(input.name) && prev?.name !== input.name) throw fail(409, "That name is used by Connections.");
    if (all.some((s) => s.name === input.name && s.id !== input.id)) throw fail(409, `There's already a server named ${input.name}.`);
    let header: Stored["header"];
    if (input.header) {
      if (input.header.value !== undefined) {
        if (!this.canStore) throw fail(409, "This machine can't encrypt the header (safeStorage is unavailable), so Landlens won't store it.");
        header = { name: input.header.name, value: this.crypto.encryptString(input.header.value).toString("base64") };
      } else if (prev?.header?.value && prev.header.name.toLowerCase() === input.header.name.toLowerCase() && originOf(prev.url) === originOf(input.url)) {
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
      // A new address or credential may list other tools: auto-run waits for you to look again.
      ...(!changed && prev?.listing ? { listing: prev.listing } : {}),
      ...(!changed && prev?.autoRun ? { autoRun: prev.autoRun } : {}),
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

  /**
   * "Run read-only tools without asking". On pins the listing the MCP page shows (from the last Test), so a server
   * never tested can't be turned on: you haven't seen its tools.
   */
  setAutoRun(id: string, on: boolean, context?: string): McpServerInfo {
    const all = this.read();
    const s = all.find((x) => x.id === id);
    if (!s) throw fail(404, "no such MCP server");
    if (on) {
      if (!s.listing || !s.tools) throw fail(409, "Test it first, so you've seen the tools you're allowing.");
      s.autoRun = { pin: s.listing };
    } else delete s.autoRun;
    delete s.autoRunNote;
    this.write(all);
    return view(s, context);
  }

  /** A session found another listing than the one you pinned: auto-run goes off, with a note. */
  drifted(id: string) {
    const all = this.read();
    const s = all.find((x) => x.id === id);
    if (!s?.autoRun) return;
    delete s.autoRun;
    s.autoRunNote = DRIFT_NOTE;
    this.write(all);
  }

  /** The result of the last test or listing; a listing other than the pinned one turns auto-run off. */
  status(id: string, r: { status: McpServerInfo["status"]; detail?: string; tools?: McpToolInfo[]; listing?: string }) {
    const all = this.read();
    const s = all.find((x) => x.id === id);
    if (!s) return;
    s.status = r.status;
    if (r.detail) s.detail = r.detail;
    else delete s.detail;
    if (r.tools) s.tools = r.tools;
    if (r.listing) {
      s.listing = r.listing;
      if (s.autoRun && s.autoRun.pin !== r.listing) {
        delete s.autoRun;
        s.autoRunNote = DRIFT_NOTE;
      }
    }
    this.write(all);
  }

  /** The stored header's name, if any (main only; the value stays encrypted). */
  headerName(id: string): string | undefined {
    return this.get(id).header?.name;
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
    return { id: s.id, name: s.name, url: s.url, ...(s.header && value ? { headers: { [s.header.name]: value } } : {}), ...(s.autoRun ? { pin: s.autoRun.pin } : {}) };
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
    autoRun: !!s.autoRun,
    ...(s.autoRunNote ? { autoRunNote: s.autoRunNote } : {}),
    appOrigins: s.appOrigins,
    ...(s.tools ? { tools: s.tools } : {}),
    status: s.status ?? "unknown",
    ...(s.detail ? { detail: s.detail } : {}),
  };
}

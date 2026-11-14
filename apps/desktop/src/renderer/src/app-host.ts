// The host side of MCP Apps (2026-01-26) for one view, without the SDK's AppBridge (it would bring zod and the MCP
// Protocol class into the renderer). The frame component (AppFrame.tsx) hands it messages that came from its own
// iframe's window and posts what it sends; this file holds no DOM, so the tests drive it with the SDK's App.
//
// What a view may do here: initialize; get its tool's input and result; call tools on its own server (through main
// and the gateway, with the same approval rules as anything else); ask to open a link (https only, you confirm, or
// landlens://object/... which moves the main view); report its size; log. It may not write to the agent's
// conversation (ui/message), change what the model sees (ui/update-model-context), read resources or change display
// mode: those are refused or answered "inline".
import type { McpAppView, McpToolResult } from "@landlens/contracts";

export const PROTOCOL_VERSION = "2026-01-26";
export const MIN_HEIGHT = 48;
export const MAX_HEIGHT = 640;
/** Larger messages from a view are dropped. */
const MAX_MESSAGE = 1_000_000;

export type HostContext = {
  theme: "light" | "dark";
  styles: { variables: Record<string, string> };
  displayMode: "inline";
  availableDisplayModes: ["inline"];
  containerDimensions: { maxHeight: number; width?: number };
  locale: string;
  timeZone: string;
  platform: "desktop";
  userAgent: string;
};

export type ObjectTarget = { kind: string; namespace?: string; name: string };

export type HostDeps = {
  /** To the view's window (the frame posts with "*": its origin is opaque). */
  post(message: unknown): void;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  /** https only; main shows the host and asks you. */
  openLink(url: string): Promise<boolean>;
  /** Move the main view to an object (the view's "Open in Landlens"). */
  openObject(t: ObjectTarget): void;
  resize(height: number): void;
  /** A key typed in the view that the app answers (Escape, ⌘/Ctrl chords): replay it in the host. */
  key?(k: ViewKey): void;
  context(): HostContext;
  log?(level: string, data: unknown): void;
};

export type ViewKey = { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean };

/** The keys a view may hand back: Escape, and ⌘/Ctrl with a letter or digit the app binds. Anything else is dropped. */
export function viewKey(p: Record<string, unknown>): ViewKey | undefined {
  const key = typeof p.key === "string" ? p.key : "";
  const k = { key, metaKey: p.metaKey === true, ctrlKey: p.ctrlKey === true, shiftKey: p.shiftKey === true, altKey: p.altKey === true };
  if (key === "Escape") return { ...k, metaKey: false, ctrlKey: false, altKey: false };
  return (k.metaKey || k.ctrlKey) && !k.altKey && /^[kjb1-9]$/i.test(key) ? k : undefined;
}

type Msg = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };

const OBJECT_LINK = /^landlens:\/\/object\/([A-Za-z][A-Za-z0-9]{0,62})\/([a-z0-9][a-z0-9.-]{0,252}|_)\/([a-z0-9][a-z0-9.:-]{0,252})$/;

/** landlens://object/<Kind>/<namespace or _>/<name>, the one non-https link a view may ask for. */
export function objectLink(url: string): ObjectTarget | undefined {
  const m = OBJECT_LINK.exec(url);
  if (!m) return undefined;
  return { kind: m[1]!, name: decodeURIComponent(m[3]!), ...(m[2] !== "_" ? { namespace: m[2]! } : {}) };
}

export class AppHost {
  private initialized = false;
  private delivered = false;
  private closed = false;
  private nextId = 1;
  private readonly waiting = new Map<number, (m: Msg) => void>();

  constructor(private readonly view: McpAppView, private readonly deps: HostDeps, private readonly hostVersion = "0.1.0") {}

  /** A message from the view (the caller checked it came from this view's frame). */
  receive(data: unknown): void {
    if (this.closed || !data || typeof data !== "object") return;
    const m = data as Msg;
    if (m.jsonrpc !== "2.0") return;
    try {
      if (JSON.stringify(m).length > MAX_MESSAGE) return;
    } catch {
      return;
    }
    if (m.method === undefined && (typeof m.id === "number" || typeof m.id === "string")) {
      const w = this.waiting.get(m.id as number);
      if (w) {
        this.waiting.delete(m.id as number);
        w(m);
      }
      return;
    }
    if (typeof m.method !== "string") return;
    const params = (m.params && typeof m.params === "object" ? m.params : {}) as Record<string, unknown>;
    if (m.id === undefined || m.id === null) return this.notification(m.method, params);
    if (typeof m.id !== "number" && typeof m.id !== "string") return;
    void this.request(m.id, m.method, params);
  }

  /** The theme or size changed: tell the view. */
  contextChanged(): void {
    if (this.initialized && !this.closed) this.notify("ui/notifications/host-context-changed", this.deps.context());
  }

  /** Ask the view to clean up before its frame goes (waits at most 500 ms). */
  async teardown(): Promise<void> {
    if (this.closed) return;
    if (this.initialized) {
      const id = this.nextId++;
      await Promise.race([
        new Promise<void>((resolve) => {
          this.waiting.set(id, () => resolve());
          this.deps.post({ jsonrpc: "2.0", id, method: "ui/resource-teardown", params: {} });
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
    }
    this.closed = true;
  }

  private notification(method: string, params: Record<string, unknown>) {
    switch (method) {
      case "ui/notifications/initialized":
        if (!this.initialized || this.delivered) return;
        this.delivered = true;
        // What the tool was called with, then what it returned: the view renders from these.
        this.notify("ui/notifications/tool-input", { arguments: this.view.input });
        this.notify("ui/notifications/tool-result", this.view.result);
        return;
      case "ui/notifications/size-changed": {
        const h = Number(params.height);
        if (Number.isFinite(h)) this.deps.resize(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.ceil(h))));
        return;
      }
      case "ui/notifications/landlens-key": {
        const k = viewKey(params);
        if (k) this.deps.key?.(k);
        return;
      }
      case "notifications/message":
        this.deps.log?.(String(params.level ?? "info"), params.data);
        return;
      default:
        return; // anything else a view says is ignored
    }
  }

  private async request(id: number | string, method: string, params: Record<string, unknown>) {
    const ok = (result: unknown) => this.deps.post({ jsonrpc: "2.0", id, result });
    const err = (code: number, message: string) => this.deps.post({ jsonrpc: "2.0", id, error: { code, message } });
    try {
      switch (method) {
        case "ui/initialize":
          this.initialized = true;
          return ok({
            protocolVersion: PROTOCOL_VERSION,
            hostInfo: { name: "Landlens", version: this.hostVersion },
            hostCapabilities: { openLinks: {}, serverTools: {}, logging: {} },
            hostContext: {
              ...this.deps.context(),
              toolInfo: { tool: { name: this.view.tool.name, ...(this.view.tool.description ? { description: this.view.tool.description } : {}), inputSchema: { type: "object" } } },
            },
          });
        case "ping":
          return ok({});
        case "tools/call": {
          if (!this.initialized) return err(-32002, "Not initialized");
          const name = typeof params.name === "string" ? params.name : "";
          const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
          if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) return err(-32602, "Invalid tool name");
          return ok(await this.deps.callTool(name, args));
        }
        case "ui/open-link": {
          const url = typeof params.url === "string" ? params.url : "";
          const target = objectLink(url);
          if (target) {
            this.deps.openObject(target);
            return ok({});
          }
          if (!/^https:\/\//i.test(url)) return ok({ isError: true });
          return ok((await this.deps.openLink(url)) ? {} : { isError: true });
        }
        case "ui/request-display-mode":
          return ok({ mode: "inline" });
        case "ui/message":
          return err(-32601, "Landlens doesn't let a view write to the agent's conversation");
        case "ui/update-model-context":
          return err(-32601, "Landlens doesn't let a view change what the model sees");
        default:
          return err(-32601, "Method not found");
      }
    } catch (e) {
      return err(-32603, (e as Error).message ?? "failed");
    }
  }

  private notify(method: string, params: unknown) {
    this.deps.post({ jsonrpc: "2.0", method, params });
  }
}

/**
 * The MCP Apps standard variables, filled from Iris tokens (docs/design.md). `token(name)` reads a computed custom
 * property from the page; values are re-read on every theme change.
 */
export function irisVariables(token: (name: string) => string): Record<string, string> {
  const t = (n: string) => token(n).trim();
  const v: Record<string, string> = {
    "--color-background-primary": t("--bg-2"),
    "--color-background-secondary": t("--bg-3"),
    "--color-background-tertiary": t("--bg-1"),
    "--color-background-inverse": t("--ink"),
    "--color-background-ghost": "transparent",
    "--color-background-info": t("--accent-soft"),
    "--color-background-danger": t("--bad-soft"),
    "--color-background-success": t("--ok-soft"),
    "--color-background-warning": t("--warn-soft"),
    "--color-background-disabled": t("--bg-3"),
    "--color-text-primary": t("--ink"),
    "--color-text-secondary": t("--ink-2"),
    "--color-text-tertiary": t("--ink-3"),
    "--color-text-inverse": t("--bg-0"),
    "--color-text-ghost": t("--ink-4"),
    "--color-text-info": t("--accent"),
    "--color-text-danger": t("--bad-text"),
    "--color-text-success": t("--ok-text"),
    "--color-text-warning": t("--warn-text"),
    "--color-text-disabled": t("--ink-4"),
    "--color-border-primary": t("--line-2"),
    "--color-border-secondary": t("--line"),
    "--color-border-tertiary": t("--line"),
    "--color-border-inverse": t("--bg-0"),
    "--color-border-ghost": "transparent",
    "--color-border-info": t("--accent-line"),
    "--color-border-danger": t("--bad"),
    "--color-border-success": t("--ok"),
    "--color-border-warning": t("--warn"),
    "--color-border-disabled": t("--line"),
    "--color-ring-primary": t("--accent"),
    "--color-ring-secondary": t("--line-2"),
    "--color-ring-inverse": t("--ink"),
    "--color-ring-info": t("--accent"),
    "--color-ring-danger": t("--bad"),
    "--color-ring-success": t("--ok"),
    "--color-ring-warning": t("--warn"),
    // Geist isn't loaded inside a view (its CSP allows fonts from data: only), so the system face follows it.
    "--font-sans": t("--font"),
    "--font-mono": t("--mono"),
    "--font-weight-normal": "400",
    "--font-weight-medium": "500",
    "--font-weight-semibold": "600",
    "--font-weight-bold": "700",
    "--font-text-xs-size": "11px",
    "--font-text-sm-size": "12px",
    "--font-text-md-size": "13px",
    "--font-text-lg-size": "15px",
    "--font-heading-xs-size": "12px",
    "--font-heading-sm-size": "13px",
    "--font-heading-md-size": "15px",
    "--font-heading-lg-size": "16px",
    "--font-heading-xl-size": "20px",
    "--font-heading-2xl-size": "26px",
    "--font-heading-3xl-size": "30px",
    "--font-text-xs-line-height": "1.4",
    "--font-text-sm-line-height": "1.45",
    "--font-text-md-line-height": "1.45",
    "--font-text-lg-line-height": "1.4",
    "--font-heading-xs-line-height": "1.3",
    "--font-heading-sm-line-height": "1.3",
    "--font-heading-md-line-height": "1.3",
    "--font-heading-lg-line-height": "1.25",
    "--font-heading-xl-line-height": "1.2",
    "--font-heading-2xl-line-height": "1.15",
    "--font-heading-3xl-line-height": "1.1",
    "--border-radius-xs": "3px",
    "--border-radius-sm": t("--r-1"),
    "--border-radius-md": t("--r-2"),
    "--border-radius-lg": t("--r-3"),
    "--border-radius-xl": t("--r-4"),
    "--border-radius-full": "9999px",
    "--border-width-regular": "1px",
    "--shadow-hairline": `0 0 0 1px ${t("--line")}`,
    "--shadow-sm": t("--shadow-1"),
    "--shadow-md": t("--shadow-2"),
    "--shadow-lg": t("--shadow-2"),
  };
  // Nothing that could close a declaration or open a rule reaches the view.
  for (const k of Object.keys(v)) if (!v[k] || /[;{}<>\\]/.test(v[k]!)) delete v[k];
  return v;
}

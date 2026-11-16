// MCP App views, served on their own origin. A view is an HTML document from an MCP server (Landlens's own, or a
// remote one you added); it runs in the dock or on the MCP page in an <iframe sandbox="allow-scripts"> whose src is
// landlens-app://view/<id>, a scheme main registers and answers itself. So a view:
// - has an opaque origin (no allow-same-origin): it can't reach the page that embeds it, its storage or its cookies,
//   and the renderer's own CSP and IPC don't apply to it; no preload runs in it, so window.landlens isn't there;
// - runs under the CSP below, sent as a header by main: inline script and style only, images, fonts and media from
//   data: only, and no network at all (connect-src 'none') unless its resource declares connect domains AND you listed
//   them for its server on the MCP page (only https origins); never frames, objects, forms or a base URI;
// - can't navigate (main allows a frame to load only a live view's own address), open windows or popups (the sandbox
//   has no allow-popups, and main denies them anyway), or reach the top window (no allow-top-navigation).
// It talks to Landlens only by postMessage with the frame that embeds it, which answers the MCP Apps methods (see
// renderer/app-host.ts): tools it calls go through the gateway with its session and the same approval rules.
import { randomBytes } from "node:crypto";
import type { AppResource } from "@landlens/mcp-gateway";

export const APP_SCHEME = "landlens-app";
const HOST = "view";
const MAX_VIEWS = 40;

export type View = {
  id: string;
  /** The gateway call whose result the view shows ("" for a block of a view, which is no call's). */
  call: string;
  /** A block Claude wrote on the Views page (wave 10, D204): its view and block. Its calls and intents go to ViewService. */
  block?: { view: string; block: string };
  server: string;
  tool: string;
  html: string;
  csp: string;
  /** Tool calls from this view in the current minute, to keep a runaway view from flooding the gateway. */
  calls: { minute: number; count: number };
  /** Link dialogs it asked for in the current minute. */
  links: { minute: number; count: number };
};

/** An https origin, exactly; anything else a resource declares is dropped. */
const ORIGIN = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

/**
 * The view's CSP. Network is off unless its resource declares connect domains you also allowed for its server; the
 * declared resource, frame and base-URI domains are ignored (assets come inline or as data:, and views never frame).
 */
export function viewCsp(declared: AppResource["csp"], allowed: string[]): string {
  const allow = new Set(allowed.filter((o) => ORIGIN.test(o)));
  const connect = declared.connectDomains.filter((d) => ORIGIN.test(d) && allow.has(d));
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "media-src data:",
    `connect-src ${connect.length ? connect.join(" ") : "'none'"}`,
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    // WebRTC isn't fetch: connect-src doesn't cover ICE (STUN/TURN). CSP3's webrtc directive blocks it where the
    // engine knows it; the window's WebRTC IP policy (security.ts) keeps UDP off where it doesn't.
    "webrtc 'block'",
  ].join("; ");
}

/** Headers of every view response, beside its CSP. */
export const VIEW_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-DNS-Prefetch-Control": "off",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), display-capture=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), fullscreen=()",
} as const;

export class AppViews {
  private readonly views = new Map<string, View>();

  add(v: Omit<View, "id" | "calls" | "links">): View {
    const view: View = { ...v, id: randomBytes(16).toString("hex"), calls: { minute: 0, count: 0 }, links: { minute: 0, count: 0 } };
    this.views.set(view.id, view);
    while (this.views.size > MAX_VIEWS) this.views.delete(this.views.keys().next().value!);
    return view;
  }

  get(id: string): View | undefined {
    return this.views.get(id);
  }

  close(id: string) {
    this.views.delete(id);
  }

  /** At most 60 tool calls a minute per view. */
  allowCall(id: string, now = Date.now()): boolean {
    const v = this.views.get(id);
    if (!v) return false;
    const minute = Math.floor(now / 60_000);
    if (v.calls.minute !== minute) v.calls = { minute, count: 0 };
    return ++v.calls.count <= 60;
  }

  /** At most three link dialogs a minute per view. */
  allowLink(id: string, now = Date.now()): boolean {
    const v = this.views.get(id);
    if (!v) return false;
    const minute = Math.floor(now / 60_000);
    if (v.links.minute !== minute) v.links = { minute, count: 0 };
    return ++v.links.count <= 3;
  }

  /** The frame's address for a view. */
  static url(id: string): string {
    return `${APP_SCHEME}://${HOST}/${id}`;
  }

  /** Whether a frame may load this address: a live view's own, nothing else. */
  isViewUrl(url: string): boolean {
    return !!this.match(url);
  }

  private match(url: string): View | undefined {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return undefined;
    }
    if (u.protocol !== `${APP_SCHEME}:` || u.host !== HOST || u.search || u.username || u.password) return undefined;
    const m = /^\/([0-9a-f]{32})$/.exec(u.pathname);
    return m ? this.views.get(m[1]!) : undefined;
  }

  /** What the landlens-app: scheme answers. */
  respond(method: string, url: string): { status: number; headers: Record<string, string>; body: string } {
    const v = method === "GET" ? this.match(url) : undefined;
    if (!v) return { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Security-Policy": "default-src 'none'", "X-Content-Type-Options": "nosniff" }, body: "not found" };
    return { status: 200, headers: { ...VIEW_HEADERS, "Content-Security-Policy": v.csp }, body: v.html };
  }
}

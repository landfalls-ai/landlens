// The Electron security baseline. Both Lens forks run their UI with nodeIntegration on, contextIsolation off, no
// sandbox and a CSP with 'unsafe-eval' (docs/research/lens-architecture.md). Landlens runs an AI agent with access to
// clusters, so the renderer gets none of that: sandboxed, isolated, no Node, a strict CSP, no navigation, no new
// windows, no permissions, and it can only call the IPC channels the preload bridge lists.
import { app, protocol, session, type BrowserWindowConstructorOptions, type WebContents } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { APP_SCHEME, type AppViews } from "./app-views";
import { CSP_PROD } from "./csp";

export { CSP_PROD };

/** Set by electron-vite dev; ignored in a packaged app, so an environment variable can't point Landlens elsewhere. */
export const DEV_URL = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;

/** The one page Landlens loads in production. */
export const RENDERER_INDEX = join(__dirname, "../renderer/index.html");
const RENDERER_URL = pathToFileURL(RENDERER_INDEX).href;

export function secureWebPreferences(preload: string): BrowserWindowConstructorOptions["webPreferences"] {
  return {
    preload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
    navigateOnDragDrop: false,
  };
}

/** Dev only: Vite's HMR client and React refresh need the dev server, its websocket and one inline preamble. */
const cspDev = (origin: string) =>
  `default-src 'none'; script-src 'self' ${origin} 'unsafe-inline'; style-src 'self' 'unsafe-inline' ${origin}; ` +
  `img-src 'self' data: ${origin}; font-src 'self' ${origin}; connect-src 'self' ${origin} ${origin.replace(/^http/, "ws")}; ` +
  `frame-src ${APP_SCHEME}:; ` +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

/** Our own page and nothing else: the dev server's origin in development, the exact index.html file otherwise. */
export function isAppUrl(url: string): boolean {
  if (DEV_URL) return url.startsWith(new URL(DEV_URL).origin + "/");
  return url.split("#")[0] === RENDERER_URL;
}

export function hardenSession() {
  const csp = DEV_URL ? cspDev(new URL(DEV_URL).origin) : CSP_PROD;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // An MCP App view keeps the CSP main served it with (app-views.ts); everything else gets the renderer's.
    if (details.url.startsWith(`${APP_SCHEME}:`)) return callback({});
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp] } });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

/** Whether a frame may load an address: set once the views exist (registerAppProtocol). */
let isViewUrl: (url: string) => boolean = () => false;

/** Serve MCP App views on landlens-app: from main; a frame may load only a live view's own address. */
export function registerAppProtocol(views: AppViews) {
  isViewUrl = (url) => views.isViewUrl(url);
  protocol.handle(APP_SCHEME, (req) => {
    const r = views.respond(req.method, req.url);
    return new Response(r.body, { status: r.status, headers: r.headers });
  });
}

export function hardenContents(contents: WebContents) {
  contents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  // Frames: a view loads at its own address and goes nowhere else (no link, form, script or redirect moves it).
  contents.on("will-frame-navigate", (details) => {
    if (!details.isMainFrame && !isViewUrl(details.url)) details.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  // Nothing opens through window.open, from the page or any frame: the handler can't tell which frame asked (a view
  // sends no referrer, and neither do the page's own links), so it opens nothing. Links in answers go through the
  // link:open channel, which only our own page can call; a view asks with ui/open-link, which shows you the host.
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  // No WebRTC over UDP outside a proxy (there is none), so no ICE candidate gathering can reach the network from the
  // page or a view, whatever a view's script does with RTCPeerConnection.
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
}

/**
 * Blink's settings for every page and frame. DNS prefetching off: `<link rel="dns-prefetch">` isn't under CSP, and
 * `X-DNS-Prefetch-Control: off` stops only the automatic prefetch of anchors, so a view's script could spell data into
 * host names and have them resolved, a way out with no request (security review of wave 10 part 2, H1). Only this
 * spelling works in Electron 45: `--dns-prefetch-disable` and `DNSPrefetchingEnabled` change nothing.
 */
export const BLINK_SETTINGS = "dnsPrefetchingEnabled=false";

/** Must run before app is ready. */
export function hardenApp() {
  app.enableSandbox();
  app.commandLine.appendSwitch("blink-settings", BLINK_SETTINGS);
  // Standard and secure so a view's frame gets a real (then sandboxed, so opaque) origin and a secure context; no
  // fetch, CORS, service-worker or stream privileges.
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }]);
  app.on("web-contents-created", (_e, contents) => hardenContents(contents));
}

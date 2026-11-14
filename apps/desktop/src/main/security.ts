// The Electron security baseline. Both Lens forks run their UI with nodeIntegration on, contextIsolation off, no
// sandbox and a CSP with 'unsafe-eval' (docs/research/lens-architecture.md). Landlens runs an AI agent with access to
// clusters, so the renderer gets none of that: sandboxed, isolated, no Node, a strict CSP, no navigation, no new
// windows, no permissions, and it can only call the IPC channels the preload bridge lists.
import { app, protocol, session, shell, type BrowserWindowConstructorOptions, type WebContents } from "electron";
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
  contents.setWindowOpenHandler(({ url, referrer }) => {
    // Links to the web open in the user's browser; nothing opens inside Landlens. A view never opens anything this
    // way (its sandbox has no popups; it asks with ui/open-link, which shows you the host first).
    if (/^https:\/\//.test(url) && !referrer.url.startsWith(`${APP_SCHEME}:`)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

/** Must run before app is ready. */
export function hardenApp() {
  app.enableSandbox();
  // Standard and secure so a view's frame gets a real (then sandboxed, so opaque) origin and a secure context; no
  // fetch, CORS, service-worker or stream privileges.
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }]);
  app.on("web-contents-created", (_e, contents) => hardenContents(contents));
}

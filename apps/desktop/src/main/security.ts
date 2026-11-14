// The Electron security baseline. Both Lens forks run their UI with nodeIntegration on, contextIsolation off, no
// sandbox and a CSP with 'unsafe-eval' (docs/research/lens-architecture.md). Landlens runs an AI agent with access to
// clusters, so the renderer gets none of that: sandboxed, isolated, no Node, a strict CSP, no navigation, no new
// windows, no permissions, and it can only call the IPC channels the preload bridge lists.
import { app, session, shell, type BrowserWindowConstructorOptions, type WebContents } from "electron";

export const DEV_URL = process.env.ELECTRON_RENDERER_URL; // set by electron-vite dev

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

/** The production CSP: only our own files; no eval, no inline scripts, no network. */
export const CSP_PROD =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

/** Dev only: Vite's HMR client and React refresh need the dev server, its websocket and one inline preamble. */
const cspDev = (origin: string) =>
  `default-src 'none'; script-src 'self' ${origin} 'unsafe-inline'; style-src 'self' 'unsafe-inline' ${origin}; ` +
  `img-src 'self' data: ${origin}; font-src 'self' ${origin}; connect-src 'self' ${origin} ${origin.replace(/^http/, "ws")}; ` +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

export function isAppUrl(url: string): boolean {
  if (DEV_URL) return url.startsWith(new URL(DEV_URL).origin + "/");
  return url.startsWith("file://") && url.includes("/out/renderer/");
}

export function hardenSession() {
  const csp = DEV_URL ? cspDev(new URL(DEV_URL).origin) : CSP_PROD;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp] } });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

export function hardenContents(contents: WebContents) {
  contents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    // Links to the web open in the user's browser; nothing opens inside Landlens.
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

/** Must run before app is ready. */
export function hardenApp() {
  app.enableSandbox();
  app.on("web-contents-created", (_e, contents) => hardenContents(contents));
}

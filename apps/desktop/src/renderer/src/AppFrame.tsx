// One MCP App view, inline: main serves its HTML at landlens-app://view/<id> (its own origin, its own CSP), and this
// frames it with sandbox="allow-scripts" only. No allow-same-origin: the view's origin is opaque, so it can't reach
// this page, window.landlens or any storage; no allow-popups, allow-forms or allow-top-navigation. Messages are taken
// only from this frame's own window, and app-host.ts answers them.
import type { McpAppView } from "@landlens/contracts";
import { BUILTIN_MCP_SERVER } from "@landlens/contracts";
import { ChevronDown, CircleX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type ApiError } from "./api";
import { AppHost, irisVariables, MAX_HEIGHT, type HostContext, type ObjectTarget } from "./app-host";
import { Ic } from "./icons";

const light = () => window.matchMedia("(prefers-color-scheme: light)").matches;

function hostContext(width?: number): HostContext {
  const css = getComputedStyle(document.documentElement);
  return {
    theme: light() ? "light" : "dark",
    styles: { variables: irisVariables((n) => css.getPropertyValue(n)) },
    displayMode: "inline",
    availableDisplayModes: ["inline"],
    containerDimensions: { maxHeight: MAX_HEIGHT, ...(width ? { width } : {}) },
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    platform: "desktop",
    userAgent: "Landlens",
  };
}

/**
 * `cap`: show at most this many pixels until "Show all" (the dock caps views so the answer stays near). A view from a
 * server you added sits in a quieter ring with "View from <server>" above it, so it never reads as Landlens's own.
 */
export function AppFrame(props: { call: string; onOpenObject: (t: ObjectTarget) => void; cap?: number }) {
  const [view, setView] = useState<McpAppView>();
  const [error, setError] = useState<string>();
  const [height, setHeight] = useState(140);
  const [ready, setReady] = useState(false);
  const [all, setAll] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const open = useRef(props.onOpenObject);
  open.current = props.onOpenObject;

  useEffect(() => {
    let closed = false;
    let id: string | undefined;
    api.invoke("mcp:app-open", { call: props.call }).then(
      (v) => (closed ? void api.invoke("mcp:app-close", { view: v.view }) : ((id = v.view), setView(v))),
      (e: ApiError) => !closed && setError(e.message),
    );
    return () => {
      closed = true;
      if (id) void api.invoke("mcp:app-close", { view: id }).catch(() => {});
    };
  }, [props.call]);

  useEffect(() => {
    if (!view) return;
    const host = new AppHost(view, {
      post: (m) => frame.current?.contentWindow?.postMessage(m, "*"),
      callTool: (name, args) => api.invoke("mcp:app-call", { view: view.view, name, arguments: args }),
      openLink: (url) => api.invoke("mcp:app-link", { view: view.view, url }).then((r) => r.opened, () => false),
      openObject: (t) => open.current(t),
      resize: (h) => (setHeight(h), setReady(true)),
      // Replayed on the frame element so the app's own handlers see where it came from (a dock, a drawer).
      key: (k) => frame.current?.dispatchEvent(new KeyboardEvent("keydown", { ...k, bubbles: true, cancelable: true })),
      context: () => hostContext(frame.current?.clientWidth),
    });
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      host.receive(e.data);
    };
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onTheme = () => host.contextChanged();
    window.addEventListener("message", onMessage);
    mq.addEventListener("change", onTheme);
    // Shown even if the view never reports a size.
    const t = setTimeout(() => setReady(true), 1500);
    return () => {
      clearTimeout(t);
      window.removeEventListener("message", onMessage);
      mq.removeEventListener("change", onTheme);
      void host.teardown();
    };
  }, [view]);

  if (error) {
    return (
      <div className="app-frame failed" role="note">
        <Ic icon={CircleX} size={13} className="tone-bad" />
        <span>The view couldn't open: {error}</span>
      </div>
    );
  }
  if (!view) return <div className="app-frame"><div className="skel" style={{ height: 96 }} /></div>;
  const clipped = !!props.cap && !all && height > props.cap + 24;
  const third = view.server !== BUILTIN_MCP_SERVER;
  const frameEl = (
    <div className={"app-frame" + (view.prefersBorder ? " bordered" : "") + (ready ? "" : " loading") + (clipped ? " clipped" : "")} style={clipped ? { maxHeight: props.cap } : undefined}>
      <iframe
        ref={frame}
        src={view.url}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title={`${view.server} · ${view.tool.name} view`}
        style={{ height }}
      />
      {clipped ? (
        <div className="app-fade">
          <button className="secondary small" onClick={() => setAll(true)}><Ic icon={ChevronDown} size={13} />Show all</button>
        </div>
      ) : null}
    </div>
  );
  if (!third) return frameEl;
  return (
    <div className="app-third">
      <div className="app-third-cap">View from <b>{view.server}</b></div>
      {frameEl}
    </div>
  );
}

// One MCP App view, inline: main serves its HTML at landlens-app://view/<id> (its own origin, its own CSP), and this
// frames it with sandbox="allow-scripts" only. No allow-same-origin: the view's origin is opaque, so it can't reach
// this page, window.landlens or any storage; no allow-popups, allow-forms or allow-top-navigation. Messages are taken
// only from this frame's own window, and app-host.ts answers them.
import type { McpAppView } from "@landlens/contracts";
import { BUILTIN_MCP_SERVER, VIEWS_MCP_SERVER } from "@landlens/contracts";

/** The one tool a block of a view may call (D204). */
const VIEW_TOOLS: ReadonlySet<string> = new Set(["view_data"]);
import { ChevronDown, CircleX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type ApiError } from "./api";
import { AppHost, irisVariables, MAX_HEIGHT, VIEW_MAX_HEIGHT, type HostContext, type ObjectTarget } from "./app-host";
import { Ic } from "./icons";
import { viewStore } from "./viewStore";

const light = () => window.matchMedia("(prefers-color-scheme: light)").matches;

function hostContext(width?: number, max = MAX_HEIGHT, fixed?: number): HostContext {
  const css = getComputedStyle(document.documentElement);
  return {
    theme: light() ? "light" : "dark",
    styles: { variables: irisVariables((n) => css.getPropertyValue(n)) },
    displayMode: "inline",
    availableDisplayModes: ["inline"],
    containerDimensions: { maxHeight: max, ...(width ? { width } : {}), ...(fixed ? { height: fixed } : {}) },
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    platform: "desktop",
    userAgent: "Landlens",
  };
}

/** A block Claude wrote on the Views page (wave 10, D204): its view, block, the sources it reads, and a fixed height. */
export type BlockFrame = { view: string; block: string; uses: string[]; version: number; fill?: number };

/**
 * `cap`: show at most this many pixels until "Show all" (the dock caps views so the answer stays near). A view from a
 * server you added sits in a quieter ring with "View from <server>" above it, so it never reads as Landlens's own; a
 * block Claude wrote sits in the same ring captioned "Built by Claude" (D204). A block may call only view_data, its
 * data arrives from the page's store, and the objects it opens are checked by main (views:intent).
 */
export function AppFrame(props: { call?: string; block?: BlockFrame; onOpenObject: (t: ObjectTarget) => void; onOpenView?: (id: string) => void; cap?: number }) {
  const b = props.block;
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
    const opened = b ? api.invoke("views:app-open", { view: b.view, block: b.block }) : api.invoke("mcp:app-open", { call: props.call ?? "" });
    opened.then(
      (v) => (closed ? void api.invoke("mcp:app-close", { view: v.view }) : ((id = v.view), setView(v))),
      (e: ApiError) => !closed && setError(e.message),
    );
    return () => {
      closed = true;
      if (id) void api.invoke("mcp:app-close", { view: id }).catch(() => {});
    };
  }, [props.call, b?.view, b?.block, b?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!view) return;
    const host = new AppHost(view, {
      post: (m) => frame.current?.contentWindow?.postMessage(m, "*"),
      callTool: (name, args) => (b ? api.invoke("views:app-call", { frame: view.view, name, arguments: args }) : api.invoke("mcp:app-call", { view: view.view, name, arguments: args })),
      openLink: (url) => api.invoke("mcp:app-link", { view: view.view, url }).then((r) => r.opened, () => false),
      // A block opens only what main finds among the view's rows (D219); a tool's view opens what it names.
      openObject: b
        ? async (t) => {
            const r = await api.invoke("views:intent", { frame: view.view, url: `landlens://object/${t.kind}/${t.namespace ?? "_"}/${t.name}` }).catch(() => ({ object: undefined }));
            if (!r.object) return false;
            open.current({ kind: r.object.kind, name: r.object.name, ...(r.object.namespace ? { namespace: r.object.namespace } : {}) });
            return true;
          }
        : (t) => open.current(t),
      ...(props.onOpenView ? { openView: props.onOpenView } : {}),
      ...(b ? { tools: VIEW_TOOLS, maxHeight: VIEW_MAX_HEIGHT } : {}),
      resize: (h) => (b?.fill ? undefined : setHeight(h), setReady(true)),
      // Replayed on the frame element so the app's own handlers see where it came from (a dock, a drawer).
      key: (k) => frame.current?.dispatchEvent(new KeyboardEvent("keydown", { ...k, bubbles: true, cancelable: true })),
      context: () => hostContext(frame.current?.clientWidth, b ? VIEW_MAX_HEIGHT : MAX_HEIGHT, b?.fill),
    });
    // A block's sources, live: what the page's store hears from main, for the sources this block names.
    const offData = b ? viewStore.onData((source, data) => b.uses.includes(source) && host.pushData(source, data)) : () => {};
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
      offData();
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
  const shown = b?.fill ?? height;
  const frameEl = (
    <div className={"app-frame" + (view.prefersBorder ? " bordered" : "") + (ready ? "" : " loading") + (clipped ? " clipped" : "")} style={clipped ? { maxHeight: props.cap } : undefined}>
      <iframe
        ref={frame}
        src={view.url}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title={b ? `Built by Claude: ${b.block}` : `${view.server} · ${view.tool.name} view`}
        style={{ height: shown }}
      />
      {clipped ? (
        <div className="app-fade">
          <button className="secondary small" onClick={() => setAll(true)}><Ic icon={ChevronDown} size={13} />Show all</button>
        </div>
      ) : null}
    </div>
  );
  if (!third) return frameEl;
  // landlens-views' own card in the dock is Landlens's; a block on the Views page is Claude's, and says so.
  if (view.server === VIEWS_MCP_SERVER && !b) return frameEl;
  return (
    <div className={"app-third" + (b ? " built" : "")}>
      <div className="app-third-cap">{b ? <>Built by Claude</> : <>View from <b>{view.server}</b></>}</div>
      {frameEl}
    </div>
  );
}

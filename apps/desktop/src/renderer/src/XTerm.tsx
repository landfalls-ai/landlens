// One terminal on screen: xterm.js bound to a terminal main holds (a pod shell or your local shell). Keys go to main
// as typed; output is written as it comes; the size follows the element and is sent to the other end. The xterm
// outlives one session: "New session" binds the same screen to a new terminal id, so the old output stays above.
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal, type ITheme } from "@xterm/xterm";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { api } from "./api";
import { onTerminalData, onTerminalStatus } from "./streams";
import type { TerminalStatus } from "@landlens/contracts";

/** The terminal's colours from Landlens's tokens (--term-*), so it follows dark and light. */
export function terminalTheme(el: Element): ITheme {
  const css = getComputedStyle(el);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return {
    background: v("--term-bg"), foreground: v("--term-fg"), cursor: v("--term-cursor"), cursorAccent: v("--term-bg"),
    selectionBackground: v("--term-sel"),
    black: v("--term-black"), brightBlack: v("--ink-4"),
    red: v("--term-red"), brightRed: v("--term-red"),
    green: v("--term-green"), brightGreen: v("--term-green"),
    yellow: v("--term-yellow"), brightYellow: v("--term-yellow"),
    blue: v("--term-blue"), brightBlue: v("--term-blue"),
    magenta: v("--term-magenta"), brightMagenta: v("--term-magenta"),
    cyan: v("--term-cyan"), brightCyan: v("--term-cyan"),
    white: v("--term-white"), brightWhite: v("--term-fg"),
  };
}

export type XTermHandle = {
  focus(): void;
  find(text: string, next: boolean): { index: number; count: number } | undefined;
  clearFind(): void;
  /** The selected text, for Copy and "Ask Claude". */
  selection(): string;
  clearSelection(): void;
  /** Paste as if typed (after the person said yes to a multi-line paste). */
  paste(text: string): void;
  /** A dim line in the output, such as the marker before a new session. */
  note(text: string): void;
};

/** Keys the window keeps even while a terminal has focus (D22): ⌘K, ⌘J, ⌘B, ⌘`, ⌘W, ⌘F, ⌘⇧[ and ⌘⇧]. */
const PASS = /^(k|j|b|`|w|f|\[|\]|\{|\}|1|2)$/i;

export const XTerm = forwardRef<XTermHandle, {
  /** The session the screen is bound to; none while one is starting. */
  terminal?: string;
  onStatus: (s: TerminalStatus) => void;
  /** Ended: the output stays, greyed, and keys go nowhere. */
  dead?: boolean;
  /** Shown once, before the first output. */
  banner?: string;
  /** Asked before a paste goes in: return the text to paste now, or false to hold it (the caller pastes later, or not). */
  onPaste?: (text: string) => string | false;
  onSelection?: (text: string) => void;
  /** Each piece of output as it is written (the tab reads the start of a session, to tell "no shell" apart). */
  onOutput?: (text: string) => void;
}>(function XTerm({ terminal, onStatus, dead, banner, onPaste, onSelection, onOutput }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal>(undefined);
  const fit = useRef<FitAddon>(undefined);
  const search = useRef<SearchAddon>(undefined);
  const found = useRef<{ index: number; count: number }>(undefined);
  const cb = useRef({ onStatus, onPaste, onSelection, onOutput });
  cb.current = { onStatus, onPaste, onSelection, onOutput };
  const bound = useRef<string>(undefined);
  bound.current = dead ? undefined : terminal;
  const lastSize = useRef("");

  useImperativeHandle(ref, () => ({
    focus: () => term.current?.focus(),
    find: (text, next) => {
      found.current = undefined;
      const s = search.current;
      if (!s || !text) return undefined;
      const opts = { decorations: { matchOverviewRuler: "#888", activeMatchColorOverviewRuler: "#fff", matchBackground: undefined, activeMatchBackground: undefined } };
      void (next ? s.findNext(text, opts) : s.findPrevious(text, opts));
      return found.current;
    },
    clearFind: () => search.current?.clearDecorations(),
    selection: () => term.current?.getSelection() ?? "",
    clearSelection: () => term.current?.clearSelection(),
    paste: (text) => {
      const t = term.current;
      if (!t || !bound.current) return;
      t.paste(text);
    },
    note: (text) => term.current?.writeln(`\r\n\x1b[2m${text}\x1b[0m`),
  }));

  // The screen: made once.
  useEffect(() => {
    const host = el.current!;
    const t = new Terminal({
      fontFamily: getComputedStyle(host).getPropertyValue("--mono").trim() || "monospace",
      fontSize: 12.5, lineHeight: 1.2, cursorBlink: true, scrollback: 10_000, allowProposedApi: true,
      macOptionIsMeta: true, theme: terminalTheme(host), drawBoldTextInBrightColors: false,
      // OSC 8 links a program prints: https only, opened by main (which shows the host), never xterm's confirm().
      linkHandler: {
        allowNonHttpProtocols: false,
        activate: (_e, uri) => {
          if (/^https:\/\//i.test(uri)) void api.invoke("link:open", { url: uri }).catch(() => {});
        },
      },
    });
    const f = new FitAddon();
    const s = new SearchAddon();
    t.loadAddon(f);
    t.loadAddon(s);
    t.open(host);
    term.current = t;
    fit.current = f;
    search.current = s;
    if (banner) t.writeln(`\x1b[2m${banner}\x1b[0m`);
    const results = s.onDidChangeResults((r) => (found.current = r.resultIndex >= 0 ? { index: r.resultIndex + 1, count: r.resultCount } : { index: 0, count: r.resultCount }));
    // The window's shortcuts pass through; xterm keeps every other key.
    t.attachCustomKeyEventHandler((e) => !((e.metaKey || e.ctrlKey) && PASS.test(e.key) && (e.metaKey || e.key === "`")));
    const sel = t.onSelectionChange(() => cb.current.onSelection?.(t.getSelection()));
    // A paste is the textarea's paste event: catch it first, so a multi-line paste into a pod can ask.
    // With onPaste (a pod), main pastes what onPaste approves, never the clipboard's raw text.
    const onPasteEvent = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!bound.current) return e.preventDefault(), e.stopImmediatePropagation();
      if (cb.current.onPaste) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const ok = cb.current.onPaste(text);
        if (ok !== false) t.paste(ok);
      }
    };
    host.addEventListener("paste", onPasteEvent, true);
    const input = t.onData((data) => {
      const id = bound.current;
      if (id) void api.invoke("terminal:input", { terminal: id, data }).catch(() => {});
    });
    const resize = () => {
      if (!host.offsetWidth || !host.offsetHeight) return;
      f.fit();
      const id = bound.current;
      const size = `${id}:${t.cols}x${t.rows}`;
      if (!id || size === lastSize.current) return;
      lastSize.current = size;
      void api.invoke("terminal:resize", { terminal: id, cols: t.cols, rows: t.rows }).catch(() => {});
    };
    const ro = new ResizeObserver(() => requestAnimationFrame(resize));
    ro.observe(host);
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const retheme = () => (t.options.theme = terminalTheme(host));
    mq.addEventListener("change", retheme);
    (host as HTMLDivElement & { resizeNow?: () => void }).resizeNow = resize;
    return () => {
      mq.removeEventListener("change", retheme);
      ro.disconnect();
      host.removeEventListener("paste", onPasteEvent, true);
      results.dispose();
      sel.dispose();
      input.dispose();
      t.dispose();
      term.current = undefined;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The session: output in, status out, and its size sent once it is bound.
  useEffect(() => {
    const t = term.current;
    if (!terminal || !t) return;
    // Tell main what has been drawn, in batches, so a container that prints without end waits for the screen.
    let drawn = 0;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    const ack = () => {
      ackTimer = undefined;
      if (drawn) void api.invoke("terminal:ack", { terminal, chars: drawn }).catch(() => {});
      drawn = 0;
    };
    const offData = onTerminalData(terminal, (e) => {
      t.write(e.data, () => {
        drawn += e.data.length;
        if (drawn >= 64 * 1024) ack();
        else ackTimer ??= setTimeout(ack, 50);
      });
      cb.current.onOutput?.(e.data);
    });
    const offStatus = onTerminalStatus(terminal, (s) => cb.current.onStatus(s));
    lastSize.current = "";
    (el.current as HTMLDivElement & { resizeNow?: () => void } | null)?.resizeNow?.();
    return () => {
      offData();
      offStatus();
      if (ackTimer) clearTimeout(ackTimer);
    };
  }, [terminal]);

  useEffect(() => {
    const t = term.current;
    if (!t) return;
    t.options.cursorBlink = !dead;
    t.options.cursorStyle = dead ? "underline" : "block";
    t.options.disableStdin = !!dead;
  }, [dead]);

  return <div className={"xterm-host" + (dead ? " dead" : "")} ref={el} />;
});

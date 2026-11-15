// The YAML editor (D24): CodeMirror 6 in the YAML well, coloured with the --code-* tokens. Lines can carry marks:
// changed (the diff's green edge), bad (a syntax error or the cluster's refusal, with its message beneath) and own
// (another manager owns a field there, amber). ⌘⏎ asks for a review.
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import { foldGutter, foldKeymap, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, WidgetType, type DecorationSet } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export type LineMark = { line: number; kind: "chg" | "bad" | "own"; message?: string };

const highlight = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--code-key)" },
  { tag: [t.string, t.special(t.string), t.content], color: "var(--code-str)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--code-num)" },
  { tag: [t.punctuation, t.separator, t.bracket, t.squareBracket, t.brace, t.operator], color: "var(--code-punct)" },
  { tag: [t.comment, t.lineComment], color: "var(--ink-3)", fontStyle: "italic" },
  { tag: [t.meta, t.labelName, t.typeName], color: "var(--ink-2)" },
]);

const theme = EditorView.theme({
  "&": { color: "var(--ink)", backgroundColor: "transparent", fontSize: "12px", height: "100%" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--accent)", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "1.5px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--term-sel) !important" },
  // Opaque, so text scrolled sideways doesn't show through the line numbers.
  ".cm-gutters": { backgroundColor: "var(--bg-0)", color: "var(--ink-4)", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink-2)" },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--bg-1)", border: "none", color: "var(--ink-3)" },
  ".cm-searchMatch": { backgroundColor: "var(--find)" },
  ".cm-searchMatch-selected": { backgroundColor: "var(--find-cur)", color: "#fff" },
  ".cm-panels": { backgroundColor: "var(--bg-2)", color: "var(--ink)" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--line)" },
  ".cm-textfield": { backgroundColor: "var(--bg-1)", border: "1px solid var(--line-2)", borderRadius: "4px", color: "var(--ink)" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--bg-3)", border: "1px solid var(--line-2)", borderRadius: "4px", color: "var(--ink)" },
}, { dark: true });

class Message extends WidgetType {
  constructor(readonly kind: "bad" | "own", readonly text: string) {
    super();
  }
  eq(o: Message) {
    return o.kind === this.kind && o.text === this.text;
  }
  toDOM() {
    const d = document.createElement("div");
    d.className = `cm-msg ${this.kind}`;
    d.setAttribute("role", this.kind === "bad" ? "alert" : "note");
    d.textContent = this.text;
    return d;
  }
}

const setMarks = StateEffect.define<LineMark[]>();
const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setMarks)) deco = build(tr.state, e.value);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function build(state: EditorState, marks: LineMark[]): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const sorted = [...marks].filter((m) => m.line >= 1 && m.line <= state.doc.lines).sort((a, c) => a.line - c.line || order(a) - order(c));
  for (const m of sorted) {
    const l = state.doc.line(m.line);
    b.add(l.from, l.from, Decoration.line({ class: `cm-l-${m.kind}` }));
  }
  // Messages go under their line, after the line decorations at the same position.
  for (const m of sorted) {
    if (!m.message || m.kind === "chg") continue;
    const l = state.doc.line(m.line);
    b.add(l.to, l.to, Decoration.widget({ widget: new Message(m.kind, m.message), block: true, side: 1 }));
  }
  return b.finish();
}
const order = (m: LineMark) => (m.kind === "chg" ? 0 : m.kind === "own" ? 1 : 2);

export type CodeEditorHandle = { focus(): void; value(): string; goTo(line: number): void };

export const CodeEditor = forwardRef<CodeEditorHandle, {
  value: string;
  onChange: (text: string) => void;
  marks: LineMark[];
  onSubmit?: () => void;
  onEscape?: () => void;
  label: string;
  readOnly?: boolean;
}>(function CodeEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(undefined);
  const cb = useRef(props);
  cb.current = props;

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    value: () => view.current?.state.doc.toString() ?? "",
    goTo: (line) => {
      const v = view.current;
      if (!v || line < 1 || line > v.state.doc.lines) return;
      const l = v.state.doc.line(line);
      v.dispatch({ selection: { anchor: l.from }, scrollIntoView: true });
      v.focus();
    },
  }));

  useEffect(() => {
    const extensions: Extension[] = [
      // Control and format characters (a bidi override, zero-width) show as marks, never act on the text around them.
      highlightSpecialChars(),
      lineNumbers(), foldGutter(), highlightActiveLine(), highlightActiveLineGutter(), history(), indentOnInput(),
      search({ top: false }), highlightSelectionMatches(),
      yaml(), syntaxHighlighting(highlight), theme, marksField,
      EditorState.tabSize.of(2),
      // The drawer is narrow: long values wrap instead of scrolling sideways.
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": props.label }),
      keymap.of([
        { key: "Mod-Enter", run: () => (cb.current.onSubmit?.(), true) },
        { key: "Escape", run: () => (cb.current.onEscape ? (cb.current.onEscape(), true) : false) },
        ...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) cb.current.onChange(u.state.doc.toString());
      }),
      ...(props.readOnly ? [EditorState.readOnly.of(true)] : []),
    ];
    const v = new EditorView({ parent: host.current!, state: EditorState.create({ doc: props.value, extensions }) });
    view.current = v;
    v.dispatch({ effects: setMarks.of(props.marks) });
    return () => v.destroy();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A new value from outside (Discard, a reload) replaces the text.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== props.value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value } });
  }, [props.value]);

  useEffect(() => {
    view.current?.dispatch({ effects: setMarks.of(props.marks) });
  }, [props.marks]);

  return <div className="cm-host" ref={host} />;
});

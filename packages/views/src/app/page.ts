/// <reference path="../raw.d.ts" />
// An app block's document (D204): Landlens's base.css and runtime, then Claude's fragment. Claude writes the body's
// markup, a stylesheet and a script; Landlens writes everything around them. `</script` and `</style` inside Claude's
// text are escaped so neither can end its element early. What the frame may do is the CSP's and the sandbox's to say
// (main's viewCsp with no origins: connect-src 'none'); the refused tags are only a courtesy to Claude.
import css from "./base.css?raw";
import card from "./card.js?raw";
import runtime from "./runtime.js?raw";

const inlineScript = (js: string) => js.replace(/<\/(script)/gi, "<\\/$1");
const inlineStyle = (s: string) => s.replace(/<\/(style)/gi, "<\\/$1");
const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type Fragment = { html: string; css?: string; js?: string };

/** The whole HTML of one block: base, Claude's css, Claude's html in #app, the runtime, Claude's js. */
export function blockPage(title: string, f: Fragment): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="dark light">',
    `<title>${escapeText(title)}</title>`,
    `<style>${inlineStyle(css)}</style>`,
    f.css ? `<style>${inlineStyle(f.css)}</style>` : "",
    `</head><body><div id="app">${f.html}</div>`,
    `<script>${inlineScript(runtime)}</script>`,
    f.js ? `<script>${inlineScript(f.js)}</script>` : "",
    "</body></html>",
  ].filter(Boolean).join("\n");
}

export const VIEW_CARD_URI = "ui://landlens-views/card";
/** The dock's card for render_view and patch_view: Landlens's own, written with the same runtime. */
export const VIEW_CARD_HTML = blockPage("View", { html: '<div class="dim card">Building the view…</div>', js: card });
/** A block's resource URI (D204): ui://landlens-views/<view>/<block>. */
export const blockUri = (view: string, block: string) => `ui://landlens-views/${view}/${block}`;

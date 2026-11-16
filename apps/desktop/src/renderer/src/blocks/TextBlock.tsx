// A view's text (wave 10 part 3, D220): Claude's own words through the dock's Markdown, which builds React elements
// from text (never HTML) and shows each link's host beside it. A link opens only through main's link dialog, as a
// frame's does: main finds the address among the block's own links, shows it whole (at most 500 characters, its query
// said) and opens it on the person's Open (security review of part 3, L4).
import { api } from "../api";
import { LinkOpener, Markdown } from "../Markdown";
import type { BlockDoc } from "../viewBlocks";

export function TextBlock({ view, block, b }: { view: string; block: string; b: BlockDoc }) {
  return (
    <div className="vb-md">
      <LinkOpener.Provider value={(url) => void api.invoke("views:link", { view, block, url }).catch(() => {})}>
        <Markdown text={b.markdown ?? ""} />
      </LinkOpener.Provider>
    </div>
  );
}

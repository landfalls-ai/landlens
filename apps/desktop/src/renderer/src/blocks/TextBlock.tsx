// A view's text (wave 10 part 3, D220): Claude's own words through the dock's Markdown, which builds React elements
// from text (never HTML), shows each link's host beside it and opens it through link:open (https only), as a link in
// Claude's answer does today.
import { Markdown } from "../Markdown";
import type { BlockDoc } from "../viewBlocks";

export function TextBlock({ b }: { b: BlockDoc }) {
  return <div className="vb-md"><Markdown text={b.markdown ?? ""} /></div>;
}

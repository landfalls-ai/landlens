// Enough Markdown for an agent's answers: paragraphs, headings, lists, tables, code blocks, inline code, bold,
// italics and links. It builds React elements from text, never HTML, so nothing the agent writes can run in the page.
import { Check, Copy } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { api } from "./api";
import { Ic } from "./icons";
import { parseTable, TABLE_MAX, tableStarts, type MdTable } from "./mdTable";
import { copyText } from "./present";

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*```(\S*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence
      blocks.push(<CodeBlock key={key++} lang={fence[1]} code={body.join("\n")} />);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const table = parseTable(lines, i);
    if (table) {
      blocks.push(<Table key={key++} t={table} />);
      i = table.end;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(<p key={key++} className="md-h">{inline(heading[2]!)}</p>);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i]!)) {
        let item = lines[i]!.replace(/^\s*([-*]|\d+[.)])\s+/, "");
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i]!)) item += " " + lines[i++]!.trim();
        items.push(item);
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(<List key={key++} className="md-list">{items.map((it, j) => <li key={j}>{inline(it)}</li>)}</List>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^\s*```/.test(lines[i]!) && !/^(#{1,4})\s/.test(lines[i]!) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i]!) && !tableStarts(lines, i)) {
      para.push(lines[i++]!);
    }
    blocks.push(<p key={key++}>{inline(para.join(" "))}</p>);
  }
  return <div className="md">{blocks}</div>;
}

/** A table: scrolls sideways inside the dock; cells use the inline rules, so they stay text. */
function Table({ t }: { t: MdTable }) {
  const cols = Math.min(t.head.length, TABLE_MAX.cols);
  const rows = t.rows.slice(0, TABLE_MAX.rows);
  const style = (j: number) => (t.align[j] ? { textAlign: t.align[j] } : undefined);
  const hidden = [t.rows.length > rows.length ? `${t.rows.length - rows.length} more rows` : "", t.head.length > cols ? `${t.head.length - cols} more columns` : ""].filter(Boolean);
  return (
    <div className="md-table-wrap" tabIndex={0} role="region" aria-label="Table">
      <table className="md-table">
        <thead><tr>{t.head.slice(0, cols).map((h, j) => <th key={j} scope="col" style={style(j)}>{inline(h)}</th>)}</tr></thead>
        <tbody>{rows.map((r, k) => <tr key={k}>{r.slice(0, cols).map((c, j) => <td key={j} style={style(j)}>{inline(c)}</td>)}</tr>)}</tbody>
      </table>
      {hidden.length ? <p className="md-table-more">{hidden.join(" and ")} not shown</p> : null}
    </div>
  );
}

/** A fenced block: horizontal scroll, and a Copy button on hover. */
function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-pre">
      <pre className="md-code" data-lang={lang || undefined}><code>{code}</code></pre>
      <button
        type="button"
        className="secondary md-copy"
        aria-label="Copy code"
        onClick={() => void copyText(code).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        })}
      ><Ic icon={copied ? Check : Copy} size={12} />{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

/** `code`, **bold**, *italic*, [text](https://…) */
function inline(s: string): ReactNode {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https:\/\/[^)\s]+)\))/g;
  let last = 0;
  let k = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(s)); ) {
    if (m.index > last) out.push(<Fragment key={k++}>{s.slice(last, m.index)}</Fragment>);
    const t = m[0];
    if (m[1]) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    else if (m[4]) out.push(<Link key={k++} url={m[5]!} text={/^\[([^\]]+)\]/.exec(t)![1]!} />);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(<Fragment key={k++}>{s.slice(last)}</Fragment>);
  return out;
}

/**
 * A link from the agent's answer. Its text could hide where it goes (and a query string could carry what the agent
 * read), so the host is always shown beside it and the whole address is the tooltip.
 */
function Link({ url, text }: { url: string; text: string }) {
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    return <>{text}</>;
  }
  return (
    <>
      {/* Main opens it (link:open, https only); window.open is denied for every frame. */}
      <a
        href={url}
        title={url}
        rel="noreferrer"
        onClick={(e) => {
          e.preventDefault();
          void api.invoke("link:open", { url }).catch(() => {});
        }}
      >
        {text}
      </a>
      {text !== url && text !== host ? <span className="link-host"> ({host})</span> : null}
    </>
  );
}

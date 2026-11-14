// The YAML well: line numbers from a CSS counter and colours from a per-line tokenizer. Each line is a span ending in
// its own newline, so the element's text is still exactly the YAML.
import { Check, Copy, Lock } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Ic } from "./icons";
import { copyText } from "./present";

const KEY = /^(\s*)(- )?((?:"[^"]*"|'[^']*'|[^\s:#'"][^:#]*?)):(?=\s|$)(.*)$/;
const ITEM = /^(\s*)(- )(.*)$/;
const REDACTED = "••••••";

export function Yaml({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  return (
    <div className="yaml-well">
      <button
        className="secondary yaml-copy"
        onClick={() => void copyText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        })}
      >
        <Ic icon={copied ? Check : Copy} size={13} />
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="yaml">{lines.map((l, i) => <Line key={i} text={l} />)}</pre>
    </div>
  );
}

function Line({ text }: { text: string }) {
  const redacted = text.includes(REDACTED);
  return (
    <span className={"l" + (redacted ? " redacted-line" : "")}>
      {redacted ? <Ic icon={Lock} size={10} className="lock" /> : null}
      {yamlTokens(text)}
      {"\n"}
    </span>
  );
}

export function yamlTokens(line: string): ReactNode {
  if (/^\s*#/.test(line)) return <span className="c">{line}</span>;
  const k = KEY.exec(line);
  if (k) {
    return (
      <>
        {k[1]}
        {k[2] ? <span className="p">{k[2]}</span> : null}
        <span className="k">{k[3]}</span>
        <span className="p">:</span>
        {value(k[4]!)}
      </>
    );
  }
  const item = ITEM.exec(line);
  if (item) return <>{item[1]}<span className="p">{item[2]}</span>{value(item[3]!)}</>;
  return value(line);
}

function value(v: string): ReactNode {
  if (!v) return null;
  const lead = /^\s*/.exec(v)![0];
  const rest = v.slice(lead.length);
  if (!rest) return v;
  let cls = "s";
  if (rest.includes(REDACTED)) cls = "redacted";
  else if (/^(-?\d+(\.\d+)?|true|false|null|~)$/.test(rest)) cls = "n";
  else if (/^[|>][-+]?$/.test(rest) || /^[[{]\]?[}\]]?$/.test(rest) || rest === "[]" || rest === "{}") cls = "p";
  return <>{lead}<span className={cls}>{rest}</span></>;
}

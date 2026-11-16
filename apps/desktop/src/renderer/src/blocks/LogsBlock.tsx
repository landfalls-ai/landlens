// A view's log (wave 10 part 3) on the log view's own line rules (logRows.ts): each line made plain (escapes, controls
// and bidi marks out) and coloured by its ANSI codes as LogsView does, failures marked in the bad colour, "Failures
// only" as the document asks and as the person toggles. It follows the end unless the person scrolled up. Text only.
import type { SourceData } from "@landlens/contracts";
import { useEffect, useRef, useState } from "react";
import { ansi, plain } from "../logRows";
import { logLines, type BlockDoc } from "../viewBlocks";

export function LogsBlock({ b, d }: { b: BlockDoc; d: SourceData | undefined }) {
  const [failures, setFailures] = useState(!!b.failuresOnly);
  const box = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const lines = logLines(d?.lines, failures);
  useEffect(() => {
    const el = box.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, d?.at]);
  return (
    <div className="vb-logs-wrap">
      <div className="seg vb-logs-seg" role="group" aria-label="Lines">
        <button className={failures ? "" : "on"} aria-pressed={!failures} onClick={() => setFailures(false)}>All</button>
        <button className={failures ? "on" : ""} aria-pressed={failures} onClick={() => setFailures(true)}>Failures only</button>
      </div>
      <div className="vb-loglines" ref={box} role="log" aria-label={b.title ?? "Log"} tabIndex={0}
        onScroll={(e) => (follow.current = e.currentTarget.scrollTop + e.currentTarget.clientHeight >= e.currentTarget.scrollHeight - 8)}>
        {lines.length ? lines.map((l) => (
          <div key={l.n} className={"vb-line" + (l.failure ? " fail" : "")}>
            {ansi(plain(l.text)).map((p, i) => <span key={i} {...(p.cls ? { className: p.cls } : {})}>{p.text}</span>)}
          </div>
        )) : <p className="dim small">{failures ? "No failures in these lines." : "No lines yet."}</p>}
      </div>
    </div>
  );
}

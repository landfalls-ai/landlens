// Recent actions (wave 8, D147): main's log of what you did on this cluster, newest first. One row per apply: the
// action's icon, a sentence built from the row's checked fields, its age and its outcome. A row's object opens on
// click when it still exists. The status bar shows the count since Landlens started.
import type { ActionLogEntry } from "@landlens/contracts";
import { Ban, CircleCheck, CircleDashed, CircleSlash, CircleX, History, LogOut, Pause, Play, RotateCcw, Scale, TriangleAlert, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Ic, type LucideIcon } from "./icons";
import { duration } from "./present";

const STARTED = Date.now();
const ICON: Partial<Record<ActionLogEntry["action"], LucideIcon>> = { scale: Scale, restart: RotateCcw, delete: Trash2, trigger: Play, suspend: Pause, resume: Play, cordon: CircleSlash, uncordon: CircleCheck, drain: LogOut };
const OUTCOME: Record<ActionLogEntry["outcome"], { word: string; tone: string; icon: LucideIcon }> = {
  // Written before the requests went (M3); one that stays so had no answer recorded (Landlens stopped first).
  sent: { word: "Sent", tone: "dim", icon: CircleDashed },
  applied: { word: "Done", tone: "ok", icon: CircleCheck },
  partial: { word: "Partly", tone: "warn", icon: TriangleAlert },
  failed: { word: "Failed", tone: "bad", icon: CircleX },
  conflict: { word: "Changed first", tone: "warn", icon: TriangleAlert },
  cancelled: { word: "Cancelled", tone: "dim", icon: Ban },
  stopped: { word: "Stopped", tone: "warn", icon: Ban },
};

/** The row's sentence, from its fields only. */
export function sentence(e: ActionLogEntry): string {
  const what = e.names.length === 1 ? `${e.kind} ${e.namespace ? `${e.namespace}/` : ""}${e.names[0]}` : `${e.names.length} ${e.kind}s${e.namespace ? ` in ${e.namespace}` : ""}`;
  const verb = { scale: "Scaled", restart: "Restarted", delete: "Deleted", trigger: "Ran", suspend: "Suspended", resume: "Resumed", cordon: "Cordoned", uncordon: "Uncordoned", drain: "Drained", reveal: "Revealed a key of", copy: "Copied a key of" }[e.action];
  return `${verb} ${what}${e.detail ? ` · ${e.detail}` : ""}`;
}

/** The log for this cluster (its context and API server, L7), read again whenever `version` moves. */
export function useActionLog(handle: string, version: number) {
  const [entries, setEntries] = useState<ActionLogEntry[]>([]);
  const read = useCallback(() => {
    void api.invoke("action:log", { handle, limit: 200 }).then((r) => setEntries(r.entries), () => {});
  }, [handle]);
  useEffect(read, [read, version]);
  return { entries, since: entries.filter((e) => Date.parse(e.at) >= STARTED).length };
}

export function RecentActions({ entries, onOpen, onClose }: { entries: ActionLogEntry[]; onOpen: (e: ActionLogEntry) => void; onClose: () => void }) {
  const self = useRef<HTMLDivElement>(null);
  const now = Date.now();
  useEffect(() => {
    const close = (e: MouseEvent) => !self.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.(".sb-item.actions") && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key, true);
    self.current?.querySelector<HTMLElement>("button, [tabindex='0']")?.focus();
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key, true);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={self} className="pop recent-actions" role="dialog" aria-label="Recent actions">
      <header className="recent-head">
        <Ic icon={History} size={14} className="dim" />
        <strong className="grow">Recent actions</strong>
        <button className="icon-btn sm" aria-label="Close" onClick={onClose}><Ic icon={X} size={13} /></button>
      </header>
      {entries.length ? (
        <ul className="recent-list">
          {entries.map((e) => {
            const o = OUTCOME[e.outcome];
            // A row opens its own kind (group and resource, L8); an older row without them doesn't open.
            const one = e.names.length === 1 && e.action !== "delete" && e.resource !== undefined;
            return (
              <li key={e.id}>
                <button className="recent-row" disabled={!one} onClick={() => (onOpen(e), onClose())} title={one ? "Open it" : undefined}>
                  <Ic icon={ICON[e.action] ?? History} size={14} className="dim" />
                  <span className="recent-text">{sentence(e)}</span>
                  <span className="recent-age mono">{duration(now - Date.parse(e.at))}</span>
                  <span className={`recent-outcome tone-${o.tone}`}><Ic icon={o.icon} size={12} />{o.word}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="small dim recent-empty">Nothing yet. What you scale, restart, delete or run from Landlens shows here.</p>
      )}
      <p className="small dim recent-foot">Your own actions on this cluster, kept on this computer. Claude's changes stay in its sessions.</p>
    </div>
  );
}

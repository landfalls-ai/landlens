// A GitHub or Linear write's arguments as the dock's ask card shows them (D84; M5 of the part 3 review): a short
// table first, and every argument behind "Show all arguments", so nothing you approve is hidden. What the table
// cuts says how much it cut. Pure, so tests can read it without a window.
import { redactText } from "@landlens/kube/redact";

export type ArgRow = { label: string; value: string; body?: boolean };

/** The body's first characters in the table; the rest is counted, and whole under Show all arguments. */
export const BODY_SHOWN = 600;
/** File paths listed in the table before "and N more". */
export const FILES_SHOWN = 20;
/** Other arguments listed in the table before "and N more". */
export const OTHERS_SHOWN = 12;

const scalar = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const n = (x: number) => x.toLocaleString("en-US");

/** A string cut to `max`, saying how many characters were left out. */
export function cutSaying(v: string, max: number): string {
  return v.length > max ? `${v.slice(0, max)}… (+${n(v.length - max)} more characters)` : v;
}

/** Any value in one line: a scalar as itself, anything else as compact JSON; cut to `max`, saying so. */
function oneLine(v: unknown, max: number): string {
  let s: string;
  if (scalar(v)) s = String(v);
  else {
    try {
      s = JSON.stringify(v) ?? String(v);
    } catch {
      s = String(v);
    }
  }
  return cutSaying(redactText(s), max);
}

/** The table's rows, in a fixed order: where, which, branches, title, files, body, then every other argument. */
export function providerArgRows(args: unknown): ArgRow[] {
  const a = (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  const rows: ArgRow[] = [];
  const used = new Set<string>();
  const take = (label: string, keys: string[], show: (v: unknown) => string | undefined = (v) => oneLine(v, 200)) => {
    for (const k of keys) {
      if (a[k] === undefined || used.has(k)) continue;
      const v = show(a[k]);
      used.add(k);
      if (v !== undefined) return void rows.push({ label, value: v });
    }
  };
  if (typeof a.owner === "string" && typeof a.repo === "string") {
    rows.push({ label: "Repository", value: oneLine(`${a.owner}/${a.repo}`, 200) });
    used.add("owner").add("repo");
  }
  take("Team", ["team", "teamId", "teamKey"]);
  take("Issue", ["issue_number", "issueId"]);
  take("Pull request", ["pullNumber", "pull_number"]);
  take("Id", ["id", "comment_id", "commentId"]);
  take("Method", ["method"]);
  // A pull request goes from its head into its base; a new branch starts from from_branch.
  take("Branch", ["branch"]);
  take("From", ["head", "from_branch"]);
  take("Into", ["base"]);
  take("Title", ["title", "name"]);
  take("File", ["path"]);
  take("Files", ["files"], (v) => {
    if (!Array.isArray(v)) return undefined;
    const paths = v.map((f) => (f && typeof f === "object" ? oneLine((f as { path?: unknown }).path ?? "?", 200) : "?"));
    const shown = paths.slice(0, FILES_SHOWN).join(", ");
    return `${v.length}: ${shown}${paths.length > FILES_SHOWN ? `, and ${n(paths.length - FILES_SHOWN)} more` : ""}`;
  });
  take("Body", ["body", "description", "content", "message"], (v) => (typeof v === "string" ? cutSaying(redactText(v), BODY_SHOWN) : undefined));
  if (rows.at(-1)?.label === "Body") rows.at(-1)!.body = true;
  const others = Object.entries(a).filter(([k, v]) => !used.has(k) && v !== undefined);
  for (const [k, v] of others.slice(0, OTHERS_SHOWN)) rows.push({ label: k, value: oneLine(v, 160) });
  if (others.length > OTHERS_SHOWN) rows.push({ label: "More", value: `${n(others.length - OTHERS_SHOWN)} more arguments, under Show all arguments` });
  return rows;
}

/** Every argument, whole, as indented JSON, with credentials cut as the call log cuts them. */
export function providerArgsJson(args: unknown): string {
  try {
    return redactText(JSON.stringify(args ?? {}, null, 2));
  } catch {
    return "(arguments that aren't JSON)";
  }
}

// What Claude may see of a Google Cloud resource (D93, D94): the resource's own JSON (versionedResources) can hold
// secrets in plain sight: a VM's startup script in metadata.items, Cloud Run and Cloud Functions environment values,
// build variables, keys and tokens pasted into a description. Before any of it reaches the agent (a landlens-gcp tool's
// answer, or Ask Claude's brief) it goes through here:
//
// 1. Values that are configuration by position lose their value: env[].value, metadata.items[].value, and the
//    map-shaped environments (environmentVariables, buildEnvironmentVariables, secretEnvironmentVariables).
// 2. Keys whose name says secret (the Helm rule's words: password, token, apiKey, DB_PASSWORD, …) lose their value.
// 3. Every string: credential shapes replaced (redactText, Google's ya29., AIza…, 1//…, GOCSPX-… included), control
//    and format characters (bidi overrides, zero-width) removed, and capped.
import { hideSecrets, maskLiterals, redactObject, redactText } from "@landlens/kube";
import { stringify } from "yaml";
import type { GcpResource } from "@landlens/contracts";
import { clean } from "./assets.js";

const HIDDEN = "<redacted>";
/** Environments kept as maps by Google's APIs (Cloud Functions, Cloud Build, App Engine). */
const ENV_MAPS = new Set(["environmentVariables", "buildEnvironmentVariables", "secretEnvironmentVariables", "envVariables", "env_variables"]);
const LONGEST = 4096;

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Values by position: env[].value, metadata.items[].value, and env maps' values. */
function dropPositional(node: unknown, key?: string): unknown {
  if (Array.isArray(node)) return node.slice(0, 5000).map((x) => dropPositional(x));
  if (!isPlain(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "__proto__") continue;
    if (ENV_MAPS.has(k) && isPlain(v)) out[k] = Object.fromEntries(Object.keys(v).map((n) => [n, HIDDEN]));
    else if ((k === "env" || (k === "items" && key === "metadata")) && Array.isArray(v)) {
      out[k] = v.slice(0, 5000).map((e) => (isPlain(e) && "value" in e ? { ...(dropPositional(e) as Record<string, unknown>), value: HIDDEN } : dropPositional(e)));
    } else out[k] = dropPositional(v, k);
  }
  return out;
}

function cleanStrings(node: unknown): unknown {
  if (typeof node === "string") return clean(node, LONGEST + 64);
  if (Array.isArray(node)) return node.map(cleanStrings);
  if (isPlain(node)) return Object.fromEntries(Object.entries(node).map(([k, v]) => [clean(k, 200), cleanStrings(v)]));
  return node;
}

/** A resource's own JSON as the agent may see it, with what was hidden as literals to mask anywhere else. */
export function scrubResource(input: unknown): { value: unknown; literals: string[] } {
  const positional = dropPositional(input);
  const hidden = hideSecrets(positional);
  return { value: cleanStrings(redactObject(hidden.value)), literals: hidden.literals };
}

/** The resource's JSON (as gcp:resource read it) scrubbed, as YAML, cut at `max` characters. */
export function resourceYaml(json: string | undefined, max: number): { text: string; cut: boolean } {
  if (!json) return { text: "", cut: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // Cut at 256 KB in main, so it may not parse: what is there is scrubbed as text.
    const t = redactText(clean(json, max + 64));
    return t.length > max ? { text: t.slice(0, max), cut: true } : { text: t, cut: false };
  }
  const s = scrubResource(parsed);
  const text = maskLiterals(redactText(stringify(s.value, { lineWidth: 0 })), s.literals);
  return text.length > max ? { text: `${text.slice(0, max)}\n… (cut at ${max} characters)`, cut: true } : { text, cut: false };
}

/** A search result's fields, one per line, scrubbed (labels are the person's text and may be anything). */
export function resourceLines(r: GcpResource): string[] {
  const f = (s: string | undefined) => (s === undefined ? undefined : redactText(clean(s, 300)));
  const line = (k: string, v: string | undefined) => (v ? [`${k}: ${v}`] : []);
  const labels = r.labels ? Object.entries(r.labels).map(([k, v]) => `${clean(k, 63)}=${redactText(clean(v, 300))}`).join(", ") : "";
  return [
    `Name: ${f(r.name)}`,
    `Type: ${f(r.assetType)}`,
    ...line("Display name", f(r.displayName)),
    ...line("Location", f(r.location)),
    ...line("State", f(r.state)),
    ...line("Created", f(r.createTime)),
    ...line("Updated", f(r.updateTime)),
    ...line("Parent", f(r.parent)),
    ...line("Labels", labels || undefined),
  ];
}

export const BRIEF_MAX = 8_000;

/**
 * What Ask Claude quotes for a resource (D94): its fields, then its own JSON scrubbed as YAML, at most 8,000 characters.
 * The dock quotes it as data, not instructions, and redacts and caps it again.
 */
export function resourceBrief(project: string, r: GcpResource, json?: string): string {
  const head = [`Google Cloud project: ${project}`, ...resourceLines(r)].join("\n");
  const room = BRIEF_MAX - head.length - 40;
  if (!json || room < 200) return head.slice(0, BRIEF_MAX);
  const y = resourceYaml(json, room);
  return `${head}\nIts configuration (secret values hidden):\n${y.text}`.slice(0, BRIEF_MAX);
}

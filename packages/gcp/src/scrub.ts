// What Claude may see of a Google Cloud resource (D93, D94): the resource's own JSON (versionedResources) can hold
// secrets in plain sight: a VM's startup script in metadata.items, Cloud Run and Cloud Functions environment values,
// build variables, keys and tokens pasted into a description. Before any of it reaches the agent (a landlens-gcp tool's
// answer, or Ask Claude's brief) it goes through here:
//
// 1. Values that are configuration by position lose their value: env[].value, metadata.items[].value, the
//    map-shaped environments (environmentVariables, buildEnvironmentVariables, secretEnvironmentVariables), boot
//    scripts kept as maps (GKE's and Dataproc's metadata: startup-script*, user-data, kube-env, configure-sh, …),
//    Google's key material (masterAuth.clientKey, privateKeyData, rawKey, any *KeyData), a scheduled request's body
//    (httpTarget.body, appEngineHttpTarget.body, pubsubTarget.data), and an argument after --password, --token,
//    --secret or --api-key (review of part 5, L5).
// 2. Keys whose name says secret (the Helm rule's words: password, token, apiKey, DB_PASSWORD, …) lose their value.
// 3. Every string: credential shapes replaced (redactText, Google's ya29., AIza…, 1//…, GOCSPX-… included), control
//    and format characters (bidi overrides, zero-width) removed, and capped.
//
// It works on the parsed object, never on cut JSON text: main reads the whole resource, scrubs it here, and only then
// cuts what it gives (review of part 5, M1: cut text didn't parse, and the positional rules were skipped).
import { hideSecrets, maskLiterals, redactObject, redactText } from "@landlens/kube";
import { stringify } from "yaml";
import type { GcpResource } from "@landlens/contracts";
import { clean } from "./assets.js";

const HIDDEN = "<redacted>";
/** Environments kept as maps by Google's APIs (Cloud Functions, Cloud Build, App Engine). */
const ENV_MAPS = new Set(["environmentVariables", "buildEnvironmentVariables", "secretEnvironmentVariables", "envVariables", "env_variables"]);
const LONGEST = 4096;
/** Boot scripts and bootstrap configuration kept as a map's keys (GKE node pools, Dataproc, instance templates). */
const SCRIPT_KEY = /^(?:startup-script.*|shutdown-script.*|windows-startup-script.*|windows-shutdown-script.*|sysprep-specialize-script.*|user-data|kube-env|configure-sh)$/i;
/** Google's key material by name: a cluster's client key, a service account key's private key, a KMS raw key. */
const KEY_MATERIAL = /^(?:clientKey|privateKey|privateKeyData|[A-Za-z]*KeyData|rawKey|keyMaterial)$/;
/** A scheduled request's payload (Cloud Scheduler, Cloud Tasks): base64 text that may carry anything. */
const PAYLOADS: Record<string, string> = { httpTarget: "body", appEngineHttpTarget: "body", appEngineHttpRequest: "body", httpRequest: "body", pubsubTarget: "data" };
/** A flag whose next argument is a secret: ["--token", "s3cr3t"]; "--token=s3cr3t" loses what follows "=". */
const SECRET_FLAG = /^--?(?:password|passwd|token|secret|api-?key|apikey|access-?token|client-?secret)$/i;
const SECRET_FLAG_EQ = /^(--?(?:password|passwd|token|secret|api-?key|apikey|access-?token|client-?secret)=).+$/i;

/** A list of arguments with each secret after its flag hidden. */
function hideFlagged(list: unknown[]): unknown[] {
  return list.map((x, i) => {
    const prev = list[i - 1];
    if (typeof prev === "string" && SECRET_FLAG.test(prev) && (typeof x === "string" || typeof x === "number")) return HIDDEN;
    if (typeof x === "string" && SECRET_FLAG_EQ.test(x)) return x.replace(SECRET_FLAG_EQ, `$1${HIDDEN}`);
    return x;
  });
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Values by position: env[].value, metadata.items[].value, and env maps' values. */
function dropPositional(node: unknown, key?: string): unknown {
  if (Array.isArray(node)) return hideFlagged(node.slice(0, 5000)).map((x) => dropPositional(x));
  if (!isPlain(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "__proto__") continue;
    if (SCRIPT_KEY.test(k) && v !== null && typeof v !== "object") out[k] = HIDDEN;
    else if (KEY_MATERIAL.test(k) && v !== null && v !== undefined && v !== "") out[k] = HIDDEN;
    else if (key !== undefined && PAYLOADS[key] === k && v !== null && v !== undefined) out[k] = HIDDEN;
    else if (ENV_MAPS.has(k) && isPlain(v)) out[k] = Object.fromEntries(Object.keys(v).map((n) => [n, HIDDEN]));
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

/**
 * The resource's own configuration (the parsed object getResource read, whole) scrubbed, as YAML, cut at `max`
 * characters. Only the object: never JSON text, which may have been cut and would skip the rules above (M1).
 */
export function resourceYaml(config: unknown, max: number): { text: string; cut: boolean } {
  if (config === undefined || config === null || typeof config !== "object") return { text: "", cut: false };
  const s = scrubResource(config);
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
export function resourceBrief(project: string, r: GcpResource, config?: unknown): string {
  const head = [`Google Cloud project: ${project}`, ...resourceLines(r)].join("\n");
  const room = BRIEF_MAX - head.length - 40;
  if (config === undefined || room < 200) return head.slice(0, BRIEF_MAX);
  const y = resourceYaml(config, room);
  if (!y.text) return head.slice(0, BRIEF_MAX);
  return `${head}\nIts configuration (secret values hidden):\n${y.text}`.slice(0, BRIEF_MAX);
}

// What the agent may see of a Kubernetes object, applied in two places: the front door scrubs every response to an
// agent token (so the agent's own kubectl gets the same treatment), and the MCP tools scrub what they print.
// The rules follow landfall-cluster-agent (README, "What leaves the cluster"): strip managedFields and
// last-applied-configuration, never env[].value, cap every string and the whole result, then scrub what looks like a
// credential. Secrets never get here: the agent's front-door token can't read them, and their data is dropped anyway.

export const MAX_STRING = 4096;
export const MAX_RESULT = 200_000;

/** Credential-shaped text, after the redactors Landfall and gitleaks use (a pinned subset; see docs/agent.md). */
const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<redacted private key>"],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, "<redacted auth header>"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<redacted jwt>"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<redacted aws key id>"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "<redacted github token>"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "<redacted github token>"],
  [/\blin_(?:api|oauth|refresh)_[A-Za-z0-9]{20,}/g, "<redacted linear key>"],
  [/\bya29\.[A-Za-z0-9._-]{20,}/g, "<redacted google token>"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "<redacted slack token>"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, "<redacted api key>"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "<redacted gitlab token>"],
  // A scheme is at most 32 characters, so a long run of letters and dots isn't tried from every position (quadratic).
  [/(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]{1,256}:)[^\s@/]{1,256}@/gi, "$1<redacted>@"], // password in a URL
  [/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)(?!<(?:hidden|redacted))[^\s"',}]{6,}/gi, "$1<redacted>"],
];

export function redactText(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

const CAPPED = /… \(\d+ more characters\)$/;

function capString(s: string): string {
  // Idempotent: the front door and the MCP tools both scrub what an MCP tool reads.
  return s.length > MAX_STRING && !(s.length <= MAX_STRING + 40 && CAPPED.test(s)) ? `${s.slice(0, MAX_STRING)}… (${s.length - MAX_STRING} more characters)` : s;
}

const KEEP_ANNOTATIONS = new Set([
  "deployment.kubernetes.io/revision",
  "kubernetes.io/change-cause",
]);

/**
 * A copy of the object that is safe to hand to the agent. Works on one object, a List (kubectl get -o yaml), a Table
 * (kubectl get) or a watch event: every embedded object's metadata is scrubbed, not only the top one's.
 */
export function redactObject(input: unknown): unknown {
  const o = structuredClone(input) as any;
  if (!o || typeof o !== "object") return o;
  scrubObjects(o, o.kind === "SecretList");
  stripEnvValues(o);
  return walkStrings(o, (s) => capString(redactText(s)));
}

/** managedFields, last-applied and big annotations off every object; Secret values off every Secret. */
function scrubObjects(node: any, inSecretList: boolean) {
  if (Array.isArray(node)) return node.forEach((n) => scrubObjects(n, inSecretList));
  if (!node || typeof node !== "object") return;
  const m = node.metadata;
  if (m && typeof m === "object" && !Array.isArray(m)) {
    delete m.managedFields;
    const ann = m.annotations;
    if (ann && typeof ann === "object") {
      for (const k of Object.keys(ann)) {
        // last-applied holds the whole object as written, Secret values included; big annotations are noise.
        if (k === "kubectl.kubernetes.io/last-applied-configuration") delete ann[k];
        else if (!KEEP_ANNOTATIONS.has(k) && typeof ann[k] === "string" && ann[k].length > 512) ann[k] = `<${ann[k].length} characters omitted>`;
      }
    }
    if (node.kind === "Secret" || (inSecretList && !node.kind)) {
      for (const f of ["data", "stringData"]) {
        if (node[f] && typeof node[f] === "object") node[f] = Object.fromEntries(Object.keys(node[f]).map((k) => [k, "<redacted>"]));
      }
    }
  }
  for (const [k, v] of Object.entries(node)) if (k !== "metadata") scrubObjects(v, inSecretList || node.kind === "SecretList");
}

/** env[].value of every container template anywhere in the object (pods, workloads, jobs, cronjobs, CRDs). */
function stripEnvValues(node: any) {
  if (Array.isArray(node)) return node.forEach(stripEnvValues);
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node.env)) {
    for (const e of node.env) if (e && typeof e === "object" && "value" in e) e.value = "<redacted>";
  }
  for (const v of Object.values(node)) stripEnvValues(v);
}

function walkStrings(node: any, f: (s: string) => string): any {
  if (typeof node === "string") return f(node);
  if (Array.isArray(node)) return node.map((x) => walkStrings(x, f));
  if (node && typeof node === "object") {
    for (const k of Object.keys(node)) node[k] = walkStrings(node[k], f);
  }
  return node;
}

/** Cap a whole tool result; the agent is told what was cut. */
export function capResult(text: string, limit = MAX_RESULT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… truncated (${text.length - limit} more characters). Narrow the request (namespace, labelSelector, limit, tailLines).`;
}

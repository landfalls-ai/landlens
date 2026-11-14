// What the agent may see of a Kubernetes object. The rules follow landfall-cluster-agent (README, "What leaves the
// cluster"): strip managedFields and last-applied-configuration, never env[].value, cap every string and the whole
// result, then scrub what looks like a credential. Secrets never get here: the agent's front-door token can't read
// them, and their data is dropped below anyway.

export const MAX_STRING = 4096;
export const MAX_RESULT = 200_000;

/** Credential-shaped text, after the redactors Landfall and gitleaks use (a pinned subset; see docs/agent.md). */
const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<redacted private key>"],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, "<redacted auth header>"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<redacted jwt>"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<redacted aws key id>"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, "<redacted github token>"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "<redacted slack token>"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, "<redacted api key>"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "<redacted gitlab token>"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, "$1<redacted>@"], // password in a URL
  [/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi, "$1<redacted>"],
];

export function redactText(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

function capString(s: string): string {
  return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}… (${s.length - MAX_STRING} more characters)` : s;
}

const KEEP_ANNOTATIONS = new Set([
  "deployment.kubernetes.io/revision",
  "kubernetes.io/change-cause",
]);

/** A copy of the object that is safe to hand to the agent. */
export function redactObject(input: unknown): unknown {
  const o = structuredClone(input) as any;
  if (!o || typeof o !== "object") return o;
  if (o.metadata) {
    delete o.metadata.managedFields;
    const ann = o.metadata.annotations as Record<string, string> | undefined;
    if (ann) {
      for (const k of Object.keys(ann)) {
        // last-applied holds the whole object as written, Secret values included; big annotations are noise.
        if (k === "kubectl.kubernetes.io/last-applied-configuration") delete ann[k];
        else if (!KEEP_ANNOTATIONS.has(k) && ann[k]!.length > 512) ann[k] = `<${ann[k]!.length} characters omitted>`;
      }
    }
  }
  if (o.kind === "Secret") {
    for (const f of ["data", "stringData"]) if (o[f]) o[f] = Object.fromEntries(Object.keys(o[f]).map((k) => [k, "<redacted>"]));
  }
  stripEnvValues(o);
  return walkStrings(o, (s) => capString(redactText(s)));
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

// What a failed Google call says (spec D88): one of a fixed set of sentences, made from the HTTP status and the
// error's `status`/`reason` only, never Google's own text (an error body can echo anything, a token included). The
// raw error goes to main's log, with credentials cut (`rawGcpError`).
import { redactText } from "@landlens/kube/redact";

/** The three APIs Landlens reads. */
export type GcpApi = "cloudresourcemanager" | "cloudasset" | "container";

const API_NAME: Record<GcpApi, string> = {
  cloudresourcemanager: "Cloud Resource Manager",
  cloudasset: "Cloud Asset",
  container: "Kubernetes Engine",
};

/** A Google call that failed: `message` is the sentence for the page; `status` the HTTP status (0: no answer). */
export class GcpError extends Error {
  constructor(readonly status: number, message: string, readonly raw = "") {
    super(message);
  }
}

export const SENTENCES = {
  signIn: "Google didn't accept gcloud's sign-in. Run `gcloud auth login`.",
  limited: "Google is limiting requests. Try again in a minute.",
  timeout: "Google didn't answer in time.",
  dns: "Google's address doesn't resolve. Check your network.",
  tls: "Google's TLS certificate wasn't accepted.",
  unreachable: "Couldn't reach Google.",
  redirect: "Google redirected; Landlens doesn't follow redirects.",
  tooBig: "Google's answer was larger than Landlens reads (8 MB).",
  answer: "Google's answer wasn't what Landlens expected.",
} as const;

/** The sentence for a disabled API in a project, with the command that turns it on. */
export function disabledSentence(api: GcpApi, project?: string): string {
  const where = project ? `in ${project}` : "for the project your requests are billed to";
  return `The ${API_NAME[api]} API is off ${where}. Turn it on: \`gcloud services enable ${api}.googleapis.com --project ${project ?? "<project>"}\`.`;
}

/** The sentence for a 403 that isn't a disabled API: which role the account lacks. */
export function deniedSentence(api: GcpApi, project?: string): string {
  if (api === "cloudasset") return `Your account can't list resources in ${project} (it needs Cloud Asset Viewer).`;
  if (api === "container") return `Your account can't list GKE clusters in ${project} (it needs Kubernetes Engine Cluster Viewer).`;
  return "Your account can't search projects.";
}

/** The `reason`s Google's error body names (google.rpc.ErrorInfo, and the older `errors[]`), as strings only. */
export function reasonsOf(body: unknown): string[] {
  const e = (body as { error?: { status?: unknown; details?: unknown; errors?: unknown } } | undefined)?.error;
  if (!e || typeof e !== "object") return [];
  const out: string[] = [];
  if (typeof e.status === "string") out.push(e.status);
  for (const list of [e.details, e.errors]) {
    if (!Array.isArray(list)) continue;
    for (const d of list) {
      const r = (d as { reason?: unknown } | null)?.reason;
      if (typeof r === "string" && /^[A-Za-z_]{1,64}$/.test(r)) out.push(r);
    }
  }
  return out;
}

/** An HTTP failure as its sentence. `body` is the parsed error body, if any; nothing of it is copied. */
export function httpError(status: number, body: unknown, api: GcpApi, project?: string): GcpError {
  const reasons = reasonsOf(body);
  const raw = `HTTP ${status} ${reasons.join(",")}`;
  if (status === 401) return new GcpError(401, SENTENCES.signIn, raw);
  if (status === 403 && reasons.some((r) => r === "SERVICE_DISABLED" || r === "accessNotConfigured")) return new GcpError(403, disabledSentence(api, project), raw);
  if (status === 403) return new GcpError(403, deniedSentence(api, project), raw);
  if (status === 429 || reasons.includes("RESOURCE_EXHAUSTED") || reasons.includes("RATE_LIMIT_EXCEEDED")) return new GcpError(429, SENTENCES.limited, raw);
  if (status === 404) return new GcpError(404, project ? `Google found nothing for ${project} (404).` : "Google found nothing there (404).", raw);
  return new GcpError(status, `Google answered HTTP ${status}.`, raw);
}

/** A request that got no HTTP answer (time limit, DNS, TLS, refused, a redirect) as its sentence. */
export function networkError(err: unknown): GcpError {
  if (err instanceof GcpError) return err;
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string; name?: string } };
  const all = `${e?.name ?? ""} ${e?.message ?? String(err)} ${e?.cause?.name ?? ""} ${e?.cause?.code ?? ""} ${e?.cause?.message ?? ""}`;
  const raw = rawGcpError(err);
  if (/redirect/i.test(all)) return new GcpError(0, SENTENCES.redirect, raw);
  if (/TimeoutError|AbortError|timed? ?out|ETIMEDOUT/i.test(all)) return new GcpError(0, SENTENCES.timeout, raw);
  if (/ENOTFOUND|EAI_AGAIN/.test(all)) return new GcpError(0, SENTENCES.dns, raw);
  if (/CERT|SSL|TLS|self[- ]signed|certificate/i.test(all)) return new GcpError(0, SENTENCES.tls, raw);
  return new GcpError(0, SENTENCES.unreachable, raw);
}

/** The error's own text, for main's log only: bearers and every credential shape cut, one line, 500 characters. */
export function rawGcpError(err: unknown): string {
  const e = err as { message?: string; raw?: string; cause?: { code?: string; message?: string } };
  const text = err instanceof GcpError ? `${err.message} [${err.raw}]` : `${e?.message ?? String(err)}${e?.cause ? ` (${e.cause.code ?? e.cause.message})` : ""}`;
  return redactText(text.replace(/Bearer\s+\S+/gi, "Bearer …").replace(/ya29\.[A-Za-z0-9._-]+/g, "<redacted google token>")).replace(/\s+/g, " ").slice(0, 500);
}

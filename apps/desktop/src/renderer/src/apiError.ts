// Errors from main as the page sees them. contextBridge copies only an Error's message across, so the preload puts
// `{"status":n,"message":"…"}` in it; this turns that back into an Error with its message and a numeric `status`.
export type ApiError = Error & { status?: number };

export function toApiError(e: unknown): ApiError {
  const text = e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
  const m = /(\{"status":\d+,"message":[\s\S]*\})$/.exec(text);
  if (m) {
    try {
      const p = JSON.parse(m[1]!) as { status?: unknown; message?: unknown };
      if (typeof p.status === "number" && typeof p.message === "string") return Object.assign(new Error(p.message), { status: p.status });
    } catch {
      // not ours: fall through
    }
  }
  return Object.assign(new Error(text), e instanceof Error && typeof (e as ApiError).status === "number" ? { status: (e as ApiError).status } : {});
}

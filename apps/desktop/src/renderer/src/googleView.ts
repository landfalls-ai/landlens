// Google's view of the connected cluster (wave 9, D177–D178, D188): gcp:cluster-view while the Overview or Problems is
// shown, and every 60 s then while the window is visible (main keeps the suggestions 10 minutes and the alerts 60 s, so
// a refresh reads Google only when its time is up). The page names only the handle; main decides whether this is a GKE
// cluster of a chosen project and reads Google. One hook for the workspace, so ⌘K knows it too; not polled otherwise.
// A call that fails replaces the last answer with "couldn't be read" (viewOnError), never leaves it standing; before
// the first answer, a context named as GKE clusters are is `reading` (review of part 3, M1).
import type { GcpClusterView } from "@landlens/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ApiError } from "./api";
import { gkeShaped, latestOnly, startViewPoll, viewOnError } from "./googleRules";

export type GoogleView = { view?: GcpClusterView; error?: ApiError; loading: boolean; reading: boolean; refresh: () => void };

export { VIEW_EVERY } from "./googleRules";

export function useGoogleView(handle: string, active = true, context = ""): GoogleView {
  const [view, setView] = useState<GcpClusterView>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(true);
  const shaped = gkeShaped(context);
  const shapedNow = useRef(shaped);
  shapedNow.current = shaped;
  // One for the hook's life, so a late answer for the previous handle is dropped too (latestOnly).
  const ask = useRef<(handle: string, fresh: boolean) => void>(undefined);
  ask.current ??= latestOnly(
    (h: string, fresh: boolean) => api.invoke("gcp:cluster-view", { handle: h, ...(fresh ? { fresh: true } : {}) }),
    {
      value: (v) => (setView(v), setError(undefined), setLoading(false)),
      error: (e) => {
        const err = e as ApiError;
        setView((prev) => viewOnError(prev, typeof err?.message === "string" ? err.message : "", shapedNow.current));
        setError(err);
        setLoading(false);
      },
    },
  );

  const load = useCallback((fresh: boolean) => {
    setLoading(true);
    ask.current!(handle, fresh);
  }, [handle]);

  useEffect(() => {
    setView(undefined);
    setError(undefined);
  }, [handle]);
  useEffect(() => startViewPoll(active, load, () => document.visibilityState === "visible"), [load, active]);

  const refresh = useCallback(() => load(true), [load]);
  return { ...(view ? { view } : {}), ...(error ? { error } : {}), loading, reading: shaped && !view && !error, refresh };
}

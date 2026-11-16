// Google's view of the connected cluster (wave 9, D177–D178, D188): gcp:cluster-view while the Overview or Problems is
// shown, and every 60 s then while the window is visible (main keeps the suggestions 10 minutes and the alerts 60 s, so
// a refresh reads Google only when its time is up). The page names only the handle; main decides whether this is a GKE
// cluster of a chosen project and reads Google. One hook for the workspace, so ⌘K knows it too; not polled otherwise.
import type { GcpClusterView } from "@landlens/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ApiError } from "./api";
import { latestOnly } from "./googleRules";

export type GoogleView = { view?: GcpClusterView; error?: ApiError; loading: boolean; refresh: () => void };

export const VIEW_EVERY = 60_000;

export function useGoogleView(handle: string, active = true): GoogleView {
  const [view, setView] = useState<GcpClusterView>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(true);
  // One for the hook's life, so a late answer for the previous handle is dropped too (latestOnly).
  const ask = useRef<(handle: string, fresh: boolean) => void>(undefined);
  ask.current ??= latestOnly(
    (h: string, fresh: boolean) => api.invoke("gcp:cluster-view", { handle: h, ...(fresh ? { fresh: true } : {}) }),
    {
      value: (v) => (setView(v), setError(undefined), setLoading(false)),
      error: (e) => (setError(e as ApiError), setLoading(false)),
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
  useEffect(() => {
    if (!active) return;
    load(false);
    const t = setInterval(() => document.visibilityState === "visible" && load(false), VIEW_EVERY);
    return () => clearInterval(t);
  }, [load, active]);

  const refresh = useCallback(() => load(true), [load]);
  return { ...(view ? { view } : {}), ...(error ? { error } : {}), loading, refresh };
}

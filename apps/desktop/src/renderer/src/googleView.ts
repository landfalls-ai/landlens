// Google's view of the connected cluster (wave 9, D177–D178): gcp:cluster-view once per visit and every 10 minutes
// while the window is visible. The page names only the handle; main decides whether this is a GKE cluster of a chosen
// project and reads Google. Shared by the Overview and (from part 3) Problems.
import type { GcpClusterView } from "@landlens/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ApiError } from "./api";
import { latestOnly } from "./googleRules";

export type GoogleView = { view?: GcpClusterView; error?: ApiError; loading: boolean; refresh: () => void };

const EVERY = 10 * 60_000;

export function useGoogleView(handle: string): GoogleView {
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
    load(false);
    const t = setInterval(() => document.visibilityState === "visible" && load(false), EVERY);
    return () => clearInterval(t);
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);
  return { ...(view ? { view } : {}), ...(error ? { error } : {}), loading, refresh };
}

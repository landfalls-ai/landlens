// The cluster's health, polled for the whole workspace: the Overview page, the sidebar badges and the status bar all
// read this one result. Every 10s while the window is visible, and at once when the namespace changes.
import type { ClusterHealth } from "@landlens/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ApiError } from "./api";

export type HealthState = { health?: ClusterHealth; error?: ApiError; loading: boolean; refresh: () => void };

const EVERY = 10_000;

export function useHealth(handle: string, namespace: string): HealthState {
  const [health, setHealth] = useState<ClusterHealth>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const load = useCallback(() => {
    const mine = ++seq.current;
    api.invoke("cluster:health", { handle, ...(namespace ? { namespace } : {}) }).then(
      (h) => {
        if (mine !== seq.current) return;
        setHealth(h);
        setError(undefined);
        setLoading(false);
      },
      (e: ApiError) => {
        if (mine !== seq.current) return;
        setError(e);
        setLoading(false);
      },
    );
  }, [handle, namespace]);

  useEffect(() => {
    setLoading(true);
    setHealth(undefined);
    load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, EVERY);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  return { health, error, loading, refresh: load };
}

export { badgeFor, type Badge } from "./problemRules";

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

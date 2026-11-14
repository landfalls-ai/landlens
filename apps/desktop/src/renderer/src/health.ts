// The cluster's health, polled for the whole workspace: the Overview page, the sidebar badges and the status bar all
// read this one result. Every 10s while the window is visible, and at once when the namespace changes.
import type { ClusterHealth, HealthProblem } from "@landlens/contracts";
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

/** The badge a sidebar item shows: failures in red, else warnings in amber. */
export type Badge = { tone: "bad" | "warn"; n: number };

export function badgeFor(problems: HealthProblem[], kind?: HealthProblem["kind"]): Badge | undefined {
  const mine = kind ? problems.filter((p) => p.kind === kind) : problems;
  const bad = mine.filter((p) => p.tone === "bad").length;
  if (bad) return { tone: "bad", n: bad };
  const warn = mine.length;
  return warn ? { tone: "warn", n: warn } : undefined;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

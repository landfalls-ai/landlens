// The renderer's side of graphs: metrics:series for a scope, every 30s while the window is visible. A new range keeps
// the previous frame (dimmed) until the answer comes; a new scope starts clean.
import type { MetricsRange, MetricsRequest, MetricsSeries } from "@landlens/contracts";
import { useEffect, useRef, useState } from "react";
import { api, type ApiError } from "./api";

export type MetricsState = { data?: MetricsSeries; error?: ApiError; loading: boolean; stale: boolean };
const EVERY = 30_000;

/** `version` changes when the Clickland settings do, so every chart asks again. */
export function useMetrics(req: Omit<MetricsRequest, "range"> | undefined, range: MetricsRange, version: number): MetricsState {
  const scope = req ? JSON.stringify(req) : "";
  const [state, setState] = useState<MetricsState & { scope: string }>({ loading: true, stale: false, scope: "" });
  const seq = useRef(0);
  useEffect(() => {
    if (!req) return;
    setState((s) => (s.scope === scope ? { ...s, stale: true } : { loading: true, stale: false, scope }));
    const load = () => {
      const mine = ++seq.current;
      api.invoke("metrics:series", { ...req, range }).then(
        (data) => mine === seq.current && setState({ data, loading: false, stale: false, scope }),
        (error: ApiError) => mine === seq.current && setState({ error, loading: false, stale: false, scope }),
      );
    };
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), EVERY);
    return () => clearInterval(t);
  }, [scope, range, version]); // eslint-disable-line react-hooks/exhaustive-deps
  return state.scope === scope ? state : { loading: true, stale: false };
}

export const RANGES: MetricsRange[] = ["1h", "6h", "24h"];

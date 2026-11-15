// Whether Landflow's sends can be offered here (wave 7 part 4, D121, D125), shared by every view: the Landflow card's
// state, whether its triage webhook is set up with a secret, and what the key's scopes cover, from family:list and kept
// live from family:update; and the problems of a cluster sent to triage (landflow:sent), for their chips (D124). The
// key and the webhook's secret never come here.
import type { FamilyInfo, LandflowRun, LandflowSent } from "@landlens/contracts";
import { useEffect, useRef, useState } from "react";
import { api, type ApiError } from "./api";

export type LandflowState = { ready: boolean; triage: boolean; flows: boolean; runs: boolean };

let state: LandflowState = { ready: false, triage: false, flows: false, runs: false };
let loaded = false;
const listeners = new Set<(s: LandflowState) => void>();
const put = (i: FamilyInfo) => {
  const ready = i.state === "ready";
  state = { ready, triage: ready && !!i.triage?.hasSecret, flows: ready && !!i.can?.flows && !!i.can?.run, runs: ready && !!i.can?.runs };
  for (const l of listeners) l(state);
};

function load() {
  if (loaded) return;
  loaded = true;
  api.on("family:update", (i: FamilyInfo) => i.sibling === "landflow" && put(i));
  void api.invoke("family:list", {}).then((l) => put(l.landflow), () => (loaded = false));
}

export function useLandflow(): LandflowState {
  const [s, setS] = useState(state);
  useEffect(() => {
    load();
    listeners.add(setS);
    setS(state);
    return () => void listeners.delete(setS);
  }, []);
  return s;
}

/** The problems of one cluster sent to triage, newest send per problem; read again after each send or follow. */
const sent = new Map<string, LandflowSent[]>();
const sentListeners = new Set<() => void>();
export function refreshSent(handle: string) {
  void api.invoke("landflow:sent", { handle }).then((r) => {
    sent.set(handle, r.entries);
    for (const l of sentListeners) l();
  }, () => {});
}

export function useSent(handle: string): Map<string, LandflowSent> {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    sentListeners.add(l);
    refreshSent(handle);
    return () => void sentListeners.delete(l);
  }, [handle]);
  return new Map((sent.get(handle) ?? []).map((e) => [e.problem, e]));
}


/**
 * A send or a run, followed (D122): main is asked every 2 s while it says the run is still going, for at most 60 s;
 * then the person checks again by hand. Each answer replaces the last; nothing else of the run is read.
 */
export function useFollow(first: LandflowRun | undefined, onAnswer?: (r: LandflowRun) => void) {
  const [r, setR] = useState(first);
  const [paused, setPaused] = useState(false);
  const [again, setAgain] = useState(0);
  const now = useRef(false);
  useEffect(() => (setR(first), setPaused(false)), [first]);
  useEffect(() => {
    if (!r?.follow || !r.run || paused) return;
    const run = r.run;
    const started = Date.now();
    let stop = false;
    const tick = () => {
      if (stop) return;
      if (Date.now() - started > FOLLOW_FOR) return setPaused(true);
      void api.invoke("landflow:follow", { run }).then(
        (next) => {
          if (stop) return;
          setR(next);
          onAnswer?.(next);
          if (next.follow) timer = setTimeout(tick, FOLLOW_EVERY);
        },
        (e: ApiError) => !stop && (setR((cur) => cur && { ...cur, note: e.message, tone: "bad", follow: false })),
      );
    };
    let timer = setTimeout(tick, now.current ? 0 : FOLLOW_EVERY);
    now.current = false;
    return () => ((stop = true), clearTimeout(timer));
  }, [r?.run, r?.follow, paused, again]); // eslint-disable-line react-hooks/exhaustive-deps
  return { run: r, paused, checkAgain: () => ((now.current = true), setPaused(false), setAgain((n) => n + 1)) };
}
export const FOLLOW_EVERY = 2000;
export const FOLLOW_FOR = 60_000;

/** The run's page in Landflow, or the room its triage opened, after main's native dialog. */
export const openInLandflow = (run: string, what: "run" | "room") => api.invoke("landflow:open", { run, what }).catch(() => ({ opened: false }));

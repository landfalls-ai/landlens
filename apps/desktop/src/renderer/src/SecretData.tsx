// A Secret's Data section (wave 8 part 4, D166): one row per key, its size, Copy and Reveal. The first press asks main
// to unlock that Secret (main's own dialog); a lock chip then counts the unlock down, with Lock now.
//
// A revealed value is held in one place only: a ref inside that key's SecretValue, written straight into one text node
// of a <pre data-private>. It is never React state or a prop (React keeps old state on its alternate fibers), never in
// Workspace, a context, a store, localStorage, the YAML tab (which stays ••••••) or an error boundary's record. It is
// dropped (the ref emptied, the text node cleared) after 30 s, on Hide, when the window loses focus or is hidden, when
// the drawer closes or changes object or tab (unmount), when the Secret's resourceVersion changes (the row's key), on
// lock and on disconnect; one value is shown at a time. It can't be selected, copied, cut or dragged out of the page:
// Copy goes through main to the clipboard and never brings the value here.
//
// An answer is stored only if its reveal is still the current one (M1 of the security review): each reveal takes a
// ticket, and Hide, the row going (unmount: the drawer closed, another object or tab, a new resourceVersion), a blur
// or a hidden window while main is reading all move it on, so a late answer is dropped, never written to a ref, and
// the module's `hideShown` points only at a mounted row's hide. One reveal or copy at a time a row (L8).
import type { KubeObject, Revealed } from "@landlens/contracts";
import { Copy, Eye, EyeOff, Lock, LockOpen, TriangleAlert } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type ApiError } from "./api";
import { Ic } from "./icons";
import { bytesText, clock, sizeOf, visibleValue } from "./secretText";

/** Seconds a value stays on screen, and the clipboard keeps a copy (main's own timer clears it). */
export const SHOW_MS = 30_000;
const HELM = "helm.sh/release.v1";
/** Main's sentence for a Secret this window hasn't unlocked (secrets.ts SECRET_TEXT.locked). */
const LOCKED = "Unlock this Secret first.";

/**
 * When each Secret's unlock ends, by `handle/namespace/name`, so the chip survives the drawer closing or changing tab:
 * a time, never a value. Main's own record decides; a reveal it refuses as locked clears this and asks again.
 */
const unlockedUntil = new Map<string, number>();

/** The one value on screen: revealing another hides it first. */
let hideShown: (() => void) | undefined;
/** Hide whatever is shown (the drawer's lock, a disconnect). */
export const hideSecretValue = () => hideShown?.();

const canCache = new Map<string, Promise<boolean>>();
/** Whether your role may `get secrets` in the namespace (asked once a minute through cluster:access). */
function useCanGet(handle: string, namespace: string | undefined): boolean | undefined {
  const [can, setCan] = useState<boolean>();
  useEffect(() => {
    if (!namespace) return;
    const key = `${handle}/${namespace}`;
    let p = canCache.get(key);
    if (!p) {
      p = api.invoke("cluster:access", { handle, checks: [{ verb: "get", group: "", resource: "secrets", namespace }] }).then((r) => r.allowed[0] === true, () => true);
      canCache.set(key, p);
      setTimeout(() => canCache.delete(key), 60_000);
    }
    let alive = true;
    void p.then((v) => alive && setCan(v));
    return () => {
      alive = false;
    };
  }, [handle, namespace]);
  return can;
}

export function SecretData({ handle, object }: { handle: string; object: KubeObject }) {
  const ns = object.metadata.namespace ?? "";
  const secret = { namespace: ns, name: object.metadata.name };
  const type = String((object as { type?: unknown }).type ?? "");
  const data = ((object as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
  const keys = Object.keys(data).sort();
  const helm = type === HELM;
  const can = useCanGet(handle, ns || undefined);
  const lockKey = `${handle}/${ns}/${object.metadata.name}`;
  const [until, setUntilState] = useState<number | undefined>(() => unlockedUntil.get(lockKey));
  const setUntil = (t: number | undefined) => {
    if (t === undefined) unlockedUntil.delete(lockKey);
    else unlockedUntil.set(lockKey, t);
    setUntilState(t);
  };
  const [now, setNow] = useState(() => Date.now());
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string>();
  const unlocked = until !== undefined && until > now;

  useEffect(() => {
    if (until === undefined) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  useEffect(() => {
    if (until !== undefined && until <= now) {
      setUntil(undefined);
      hideSecretValue();
    }
  }, [until, now]);

  /** The unlock, asked of main once (its own dialog); true when the Secret is unlocked for this window. */
  const ensure = async (again = false): Promise<boolean> => {
    if (unlocked && !again) return true;
    if (asking) return false;
    setAsking(true);
    setError(undefined);
    try {
      const r = await api.invoke("secret:unlock", { handle, secret });
      setUntil(Date.now() + r.left);
      setNow(Date.now());
      return true;
    } catch (e) {
      const err = e as ApiError;
      if (err.status !== 409) setError(err.message);
      return false;
    } finally {
      setAsking(false);
    }
  };
  const lockNow = () => {
    hideSecretValue();
    setUntil(undefined);
    void api.invoke("secret:lock", { handle, secret }).catch(() => {});
  };

  if (!keys.length) return null;
  const why = can === false ? `Your role can't read Secrets in ${ns}` : undefined;
  return (
    <section className="secret-data" aria-label="Data">
      <div className="secret-head">
        <h3>Data</h3>
        <span className="grow" />
        {unlocked ? (
          <span className="lock-chip" role="status" aria-label={`Unlocked for ${clock(until! - now)}`}>
            <Ic icon={LockOpen} size={12} />Unlocked · <span className="mono">{clock(until! - now)}</span>
            <button className="link-btn" onClick={lockNow}>Lock now</button>
          </span>
        ) : null}
      </div>
      {helm ? <p className="secret-note"><Ic icon={TriangleAlert} size={13} />Helm's release record: open it under Helm.</p> : null}
      {error ? <p className="secret-note bad" role="alert"><Ic icon={TriangleAlert} size={13} />{error}</p> : null}
      <ul className="secret-keys">
        {keys.map((k) => (
          <SecretValue key={`${k}@${object.metadata.resourceVersion ?? ""}`} handle={handle} secret={secret} name={k} size={sizeOf(data[k])}
            helm={helm} why={why} busy={asking} ensure={ensure} unlocked={unlocked} />
        ))}
      </ul>
    </section>
  );
}

type Shown = { kind: Revealed["kind"]; bytes: number; at: number };

function SecretValue(p: {
  handle: string; secret: { namespace: string; name: string }; name: string; size?: number; helm: boolean; why?: string;
  busy: boolean; unlocked: boolean; ensure: (again?: boolean) => Promise<boolean>;
}) {
  const value = useRef<string | undefined>(undefined);
  const pre = useRef<HTMLPreElement>(null);
  const [shown, setShown] = useState<Shown>();
  const [copied, setCopied] = useState<number>();
  const [base64, setBase64] = useState(false);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const hideRef = useRef<() => void>(() => {});
  /** Mounted: an answer for a row that has gone is dropped. */
  const alive = useRef(true);
  /** The reveal in flight: anything that ends it moves this on, and its answer is then dropped. */
  const ticket = useRef(0);
  /** A reveal or copy waiting on main: a second press does nothing (L8). */
  const pending = useRef(false);

  const hide = () => {
    ticket.current++;
    value.current = undefined;
    if (pre.current) pre.current.textContent = "";
    setShown(undefined);
    if (hideShown === hideRef.current) hideShown = undefined;
  };
  hideRef.current = hide;

  // The value goes into the text node after the <pre> is drawn, and nowhere else.
  useLayoutEffect(() => {
    if (shown?.kind === "text" && pre.current) pre.current.textContent = visibleValue(value.current ?? "");
  }, [shown]);

  // While shown: 30 s, a lost focus, a hidden window; and always on unmount.
  useEffect(() => {
    if (!shown) return;
    const tick = setInterval(() => setNow(Date.now()), 250);
    const end = setTimeout(() => hideRef.current(), SHOW_MS);
    const blur = () => hideRef.current();
    const vis = () => document.visibilityState === "hidden" && hideRef.current();
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", vis);
    return () => {
      clearInterval(tick);
      clearTimeout(end);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [shown]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      ticket.current++;
      value.current = undefined;
      if (hideShown === hideRef.current) hideShown = undefined;
    };
  }, []);
  // The lock ends: what is shown goes.
  useEffect(() => {
    if (!p.unlocked && shown) hide();
  }, [p.unlocked]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (copied === undefined) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    const end = setTimeout(() => setCopied(undefined), SHOW_MS);
    return () => (clearInterval(t), clearTimeout(end));
  }, [copied]);

  const reveal = async () => {
    if (shown) return hide();
    if (pending.current) return;
    pending.current = true;
    setError(undefined);
    try {
      if (!(await p.ensure())) return;
      hideShown?.();
      const mine = ++ticket.current;
      // A blur or a hidden window while main reads ends this reveal: the value would land in a window you've left.
      const drop = () => {
        if (ticket.current === mine) ticket.current++;
      };
      const vis = () => document.visibilityState === "hidden" && drop();
      window.addEventListener("blur", drop);
      document.addEventListener("visibilitychange", vis);
      let r: Revealed;
      try {
        const ask = () => api.invoke("secret:reveal", { handle: p.handle, secret: p.secret, key: p.name });
        // Main's unlock ended (a reload, its time) though this window's chip still showed it: ask main's dialog again.
        r = await ask().catch(async (e: ApiError) => {
          if (e.status === 403 && e.message === LOCKED && (await p.ensure(true))) return ask();
          throw e;
        });
      } finally {
        window.removeEventListener("blur", drop);
        document.removeEventListener("visibilitychange", vis);
      }
      // Its row gone, hidden, blurred, or another reveal since: the answer is dropped, never stored (M1).
      if (!alive.current || ticket.current !== mine || document.visibilityState === "hidden") return;
      if (r.kind === "text") value.current = r.text;
      hideShown = hideRef.current;
      setShown({ kind: r.kind, bytes: r.bytes, at: Date.now() });
      setNow(Date.now());
    } catch (e) {
      if (alive.current) setError((e as ApiError).message);
    } finally {
      pending.current = false;
    }
  };
  const copy = async (as?: "base64") => {
    if (pending.current) return;
    pending.current = true;
    setError(undefined);
    try {
      if (!(await p.ensure())) return;
      const ask = () => api.invoke("secret:copy", { handle: p.handle, secret: p.secret, key: p.name, ...(as ? { as } : {}) });
      await ask().catch(async (e: ApiError) => {
        if (e.status === 403 && e.message === LOCKED && (await p.ensure(true))) return ask();
        throw e;
      });
      if (!alive.current) return;
      setBase64(false);
      setCopied(Date.now());
      setNow(Date.now());
    } catch (e) {
      if (!alive.current) return;
      const err = e as ApiError;
      if (err.status === 415) setBase64(true);
      setError(err.message);
    } finally {
      pending.current = false;
    }
  };

  const off = !!p.why || p.helm || p.busy;
  const left = shown ? Math.max(0, SHOW_MS - (now - shown.at)) : 0;
  return (
    <li className="secret-key">
      <div className="secret-row">
        <span className="mono secret-name" title={p.name}>{p.name}</span>
        <span className="dim mono secret-size">{p.size === undefined ? "" : bytesText(p.size)}</span>
        <span className="grow" />
        {p.helm ? null : (
          <>
            <button className="secondary sm" aria-label={`Copy ${p.name}`} disabled={off} title={p.why ?? "Copy to the clipboard: cleared after 30 s"} onClick={() => void copy()}>
              <Ic icon={Copy} size={12} />Copy
            </button>
            <button className="secondary sm" aria-label={`${shown ? "Hide" : "Reveal"} ${p.name}`} aria-pressed={!!shown} disabled={off && !shown} title={p.why ?? (shown ? "Hide" : "Show to you only, for 30 s")} onClick={() => void reveal()}>
              <Ic icon={shown ? EyeOff : Eye} size={12} />{shown ? "Hide" : "Reveal"}
            </button>
          </>
        )}
      </div>
      {shown ? (
        <div className="secret-shown">
          {shown.kind === "text" ? (
            <pre ref={pre} className="secret-value" data-private="" aria-label={`Value of ${p.name}`}
              onCopy={(e) => e.preventDefault()} onCut={(e) => e.preventDefault()} onDragStart={(e) => e.preventDefault()} onContextMenu={(e) => e.preventDefault()} />
          ) : (
            <p className="secret-note">{shown.kind === "binary" ? `Not text (${bytesText(shown.bytes)}): nothing is shown. Copy it as base64.` : `Over 64 KiB (${bytesText(shown.bytes)}): copy it instead.`}</p>
          )}
          <div className="secret-timer" aria-hidden="true"><i style={{ width: `${(left / SHOW_MS) * 100}%` }} /></div>
          <span className="dim secret-hides" role="timer">Hides in {Math.ceil(left / 1000)} s</span>
        </div>
      ) : null}
      {copied !== undefined ? <p className="secret-note ok" role="status"><Ic icon={Lock} size={12} />Copied. Clears in {Math.max(0, Math.ceil((SHOW_MS - (now - copied)) / 1000))} s</p> : null}
      {error ? (
        <p className="secret-note bad" role="alert"><Ic icon={TriangleAlert} size={12} />{error}
          {base64 ? <button className="link-btn" onClick={() => void copy("base64")}>Copy as base64</button> : null}
        </p>
      ) : null}
    </li>
  );
}

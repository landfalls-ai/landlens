// A Secret's certificates (wave 8 part 4, D167): one card per certificate in `tls.crt` and `ca.crt`, the leaf first,
// read by main with a token for one GET; public halves only (main never decodes `tls.key`). Shown on open for a
// kubernetes.io/tls Secret; for other types a quiet link, so main doesn't read every Secret you click. Every name on a
// card is the certificate's own text, drawn as text nodes, never inside a sentence of Landlens's.
import type { CertDetail, KubeObject } from "@landlens/contracts";
import { Check, CircleCheck, CircleX, Clock, Copy, FileBadge, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type ApiError } from "./api";
import { Ic } from "./icons";
import { copyText } from "./present";
import { expiry } from "./secretText";

const TLS = "kubernetes.io/tls";
type Read = { certs: CertDetail[]; skipped?: string } | { error: string } | "loading";

export function CertPanel({ handle, object, now }: { handle: string; object: KubeObject; now: number }) {
  const tls = String((object as { type?: unknown }).type ?? "") === TLS;
  const helm = String((object as { type?: unknown }).type ?? "") === "helm.sh/release.v1";
  const [read, setRead] = useState<Read>();
  const load = () => {
    setRead("loading");
    api.invoke("secret:certs", { handle, secret: { namespace: object.metadata.namespace ?? "", name: object.metadata.name } })
      .then((r) => setRead(r), (e: ApiError) => setRead({ error: e.message }));
  };
  useEffect(() => {
    setRead(undefined);
    if (tls) load();
  }, [handle, object.metadata.uid, object.metadata.resourceVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  if (helm) return null;
  if (!read) {
    return <button className="link-btn cert-look" onClick={load}><Ic icon={FileBadge} size={13} />Look for certificates</button>;
  }
  return (
    <section className="certs" aria-label="Certificates">
      <h3>Certificates</h3>
      {read === "loading" ? <p className="muted-line">Reading certificates…</p>
        : "error" in read ? <p className="tone-bad">{read.error}</p>
        : !read.certs.length ? <p className="muted-line">No certificate in tls.crt or ca.crt.</p>
        : (
          <>
            <Chain certs={read.certs} />
            <ul className="cert-list">{read.certs.map((c) => <CertCard key={`${c.key}/${c.index}`} c={c} now={now} />)}</ul>
          </>
        )}
      {read !== "loading" && !("error" in read) && read.skipped ? <p className="muted-line">{read.skipped}</p> : null}
    </section>
  );
}

/** "leaf → R11 → ISRG Root X1": the chain in tls.crt, when it holds more than the leaf. */
function Chain({ certs }: { certs: CertDetail[] }) {
  const chain = certs.filter((c) => c.key === "tls.crt" && !c.unreadable);
  if (chain.length < 2) return null;
  const last = chain.at(-1)!;
  const names = [...chain.map((c) => c.subject || "?"), ...(last.selfSigned ? [] : [last.issuer || "?"])];
  return (
    <p className="cert-chain" aria-label="Chain">
      {names.map((n, i) => <span key={i}>{i ? <span className="dim" aria-hidden="true"> → </span> : null}<span className="mono">{n}</span></span>)}
    </p>
  );
}

const keyText = (k: CertDetail["publicKey"]) => !k ? "—" : k.type === "rsa" ? `RSA${k.bits ? ` ${k.bits}` : ""}` : k.type === "ec" ? `EC${k.curve ? ` ${k.curve}` : ""}` : k.type === "ed25519" ? "Ed25519" : "Other";
const day = (iso: string) => iso.slice(0, 10);

function CertCard({ c, now }: { c: CertDetail; now: number }) {
  if (c.unreadable) {
    return (
      <li className="cert-card">
        <div className="cert-head"><Ic icon={CircleX} size={14} className="tone-bad" /><strong>Unreadable certificate</strong><span className="dim mono">{c.key} #{c.index + 1}</span></div>
      </li>
    );
  }
  const e = expiry(c.notAfter, now);
  const sans = c.sans;
  return (
    <li className="cert-card">
      <div className="cert-head">
        <Ic icon={ShieldCheck} size={14} />
        <strong className="cert-title" title={c.subject}>{c.subject || "—"}</strong>
        <span className="dim mono">{c.key}{c.key === "tls.crt" && c.index === 0 ? " · leaf" : ` #${c.index + 1}`}</span>
      </div>
      <div className="cert-badges">
        <span className={`badge ${e.tone}`}><Ic icon={e.tone === "ok" ? CircleCheck : e.tone === "warn" ? Clock : CircleX} size={12} />{e.text}</span>
        {c.ca ? <span className="badge muted">CA</span> : null}
        {c.selfSigned ? <span className="badge muted">self-signed</span> : null}
      </div>
      <dl className="facts cert-facts">
        <dt>Issuer</dt><dd>{c.issuer || "—"}</dd>
        {sans.length ? (
          <>
            <dt>Names</dt>
            <dd>
              <span className="cert-sans">{sans.slice(0, 6).map((n) => <span key={n} className="chip mono">{n}</span>)}</span>
              {sans.length > 6 ? (
                <details className="cert-more"><summary>{sans.length - 6} more</summary><span className="cert-sans">{sans.slice(6).map((n) => <span key={n} className="chip mono">{n}</span>)}</span></details>
              ) : null}
            </dd>
          </>
        ) : null}
        <dt>Valid</dt><dd className="mono">{day(c.notBefore)} – {day(c.notAfter)}</dd>
        <dt>Key</dt><dd>{keyText(c.publicKey)}</dd>
        <dt>Serial</dt><dd><Hex label="serial" value={c.serial} /></dd>
        <dt>SHA-256</dt><dd><Hex label="SHA-256 fingerprint" value={c.sha256} /></dd>
      </dl>
    </li>
  );
}

/** A public hex value with its own copy button (public material: the window's clipboard is fine). */
function Hex({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  if (!value) return <>—</>;
  return (
    <span className="cert-hex">
      <span className="mono">{value}</span>
      <button className="icon-btn" aria-label={`Copy ${label}`} title={`Copy ${label}`}
        onClick={() => void copyText(value).then(() => (setDone(true), setTimeout(() => setDone(false), 1200)))}><Ic icon={done ? Check : Copy} size={12} /></button>
    </span>
  );
}

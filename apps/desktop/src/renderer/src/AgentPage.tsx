// The Agent page (wave 3, D72–D77): which of your Claude Code skills agent sessions get, and the agent itself with its
// fence in words. Skills are copied into each new session's folder and run inside its sandbox.
import type { AgentSettingsInfo } from "@landlens/contracts";
import { Check, Search, ShieldCheck, Sparkles, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type ApiError } from "./api";
import { Ic } from "./icons";

export type AgentTab = "skills" | "agents";

export function AgentPage({ tab, onTab }: { tab: AgentTab; onTab: (t: AgentTab) => void }) {
  const [settings, setSettings] = useState<AgentSettingsInfo>();
  const [error, setError] = useState<string>();
  const reload = () => api.invoke("agent:settings", {}).then(setSettings, (e: ApiError) => setError(e.message));
  useEffect(() => void reload(), []);
  const on = settings?.skills.filter((s) => s.chosen).length ?? 0;

  return (
    <div className="ov mcp">
      <div className="tabs mcp-tabs" role="tablist" aria-label="Agent">
        {(["skills", "agents"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => onTab(t)}>
            {t === "skills" ? "Skills" : "Agents"}
            <span className="count" aria-hidden="true">{t === "skills" ? (settings ? on : "…") : 1}</span>
          </button>
        ))}
      </div>
      {error ? <p className="tone-bad small" role="alert">{error}</p> : null}
      {tab === "skills" ? <Skills settings={settings} onChanged={reload} onError={setError} /> : <Agents skillsOn={on} />}
    </div>
  );
}

function Skills({ settings, onChanged, onError }: { settings?: AgentSettingsInfo; onChanged: () => void; onError: (m?: string) => void }) {
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string>();
  const skills = useMemo(() => {
    const all = [
      ...(settings?.skills ?? []),
      ...(settings?.missing ?? []).map((name) => ({ name, description: "", chosen: true, missing: true })),
    ] as { name: string; description: string; chosen: boolean; missing?: boolean }[];
    const f = filter.trim().toLowerCase();
    return all
      .filter((s) => !f || s.name.includes(f) || s.description.toLowerCase().includes(f))
      .sort((a, b) => Number(b.chosen) - Number(a.chosen) || a.name.localeCompare(b.name));
  }, [settings, filter]);
  const set = (name: string, chosen: boolean) => {
    if (!settings) return;
    const now = new Set(settings.skills.filter((s) => s.chosen).map((s) => s.name));
    if (chosen) now.add(name);
    else now.delete(name);
    setBusy(true);
    onError(undefined);
    api.invoke("agent:skills", { chosen: [...now] }).then(onChanged, (e: ApiError) => onError(e.message)).finally(() => setBusy(false));
  };
  const on = settings?.skills.filter((s) => s.chosen).length ?? 0;
  return (
    <>
      <div className="mcp-intro">
        <p className="dim">
          Pick which of your own Claude Code skills an agent session gets. Landlens reads them from <span className="mono">{settings?.skillsDir ?? "~/.claude/skills"}</span>.
          A session starts with none of your settings, plugins or hooks; the skills you turn on here are the only things of yours it carries.
        </p>
        {(settings?.skills.length ?? 0) > 8 ? (
          <label className="field" style={{ width: 200 }}><Ic icon={Search} size={14} /><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter skills" aria-label="Filter skills" /></label>
        ) : null}
      </div>
      <div className="agent-note" role="note">
        <Ic icon={ShieldCheck} size={15} />
        <span>
          <b>Skills run inside the sandbox.</b> A skill's instructions and scripts are copied into the session's folder and run
          with the session's limits: this cluster only, through Landlens; no Secrets; no internet; none of your files. A
          skill that needs something else will fail there, and the agent will say so. Skills with links, over 500 files or over
          5 MB are left out.
        </span>
      </div>
      <section className="panel" aria-label="Your skills">
        <header className="panel-head">
          <h3>Your skills</h3>
          <span className="dim small">{on} of {settings?.skills.length ?? "…"} on</span>
          <span className="grow" />
          <span className="dim small">Used by sessions you start from now on</span>
        </header>
        {settings && !settings.skills.length && !settings.missing.length ? (
          <div className="ov-empty"><strong>No skills in {settings.skillsDir}</strong><span>Skills you make in Claude Code appear here.</span></div>
        ) : (
          <ul className="skill-list">
            {skills.map((s) => (
              <li key={s.name} className={"skill-row" + (s.chosen ? "" : " off")}>
                <label className="switch">
                  <input type="checkbox" role="switch" checked={s.chosen} disabled={busy} onChange={() => set(s.name, !s.chosen)} aria-label={`Use ${s.name}`} />
                </label>
                <div style={{ minWidth: 0 }}>
                  <div className="skill-name">{s.name}{s.missing ? <span className="badge warn"><Ic icon={TriangleAlert} size={12} />Not found</span> : null}</div>
                  {s.description ? (
                    <div className="skill-desc" title={s.description} style={open === s.name ? { whiteSpace: "normal" } : undefined}
                      onClick={() => setOpen((o) => (o === s.name ? undefined : s.name))}>{s.description}</div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Agents({ skillsOn }: { skillsOn: number }) {
  return (
    <>
      <div className="mcp-intro">
        <p className="dim">The agent the dock runs. It speaks ACP, gets the cluster tools through Landlens, and waits for your approval before any change.</p>
      </div>
      <section className="panel" aria-label="Agent Claude Code">
        <header className="panel-head">
          <span className="claude-tile" style={{ width: 28, height: 28 }}><Ic icon={Sparkles} size={14} /></span>
          <h3>Claude Code</h3>
          <span className="badge muted">Built in</span>
          <span className="pill">default</span>
          <span className="grow" />
          <span className="dim small">Your Claude Code login</span>
        </header>
        <div className="agent-meta">
          <span className="mono dim small">claude-agent-acp 0.107.0</span>
          <span className="dim small">{skillsOn} skill{skillsOn === 1 ? "" : "s"} on</span>
        </div>
        <div className="agent-fence">
          <div className="agent-fence-title">How it's fenced: Claude Code's own sandbox</div>
          <ul className="test-steps">
            <li><Ic icon={Check} size={13} /><span>Its shell runs in <b>Claude Code's sandbox</b>: it reads only the session folder, and has no internet.</span></li>
            <li><Ic icon={Check} size={13} /><span>It reaches this cluster only through Landlens: no Secrets, no exec.</span></li>
            <li><Ic icon={Check} size={13} /><span>Every change waits for your approval in the dock, after a dry run.</span></li>
          </ul>
        </div>
      </section>
      <p className="dim small">
        Other ACP agents aren't offered yet: Claude Code's sandbox fences only Claude Code, and another agent would need
        Landlens's own sandbox, with network to its model provider. See docs/limitations.md.
      </p>
    </>
  );
}

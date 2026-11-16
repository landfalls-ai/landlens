// Every renderer request lands here: checked to come from our own page, validated with the contract's schema, then
// answered. Errors cross as JSON {status, message} so the UI can tell "no access" from "failed".
import { channels, type Channel, type ClusterStatusEvent, type KubeObject, type Request, type Responses, type ResourceType, type WatchEvent } from "@landlens/contracts";
import { checkAccess, getRelease, KubeError, listContexts, listReleases, mergeCatalog, searchIndex, withoutSecretValues, type SearchIndex, type ClusterManager, type WatchHub } from "@landlens/kube";
import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { MetricsService } from "@landlens/metrics";
import type { AgentService } from "./agent";
import type { DoctorService } from "./doctor";
import type { ClicklandSettingsStore } from "./clickland-settings";
import type { ClicklandHistory } from "./clickland-history";
import type { PrometheusChoices } from "./prometheus-choice";
import type { McpService } from "./mcp";
import type { ForwardService } from "./forwards";
import type { WorkbenchService } from "./workbench";
import { flowOwners, type ConnectionsService } from "./connections";
import type { FamilyService } from "./family";
import type { LandflowActions } from "./landflow";
import { connectedOf, type GcpService } from "./gcp";
import type { TelemetryService } from "./telemetry";
import type { BrainService } from "./brain";
import { isAppUrl } from "./security";
import { nativeConfirm as confirmOn } from "./native-confirm";
import type { SecretService } from "./secrets";
import type { ActionService } from "./actions";
import type { ViewService } from "./views";

type Handlers = { [C in Channel]: (req: Request<C>, event: IpcMainInvokeEvent) => Promise<Responses[C]> };

const viewsOf = (v: ViewService | undefined): ViewService => {
  if (!v) throw Object.assign(new Error("Views aren't available in this window."), { status: 503 });
  return v;
};

export function registerIpc(clusters: ClusterManager, hub: WatchHub, agent: AgentService, metrics: { service: MetricsService; settings: ClicklandSettingsStore; prometheus: PrometheusChoices; history: ClicklandHistory }, mcp: McpService, workbench: WorkbenchService, forwards: ForwardService, doctor: DoctorService, connections: ConnectionsService, gcp: GcpService, family: FamilyService, landflow: LandflowActions, report: { telemetry: TelemetryService; brain: BrainService }, actions: ActionService, secrets: SecretService, gkeHandles = new Set<string>(), views?: ViewService) {
  const searches = new Map<string, { at: number; read: Promise<SearchIndex & { at: string }> }>();
  /** Subscriptions per renderer, so a closed window stops its watches. */
  const owned = new Map<WebContents, Set<string>>();
  /** Windows that started a sign-in: when one goes, its sign-ins stop. */
  const flowOwner = flowOwners({ cancelFor: (owner) => (connections.cancelFor(owner), family.cancelFor(owner)) });
  // gkeHandles: clusters connected through Landlens's GKE kubeconfig, by handle (a context of yours by the same name
  // isn't one); main's metrics source reads the same set.
  clusters.onGone((handle) => gkeHandles.delete(handle));

  /** Main's own question, in a native dialog on the asking window: the renderer can't answer it (part 5, L3). */
  const nativeConfirm = (event: IpcMainInvokeEvent) => confirmOn(event.sender);

  const disconnect = async (handle: string) => {
    metrics.service.forget(handle);
    metrics.history.forget(handle);
    doctor.forget(handle);
    await mcp.forget(handle);
    await hub.stopAll(handle);
    await clusters.disconnect(handle);
  };

  // A GKE cluster whose project you took out, or that left the listing (Google Cloud off, gcloud signed out, another
  // account, a new address), is disconnected at once, and every window is told (review of part 5, L7).
  gcp.onGkeGone((contexts) => {
    for (const info of clusters.list()) {
      if (!gkeHandles.has(info.handle) || !contexts.includes(info.context)) continue;
      const event: ClusterStatusEvent = { handle: info.handle, context: info.context, state: "disconnected", reason: "its Google Cloud project is no longer chosen, or gcloud's sign-in changed." };
      void disconnect(info.handle).finally(() => {
        for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("cluster:status", event);
      });
    }
  });

  const handlers: Handlers = {
    "catalog:list": async () => {
      let own: ReturnType<typeof listContexts> = [];
      let error: string | undefined;
      try {
        own = listContexts();
      } catch (err) {
        error = `Could not read your kubeconfig: ${(err as Error).message}`;
      }
      // The GKE clusters of the Google Cloud projects you chose (D91), after yours; a name yours has is left out.
      const gke = await gcp.gkeContexts().catch((err: Error) => ({ contexts: [], errors: [{ project: "", message: err.message }] }));
      return { contexts: mergeCatalog(own, gke.contexts), ...(error ? { error } : {}), ...(gke.errors.length ? { gke: { errors: gke.errors } } : {}) };
    },
    "cluster:connect": async ({ context }, event) => {
      // Only contexts from the user's kubeconfig, or a GKE cluster Landlens listed (its own kubeconfig, D91); the name
      // goes to the sidecar as an argument. Yours wins when both have the name. A GKE cluster's first connect asks in
      // main's own dialog (L3).
      const own = listContexts().some((c) => c.name === context);
      const gke = own ? undefined : await gcp.gkeConnect(context, nativeConfirm(event));
      if (!own && !gke) throw ipcError(404, `no context named ${context} in your kubeconfig`);
      const info = await clusters.connect(context, gke ?? {});
      // A window that connects another cluster keeps no Secret unlocked (D163).
      secrets.lockWindow(event.sender);
      if (gke) gkeHandles.add(info.handle);
      // Kept forwards for this context start again (D37), without opening anything.
      forwards.restore(info);
      return info;
    },
    "cluster:disconnect": async ({ handle }) => {
      await disconnect(handle);
      return { ok: true };
    },
    "cluster:discovery": async ({ handle }) => ({ types: await clusters.discovery(handle) }),
    "cluster:access": async ({ handle, checks }) => ({ allowed: await checkAccess(clusters.get(handle).client, checks) }),
    // The Overview's health and the doctor's report come from one service, reading as you (wave 5, D53).
    "cluster:health": async ({ handle, namespace }) => doctor.health(handle, namespace),
    "doctor:list": async ({ handle, namespace }) => doctor.report(handle, namespace),
    "doctor:evidence": async ({ handle, namespace, id }) => doctor.evidence(handle, namespace, id),
    "resource:get": async ({ handle, ref }) => {
      const type = await clusters.typeOf(handle, ref); // only kinds the cluster serves
      return { object: withoutSecretValues(await clusters.getObject(handle, ref), isSecrets(type)) };
    },
    "resource:events": async ({ handle, uid, namespace }) => ({ items: await clusters.eventsFor(handle, uid, namespace) }),
    "watch:subscribe": async (req, event) => {
      const secrets = isSecrets(await clusters.typeOf(req.handle, req));
      const hide = (o: KubeObject) => withoutSecretValues(o, secrets);
      const wc = event.sender;
      let set = owned.get(wc);
      if (!set) {
        set = new Set();
        owned.set(wc, set);
        wc.once("destroyed", () => {
          for (const id of owned.get(wc) ?? []) hub.unsubscribe(id);
          owned.delete(wc);
        });
      }
      let subscription = "";
      subscription = hub.subscribe(req, (e) => {
        if (wc.isDestroyed()) return;
        const payload: WatchEvent =
          e.type === "error"
            ? { subscription, type: "error", status: e.status, message: e.message }
            : e.type === "snapshot"
              ? { subscription, type: "snapshot", items: e.items.map(hide) }
              : { subscription, type: "delta", upserted: e.upserted.map(hide), removed: e.removed };
        wc.send("watch:event", payload);
      });
      set.add(subscription);
      return { subscription };
    },
    "watch:unsubscribe": async ({ subscription }, event) => {
      owned.get(event.sender)?.delete(subscription);
      hub.unsubscribe(subscription);
      return { ok: true };
    },
    "agent:start": ({ handle, namespaces }) => agent.start(handle, namespaces),
    // No Secret is attached, and no value Landlens revealed or copied is sent (wave 8 part 4, D168): the dock, a quote, a paste.
    "agent:prompt": async ({ session, text, context }) => {
      await secrets.refusePrompt({ text, ...(context ? { context } : {}) });
      return agent.prompt(session, text, context);
    },
    "agent:cancel": async ({ session }) => (await agent.cancel(session), { ok: true }),
    "agent:mode": async ({ session, mode }) => (await agent.setMode(session, mode), { ok: true }),
    "agent:config": async ({ session, config, value }) => (await agent.setConfig(session, config, value), { ok: true }),
    "agent:answer": async ({ request, option }) => (agent.answer(request, option), { ok: true }),
    "agent:decide": async ({ change, decision, note }) => (await secrets.refuseValues([note]), agent.decide(change, decision, note), { ok: true }),
    "agent:history": async ({ context }) => ({ sessions: agent.history(context) }),
    "agent:resume": async ({ handle, session }) => agent.resume(handle, session),
    "agent:forget": async ({ session }) => (await agent.forget(session), { ok: true }),
    "agent:settings": async () => agent.settings(),
    "agent:skills": async ({ chosen }) => (agent.setSkills(chosen), { ok: true }),
    // Links in an answer open in your browser, https only. Only our own page reaches IPC (checked below), so a view
    // in a subframe can't use this; window.open is denied for everyone (security.ts).
    "link:open": async ({ url }) => {
      const u = httpsLink(url);
      if (!u) throw ipcError(400, "Landlens opens https links only.");
      await shell.openExternal(u);
      return { opened: true };
    },
    "agent:close": async ({ session }) => (await agent.close(session), { ok: true }),
    // The autonomous mode (D82): on or off for one connection in one session; main alone answers for it.
    "agent:autonomy": async ({ session, provider, on, scope }) => mcp.setAutonomy(session, provider, on, scope),
    // Graphs (docs/metrics.md). The Clickland key comes in with configure and test; nothing sends it back.
    "metrics:series": (req) => metrics.service.series(req),
    "metrics:settings": async ({ context }) => {
      const console = family.clicklandConsole();
      return { ...metrics.settings.view(context), ...(console ? { console } : {}) };
    },
    // Clickland's key is the family's too (docs/family.md): a change asks who the key is again.
    "metrics:configure": async (input) => {
      const out = metrics.settings.set(input);
      family.clicklandChanged();
      return out;
    },
    "metrics:test": (input) => metrics.service.test(input),
    "metrics:disconnect": async () => {
      const out = metrics.settings.clear();
      family.clicklandChanged();
      return out;
    },
    // Clickland's logs and traces (docs/metrics.md#logs-and-traces): an object the window shows or the doctor named;
    // the search is main's own, the lines scrubbed before they cross. Open in Clickland asks in main's own dialog.
    "clickland:logs": (req) => metrics.history.logs(req),
    "clickland:traces": (req) => metrics.history.traces(req),
    "clickland:trace": (req) => metrics.history.trace(req),
    "clickland:open": (req, event) => metrics.history.open(req, { confirm: nativeConfirm(event), openExternal: (url) => shell.openExternal(url) }),
    // Choosing a Prometheus: only the one Landlens finds now, for this cluster's context (docs/metrics.md#prometheus).
    "metrics:prometheus": async ({ handle, use }) => {
      const context = clusters.get(handle).info.context;
      if (use !== null && (await metrics.service.foundPrometheus(handle)) !== use) throw ipcError(409, `Landlens doesn't find a Prometheus at ${use} now.`);
      metrics.prometheus.set(context, use);
      return { ok: true };
    },
    // MCP (docs/mcp.md). A server's header value comes in with save and test; nothing sends it back.
    "mcp:servers": ({ context }) => mcp.servers(context),
    "mcp:save": async (input) => mcp.save(input),
    "mcp:test": (req) => mcp.test(req),
    "mcp:enable": async ({ id, context, enabled }) => mcp.enable(id, context, enabled),
    "mcp:auto-run": async ({ id, enabled, context }) => mcp.autoRun(id, enabled, context),
    "mcp:remove": async ({ id }) => (mcp.remove(id), { ok: true }),
    "mcp:calls": async () => ({ calls: mcp.calls() }),
    "mcp:try": ({ handle, server, tool }) => mcp.try(handle, server, tool),
    "mcp:app-open": ({ call }) => mcp.openView(call),
    "mcp:app-call": ({ view, name, arguments: args }) => mcp.viewCall(view, name, args ?? {}),
    "mcp:app-close": async ({ view }) => (mcp.views.close(view), { ok: true }),
    "mcp:app-link": async ({ view, url }) => ({ opened: await mcp.viewLink(view, url) }),
    // Connections (docs/connections.md). A token comes in on conn:token; nothing sends one back. A sign-in belongs to
    // the window that started it.
    "conn:list": async () => ({ ...connections.list(), gcp: await gcp.status() }),
    "conn:github-device": async (_r, event) => connections.githubDevice(flowOwner(event.sender)),
    "conn:linear-signin": async ({ mode }, event) => connections.linearSignIn(mode, flowOwner(event.sender)),
    "conn:token": ({ provider, token }) => connections.token(provider, token),
    // A Landfall sign-in is a flow too (the family's): each service ends only flows it made, owned by this window.
    "conn:cancel": async ({ flow }, event) => (family.hasFlow(flow) ? family.cancel(flow, event.sender) : connections.cancel(flow, event.sender), { ok: true }),
    "conn:set": async ({ provider, mode, readsAuto, give }) => connections.set(provider, { ...(mode ? { mode } : {}), ...(readsAuto !== undefined ? { readsAuto } : {}), ...(give !== undefined ? { give } : {}) }),
    "conn:test": ({ provider }) => connections.test(provider),
    "conn:repin": async ({ provider }) => connections.repin(provider),
    "conn:disconnect": ({ provider }) => connections.disconnect(provider),
    // The Land family (docs/family.md). A key or secret comes in on family:connect and family:set; none goes back.
    "family:list": async () => family.list(),
    "family:connect": ({ url, key }) => family.connectLandflow(url, key),
    "family:signin": async ({ url }, event) => family.signinLandfall(url, flowOwner(event.sender)),
    "family:set": async ({ sibling, toSessions, readsAuto, console, triage }) =>
      family.set(sibling, { ...(toSessions !== undefined ? { toSessions } : {}), ...(readsAuto !== undefined ? { readsAuto } : {}), ...(console !== undefined ? { console } : {}), ...(triage !== undefined ? { triage } : {}) }),
    "family:test": ({ sibling }) => family.test(sibling),
    "family:repin": async ({ sibling, hash }) => family.repin(sibling, hash),
    "family:disconnect": ({ sibling }) => family.disconnect(sibling),
    // Landflow on a resource (docs/family.md#landflow-on-a-resource): main builds what is sent and keeps it under a
    // sheet owned by this window; the window sends only choices and main's ids. Links open after main's own dialog.
    "landflow:alert": (req, event) => landflow.prepareAlert(req, event.sender),
    "landflow:triage": (req, event) => landflow.sendAlert(req, event.sender),
    "landflow:flows": (_req, event) => landflow.flows(event.sender),
    "landflow:input": (req, event) => landflow.prepareInput(req, event.sender),
    "landflow:run": (req, event) => landflow.run(req, event.sender),
    "landflow:follow": (req) => landflow.follow(req),
    "landflow:sent": async (req) => landflow.sentFor(req),
    "landflow:open": (req, event) => landflow.open(req, { confirm: nativeConfirm(event), openExternal: (url) => shell.openExternal(url) }, event.sender),
    // Landlens's telemetry (D127–D133): turning it on, or a new collector, asks in main's own dialog.
    "telemetry:set": (req, event) => report.telemetry.set({ ...req }, nativeConfirm(event)),
    "telemetry:recent": async () => report.telemetry.recent(),
    "telemetry:open": ({ session }, event) =>
      report.telemetry.open(session, (s) => agent.isOpen(s) || agent.history().some((e) => e.session === s), { confirm: nativeConfirm(event), openExternal: (url) => shell.openExternal(url) }),
    // A session's summary to the brain (D134–D135): a sheet per window; send names its digest.
    "brain:draft": async ({ session }, event) => report.brain.draft(session, event.sender),
    "brain:ask": ({ sheet }, event) => report.brain.ask(sheet, event.sender),
    "brain:cancel": ({ sheet }, event) => report.brain.cancel(sheet, event.sender),
    // Team or org: main's own dialog shows the text and who will see it (review of part 5, M4).
    "brain:send": async (req, event) => (await secrets.refuseValues([req.title, req.summary]), report.brain.send(req, event.sender, nativeConfirm(event))),
    "brain:remove": ({ session }) => report.brain.remove(session),
    // Google Cloud (docs/gcp.md): read-only, with gcloud's sign-in; reads go only to the projects you chose.
    "gcp:status": ({ fresh }) => gcp.status(!!fresh),
    "gcp:projects": ({ fresh }) => gcp.projects(!!fresh),
    "gcp:choose": ({ projects }) => gcp.choose(projects),
    // A grant to the agent: main asks in a native dialog before turning it on; off leaves open sessions at once.
    "gcp:agent-read": async ({ on }, event) => {
      const s = await gcp.setAgentRead(on, nativeConfirm(event));
      if (!s.agentRead) mcp.gcpOff();
      return s;
    },
    "gcp:types": ({ project, fresh }) => gcp.types(project, !!fresh),
    "gcp:resources": (r) => gcp.resources(r),
    "gcp:resource": ({ project, name }) => gcp.resource(project, name),
    "gcp:clusters": () => gcp.clusters(),
    // Google's view of a connected cluster (wave 9, D173–D177): the page names only the handle. Whether it is a GKE
    // cluster of a chosen project is main's answer, from how it was connected and the address it was connected at.
    // The sidecar's report of whom it trusts goes with it: an own context must verify TLS against the listed CA (M1).
    "gcp:cluster-view": ({ handle, fresh }) => gcp.view(connectedOf(clusters, gkeHandles, handle), !!fresh),
    // One alert's or suggestion's detail and Ask Claude's brief (wave 9 part 3, D187): a handle and an id, answered only
    // for an id in that cluster's view now.
    "gcp:cluster-item": ({ handle, kind, id }) => gcp.item(connectedOf(clusters, gkeHandles, handle), kind, id),
    // Views on demand (wave 10, docs/views.md): the page's channels. The person's words are checked for revealed
    // Secret values as the dock's are (D168); a frame's calls and intents are ViewService's to answer.
    "views:start": async ({ handle, namespaces, text }) => {
      await secrets.refusePrompt({ text });
      return viewsOf(views).start({ handle, text, ...(namespaces ? { namespaces } : {}) });
    },
    "views:prompt": async ({ view, text, context, block }) => {
      await secrets.refusePrompt({ text, ...(context ? { context } : {}) });
      return viewsOf(views).prompt({ view, text, ...(context ? { context } : {}), ...(block ? { block } : {}) });
    },
    "views:get": async ({ view }) => viewsOf(views).get(view),
    "views:version": async ({ view, to }) => viewsOf(views).version(view, to),
    "views:param": async ({ view, name, value }) => viewsOf(views).param(view, name, value),
    "views:refresh": async ({ view }) => ({ ran: viewsOf(views).refresh(view) }),
    "views:visible": async ({ view, visible }) => (viewsOf(views).visible(view, visible), { ok: true as const }),
    "views:close": async ({ view }) => (await viewsOf(views).close(view), { ok: true as const }),
    "views:app-open": async ({ view, block }) => viewsOf(views).appOpen(view, block),
    "views:app-call": ({ frame, name, arguments: args }) => viewsOf(views).appCall(frame, name, args ?? {}),
    "views:intent": async ({ frame, url }) => viewsOf(views).intent(frame, url),
    "views:audit": async ({ view }) => viewsOf(views).auditOf(view),
    // The workbench (docs/workbench.md): logs and shells belong to the window that opened them.
    "logs:open": async (req, event) => workbench.openLogs(req, event.sender),
    "logs:close": async ({ stream }, event) => (workbench.closeLogsFor(stream, event.sender), { ok: true }),
    "terminal:open": async (req, event) => workbench.openTerminal(req, event.sender),
    "terminal:local": async ({ handle }, event) => workbench.openLocal({ handle }, event.sender),
    "terminal:input": async ({ terminal, data }, event) => (workbench.input(terminal, data, event.sender), { ok: true }),
    "terminal:resize": async ({ terminal, cols, rows }, event) => (workbench.resize(terminal, cols, rows, event.sender), { ok: true }),
    "terminal:ack": async ({ terminal, chars }, event) => (workbench.ack(terminal, chars, event.sender), { ok: true }),
    "terminal:close": async ({ terminal }, event) => (workbench.close(terminal, event.sender), { ok: true }),
    "edit:review": (r, event) => workbench.reviewEdit(r, event.sender),
    "edit:create": (r, event) => workbench.reviewCreate(r, event.sender),
    "edit:apply": (r, event) => workbench.applyEdit(r, event.sender),
    "edit:discard": async ({ id }, event) => (workbench.discardEdit(id, event.sender), { ok: true }),
    // Your actions (docs/workbench.md#your-actions, D143–D147): main builds, dry-runs and keeps every request as you;
    // Apply names the review and its digest; bulk and wide deletes ask in main's own dialog first.
    "action:review": (r, event) => actions.review(r, event.sender),
    "action:apply": (r, event) => actions.apply(r, event.sender, nativeConfirm(event)),
    "action:discard": async ({ id }, event) => (actions.discard(id, event.sender), { ok: true }),
    "action:stop": async ({ run }, event) => (actions.stop(run, event.sender), { ok: true }),
    "action:runs": async ({ handle }, event) => ({ runs: actions.runsOf(handle, event.sender) }),
    "action:log": async ({ handle, limit }) => ({ entries: actions.history(handle, limit) }),
    // Secret values (wave 8 part 4, D161–D168): main's dialog unlocks one Secret for this window; values go to this
    // window only (reveal) or to the clipboard from main (copy); certificates are public halves.
    "secret:unlock": (r, event) => secrets.unlock(r, event.sender, nativeConfirm(event)),
    "secret:lock": async (r, event) => (secrets.lock(r, event.sender), { ok: true }),
    "secret:reveal": (r, event) => secrets.reveal(r, event.sender),
    "secret:copy": (r, event) => secrets.copy(r, event.sender),
    "secret:certs": (r, event) => secrets.certs(r, event.sender),
    // Port-forwards belong to the app, not a window (docs/workbench.md#port-forward).
    "forward:list": async () => ({ forwards: forwards.list() }),
    "forward:suggest": ({ port }) => forwards.suggest(port),
    "forward:check": ({ port }) => forwards.check(port),
    "forward:start": (r) => forwards.start(r),
    "forward:stop": async ({ id }) => (forwards.stop(id), { ok: true }),
    "forward:resume": ({ id, handle }) => forwards.resume(id, handle),
    "forward:remove": async ({ id }) => (forwards.remove(id), { ok: true }),
    "forward:open": async ({ id }) => (forwards.open(id), { ok: true }),
    // Helm releases, read as you and decoded here; the window gets no secret values (docs/workbench.md#helm-releases).
    "helm:list": ({ handle, namespace }) => helmCall(() => listReleases(clusters.get(handle).client, namespace)),
    "helm:get": ({ handle, namespace, name, revision }) => helmCall(() => getRelease(clusters.get(handle).client, namespace, name, revision)),
    // The palette's names across kinds (D45): one read shared by every window, again after 15 s or on `fresh`.
    "search:index": async ({ handle, fresh }) => {
      const c = clusters.get(handle);
      const held = searches.get(handle);
      if (held && !fresh && Date.now() - held.at < SEARCH_FRESH_MS) return held.read;
      const read = clusters.discovery(handle).then((types) => searchIndex(c.client, types, AbortSignal.timeout(15_000))).then((r) => ({ ...r, at: new Date().toISOString() }));
      searches.set(handle, { at: Date.now(), read });
      read.catch(() => searches.get(handle)?.read === read && searches.delete(handle));
      return read;
    },
  };

  clusters.onGone((handle) => searches.delete(handle));

  for (const name of Object.keys(channels) as Channel[]) {
    ipcMain.handle(name, async (event, raw) => {
      if (!isAppUrl(event.senderFrame?.url ?? "")) throw ipcError(403, "not from Landlens");
      const parsed = channels[name].safeParse(raw ?? {});
      if (!parsed.success) throw ipcError(400, `bad request for ${name}: ${parsed.error.message}`);
      try {
        return await (handlers[name] as (r: unknown, e: IpcMainInvokeEvent) => Promise<unknown>)(parsed.data, event);
      } catch (err) {
        if (err instanceof Error && /^\{"status":\d+/.test(err.message)) throw err; // already an ipcError
        if (err instanceof KubeError) throw ipcError(err.status, err.message);
        const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
        throw ipcError(status, (err as Error).message ?? String(err));
      }
    });
  }
}

/** How long one read of the palette's names serves every window (D45). */
const SEARCH_FRESH_MS = 15_000;

const isSecrets = (t: ResourceType) => t.group === "" && t.resource === "secrets";

/** An https address with no user info, as a string, or undefined. */
export function httpsLink(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : undefined;
  } catch {
    return undefined;
  }
}

const ipcError = (status: number, message: string) => new Error(JSON.stringify({ status, message }));

/** Helm reads its releases from Secrets: say so when your role can't list them. */
async function helmCall<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof KubeError && e.status === 403) throw ipcError(403, "You can't read Secrets here, and Helm keeps its releases in Secrets.");
    throw e;
  }
}

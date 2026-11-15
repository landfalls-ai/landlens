// Every renderer request lands here: checked to come from our own page, validated with the contract's schema, then
// answered. Errors cross as JSON {status, message} so the UI can tell "no access" from "failed".
import { channels, type Channel, type KubeObject, type Request, type Responses, type ResourceType, type WatchEvent } from "@landlens/contracts";
import { checkAccess, getRelease, KubeError, listContexts, listReleases, searchIndex, withoutSecretValues, type SearchIndex, type ClusterManager, type WatchHub } from "@landlens/kube";
import { ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { MetricsService } from "@landlens/metrics";
import type { AgentService } from "./agent";
import type { DoctorService } from "./doctor";
import type { ClicklandSettingsStore } from "./clickland-settings";
import type { PrometheusChoices } from "./prometheus-choice";
import type { McpService } from "./mcp";
import type { ForwardService } from "./forwards";
import type { WorkbenchService } from "./workbench";
import type { ConnectionsService } from "./connections";
import { isAppUrl } from "./security";

type Handlers = { [C in Channel]: (req: Request<C>, event: IpcMainInvokeEvent) => Promise<Responses[C]> };

export function registerIpc(clusters: ClusterManager, hub: WatchHub, agent: AgentService, metrics: { service: MetricsService; settings: ClicklandSettingsStore; prometheus: PrometheusChoices }, mcp: McpService, workbench: WorkbenchService, forwards: ForwardService, doctor: DoctorService, connections: ConnectionsService) {
  const searches = new Map<string, { at: number; read: Promise<SearchIndex & { at: string }> }>();
  /** Subscriptions per renderer, so a closed window stops its watches. */
  const owned = new Map<WebContents, Set<string>>();
  /** Windows that started a sign-in: when one goes, its sign-ins stop. */
  const signingIn = new WeakSet<WebContents>();
  const flowOwner = (wc: WebContents) => {
    if (!signingIn.has(wc)) {
      signingIn.add(wc);
      wc.once("destroyed", () => connections.cancelFor(wc));
    }
    return wc;
  };

  const handlers: Handlers = {
    "catalog:list": async () => {
      try {
        return { contexts: listContexts() };
      } catch (err) {
        return { contexts: [], error: `Could not read your kubeconfig: ${(err as Error).message}` };
      }
    },
    "cluster:connect": async ({ context }) => {
      // Only contexts from the user's kubeconfig; the name goes to the sidecar as an argument.
      if (!listContexts().some((c) => c.name === context)) throw ipcError(404, `no context named ${context} in your kubeconfig`);
      const info = await clusters.connect(context);
      // Kept forwards for this context start again (D37), without opening anything.
      forwards.restore(info);
      return info;
    },
    "cluster:disconnect": async ({ handle }) => {
      metrics.service.forget(handle);
      doctor.forget(handle);
      await mcp.forget(handle);
      await hub.stopAll(handle);
      await clusters.disconnect(handle);
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
    "agent:prompt": ({ session, text, context }) => agent.prompt(session, text, context),
    "agent:cancel": async ({ session }) => (await agent.cancel(session), { ok: true }),
    "agent:mode": async ({ session, mode }) => (await agent.setMode(session, mode), { ok: true }),
    "agent:config": async ({ session, config, value }) => (await agent.setConfig(session, config, value), { ok: true }),
    "agent:answer": async ({ request, option }) => (agent.answer(request, option), { ok: true }),
    "agent:decide": async ({ change, decision, note }) => (agent.decide(change, decision, note), { ok: true }),
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
    // Graphs (docs/metrics.md). The Clickland key comes in with configure and test; nothing sends it back.
    "metrics:series": (req) => metrics.service.series(req),
    "metrics:settings": async ({ context }) => metrics.settings.view(context),
    "metrics:configure": async (input) => metrics.settings.set(input),
    "metrics:test": (input) => metrics.service.test(input),
    "metrics:disconnect": async () => metrics.settings.clear(),
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
    "mcp:preset": () => mcp.preset(),
    "mcp:calls": async () => ({ calls: mcp.calls() }),
    "mcp:try": ({ handle, server, tool }) => mcp.try(handle, server, tool),
    "mcp:app-open": ({ call }) => mcp.openView(call),
    "mcp:app-call": ({ view, name, arguments: args }) => mcp.viewCall(view, name, args ?? {}),
    "mcp:app-close": async ({ view }) => (mcp.views.close(view), { ok: true }),
    "mcp:app-link": async ({ view, url }) => ({ opened: await mcp.viewLink(view, url) }),
    // Connections (docs/connections.md). A token comes in on conn:token; nothing sends one back. A sign-in belongs to
    // the window that started it.
    "conn:list": async () => connections.list(),
    "conn:github-device": async (_r, event) => connections.githubDevice(flowOwner(event.sender)),
    "conn:linear-signin": async ({ mode }, event) => connections.linearSignIn(mode, flowOwner(event.sender)),
    "conn:token": ({ provider, token }) => connections.token(provider, token),
    "conn:cancel": async ({ flow }, event) => (connections.cancel(flow, event.sender), { ok: true }),
    "conn:set": async ({ provider, mode, readsAuto }) => connections.set(provider, { ...(mode ? { mode } : {}), ...(readsAuto !== undefined ? { readsAuto } : {}) }),
    "conn:test": ({ provider }) => connections.test(provider),
    "conn:repin": async ({ provider }) => connections.repin(provider),
    "conn:disconnect": ({ provider }) => connections.disconnect(provider),
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

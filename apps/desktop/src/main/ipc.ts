// Every renderer request lands here: checked to come from our own page, validated with the contract's schema, then
// answered. Errors cross as JSON {status, message} so the UI can tell "no access" from "failed".
import { channels, type Channel, type KubeObject, type Request, type Responses, type ResourceType, type WatchEvent } from "@landlens/contracts";
import { checkAccess, clusterHealth, KubeError, listContexts, withoutSecretValues, type ClusterManager, type WatchHub } from "@landlens/kube";
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { MetricsService } from "@landlens/metrics";
import type { AgentService } from "./agent";
import type { ClicklandSettingsStore } from "./clickland-settings";
import type { McpService } from "./mcp";
import { isAppUrl } from "./security";

type Handlers = { [C in Channel]: (req: Request<C>, event: IpcMainInvokeEvent) => Promise<Responses[C]> };

export function registerIpc(clusters: ClusterManager, hub: WatchHub, agent: AgentService, metrics: { service: MetricsService; settings: ClicklandSettingsStore }, mcp: McpService) {
  /** Subscriptions per renderer, so a closed window stops its watches. */
  const owned = new Map<WebContents, Set<string>>();

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
      return clusters.connect(context);
    },
    "cluster:disconnect": async ({ handle }) => {
      metrics.service.forget(handle);
      await mcp.forget(handle);
      await hub.stopAll(handle);
      await clusters.disconnect(handle);
      return { ok: true };
    },
    "cluster:discovery": async ({ handle }) => ({ types: await clusters.discovery(handle) }),
    "cluster:access": async ({ handle, checks }) => ({ allowed: await checkAccess(clusters.get(handle).client, checks) }),
    "cluster:health": async ({ handle, namespace }) => {
      const client = clusters.get(handle).client;
      return clusterHealth((path) => client.json(path), namespace ? { namespace } : {});
    },
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
    "agent:close": async ({ session }) => (await agent.close(session), { ok: true }),
    // Graphs (docs/metrics.md). The Clickland key comes in with configure and test; nothing sends it back.
    "metrics:series": (req) => metrics.service.series(req),
    "metrics:settings": async ({ context }) => metrics.settings.view(context),
    "metrics:configure": async (input) => metrics.settings.set(input),
    "metrics:test": (input) => metrics.service.test(input),
    "metrics:disconnect": async () => metrics.settings.clear(),
    // MCP (docs/mcp.md). A server's header value comes in with save and test; nothing sends it back.
    "mcp:servers": ({ context }) => mcp.servers(context),
    "mcp:save": async (input) => mcp.save(input),
    "mcp:test": (req) => mcp.test(req),
    "mcp:enable": async ({ id, context, enabled }) => mcp.enable(id, context, enabled),
    "mcp:remove": async ({ id }) => (mcp.remove(id), { ok: true }),
    "mcp:preset": () => mcp.preset(),
    "mcp:calls": async () => ({ calls: mcp.calls() }),
    "mcp:try": ({ handle, server, tool }) => mcp.try(handle, server, tool),
    "mcp:app-open": ({ call }) => mcp.openView(call),
    "mcp:app-call": ({ view, name, arguments: args }) => mcp.viewCall(view, name, args ?? {}),
    "mcp:app-close": async ({ view }) => (mcp.views.close(view), { ok: true }),
    "mcp:app-link": async ({ view, url }) => ({ opened: await mcp.viewLink(view, url) }),
  };

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

const isSecrets = (t: ResourceType) => t.group === "" && t.resource === "secrets";

const ipcError = (status: number, message: string) => new Error(JSON.stringify({ status, message }));

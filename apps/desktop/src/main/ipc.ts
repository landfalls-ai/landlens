// Every renderer request lands here: checked to come from our own page, validated with the contract's schema, then
// answered. Errors cross as JSON {status, message} so the UI can tell "no access" from "failed".
import { channels, type Channel, type Request, type Responses, type WatchEvent } from "@landlens/contracts";
import { checkAccess, KubeError, listContexts, withoutSecretValues, type ClusterManager, type WatchHub } from "@landlens/kube";
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { isAppUrl } from "./security";

type Handlers = { [C in Channel]: (req: Request<C>, event: IpcMainInvokeEvent) => Promise<Responses[C]> };

export function registerIpc(clusters: ClusterManager, hub: WatchHub) {
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
    "cluster:connect": ({ context }) => clusters.connect(context),
    "cluster:disconnect": async ({ handle }) => {
      await hub.stopAll(handle);
      await clusters.disconnect(handle);
      return { ok: true };
    },
    "cluster:discovery": async ({ handle }) => ({ types: await clusters.discovery(handle) }),
    "cluster:access": async ({ handle, checks }) => ({ allowed: await checkAccess(clusters.get(handle).client, checks) }),
    "resource:get": async ({ handle, ref }) => ({ object: withoutSecretValues(await clusters.getObject(handle, ref)) }),
    "resource:events": async ({ handle, uid, namespace }) => ({ items: await clusters.eventsFor(handle, uid, namespace) }),
    "watch:subscribe": async (req, event) => {
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
              ? { subscription, type: "snapshot", items: e.items.map(withoutSecretValues) }
              : { subscription, type: "delta", upserted: e.upserted.map(withoutSecretValues), removed: e.removed };
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
  };

  for (const name of Object.keys(channels) as Channel[]) {
    ipcMain.handle(name, async (event, raw) => {
      if (!isAppUrl(event.senderFrame?.url ?? "")) throw ipcError(403, "not from Landlens");
      const parsed = channels[name].safeParse(raw ?? {});
      if (!parsed.success) throw ipcError(400, `bad request for ${name}: ${parsed.error.message}`);
      try {
        return await (handlers[name] as (r: unknown, e: IpcMainInvokeEvent) => Promise<unknown>)(parsed.data, event);
      } catch (err) {
        if (err instanceof KubeError) throw ipcError(err.status, err.message);
        const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
        throw ipcError(status, (err as Error).message ?? String(err));
      }
    });
  }
}

const ipcError = (status: number, message: string) => new Error(JSON.stringify({ status, message }));

// Main's own question, in a native dialog on the asking window: the renderer can't answer it (wave 6 part 5, L3). Used
// for a GKE cluster's first connect, links out, telemetry's collector, the brain's wider sends, and your widest
// actions (wave 8, D143). Cancel is the default.
import { BrowserWindow, dialog, type WebContents } from "electron";

export type Confirm = (q: { message: string; detail: string; yes: string }) => Promise<boolean>;

export const nativeConfirm = (wc: WebContents): Confirm => async ({ message, detail, yes }) => {
  const win = BrowserWindow.fromWebContents(wc);
  const opts = { type: "question" as const, buttons: [yes, "Cancel"], defaultId: 1, cancelId: 1, message, detail, noLink: true };
  const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return r.response === 0;
};

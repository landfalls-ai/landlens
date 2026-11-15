// The dock's width (wave 6): dragged or set with the arrow keys on its left edge, remembered in localStorage. Pure rules
// here, so they are tested without a DOM.

export const DOCK = { min: 320, max: 960, wide: 392, narrow: 360, step: 16, table: 600, rail: 52, drawer: 372 } as const;
export const DOCK_KEY = "landlens.dock.width";

/** The widest the dock may be: the rail and ~600px of table stay, and beside a drawer (wide windows) the drawer too. */
export function dockMax(app: number, drawer: boolean, narrow: boolean): number {
  const room = app - DOCK.rail - DOCK.table - (drawer && !narrow ? DOCK.drawer : 0);
  return Math.max(DOCK.min, Math.min(DOCK.max, Math.floor(room)));
}

/** The width to show: what you chose (or the default for the window), held between the minimum and dockMax. */
export function dockWidth(chosen: number | undefined, app: number, drawer: boolean, narrow: boolean): number {
  const want = chosen ?? (narrow ? DOCK.narrow : DOCK.wide);
  return Math.min(dockMax(app, drawer, narrow), Math.max(DOCK.min, Math.round(want)));
}

/** A stored width, or undefined for nothing usable (a hand-edited or old value). */
export function readDockWidth(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= DOCK.min && n <= DOCK.max ? Math.round(n) : undefined;
}

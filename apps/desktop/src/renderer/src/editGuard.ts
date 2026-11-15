// Leaving an edit with changes asks first (D31). The open editor registers a guard; anything that would take it away
// (another row, closing the drawer, another page) calls leaveEdit with what it wants to do, which runs at once when
// nothing is changed, or after the person says Discard in the editor's foot.
let guard: ((go: () => void) => boolean) | undefined;

export function setEditGuard(g: ((go: () => void) => boolean) | undefined) {
  guard = g;
}

export function leaveEdit(go: () => void) {
  if (guard && !guard(go)) return;
  go();
}

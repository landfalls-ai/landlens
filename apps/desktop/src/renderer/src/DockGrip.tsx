// The dock's left edge (wave 6): drag it, or focus it and use ← → (Home and End for the narrowest and widest);
// a double click goes back to the default. The same pattern as the panel's grip (Bench.tsx).
import { useState } from "react";
import { DOCK } from "./dockWidth";

export function DockGrip(props: { width: number; max: number; onWidth: (w: number | undefined) => void }) {
  const [drag, setDrag] = useState(false);
  const set = (w: number) => props.onWidth(Math.min(props.max, Math.max(DOCK.min, Math.round(w))));

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = props.width;
    setDrag(true);
    document.body.classList.add("resizing-x");
    // The dock sits on the right: moving left makes it wider.
    const move = (ev: PointerEvent) => set(startW + (startX - ev.clientX));
    const up = () => {
      setDrag(false);
      document.body.classList.remove("resizing-x");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return (
    <div className={"dock-grip" + (drag ? " drag" : "")} role="separator" aria-orientation="vertical" aria-label="Resize Claude's panel"
      title="Drag to resize · double-click for the default width" tabIndex={0}
      aria-valuemin={DOCK.min} aria-valuemax={props.max} aria-valuenow={props.width}
      onPointerDown={onDown} onDoubleClick={() => props.onWidth(undefined)}
      onKeyDown={(e) => {
        const k = e.key;
        if (k === "ArrowLeft") (e.preventDefault(), set(props.width + DOCK.step));
        else if (k === "ArrowRight") (e.preventDefault(), set(props.width - DOCK.step));
        else if (k === "Home") (e.preventDefault(), set(DOCK.min));
        else if (k === "End") (e.preventDefault(), set(props.max));
      }} />
  );
}

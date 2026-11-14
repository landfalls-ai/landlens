import { useCallback, useRef, useState } from "react";

/** An element's content width, kept current with a ResizeObserver; a callback ref, so a remounted element is followed. */
export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const ro = useRef<ResizeObserver>(undefined);
  const ref = useCallback((el: T | null) => {
    ro.current?.disconnect();
    if (!el) return;
    ro.current = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    ro.current.observe(el);
    setWidth(Math.floor(el.clientWidth));
  }, []);
  return [ref, width];
}

import { type RefObject, useLayoutEffect, useRef, useState } from "react";

export interface InstrumentInsets {
  top: number;
  left: number;
}

/**
 * The instruments' footprint as map insets: {top} under the portrait
 * strip, {left} beside the landscape rail. Shape is inferred from the
 * measured box (full-width = strip), so CSS stays the one layout owner.
 *
 * The returned ref goes on the instruments box; the host it measures
 * against is that box's parent (the recording screen).
 */
export function useInstrumentInsets(): {
  ref: RefObject<HTMLDivElement | null>;
  insets: InstrumentInsets;
} {
  const ref = useRef<HTMLDivElement>(null);
  const [insets, setInsets] = useState<InstrumentInsets>({ top: 0, left: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      // The rail is LEFT-ANCHORED and FULL-HEIGHT — width alone also
      // matches the >=768px floating card (right-anchored, 400px), which
      // must keep insetting the TOP like the portrait strip does, or
      // iPad/desktop center the aircraft toward the card. Shape, not
      // breakpoint, so CSS stays the one layout owner.
      const rail = rect.left <= 1 && rect.height >= host.clientHeight - 1;
      if (rail) {
        setInsets({ top: 0, left: rect.width });
        return;
      }
      setInsets({ top: rect.height, left: 0 });
    };
    measure();
    // ResizeObserver, not window.resize: WKWebView can fire resize before
    // rotated env() insets settle (the exact stale-read class INSETS.md's
    // probe bridge exists for); the observer fires again when the boxes
    // themselves land.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  return { ref, insets };
}

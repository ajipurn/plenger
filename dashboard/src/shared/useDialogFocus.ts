import { useEffect, useRef } from "react";

/** Keep an explicit return target when an action replaces its invoking element. */
export function useDialogFocus(open: boolean, returnFocus: () => HTMLElement | null | undefined) {
  const wasOpen = useRef(open);
  useEffect(() => {
    let frame: number | undefined;
    if (wasOpen.current && !open) {
      frame = requestAnimationFrame(() => {
        const target = returnFocus();
        if (target?.isConnected) target.focus({ preventScroll: true });
      });
    }
    wasOpen.current = open;
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [open, returnFocus]);
}

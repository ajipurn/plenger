import { useEffect, useRef } from "react";

/** Keep an explicit return target when an action replaces its invoking element. */
export function useDialogFocus(open: boolean, returnFocus: () => HTMLElement | null | undefined) {
  const wasOpen = useRef(open);
  // Callers pass a new function each render; read the latest one when the frame runs.
  const target = useRef(returnFocus);
  useEffect(() => {
    target.current = returnFocus;
  });
  // Only reopening or unmounting cancels the pending focus. A re-render while the dialog
  // closes, such as a refresh after its action, must not.
  useEffect(() => {
    let frame: number | undefined;
    if (wasOpen.current && !open) {
      frame = requestAnimationFrame(() => {
        const element = target.current();
        if (element?.isConnected) element.focus({ preventScroll: true });
      });
    }
    wasOpen.current = open;
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [open]);
}

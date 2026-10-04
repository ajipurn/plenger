import { useSyncExternalStore } from "react";
import { TextMorph } from "torph/react";

const motionQuery = "(prefers-reduced-motion: reduce)";
function subscribe(onChange: () => void) {
  const media = window.matchMedia(motionQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Animate changing numeric values while honoring the user's reduced-motion setting. */
export function MorphNumber({ value }: { value: number }) {
  const reduce = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(motionQuery).matches,
    () => true,
  );
  return (
    <TextMorph
      duration={200}
      ease="cubic-bezier(0.77, 0, 0.175, 1)"
      scale={false}
      numbers
      disabled={reduce}
      respectReducedMotion
    >
      {value}
    </TextMorph>
  );
}

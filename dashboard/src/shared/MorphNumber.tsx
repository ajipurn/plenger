import { useSyncExternalStore } from "react";
import { TextMorph } from "torph/react";

const motionQuery = "(prefers-reduced-motion: reduce)";
function subscribe(onChange: () => void) {
  const media = window.matchMedia(motionQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Torph Counter tick: changed places roll while unchanged digits and units stay still. */
export function MorphNumber({ value }: { value: number | string }) {
  const reduce = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(motionQuery).matches,
    () => true,
  );
  return (
    <TextMorph
      className="tabular-nums"
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

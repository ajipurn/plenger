import { useSyncExternalStore } from "react";
import { TextMorph } from "torph/react";

const motionQuery = "(prefers-reduced-motion: reduce)";
function subscribe(onChange: () => void) {
  const media = window.matchMedia(motionQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Native numeric place matching, or a quieter text transition for dates and timestamps. */
export function MorphNumber({
  value,
  variant = "number",
}: {
  value: number | string;
  variant?: "number" | "text";
}) {
  const reduce = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(motionQuery).matches,
    () => true,
  );
  return (
    <TextMorph
      className="tabular-nums"
      numbers={variant === "number"}
      {...(variant === "text" ? { duration: 200 } : {})}
      scale={variant === "number"}
      disabled={reduce}
      respectReducedMotion
    >
      {value}
    </TextMorph>
  );
}

/** Animate numeric slots in prose while keeping surrounding text and wrapping natural. */
export function NumericText({ children }: { children: string }) {
  const parts = children.split(/([-+]?[$€£]?\d+(?:[.,:\u00a0\u202f]\d+)*(?:%|‰)?)/);
  let slot = 0;
  return parts.map((part, index) =>
    index % 2 === 0 ? part : <MorphNumber key={`number-${slot++}`} value={part} />,
  );
}

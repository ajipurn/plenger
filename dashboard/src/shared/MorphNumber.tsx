import { useState, useSyncExternalStore } from "react";
import { TextMorph } from "torph/react";

// One query serves every value; a long scan's cost tables hold thousands.
let motion: MediaQueryList | undefined;
function reducedMotion(): MediaQueryList {
  motion ??= window.matchMedia("(prefers-reduced-motion: reduce)");
  return motion;
}
function subscribe(onChange: () => void) {
  const media = reducedMotion();
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
    () => reducedMotion().matches,
    () => true,
  );
  // Torph measures every glyph when it attaches, and a table holds dozens of values.
  // A value stays plain text until it first changes; Torph then attaches to the old
  // value and morphs to the new one.
  const [initial] = useState(value);
  const [changed, setChanged] = useState(false);
  if (!changed && value !== initial) setChanged(true);
  return (
    <TextMorph
      className="tabular-nums"
      numbers={variant === "number"}
      {...(variant === "text" ? { duration: 200 } : {})}
      scale={variant === "number"}
      disabled={reduce || !changed}
      // `reduce` already follows the setting, so Torph does not open a query per value.
      respectReducedMotion={false}
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

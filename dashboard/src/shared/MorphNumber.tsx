import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { TextMorph } from "torph/react";

const motionQuery = "(prefers-reduced-motion: reduce)";
const countSteps = 8;
const countStepMs = 200;
function subscribe(onChange: () => void) {
  const media = window.matchMedia(motionQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Count through eight gentle Torph rolls, retargeting from the current displayed value. */
function useCountedValue(value: number | null, enabled: boolean) {
  const [displayed, setDisplayed] = useState(value);
  const current = useRef(value);
  useEffect(() => {
    const from = current.current;
    if (!enabled || value === null || from === null) {
      current.current = value;
      setDisplayed(value);
      return;
    }
    if (from === value) return;
    const started = performance.now();
    let frame = 0;
    let previousStep = 0;
    const tick = (now: number) => {
      const step = Math.min(countSteps, Math.floor((now - started) / countStepMs));
      if (step > previousStep) {
        previousStep = step;
        const next = step === countSteps ? value : from + ((value - from) * step) / countSteps;
        current.current = next;
        setDisplayed(next);
      }
      if (step < countSteps) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, enabled]);
  return enabled ? (displayed ?? value) : value;
}

/** Torph rolls changed places. Usage counters can also count through intermediate values. */
export function MorphNumber({
  value,
  count = false,
  format,
}: {
  value: number | string;
  count?: boolean;
  format?: (value: number) => string;
}) {
  const reduce = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(motionQuery).matches,
    () => true,
  );
  const counting = count && typeof value === "number";
  const displayed = useCountedValue(counting ? value : null, !reduce);
  const label = (amount: number) =>
    format ? format(amount) : Math.round(amount).toLocaleString("en-US");
  const text = counting ? label(displayed ?? value) : value;
  const morph = (
    <TextMorph
      className="tabular-nums"
      duration={counting ? countStepMs : 200}
      ease={counting ? "linear" : "cubic-bezier(0.77, 0, 0.175, 1)"}
      scale={false}
      numbers
      disabled={reduce}
      respectReducedMotion
    >
      {text}
    </TextMorph>
  );
  return counting ? (
    <span className="tabular-nums">
      <span className="sr-only">{label(value)}</span>
      <span aria-hidden="true">{morph}</span>
    </span>
  ) : (
    morph
  );
}

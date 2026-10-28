import gsap from "gsap";

/**
 * Redaction ships cuts from clean to fully pixelated. Their widths differ by about 2%,
 * so callers keep lines from rewrapping while `data-redact` swaps them. CSS maps each
 * value to its cut.
 */
const CUTS = ["100", "70", "35"] as const;

/**
 * Sets each element's cut for a progress from 0 (fully redacted) to 1 (clean). With a
 * `spread` above 0, later elements start later, so text clears in reading order.
 */
export function applyRedaction(elements: HTMLElement[], progress: number, spread = 0.6) {
  const last = Math.max(1, elements.length - 1);
  elements.forEach((element, index) => {
    const start = elements.length > 1 ? (index / last) * spread : 0;
    const local = Math.min(1, Math.max(0, (progress - start) / (1 - spread)));
    const cut = CUTS[Math.floor(local * (CUTS.length + 1))];
    if (cut) element.dataset.redact = cut;
    else delete element.dataset.redact;
  });
}

/** A tween that clears `elements` from redacted to clean text. */
export function unredact(elements: HTMLElement[], vars: gsap.TweenVars = {}) {
  const state = { progress: 0 };
  applyRedaction(elements, 0);
  return gsap.to(state, {
    progress: 1,
    duration: 1,
    ease: "none",
    ...vars,
    onUpdate: () => applyRedaction(elements, state.progress),
  });
}

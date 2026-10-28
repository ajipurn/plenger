import gsap from "gsap";
import type Lenis from "lenis";

const finePointer = () => window.matchMedia("(hover: hover) and (pointer: fine)").matches;

/** A ring that trails the pointer and grows over links; labelled targets fill it. */
export function setupCursor() {
  const root = document.querySelector<HTMLElement>("[data-cursor]");
  const ring = root?.querySelector<HTMLElement>("[data-cursor-ring]");
  const label = root?.querySelector<HTMLElement>("[data-cursor-label]");
  if (!root || !ring || !label || !finePointer()) return;

  const x = gsap.quickTo(ring, "x", { duration: 0.5, ease: "power3.out" });
  const y = gsap.quickTo(ring, "y", { duration: 0.5, ease: "power3.out" });
  let placed = false;

  window.addEventListener(
    "pointermove",
    (event) => {
      if (!placed) {
        gsap.set(ring, { x: event.clientX, y: event.clientY });
        placed = true;
      }
      x(event.clientX);
      y(event.clientY);
      root.classList.add("is-visible");
    },
    { passive: true },
  );
  document.documentElement.addEventListener("pointerleave", () => {
    root.classList.remove("is-visible");
  });
  document.addEventListener("pointerover", (event) => {
    const target = (event.target as Element | null)?.closest<HTMLElement>(
      "[data-cursor-hover], a, button, [data-stride-item]",
    );
    const text = target?.dataset.cursorHover ?? "";
    root.classList.toggle("is-hover", Boolean(target));
    root.classList.toggle("has-label", text.length > 0);
    label.textContent = text;
  });
}

/** Buttons lean toward the pointer and settle back when it leaves. */
export function setupMagnetic() {
  if (!finePointer()) return;
  for (const element of document.querySelectorAll<HTMLElement>("[data-magnetic]")) {
    const x = gsap.quickTo(element, "x", { duration: 0.7, ease: "power3.out" });
    const y = gsap.quickTo(element, "y", { duration: 0.7, ease: "power3.out" });
    element.addEventListener("pointermove", (event) => {
      const box = element.getBoundingClientRect();
      x((event.clientX - (box.left + box.width / 2)) * 0.22);
      y((event.clientY - (box.top + box.height / 2)) * 0.35);
    });
    element.addEventListener("pointerleave", () => {
      x(0);
      y(0);
    });
  }
}

/** Cards light up under the pointer. */
export function setupSpotlights() {
  for (const card of document.querySelectorAll<HTMLElement>("[data-card]")) {
    card.addEventListener("pointermove", (event) => {
      const box = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${event.clientX - box.left}px`);
      card.style.setProperty("--my", `${event.clientY - box.top}px`);
    });
  }
}

/**
 * The marquee loops in CSS from the first paint. Once smooth scroll runs, scrolling
 * speeds the loop up and turns it with the scroll direction.
 */
export function setupMarqueeBoost(lenis: Lenis) {
  const loop = document.querySelector<HTMLElement>("[data-marquee]")?.getAnimations()[0];
  if (!loop) return;
  let direction = 1;
  let boost = 0;
  lenis.on("scroll", ({ velocity }: Lenis) => {
    if (Math.abs(velocity) > 0.2) direction = Math.sign(velocity);
    boost = Math.max(boost, Math.min(Math.abs(velocity) * 0.12, 5));
  });
  gsap.ticker.add(() => {
    boost *= 0.94;
    const rate = loop.playbackRate;
    loop.playbackRate = rate + (direction * (1 + boost) - rate) * 0.08;
  });
}

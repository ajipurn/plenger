import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import type { ParticleScene } from "../scene/particles.ts";

/**
 * Drives the process section while its sticky panel holds the screen. Each quarter of
 * the scroll activates one step; flagged lines turn into findings as the scan line
 * passes. CSS sizes the section, so nothing moves when this starts late.
 */
export function setupProcess(scene: ParticleScene | null, reduced: boolean) {
  const section = document.querySelector<HTMLElement>("[data-process]");
  if (!section) return;
  const steps = [...section.querySelectorAll<HTMLElement>("[data-step]")];
  const bar = section.querySelector<HTMLElement>("[data-process-bar]");
  const value = section.querySelector<HTMLElement>("[data-process-value]");
  let active = -1;

  const apply = (progress: number) => {
    if (scene) scene.state.scan = progress;
    if (bar) bar.style.transform = `scaleX(${progress})`;
    if (value) value.textContent = String(Math.round(progress * 100)).padStart(3, "0");
    const next = Math.min(steps.length - 1, Math.floor(progress * steps.length));
    if (next === active) return;
    active = next;
    steps.forEach((step, index) => {
      step.classList.toggle("is-active", index === active);
    });
  };

  if (reduced) {
    // Every step stays open; the findings light up once the section is reached.
    if (bar) bar.style.transform = "scaleX(1)";
    if (value) value.textContent = "100";
    ScrollTrigger.create({
      trigger: section,
      start: "top 60%",
      onEnter: () => {
        if (scene) scene.state.scan = 1;
      },
    });
    return;
  }

  apply(0);
  const progress = { value: 0 };
  gsap.to(progress, {
    value: 1,
    ease: "none",
    onUpdate: () => apply(progress.value),
    scrollTrigger: { trigger: section, start: "top top", end: "bottom bottom", scrub: 1 },
  });
}

/**
 * Lights one STRIDE arc at a time. Scrolling through the list moves the light; hover
 * takes over while it lasts.
 */
export function setupStride(scene: ParticleScene | null) {
  const list = document.querySelector<HTMLElement>("[data-stride]");
  if (!list) return;
  const items = [...list.querySelectorAll<HTMLElement>("[data-stride-item]")];
  let scrolled = -1;
  let pointed = -1;
  let shown = -1;

  const apply = () => {
    const active = pointed >= 0 ? pointed : scrolled;
    if (active === shown) return;
    shown = active;
    items.forEach((item, index) => {
      item.classList.toggle("is-active", index === active);
    });
    scene?.segments.forEach((segment, index) => {
      gsap.to(segment, {
        value: index === active ? 1 : 0,
        duration: 0.8,
        ease: "power2.out",
        overwrite: true,
      });
    });
  };

  // Item tops crossing 62% of the viewport; positions are read on every update.
  const marks = items.map((item) => ScrollTrigger.create({ trigger: item, start: "top 62%" }));
  ScrollTrigger.create({
    trigger: list,
    start: "top 62%",
    end: "bottom 62%",
    onUpdate: (self) => {
      const scroll = self.scroll();
      scrolled = self.isActive ? marks.findLastIndex((mark) => scroll >= mark.start) : -1;
      apply();
    },
    onToggle: (self) => {
      if (self.isActive) return;
      scrolled = -1;
      apply();
    },
  });

  items.forEach((item, index) => {
    item.addEventListener("pointerenter", () => {
      pointed = index;
      apply();
    });
    item.addEventListener("pointerleave", () => {
      pointed = -1;
      apply();
    });
  });
}

/** The dashboard mock tilts up into place and leans toward the pointer. */
export function setupShowcase(reduced: boolean) {
  const stage = document.querySelector<HTMLElement>("[data-showcase]");
  const app = stage?.querySelector<HTMLElement>(".app");
  if (!stage || !app || reduced) return;
  // Already in view when the motion bundle arrived: keep the mock still.
  if (stage.getBoundingClientRect().top < window.innerHeight * 0.9) return;

  gsap.fromTo(
    app,
    { rotationX: 28, y: 80, scale: 0.86, transformPerspective: 1800 },
    {
      rotationX: 0,
      y: 0,
      scale: 1,
      ease: "none",
      scrollTrigger: { trigger: stage, start: "top 95%", end: "top 20%", scrub: 1 },
    },
  );
  gsap.from(app.querySelectorAll("[data-row]"), {
    x: -18,
    autoAlpha: 0,
    duration: 1,
    ease: "power3.out",
    stagger: 0.08,
    scrollTrigger: { trigger: app, start: "top 65%", once: true },
  });

  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  const tilt = gsap.quickTo(app, "rotationY", { duration: 1.2, ease: "power3.out" });
  stage.addEventListener("pointermove", (event) => {
    const box = stage.getBoundingClientRect();
    tilt(((event.clientX - box.left) / box.width - 0.5) * 6);
  });
  stage.addEventListener("pointerleave", () => tilt(0));
}

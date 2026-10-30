import gsap from "gsap";
import { directScenes } from "./director.ts";
import { createParticleScene, type ParticleScene } from "./particles.ts";

const CAMERA_FOV = 35;
const CAMERA_DISTANCE = 9;

/**
 * Starts the particle field. Particles arrive from the dust over the hero's static
 * emblem, which fades out, then follow the sections. Without WebGL the static emblem
 * stays and the page reads as before.
 */
export function startScene(reduced: boolean, monoFont: string): ParticleScene | null {
  const html = document.documentElement;
  const canvas = document.querySelector<HTMLCanvasElement>("[data-webgl]");
  if (!canvas) return null;
  let scene: ParticleScene;
  try {
    scene = createParticleScene(canvas, monoFont);
  } catch {
    html.classList.add("no-webgl");
    return null;
  }

  const glow = document.querySelector<HTMLElement>(".glow");
  let unit = 0;
  const measure = () => {
    unit = window.innerHeight / (2 * CAMERA_DISTANCE * Math.tan((CAMERA_FOV * Math.PI) / 360));
  };
  measure();
  window.addEventListener("resize", () => {
    scene.resize();
    measure();
  });
  window.addEventListener(
    "pointermove",
    (event) => {
      scene.pointer(
        (event.clientX / window.innerWidth) * 2 - 1,
        -(event.clientY / window.innerHeight) * 2 + 1,
      );
    },
    { passive: true },
  );
  html.addEventListener("pointerleave", () => scene.pointer(9, 9));

  const compact = window.matchMedia("(max-width: 899px)");
  gsap.ticker.add((time) => {
    // Compact layouts use the in-flow static shield and keep particles off the copy.
    if (compact.matches) return;
    scene.render(reduced ? 0 : time);
    if (glow) {
      glow.style.transform = `translate3d(${scene.state.x * unit}px, ${-scene.state.y * unit}px, 0)`;
    }
  });

  directScenes(scene, reduced);
  html.classList.add("has-scene");
  if (reduced) scene.state.intro = 1;
  else gsap.to(scene.state, { intro: 1, duration: 3.4, ease: "power2.out" });
  return scene;
}

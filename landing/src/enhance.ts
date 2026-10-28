import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import {
  setupCursor,
  setupMagnetic,
  setupMarqueeBoost,
  setupSpotlights,
} from "./motion/interactions.ts";
import { setupProcess, setupShowcase, setupStride } from "./motion/sections.ts";
import { createSmoothScroll } from "./motion/smooth.ts";
import { setupReveals } from "./motion/text.ts";

const MONO_FONT = '"Kode Mono Variable"';
const DISPLAY_FONTS = ['"Redaction"', '"Redaction 35"', '"Redaction 70"', '"Redaction 100"'];

/** Fonts decide line breaks and the sampled code, so wait for them, but not forever. */
async function fontsReady() {
  const loaded = Promise.all([
    document.fonts.load(`500 30px ${MONO_FONT}`),
    ...DISPLAY_FONTS.map((family) => document.fonts.load(`400 30px ${family}`)),
    document.fonts.ready,
  ]).catch(() => undefined);
  await Promise.race([loaded, new Promise((resolve) => window.setTimeout(resolve, 2500))]);
}

/** Layers motion and the particle field over the finished HTML page. */
export async function enhance() {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  gsap.registerPlugin(ScrollTrigger, SplitText);
  // three.js is the largest download; start it while the fonts settle.
  const stage = import("./scene/stage.ts");
  const lenis = reduced ? null : createSmoothScroll();

  await fontsReady();
  document.documentElement.classList.add("is-enhanced");
  const scene = await stage
    .then(({ startScene }) => startScene(reduced, `${MONO_FONT}, monospace`))
    .catch(() => null);

  setupProcess(scene, reduced);
  setupStride(scene);
  setupSpotlights();
  if (lenis) setupMarqueeBoost(lenis);
  if (!reduced) {
    setupReveals();
    setupShowcase(reduced);
    setupCursor();
    setupMagnetic();
  }
  ScrollTrigger.refresh();
}

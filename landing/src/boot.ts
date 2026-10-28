import { setupCopy, setupNav } from "./motion/chrome.ts";

/**
 * Web fonts load in two stages. The first paint uses local faces sized to match them,
 * so it never waits for a download; the `fonts` class switches to the web fonts on the
 * next frame. Once they have loaded, a flag lets later visits switch before the first
 * paint (see the inline script in Page.astro), when the fonts come from the cache.
 */
const FONTS_KEY = "plenger:fonts";
const FONT_FACES = ['400 1em "Redaction"', '400 1em "Kode Mono Variable"'];

function loadFonts() {
  const html = document.documentElement;
  const remember = () => {
    try {
      localStorage.setItem(FONTS_KEY, "1");
    } catch {
      // Storage is optional; without it every visit takes the two-stage path.
    }
  };
  const swap = () => {
    html.classList.add("fonts");
    void Promise.all(FONT_FACES.map((face) => document.fonts.load(face))).then(remember, () => {});
  };
  if (html.classList.contains("fonts")) swap();
  else requestAnimationFrame(() => requestAnimationFrame(swap));
}

/**
 * The page is complete as HTML and CSS. Smooth scroll, reveals and the particle field
 * load on the first input; until then the hero shows the static emblem.
 */
const INPUTS = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;

loadFonts();
setupCopy();
setupNav();

let started = false;
function start() {
  if (started) return;
  started = true;
  for (const type of INPUTS) window.removeEventListener(type, start);
  void import("./enhance.ts").then(({ enhance }) => enhance());
}

for (const type of INPUTS) window.addEventListener(type, start, { passive: true });

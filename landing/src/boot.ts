import { setupCopy, setupNav } from "./motion/chrome.ts";

const FONT_FACES = [
  '400 1em "Redaction"',
  '400 1em "Redaction 35"',
  '400 1em "Redaction 70"',
  '400 1em "Redaction 100"',
  '400 1em "Kode Mono Variable"',
  '400 1em "Geist Variable"',
  '400 1em "Geist Mono Variable"',
  '400 1em "Sacramento"',
];

/** Reveal one stable set of fonts. A timed-out visit keeps its local fallbacks. */
async function loadFonts() {
  const html = document.documentElement;
  try {
    const loaded = await Promise.all(FONT_FACES.map((face) => document.fonts.load(face)));
    // The inline deadline may have already revealed the page while downloads continued.
    if (html.classList.contains("is-loading") && loaded.every((faces) => faces.length > 0)) {
      html.classList.add("fonts");
    }
  } catch {
    // Keep every family on its readable local fallback if a download fails.
  } finally {
    html.classList.remove("is-loading");
  }
}

/**
 * The page is complete as HTML and CSS. Smooth scroll, reveals and the particle field
 * load on the first input; until then the hero shows the static emblem.
 */
const INPUTS = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;

void loadFonts();
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

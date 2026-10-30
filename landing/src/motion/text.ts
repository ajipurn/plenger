import gsap from "gsap";
import { SplitText } from "gsap/SplitText";
import { unredact } from "./redact.ts";

/**
 * The motion bundle loads on the first interaction, so the reader may already see part
 * of the page. Only content still below the fold gets an entrance; the rest stays put.
 */
const ahead = (element: Element) => element.getBoundingClientRect().top > window.innerHeight * 0.9;

/** Headings rise line by line from a mask and clear from redacted; blocks fade up once. */
export function setupReveals() {
  for (const heading of document.querySelectorAll<HTMLElement>("[data-split]")) {
    if (!ahead(heading)) continue;
    SplitText.create(heading, {
      type: "lines",
      mask: "lines",
      linesClass: "line",
      autoSplit: true,
      onSplit: (self) => {
        const lines = self.lines as HTMLElement[];
        return gsap
          .timeline({ scrollTrigger: { trigger: heading, start: "top 85%", once: true } })
          .from(lines, { yPercent: 108, duration: 1.4, ease: "expo.out", stagger: 0.1 }, 0)
          .add(unredact(lines, { duration: 1.2 }), 0.15);
      },
    });
  }

  for (const block of document.querySelectorAll<HTMLElement>("[data-fade]")) {
    if (!ahead(block)) continue;
    gsap.from(block, {
      y: 28,
      autoAlpha: 0,
      duration: 1.2,
      ease: "power3.out",
      scrollTrigger: { trigger: block, start: "top 90%", once: true },
    });
  }

  for (const group of document.querySelectorAll<HTMLElement>(".agentic-grid, .stats")) {
    if (!ahead(group)) continue;
    gsap.from(group.querySelectorAll("[data-card]"), {
      y: 70,
      autoAlpha: 0,
      duration: 1.3,
      ease: "expo.out",
      stagger: 0.1,
      scrollTrigger: { trigger: group, start: "top 85%", once: true },
    });
  }

  for (const value of document.querySelectorAll<HTMLElement>("[data-count]")) {
    const target = Number(value.dataset.count);
    if (!target || !ahead(value)) continue;
    gsap.from(value, {
      textContent: 0,
      duration: 1.8,
      ease: "power2.out",
      snap: { textContent: 1 },
      scrollTrigger: { trigger: value, start: "top 90%", once: true },
    });
  }

  const hero = document.querySelector<HTMLElement>(".hero");
  if (hero) {
    gsap.to(".hero-title", {
      yPercent: -22,
      ease: "none",
      scrollTrigger: { trigger: hero, start: "top top", end: "bottom top", scrub: true },
    });
  }

  // The footer, not the shifted word, sets the range: its bottom is the end of the page,
  // so the reveal always completes there.
  const word = document.querySelector<HTMLElement>("[data-footer-word]");
  const footer = word?.closest("footer");
  if (word && footer && ahead(word)) {
    gsap.fromTo(
      word,
      { yPercent: 30, clipPath: "inset(0% 0% 100% 0%)" },
      {
        yPercent: 0,
        clipPath: "inset(0% 0% 0% 0%)",
        ease: "none",
        scrollTrigger: { trigger: footer, start: "top bottom", end: "bottom bottom", scrub: true },
      },
    );
  }
}

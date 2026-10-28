/**
 * Behaviour that must work from the first paint, before the motion bundle loads. Plain
 * DOM only: importing GSAP here would put it on the critical path.
 */

/** Copies a command; if the clipboard is blocked, selects it for a manual copy. */
export function setupCopy() {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
    const state = button.querySelector<HTMLElement>("[data-copy-state]");
    const code = button.querySelector("code");
    let timer = 0;
    button.addEventListener("click", async () => {
      let message = "Copied";
      try {
        await navigator.clipboard.writeText(button.dataset.copy ?? "");
      } catch {
        if (code) window.getSelection()?.selectAllChildren(code);
        message = "Selected";
      }
      button.classList.add("is-copied");
      if (state) state.textContent = message;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        button.classList.remove("is-copied");
        if (state) state.textContent = "Copy";
      }, 1800);
    });
  }
}

/**
 * Hides the bar while reading down, shows it on the way back up, and marks the link of
 * the section that crosses the middle of the screen.
 */
export function setupNav() {
  const nav = document.querySelector<HTMLElement>("[data-nav]");
  if (!nav) return;

  let last = window.scrollY;
  let queued = false;
  const update = () => {
    queued = false;
    const y = window.scrollY;
    nav.classList.toggle("is-scrolled", y > 40);
    if (Math.abs(y - last) > 4) nav.classList.toggle("is-hidden", y > last && y > 240);
    last = y;
  };
  window.addEventListener(
    "scroll",
    () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(update);
    },
    { passive: true },
  );
  nav.addEventListener("focusin", () => nav.classList.remove("is-hidden"));

  const links = new Map<Element, HTMLAnchorElement>();
  for (const link of nav.querySelectorAll<HTMLAnchorElement>("[data-nav-link]")) {
    const target = document.querySelector(link.hash);
    if (target) links.set(target, link);
  }
  // A thin band across the middle of the viewport: a section is current while it
  // covers that band.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        links.get(entry.target)?.classList.toggle("is-current", entry.isIntersecting);
      }
    },
    { rootMargin: "-50% 0px -50% 0px" },
  );
  for (const target of links.keys()) observer.observe(target);
}

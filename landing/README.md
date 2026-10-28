# Landing page

The public landing page for plenger. It is a static Astro site with three.js,
GSAP (ScrollTrigger, SplitText) and Lenis. It is not part of the npm package and
imports nothing from `src/` or `dashboard/`.

```sh
pnpm landing          # dev server on http://127.0.0.1:4190
pnpm landing:build    # static output in landing/dist
```

`pnpm check` typechecks the scripts with `tsc`. Astro 7 needs Node.js 22.23.4 or
newer to build; CI only typechecks. Deploy `landing/dist` to any static host
that serves compressed files.

## Layout

| Path | Contents |
| --- | --- |
| `src/pages/` | `index.astro`, plus `robots.txt`, `sitemap.xml` and `llms.txt` |
| `src/layouts/Page.astro` | The document: head, fixed visual layers, the boot script |
| `src/components/` | One component per section, `Seo.astro` and the hero's `EmblemPoster.astro` |
| `src/site.ts` | Title, descriptions and the facts the structured data states |
| `src/boot.ts` | Runs at load: fonts, copy buttons, the nav, and the enhancement trigger |
| `src/enhance.ts` | Loads on the first input: smooth scroll, reveals, sections, the scene |
| `src/scene/` | The particle field: target layouts, shaders, the per-section director |
| `src/motion/` | Smooth scroll, text reveals, section drivers, pointer effects |
| `src/styles/` | `index.css` imports fonts, `base.css` (tokens and chrome) and `sections.css` |

## Performance

The page is built to score 100 in every Lighthouse category, on mobile and
desktop. It is complete as HTML and CSS. Keep these properties when you change it.

- The first paint needs only the HTML. Astro inlines the stylesheet, and the boot
  script is 2 kB.
- GSAP, Lenis and three.js load on the first pointer, key, wheel, touch or scroll
  event. Until then the hero shows `EmblemPoster`, an SVG drawing of the shield
  in the same place the particles assemble.
- Layout does not depend on scripts. The process section sticks with CSS, and the
  marquee loops in CSS. Reveals animate only content still below the fold when
  the motion bundle arrives.
- Fonts load in two stages. The first paint uses local fonts sized to match the
  web fonts' widths, so lines break in the same places. `boot.ts` switches to
  the web fonts on the next frame, and from the first frame on later visits.
- The grain and the glow layers start with the scene. Large blended layers slow
  the first frame on phones.

## SEO

`Seo.astro` writes the title, description, canonical link, Open Graph and
Twitter tags, and JSON-LD for the site and the application. Set `SITE_URL` to
the public origin when building for a deploy:

```sh
SITE_URL=https://example.com pnpm landing:build
```

Without it, absolute URLs use the reserved `https://plenger.example` and the
build prints a warning. `public/og.jpg` is the 1200 by 630 social card, taken
from the hero.

## Type

Redaction (MCKL, SIL OFL 1.1) sets display type. Its numbered cuts, Redaction
35, 70 and 100, are the same letters with growing pixelation; their widths
differ by about 2%. `src/motion/redact.ts` swaps them through `data-redact`,
split lines do not wrap, and manifesto words keep their clean width. Headings
clear from redacted as they enter, manifesto words clear as the scroll reaches
them, and `<em>` accents stay redacted until hovered.

Kode Mono sets everything else: copy, labels, commands and the code the
particles spell. The dashboard mock keeps the dashboard's own faces, Geist and
Geist Mono, and the wordmark keeps Sacramento.

## The particle field

One `Points` object of 26,000 particles (12,000 on phones) blends between five
layouts in the vertex shader: the emblem, the code snippet, the STRIDE ring, a
dust field and a smaller closing emblem. `uMorph` runs from 0 to 4.

The emblem is a shield with a keyhole. `SHIELD_PATH` and `KEYHOLE_PATH` in
`src/scene/shapes.ts` are SVG paths: `emblem()` samples and inflates them into
a solid, and `EmblemPoster.astro` draws them.

The code layout renders `CODE_LINES` in `src/scene/shapes.ts` to a canvas and
samples its pixels, so the particles spell readable source. Lines in
`FLAGGED_LINES` turn orange once the scan line passes them. The finding in the
dashboard mock in `src/components/Showcase.astro` cites the same line numbers;
change both together.

Each section names its layout with `data-scene`. `src/scene/director.ts` maps
the names to positions for wide and compact screens.

## Motion and accessibility

With `prefers-reduced-motion`, the page skips smooth scroll, reveals, the
marquee and the cursor, and the process section is a static list. Without
WebGL the hero keeps its static shield. Without JavaScript every section still
reads.

Copy follows the repository docs: plain English, short sentences, claims that
[docs/STATUS.md](../docs/STATUS.md) supports. The install command assumes a
published npm release; see STATUS for its state.

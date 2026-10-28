import { defineConfig } from "astro/config";

/**
 * The public origin for canonical links, the sitemap, robots.txt and social previews.
 * Set SITE_URL when building for a deploy. The reserved .example domain marks a build
 * that still needs one.
 */
const PLACEHOLDER_SITE = "https://plenger.example";
const site = process.env.SITE_URL ?? PLACEHOLDER_SITE;
if (site === PLACEHOLDER_SITE) {
  console.warn(`[landing] SITE_URL is not set; absolute URLs use ${PLACEHOLDER_SITE}.`);
}

export default defineConfig({
  site,
  server: { host: "127.0.0.1", port: 4190 },
  devToolbar: { enabled: false },
  // The stylesheet is small; inlining it saves a render-blocking request.
  build: { inlineStylesheets: "always" },
  vite: {
    build: {
      // three.js ships as one module of about 520 kB (130 kB gzipped). It loads only
      // after the first interaction, in its own chunk.
      chunkSizeWarningLimit: 600,
    },
  },
});

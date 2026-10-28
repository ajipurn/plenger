import type { APIRoute } from "astro";

/** The pages this site serves. */
const PATHS = ["/"];

export const GET: APIRoute = ({ site }) => {
  const urls = PATHS.map((path) => `  <url><loc>${new URL(path, site).href}</loc></url>`);
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
};

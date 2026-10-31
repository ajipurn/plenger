import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import {
  API,
  applyAppearanceToHtml,
  isDashboardDensity,
  isDashboardTheme,
} from "../src/dashboard/contract.ts";

const apiTarget = process.env.PLENGER_DASHBOARD_API_TARGET;

/** In development the service still owns the saved appearance; apply it to Vite's index too. */
function savedThemePlugin(target: string) {
  return {
    name: "plenger-saved-theme",
    transformIndexHtml: {
      order: "pre" as const,
      async handler(html: string) {
        try {
          const sessionResponse = await fetch(`${target}${API.session}`, { cache: "no-store" });
          if (!sessionResponse.ok) return html;
          const { theme, density } = (await sessionResponse.json()) as {
            theme?: unknown;
            density?: unknown;
          };
          if (!isDashboardTheme(theme) || !isDashboardDensity(density)) return html;
          return applyAppearanceToHtml(html, { theme, density });
        } catch {
          // The service may still be starting; the page falls back to its default theme.
          return html;
        }
      },
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), ...(apiTarget ? [savedThemePlugin(apiTarget)] : [])],
  server: {
    host: "127.0.0.1",
    ...(apiTarget && {
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          configure(proxy) {
            proxy.on("proxyReq", (request) => {
              request.setHeader("origin", apiTarget);
            });
          },
        },
      },
    }),
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rolldownOptions: {
      onwarn(warning, warn) {
        // This SPA has no server component boundary; retain all other warnings.
        if (warning.code === "MODULE_LEVEL_DIRECTIVE" && warning.message.includes('"use client"'))
          return;
        warn(warning);
      },
    },
  },
});

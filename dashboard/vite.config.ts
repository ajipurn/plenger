import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import {
  API,
  applyAppearanceToHtml,
  isDashboardDensity,
  isDashboardTheme,
  TOKEN_HEADER,
  TOKEN_LINK_PARAMETER,
} from "../src/dashboard/contract.ts";

const apiTarget = process.env.PLENGER_DASHBOARD_API_TARGET;
const apiToken = process.env.PLENGER_DASHBOARD_TOKEN;
const apiHeaders: Record<string, string> = apiToken ? { [TOKEN_HEADER]: apiToken } : {};

/** Print Vite's address with the session token, as the launcher prints the service's link. */
function sessionLinkPlugin(token: string): Plugin {
  return {
    name: "plenger-session-link",
    configureServer(server) {
      server.httpServer?.once("listening", () => {
        const address = server.httpServer?.address();
        if (address && typeof address === "object")
          console.log(
            `Plenger dashboard: http://127.0.0.1:${address.port}/#${TOKEN_LINK_PARAMETER}=${token}`,
          );
      });
    },
  };
}

/** In development the service still owns the saved appearance; apply it to Vite's index too. */
function savedThemePlugin(target: string) {
  return {
    name: "plenger-saved-theme",
    transformIndexHtml: {
      order: "pre" as const,
      async handler(html: string) {
        try {
          const sessionResponse = await fetch(`${target}${API.session}`, {
            cache: "no-store",
            headers: apiHeaders,
          });
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
  plugins: [
    tailwindcss(),
    ...(apiTarget ? [savedThemePlugin(apiTarget)] : []),
    ...(apiToken ? [sessionLinkPlugin(apiToken)] : []),
  ],
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

import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const apiTarget = process.env.PLENGER_DASHBOARD_API_TARGET;

function savedThemePlugin(target: string) {
  return {
    name: "plenger-saved-theme",
    transformIndexHtml: {
      order: "pre" as const,
      async handler(html: string) {
        try {
          const sessionResponse = await fetch(`${target}/api/session`, { cache: "no-store" });
          if (!sessionResponse.ok) return html;
          const session = (await sessionResponse.json()) as { theme?: unknown };
          const theme = session.theme;
          if (theme !== "dark" && theme !== "light") return html;
          return html
            .replace(
              /<html\b([^>]*)>/i,
              (_match, attributes: string) =>
                `<html${attributes.replace(/\sdata-theme="[^"]*"/i, "")} data-theme="${theme}">`,
            )
            .replace(
              /name="color-scheme" content="[^"]*"/,
              `name="color-scheme" content="${theme}"`,
            )
            .replace(
              /name="theme-color" content="[^"]*"/,
              `name="theme-color" content="${theme === "dark" ? "#0b0b0b" : "#fafafa"}"`,
            );
        } catch {
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

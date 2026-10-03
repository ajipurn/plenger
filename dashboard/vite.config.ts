import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss()],
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

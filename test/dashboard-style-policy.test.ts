import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  EMPTY_STYLE_HASH,
  NOTCH_TOAST_STYLE_HASH,
  VAUL_STYLE_HASH,
} from "../src/dashboard/style-policy.ts";

const digest = (css: string) => `sha256-${createHash("sha256").update(css).digest("base64")}`;

describe("dashboard runtime style policy", () => {
  it("admits the exact stylesheet the installed Vaul injects", async () => {
    const bundle = await readFile(
      new URL("../dashboard/node_modules/vaul/dist/index.mjs", import.meta.url),
      "utf8",
    );
    const literal = /__insertCSS\(("(?:[^"\\]|\\.)*")\);/.exec(bundle)?.[1];
    expect(literal, "Vaul no longer injects its CSS through __insertCSS").toBeDefined();
    expect(digest(JSON.parse(literal ?? '""'))).toBe(VAUL_STYLE_HASH);
  });

  it("admits the exact stylesheet the installed Notch Toast renders", async () => {
    const bundle = await readFile(
      new URL("../dashboard/node_modules/notch-toast/dist/index.js", import.meta.url),
      "utf8",
    );
    // A template literal without escapes or substitutions renders exactly as written.
    const css = /_jsx\("style", \{ children: `([^`$\\]*)` \}\)/.exec(bundle)?.[1];
    expect(css, "Notch Toast no longer renders a plain style element").toBeDefined();
    expect(digest(css ?? "")).toBe(NOTCH_TOAST_STYLE_HASH);
  });

  it("admits only an empty stylesheet for Vaul's first insertion", () => {
    expect(digest("")).toBe(EMPTY_STYLE_HASH);
  });
});

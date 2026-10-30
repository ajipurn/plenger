import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const layout = await readFile(
  new URL("../landing/src/layouts/Page.astro", import.meta.url),
  "utf8",
);
const boot = stripTypeScriptTypes(
  (await readFile(new URL("../landing/src/boot.ts", import.meta.url), "utf8")).replace(
    /^import .*from "\.\/motion\/chrome\.ts";\n/m,
    "",
  ),
);

/** Run the real startup scripts with font downloads held until the test releases them. */
function startup(runBoot = true) {
  const classes = new Set<string>();
  const frames: (() => void)[] = [];
  const timers: { run: () => void; delay: number }[] = [];
  const fonts = new Map<string, ReturnType<typeof Promise.withResolvers<object[]>>>();
  const load = vi.fn((face: string) => {
    const download = Promise.withResolvers<object[]>();
    fonts.set(face, download);
    return download.promise;
  });
  const context = {
    document: {
      documentElement: {
        classList: {
          add: (...names: string[]) => {
            for (const name of names) classes.add(name);
          },
          remove: (...names: string[]) => {
            for (const name of names) classes.delete(name);
          },
          contains: (name: string) => classes.has(name),
        },
      },
      fonts: { load },
    },
    window: {
      setTimeout: (run: () => void, delay: number) => timers.push({ run, delay }),
      addEventListener() {},
      removeEventListener() {},
    },
    // A stored flag must not stand in for font availability after the cache is cleared.
    localStorage: { getItem: () => "1", setItem() {} },
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    setupCopy() {},
    setupNav() {},
  };
  const inline = /<script is:inline>([\s\S]*?)<\/script>/.exec(layout)?.[1];
  expect(inline).toBeDefined();
  runInNewContext(inline ?? "", context);
  if (runBoot) runInNewContext(boot, context);
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return { classes, frames, timers, fonts, load, flush };
}

describe("landing page initial loading", () => {
  it("keeps the loading screen up while fonts are downloading, even with an old cache flag", () => {
    const page = startup();
    for (let frame = 0; frame < 3; frame++) {
      for (const run of page.frames.splice(0)) run();
    }
    expect(layout).toContain("data-loader");
    expect(layout).toContain('role="status"');
    expect(page.classes.has("is-loading")).toBe(true);
    expect(page.classes.has("fonts")).toBe(false);
  });

  it("reveals all the intended font families together after their downloads finish", async () => {
    const page = startup();
    expect(page.load.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([
        '400 1em "Redaction"',
        '400 1em "Redaction 35"',
        '400 1em "Redaction 70"',
        '400 1em "Redaction 100"',
        '400 1em "Kode Mono Variable"',
        '400 1em "Geist Variable"',
        '400 1em "Geist Mono Variable"',
        '400 1em "Sacramento"',
      ]),
    );
    const last = page.fonts.get('400 1em "Sacramento"');
    expect(last).toBeDefined();
    for (const download of page.fonts.values()) {
      if (download !== last) download.resolve([{}]);
    }
    await page.flush();
    expect(page.classes.has("is-loading")).toBe(true);
    expect(page.classes.has("fonts")).toBe(false);
    last?.resolve([{}]);
    await page.flush();
    expect(page.classes.has("fonts")).toBe(true);
    expect(page.classes.has("is-loading")).toBe(false);
  });

  it("shows readable fallback text if a font fails", async () => {
    const page = startup();
    page.fonts.get('400 1em "Redaction"')?.reject(new Error("Font download failed"));
    await page.flush();
    expect(page.classes.has("fonts")).toBe(false);
    expect(page.classes.has("is-loading")).toBe(false);
  });

  it("keeps fallbacks when a font face is unavailable in the stylesheet", async () => {
    const page = startup();
    for (const download of page.fonts.values()) download.resolve([]);
    await page.flush();
    expect(page.classes.has("fonts")).toBe(false);
    expect(page.classes.has("is-loading")).toBe(false);
  });

  it("releases the screen if the boot module never arrives", () => {
    const page = startup(false);
    expect(page.classes.has("is-loading")).toBe(true);
    expect(page.timers).toHaveLength(1);
    expect(page.timers[0]?.delay).toBeGreaterThan(0);
    expect(page.timers[0]?.delay).toBeLessThanOrEqual(3000);
    for (const { run } of page.timers) run();
    expect(page.classes.has("is-loading")).toBe(false);
  });

  it("does not swap visible text when fonts arrive after the loading deadline", async () => {
    const page = startup();
    for (const { run } of page.timers) run();
    for (const download of page.fonts.values()) download.resolve([{}]);
    await page.flush();
    expect(page.classes.has("fonts")).toBe(false);
    expect(page.classes.has("is-loading")).toBe(false);
  });
});

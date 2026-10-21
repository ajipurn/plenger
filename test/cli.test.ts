import { describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/cli/index.ts";
import { captureCli } from "./support/cli.ts";

describe("dashboard launcher CLI", () => {
  it.each(["--help", "-h"])(
    "shows %s without starting the dashboard or checking updates",
    async (flag) => {
      const updates = { notify: vi.fn(), run: vi.fn() };
      const result = await captureCli([flag], updates);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("plenger update");
      expect(result.stdout).toContain("--workspace");
      expect(result.stdout).not.toMatch(
        /plenger (?:scan|serve|facts|assess|rules|redteam|skills)\b/,
      );
      expect(updates.notify).not.toHaveBeenCalled();
      expect(updates.run).not.toHaveBeenCalled();
    },
  );

  it.each(["--version", "-v"])("prints %s without an update check", async (flag) => {
    const updates = { notify: vi.fn(), run: vi.fn() };
    expect(await captureCli([flag], updates)).toEqual({
      code: 0,
      stdout: `${VERSION}\n`,
      stderr: "",
    });
    expect(updates.notify).not.toHaveBeenCalled();
  });

  it("shows updater help without contacting npm or starting the dashboard", async () => {
    const updates = { notify: vi.fn(), run: vi.fn() };
    expect((await captureCli(["update", "--help"], updates)).stdout).toContain("confirmation");
    expect(updates.run).not.toHaveBeenCalled();
  });

  it.each([
    ["scan"],
    ["serve"],
    ["facts"],
    ["rules"],
    ["assess"],
    ["redteam", "run"],
    ["skills", "--add"],
    ["project"],
    ["--port", "-1"],
    ["--port", "65536"],
    ["--port", "1.5"],
    ["--workspace", ""],
    ["--data-dir", ""],
    ["--port"],
    ["--unknown"],
    ["--json"],
    ["update", "--yes"],
    ["update", "--workspace", "."],
    ["update", "extra"],
  ])("rejects removed commands and invalid options: %j", async (...argv) => {
    expect((await captureCli(argv)).code).toBe(2);
  });
});

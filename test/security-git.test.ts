import { execFile } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { sourceRevision } from "../src/security/git.ts";
import { temporaryDir } from "./support/tmp.ts";

const execute = promisify(execFile);
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("sourceRevision", () => {
  it.skipIf(process.platform === "win32")(
    "reads commit and branch without running the project's Git filter drivers",
    async () => {
      const project = await temporaryDir();
      const marker = join(project, "filter-ran");
      // Commits exist only in this disposable fixture, never in the user's checkout.
      const git = (...args: string[]) =>
        execute("git", [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "user.name=Plenger test",
          "-c",
          "user.email=test@example.invalid",
          "-C",
          project,
          ...args,
        ]);
      await writeFile(join(project, "app.py"), "print('one')\n");
      await git("init", "--initial-branch=main");
      await git("add", ".");
      await git("commit", "-m", "test: filter fixture");
      // A project-supplied clean filter, as a downloaded archive with its .git could carry.
      await git("config", "filter.probe.clean", `sh -c 'printf ran > "${marker}"; cat'`);
      await writeFile(join(project, ".gitattributes"), "* filter=probe\n");
      await writeFile(join(project, "app.py"), "print('two')\n");

      const revision = await sourceRevision(project);
      expect(revision.commit).toMatch(/^[a-f0-9]{40,64}$/);
      expect(revision.branch).toBe("main");
      expect(revision.dirty).toBeNull();
      expect(await exists(marker)).toBe(false);

      // Control: the fixture is armed, so a status read would have run the filter.
      await git("status", "--porcelain");
      expect(await exists(marker)).toBe(true);
    },
  );
});

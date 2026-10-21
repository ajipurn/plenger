import { execFile } from "node:child_process";
import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ChangeScopeError, changedLines, changesSince } from "../src/security/changes.ts";
import { temporaryDir } from "./support/tmp.ts";

const execute = promisify(execFile);
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
/** Git in a disposable fixture, never in the user's checkout. */
const gitIn =
  (project: string) =>
  (...args: string[]) =>
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
const split = (text: string) => (text ? text.split(",") : []);

describe("changed lines", () => {
  it("marks inserted and edited lines, and the line after a deletion", () => {
    expect(changedLines(split("a,b,c,d"), split("a,b,c,d"))).toEqual([]);
    expect(changedLines(split("a,b,c,d"), split("a,x,c,d"))).toEqual([{ line: 2, endLine: 2 }]);
    expect(changedLines(split("a,b,c,d"), split("a,c,d"))).toEqual([{ line: 2, endLine: 2 }]);
    expect(changedLines(split("a,b,c,d,e,f"), split("a,x,c,d,y,f"))).toEqual([
      { line: 2, endLine: 2 },
      { line: 5, endLine: 5 },
    ]);
    expect(changedLines(split("a,b,c,d,e,f,g"), split("a,b,X,Y,e,f,g"))).toEqual([
      { line: 3, endLine: 4 },
    ]);
    expect(changedLines(split(""), split("a,b"))).toEqual([{ line: 1, endLine: 2 }]);
    expect(changedLines(split("a,b,c,d"), split("a,b,c,d,e"))).toEqual([{ line: 5, endLine: 5 }]);
  });
});

describe("changesSince", () => {
  it.skipIf(process.platform === "win32")(
    "compares the files on disk with the base commit without running the project's Git filters",
    async () => {
      const project = await temporaryDir();
      const git = gitIn(project);
      const marker = join(project, "filter-ran");
      await writeFile(join(project, "app.py"), "import os\n\n\ndef run(name):\n    return name\n");
      await writeFile(join(project, "auth.py"), "def check(user):\n    return user.admin\n");
      await writeFile(join(project, "same.py"), "VALUE = 1\n");
      await git("init", "--initial-branch=main");
      await git("add", ".");
      await git("commit", "-m", "test: base");
      // A project-supplied clean filter: reading working-tree status would run it.
      await git("config", "filter.probe.clean", `sh -c 'printf ran > "${marker}"; cat'`);
      await writeFile(join(project, ".gitattributes"), "* filter=probe\n");
      await writeFile(
        join(project, "app.py"),
        "import os\n\n\ndef run(name):\n    os.system(name)\n    return name\n",
      );
      await writeFile(join(project, "new.py"), "def added():\n    pass\n");
      await rm(join(project, "auth.py"));

      const scope = await changesSince(project, "main", ["app.py", "new.py", "same.py"]);
      expect(scope.base).toBe("main");
      expect(scope.commit).toMatch(/^[a-f0-9]{40,64}$/);
      expect(scope.files).toEqual([
        { path: "app.py", added: false, ranges: [{ line: 5, endLine: 5 }] },
        { path: "new.py", added: true, ranges: [{ line: 1, endLine: 2 }] },
      ]);
      expect(scope.removed).toEqual(["auth.py"]);
      expect(await exists(marker)).toBe(false);

      for (const ref of ["--output=x", "main..HEAD", "no-such-branch", "main main"])
        await expect(changesSince(project, ref, ["app.py"])).rejects.toBeInstanceOf(
          ChangeScopeError,
        );
      // Control: the fixture is armed, so a status read would have run the filter.
      await git("status", "--porcelain");
      expect(await exists(marker)).toBe(true);
    },
    // A dozen Git processes, which a busy machine can slow past the default.
    30_000,
  );

  it("names the problem when the folder is not a Git repository", async () => {
    const project = await temporaryDir();
    await writeFile(join(project, "app.py"), "print(1)\n");
    await expect(changesSince(project, "main", ["app.py"])).rejects.toThrow(
      "main is not a commit of this project's Git repository.",
    );
  });
});

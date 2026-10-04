import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { FolderListing, PlanRequest } from "./contract.ts";
import { expectKeys, HttpError, requireString } from "./http.ts";

const MAX_PATH_LENGTH = 4096;
const MAX_TARGET_LENGTH = 128;
const MAX_LISTED_FOLDERS = 500;
const FOLDER_MESSAGE = "Choose an existing project folder.";

/**
 * The canonical path of an existing directory, relative paths resolved against the
 * workspace. Every failure gets the same message so a probe learns nothing about
 * what exists outside the workspace.
 */
export async function resolveDirectory(path: string, workspace: string): Promise<string> {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH || path.includes("\0"))
    throw new HttpError(400, FOLDER_MESSAGE);
  try {
    const canonical = await realpath(isAbsolute(path) ? path : resolve(workspace, path));
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch (error) {
    throw new HttpError(400, FOLDER_MESSAGE, { cause: error });
  }
}

/** Visible sub-folders of `path`, sorted; hidden entries, symlinks and files are omitted. */
export async function listFolders(path: string, workspace: string): Promise<FolderListing> {
  const canonical = await resolveDirectory(path, workspace);
  try {
    const children = (await readdir(canonical, { withFileTypes: true }))
      .filter(
        (entry) => !entry.name.startsWith(".") && entry.isDirectory() && !entry.isSymbolicLink(),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_LISTED_FOLDERS)
      .map((entry) => ({ name: entry.name, path: join(canonical, entry.name) }));
    const parent = dirname(canonical);
    return { path: canonical, parent: parent === canonical ? null : parent, folders: children };
  } catch (error) {
    throw new HttpError(400, "This folder could not be opened.", { cause: error });
  }
}

/** `{ path }`, optionally with a `target` id, and nothing else. */
export function parseProjectRequest(
  body: Record<string, unknown>,
  options: { allowTarget: boolean },
): PlanRequest {
  const message = "Project request contains unsupported options.";
  expectKeys(body, options.allowTarget ? ["path", "target"] : ["path"], message);
  const path = requireString(body.path, message);
  if (body.target === undefined) return { path };
  return { path, target: requireString(body.target, message, { min: 1, max: MAX_TARGET_LENGTH }) };
}

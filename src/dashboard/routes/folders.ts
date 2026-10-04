import { API, type ChooseFolderResult } from "../contract.ts";
import { HttpError, jsonRequest } from "../http.ts";
import type { Route } from "../router.ts";
import type { Services } from "../services.ts";
import { listFolders, parseProjectRequest, resolveDirectory } from "../workspace.ts";

export function folderRoutes({ workspace, supervisor, folderPicker }: Services): Route[] {
  return [
    {
      method: "GET",
      path: API.folders,
      handler: async ({ url }) => ({
        status: 200,
        body: await listFolders(url.searchParams.get("path") ?? workspace, workspace),
      }),
    },
    {
      method: "POST",
      path: API.chooseFolder,
      handler: async ({ request, response }) => {
        const body = parseProjectRequest(await jsonRequest(request), { allowTarget: false });
        const path = await resolveDirectory(body.path, workspace);
        // Never open a system dialog for a page that has already gone away.
        if (response.destroyed) return undefined;
        return supervisor.withFolderPicker(async (signal) => {
          let selected: string | null;
          try {
            selected = await folderPicker(path, signal);
          } catch (error) {
            throw new HttpError(
              503,
              "The system folder picker could not be opened. Browse the folders below or enter a path and press Enter.",
              { cause: error },
            );
          }
          if (response.destroyed) return undefined;
          const result: ChooseFolderResult = {
            folder: selected === null ? null : await listFolders(selected, workspace),
          };
          return { status: 200, body: result };
        });
      },
    },
  ];
}

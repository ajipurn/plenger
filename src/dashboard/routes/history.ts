import { API } from "../contract.ts";
import { expectKeys, HttpError, jsonRequest, requireString } from "../http.ts";
import type { Route } from "../router.ts";
import type { Services } from "../services.ts";

const MAX_ID_LENGTH = 128;

export function historyRoutes({ workspace, store, supervisor }: Services): Route[] {
  return [
    {
      method: "POST",
      path: API.openScan,
      handler: async ({ request }) => {
        const body = await jsonRequest(request);
        supervisor.assertIdle();
        const message = "Choose a saved scan.";
        expectKeys(body, ["id"], message);
        const id = requireString(body.id, message, { max: MAX_ID_LENGTH });
        if (!store.openScan(id))
          throw new HttpError(404, "This saved scan is no longer available.");
        return { status: 200, body: store.read(workspace) };
      },
    },
  ];
}

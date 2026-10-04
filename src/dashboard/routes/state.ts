import { API } from "../contract.ts";
import { expectKeys, jsonRequest } from "../http.ts";
import type { Route } from "../router.ts";
import type { Services } from "../services.ts";

export function stateRoutes({ workspace, store, supervisor }: Services): Route[] {
  return [
    {
      method: "GET",
      path: API.state,
      handler: () => ({ status: 200, body: store.read(workspace) }),
    },
    {
      method: "POST",
      path: API.clear,
      handler: async ({ request }) => {
        const body = await jsonRequest(request);
        supervisor.assertIdle();
        expectKeys(body, [], "Clear request contains unsupported options.");
        store.clear();
        return { status: 200, body: store.read(workspace) };
      },
    },
  ];
}

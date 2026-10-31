import { API, type DashboardSession } from "../contract.ts";
import type { Route } from "../router.ts";
import type { Services } from "../services.ts";

/** The only unauthenticated endpoint: it hands the page its token. */
export function sessionRoutes({ workspace, token, store }: Services): Route[] {
  return [
    {
      method: "GET",
      path: API.session,
      public: true,
      handler: () => {
        const session: DashboardSession = {
          workspace,
          token,
          theme: store.readTheme(),
          density: store.readDensity(),
        };
        return { status: 200, body: session };
      },
    },
  ];
}

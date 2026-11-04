import { API, type DashboardSession } from "../contract.ts";
import type { Route } from "../router.ts";
import type { Services } from "../services.ts";

/**
 * The page's session settings. It needs the token, which the page reads from the link
 * the launcher printed: a public endpoint would hand the token to any local process.
 */
export function sessionRoutes({ workspace, token, store }: Services): Route[] {
  return [
    {
      method: "GET",
      path: API.session,
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

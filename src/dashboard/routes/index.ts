import type { Route } from "../router.ts";
import type { Services } from "../services.ts";
import { folderRoutes } from "./folders.ts";
import { historyRoutes } from "./history.ts";
import { providerRoutes } from "./providers.ts";
import { redteamRoutes } from "./redteam.ts";
import { scanRoutes } from "./scan.ts";
import { sessionRoutes } from "./session.ts";
import { stateRoutes } from "./state.ts";
import { themeRoutes } from "./theme.ts";

/** The complete `/api/*` table; `matchRoute` walks it in this order. */
export function dashboardRoutes(services: Services): Route[] {
  return [
    ...sessionRoutes(services),
    ...stateRoutes(services),
    ...themeRoutes(services),
    ...historyRoutes(services),
    ...scanRoutes(services),
    ...folderRoutes(services),
    ...providerRoutes(services),
    ...redteamRoutes(services),
  ];
}

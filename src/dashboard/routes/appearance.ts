import {
  API,
  type DensityResult,
  isDashboardDensity,
  isDashboardTheme,
  type ThemeResult,
} from "../contract.ts";
import { expectKeys, HttpError, jsonRequest } from "../http.ts";
import type { Route } from "../router.ts";
import type { Services } from "../services.ts";

/** The saved theme and density. Both apply to every project. */
export function appearanceRoutes({ store }: Services): Route[] {
  return [
    {
      method: "POST",
      path: API.theme,
      handler: async ({ request }) => {
        const body = await jsonRequest(request);
        const message = "Choose the dark, system or light theme.";
        expectKeys(body, ["theme"], message);
        const theme = body.theme;
        if (!isDashboardTheme(theme)) throw new HttpError(400, message);
        store.saveTheme(theme);
        const result: ThemeResult = { theme };
        return { status: 200, body: result };
      },
    },
    {
      method: "POST",
      path: API.density,
      handler: async ({ request }) => {
        const body = await jsonRequest(request);
        const message = "Choose the comfortable or compact density.";
        expectKeys(body, ["density"], message);
        const density = body.density;
        if (!isDashboardDensity(density)) throw new HttpError(400, message);
        store.saveDensity(density);
        const result: DensityResult = { density };
        return { status: 200, body: result };
      },
    },
  ];
}

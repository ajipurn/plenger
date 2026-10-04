import { API, type ThemeResult } from "../contract.ts";
import { expectKeys, HttpError, jsonRequest } from "../http.ts";
import type { Route } from "../router.ts";
import type { Services } from "../services.ts";

export function themeRoutes({ store }: Services): Route[] {
  return [
    {
      method: "POST",
      path: API.theme,
      handler: async ({ request }) => {
        const body = await jsonRequest(request);
        const message = "Choose dark or light mode.";
        expectKeys(body, ["theme"], message);
        const theme = body.theme;
        if (theme !== "dark" && theme !== "light") throw new HttpError(400, message);
        store.saveTheme(theme);
        const result: ThemeResult = { theme };
        return { status: 200, body: result };
      },
    },
  ];
}

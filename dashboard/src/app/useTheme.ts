import type { DashboardTheme } from "../../../src/dashboard/contract.ts";
import type { DashboardApi } from "../api/client.ts";
import { isDashboardTheme, THEME_LABELS, themeColorMetas, themeColorScheme } from "./appearance.ts";
import { usePreference } from "./usePreference.ts";

/** Mirror the theme into the document and persist changes through the service. */
export function useTheme(api: DashboardApi | null, announce: (message: string) => void) {
  const preference = usePreference<DashboardTheme>({
    initial: () => {
      const saved = document.documentElement.dataset.theme;
      return isDashboardTheme(saved) ? saved : "dark";
    },
    apply: applyTheme,
    save: api && ((next) => api.setTheme(next)),
    announce: (next) => announce(`Theme set to ${THEME_LABELS[next]}.`),
    failure: "Could not save your theme. Try again.",
  });
  return { ...preference, theme: preference.value, setTheme: preference.setValue };
}

function applyTheme(theme: DashboardTheme): void {
  document.documentElement.dataset.theme = theme;
  // System has one theme-color per device setting, so the metas are replaced, not edited.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.remove();
  for (const { media, content } of themeColorMetas(theme)) {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    if (media) meta.media = media;
    meta.content = content;
    document.head.append(meta);
  }
  const scheme = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (scheme) scheme.content = themeColorScheme(theme);
}

import { useLayoutEffect, useState } from "react";
import type { DashboardTheme } from "../../../src/dashboard/contract.ts";
import type { DashboardApi } from "../api/client.ts";
import { THEME_COLORS } from "./theme.ts";

/** Mirror the theme into the document and persist changes through the service. */
export function useTheme(api: DashboardApi | null, announce: (message: string) => void) {
  const [theme, setTheme] = useState<DashboardTheme>(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    const color = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (color) color.content = THEME_COLORS[theme];
    const scheme = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
    if (scheme) scheme.content = theme;
  }, [theme]);

  async function toggle() {
    if (!api || saving) return;
    const previous = theme;
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setSaving(true);
    setError("");
    try {
      await api.setTheme(next);
      announce(`${next === "dark" ? "Dark" : "Light"} mode enabled.`);
    } catch {
      setTheme(previous);
      setError("Could not save your theme. Try switching again.");
    } finally {
      setSaving(false);
    }
  }

  return { theme, setTheme, saving, error, toggle };
}

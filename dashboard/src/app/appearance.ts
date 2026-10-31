import type { DashboardDensity, DashboardTheme } from "../../../src/dashboard/contract.ts";

export {
  DASHBOARD_DENSITIES,
  DASHBOARD_THEMES,
  isDashboardDensity,
  isDashboardTheme,
  themeColorMetas,
  themeColorScheme,
} from "../../../src/dashboard/contract.ts";

/** Choice names as the Appearance settings and announcements show them. */
export const THEME_LABELS: Record<DashboardTheme, string> = {
  dark: "Dark",
  system: "System",
  light: "Light",
};
export const DENSITY_LABELS: Record<DashboardDensity, string> = {
  comfortable: "Comfortable",
  compact: "Compact",
};

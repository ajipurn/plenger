import type { DashboardDensity } from "../../../src/dashboard/contract.ts";
import type { DashboardApi } from "../api/client.ts";
import { DENSITY_LABELS, isDashboardDensity } from "./appearance.ts";
import { usePreference } from "./usePreference.ts";

/** Mirror the density into the document and persist changes through the service. */
export function useDensity(api: DashboardApi | null, announce: (message: string) => void) {
  const preference = usePreference<DashboardDensity>({
    initial: () => {
      const saved = document.documentElement.dataset.density;
      return isDashboardDensity(saved) ? saved : "comfortable";
    },
    apply: applyDensity,
    save: api && ((next) => api.setDensity(next)),
    announce: (next) => announce(`Density set to ${DENSITY_LABELS[next]}.`),
    failure: "Could not save your density. Try again.",
  });
  return { ...preference, density: preference.value, setDensity: preference.setValue };
}

function applyDensity(density: DashboardDensity): void {
  document.documentElement.dataset.density = density;
}

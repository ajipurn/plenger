import { useEffect } from "react";
import type { CampaignReport } from "../../../src/redteam/campaign.ts";
import type { RedteamRun } from "../../../src/redteam/run.ts";
import type { DashboardApi } from "../api/client.ts";
import { isActiveRunState } from "../shared/runs.ts";
import type { DashboardActions } from "./DashboardContext.tsx";

/** Refresh the active run or campaign every second until it finishes. */
export function useRunPolling(
  api: DashboardApi | null,
  runs: RedteamRun[],
  campaigns: CampaignReport[],
  actions: DashboardActions,
  announce: (message: string) => void,
) {
  const activeRunId = runs.find((run) => isActiveRunState(run.state))?.id;
  const activeCampaignId = campaigns.find((item) => isActiveRunState(item.state))?.id;

  useEffect(() => {
    const id = activeCampaignId ?? activeRunId;
    if (!api || !id) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const run = activeCampaignId ? await api.getCampaign(id) : await api.getRun(id);
        if (!disposed) {
          if (run.kind === "redteam-campaign") actions.updateCampaign(run);
          else actions.updateRun(run);
          if (run.finishedAt)
            announce(`Red-team run ${run.state}. Review its evidence and coverage.`);
        }
      } catch {
        if (!disposed)
          announce("Unable to refresh run progress. Reconnecting to the local service…");
      }
      if (!disposed) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [api, activeRunId, activeCampaignId, actions, announce]);

  return { activeRunId, activeCampaignId };
}

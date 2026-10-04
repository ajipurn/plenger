import type { CampaignReport } from "../../../src/redteam/campaign.ts";
import type { RedteamRun } from "../../../src/redteam/run.ts";

export function isActiveRunState(state: RedteamRun["state"] | CampaignReport["state"]): boolean {
  return state === "preparing" || state === "running";
}

/** Replace or insert an item, newest first, keeping at most `limit` entries. */
export function upsertRecent<T extends { id: string; createdAt: string }>(
  list: T[],
  item: T,
  limit: number,
): T[] {
  return [item, ...list.filter((entry) => entry.id !== item.id)]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, limit);
}

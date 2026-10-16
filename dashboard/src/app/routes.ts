export const routes = {
  findings: "/findings",
  inventory: "/inventory",
  redteam: "/redteam",
  history: "/history",
  settings: "/settings",
  appearance: "/settings/appearance",
  providers: "/settings/providers",
  data: "/settings/data",
} as const;

/** Hash bookmarks from the first dashboard, mapped to their real routes. */
const LEGACY_HASH_VIEWS: Record<string, string> = {
  overview: "/",
  findings: routes.findings,
  inventory: routes.inventory,
  redteam: routes.redteam,
  history: routes.history,
};
export function legacyHashTarget(hash: string): string | null {
  if (hash === "scans" || hash.startsWith("scans/")) return `/${hash}`;
  if (hash === "repositories") return "/repositories";
  const match = /^(\w+)(\?.*)?$/.exec(hash);
  const view = match?.[1];
  if (!view || !Object.hasOwn(LEGACY_HASH_VIEWS, view)) return null;
  return `${LEGACY_HASH_VIEWS[view]}${match?.[2] ?? ""}`;
}

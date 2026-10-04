import { matchPath } from "react-router";

export type PageId = "overview" | "findings" | "inventory" | "redteam" | "history" | "settings";

export const routes = {
  overview: "/",
  findings: "/findings",
  inventory: "/inventory",
  redteam: "/redteam",
  history: "/history",
  settings: "/settings",
  providers: "/settings/providers",
} as const;

/** Sidebar sections, in display order. */
export const navigationGroups = ["Analyze", "Test", "Workspace"] as const;
export type NavigationGroup = (typeof navigationGroups)[number];

export interface Page {
  id: PageId;
  label: string;
  path: string;
  group: NavigationGroup;
  /** Match the path exactly; settings has nested pages. */
  end: boolean;
}

export const pages: Page[] = [
  { id: "overview", label: "Overview", path: routes.overview, group: "Analyze", end: true },
  { id: "findings", label: "Findings", path: routes.findings, group: "Analyze", end: true },
  { id: "inventory", label: "Inventory", path: routes.inventory, group: "Analyze", end: true },
  { id: "redteam", label: "Red-team", path: routes.redteam, group: "Test", end: true },
  { id: "history", label: "Scan history", path: routes.history, group: "Workspace", end: true },
  { id: "settings", label: "Settings", path: routes.settings, group: "Workspace", end: false },
];

export function pageFor(pathname: string): PageId {
  return (
    pages.find((page) => matchPath({ path: page.path, end: page.end }, pathname))?.id ?? "overview"
  );
}

export function findingRoute(fingerprint: string): string {
  return `${routes.findings}?finding=${encodeURIComponent(fingerprint)}`;
}

/** Earlier URLs that still resolve to the providers settings page. */
export const legacyRedirects: { from: string; to: string }[] = [
  { from: routes.settings, to: routes.providers },
  { from: "/providers", to: routes.providers },
];

/** Hash bookmarks from the first dashboard, mapped to their real routes. */
const legacyHashViews: PageId[] = ["overview", "findings", "inventory", "redteam", "history"];
export function legacyHashTarget(hash: string): string | null {
  const match = new RegExp(`^(${legacyHashViews.join("|")})(\\?.*)?$`).exec(hash);
  const page = match ? pages.find((item) => item.id === match[1]) : undefined;
  if (!match || !page) return null;
  return `${page.path}${match[2] ?? ""}`;
}

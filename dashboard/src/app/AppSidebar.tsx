import { type RefObject, useId } from "react";
import { Link, NavLink } from "react-router";
import type { DashboardTheme } from "../../../src/dashboard/contract.ts";
import { Icon, Mark } from "../shared/icons.tsx";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { pathSegments, projectName } from "../shared/paths.ts";
import { useElementScrollbars } from "../shared/ScrollArea.tsx";
import { Button } from "../shared/ui.tsx";
import { navigationGroups, pages, routes } from "./routes.ts";

/**
 * The workspace frame: brand, project switcher, grouped navigation and appearance.
 * A fixed column on wide screens; on narrow screens its parts join the page grid as
 * a header row with a sticky, horizontally scrolling navigation.
 */
export function AppSidebar({
  project,
  initializing,
  switcherDisabled,
  pickerTrigger,
  onOpenPicker,
  theme,
  themeDisabled,
  themeSaving,
  onToggleTheme,
  findingCount,
  historyCount,
}: {
  project: string;
  initializing: boolean;
  switcherDisabled: boolean;
  pickerTrigger: RefObject<HTMLButtonElement | null>;
  onOpenPicker: () => void;
  theme: DashboardTheme;
  themeDisabled: boolean;
  themeSaving: boolean;
  onToggleTheme: () => void;
  findingCount: number;
  historyCount: number;
}) {
  const groupId = useId();
  const navigationScrollbars = useElementScrollbars<HTMLElement>("x");
  const nextTheme = theme === "dark" ? "light" : "dark";
  const name = project ? projectName(project) : "";
  const parent = pathSegments(project).slice(-3, -1).join("/");
  const counts: Partial<Record<(typeof pages)[number]["id"], number>> = {
    findings: findingCount,
    history: historyCount,
  };
  return (
    <div className="app-sidebar">
      <div className="sidebar-brand">
        <Link className="brand" to={routes.overview} aria-label="Plenger overview">
          <Mark />
          <span className="brand-text" aria-hidden="true">
            <span className="brand-name">Plenger</span>
            <span className="brand-tagline">Agent security</span>
          </span>
        </Link>
      </div>
      <div className="sidebar-project">
        <Button
          ref={pickerTrigger}
          className="project-switcher"
          disabled={switcherDisabled}
          onClick={onOpenPicker}
          aria-label={`Select project${project ? `, current project ${name}` : ""}`}
        >
          <span className="project-avatar" aria-hidden="true">
            {name ? name.slice(0, 1).toUpperCase() : <Icon name="folder" />}
          </span>
          <span className="project-switcher-text">
            {initializing ? (
              <span className="skeleton-block skeleton-project-name" aria-hidden="true" />
            ) : (
              <>
                <strong>{name || "Select project"}</strong>
                <span className="project-switcher-path">
                  {parent ? `…/${parent}` : project ? "Project root" : "No folder selected"}
                </span>
              </>
            )}
          </span>
          <Icon name="selector" className="project-switcher-arrow" />
        </Button>
      </div>
      <div className="sidebar-nav-shell">
        <nav
          ref={navigationScrollbars}
          className="sidebar-nav"
          data-overlayscrollbars-initialize=""
          aria-label="Workspace navigation"
        >
          {navigationGroups.map((group) => (
            <div className="nav-group" key={group}>
              <span className="nav-group-label" id={`${groupId}-${group}`}>
                {group}
              </span>
              <ul className="nav-list" aria-labelledby={`${groupId}-${group}`}>
                {pages
                  .filter((page) => page.group === group)
                  .map((page) => (
                    <li key={page.id}>
                      <NavLink
                        to={page.path}
                        end={page.end}
                        className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
                      >
                        <Icon name={page.id} />
                        <span>{page.label}</span>
                        {counts[page.id] !== undefined && (
                          <span className="nav-count">
                            <MorphNumber value={counts[page.id] ?? 0} />
                          </span>
                        )}
                      </NavLink>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
      <div className="sidebar-footer">
        <Button
          className="icon-button theme-toggle"
          disabled={themeDisabled}
          aria-disabled={themeSaving}
          aria-label={`Switch to ${nextTheme} mode`}
          title={`Switch to ${nextTheme} mode`}
          onClick={onToggleTheme}
        >
          <Icon name={theme === "dark" ? "sun" : "moon"} />
        </Button>
      </div>
    </div>
  );
}

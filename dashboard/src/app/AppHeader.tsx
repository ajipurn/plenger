import type { RefObject } from "react";
import { Link } from "react-router";
import type { DashboardTheme } from "../../../src/dashboard/contract.ts";
import { Icon, Mark } from "../shared/icons.tsx";
import { projectName } from "../shared/paths.ts";
import { Button } from "../shared/ui.tsx";
import { routes } from "./routes.ts";

export function AppHeader({
  project,
  initializing,
  switcherDisabled,
  pickerTrigger,
  onOpenPicker,
  theme,
  themeDisabled,
  themeSaving,
  onToggleTheme,
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
}) {
  const nextTheme = theme === "dark" ? "light" : "dark";
  return (
    <header className="workspace-header">
      <div className="workspace-topbar">
        <div className="workspace-identity">
          <Link className="brand" to={routes.overview} aria-label="Plenger overview">
            <Mark />
          </Link>
          <span className="header-divider" aria-hidden="true" />
          <Button
            ref={pickerTrigger}
            className="project-switcher"
            disabled={switcherDisabled}
            onClick={onOpenPicker}
            aria-label={`Select project${project ? `, current project ${projectName(project)}` : ""}`}
          >
            <Icon name="folder" />
            {initializing ? (
              <span className="skeleton-block skeleton-project-name" aria-hidden="true" />
            ) : (
              <strong>{project ? projectName(project) : "Select project"}</strong>
            )}
            <Icon name="chevron" className="project-switcher-arrow" />
          </Button>
        </div>
        <div className="workspace-status">
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
    </header>
  );
}

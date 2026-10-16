import { useId } from "react";
import { Switch } from "react-aria-components";
import type { DashboardTheme } from "../../../src/dashboard/contract.ts";

export function AppearanceSettings({
  theme,
  disabled,
  error,
  onToggle,
}: {
  theme: DashboardTheme;
  disabled: boolean;
  error: string;
  onToggle: () => void;
}) {
  const id = useId();
  return (
    <section className="subnav-content" aria-labelledby={`${id}-heading`}>
      <div className="subnav-content-heading">
        <div>
          <h2 id={`${id}-heading`}>Appearance</h2>
          <p className="muted">Choose how the dashboard looks.</p>
        </div>
      </div>
      <Switch
        className="settings-theme-switch"
        isSelected={theme === "dark"}
        isDisabled={disabled}
        onChange={onToggle}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
      >
        <span className="settings-theme-switch-copy">
          <span id={`${id}-label`}>Dark mode</span>
          <span id={`${id}-description`} className="muted">
            Use a dark appearance throughout the dashboard.
          </span>
        </span>
        <span className="settings-theme-switch-track" aria-hidden="true">
          <span />
        </span>
      </Switch>
      <p className="muted settings-data-hint">Your preference is saved automatically.</p>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

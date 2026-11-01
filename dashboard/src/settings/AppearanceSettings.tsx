import { useId } from "react";
import { Label, Radio, RadioGroup, Text } from "react-aria-components";
import type { DashboardDensity, DashboardTheme } from "../../../src/dashboard/contract.ts";
import {
  DASHBOARD_DENSITIES,
  DASHBOARD_THEMES,
  DENSITY_LABELS,
  isDashboardDensity,
  isDashboardTheme,
  THEME_LABELS,
} from "../app/appearance.ts";
import { Icon } from "../shared/icons.tsx";

/** A saved choice as `usePreference` returns it. */
interface Preference<T> {
  value: T;
  /** Holds the choice while one is saved, without dimming the options. */
  saving: boolean;
  error: string;
  choose: (value: T) => Promise<void>;
}

export function AppearanceSettings({
  disabled,
  theme,
  density,
}: {
  disabled: boolean;
  theme: Preference<DashboardTheme>;
  density: Preference<DashboardDensity>;
}) {
  const id = useId();
  const saving = theme.saving || density.saving;
  return (
    <section
      className="subnav-content settings-appearance-content"
      aria-labelledby={`${id}-heading`}
    >
      <div className="subnav-content-heading">
        <div>
          <h2 id={`${id}-heading`}>Appearance</h2>
          <p className="muted">Choose how the dashboard looks.</p>
        </div>
        {!disabled && !theme.error && !density.error && (
          <p className="settings-appearance-save" role="status">
            <Icon name={saving ? "clock" : "check"} />
            <span>{saving ? "Saving…" : "Saved automatically"}</span>
          </p>
        )}
      </div>
      <div className="settings-appearance">
        <RadioGroup
          className="settings-choice settings-theme-choice"
          orientation="horizontal"
          value={theme.value}
          isDisabled={disabled}
          isReadOnly={theme.saving}
          onChange={(value) => {
            if (isDashboardTheme(value)) void theme.choose(value);
          }}
        >
          <div className="settings-choice-heading">
            <Label className="settings-choice-title">
              <Icon name="sun" />
              <span>Theme</span>
            </Label>
            <Text slot="description" className="muted">
              Choose a light or dark workspace.
            </Text>
          </div>
          <div className="settings-choice-options">
            {DASHBOARD_THEMES.map((option) => (
              <Radio key={option} value={option} className="settings-choice-option">
                <ThemePreview theme={option} />
                <span className="settings-choice-label">
                  {THEME_LABELS[option]}
                  <span className="ui-choice-radio" aria-hidden="true" />
                </span>
              </Radio>
            ))}
          </div>
          <p className="settings-choice-hint">
            <Icon name="settings" />
            <span>
              {theme.value === "system"
                ? "Follows your device appearance."
                : "Applies across your dashboard."}
            </span>
          </p>
          {theme.error && (
            <p className="error-message" role="alert">
              {theme.error}
            </p>
          )}
        </RadioGroup>
        <RadioGroup
          className="settings-choice settings-density-choice"
          orientation="horizontal"
          value={density.value}
          isDisabled={disabled}
          isReadOnly={density.saving}
          onChange={(value) => {
            if (isDashboardDensity(value)) void density.choose(value);
          }}
        >
          <div className="settings-choice-heading">
            <Label className="settings-choice-title">
              <Icon name="inventory" />
              <span>Density</span>
            </Label>
            <Text slot="description" className="muted">
              Choose how much fits on screen.
            </Text>
          </div>
          <div className="settings-density-options">
            {DASHBOARD_DENSITIES.map((option) => (
              <Radio key={option} value={option} className="settings-density-option">
                {DENSITY_LABELS[option]}
              </Radio>
            ))}
          </div>
          <DensityPreview density={density.value} />
          <p className="settings-choice-hint">Buttons and fields keep their size.</p>
          {density.error && (
            <p className="error-message" role="alert">
              {density.error}
            </p>
          )}
        </RadioGroup>
      </div>
    </section>
  );
}

/** A small picture of the dashboard in one appearance. System shows light and dark side by side. */
function ThemePreview({ theme }: { theme: DashboardTheme }) {
  return (
    <span className="settings-choice-preview" aria-hidden="true">
      {theme === "system" ? (
        <>
          <PreviewScreen appearance="light" />
          <PreviewScreen appearance="dark" />
        </>
      ) : (
        <PreviewScreen appearance={theme} />
      )}
    </span>
  );
}

/** Its own data-theme gives the picture that appearance's tokens, whatever the page uses. */
function PreviewScreen({ appearance }: { appearance: "dark" | "light" }) {
  return (
    <span className="theme-preview-screen" data-theme={appearance}>
      <span className="theme-preview-bar">
        <span className="theme-preview-mark" />
        <span className="theme-preview-tab" data-current />
        <span className="theme-preview-tab" />
        <span className="theme-preview-action" />
      </span>
      <span className="theme-preview-title" />
      <span className="theme-preview-card">
        {(["critical", "high", "medium"] as const).map((severity) => (
          <span key={severity} className="theme-preview-row" data-severity={severity}>
            <span />
            <span />
          </span>
        ))}
      </span>
    </span>
  );
}

/** Severities for the preview's finding rows; the frame cuts off what does not fit. */
const DENSITY_PREVIEW_ROWS = [
  "critical",
  "high",
  "high",
  "medium",
  "medium",
  "low",
  "medium",
  "low",
] as const;

/** The same findings table at each density: the frame shows more rows when compact. */
function DensityPreview({ density }: { density: DashboardDensity }) {
  return (
    <span
      className="settings-choice-preview density-preview"
      data-density={density}
      aria-hidden="true"
    >
      <span className="density-preview-table">
        <span className="density-preview-row" data-head>
          <span />
          <span />
          <span />
        </span>
        {DENSITY_PREVIEW_ROWS.map((severity, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed picture whose rows never move.
          <span key={index} className="density-preview-row" data-severity={severity}>
            <span />
            <span />
            <span />
          </span>
        ))}
      </span>
    </span>
  );
}

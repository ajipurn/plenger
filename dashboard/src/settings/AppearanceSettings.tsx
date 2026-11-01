import { type ReactNode, useId } from "react";
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
  return (
    <section className="subnav-content" aria-labelledby={`${id}-heading`}>
      <div className="subnav-content-heading">
        <div>
          <h2 id={`${id}-heading`}>Appearance</h2>
          <p className="muted">Choose how the dashboard looks.</p>
        </div>
      </div>
      <div className="settings-appearance">
        <Choice
          label="Theme"
          description="System follows your device setting and changes with it."
          options={DASHBOARD_THEMES}
          labels={THEME_LABELS}
          isOption={isDashboardTheme}
          preference={theme}
          disabled={disabled}
          preview={(option) => <ThemePreview theme={option} />}
        />
        <Choice
          label="Density"
          description="Compact fits more rows on screen. Buttons and fields keep their size."
          options={DASHBOARD_DENSITIES}
          labels={DENSITY_LABELS}
          isOption={isDashboardDensity}
          preference={density}
          disabled={disabled}
          preview={(option) => <DensityPreview density={option} />}
        />
      </div>
      <p className="muted settings-data-hint">Your preferences are saved automatically.</p>
    </section>
  );
}

/** One appearance setting as radio cards, each with a picture of what it does. */
function Choice<T extends string>({
  label,
  description,
  options,
  labels,
  isOption,
  preference,
  disabled,
  preview,
}: {
  label: string;
  description: string;
  options: readonly T[];
  labels: Record<T, string>;
  isOption: (value: unknown) => value is T;
  preference: Preference<T>;
  disabled: boolean;
  preview: (option: T) => ReactNode;
}) {
  return (
    <RadioGroup
      className="settings-choice"
      orientation="horizontal"
      value={preference.value}
      isDisabled={disabled}
      isReadOnly={preference.saving}
      onChange={(value) => {
        if (isOption(value)) void preference.choose(value);
      }}
    >
      <div className="settings-choice-heading">
        <Label>{label}</Label>
        <Text slot="description" className="muted">
          {description}
        </Text>
      </div>
      <div className="settings-choice-options">
        {options.map((option) => (
          <Radio key={option} value={option} className="settings-choice-option">
            {preview(option)}
            <span className="settings-choice-label">
              <span className="ui-choice-radio" aria-hidden="true" />
              {labels[option]}
            </span>
          </Radio>
        ))}
      </div>
      {preference.error && (
        <p className="error-message" role="alert">
          {preference.error}
        </p>
      )}
    </RadioGroup>
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

import type { ReactNode } from "react";
import type { RunState } from "../../../src/redteam/constants.ts";
import { capitalize } from "../shared/format.ts";
import { Icon, type IconName } from "../shared/icons.tsx";

export type RunTone = "issue" | "warning" | "neutral";

/** A result's headline: tone icon, title, explanation and status pills on the right. */
export function RunVerdict({
  tone,
  eyebrow,
  title,
  titleId,
  description,
  live = false,
  status,
}: {
  tone: RunTone;
  eyebrow: string;
  title: string;
  titleId: string;
  description: string;
  /** Announce title and description changes while a test is running. */
  live?: boolean;
  status?: ReactNode;
}) {
  return (
    <header className={`run-verdict run-tone-${tone}`}>
      <span className="run-verdict-icon">
        <Icon name={tone === "issue" ? "findings" : "redteam"} />
      </span>
      <div {...(live ? { role: "status", "aria-live": "polite" as const } : {})}>
        <p className="eyebrow">{eyebrow}</p>
        <h3 id={titleId}>{title}</h3>
        <p>{description}</p>
      </div>
      {status && <div className="run-verdict-status">{status}</div>}
    </header>
  );
}

const stateTones: Record<RunState, string> = {
  preparing: "active",
  running: "active",
  completed: "neutral",
  stopped: "warning",
  failed: "error",
};

/** The process state of a run or campaign. It says nothing about the security result. */
export function RunStatePill({ state }: { state: RunState }) {
  return (
    <span className={`state-pill state-${stateTones[state]}`}>
      <span className="state-dot" aria-hidden="true" />
      <span className="sr-only">Process: </span>
      {capitalize(state)}
    </span>
  );
}

export function StatePill({
  tone,
  icon,
  children,
}: {
  tone: "success" | "error" | "warning" | "neutral";
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <span className={`state-pill state-${tone}`}>
      {icon && <Icon name={icon} />}
      {children}
    </span>
  );
}

export interface RunStat {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  /** Draws a usage bar under the value, for example calls admitted against the limit. */
  meter?: { value: number; max: number };
}

/** A row of key figures divided by hairlines. */
export function RunStats({ items, live = false }: { items: RunStat[]; live?: boolean }) {
  return (
    <div className="run-stats" {...(live ? { role: "status" } : {})}>
      <dl>
        {items.map((item) => (
          <div key={item.label}>
            <dt>{item.label}</dt>
            <dd>
              <strong>{item.value}</strong>
              {item.note !== undefined && <span>{item.note}</span>}
              {item.meter && (
                <span className="run-stat-meter" aria-hidden="true">
                  <span
                    style={{
                      width: `${Math.min(100, (item.meter.value / Math.max(1, item.meter.max)) * 100)}%`,
                    }}
                  />
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const alertIcons: Record<"error" | "issue" | "warning" | "info", IconName> = {
  error: "error",
  issue: "findings",
  warning: "alert",
  info: "info",
};

/** A tinted notice inside a result: errors, findings, stale results and context. */
export function RunAlert({
  tone,
  role,
  children,
}: {
  tone: "error" | "issue" | "warning" | "info";
  role?: "status" | "alert";
  children: ReactNode;
}) {
  return (
    <div className={`run-alert run-alert-${tone}`} {...(role ? { role } : {})}>
      <Icon name={alertIcons[tone]} />
      <div>{children}</div>
    </div>
  );
}

/** A titled block inside a result panel, with an optional count or note on the right. */
export function RunSection({
  title,
  aside,
  className = "",
  children,
}: {
  title: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`run-section ${className}`}>
      <div className="run-section-heading">
        <h4>{title}</h4>
        {aside}
      </div>
      {children}
    </div>
  );
}

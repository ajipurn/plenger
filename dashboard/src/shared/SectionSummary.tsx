import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons.tsx";

/**
 * The summary row of a collapsible page section: icon tile, title, one line of
 * description, an optional value on the right and the disclosure chevron.
 */
export function SectionSummary({
  icon,
  title,
  description,
  meta,
  className = "",
}: {
  icon: IconName;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <summary className={`disclosure-heading section-summary ${className}`}>
      <span className="section-summary-icon" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <span className="section-summary-text">
        <strong>{title}</strong>
        {description && <span>{description}</span>}
      </span>
      {meta && <span className="section-summary-meta">{meta}</span>}
      <Icon name="chevron" />
    </summary>
  );
}

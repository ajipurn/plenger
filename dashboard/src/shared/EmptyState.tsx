import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons.tsx";

/**
 * Icon, heading, description, and optional actions. Callers keep their own class
 * names so each feature's styling is unchanged.
 */
export function EmptyState({
  as: Wrapper = "div",
  className,
  icon,
  iconClassName,
  title,
  titleLevel: Title = "h2",
  description,
  descriptionClassName,
  children,
}: {
  as?: "div" | "section";
  className: string;
  icon: IconName;
  /** Wraps the icon in a span when the feature styles a symbol container. */
  iconClassName?: string;
  title?: ReactNode;
  titleLevel?: "h2" | "h3" | "h4";
  description?: ReactNode;
  descriptionClassName?: string;
  children?: ReactNode;
}) {
  return (
    <Wrapper className={className}>
      {iconClassName ? (
        <span className={iconClassName}>
          <Icon name={icon} />
        </span>
      ) : (
        <Icon name={icon} />
      )}
      {title !== undefined && <Title>{title}</Title>}
      {description !== undefined && <p className={descriptionClassName}>{description}</p>}
      {children}
    </Wrapper>
  );
}

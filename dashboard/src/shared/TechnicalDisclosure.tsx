import type { ReactNode } from "react";
import { Icon } from "./icons.tsx";
import { ScrollArea } from "./ScrollArea.tsx";

export function TechnicalDisclosure({
  title,
  children,
  open,
  scrollable = false,
  className = "",
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
  scrollable?: boolean;
  className?: string;
}) {
  return (
    <details className={`technical-disclosure ${className}`} open={open}>
      <summary className="disclosure-heading">
        <span>{title}</span>
        <Icon name="chevron" />
      </summary>
      <div className="technical-content">
        {scrollable ? (
          <ScrollArea className="technical-list-scroll" role="region" aria-label={title}>
            {children}
          </ScrollArea>
        ) : (
          children
        )}
      </div>
    </details>
  );
}

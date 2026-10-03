import { OverlayScrollbarsComponent } from "overlayscrollbars-react";
import type { ComponentProps } from "react";

/** Keep page scrolling native; enhance only bounded lists. */
export function ScrollArea({
  children,
  className,
  role = "region",
  "aria-label": label = "Scrollable list",
  tabIndex = 0,
  ...props
}: ComponentProps<typeof OverlayScrollbarsComponent>) {
  return (
    <OverlayScrollbarsComponent
      defer
      className={`scroll-area ${className ?? ""}`}
      options={{
        overflow: { x: "hidden", y: "scroll" },
        scrollbars: { theme: "os-theme-plenger", autoHide: "never", clickScroll: false },
      }}
      {...props}
      events={{
        initialized(instance) {
          const viewport = instance.elements().viewport;
          viewport.tabIndex = tabIndex;
          viewport.setAttribute("role", role);
          viewport.setAttribute("aria-label", label);
        },
      }}
    >
      {children}
    </OverlayScrollbarsComponent>
  );
}

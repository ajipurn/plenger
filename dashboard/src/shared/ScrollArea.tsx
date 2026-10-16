import { OverlayScrollbarsComponent, useOverlayScrollbars } from "overlayscrollbars-react";
import { type ComponentProps, useCallback } from "react";
import { horizontalScrollbars, verticalScrollbars } from "./scrollbars.ts";

/** Enhance an existing viewport without moving React children. */
export function useElementScrollbars<T extends HTMLElement>(axis: "x" | "y" = "y") {
  const [initialize, instance] = useOverlayScrollbars({
    options: axis === "x" ? horizontalScrollbars : verticalScrollbars,
  });
  return useCallback(
    (element: T | null) => {
      // Dialog portals detach while their parent remains mounted.
      instance()?.destroy();
      if (element) initialize({ target: element, elements: { viewport: element } });
    },
    [initialize, instance],
  );
}

/** A bounded list with a keyboard-accessible viewport. */
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
      options={verticalScrollbars}
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

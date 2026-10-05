import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

interface PopupLayer {
  container: HTMLElement | null;
  setContainer: (element: HTMLElement | null) => void;
}

const PopupLayerContext = createContext<PopupLayer>({
  container: null,
  setContainer: () => {},
});

/**
 * Vaul drawers are Radix modal dialogs: while one is open, Radix sets
 * `pointer-events: none` on `<body>`, traps focus in the drawer and treats any
 * press outside it as a dismissal. Base UI popups portal into the open drawer
 * instead of `<body>`, so they stay clickable and inside its focus scope.
 */
export function PopupLayerProvider({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const value = useMemo(() => ({ container, setContainer }), [container]);
  return <PopupLayerContext.Provider value={value}>{children}</PopupLayerContext.Provider>;
}

/**
 * The open drawer that popups mount into, or null for `<body>`. Pass it to Base UI
 * as `container ?? undefined`: an explicit null makes Base UI wait and render nothing.
 */
export function usePopupContainer(): HTMLElement | null {
  return useContext(PopupLayerContext).container;
}

/** A stable ref callback for the modal surface that should host popups. */
export function usePopupContainerRef(): (element: HTMLElement | null) => void {
  return useContext(PopupLayerContext).setContainer;
}

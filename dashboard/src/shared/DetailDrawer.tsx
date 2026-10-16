import { type ReactNode, type RefObject, useRef } from "react";
import { UNSAFE_PortalProvider } from "react-aria/PortalProvider";
import { Drawer } from "vaul";
import { Icon } from "./icons.tsx";
import { useElementScrollbars } from "./ScrollArea.tsx";
import { Button } from "./ui.tsx";

/** Right-side detail drawer with a heading, close control, and a scrollable body. */
export function DetailDrawer({
  open,
  onOpenChange,
  dismissible = true,
  className,
  headingClassName,
  bodyClassName = "inventory-detail-scroll",
  eyebrow,
  title,
  description,
  descriptionClassName,
  closeLabel,
  closeDisabled = false,
  returnFocus,
  contentRef,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dismissible?: boolean;
  className: string;
  headingClassName: string;
  bodyClassName?: string;
  eyebrow: ReactNode;
  title: ReactNode;
  description: ReactNode;
  descriptionClassName: string;
  closeLabel: string;
  closeDisabled?: boolean;
  /** Resolves the element that regains focus once the drawer has closed. */
  returnFocus: () => HTMLElement | null | undefined;
  /** Allows sibling confirmations to portal inside the drawer's modal focus scope. */
  contentRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const scrollbars = useElementScrollbars<HTMLDivElement>();
  const ownContent = useRef<HTMLDivElement>(null);
  const content = contentRef ?? ownContent;
  const closeButton = useRef<HTMLButtonElement>(null);
  return (
    <Drawer.Root
      direction="right"
      open={open}
      onOpenChange={onOpenChange}
      dismissible={dismissible}
      autoFocus
      repositionInputs={false}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="inventory-drawer-overlay" />
        <Drawer.Content
          ref={content}
          className={className}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            closeButton.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocus();
            if (target?.isConnected) target.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={(event) => {
            // Radix handles Escape during capture. Let the inner React Aria overlay close first.
            if (
              event.target instanceof Element &&
              event.target.closest(".ui-popover, [data-overlay-container]")
            )
              event.preventDefault();
          }}
        >
          <UNSAFE_PortalProvider getContainer={() => content.current}>
            <div className={headingClassName}>
              <div>
                <p className="eyebrow">{eyebrow}</p>
                <Drawer.Title>{title}</Drawer.Title>
                <Drawer.Description className={descriptionClassName}>
                  {description}
                </Drawer.Description>
              </div>
              <Button
                ref={closeButton}
                className="icon-button"
                aria-label={closeLabel}
                disabled={closeDisabled}
                onClick={() => onOpenChange(false)}
              >
                <Icon name="close" />
              </Button>
            </div>
            <div
              className={bodyClassName}
              ref={scrollbars}
              data-overlayscrollbars-initialize=""
              data-vaul-no-drag
            >
              {children}
            </div>
            {footer && (
              <div className="ui-drawer-footer" data-vaul-no-drag>
                {footer}
              </div>
            )}
          </UNSAFE_PortalProvider>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

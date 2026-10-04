import type { ReactNode } from "react";
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
  children,
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
  children: ReactNode;
}) {
  const scrollbars = useElementScrollbars<HTMLDivElement>();
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
          className={className}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus()?.focus({ preventScroll: true });
          }}
        >
          <div className={headingClassName}>
            <div>
              <p className="eyebrow">{eyebrow}</p>
              <Drawer.Title>{title}</Drawer.Title>
              <Drawer.Description className={descriptionClassName}>
                {description}
              </Drawer.Description>
            </div>
            <Drawer.Close asChild>
              <Button className="icon-button" aria-label={closeLabel} disabled={closeDisabled}>
                <Icon name="close" />
              </Button>
            </Drawer.Close>
          </div>
          <div
            className={bodyClassName}
            ref={scrollbars}
            data-overlayscrollbars-initialize=""
            data-vaul-no-drag
          >
            {children}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { type ReactNode, type RefObject, useRef } from "react";
import { useElementScrollbars } from "./ScrollArea.tsx";
import { Button } from "./ui.tsx";

/** Destructive confirmation with a cancel control that receives initial focus. */
export function ConfirmDialog({
  open,
  busy,
  error,
  title,
  description,
  confirmLabel,
  onClose,
  onConfirm,
  finalFocus,
  backdropClassName = "project-dialog-backdrop",
  viewportClassName = "project-dialog-viewport",
  popupClassName = "project-dialog",
  actionsClassName,
  scrollable = false,
}: {
  open: boolean;
  busy: boolean;
  error: string;
  title: string;
  description: ReactNode;
  confirmLabel: ReactNode;
  onClose: () => void;
  onConfirm: () => void;
  finalFocus: RefObject<HTMLElement | null>;
  backdropClassName?: string;
  viewportClassName?: string;
  popupClassName?: string;
  actionsClassName: string;
  /** Enhance the popup with overlay scrollbars for long descriptions. */
  scrollable?: boolean;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const scrollbars = useElementScrollbars<HTMLDivElement>();
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={backdropClassName} />
        <AlertDialog.Viewport className={viewportClassName}>
          <AlertDialog.Popup
            {...(scrollable ? { ref: scrollbars, "data-overlayscrollbars-initialize": "" } : {})}
            className={popupClassName}
            initialFocus={cancel}
            finalFocus={finalFocus}
          >
            <div className="dialog-heading">
              <AlertDialog.Title>{title}</AlertDialog.Title>
            </div>
            <AlertDialog.Description className="muted">{description}</AlertDialog.Description>
            {error && (
              <p className="error-message" role="alert">
                {error}
              </p>
            )}
            <div className={actionsClassName}>
              <Button
                ref={cancel}
                className="button button-secondary"
                disabled={busy}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button className="button button-danger" disabled={busy} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

import type { ReactNode, RefObject } from "react";
import { Dialog, Heading, Modal, ModalOverlay, Text } from "react-aria-components";
import { NumericText } from "./MorphNumber.tsx";
import { useElementScrollbars } from "./ScrollArea.tsx";
import { Button } from "./ui.tsx";
import { useDialogFocus } from "./useDialogFocus.ts";

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
  const scrollbars = useElementScrollbars<HTMLDivElement>();
  useDialogFocus(open, () => finalFocus.current);
  return (
    <ModalOverlay
      isOpen={open}
      isKeyboardDismissDisabled={busy}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      className={`${backdropClassName} ${viewportClassName}`}
    >
      <Modal
        {...(scrollable ? { ref: scrollbars, "data-overlayscrollbars-initialize": "" } : {})}
        className={popupClassName}
      >
        <Dialog role="alertdialog" className="ui-dialog">
          <div className="dialog-heading">
            <Heading slot="title">{title}</Heading>
          </div>
          <Text slot="description" className="muted">
            {description}
          </Text>
          {error && (
            <p className="error-message" role="alert">
              <NumericText>{error}</NumericText>
            </p>
          )}
          <div className={actionsClassName}>
            <Button className="button button-secondary" disabled={busy} onClick={onClose} autoFocus>
              Cancel
            </Button>
            <Button className="button button-danger" disabled={busy} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { type RefObject, useRef } from "react";
import { Icon } from "./icons.tsx";
import { useElementScrollbars } from "./ScrollArea.tsx";
import { Button } from "./ui.tsx";

export function ClearSavedData({
  open,
  busy,
  error,
  returnFocus,
  onClose,
  onClear,
}: {
  open: boolean;
  busy: boolean;
  error: string;
  returnFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
  onClear: () => Promise<void>;
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
        <AlertDialog.Backdrop className="project-dialog-backdrop" />
        <AlertDialog.Viewport className="project-dialog-viewport">
          <AlertDialog.Popup
            ref={scrollbars}
            data-overlayscrollbars-initialize=""
            className="project-dialog clear-dialog"
            initialFocus={cancel}
            finalFocus={returnFocus}
          >
            <div className="dialog-heading">
              <AlertDialog.Title>Clear saved data?</AlertDialog.Title>
            </div>
            <AlertDialog.Description className="muted">
              Delete all saved scans, project reviews, red-team runs, run settings, and project
              selections on this device. Your project files and exported reports stay unchanged.
            </AlertDialog.Description>
            {error && (
              <p className="error-message" role="alert">
                {error}
              </p>
            )}
            <div className="clear-dialog-actions">
              <Button
                ref={cancel}
                className="button button-secondary"
                disabled={busy}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button
                className="button button-danger"
                disabled={busy}
                onClick={() => void onClear()}
              >
                {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="trash" />}
                {busy ? "Clearing…" : "Clear saved data"}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

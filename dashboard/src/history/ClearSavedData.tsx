import type { RefObject } from "react";
import { ConfirmDialog } from "../shared/ConfirmDialog.tsx";
import { Icon } from "../shared/icons.tsx";

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
  return (
    <ConfirmDialog
      open={open}
      busy={busy}
      error={error}
      title="Clear saved data?"
      description="Delete all saved scans, project reviews, red-team runs, run settings and project selections on this device. Saved providers stay in Settings. Your project files and exported reports stay unchanged."
      confirmLabel={
        <>
          {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="trash" />}
          {busy ? "Clearing…" : "Clear saved data"}
        </>
      }
      onClose={onClose}
      onConfirm={() => void onClear()}
      finalFocus={returnFocus}
      popupClassName="project-dialog clear-dialog"
      actionsClassName="clear-dialog-actions"
      scrollable
    />
  );
}

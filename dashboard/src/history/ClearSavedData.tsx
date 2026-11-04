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
      title="Clear all workspace data?"
      description="Permanently delete all saved projects, scans, findings, rounds, imported evidence and red-team results on this device. Providers and their credentials are kept. Your project files and exported reports stay unchanged. This cannot be undone."
      confirmLabel={
        <>
          {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="trash" />}
          {busy ? "Clearing…" : "Clear data"}
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

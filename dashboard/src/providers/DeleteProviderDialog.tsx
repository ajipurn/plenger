import type { RefObject } from "react";
import type { SavedProvider } from "../../../src/redteam/provider-config.ts";
import { ConfirmDialog } from "../shared/ConfirmDialog.tsx";

export function DeleteProviderDialog({
  provider,
  busy,
  error,
  finalFocus,
  onClose,
  onConfirm,
}: {
  /** The provider awaiting confirmation; the dialog is closed when null. */
  provider: SavedProvider | null;
  busy: boolean;
  error: string;
  finalFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      open={!!provider}
      busy={busy}
      error={error}
      title="Delete provider?"
      description={
        <>
          Delete {provider?.name} and its saved API key? Existing test results stay saved. Select
          another provider before running new tests.
        </>
      }
      confirmLabel="Delete provider"
      onClose={onClose}
      onConfirm={onConfirm}
      finalFocus={finalFocus}
      backdropClassName="project-dialog-backdrop provider-delete-backdrop"
      viewportClassName="project-dialog-viewport provider-delete-viewport"
      actionsClassName="provider-actions provider-delete-actions"
    />
  );
}

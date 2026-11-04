import { type RefObject, useRef, useState } from "react";
import type { LocalRepository } from "../../../src/dashboard/contract.ts";
import { useApi } from "../app/DashboardContext.tsx";
import { useAsyncAction } from "../shared/async.ts";
import { ConfirmDialog } from "../shared/ConfirmDialog.tsx";
import { plural } from "../shared/format.ts";
import { Icon } from "../shared/icons.tsx";
import { NumericText } from "../shared/MorphNumber.tsx";
import { notifySuccess } from "../shared/toast.tsx";

export type ProjectDeletion = ReturnType<typeof useProjectDeletion>;

/**
 * Confirmation and request state for deleting one saved project. `onDeleted` runs once the
 * service has deleted it. Focus returns to the invoking control, or to `fallbackFocus` when
 * the deletion removed that control.
 */
export function useProjectDeletion(
  onDeleted: () => Promise<void> | void,
  fallbackFocus?: RefObject<HTMLElement | null>,
) {
  const api = useApi();
  const [project, setProject] = useState<LocalRepository | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const { busy, error, setError, run } = useAsyncAction();
  return {
    project,
    busy,
    error,
    returnFocus,
    open(next: LocalRepository, trigger: HTMLElement) {
      returnFocus.current = trigger;
      setError("");
      setProject(next);
    },
    close() {
      setProject(null);
    },
    async confirm() {
      if (!api || !project) return;
      await run(async () => {
        await api.deleteRepository(project.id);
        if (fallbackFocus) returnFocus.current = fallbackFocus.current;
        setProject(null);
        await onDeleted();
        notifySuccess("Project deleted.");
      }, "Unable to delete the project. Check the local service connection and try again.");
    },
  };
}

export function DeleteProjectDialog({
  deletion,
  scans,
}: {
  deletion: ProjectDeletion;
  /** How many saved scans the project awaiting confirmation has. */
  scans: number;
}) {
  const { project, busy, error } = deletion;
  return (
    <ConfirmDialog
      open={!!project}
      busy={busy}
      error={error}
      title="Delete project?"
      description={
        <>
          <NumericText>
            {scans
              ? `Delete ${project?.name} and its ${scans} ${plural(scans, "scan")} from this device? Saved findings, rounds, imported evidence and the threat model are deleted with it.`
              : `Delete ${project?.name} from this device? It has no saved scans.`}
          </NumericText>{" "}
          The folder and its files stay unchanged. This cannot be undone.
        </>
      }
      confirmLabel={
        <>
          {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="trash" />}
          {busy ? "Deleting…" : "Delete project"}
        </>
      }
      onClose={deletion.close}
      onConfirm={() => void deletion.confirm()}
      finalFocus={deletion.returnFocus}
      popupClassName="project-dialog clear-dialog"
      actionsClassName="clear-dialog-actions"
    />
  );
}

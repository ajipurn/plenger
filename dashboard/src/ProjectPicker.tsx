import { Dialog } from "@base-ui/react/dialog";
import { type FormEvent, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { FolderListing } from "../../src/dashboard/model.ts";
import type { DashboardApi } from "./api.ts";
import { Icon } from "./icons.tsx";
import { ScrollArea } from "./ScrollArea.tsx";
import { Button, Input } from "./ui.tsx";

export function ProjectPicker({
  api,
  initial,
  open = true,
  returnFocus,
  onSelect,
  onClose,
}: {
  api: DashboardApi;
  initial: string;
  open?: boolean;
  returnFocus?: RefObject<HTMLElement | null>;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const initialFocus = useRef<HTMLInputElement>(null);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [path, setPath] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const browse = useCallback(
    async (destination: string) => {
      const current = ++sequence.current;
      setBusy(true);
      setError("");
      try {
        const result = await api.folders(destination);
        if (current === sequence.current) {
          setListing(result);
          setPath(result.path);
        }
      } catch (error) {
        if (current === sequence.current)
          setError(error instanceof Error ? error.message : "Unable to open this folder.");
      } finally {
        if (current === sequence.current) setBusy(false);
      }
    },
    [api],
  );
  useEffect(() => {
    if (open) {
      setPath(initial);
      setListing(null);
      void browse(initial);
    }
    return () => {
      sequence.current += 1;
    };
  }, [browse, initial, open]);
  function navigate(event: FormEvent) {
    event.preventDefault();
    void browse(path);
  }
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="project-dialog-backdrop" />
        <Dialog.Viewport className="project-dialog-viewport">
          <Dialog.Popup
            className="project-dialog"
            initialFocus={initialFocus}
            finalFocus={returnFocus}
          >
            <div className="dialog-heading">
              <div className="picker-heading-main">
                <span className="picker-symbol">
                  <Icon name="folder" />
                </span>
                <div>
                  <p className="eyebrow">Local workspace</p>
                  <Dialog.Title>Select a project</Dialog.Title>
                </div>
              </div>
              <Button
                type="button"
                className="icon-button"
                onClick={onClose}
                aria-label="Close project picker"
              >
                <Icon name="close" />
              </Button>
            </div>
            <Dialog.Description className="muted">
              Choose the folder containing your agent’s source code. Browse below or enter its path.
            </Dialog.Description>
            <form onSubmit={navigate} className="folder-path-form">
              <div className="field">
                <label htmlFor="folder-path">Folder path</label>
                <div className="folder-path-field">
                  <Icon name="folder" />
                  <Input
                    ref={initialFocus}
                    id="folder-path"
                    name="folder-path"
                    autoComplete="off"
                    value={path}
                    onChange={(event) => setPath(event.target.value)}
                    aria-invalid={!!error}
                    aria-describedby={error ? "folder-error" : undefined}
                    required
                  />
                </div>
              </div>
              <Button type="submit" className="button button-secondary" disabled={busy}>
                Open folder
              </Button>
            </form>
            {error && (
              <p id="folder-error" role="alert" className="error-message">
                {error}
              </p>
            )}
            <div className="folder-navigation">
              <Button
                type="button"
                className="button button-quiet"
                disabled={busy || !listing?.parent}
                onClick={() => {
                  if (listing?.parent) void browse(listing.parent);
                }}
              >
                <Icon name="arrow" /> Parent folder
              </Button>
              <span className="muted" role="status">
                {busy
                  ? "Opening folder…"
                  : listing
                    ? `${listing.folders.length} ${listing.folders.length === 1 ? "folder" : "folders"}`
                    : "Choose a folder"}
              </span>
            </div>
            <ScrollArea
              className="folder-list"
              role="region"
              aria-label="Project subfolders"
              aria-busy={busy}
            >
              {listing?.folders.map((folder) => (
                <Button
                  key={folder.path}
                  type="button"
                  className="picker-folder"
                  disabled={busy}
                  onClick={() => void browse(folder.path)}
                >
                  <Icon name="folder" />
                  <span>{folder.name}</span>
                  <Icon name="chevron" />
                </Button>
              ))}
              {!busy && listing && listing.folders.length === 0 && (
                <div className="empty-state compact">
                  <Icon name="folder" />
                  <p>No subfolders</p>
                  <span className="muted">You can select this folder as your project.</span>
                </div>
              )}
              {busy && !listing && (
                <div className="empty-state compact">
                  <span className="spinner" aria-hidden="true" />
                  <p className="muted">Opening your workspace…</p>
                </div>
              )}
              {!busy && !listing && error && (
                <div className="empty-state compact">
                  <Icon name="folder" />
                  <p>Folder could not be opened</p>
                  <span className="muted">Enter an existing folder path and try again.</span>
                </div>
              )}
            </ScrollArea>
            <div className="dialog-footer">
              <div className="folder-current-path">
                <span className="muted">Current folder</span>
                <p className="break-path">{listing?.path ?? initial}</p>
              </div>
              <div className="dialog-footer-actions">
                <Button type="button" className="button button-secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  className="button button-primary"
                  disabled={busy || !listing || !!error || path !== listing.path}
                  onClick={() => {
                    if (listing) onSelect(listing.path);
                  }}
                >
                  <Icon name="check" />
                  Select this folder
                </Button>
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import { type FormEvent, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { FolderListing } from "../../../src/dashboard/contract.ts";
import { useApi } from "../app/DashboardContext.tsx";
import { errorMessage } from "../shared/async.ts";
import { plural } from "../shared/format.ts";
import { Icon } from "../shared/icons.tsx";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { pathSegments } from "../shared/paths.ts";
import { ScrollArea, useElementScrollbars } from "../shared/ScrollArea.tsx";
import { Button, Input } from "../shared/ui.tsx";

export function ProjectPicker({
  initial,
  open = true,
  returnFocus,
  onSelect,
  onClose,
}: {
  initial: string;
  open?: boolean;
  returnFocus?: RefObject<HTMLElement | null>;
  onSelect: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const api = useApi();
  const initialFocus = useRef<HTMLButtonElement>(null);
  const pathInput = useRef<HTMLInputElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const [editingPath, setEditingPath] = useState(false);
  const popupScrollbars = useElementScrollbars<HTMLDivElement>();
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [path, setPath] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const pickerRequest = useRef<AbortController | null>(null);
  const browse = useCallback(
    async (destination: string) => {
      if (!api) return;
      const current = ++sequence.current;
      setBusy(true);
      setError("");
      try {
        const result = await api.folders(destination);
        if (current === sequence.current) {
          setListing(result);
          setPath(result.path);
          setEditingPath(false);
        }
      } catch (error) {
        if (current === sequence.current)
          setError(errorMessage(error, "Unable to open this folder."));
      } finally {
        if (current === sequence.current) setBusy(false);
      }
    },
    [api],
  );
  useEffect(() => {
    if (open) {
      setPath(initial);
      setEditingPath(false);
      setListing(null);
      void browse(initial);
    }
    return () => {
      sequence.current += 1;
      pickerRequest.current?.abort();
    };
  }, [browse, initial, open]);
  useEffect(() => {
    if (editingPath) {
      pathInput.current?.focus();
      pathInput.current?.select();
    } else {
      if (wasEditing.current) editButton.current?.focus();
    }
    wasEditing.current = editingPath;
  }, [editingPath]);
  const currentPath = listing?.path ?? initial;
  const pathParts = pathSegments(currentPath);
  const breadcrumbs = [
    { name: "/", path: "/" },
    ...pathParts.map((name, index) => ({
      name,
      path: `/${pathParts.slice(0, index + 1).join("/")}`,
    })),
  ];
  const visibleBreadcrumbs = breadcrumbs.slice(-2);
  const hiddenBreadcrumbs = breadcrumbs.slice(0, -2);
  const folderName = pathParts.at(-1) ?? "/";
  function editPath() {
    setPath(currentPath);
    setEditingPath(true);
  }
  function navigate(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    void browse(path);
  }
  async function chooseFolder() {
    if (!api) return;
    const current = ++sequence.current;
    const controller = new AbortController();
    pickerRequest.current = controller;
    setBusy(true);
    setError("");
    try {
      const result = await api.chooseFolder(listing?.path ?? initial, controller.signal);
      if (current === sequence.current && result.folder) {
        setListing(result.folder);
        setPath(result.folder.path);
        setEditingPath(false);
      }
    } catch (error) {
      if (current === sequence.current && !controller.signal.aborted)
        setError(errorMessage(error, "Unable to open the system folder picker."));
    } finally {
      if (current === sequence.current) setBusy(false);
      if (pickerRequest.current === controller) pickerRequest.current = null;
    }
  }
  async function select() {
    if (!listing || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSelect(listing.path);
    } catch (error) {
      setError(errorMessage(error, "Unable to select this project."));
    } finally {
      setBusy(false);
    }
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
            ref={popupScrollbars}
            data-overlayscrollbars-initialize=""
            className="project-dialog"
            initialFocus={initialFocus}
            finalFocus={returnFocus}
          >
            <div className="dialog-heading">
              <Dialog.Title>Select a project</Dialog.Title>
              <Button
                ref={initialFocus}
                type="button"
                className="icon-button"
                onClick={onClose}
                aria-label="Close project picker"
              >
                <Icon name="close" />
              </Button>
            </div>
            <Dialog.Description className="sr-only">
              Browse to your project folder, edit its path, or choose a folder from your device.
            </Dialog.Description>
            <div className="picker-location-label">
              <span>Location</span>
              <span className="sr-only" id="folder-path-hint">
                Press Enter to open the path, or Escape to cancel editing.
              </span>
            </div>
            <form onSubmit={navigate} className="folder-path-form">
              {editingPath ? (
                <div key="path-input" className="folder-path-field">
                  <Icon name="folder" />
                  <Input
                    ref={pathInput}
                    id="folder-path"
                    name="folder-path"
                    aria-label="Folder path"
                    autoComplete="off"
                    value={path}
                    onChange={(event) => setPath(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        setPath(currentPath);
                        setError("");
                        setEditingPath(false);
                      }
                    }}
                    aria-invalid={!!error}
                    aria-describedby={`folder-path-hint${error ? " folder-error" : ""}`}
                    required
                  />
                  <Button
                    type="submit"
                    className="picker-location-action"
                    aria-label="Open folder path"
                    disabled={busy}
                  >
                    <Icon name="check" />
                  </Button>
                </div>
              ) : (
                <div key="breadcrumbs" className="picker-location">
                  <Icon name="folder" />
                  <nav className="picker-breadcrumbs" aria-label="Folder location">
                    {hiddenBreadcrumbs.length > 0 && (
                      <Menu.Root>
                        <Menu.Trigger
                          className="picker-ancestor-trigger"
                          aria-label="Show parent folders"
                          title="Show parent folders"
                          disabled={busy}
                        >
                          …
                        </Menu.Trigger>
                        <Menu.Portal>
                          <Menu.Positioner
                            className="picker-ancestor-positioner"
                            align="start"
                            sideOffset={6}
                          >
                            <Menu.Popup className="picker-ancestor-menu">
                              {hiddenBreadcrumbs.map((crumb) => (
                                <Menu.Item
                                  key={crumb.path}
                                  className="picker-ancestor-item"
                                  title={crumb.path}
                                  onClick={() => void browse(crumb.path)}
                                >
                                  <Icon name="folder" />
                                  <span>{crumb.name}</span>
                                </Menu.Item>
                              ))}
                            </Menu.Popup>
                          </Menu.Positioner>
                        </Menu.Portal>
                      </Menu.Root>
                    )}
                    {visibleBreadcrumbs.map((crumb, index) => (
                      <span
                        key={crumb.path}
                        className={
                          crumb.path === currentPath
                            ? "picker-current-crumb"
                            : "picker-parent-crumb"
                        }
                      >
                        {(index > 0 || hiddenBreadcrumbs.length > 0) && <Icon name="chevron" />}
                        <Button
                          type="button"
                          disabled={busy}
                          aria-current={crumb.path === currentPath ? "location" : undefined}
                          title={crumb.path}
                          onClick={() => void browse(crumb.path)}
                        >
                          <span>{crumb.name}</span>
                        </Button>
                      </span>
                    ))}
                  </nav>
                  <Button
                    ref={editButton}
                    type="button"
                    className="picker-location-action picker-edit-action"
                    aria-label="Edit folder path"
                    title="Edit folder path"
                    disabled={busy}
                    onClick={(event) => {
                      // Keep the activating click from submitting the newly mounted path form.
                      event.preventDefault();
                      editPath();
                    }}
                  >
                    <Icon name="edit" />
                    <span>Edit</span>
                  </Button>
                </div>
              )}
              <Button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() => void chooseFolder()}
              >
                Browse…
              </Button>
            </form>
            {error && (
              <p id="folder-error" role="alert" className="error-message">
                {error}
              </p>
            )}
            <div className="folder-navigation">
              <span>Folders</span>
              <span className="muted" role="status">
                {busy ? (
                  "Opening folder…"
                ) : listing ? (
                  <>
                    <MorphNumber value={listing.folders.length} />{" "}
                    {plural(listing.folders.length, "folder")}
                  </>
                ) : (
                  "Choose a folder"
                )}
              </span>
            </div>
            <ScrollArea
              className="folder-list"
              role="region"
              aria-label="Project subfolders"
              aria-busy={busy}
            >
              {listing?.parent && (
                <Button
                  type="button"
                  className="picker-folder"
                  disabled={busy}
                  onClick={() => {
                    if (listing.parent) void browse(listing.parent);
                  }}
                >
                  <Icon name="parent-folder" />
                  <span>Parent folder</span>
                  <Icon name="chevron" />
                </Button>
              )}
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
                <div className="picker-folder-skeleton" aria-hidden="true">
                  {["first", "second", "third", "fourth"].map((row) => (
                    <div key={row}>
                      <span className="skeleton-block skeleton-symbol" />
                      <span className="skeleton-block skeleton-row-title" />
                    </div>
                  ))}
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
              <div className="picker-selected-folder" title={currentPath}>
                <Icon name="folder" />
                <div>
                  <span className="muted">Selected folder</span>
                  <strong>{folderName}</strong>
                </div>
              </div>
              <div className="dialog-footer-actions">
                <Button type="button" className="button button-secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  className="button button-primary"
                  disabled={busy || !listing || !!error || path !== listing.path}
                  onClick={() => void select()}
                >
                  <Icon name="check" />
                  Open project
                </Button>
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

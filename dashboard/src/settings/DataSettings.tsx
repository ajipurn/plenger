import { useId, useRef, useState } from "react";
import { useApi } from "../app/DashboardContext.tsx";
import { ClearSavedData } from "../history/ClearSavedData.tsx";
import { useAsyncAction } from "../shared/async.ts";
import { Icon } from "../shared/icons.tsx";
import { notifySuccess } from "../shared/toast.tsx";
import { Button } from "../shared/ui.tsx";

export function DataSettings({ active, onCleared }: { active: boolean; onCleared: () => void }) {
  const api = useApi();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const { busy, error, setError, run } = useAsyncAction();

  async function clear() {
    if (!api) return;
    await run(async () => {
      await api.clear();
      onCleared();
      setOpen(false);
      notifySuccess("Workspace data cleared.");
    }, "Unable to clear saved data. Check the local service connection and try again.");
  }

  return (
    <section className="subnav-content settings-data-content" aria-labelledby={`${id}-heading`}>
      <div className="subnav-content-heading">
        <div>
          <h2 id={`${id}-heading`}>Data</h2>
          <p className="muted">Manage the workspace data saved on this device.</p>
        </div>
      </div>
      <section className="settings-clear-data" aria-labelledby={`${id}-clear`}>
        <div className="settings-data-card-heading">
          <h3 id={`${id}-clear`}>Clear saved data</h3>
          <p className="muted">
            Remove all saved projects and security review history from this device.
          </p>
        </div>
        <div className="settings-data-scope">
          <section className="settings-data-scope-group" aria-labelledby={`${id}-deleted`}>
            <h4 id={`${id}-deleted`} className="settings-data-scope-title">
              Will be deleted
            </h4>
            <ul className="settings-data-list">
              <li>
                <Icon name="folder" />
                <span>All saved projects</span>
              </li>
              <li>
                <Icon name="history" />
                <span>Scans, findings and rounds</span>
              </li>
              <li>
                <Icon name="data-stores" />
                <span>Imported evidence and red-team results</span>
              </li>
            </ul>
          </section>
          <section className="settings-data-scope-group" aria-labelledby={`${id}-kept`}>
            <h4 id={`${id}-kept`} className="settings-data-scope-title">
              Will be kept
            </h4>
            <ul className="settings-data-list">
              <li>
                <Icon name="providers" />
                <span>Providers and credentials</span>
              </li>
              <li>
                <Icon name="sun" />
                <span>Appearance preferences</span>
              </li>
              <li>
                <Icon name="source-files" />
                <span>Project files and exported reports</span>
              </li>
            </ul>
          </section>
        </div>
        <div className="settings-data-actions">
          <p id={`${id}-warning`} className="settings-data-warning">
            <Icon name="alert" />
            <span>This action cannot be undone.</span>
          </p>
          <Button
            ref={trigger}
            className="button button-danger"
            disabled={!api || active || busy}
            aria-describedby={`${id}-warning${active ? ` ${id}-active` : ""}`}
            onClick={() => {
              setError("");
              setOpen(true);
            }}
          >
            <Icon name="trash" /> Clear data
          </Button>
        </div>
      </section>
      {active && (
        <p id={`${id}-active`} className="muted settings-data-hint">
          Finish, pause or stop the running scan before clearing data.
        </p>
      )}
      <ClearSavedData
        open={open}
        busy={busy}
        error={error}
        returnFocus={trigger}
        onClose={() => setOpen(false)}
        onClear={clear}
      />
    </section>
  );
}

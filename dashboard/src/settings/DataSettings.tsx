import { useId, useRef, useState } from "react";
import { useApi } from "../app/DashboardContext.tsx";
import { ClearSavedData } from "../history/ClearSavedData.tsx";
import { useAsyncAction } from "../shared/async.ts";
import { Icon } from "../shared/icons.tsx";
import { Button } from "../shared/ui.tsx";

export function DataSettings({ active, onCleared }: { active: boolean; onCleared: () => void }) {
  const api = useApi();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const { busy, error, setError, run } = useAsyncAction();

  async function clear() {
    if (!api) return;
    await run(async () => {
      await api.clear();
      onCleared();
      setOpen(false);
      setNotice("Workspace data cleared. Providers and credentials are kept.");
    }, "Unable to clear saved data. Check the local service connection and try again.");
  }

  return (
    <section className="subnav-content" aria-labelledby={`${id}-heading`}>
      <div className="subnav-content-heading">
        <div>
          <h2 id={`${id}-heading`}>Data</h2>
          <p className="muted">Manage the workspace data saved on this device.</p>
        </div>
      </div>
      <section className="settings-clear-data" aria-labelledby={`${id}-clear`}>
        <div>
          <h3 id={`${id}-clear`}>Clear data</h3>
          <p className="muted">
            Delete all saved projects, scans, findings, reviews and red-team results. Providers and
            their credentials are kept.
          </p>
          <p className="muted">
            This cannot be undone. Your project files and exported reports stay unchanged.
          </p>
        </div>
        <Button
          ref={trigger}
          className="button button-danger"
          disabled={!api || active || busy}
          {...(active ? { "aria-describedby": `${id}-active` } : {})}
          onClick={() => {
            setError("");
            setNotice("");
            setOpen(true);
          }}
        >
          <Icon name="trash" /> Clear data
        </Button>
      </section>
      {active && (
        <p id={`${id}-active`} className="muted settings-data-hint">
          Finish, pause or stop the running scan before clearing data.
        </p>
      )}
      <div role="status">{notice && <p className="provider-notice">{notice}</p>}</div>
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

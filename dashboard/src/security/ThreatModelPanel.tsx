import { useId, useState } from "react";
import { type LocalRepository, THREAT_MODEL_LIMITS } from "../../../src/dashboard/contract.ts";
import { useApi } from "../app/DashboardContext.tsx";
import { errorMessage } from "../shared/async.ts";
import { Icon } from "../shared/icons.tsx";
import { MorphNumber, NumericText } from "../shared/MorphNumber.tsx";
import { Button, TextArea } from "../shared/ui.tsx";
import { date } from "./ui.tsx";

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * The project's threat model: what the reviews derived, or what the user wrote. Every
 * review of the next scan starts from it; a written one is kept as written.
 */
export function ThreatModelPanel({
  project,
  onChanged,
}: {
  project: LocalRepository;
  onChanged: () => Promise<void>;
}) {
  const api = useApi();
  const id = useId();
  const model = project.threatModel;
  const [editing, setEditing] = useState(false);
  const [architecture, setArchitecture] = useState("");
  const [assets, setAssets] = useState("");
  const [boundaries, setBoundaries] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const edit = () => {
    setArchitecture(model?.architecture ?? "");
    setAssets((model?.assets ?? []).join("\n"));
    setBoundaries((model?.trustBoundaries ?? []).join("\n"));
    setError("");
    setEditing(true);
  };
  async function save(threatModel: Parameters<NonNullable<typeof api>["updateRepository"]>[1]) {
    if (!api) return;
    setBusy(true);
    setError("");
    try {
      await api.updateRepository(project.id, threatModel);
      await onChanged();
      setEditing(false);
    } catch (failure) {
      setError(errorMessage(failure, "Unable to save the threat model."));
    } finally {
      setBusy(false);
    }
  }
  const L = THREAT_MODEL_LIMITS;
  return (
    <section className="security-threat-model">
      <h2>
        <Icon name="checklist" /> Threat model
      </h2>
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save({
              threatModel: {
                architecture: architecture.trim(),
                assets: lines(assets),
                trustBoundaries: lines(boundaries),
              },
            });
          }}
        >
          <div className="security-form-block">
            <label htmlFor={`${id}-architecture`}>Architecture</label>
            <TextArea
              id={`${id}-architecture`}
              value={architecture}
              onChange={(event) => setArchitecture(event.target.value)}
              rows={4}
              maxLength={L.textCharacters}
              disabled={busy}
            />
          </div>
          <div className="security-form-block">
            <label htmlFor={`${id}-assets`}>Assets, one per line</label>
            <TextArea
              id={`${id}-assets`}
              value={assets}
              onChange={(event) => setAssets(event.target.value)}
              rows={4}
              disabled={busy}
            />
          </div>
          <div className="security-form-block">
            <label htmlFor={`${id}-boundaries`}>Trust boundaries, one per line</label>
            <TextArea
              id={`${id}-boundaries`}
              value={boundaries}
              onChange={(event) => setBoundaries(event.target.value)}
              rows={4}
              disabled={busy}
            />
          </div>
          <p className="muted">
            Up to {L.items} assets and {L.items} trust boundaries. Reviews keep a model you write
            and only report where the source disagrees.
          </p>
          {error && (
            <p role="alert" className="error-message">
              <NumericText>{error}</NumericText>
            </p>
          )}
          <div className="security-threat-model-actions">
            <Button className="button button-primary" type="submit" disabled={busy}>
              Save
            </Button>
            <Button
              className="button button-secondary"
              onClick={() => setEditing(false)}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : model ? (
        <>
          <p className="muted">
            Version <MorphNumber value={model.version} /> ·{" "}
            {model.origin === "user" ? "written on this page" : "derived by the last scan"} ·{" "}
            <MorphNumber value={date(model.updatedAt)} variant="text" />
          </p>
          <p>{model.architecture || "No architecture written."}</p>
          {model.assets.length > 0 && (
            <>
              <h3>Assets</h3>
              <ul>
                {model.assets.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
          {model.trustBoundaries.length > 0 && (
            <>
              <h3>Trust boundaries</h3>
              <ul>
                {model.trustBoundaries.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
          {error && (
            <p role="alert" className="error-message">
              <NumericText>{error}</NumericText>
            </p>
          )}
          <div className="security-threat-model-actions">
            <Button className="button button-secondary" onClick={edit} disabled={busy}>
              Edit
            </Button>
            {model.origin === "user" && (
              <Button
                className="button button-secondary"
                onClick={() => void save({ threatModel: null })}
                disabled={busy}
              >
                Let scans derive it
              </Button>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            The first scan derives the project's architecture, assets and trust boundaries, and
            later reviews start from them. You can also write them now.
          </p>
          <Button className="button button-secondary" onClick={edit}>
            Write threat model
          </Button>
        </>
      )}
    </section>
  );
}

import { useEffect, useId, useRef, useState } from "react";
import { Label, Radio, RadioGroup } from "react-aria-components";
import { Link } from "react-router";
import {
  type LocalRepository,
  reviewBudget,
  SCAN_DEPTHS,
  type ScanDepth,
  SECURITY_REVIEW_LIMITS,
  type SecurityScan,
  WORKSPACE_LIMITS,
} from "../../../src/dashboard/contract.ts";
import {
  hasProviderModelCatalog,
  type SavedProvider,
} from "../../../src/redteam/provider-config.ts";
import { useApi } from "../app/DashboardContext.tsx";
import { useProviderModels } from "../providers/useProviderModels.ts";
import { errorMessage } from "../shared/async.ts";
import { DetailDrawer } from "../shared/DetailDrawer.tsx";
import { Icon } from "../shared/icons.tsx";
import { Button, Input, Select, TextArea } from "../shared/ui.tsx";

/** The second review uses the discovery provider and model. */
const SAME_VALIDATOR = "same";
export function ProjectForm({
  open,
  onClose,
  onCreated,
  returnFocus,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (project: LocalRepository) => void;
  returnFocus: () => HTMLElement | null;
}) {
  const api = useApi();
  const id = useId();
  const [path, setPath] = useState(api?.session.workspace ?? "");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pathInput = useRef<HTMLInputElement>(null);
  async function browse() {
    if (!api) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.chooseFolder(path || api.session.workspace);
      if (result.folder) setPath(result.folder.path);
    } catch (failure) {
      setError(errorMessage(failure, "Enter the local folder path to continue."));
      pathInput.current?.focus();
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    if (!api) return;
    setBusy(true);
    setError("");
    try {
      const project = await api.addRepository({
        path,
        name: name.trim() || path.split(/[\\/]/).filter(Boolean).at(-1) || "Project",
        notes,
      });
      onCreated(project);
      onClose();
    } catch (failure) {
      setError(errorMessage(failure, "Unable to add project. Check the local folder path."));
      pathInput.current?.focus();
    } finally {
      setBusy(false);
    }
  }
  return (
    <DetailDrawer
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      dismissible={!busy}
      className="inventory-detail-panel security-drawer"
      headingClassName="findings-drawer-heading security-drawer-heading"
      eyebrow="Projects"
      title="Add project"
      description="Choose a source folder on this computer."
      descriptionClassName="muted"
      closeLabel="Close add project"
      closeDisabled={busy}
      returnFocus={returnFocus}
      footer={
        <div className="security-form-footer">
          <Button className="button button-secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="button button-primary"
            type="submit"
            form={`${id}-form`}
            disabled={busy || !api}
          >
            {busy ? "Adding project…" : "Add project"}
          </Button>
        </div>
      }
    >
      <form
        id={`${id}-form`}
        className="security-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="security-form-block">
          <label htmlFor={`${id}-path`}>Local folder</label>
          <div className="security-path-control">
            <Input
              ref={pathInput}
              id={`${id}-path`}
              value={path}
              onChange={(event) => setPath(event.target.value)}
              required
              maxLength={WORKSPACE_LIMITS.pathCharacters}
              autoComplete="off"
              disabled={busy}
            />
            <Button
              className="button button-secondary"
              disabled={busy}
              onClick={() => void browse()}
            >
              Browse…
            </Button>
          </div>
          <p className="muted">
            Choose a folder containing Python, JavaScript or TypeScript source files. Git is
            optional.
          </p>
        </div>
        <div className="security-form-block">
          <label htmlFor={`${id}-name`}>
            Project name <span className="muted">(optional)</span>
          </label>
          <Input
            id={`${id}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Folder name"
            maxLength={WORKSPACE_LIMITS.nameCharacters}
            disabled={busy}
          />
        </div>
        <div className="security-form-block">
          <label htmlFor={`${id}-notes`}>
            Review context <span className="muted">(optional)</span>
          </label>
          <TextArea
            id={`${id}-notes`}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={4}
            maxLength={WORKSPACE_LIMITS.contextCharacters}
            placeholder="Authentication, tenant boundaries, and assets to protect."
            disabled={busy}
          />
          <p className="muted">
            Saved for future scans. Adding a project does not call your provider.
          </p>
        </div>
        {error && (
          <p role="alert" className="error-message">
            {error}
          </p>
        )}
      </form>
    </DetailDrawer>
  );
}

export function NewScanForm({
  open,
  repositoryId,
  repositories,
  providers,
  onClose,
  onAddProject,
  onStarted,
  onChanged,
  returnFocus,
}: {
  open: boolean;
  repositoryId: string;
  repositories: LocalRepository[];
  providers: SavedProvider[];
  onClose: () => void;
  onAddProject: () => void;
  onStarted: (scan: SecurityScan) => void;
  onChanged: () => Promise<void>;
  returnFocus: () => HTMLElement | null;
}) {
  const api = useApi();
  const id = useId();
  const [selected, setSelected] = useState(repositoryId || repositories[0]?.id || "");
  const [providerId, setProviderId] = useState(
    (providers.find((item) => item.isDefault) ?? providers[0])?.id ?? "",
  );
  const [depth, setDepth] = useState<ScanDepth>("standard");
  const [validatorId, setValidatorId] = useState(SAME_VALIDATOR);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const project = repositories.find((item) => item.id === selected) ?? repositories[0];
  const provider = providers.find((item) => item.id === providerId) ?? providers[0];
  const validator = providers.find((item) => item.id === validatorId);
  const [model, setModel] = useState(provider?.model ?? "");
  const catalog = useProviderModels(api);
  const { clear: clearCatalog, restore: restoreCatalog } = catalog;
  const catalogProviderId = provider?.id;
  const catalogProvider = provider?.provider;
  useEffect(() => {
    clearCatalog();
    if (open && catalogProviderId && hasProviderModelCatalog(catalogProvider))
      void restoreCatalog(catalogProviderId);
    return clearCatalog;
  }, [open, catalogProviderId, catalogProvider, clearCatalog, restoreCatalog]);
  const modelItems = catalog.models.map((item) => ({
    value: item.id,
    label: item.name,
  }));
  if (provider?.model && !modelItems.some((item) => item.value === provider.model))
    modelItems.unshift({
      value: provider.model,
      label: `${provider.model} (default)`,
    });
  const selectedPricing = provider?.modelPricing?.find((item) => item.model === model);
  const contextWindow = catalog.models.find((item) => item.id === model)?.maxInputTokens;
  const budget = reviewBudget([contextWindow]);
  const [notes, setNotes] = useState(project?.environment.notes ?? "");
  async function submit() {
    if (!api || !project || !provider || !model.trim()) return;
    setBusy(true);
    setError("");
    try {
      if (notes !== project.environment.notes) {
        await api.updateRepository(project.id, { notes });
        await onChanged();
      }
      const scan = await api.startSecurityScan({
        repositoryId: project.id,
        providerId: provider.id,
        model: model.trim(),
        depth,
        ...(validator ? { validatorProviderId: validator.id } : {}),
      });
      onStarted(scan);
      onClose();
    } catch (failure) {
      setError(
        errorMessage(
          failure,
          "Unable to start scan. Check the local folder and provider settings.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <DetailDrawer
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      dismissible={!busy}
      className="inventory-detail-panel security-drawer security-scan-drawer"
      headingClassName="findings-drawer-heading security-drawer-heading"
      eyebrow="Security scan"
      title="New Scan"
      description="Review source code from a local folder."
      descriptionClassName="muted"
      closeLabel="Close new scan"
      closeDisabled={busy}
      returnFocus={returnFocus}
      footer={
        <div className="security-form-footer">
          <p className="security-form-consent">
            Selected source and review context are sent to {provider?.name ?? "your provider"}
            {validator && validator.id !== provider?.id ? ` and to ${validator.name}` : ""}. API
            usage may incur costs.
          </p>
          <Button className="button button-secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={`${id}-form`}
            className="button button-primary"
            disabled={busy || !api || !project || !provider || !model.trim() || catalog.loading}
          >
            {busy ? "Starting scan…" : "Start Scan"}
          </Button>
        </div>
      }
    >
      <form
        id={`${id}-form`}
        className="security-form security-scan-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="security-form-block">
          <div className="security-scan-field-heading">
            <label htmlFor={`${id}-project`}>Project</label>
            <Button className="button button-quiet" onClick={onAddProject} disabled={busy}>
              <Icon name="plus" /> Add project
            </Button>
          </div>
          <div className="security-project-control">
            {project ? (
              <Select
                label="Project"
                id={`${id}-project`}
                value={project.id}
                items={repositories.map((item) => ({
                  value: item.id,
                  label: item.name,
                }))}
                onValueChange={(value) => {
                  setSelected(value);
                  setNotes(repositories.find((item) => item.id === value)?.environment.notes ?? "");
                }}
                disabled={busy}
              />
            ) : (
              <p className="muted">Add a local project to start a scan.</p>
            )}
          </div>
          {project && (
            <div className="security-scan-source">
              <Icon name="folder" />
              <code className="security-project-path muted">{project.path}</code>
            </div>
          )}
        </div>
        <fieldset className="security-scan-settings" aria-label="AI review">
          <div className="security-form-block">
            <label htmlFor={`${id}-provider`}>Provider</label>
            {provider ? (
              <Select
                label="Provider"
                id={`${id}-provider`}
                value={provider.id}
                items={providers.map((item) => ({
                  value: item.id,
                  label: item.name,
                }))}
                onValueChange={(value) => {
                  setProviderId(value);
                  setModel(providers.find((item) => item.id === value)?.model ?? "");
                }}
                disabled={busy}
              />
            ) : (
              <Link className="security-row-link" to="/settings/providers" onClick={onClose}>
                Configure a provider
              </Link>
            )}
          </div>
          {provider && (
            <div className="security-form-block">
              <div className="security-scan-field-heading">
                <label htmlFor={`${id}-model`}>Model</label>
                {hasProviderModelCatalog(provider.provider) && (
                  <Button
                    className="button button-quiet"
                    disabled={busy || catalog.loading}
                    onClick={() =>
                      void catalog.load({
                        id: provider.id,
                        provider: provider.provider as "anthropic" | "openai",
                        baseUrl: provider.baseUrl,
                        refresh: true,
                      })
                    }
                  >
                    {catalog.loading
                      ? "Loading models…"
                      : catalog.loaded
                        ? "Reload models"
                        : "Load models"}
                  </Button>
                )}
              </div>
              {hasProviderModelCatalog(provider.provider) ? (
                <Select
                  label="Model"
                  id={`${id}-model`}
                  value={model}
                  items={modelItems}
                  onValueChange={setModel}
                  disabled={busy || catalog.loading}
                />
              ) : (
                <Input
                  id={`${id}-model`}
                  value={model}
                  maxLength={128}
                  required
                  onChange={(event) => setModel(event.target.value)}
                  disabled={busy}
                />
              )}
              <p className="muted">
                Used for this scan only. Your provider's default stays the same.
              </p>
              <p className="muted">
                {budget.inputTokens === null
                  ? `Up to ${Math.round(budget.contextBytes / 1024)} KiB of source per batch. Load models to size it to this model's context window.`
                  : `Up to ${Math.round(budget.contextBytes / 1024)} KiB of source per batch for this model's ${budget.inputTokens.toLocaleString()}-token window.`}
                {validator
                  ? " A second-review model with a smaller or unknown window lowers it."
                  : ""}
              </p>
              {provider.provider === "anthropic" && (
                <p className="muted security-scan-pricing">
                  <Icon name="info" />
                  <span>
                    {selectedPricing
                      ? "Cost estimates use saved USD prices and reported token usage."
                      : "No saved prices for this model. Token usage is tracked; cost estimates are unavailable."}
                  </span>
                </p>
              )}
              {catalog.error && (
                <p className="error-message" role="alert">
                  {catalog.error}
                </p>
              )}
            </div>
          )}
          {provider && (
            <div className="security-form-block">
              <label htmlFor={`${id}-validator`}>Second review</label>
              <Select
                label="Second review"
                id={`${id}-validator`}
                value={validator ? validator.id : SAME_VALIDATOR}
                items={[
                  { value: SAME_VALIDATOR, label: "Same provider and model" },
                  ...providers.map((item) => ({
                    value: item.id,
                    label: `${item.name} · ${item.model}`,
                  })),
                ]}
                onValueChange={setValidatorId}
                disabled={busy}
              />
              <p className="muted">
                Checks each candidate for counterevidence with the provider's saved model. A
                different model is less likely to repeat the first model's mistakes.
              </p>
            </div>
          )}
        </fieldset>
        <RadioGroup
          className="security-scan-depth"
          name="depth"
          value={depth}
          onChange={(value) => setDepth(value as ScanDepth)}
          isDisabled={busy}
        >
          <Label>Scan depth</Label>
          <div className="security-scan-depth-options">
            {Object.entries(SCAN_DEPTHS).map(([value, item]) => (
              <Radio
                key={value}
                value={value}
                className="security-scan-depth-option"
                aria-labelledby={`${id}-${value}-label`}
                aria-describedby={`${id}-${value}-description ${id}-${value}-calls`}
              >
                <span className="security-scan-depth-indicator" aria-hidden="true" />
                <span className="security-scan-depth-copy">
                  <span id={`${id}-${value}-label`} className="security-scan-depth-name">
                    {item.label}
                  </span>
                  <span id={`${id}-${value}-description`} className="muted">
                    {value === "standard"
                      ? "Reviews one source batch."
                      : `Reviews up to ${item.batches} independent source batches.`}
                  </span>
                  <span id={`${id}-${value}-calls`} className="security-scan-depth-calls">
                    Up to {SECURITY_REVIEW_LIMITS.calls * item.batches} model calls
                  </span>
                </span>
              </Radio>
            ))}
          </div>
        </RadioGroup>
        <details className="security-review-context security-scan-context">
          <summary>
            <Icon name="chevron" />
            <span>Review context</span>
            <span className="muted security-scan-context-status">
              {notes.trim() ? "Included" : "Optional"}
            </span>
          </summary>
          <div className="security-scan-context-body">
            <label htmlFor={`${id}-notes`} className="sr-only">
              Review context
            </label>
            <TextArea
              id={`${id}-notes`}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              maxLength={WORKSPACE_LIMITS.contextCharacters}
              rows={4}
              placeholder="Authentication, tenant boundaries, and assets to protect."
              disabled={busy}
            />
            <p className="muted">Saved with this project and included in its source review.</p>
          </div>
        </details>
        <div className="security-scan-includes">
          <Icon name="checklist" />
          <div>
            <p>Static checks, AI code review and STRIDE threat modeling</p>
            <p className="muted">Source files are read without running the project.</p>
          </div>
        </div>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
      </form>
    </DetailDrawer>
  );
}

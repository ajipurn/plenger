import { useEffect, useId, useRef, useState } from "react";
import { Label, Radio, RadioGroup, Text } from "react-aria-components";
import { Link } from "react-router";
import {
  batchCostBound,
  batchTokenBound,
  EXPLORE_LIMITS,
  exploreCostBound,
  exploreTokenBound,
  type LocalRepository,
  type RepositorySource,
  type ReviewMode,
  reviewBudget,
  SCAN_BUDGET_LIMITS,
  SCAN_DEPTHS,
  type ScanBudget,
  SECURITY_REVIEW_LIMITS,
  type SecurityScan,
  type SelectableScanDepth,
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
import { Button, Checkbox, Input, Select, TextArea } from "../shared/ui.tsx";

/** The second review uses the discovery provider and model. */
const SAME_VALIDATOR = "same";
const EXPLORE_CALLS = EXPLORE_LIMITS.discovery.modelCalls + EXPLORE_LIMITS.validation.modelCalls;
const DEPTH_COPY: Record<SelectableScanDepth, Record<ReviewMode, string>> = {
  quick: {
    batch: "Reviews the most important files in one batch.",
    explore: "Explores once, starting from the most important files.",
  },
  full: {
    batch: "Reviews batch after batch until every file is covered or your limit is reached.",
    explore: "Explores again until a review reads nothing new or your limit is reached.",
  },
};
/** Full coverage without a spending limit; the batch cap still applies. */
const UNLIMITED_COPY: Record<ReviewMode, string> = {
  batch: "Reviews batch after batch until every file is covered.",
  explore: "Explores again until a review reads nothing new.",
};
const MODE_COPY: Record<ReviewMode, { label: string; description: string; calls: string }> = {
  batch: {
    label: "Batch",
    description: "Sends the most relevant files in batches the scan packs.",
    calls: `${SECURITY_REVIEW_LIMITS.calls} model calls per batch`,
  },
  explore: {
    label: "Explore",
    description: "Reads the project through read-only tools and follows paths across files.",
    calls: `Up to ${EXPLORE_CALLS} model calls per review`,
  },
};
/** Rendered source is larger than file bytes: line numbers and JSON escaping. */
const RENDER_OVERHEAD = 1.2;

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MiB`
    : `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}
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
            Choose a folder containing Python, JavaScript, TypeScript or PHP source files. Git is
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
  // Explore is measured on Claude; other connections start in Batch and can choose Explore.
  const defaultMode = (provider?: SavedProvider): ReviewMode =>
    provider?.provider === "anthropic" ? "explore" : "batch";
  const [mode, setMode] = useState<ReviewMode>(() =>
    defaultMode(providers.find((item) => item.isDefault) ?? providers[0]),
  );
  const [depth, setDepth] = useState<SelectableScanDepth>("quick");
  // Full coverage without a limit runs until it covers the project or reaches the batch cap.
  const [limited, setLimited] = useState(true);
  const [limitKind, setLimitKind] = useState<ScanBudget["kind"]>("tokens");
  const [tokenLimit, setTokenLimit] = useState(String(SCAN_BUDGET_LIMITS.defaultTokens));
  const [usdLimit, setUsdLimit] = useState(SCAN_BUDGET_LIMITS.defaultUsd.toFixed(2));
  const [source, setSource] = useState<RepositorySource | null>(null);
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
  // ChatGPT offers the models its last sign-in listed; without them the model is typed.
  const listedModels: { id: string; name: string }[] =
    provider?.provider === "chatgpt" ? (provider.chatgptModels ?? []) : catalog.models;
  const choosesModel = hasProviderModelCatalog(provider?.provider) || listedModels.length > 0;
  const modelItems = listedModels.map((item) => ({
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
  const projectId = project?.id;
  useEffect(() => {
    setSource(null);
    if (!open || !api || !projectId) return;
    const controller = new AbortController();
    api
      .repositorySource(projectId, controller.signal)
      .then(setSource)
      .catch(() => {
        /* The estimate is optional; the scan reports what it covered. */
      });
    return () => controller.abort();
  }, [open, api, projectId]);
  // A USD limit needs saved Claude prices for every model the scan uses.
  const validatorPricing = validator?.modelPricing?.find((item) => item.model === validator.model);
  const usdPricing =
    provider?.provider === "anthropic" &&
    selectedPricing &&
    (!validator || (validator.provider === "anthropic" && validatorPricing))
      ? { discovery: selectedPricing, validation: validatorPricing ?? selectedPricing }
      : undefined;
  const kind = usdPricing ? limitKind : "tokens";
  const mostTokens = mode === "explore" ? exploreTokenBound().total : batchTokenBound(budget).total;
  const mostUsd = usdPricing
    ? mode === "explore"
      ? exploreCostBound(usdPricing.discovery, usdPricing.validation)
      : batchCostBound(budget, usdPricing.discovery, usdPricing.validation)
    : null;
  const limitValue = Number(kind === "tokens" ? tokenLimit : usdLimit);
  // Full coverage repeats batches, or exploring reviews; the limit counts either.
  const [unit, units] = mode === "explore" ? ["review", "reviews"] : ["batch", "batches"];
  const limitError = (() => {
    if (depth !== "full" || !limited) return "";
    const L = SCAN_BUDGET_LIMITS;
    if (kind === "tokens") {
      if (!Number.isSafeInteger(limitValue) || limitValue < L.minTokens || limitValue > L.maxTokens)
        return `Enter whole tokens from ${L.minTokens.toLocaleString()} to ${L.maxTokens.toLocaleString()}.`;
      if (limitValue < mostTokens)
        return `One ${unit} can charge up to ${mostTokens.toLocaleString()} tokens. Raise the limit.`;
      return "";
    }
    if (!Number.isFinite(limitValue) || limitValue < L.minUsd || limitValue > L.maxUsd)
      return `Enter USD from ${L.minUsd} to ${L.maxUsd.toLocaleString()}.`;
    if (mostUsd !== null && limitValue < mostUsd)
      return `One ${unit} can cost up to USD ${mostUsd.toFixed(2)}. Raise the limit.`;
    return "";
  })();
  const guaranteed =
    kind === "tokens"
      ? Math.floor(limitValue / mostTokens)
      : mostUsd
        ? Math.floor(limitValue / mostUsd)
        : 0;
  const needed = source
    ? Math.max(
        1,
        Math.ceil((source.bytes * RENDER_OVERHEAD) / budget.contextBytes),
        Math.ceil(source.files / budget.files),
      )
    : null;
  const depthCalls: Record<SelectableScanDepth, string> = {
    quick: `Up to ${mode === "explore" ? EXPLORE_CALLS : SECURITY_REVIEW_LIMITS.calls} model calls`,
    full:
      mode === "batch" && needed !== null
        ? needed === 1
          ? "One batch covers this project"
          : `About ${needed.toLocaleString()} batches for this project`
        : limited
          ? "Stops at your limit"
          : `Up to ${SCAN_BUDGET_LIMITS.fullBatches} ${units}`,
  };
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
        mode,
        ...(depth === "full" && limited
          ? {
              budget:
                kind === "tokens"
                  ? { kind: "tokens", tokens: limitValue }
                  : { kind: "usd", usd: Math.round(limitValue * 100) / 100 },
            }
          : {}),
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
            disabled={
              busy ||
              !api ||
              !project ||
              !provider ||
              !model.trim() ||
              catalog.loading ||
              Boolean(limitError)
            }
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
        <section className="security-scan-section" aria-labelledby={`${id}-project-heading`}>
          <div className="security-scan-section-heading">
            <h3 id={`${id}-project-heading`}>Project</h3>
            <Button className="button button-quiet" onClick={onAddProject} disabled={busy}>
              <Icon name="plus" /> Add project
            </Button>
          </div>
          {project ? (
            <>
              <div className="security-scan-field">
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
                    setNotes(
                      repositories.find((item) => item.id === value)?.environment.notes ?? "",
                    );
                  }}
                  disabled={busy}
                />
                <div className="security-scan-source">
                  <span className="security-scan-source-path">
                    <Icon name="folder" />
                    <code>{project.path}</code>
                  </span>
                  {source && (
                    <span className="security-scan-source-size">
                      {source.files.toLocaleString()}
                      {source.truncated ? "+" : ""} reviewable{" "}
                      {source.files === 1 ? "file" : "files"} · {sizeText(source.bytes)}
                    </span>
                  )}
                </div>
              </div>
              <details className="security-scan-notes">
                <summary>
                  <Icon name="chevron" />
                  <span>Review context</span>
                  <span className="security-scan-notes-status">
                    {notes.trim() ? (
                      <>
                        <Icon name="check" /> Included
                      </>
                    ) : (
                      "Optional"
                    )}
                  </span>
                </summary>
                <div className="security-scan-notes-body">
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
                  <p className="muted">
                    Saved with this project and included in its source review.
                  </p>
                </div>
              </details>
            </>
          ) : (
            <p className="muted">Add a local project to start a scan.</p>
          )}
        </section>
        <section className="security-scan-section" aria-labelledby={`${id}-model-heading`}>
          <div className="security-scan-section-heading">
            <h3 id={`${id}-model-heading`}>Model</h3>
          </div>
          {provider ? (
            <>
              <div className="security-scan-fields">
                <div className="security-scan-field">
                  <div className="security-scan-field-label">
                    <label htmlFor={`${id}-provider`}>Provider</label>
                  </div>
                  <Select
                    label="Provider"
                    id={`${id}-provider`}
                    value={provider.id}
                    items={providers.map((item) => ({
                      value: item.id,
                      label: item.name,
                    }))}
                    onValueChange={(value) => {
                      const next = providers.find((item) => item.id === value);
                      setProviderId(value);
                      setModel(next?.model ?? "");
                      setMode(defaultMode(next));
                    }}
                    disabled={busy}
                  />
                </div>
                <div className="security-scan-field">
                  <div className="security-scan-field-label">
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
                  {choosesModel ? (
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
                </div>
              </div>
              <div className="security-scan-hints">
                <p className="muted">
                  Used for this scan only. Your provider's default stays the same.
                </p>
                {provider.provider === "anthropic" && (
                  <p className="muted security-scan-note">
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
              <div className="security-scan-field">
                <div className="security-scan-field-label">
                  <label htmlFor={`${id}-validator`}>Second review</label>
                </div>
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
                  Checks each candidate for counterevidence. A different model is less likely to
                  repeat the first model's mistakes.
                </p>
              </div>
            </>
          ) : (
            <p className="muted">
              Save a model connection to review source.{" "}
              <Link className="security-row-link" to="/settings/providers" onClick={onClose}>
                Configure a provider
              </Link>
            </p>
          )}
        </section>
        <section className="security-scan-section" aria-labelledby={`${id}-review-heading`}>
          <div className="security-scan-section-heading">
            <h3 id={`${id}-review-heading`}>Review</h3>
          </div>
          <RadioGroup
            className="security-scan-field"
            name="mode"
            value={mode}
            onChange={(value) => setMode(value as ReviewMode)}
            isDisabled={busy}
          >
            <div className="security-scan-field-label">
              <Label>Mode</Label>
            </div>
            <div className="security-scan-choices">
              {(["batch", "explore"] as const).map((value) => (
                <Radio
                  key={value}
                  value={value}
                  className="security-scan-choice"
                  aria-labelledby={`${id}-mode-${value}-label`}
                  aria-describedby={`${id}-mode-${value}-description ${id}-mode-${value}-calls`}
                >
                  <span className="security-scan-choice-head">
                    <span id={`${id}-mode-${value}-label`} className="security-scan-choice-name">
                      {MODE_COPY[value].label}
                    </span>
                    <span className="security-scan-choice-indicator" aria-hidden="true" />
                  </span>
                  <span id={`${id}-mode-${value}-description`}>{MODE_COPY[value].description}</span>
                  <span id={`${id}-mode-${value}-calls`} className="security-scan-choice-meta">
                    {MODE_COPY[value].calls}
                  </span>
                </Radio>
              ))}
            </div>
            {provider && (
              <Text slot="description" elementType="p" className="muted">
                {mode === "explore"
                  ? `Explore starts from up to ${Math.round(Math.min(budget.contextBytes, EXPLORE_LIMITS.firstBytes) / 1024)} KiB of source and reads the rest through tools.`
                  : budget.inputTokens === null
                    ? `Up to ${Math.round(budget.contextBytes / 1024)} KiB of source per batch.${hasProviderModelCatalog(provider.provider) ? " Load models to size it to this model's context window." : ""}`
                    : `Up to ${Math.round(budget.contextBytes / 1024)} KiB of source per batch for this model's ${budget.inputTokens.toLocaleString()}-token window.`}
                {validator && mode === "batch"
                  ? " A second-review model with a smaller or unknown window lowers it."
                  : ""}
              </Text>
            )}
          </RadioGroup>
          <RadioGroup
            className="security-scan-field"
            name="depth"
            value={depth}
            onChange={(value) => setDepth(value as SelectableScanDepth)}
            isDisabled={busy}
          >
            <div className="security-scan-field-label">
              <Label>Depth</Label>
            </div>
            <div className="security-scan-choices">
              {(["quick", "full"] as const).map((value) => (
                <Radio
                  key={value}
                  value={value}
                  className="security-scan-choice"
                  aria-labelledby={`${id}-${value}-label`}
                  aria-describedby={`${id}-${value}-description ${id}-${value}-calls`}
                >
                  <span className="security-scan-choice-head">
                    <span id={`${id}-${value}-label`} className="security-scan-choice-name">
                      {SCAN_DEPTHS[value].label}
                    </span>
                    <span className="security-scan-choice-indicator" aria-hidden="true" />
                  </span>
                  <span id={`${id}-${value}-description`}>
                    {value === "full" && !limited ? UNLIMITED_COPY[mode] : DEPTH_COPY[value][mode]}
                  </span>
                  <span id={`${id}-${value}-calls`} className="security-scan-choice-meta">
                    {depthCalls[value]}
                  </span>
                </Radio>
              ))}
            </div>
          </RadioGroup>
          {depth === "full" && (
            <div className="security-scan-limit">
              <div className="security-scan-limit-heading">
                <Checkbox isSelected={limited} onChange={setLimited} isDisabled={busy}>
                  Set a spending limit
                </Checkbox>
                {limited && (
                  <RadioGroup
                    className="security-scan-segmented"
                    aria-label="Limit unit"
                    orientation="horizontal"
                    value={kind}
                    onChange={(value) => setLimitKind(value as ScanBudget["kind"])}
                    isDisabled={busy}
                  >
                    <Radio value="tokens" className="security-scan-segment">
                      Tokens
                    </Radio>
                    <Radio value="usd" className="security-scan-segment" isDisabled={!usdPricing}>
                      USD
                    </Radio>
                  </RadioGroup>
                )}
              </div>
              {limited ? (
                <>
                  <label htmlFor={`${id}-limit`} className="sr-only">
                    {kind === "tokens" ? "Token limit" : "USD limit"}
                  </label>
                  <div className="security-scan-limit-input">
                    <Input
                      id={`${id}-limit`}
                      type="number"
                      inputMode={kind === "tokens" ? "numeric" : "decimal"}
                      min={
                        kind === "tokens" ? SCAN_BUDGET_LIMITS.minTokens : SCAN_BUDGET_LIMITS.minUsd
                      }
                      max={
                        kind === "tokens" ? SCAN_BUDGET_LIMITS.maxTokens : SCAN_BUDGET_LIMITS.maxUsd
                      }
                      step={kind === "tokens" ? 1000 : 0.01}
                      value={kind === "tokens" ? tokenLimit : usdLimit}
                      onChange={(event) =>
                        kind === "tokens"
                          ? setTokenLimit(event.target.value)
                          : setUsdLimit(event.target.value)
                      }
                      aria-invalid={Boolean(limitError)}
                      aria-describedby={`${id}-limit-help`}
                      disabled={busy}
                    />
                    <span className="security-scan-limit-unit" aria-hidden="true">
                      {kind === "tokens" ? "tokens" : "USD"}
                    </span>
                  </div>
                  <p id={`${id}-limit-help`} className={limitError ? "error-message" : "muted"}>
                    {limitError ||
                      `Each ${unit} charges at most ${
                        kind === "tokens"
                          ? `${mostTokens.toLocaleString()} tokens`
                          : `USD ${mostUsd?.toFixed(2)} at saved prices`
                      }, so this limit covers at least ${guaranteed.toLocaleString()} ${guaranteed === 1 ? unit : units}. Most ${units} charge less. A ${unit} starts only when its maximum fits what remains.`}
                  </p>
                  {!usdPricing && (
                    <p className="muted">
                      USD limits need saved Claude prices for every model in this scan.
                    </p>
                  )}
                </>
              ) : (
                <p className="muted">
                  {`No limit: the scan stops after ${SCAN_BUDGET_LIMITS.fullBatches} ${units} at most. Each ${unit} charges up to ${mostTokens.toLocaleString()} tokens.`}
                </p>
              )}
            </div>
          )}
        </section>
        <div className="security-scan-includes">
          <Icon name="checklist" />
          <div>
            <p>Static checks, AI code review and STRIDE threat modeling</p>
            <p className="muted">Source files are read without running the project.</p>
          </div>
        </div>
        {error && (
          <p className="error-message security-scan-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </DetailDrawer>
  );
}

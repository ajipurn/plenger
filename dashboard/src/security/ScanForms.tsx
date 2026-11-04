import { useEffect, useId, useRef, useState } from "react";
import { Label, Radio, RadioGroup } from "react-aria-components";
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
  type ScanAiOptions,
  type ScanBudget,
  SECURITY_REVIEW_LIMITS,
  type SecurityScan,
  type SelectableScanDepth,
  WORKSPACE_LIMITS,
} from "../../../src/dashboard/contract.ts";
import {
  hasProviderModelCatalog,
  modelPricingProvider,
  type SavedProvider,
} from "../../../src/redteam/provider-config.ts";
import { useApi } from "../app/DashboardContext.tsx";
import { useProviderModels } from "../providers/useProviderModels.ts";
import { errorMessage } from "../shared/async.ts";
import { DetailDrawer } from "../shared/DetailDrawer.tsx";
import { Icon } from "../shared/icons.tsx";
import { MorphNumber, NumericText } from "../shared/MorphNumber.tsx";
import { Button, Input, Select, TextArea } from "../shared/ui.tsx";
import { useScanModelPricing } from "./useScanModelPricing.ts";
import { useScanModelWindow } from "./useScanModelWindow.ts";

const EXPLORE_CALLS = EXPLORE_LIMITS.discovery.modelCalls + EXPLORE_LIMITS.validation.modelCalls;
/** Each choice card says what the option does in one line, then what it costs. */
const MODE_COPY: Record<ReviewMode, { label: string; description: string; calls: string }> = {
  batch: {
    label: "Batch",
    description: "Sends the most relevant files, picked by the scan.",
    calls: `${SECURITY_REVIEW_LIMITS.calls} model calls per round`,
  },
  explore: {
    label: "Explore",
    description: "Reads the project through read-only tools and follows paths across files.",
    calls: `Up to ${EXPLORE_CALLS} model calls per round`,
  },
};
const DEPTH_COPY: Record<SelectableScanDepth, Record<ReviewMode, string>> = {
  quick: {
    batch: "One round on the most important files.",
    explore: "One round, starting from the most important files.",
  },
  full: {
    batch: "Rounds until every file is covered or the limit is reached.",
    explore: "Rounds until a round reads nothing new or the limit is reached.",
  },
};
/** Full coverage without a spending limit; the round cap still applies. */
const UNLIMITED_COPY: Record<ReviewMode, string> = {
  batch: "Rounds until every file is covered.",
  explore: "Rounds until a round reads nothing new.",
};
/** Limit shortcuts. Only those that fit one round's maximum are offered. */
const TOKEN_PRESETS = [1_000_000, 2_000_000, 5_000_000, 10_000_000];
const USD_PRESETS = [1, 5, 10, 25];
const NO_LIMIT = "none";
/** The Validate with choice that keeps the discovery model. */
const SAME_VALIDATOR = "same";
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
            Choose a project folder in any language. Python, JavaScript, TypeScript and PHP also get
            static analysis. Git is optional.
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
            <NumericText>{error}</NumericText>
          </p>
        )}
      </form>
    </DetailDrawer>
  );
}

/** A model picker with its catalog action; the caller labels it. */
function ScanModelField({
  id,
  label,
  provider,
  model,
  onChange,
  catalog,
  busy,
}: {
  id: string;
  label: string;
  provider: SavedProvider;
  model: string;
  onChange: (model: string) => void;
  catalog: ReturnType<typeof useProviderModels>;
  busy: boolean;
}) {
  // ChatGPT offers the models its last sign-in listed; without them the model is typed.
  const listedModels =
    provider.provider === "chatgpt" ? (provider.chatgptModels ?? []) : catalog.models;
  const choosesModel = hasProviderModelCatalog(provider.provider) || listedModels.length > 0;
  const items = listedModels.map((item) => ({
    value: item.id,
    label: item.name,
  }));
  if (!items.some((item) => item.value === provider.model))
    items.unshift({
      value: provider.model,
      label: `${provider.model} (default)`,
    });
  return (
    <div className="security-scan-inline">
      {choosesModel ? (
        <Select
          label={label}
          id={id}
          value={model}
          items={items}
          onValueChange={onChange}
          disabled={busy || catalog.loading}
        />
      ) : (
        <Input
          id={id}
          value={model}
          maxLength={128}
          required
          onChange={(event) => onChange(event.target.value)}
          disabled={busy}
        />
      )}
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
          {catalog.loading ? "Loading models…" : catalog.loaded ? "Reload models" : "Load models"}
        </Button>
      )}
    </div>
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
  // Full coverage without a limit runs until it covers the project or reaches the round cap.
  const [limited, setLimited] = useState(true);
  const [limitKind, setLimitKind] = useState<ScanBudget["kind"]>("tokens");
  const [tokenLimit, setTokenLimit] = useState(String(SCAN_BUDGET_LIMITS.defaultTokens));
  const [usdLimit, setUsdLimit] = useState(SCAN_BUDGET_LIMITS.defaultUsd.toFixed(2));
  const [source, setSource] = useState<RepositorySource | null>(null);
  const [differentValidator, setDifferentValidator] = useState(false);
  const [validatorId, setValidatorId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Tokens show thousands separators except while they are being edited.
  const [editingLimit, setEditingLimit] = useState(false);
  const project = repositories.find((item) => item.id === selected) ?? repositories[0];
  const provider = providers.find((item) => item.id === providerId) ?? providers[0];
  const validator = differentValidator
    ? (providers.find((item) => item.id === validatorId) ?? provider)
    : undefined;
  const [model, setModel] = useState(provider?.model ?? "");
  const [validatorModel, setValidatorModel] = useState("");
  const catalog = useProviderModels(api);
  const validatorCatalog = useProviderModels(api);
  const { clear: clearCatalog, restore: restoreCatalog } = catalog;
  const catalogProviderId = provider?.id;
  const catalogProvider = provider?.provider;
  useEffect(() => {
    clearCatalog();
    if (open && catalogProviderId && hasProviderModelCatalog(catalogProvider))
      void restoreCatalog(catalogProviderId);
    return clearCatalog;
  }, [open, catalogProviderId, catalogProvider, clearCatalog, restoreCatalog]);
  const { clear: clearValidatorCatalog, restore: restoreValidatorCatalog } = validatorCatalog;
  const validatorProviderId = validator?.id;
  const validatorProvider = validator?.provider;
  useEffect(() => {
    clearValidatorCatalog();
    if (open && validatorProviderId && hasProviderModelCatalog(validatorProvider))
      void restoreValidatorCatalog(validatorProviderId);
    return clearValidatorCatalog;
  }, [
    open,
    validatorProviderId,
    validatorProvider,
    clearValidatorCatalog,
    restoreValidatorCatalog,
  ]);
  // Prices give every plan a cost, not only a USD limit.
  const pricingActive = open;
  const discoveryPrices = useScanModelPricing(api, provider, model, pricingActive);
  const validationPrices = useScanModelPricing(api, validator, validatorModel, pricingActive);
  const selectedPricing = discoveryPrices.pricing;
  // A loaded catalog answers at once; the host also knows Models.dev windows.
  const discoveryWindow = useScanModelWindow(api, provider, model, open);
  const validationWindow = useScanModelWindow(api, validator, validatorModel, open);
  const contextWindow =
    catalog.models.find((item) => item.id === model)?.maxInputTokens ?? discoveryWindow;
  const validatorContextWindow =
    validatorCatalog.models.find((item) => item.id === validatorModel)?.maxInputTokens ??
    validationWindow;
  const budget = reviewBudget([contextWindow, ...(validator ? [validatorContextWindow] : [])]);
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
  // A USD limit needs prices for every model the scan uses.
  const validatorPricing = validationPrices.pricing;
  const pricingLoading = discoveryPrices.loading || validationPrices.loading;
  const subscription = provider?.provider === "chatgpt" || validator?.provider === "chatgpt";
  const usdPricing =
    provider &&
    modelPricingProvider(provider.provider) &&
    !pricingLoading &&
    selectedPricing &&
    (!validator || (modelPricingProvider(validator.provider) && validatorPricing))
      ? {
          discovery: selectedPricing,
          validation: validatorPricing ?? selectedPricing,
        }
      : undefined;
  const kind = limitKind;
  const mostTokens = mode === "explore" ? exploreTokenBound().total : batchTokenBound(budget).total;
  const mostUsd = usdPricing
    ? mode === "explore"
      ? exploreCostBound(usdPricing.discovery, usdPricing.validation)
      : batchCostBound(budget, usdPricing.discovery, usdPricing.validation)
    : null;
  const limitValue = Number(kind === "tokens" ? tokenLimit : usdLimit);
  const limitError = (() => {
    if (depth !== "full" || !limited) return "";
    if (kind === "usd" && !usdPricing)
      return pricingLoading
        ? "Loading prices for the selected models…"
        : "USD limits need prices for each selected model. Choose a priced model or refresh its prices in Settings > Providers.";
    const L = SCAN_BUDGET_LIMITS;
    if (kind === "tokens") {
      if (!Number.isSafeInteger(limitValue) || limitValue < L.minTokens || limitValue > L.maxTokens)
        return `Enter whole tokens from ${L.minTokens.toLocaleString()} to ${L.maxTokens.toLocaleString()}.`;
      if (limitValue < mostTokens)
        return `One round can charge up to ${mostTokens.toLocaleString()} tokens. Raise the limit.`;
      return "";
    }
    if (!Number.isFinite(limitValue) || limitValue < L.minUsd || limitValue > L.maxUsd)
      return `Enter USD from ${L.minUsd} to ${L.maxUsd.toLocaleString()}.`;
    if (mostUsd !== null && limitValue < mostUsd)
      return `One round can cost up to USD ${mostUsd.toFixed(2)}. Raise the limit.`;
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
  const depthMeta: Record<SelectableScanDepth, string> = {
    quick: "1 round",
    full:
      mode === "batch" && needed !== null
        ? needed === 1
          ? "1 round covers this project"
          : `About ${needed.toLocaleString()} rounds for this project`
        : limited
          ? "Until your limit"
          : `Up to ${SCAN_BUDGET_LIMITS.fullBatches} rounds`,
  };
  const presets =
    kind === "tokens"
      ? TOKEN_PRESETS.filter((tokens) => tokens >= mostTokens)
      : USD_PRESETS.filter((usd) => mostUsd === null || usd >= mostUsd);
  const preset = !limited ? NO_LIMIT : presets.includes(limitValue) ? String(limitValue) : null;
  const limitText =
    kind === "tokens"
      ? editingLimit || !/^\d+$/.test(tokenLimit)
        ? tokenLimit
        : Number(tokenLimit).toLocaleString()
      : usdLimit;
  // What the choices add up to, shown above Start Scan instead of under each control.
  const planTitle = [
    MODE_COPY[mode].label,
    SCAN_DEPTHS[depth].label,
    depth === "quick"
      ? "one round"
      : !limited
        ? `up to ${SCAN_BUDGET_LIMITS.fullBatches} rounds`
        : limitError
          ? ""
          : kind === "tokens"
            ? `stops at ${limitValue.toLocaleString()} tokens`
            : `stops at USD ${limitValue.toFixed(2)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const sourceKiB = Math.round(
    (mode === "explore"
      ? Math.min(budget.contextBytes, EXPLORE_LIMITS.firstBytes)
      : budget.contextBytes) / 1024,
  );
  // The same maximum in USD when the models are priced. A subscription is not billed at
  // API rates, so its figure is named as an API-rate equivalent.
  const roundCost =
    mostUsd === null
      ? ""
      : subscription
        ? ` (USD ${mostUsd.toFixed(2)} at standard API rates)`
        : ` (USD ${mostUsd.toFixed(2)} at current prices)`;
  const planDetail = [
    !provider
      ? ""
      : mode === "explore"
        ? `Starts from up to ${sourceKiB} KiB of source and reads the rest through tools.`
        : budget.inputTokens === null
          ? `Up to ${sourceKiB} KiB of source per round.${hasProviderModelCatalog(provider.provider) ? " Load models to size it to this model's context window." : ""}`
          : `Up to ${sourceKiB} KiB of source per round for this model's ${budget.inputTokens.toLocaleString()}-token window.`,
    validator && mode === "batch"
      ? "A validation model with a smaller or unknown window lowers it."
      : "",
    limitError
      ? ""
      : depth === "quick"
        ? `The scan charges at most ${mostTokens.toLocaleString()} tokens${roundCost}. Most scans charge less.`
        : !limited
          ? `Each round charges up to ${mostTokens.toLocaleString()} tokens${roundCost}.`
          : kind === "usd" && subscription
            ? `Each round reserves up to USD ${mostUsd?.toFixed(2)} at standard API rates. Subscription usage is checked after each response.`
            : `Each round charges at most ${
                kind === "tokens"
                  ? `${mostTokens.toLocaleString()} tokens`
                  : `USD ${mostUsd?.toFixed(2)} at current prices`
              }, so at least ${guaranteed.toLocaleString()} ${guaranteed === 1 ? "round fits" : "rounds fit"}. Most rounds charge less.`,
  ]
    .filter(Boolean)
    .join(" ");
  async function submit() {
    if (!api || !project) return;
    if (!provider || !model.trim() || limitError || (validator && !validatorModel.trim())) return;
    setBusy(true);
    setError("");
    try {
      if (notes !== project.environment.notes) {
        await api.updateRepository(project.id, { notes });
        await onChanged();
      }
      const options: ScanAiOptions | null = provider
        ? {
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
            ...(validator
              ? {
                  validatorProviderId: validator.id,
                  validatorModel: validatorModel.trim(),
                }
              : {}),
          }
        : null;
      const scan = options
        ? await api.startSecurityScan({ ...options, repositoryId: project.id })
        : null;
      if (!scan) return;
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
          {provider && project && (
            <div className="security-scan-plan">
              <Icon name="checklist" />
              <div>
                <p className="security-scan-plan-title">
                  <NumericText>{planTitle}</NumericText>
                </p>
                {planDetail && (
                  <p className="security-scan-plan-detail">
                    <NumericText>{planDetail}</NumericText>
                  </p>
                )}
              </div>
            </div>
          )}
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
              (validator && (!validatorModel.trim() || validatorCatalog.loading)) ||
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
        <div className="security-scan-group">
          <p className="security-scan-group-title">Source</p>
          <div className="security-scan-row">
            {project ? (
              <label htmlFor={`${id}-project`} className="security-scan-row-label">
                Project
              </label>
            ) : (
              <span className="security-scan-row-label">Project</span>
            )}
            <div className="security-scan-row-control">
              {project ? (
                <>
                  <div className="security-scan-inline">
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
                    <Button
                      className="button button-secondary"
                      onClick={onAddProject}
                      disabled={busy}
                    >
                      <Icon name="plus" /> Add project
                    </Button>
                  </div>
                  <div className="security-scan-source">
                    {/* Long paths lose their start, so the project folder stays readable. */}
                    <span className="security-scan-source-path" title={project.path}>
                      <Icon name="folder" />
                      <code>
                        <bdi>{project.path}</bdi>
                      </code>
                    </span>
                    {source && (
                      <span className="security-scan-source-size">
                        <MorphNumber value={source.files} />
                        {source.truncated ? "+" : ""} {source.files === 1 ? "file" : "files"} ·{" "}
                        <MorphNumber value={sizeText(source.bytes)} />
                      </span>
                    )}
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
                <div className="security-scan-inline">
                  <p className="muted">Add a local project to start a scan.</p>
                  <Button
                    className="button button-secondary"
                    onClick={onAddProject}
                    disabled={busy}
                  >
                    <Icon name="plus" /> Add project
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="security-scan-group">
          <p className="security-scan-group-title">Model</p>
          {provider ? (
            <>
              <div className="security-scan-row">
                <label htmlFor={`${id}-model`} className="security-scan-row-label">
                  Model
                </label>
                <div className="security-scan-row-control">
                  <div className="security-scan-model">
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
                    <ScanModelField
                      id={`${id}-model`}
                      label="Model"
                      provider={provider}
                      model={model}
                      onChange={setModel}
                      catalog={catalog}
                      busy={busy}
                    />
                  </div>
                  {catalog.error && (
                    <p className="error-message" role="alert">
                      {catalog.error}
                    </p>
                  )}
                </div>
              </div>
              <div className="security-scan-row">
                <label htmlFor={`${id}-validator`} className="security-scan-row-label">
                  Validate with
                </label>
                <div className="security-scan-row-control">
                  <Select
                    label="Validate with"
                    id={`${id}-validator`}
                    value={validator ? validator.id : SAME_VALIDATOR}
                    items={[
                      {
                        value: SAME_VALIDATOR,
                        label: model.trim() ? `Same model (${model.trim()})` : "Same model",
                      },
                      ...providers.map((item) => ({ value: item.id, label: item.name })),
                    ]}
                    onValueChange={(value) => {
                      if (value === SAME_VALIDATOR) {
                        setDifferentValidator(false);
                        return;
                      }
                      setDifferentValidator(true);
                      setValidatorId(value);
                      setValidatorModel(
                        value === provider.id
                          ? model
                          : (providers.find((item) => item.id === value)?.model ?? ""),
                      );
                    }}
                    disabled={busy}
                  />
                  {validator && (
                    <div className="security-scan-field">
                      <label htmlFor={`${id}-validator-model`}>Validation model</label>
                      <ScanModelField
                        id={`${id}-validator-model`}
                        label="Validation model"
                        provider={validator}
                        model={validatorModel}
                        onChange={setValidatorModel}
                        catalog={validatorCatalog}
                        busy={busy}
                      />
                    </div>
                  )}
                  {validatorCatalog.error && (
                    <p className="error-message" role="alert">
                      {validatorCatalog.error}
                    </p>
                  )}
                  <p className="security-scan-row-help">
                    Validation checks each candidate for counterevidence.
                  </p>
                </div>
              </div>
            </>
          ) : (
            <div className="security-scan-row" data-align="text">
              <span className="security-scan-row-label">Model</span>
              <p className="security-scan-row-control muted">
                <Link className="security-row-link" to="/settings/providers" onClick={onClose}>
                  Add a provider
                </Link>{" "}
                to review source.
              </p>
            </div>
          )}
        </div>
        <div className="security-scan-group">
          <p className="security-scan-group-title">Review</p>
          <RadioGroup
            className="security-scan-row"
            name="mode"
            orientation="horizontal"
            value={mode}
            onChange={(value) => setMode(value as ReviewMode)}
            isDisabled={busy}
          >
            <Label className="security-scan-row-label">Mode</Label>
            <div className="security-scan-cards">
              {(["batch", "explore"] as const).map((value) => (
                <Radio key={value} value={value} className="security-scan-card">
                  <span className="security-scan-card-title">
                    <span className="ui-choice-radio" aria-hidden="true" />
                    {MODE_COPY[value].label}
                  </span>
                  <span className="security-scan-card-description">
                    {MODE_COPY[value].description}
                  </span>
                  <span className="security-scan-card-meta">
                    <NumericText>{MODE_COPY[value].calls}</NumericText>
                  </span>
                </Radio>
              ))}
            </div>
          </RadioGroup>
          <RadioGroup
            className="security-scan-row"
            name="depth"
            orientation="horizontal"
            value={depth}
            onChange={(value) => setDepth(value as SelectableScanDepth)}
            isDisabled={busy}
          >
            <Label className="security-scan-row-label">Depth</Label>
            <div className="security-scan-cards">
              {(["quick", "full"] as const).map((value) => (
                <Radio key={value} value={value} className="security-scan-card">
                  <span className="security-scan-card-title">
                    <span className="ui-choice-radio" aria-hidden="true" />
                    {SCAN_DEPTHS[value].label}
                  </span>
                  <span className="security-scan-card-description">
                    {value === "full" && !limited ? UNLIMITED_COPY[mode] : DEPTH_COPY[value][mode]}
                  </span>
                  <span className="security-scan-card-meta">
                    <NumericText>{depthMeta[value]}</NumericText>
                  </span>
                </Radio>
              ))}
            </div>
          </RadioGroup>
          {depth === "full" && (
            <div className="security-scan-row security-scan-limit">
              <span className="security-scan-row-label">Limit</span>
              <div className="security-scan-row-control">
                <div className="security-scan-limit-heading">
                  <RadioGroup
                    className="security-scan-presets"
                    aria-label="Spending limit"
                    orientation="horizontal"
                    value={preset}
                    onChange={(value) => {
                      if (value === NO_LIMIT) {
                        setLimited(false);
                        return;
                      }
                      setLimited(true);
                      if (kind === "tokens") setTokenLimit(value);
                      else setUsdLimit(Number(value).toFixed(2));
                    }}
                    isDisabled={busy}
                  >
                    {presets.map((amount) => (
                      <Radio key={amount} value={String(amount)} className="security-scan-preset">
                        {kind === "tokens" ? `${amount / 1_000_000}M` : `USD ${amount}`}
                      </Radio>
                    ))}
                    <Radio value={NO_LIMIT} className="security-scan-preset">
                      No limit
                    </Radio>
                  </RadioGroup>
                  {limited && (
                    <RadioGroup
                      className="security-scan-segmented"
                      data-size="small"
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
                {limited && (
                  <>
                    <label htmlFor={`${id}-limit`} className="sr-only">
                      {kind === "tokens" ? "Token limit" : "USD limit"}
                    </label>
                    <div className="security-scan-limit-input">
                      <Input
                        id={`${id}-limit`}
                        inputMode={kind === "tokens" ? "numeric" : "decimal"}
                        value={limitText}
                        onFocus={() => setEditingLimit(true)}
                        onBlur={() => setEditingLimit(false)}
                        onChange={(event) =>
                          kind === "tokens"
                            ? setTokenLimit(event.target.value.replace(/\D/g, ""))
                            : setUsdLimit(event.target.value.replace(/[^\d.]/g, ""))
                        }
                        aria-invalid={Boolean(limitError)}
                        aria-describedby={limitError ? `${id}-limit-error` : undefined}
                        disabled={busy}
                      />
                      <span className="security-scan-limit-unit" aria-hidden="true">
                        {kind === "tokens" ? "tokens" : "USD"}
                      </span>
                    </div>
                    {limitError && (
                      <p id={`${id}-limit-error`} className="error-message">
                        <NumericText>{limitError}</NumericText>
                      </p>
                    )}
                    {!usdPricing && !pricingLoading && kind === "tokens" && (
                      <p className="security-scan-row-help">
                        USD limits need prices for each selected model.
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
        {error && (
          <p className="error-message security-scan-error" role="alert">
            <NumericText>{error}</NumericText>
          </p>
        )}
      </form>
    </DetailDrawer>
  );
}

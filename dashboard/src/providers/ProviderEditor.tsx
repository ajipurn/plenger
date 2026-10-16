import { type FormEvent, type RefObject, useEffect, useState } from "react";
import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import type { ChatgptLoginResult } from "../../../src/dashboard/contract.ts";
import {
  API_KEY_MAX_LENGTH,
  API_KEY_PREVIEW,
  CHATGPT,
  MAX_OUTPUT_TOKENS,
} from "../../../src/redteam/constants.ts";
import {
  hasProviderModelCatalog,
  PROVIDER_URLS,
  type SavedProvider,
} from "../../../src/redteam/provider-config.ts";
import { DetailDrawer } from "../shared/DetailDrawer.tsx";
import { Icon } from "../shared/icons.tsx";
import { PROVIDER_OPTIONS, type ProviderKind } from "../shared/providers.ts";
import { Button, Checkbox, Input, Select } from "../shared/ui.tsx";
import { ModelPricingEditor, type PricingDraft, pricingValues } from "./ModelPricingEditor.tsx";
import type { useProviderModels } from "./useProviderModels.ts";

export interface ProviderForm {
  modelPricing: PricingDraft[];
  name: string;
  provider: ProviderKind;
  model: string;
  baseUrl: string;
  /** Kept as typed so an empty field means the model default. */
  temperature: string;
  output: number;
  apiKey: string;
  isDefault: boolean;
  /**
   * OpenAI and Claude editors hide temperature and output. Saved explicit values are
   * kept unless the user switches the connection to automatic settings.
   */
  keepGeneration: boolean;
}

/** Explicit generation settings a catalog provider still carries from an earlier save. */
export function savedGeneration(
  selected: SavedProvider | null,
  provider: ProviderKind,
): { temperature: number | null; maxOutputTokens: number | null } | null {
  if (!selected || selected.provider !== provider || !hasProviderModelCatalog(provider))
    return null;
  const temperature = selected.temperature ?? null;
  const maxOutputTokens = selected.maxOutputTokens ?? null;
  return temperature === null && maxOutputTokens === null ? null : { temperature, maxOutputTokens };
}

export function ProviderEditor({
  id,
  open,
  onOpenChange,
  busy,
  apiAvailable,
  selected,
  form,
  onChange,
  onSubmit,
  onCancel,
  onTest,
  onDelete,
  error,
  notice,
  returnFocus,
  contentRef,
  login,
  onConnect,
  onCancelLogin,
  catalog,
  onLoadModels,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  apiAvailable: boolean;
  /** The provider being edited, or null when adding one. */
  selected: SavedProvider | null;
  form: ProviderForm;
  onChange: (patch: Partial<ProviderForm>) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onTest: (provider: SavedProvider) => void;
  onDelete: (provider: SavedProvider) => void;
  error: string;
  notice: string;
  returnFocus: () => HTMLElement | null | undefined;
  contentRef: RefObject<HTMLDivElement | null>;
  login: ChatgptLoginResult | null;
  onConnect: () => void;
  onCancelLogin: () => void;
  catalog: ReturnType<typeof useProviderModels>;
  onLoadModels: () => void;
}) {
  const [tab, setTab] = useState("connection");
  const [pricingModel, setPricingModel] = useState("");
  const [validationError, setValidationError] = useState("");
  useEffect(() => {
    if (open) {
      setTab("connection");
      setPricingModel("");
      setValidationError("");
    }
  }, [open]);
  const signingIn = login?.state === "pending";
  const disabled = busy || signingIn || !apiAvailable;
  const connected =
    form.provider === "chatgpt" && selected?.provider === "chatgpt" && !!selected.chatgptAccount;
  const keySaved =
    selected?.hasApiKey && selected.provider === form.provider && selected.baseUrl === form.baseUrl;
  const hasCatalog = hasProviderModelCatalog(form.provider);
  const generation = savedGeneration(selected, form.provider);
  const apiKeyField = form.provider !== "chatgpt" && (
    <label className="provider-field-full" htmlFor={`${id}-key`}>
      API key {form.provider === "ollama" && "(optional)"}
      <Input
        id={`${id}-key`}
        type="password"
        autoComplete="new-password"
        value={form.apiKey}
        onChange={(e) => onChange({ apiKey: e.target.value })}
        // The saved-key mask is display-only. Keep the replacement value empty.
        placeholder={
          keySaved ? (selected?.apiKeyPreview ?? API_KEY_PREVIEW.mask) : "Enter an API key"
        }
        maxLength={API_KEY_MAX_LENGTH}
        required={form.provider !== "ollama" && !keySaved}
      />
      <span className="muted">
        {keySaved
          ? "Encrypted on this device. Leave blank to keep the saved key."
          : "Encrypted on this device. Excluded from reports and exports."}
      </span>
    </label>
  );
  const modelItems = catalog.models.map((model) => ({
    value: model.id,
    label: model.name,
  }));
  if (form.model && !modelItems.some((item) => item.value === form.model))
    modelItems.unshift({ value: form.model, label: form.model });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || catalog.loading) return;
    setValidationError("");
    const invalidConnection = event.currentTarget.querySelector<HTMLInputElement>(
      '[data-provider-panel="connection"] input:invalid',
    );
    if (invalidConnection) {
      setTab("connection");
      requestAnimationFrame(() => {
        const details = invalidConnection.closest("details");
        if (details) details.open = true;
        invalidConnection.focus();
        invalidConnection.reportValidity();
      });
      return;
    }
    if (hasCatalog && !form.model) {
      setTab("connection");
      setValidationError("Choose a default model. Load models first if the list is empty.");
      requestAnimationFrame(() => {
        const model = document.getElementById(`${id}-model`) as HTMLButtonElement | null;
        (model?.disabled ? document.getElementById(`${id}-load-models`) : model)?.focus();
      });
      return;
    }
    if (form.provider === "anthropic") {
      for (const draft of form.modelPricing) {
        try {
          pricingValues([draft]);
        } catch {
          setTab("pricing");
          setPricingModel(draft.model);
          setValidationError(
            `Complete the prices for ${draft.model}. Enter 0 for a free category.`,
          );
          requestAnimationFrame(() => {
            const invalid = document
              .getElementById(`${id}-form`)
              ?.querySelector<HTMLInputElement>('[data-provider-panel="pricing"] input:invalid');
            invalid?.focus();
            invalid?.reportValidity();
          });
          return;
        }
      }
    }
    onSubmit();
  }
  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      dismissible={!busy && !signingIn}
      className="inventory-detail-panel provider-editor-panel"
      headingClassName="provider-editor-heading"
      bodyClassName="inventory-detail-scroll provider-editor-body"
      eyebrow="Settings · Providers"
      title={selected ? "Edit provider" : "Add provider"}
      description={
        form.provider === "anthropic"
          ? "Manage your model connection and scan cost estimates."
          : "Manage your model connection for scans and fix prompts."
      }
      descriptionClassName="muted"
      closeLabel="Close provider editor"
      closeDisabled={busy || signingIn}
      returnFocus={returnFocus}
      contentRef={contentRef}
      footer={
        <div className="provider-editor-footer">
          {(validationError || error) && open && (
            <p className="error-message" role="alert">
              {validationError || error}
            </p>
          )}
          {notice && open && <p role="status">{notice}</p>}
          <div className="provider-footer-actions">
            <p className="muted">{busy ? "Please wait…" : "Changes apply when you save."}</p>
            <div className="provider-actions">
              <Button
                className="button button-secondary"
                onClick={onCancel}
                disabled={busy || signingIn}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                form={`${id}-form`}
                className="button button-primary"
                disabled={disabled || catalog.loading}
              >
                {signingIn
                  ? "Waiting for ChatGPT…"
                  : form.provider === "chatgpt" && !connected
                    ? "Continue with ChatGPT"
                    : "Save provider"}
              </Button>
            </div>
          </div>
        </div>
      }
    >
      <form
        id={`${id}-form`}
        noValidate
        onSubmit={submit}
        onChangeCapture={() => setValidationError("")}
      >
        <fieldset disabled={busy || signingIn || !apiAvailable} className="provider-fields">
          <Tabs
            selectedKey={form.provider === "anthropic" ? tab : "connection"}
            onSelectionChange={(key) => setTab(String(key))}
            className="provider-tabs"
          >
            <TabList
              aria-label="Provider settings"
              className={`provider-editor-tabs${form.provider === "anthropic" ? "" : " provider-only-connection"}`}
            >
              <Tab id="connection" className="provider-editor-tab">
                <Icon name="providers" />
                Connection
              </Tab>
              {form.provider === "anthropic" && (
                <Tab id="pricing" className="provider-editor-tab">
                  <Icon name="models" />
                  Model pricing
                  {form.modelPricing.length > 0 && (
                    <span className="tag">{form.modelPricing.length}</span>
                  )}
                </Tab>
              )}
            </TabList>
            <TabPanel
              id="connection"
              shouldForceMount
              className="provider-tab-panel"
              data-provider-panel="connection"
            >
              <div className="provider-form-grid">
                <label htmlFor={`${id}-name`}>
                  Name
                  <Input
                    id={`${id}-name`}
                    value={form.name}
                    onChange={(e) => onChange({ name: e.target.value })}
                    placeholder={
                      form.provider === "chatgpt"
                        ? "ChatGPT · security tests"
                        : form.provider === "anthropic"
                          ? "Claude · security review"
                          : form.provider === "openai"
                            ? "OpenAI · security review"
                            : "Qwen · security tests"
                    }
                    maxLength={80}
                    required
                  />
                </label>
                <label htmlFor={`${id}-provider`}>
                  Provider
                  <Select
                    label="Provider"
                    id={`${id}-provider`}
                    value={form.provider}
                    disabled={busy || signingIn || !apiAvailable}
                    onValueChange={(value: ProviderKind) =>
                      onChange({
                        provider: value,
                        baseUrl: PROVIDER_URLS[value],
                        apiKey: "",
                        model: "",
                        ...(value === "chatgpt"
                          ? { temperature: "", name: form.name || "ChatGPT", model: "" }
                          : value === "anthropic"
                            ? { temperature: "", name: form.name || "Claude", model: "" }
                            : {}),
                      })
                    }
                    items={PROVIDER_OPTIONS}
                  />
                </label>
                {hasCatalog && apiKeyField}
                {hasCatalog ? (
                  <div className="provider-field-full provider-model-field">
                    <label htmlFor={`${id}-model`}>Default model</label>
                    <div className="provider-model-control">
                      <Select
                        label="Default model"
                        id={`${id}-model`}
                        value={form.model}
                        items={modelItems}
                        placeholder={catalog.loaded ? "Choose a model" : "Load models first"}
                        disabled={busy || catalog.loading || !apiAvailable || !modelItems.length}
                        onValueChange={(model) => onChange({ model })}
                      />
                      <Button
                        className="button button-secondary"
                        disabled={
                          busy || catalog.loading || !apiAvailable || (!form.apiKey && !keySaved)
                        }
                        id={`${id}-load-models`}
                        onClick={onLoadModels}
                      >
                        {catalog.loading
                          ? "Loading models…"
                          : catalog.loaded
                            ? "Reload models"
                            : "Load models"}
                      </Button>
                    </div>
                    <p className="muted" role="status">
                      {catalog.loading
                        ? "Loading available models…"
                        : catalog.loaded
                          ? catalog.models.length
                            ? `${catalog.models.length} models available. You can choose another model when starting a scan.`
                            : "No models are available for this key."
                          : keySaved
                            ? "Load models using the saved API key, or enter a replacement key."
                            : "Enter an API key, then load available models."}
                    </p>
                    {form.model && <code className="provider-model-id muted">{form.model}</code>}
                    {catalog.error && (
                      <p className="error-message" role="alert">
                        {catalog.error}
                      </p>
                    )}
                  </div>
                ) : (
                  <label htmlFor={`${id}-model`}>
                    {form.provider === "chatgpt" ? "Model" : "Model ID"}
                    {form.provider === "chatgpt" && login?.models.length ? (
                      <Select
                        label="Model"
                        id={`${id}-model`}
                        value={form.model}
                        disabled={busy || signingIn || !apiAvailable}
                        onValueChange={(model: string) => onChange({ model })}
                        items={login.models.map((model) => ({
                          value: model.id,
                          label: model.name,
                        }))}
                      />
                    ) : (
                      <Input
                        id={`${id}-model`}
                        value={form.model}
                        onChange={(e) => onChange({ model: e.target.value })}
                        placeholder={
                          form.provider === "chatgpt"
                            ? "Available after sign-in"
                            : form.provider === "anthropic"
                              ? "Enter a Claude model ID"
                              : "qwen3-coder:480b-cloud"
                        }
                        maxLength={128}
                        disabled={form.provider === "chatgpt" && !connected}
                        required={form.provider !== "chatgpt" || connected}
                      />
                    )}
                  </label>
                )}
                {!hasCatalog && form.provider !== "chatgpt" && (
                  <label htmlFor={`${id}-url`}>
                    Base URL
                    <Input
                      id={`${id}-url`}
                      type="url"
                      value={form.baseUrl}
                      onChange={(e) => onChange({ baseUrl: e.target.value })}
                      maxLength={2048}
                      required
                    />
                  </label>
                )}
                {!hasCatalog && form.provider !== "chatgpt" && (
                  <label htmlFor={`${id}-temperature`}>
                    Temperature
                    <Input
                      id={`${id}-temperature`}
                      type="number"
                      min={0}
                      max={2}
                      step={0.1}
                      value={form.temperature}
                      onChange={(e) => onChange({ temperature: e.target.value })}
                      placeholder="Model default"
                    />
                    <span className="muted">Leave blank to use the model's default.</span>
                  </label>
                )}
                {!hasCatalog && (
                  <label htmlFor={`${id}-output`}>
                    {form.provider === "chatgpt"
                      ? "Output token threshold"
                      : "Maximum output tokens"}
                    <Input
                      id={`${id}-output`}
                      type="number"
                      min={1}
                      max={MAX_OUTPUT_TOKENS}
                      value={form.output}
                      onChange={(e) => onChange({ output: Number(e.target.value) })}
                      required
                    />
                    <span className="muted">
                      {form.provider === "chatgpt"
                        ? "Stops further red-team calls after a response exceeds this threshold. The response can exceed it. Scans and fix prompts use their own allowance."
                        : "Applied to each red-team model call. Scans and fix prompts use their own allowance."}
                    </span>
                  </label>
                )}
                {!hasCatalog && apiKeyField}
              </div>
              {hasCatalog && (
                <details className="provider-advanced">
                  <summary>Advanced connection settings</summary>
                  <label htmlFor={`${id}-url`}>
                    Base URL
                    <Input
                      id={`${id}-url`}
                      type="url"
                      value={form.baseUrl}
                      onChange={(event) => onChange({ baseUrl: event.target.value })}
                      maxLength={2048}
                      required
                    />
                  </label>
                  <p className="muted">
                    {form.provider === "anthropic"
                      ? "Uses the model's default temperature. Output limits are set automatically."
                      : "Uses the model's default temperature. Each operation's token allowance is sent as the output limit."}
                  </p>
                  {generation && (
                    <Checkbox
                      isDisabled={disabled}
                      isSelected={form.keepGeneration}
                      onChange={(checked) => onChange({ keepGeneration: checked })}
                    >
                      Keep the saved{" "}
                      {[
                        generation.temperature === null
                          ? null
                          : `temperature ${generation.temperature}`,
                        generation.maxOutputTokens === null
                          ? null
                          : `output limit of ${generation.maxOutputTokens.toLocaleString("en-US")} tokens`,
                      ]
                        .filter(Boolean)
                        .join(" and ")}
                    </Checkbox>
                  )}
                </details>
              )}
              {form.provider === "ollama" && (
                <p className="muted">
                  Downloaded models run locally. Models ending in :cloud use Ollama Cloud through
                  your Ollama connection.
                </p>
              )}
              {form.provider === "chatgpt" && (
                <p className="muted">
                  {connected
                    ? `Connected as ${selected?.chatgptAccount}.`
                    : "Sign in with ChatGPT in a new tab to save this provider and choose an available model."}{" "}
                  Requests use your ChatGPT plan. Token thresholds are checked after each response
                  and are not hard spending caps.{" "}
                  <a href={CHATGPT.usageUrl} target="_blank" rel="noreferrer">
                    Manage ChatGPT usage
                  </a>
                </p>
              )}
              <Checkbox
                className="provider-default"
                isDisabled={busy || signingIn || !apiAvailable}
                isSelected={form.isDefault}
                onChange={(checked) => onChange({ isDefault: checked })}
              >
                Default provider for new scans
              </Checkbox>
              <div className="provider-actions">
                {connected && (
                  <Button type="button" className="button button-secondary" onClick={onConnect}>
                    Reconnect ChatGPT
                  </Button>
                )}
                {selected && (
                  <Button
                    type="button"
                    className="button button-secondary"
                    onClick={() => selected && onTest(selected)}
                  >
                    Test saved connection
                  </Button>
                )}
              </div>
              {selected && (
                <p className="muted provider-hint">
                  Makes one model call using the saved settings.
                </p>
              )}
              {selected && (
                <div className="provider-delete">
                  <Button
                    className="button button-danger"
                    disabled={disabled}
                    onClick={() => onDelete(selected)}
                  >
                    <Icon name="trash" />
                    Delete provider
                  </Button>
                </div>
              )}
            </TabPanel>
            {form.provider === "anthropic" && (
              <TabPanel
                id="pricing"
                shouldForceMount
                className="provider-tab-panel"
                data-provider-panel="pricing"
              >
                <ModelPricingEditor
                  models={catalog.models}
                  defaultModel={form.model}
                  value={form.modelPricing}
                  onChange={(modelPricing) => onChange({ modelPricing })}
                  disabled={disabled}
                  selectedModel={pricingModel}
                  onSelectModel={setPricingModel}
                />
              </TabPanel>
            )}
          </Tabs>
        </fieldset>
      </form>
      {signingIn && (
        <div className="provider-notice provider-signin-notice">
          <p role="status">
            Finish signing in in the ChatGPT tab. This form updates automatically.
          </p>
          <div className="provider-actions">
            {login.authorizationUrl && (
              <a
                className="button button-secondary"
                href={login.authorizationUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open ChatGPT sign-in
              </a>
            )}
            <Button className="button button-secondary" disabled={busy} onClick={onCancelLogin}>
              Cancel sign-in
            </Button>
          </div>
        </div>
      )}
    </DetailDrawer>
  );
}

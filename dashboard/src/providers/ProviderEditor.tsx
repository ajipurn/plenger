import { Checkbox } from "@base-ui/react/checkbox";
import type { ChatgptLoginResult } from "../../../src/dashboard/contract.ts";
import { CHATGPT } from "../../../src/redteam/constants.ts";
import { PROVIDER_URLS, type SavedProvider } from "../../../src/redteam/provider-config.ts";
import { DetailDrawer } from "../shared/DetailDrawer.tsx";
import { Icon } from "../shared/icons.tsx";
import { PROVIDER_OPTIONS, type ProviderKind } from "../shared/providers.ts";
import { Button, Input, Select } from "../shared/ui.tsx";

export interface ProviderForm {
  name: string;
  provider: ProviderKind;
  model: string;
  baseUrl: string;
  /** Kept as typed so an empty field means the model default. */
  temperature: string;
  output: number;
  apiKey: string;
  isDefault: boolean;
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
  login,
  onConnect,
  onCancelLogin,
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
  login: ChatgptLoginResult | null;
  onConnect: () => void;
  onCancelLogin: () => void;
}) {
  const signingIn = login?.state === "pending";
  const connected =
    form.provider === "chatgpt" && selected?.provider === "chatgpt" && !!selected.chatgptAccount;
  const keySaved =
    selected?.hasApiKey && selected.provider === form.provider && selected.baseUrl === form.baseUrl;
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
      description="Connection and model settings for red-team tests."
      descriptionClassName="muted"
      closeLabel="Close provider editor"
      closeDisabled={busy || signingIn}
      returnFocus={returnFocus}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <fieldset disabled={busy || signingIn || !apiAvailable} className="provider-fields">
          <div className="provider-form-grid">
            <label htmlFor={`${id}-name`}>
              Name
              <Input
                id={`${id}-name`}
                value={form.name}
                onChange={(e) => onChange({ name: e.target.value })}
                placeholder={
                  form.provider === "chatgpt" ? "ChatGPT · security tests" : "Qwen · security tests"
                }
                maxLength={80}
                required
              />
            </label>
            <label htmlFor={`${id}-provider`}>
              Provider
              <Select
                id={`${id}-provider`}
                value={form.provider}
                disabled={busy || signingIn || !apiAvailable}
                onValueChange={(value: ProviderKind) =>
                  onChange({
                    provider: value,
                    baseUrl: PROVIDER_URLS[value],
                    apiKey: "",
                    ...(value === "chatgpt"
                      ? { temperature: "", name: form.name || "ChatGPT", model: "" }
                      : {}),
                  })
                }
                items={PROVIDER_OPTIONS}
              />
            </label>
            <label htmlFor={`${id}-model`}>
              {form.provider === "chatgpt" ? "Model" : "Model ID"}
              {form.provider === "chatgpt" && login?.models.length ? (
                <Select
                  id={`${id}-model`}
                  value={form.model}
                  disabled={busy || signingIn || !apiAvailable}
                  onValueChange={(model: string) => onChange({ model })}
                  items={login.models.map((model) => ({ value: model.id, label: model.name }))}
                />
              ) : (
                <Input
                  id={`${id}-model`}
                  value={form.model}
                  onChange={(e) => onChange({ model: e.target.value })}
                  placeholder={
                    form.provider === "chatgpt"
                      ? "Available after sign-in"
                      : "qwen3-coder:480b-cloud"
                  }
                  maxLength={128}
                  disabled={form.provider === "chatgpt" && !connected}
                  required={form.provider !== "chatgpt" || connected}
                />
              )}
            </label>
            {form.provider !== "chatgpt" && (
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
            {form.provider !== "chatgpt" && (
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
            <label htmlFor={`${id}-output`}>
              {form.provider === "chatgpt" ? "Output token threshold" : "Maximum output tokens"}
              <Input
                id={`${id}-output`}
                type="number"
                min={1}
                max={16384}
                value={form.output}
                onChange={(e) => onChange({ output: Number(e.target.value) })}
                required
              />
              <span className="muted">
                {form.provider === "chatgpt"
                  ? "Stops further calls after a response exceeds this threshold. The response can exceed it."
                  : "Applied to each model call within the test budget."}
              </span>
            </label>
            {form.provider !== "chatgpt" && (
              <label className="provider-field-full" htmlFor={`${id}-key`}>
                API key {form.provider === "ollama" && "(optional)"}
                <Input
                  id={`${id}-key`}
                  type="password"
                  autoComplete="new-password"
                  value={form.apiKey}
                  onChange={(e) => onChange({ apiKey: e.target.value })}
                  placeholder={keySaved ? "Saved · leave blank to keep" : "Enter an API key"}
                  maxLength={4096}
                  required={form.provider !== "ollama" && !keySaved}
                />
                <span className="muted">
                  Saved encrypted on this device. API keys are excluded from reports and exports.
                </span>
              </label>
            )}
          </div>
          {form.provider === "ollama" && (
            <p className="muted">
              Downloaded models run locally. Models ending in :cloud use Ollama Cloud through your
              Ollama connection.
            </p>
          )}
          {form.provider === "chatgpt" && (
            <p className="muted">
              {connected
                ? `Connected as ${selected?.chatgptAccount}.`
                : "Sign in with ChatGPT in a new tab to save this provider and choose an available model."}{" "}
              Requests use your ChatGPT plan. Token thresholds are checked after each response and
              are not hard spending caps.{" "}
              <a href={CHATGPT.usageUrl} target="_blank" rel="noreferrer">
                Manage ChatGPT usage
              </a>
            </p>
          )}
          <label className="provider-default" htmlFor={`${id}-default`}>
            <Checkbox.Root
              id={`${id}-default`}
              className="provider-checkbox"
              disabled={busy || signingIn || !apiAvailable}
              checked={form.isDefault}
              onCheckedChange={(checked) => onChange({ isDefault: checked })}
            >
              <Checkbox.Indicator>
                <Icon name="check" />
              </Checkbox.Indicator>
            </Checkbox.Root>
            Use as the default provider for new tests
          </label>
          <div className="provider-actions">
            <Button className="button button-secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" className="button button-primary">
              {signingIn
                ? "Waiting for ChatGPT…"
                : form.provider === "chatgpt" && !connected
                  ? "Continue with ChatGPT"
                  : "Save provider"}
            </Button>
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
              Testing the saved connection makes one model call.
            </p>
          )}
        </fieldset>
      </form>
      {signingIn && (
        <div className="provider-notice">
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
      {error && open && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {notice && open && (
        <p className="provider-notice" role="status">
          {notice}
        </p>
      )}
      {selected && (
        <div className="provider-delete">
          <Button
            className="button button-danger"
            disabled={busy || signingIn}
            onClick={() => onDelete(selected)}
          >
            <Icon name="trash" /> Delete provider
          </Button>
        </div>
      )}
    </DetailDrawer>
  );
}

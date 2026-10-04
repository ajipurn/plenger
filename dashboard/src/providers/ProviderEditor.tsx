import { Checkbox } from "@base-ui/react/checkbox";
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
}) {
  const keySaved =
    selected?.hasApiKey && selected.provider === form.provider && selected.baseUrl === form.baseUrl;
  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      dismissible={!busy}
      className="inventory-detail-panel provider-editor-panel"
      headingClassName="provider-editor-heading"
      bodyClassName="inventory-detail-scroll provider-editor-body"
      eyebrow="Settings · Providers"
      title={selected ? "Edit provider" : "Add provider"}
      description="Connection and model settings for red-team tests."
      descriptionClassName="muted"
      closeLabel="Close provider editor"
      closeDisabled={busy}
      returnFocus={returnFocus}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <fieldset disabled={busy || !apiAvailable} className="provider-fields">
          <div className="provider-form-grid">
            <label htmlFor={`${id}-name`}>
              Name
              <Input
                id={`${id}-name`}
                value={form.name}
                onChange={(e) => onChange({ name: e.target.value })}
                placeholder="Qwen · security tests"
                maxLength={80}
                required
              />
            </label>
            <label htmlFor={`${id}-provider`}>
              Provider
              <Select
                id={`${id}-provider`}
                value={form.provider}
                disabled={busy || !apiAvailable}
                onValueChange={(value: ProviderKind) =>
                  onChange({ provider: value, baseUrl: PROVIDER_URLS[value], apiKey: "" })
                }
                items={PROVIDER_OPTIONS}
              />
            </label>
            <label htmlFor={`${id}-model`}>
              Model ID
              <Input
                id={`${id}-model`}
                value={form.model}
                onChange={(e) => onChange({ model: e.target.value })}
                placeholder="qwen3-coder:480b-cloud"
                maxLength={128}
                required
              />
            </label>
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
            <label htmlFor={`${id}-output`}>
              Maximum output tokens
              <Input
                id={`${id}-output`}
                type="number"
                min={1}
                max={16384}
                value={form.output}
                onChange={(e) => onChange({ output: Number(e.target.value) })}
                required
              />
              <span className="muted">Applied to each model call within the test budget.</span>
            </label>
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
          </div>
          {form.provider === "ollama" && (
            <p className="muted">
              Downloaded models run locally. Models ending in :cloud use Ollama Cloud through your
              Ollama connection.
            </p>
          )}
          <label className="provider-default" htmlFor={`${id}-default`}>
            <Checkbox.Root
              id={`${id}-default`}
              className="provider-checkbox"
              disabled={busy || !apiAvailable}
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
              Save provider
            </Button>
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
            disabled={busy}
            onClick={() => onDelete(selected)}
          >
            <Icon name="trash" /> Delete provider
          </Button>
        </div>
      )}
    </DetailDrawer>
  );
}

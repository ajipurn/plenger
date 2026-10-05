import { useId, useRef, useState } from "react";
import { NavLink } from "react-router";
import { PROVIDER_URLS, type SavedProvider } from "../../../src/redteam/provider-config.ts";
import { useApi } from "../app/DashboardContext.tsx";
import { routes } from "../app/routes.ts";
import { useAsyncAction } from "../shared/async.ts";
import { Icon } from "../shared/icons.tsx";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { Button } from "../shared/ui.tsx";
import { DeleteProviderDialog } from "./DeleteProviderDialog.tsx";
import { ProviderEditor, type ProviderForm } from "./ProviderEditor.tsx";
import { ProviderTable } from "./ProviderTable.tsx";

export function ProvidersView({
  providers,
  onChange,
}: {
  providers: SavedProvider[];
  onChange: (providers: SavedProvider[]) => void;
}) {
  const api = useApi();
  const id = useId();
  const [editorOpen, setEditorOpen] = useState(false);
  const [query, setQuery] = useState("");
  const addButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const [selected, setSelected] = useState<SavedProvider | null>(null);
  const [form, setForm] = useState<ProviderForm>({
    name: "",
    provider: "ollama",
    model: "",
    baseUrl: PROVIDER_URLS.ollama,
    temperature: "",
    output: 1024,
    apiKey: "",
    isDefault: providers.length === 0,
  });
  const { busy, error, setError, run } = useAsyncAction();
  const [notice, setNotice] = useState("");
  const [pendingDelete, setPendingDelete] = useState<SavedProvider | null>(null);
  const update = (patch: Partial<ProviderForm>) => setForm((current) => ({ ...current, ...patch }));
  function edit(value: SavedProvider | null, trigger?: HTMLButtonElement) {
    returnFocus.current = trigger ?? addButton.current;
    setEditorOpen(true);
    setSelected(value);
    setForm({
      name: value?.name ?? "",
      provider: value?.provider ?? "ollama",
      model: value?.model ?? "",
      baseUrl: value?.baseUrl ?? PROVIDER_URLS.ollama,
      temperature: value?.temperature == null ? "" : String(value.temperature),
      output: value?.maxOutputTokens ?? 1024,
      isDefault: value?.isDefault ?? providers.length === 0,
      apiKey: "",
    });
    setError("");
    setNotice("");
  }
  function save() {
    if (!api) return;
    setNotice("");
    void run(async () => {
      const saved = await api.saveProvider({
        name: form.name,
        provider: form.provider,
        model: form.model,
        baseUrl: form.baseUrl,
        temperature: form.temperature === "" ? null : Number(form.temperature),
        maxOutputTokens: form.output,
        isDefault: form.isDefault,
        ...(selected ? { id: selected.id } : {}),
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      });
      onChange(await api.providers());
      setSelected(saved);
      update({ apiKey: "" });
      setEditorOpen(false);
      setNotice("Provider saved. Select it in Red-team when starting a test.");
    }, "Could not save the provider.");
  }
  function remove(value: SavedProvider) {
    if (!api) return;
    void run(async () => {
      await api.deleteProvider(value.id);
      onChange(await api.providers());
      setSelected(null);
      setPendingDelete(null);
      setEditorOpen(false);
      setNotice("Provider deleted, including its saved API key.");
    }, "Could not delete the provider.");
  }
  function test(value: SavedProvider) {
    if (!api) return;
    setNotice("");
    void run(async () => {
      const result = await api.testProvider(value.id);
      setNotice(
        `Connected to ${result.model} in ${(result.durationMs / 1000).toFixed(1)}s. This checks model access; tool support is verified during a test.`,
      );
    }, "Could not connect to the model.");
  }
  function makeDefault(value: SavedProvider) {
    if (!api) return;
    setNotice("");
    void run(async () => {
      await api.saveProvider({
        id: value.id,
        name: value.name,
        provider: value.provider,
        model: value.model,
        baseUrl: value.baseUrl,
        temperature: value.temperature,
        maxOutputTokens: value.maxOutputTokens,
        isDefault: true,
      });
      onChange(await api.providers());
      setNotice(`${value.name} is now the default for new tests.`);
    }, "Could not update the default provider.");
  }
  function requestDelete(value: SavedProvider) {
    setError("");
    setPendingDelete(value);
  }
  return (
    <div className="subnav-layout">
      <aside className="subnav">
        <p className="eyebrow">Workspace settings</p>
        <nav className="subnav-list" aria-label="Settings categories">
          <NavLink to={routes.providers} className="subnav-item">
            <Icon name="providers" /> Providers
          </NavLink>
        </nav>
      </aside>
      <section className="subnav-content" aria-labelledby={`${id}-list`}>
        <div className="subnav-content-heading">
          <div>
            <h2 id={`${id}-list`}>
              Providers{" "}
              <span className="tag">
                <MorphNumber value={providers.length} />
              </span>
            </h2>
            <p className="muted">
              Save model connections, then choose one when starting a red-team test.
            </p>
          </div>
          <Button
            ref={addButton}
            className="button button-primary"
            disabled={busy || !api}
            onClick={(event) => edit(null, event.currentTarget)}
          >
            <Icon name="plus" /> Add provider
          </Button>
        </div>
        {!editorOpen && error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {!editorOpen && notice && (
          <p className="provider-notice" role="status">
            {notice}
          </p>
        )}
        <ProviderTable
          id={id}
          providers={providers}
          query={query}
          onQueryChange={setQuery}
          busy={busy}
          onEdit={edit}
          onTest={test}
          onMakeDefault={makeDefault}
          onDelete={requestDelete}
        />
      </section>
      <ProviderEditor
        id={id}
        open={editorOpen}
        onOpenChange={(next) => {
          if (!busy) {
            setEditorOpen(next);
            if (!next) update({ apiKey: "" });
          }
        }}
        busy={busy}
        apiAvailable={!!api}
        selected={selected}
        form={form}
        onChange={update}
        onSubmit={save}
        onCancel={() => {
          setEditorOpen(false);
          update({ apiKey: "" });
        }}
        onTest={test}
        onDelete={requestDelete}
        error={error}
        notice={notice}
        returnFocus={() =>
          returnFocus.current?.isConnected ? returnFocus.current : addButton.current
        }
      />
      <DeleteProviderDialog
        provider={pendingDelete}
        busy={busy}
        error={error}
        finalFocus={addButton}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) remove(pendingDelete);
        }}
      />
    </div>
  );
}

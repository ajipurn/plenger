import { useId, useState } from "react";
import type { SavedRunProfile } from "../../src/dashboard/model.ts";
import type { ProjectPlan } from "../../src/redteam/plan.ts";
import { runBlocker } from "../../src/redteam/profile.ts";
import type { ProviderAccess } from "../../src/redteam/provider.ts";
import type { RedteamRun } from "../../src/redteam/run.ts";
import type { DashboardApi } from "./api.ts";
import { Icon } from "./icons.tsx";
import { RedteamResults } from "./RedteamResults.tsx";
import { Button, Input, Select } from "./ui.tsx";

export function RedteamRunner({
  api,
  plan,
  runs,
  profile,
  disabled,
  onUpdate,
}: {
  api: DashboardApi | null;
  plan: ProjectPlan;
  runs: RedteamRun[];
  profile: SavedRunProfile | null;
  disabled: boolean;
  onUpdate: (run: RedteamRun) => void;
}) {
  const id = useId();
  const [provider, setProvider] = useState<ProviderAccess["provider"]>(
    profile?.provider ?? "ollama",
  );
  const [model, setModel] = useState(profile?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [calls, setCalls] = useState(profile?.limits.maxModelCalls ?? 12);
  const [tokens, setTokens] = useState(
    profile?.limits.maxTokens ?? (plan.nextProfile ? 1_000_000 : 200_000),
  );
  const [seconds, setSeconds] = useState(
    (profile?.limits.timeoutMs ?? (plan.nextProfile ? 600_000 : 120_000)) / 1000,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const active = runs.find((run) => run.state === "preparing" || run.state === "running");
  const report = runs.find((run) => run.id === selected) ?? active ?? runs[0];
  const blocker = runBlocker(plan);

  async function start() {
    if (!api || !plan.selectedTarget) return;
    setPending(true);
    setError("");
    try {
      const run = await api.startRun({
        path: plan.root,
        target: plan.selectedTarget,
        sourceDigest: plan.sourceDigest,
        provider,
        model,
        ...(provider !== "ollama" ? { apiKey } : {}),
        limits: { maxModelCalls: calls, maxTokens: tokens, timeoutMs: seconds * 1000 },
      });
      setApiKey("");
      setSelected(run.id);
      onUpdate(run);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not start the run.");
    } finally {
      setPending(false);
    }
  }
  async function cancel() {
    if (!api || !active) return;
    setPending(true);
    setError("");
    try {
      await api.cancelRun(active.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not cancel the run.");
    } finally {
      setPending(false);
    }
  }
  function download(run: RedteamRun) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(run, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `plenger-run-${run.id}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      {report && (
        <RedteamResults
          report={report}
          plan={plan}
          runs={runs}
          onSelect={setSelected}
          onDownload={download}
          onCancel={active ? () => void cancel() : undefined}
          pending={pending}
        />
      )}
      <details
        className="panel run-panel run-setup"
        open={!report}
        key={report ? "repeat" : "initial"}
      >
        <summary className="disclosure-heading run-setup-heading">
          <span>{report ? "Configure another test" : "Run a security test"}</span>
          <Icon name="chevron" />
        </summary>
        <div className="run-setup-content">
          <div className="section-heading">
            <div>
              <h3 id={`${id}-heading`}>Choose a model and test limits</h3>
              <p className="muted">
                {plan.nextProfile
                  ? "Test booking and payment policies against your original route handler."
                  : "Test a file-write boundary with your selected model."}
              </p>
            </div>
            <span className="tag">
              {plan.nextProfile ? "Vercel AI SDK · SQLite" : "llmfy 0.11.0"}
            </span>
          </div>
          {!blocker ? (
            <>
              <p className="muted">
                {plan.nextProfile ? (
                  "Three built-in checks: a normal booking with a catalog-price invoice, a claimed manager price override, and a zero-payment request. Each check gets a fresh SQLite database. Your source, tool handlers and system policy run unchanged; no wrapper is required."
                ) : (
                  <>
                    Three built-in checks: an allowed write, a direct override, and a claimed
                    authorization. Tests use temporary files and preserve your tool handlers. A
                    compatible file-write tool is required for the clean check; otherwise the run is
                    inconclusive.
                  </>
                )}
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void start();
                }}
              >
                <fieldset disabled={disabled || pending || !!active} className="run-fields">
                  <div className="run-form">
                    <label htmlFor={`${id}-provider`}>
                      Provider
                      <Select
                        id={`${id}-provider`}
                        value={provider}
                        onValueChange={setProvider}
                        disabled={disabled || pending || !!active}
                        items={[
                          { value: "ollama", label: "Ollama" },
                          { value: "openai", label: "OpenAI" },
                          { value: "gemini", label: "Gemini" },
                        ]}
                      />
                    </label>
                    <label htmlFor={`${id}-model`}>
                      Model ID
                      <Input
                        id={`${id}-model`}
                        value={model}
                        onChange={(event) => setModel(event.target.value)}
                        placeholder="Enter your model ID"
                        required
                        maxLength={128}
                      />
                    </label>
                    {provider !== "ollama" && (
                      <label htmlFor={`${id}-key`}>
                        API key
                        <Input
                          id={`${id}-key`}
                          type="password"
                          autoComplete="off"
                          value={apiKey}
                          onChange={(event) => setApiKey(event.target.value)}
                          required
                          maxLength={4096}
                        />
                        <span className="muted">Used for this run; never saved.</span>
                      </label>
                    )}
                    <label htmlFor={`${id}-calls`}>
                      Model call limit
                      <Input
                        id={`${id}-calls`}
                        type="number"
                        min={1}
                        max={30}
                        value={calls}
                        onChange={(event) => setCalls(Number(event.target.value))}
                        required
                      />
                    </label>
                    <label htmlFor={`${id}-tokens`}>
                      Token budget
                      <Input
                        id={`${id}-tokens`}
                        type="number"
                        min={1}
                        max={2_000_000}
                        value={tokens}
                        onChange={(event) => setTokens(Number(event.target.value))}
                        required
                      />
                    </label>
                    <label htmlFor={`${id}-seconds`}>
                      Deadline (seconds)
                      <Input
                        id={`${id}-seconds`}
                        type="number"
                        min={1}
                        max={600}
                        value={seconds}
                        onChange={(event) => setSeconds(Number(event.target.value))}
                        required
                      />
                    </label>
                  </div>
                  {provider === "ollama" && (
                    <p className="muted">
                      Connects through Ollama on this device. Choose a downloaded model for local
                      inference; cloud models send requests to Ollama Cloud.
                    </p>
                  )}
                  <p className="muted">
                    {plan.nextProfile
                      ? "Docker Desktop or Podman must be installed and running."
                      : "Podman must be installed and running."}{" "}
                    Plenger prepares the runtime automatically. Your selected model overrides the
                    project's model for these tests.
                  </p>
                  <Button type="submit" className="button button-primary">
                    {pending ? "Starting…" : "Start test"}
                  </Button>
                </fieldset>
              </form>
            </>
          ) : (
            <p className="muted">{blocker}</p>
          )}
          {error && (
            <p role="alert" className="error-message">
              {error}
            </p>
          )}
        </div>
      </details>
    </>
  );
}

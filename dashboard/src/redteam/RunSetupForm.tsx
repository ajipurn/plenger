import { useId, useState } from "react";
import { Link } from "react-router";
import { CAMPAIGN_LIMITS, type SavedRunProfile } from "../../../src/dashboard/contract.ts";
import type { CampaignPolicy } from "../../../src/redteam/campaign.ts";
import type { ProjectPlan } from "../../../src/redteam/plan.ts";
import { runBlocker } from "../../../src/redteam/profile.ts";
import type { SavedProvider } from "../../../src/redteam/provider-config.ts";
import type { DashboardApi } from "../api/client.ts";
import { routes } from "../app/routes.ts";
import { Icon } from "../shared/icons.tsx";
import { PROVIDER_OPTIONS, type ProviderKind } from "../shared/providers.ts";
import { Button, Input, Select } from "../shared/ui.tsx";

export type CampaignStartConfig = Parameters<DashboardApi["startCampaign"]>[0];

export function RunSetupForm({
  plan,
  profile,
  providers,
  disabled,
  active,
  pending,
  error,
  onStart,
}: {
  plan: ProjectPlan;
  profile: SavedRunProfile | null;
  providers: SavedProvider[];
  disabled: boolean;
  /** A run or campaign is in progress, so a new one cannot start. */
  active: boolean;
  pending: boolean;
  error: string;
  /** Resolves to whether the campaign was accepted by the service. */
  onStart: (config: CampaignStartConfig) => Promise<boolean>;
}) {
  const id = useId();
  const [providerId, setProviderId] = useState(
    profile?.providerId ?? (profile ? "" : (providers.find((item) => item.isDefault)?.id ?? "")),
  );
  const savedProvider = providers.find((item) => item.id === providerId);
  const missingProvider = !!providerId && !savedProvider;
  const [provider, setProvider] = useState<ProviderKind>(profile?.provider ?? "ollama");
  const [model, setModel] = useState(profile?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [calls, setCalls] = useState(profile?.limits.maxModelCalls ?? 12);
  const [tokens, setTokens] = useState(
    profile?.limits.maxTokens ?? (plan.nextProfile ? 1_000_000 : 200_000),
  );
  const [seconds, setSeconds] = useState(
    (profile?.limits.timeoutMs ?? (plan.nextProfile ? 600_000 : 120_000)) / 1000,
  );
  const [repetitions, setRepetitions] = useState(profile?.repetitions ?? 1);
  const [failOn, setFailOn] = useState<CampaignPolicy["failOn"]>(profile?.policy?.failOn ?? "high");
  const [minimum, setMinimum] = useState(profile?.policy?.minimumEvaluable ?? 1);
  const [coverage, setCoverage] = useState((profile?.policy?.minCoverage ?? 1) * 100);
  const blocker = runBlocker(plan);
  const locked = disabled || pending || active;

  async function start() {
    if (!plan.selectedTarget) return;
    const started = await onStart({
      path: plan.root,
      target: plan.selectedTarget,
      sourceDigest: plan.sourceDigest,
      ...(providerId
        ? { providerId }
        : { provider, model, ...(provider !== "ollama" ? { apiKey } : {}) }),
      limits: { maxModelCalls: calls, maxTokens: tokens, timeoutMs: seconds * 1000 },
      repetitions,
      policy: {
        failOn,
        minimumEvaluable: minimum,
        minCoverage: coverage / 100,
        suppressions: profile?.policy?.suppressions ?? [],
      },
    });
    if (started) setApiKey("");
  }

  return (
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
        <span className="tag">{plan.nextProfile ? "Vercel AI SDK · SQLite" : "llmfy 0.11.0"}</span>
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
            <fieldset disabled={locked} className="run-fields">
              <div className="run-form">
                <div className="provider-field-full">
                  <label htmlFor={`${id}-connection`}>
                    Provider for this test
                    <Select
                      id={`${id}-connection`}
                      value={providerId}
                      onValueChange={setProviderId}
                      disabled={locked}
                      items={[
                        ...providers.map((item) => ({
                          value: item.id,
                          label: `${item.name}${item.isDefault ? " (Default)" : ""} · ${item.model}`,
                        })),
                        ...(missingProvider
                          ? [
                              {
                                value: providerId,
                                label: "Saved provider unavailable · select another",
                              },
                            ]
                          : []),
                        { value: "", label: "Enter connection for this run" },
                      ]}
                    />
                  </label>
                  <Link className="provider-settings-link" to={routes.providers}>
                    <Icon name="settings" /> Manage providers
                  </Link>
                </div>
                {savedProvider && (
                  <p className="muted provider-field-full">
                    {savedProvider.provider} · {savedProvider.baseUrl} ·{" "}
                    {savedProvider.maxOutputTokens.toLocaleString()} output tokens per call
                    {savedProvider.temperature === null
                      ? ""
                      : ` · temperature ${savedProvider.temperature}`}
                  </p>
                )}
                {missingProvider && (
                  <p role="alert" className="error-message provider-field-full">
                    This provider was deleted. Choose another connection before starting a test.
                  </p>
                )}
                {!providerId && (
                  <>
                    <label htmlFor={`${id}-provider`}>
                      Provider
                      <Select
                        id={`${id}-provider`}
                        value={provider}
                        onValueChange={setProvider}
                        disabled={locked}
                        items={PROVIDER_OPTIONS}
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
                  </>
                )}
                <label htmlFor={`${id}-calls`}>
                  Model call limit
                  <Input
                    id={`${id}-calls`}
                    type="number"
                    min={CAMPAIGN_LIMITS.maxModelCalls.min}
                    max={CAMPAIGN_LIMITS.maxModelCalls.max}
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
                    min={CAMPAIGN_LIMITS.maxTokens.min}
                    max={CAMPAIGN_LIMITS.maxTokens.max}
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
                    min={CAMPAIGN_LIMITS.timeoutMs.min / 1000}
                    max={CAMPAIGN_LIMITS.timeoutMs.max / 1000}
                    value={seconds}
                    onChange={(event) => setSeconds(Number(event.target.value))}
                    required
                  />
                </label>
                <label htmlFor={`${id}-repetitions`}>
                  Repetitions per attack
                  <Input
                    id={`${id}-repetitions`}
                    type="number"
                    min={CAMPAIGN_LIMITS.repetitions.min}
                    max={CAMPAIGN_LIMITS.repetitions.max}
                    value={repetitions}
                    onChange={(event) => setRepetitions(Number(event.target.value))}
                    required
                  />
                </label>
              </div>
              <p className="muted">
                The budget covers every normal task and attack across all {repetitions} repetitions.
                Increasing repetitions does not increase these limits.
              </p>
              <details className="technical-disclosure">
                <summary className="disclosure-heading">
                  CI gate requirements <Icon name="chevron" />
                </summary>
                <div className="run-form campaign-policy">
                  <label htmlFor={`${id}-fail-on`}>
                    Fail on severity
                    <Select
                      id={`${id}-fail-on`}
                      value={failOn}
                      onValueChange={setFailOn}
                      items={["none", "critical", "high", "medium", "low"].map((value) => ({
                        value: value as CampaignPolicy["failOn"],
                        label: value,
                      }))}
                    />
                  </label>
                  <label htmlFor={`${id}-coverage`}>
                    Minimum coverage (%)
                    <Input
                      id={`${id}-coverage`}
                      type="number"
                      min={1}
                      max={100}
                      value={coverage}
                      onChange={(event) => setCoverage(Number(event.target.value))}
                      required
                    />
                  </label>
                  <label htmlFor={`${id}-minimum`}>
                    Minimum usable tests per attack
                    <Input
                      id={`${id}-minimum`}
                      type="number"
                      min={1}
                      max={repetitions}
                      value={minimum}
                      onChange={(event) => setMinimum(Number(event.target.value))}
                      required
                    />
                  </label>
                </div>
              </details>
              {(savedProvider?.provider ?? provider) === "ollama" && (
                <p className="muted">
                  Connects through Ollama on this device. Choose a downloaded model for local
                  inference; cloud models send requests to Ollama Cloud.
                </p>
              )}
              <p className="muted">
                Docker Desktop or Podman must be installed and running. Plenger prepares the runtime
                automatically. Your selected model overrides the project's model for these tests.
              </p>
              <Button type="submit" className="button button-primary" disabled={missingProvider}>
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
  );
}

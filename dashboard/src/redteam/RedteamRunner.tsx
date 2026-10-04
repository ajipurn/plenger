import { useId, useState } from "react";
import type { SavedRunProfile } from "../../../src/dashboard/contract.ts";
import type { CampaignReport } from "../../../src/redteam/campaign.ts";
import type { ProjectPlan } from "../../../src/redteam/plan.ts";
import type { SavedProvider } from "../../../src/redteam/provider-config.ts";
import type { RedteamRun } from "../../../src/redteam/run.ts";
import { useApi } from "../app/DashboardContext.tsx";
import { CampaignComparison } from "../campaigns/CampaignComparison.tsx";
import { CampaignResults } from "../campaigns/CampaignResults.tsx";
import { useAsyncAction } from "../shared/async.ts";
import { downloadJson } from "../shared/download.ts";
import { formatDateTime } from "../shared/format.ts";
import { Icon } from "../shared/icons.tsx";
import { isActiveRunState } from "../shared/runs.ts";
import { Button, Select } from "../shared/ui.tsx";
import { RedteamResults } from "./RedteamResults.tsx";
import { type CampaignStartConfig, RunSetupForm } from "./RunSetupForm.tsx";

export function RedteamRunner({
  plan,
  runs,
  campaigns,
  profile,
  providers,
  disabled,
  onCampaignUpdate,
}: {
  plan: ProjectPlan;
  runs: RedteamRun[];
  campaigns: CampaignReport[];
  profile: SavedRunProfile | null;
  providers: SavedProvider[];
  disabled: boolean;
  onCampaignUpdate: (campaign: CampaignReport) => void;
}) {
  const api = useApi();
  const id = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const { busy: pending, error, run } = useAsyncAction();
  const savedTests = [...campaigns, ...runs].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
  const active = savedTests.find((run) => isActiveRunState(run.state));
  const report = savedTests.find((run) => run.id === selected) ?? active ?? savedTests[0];

  async function start(config: CampaignStartConfig): Promise<boolean> {
    if (!api) return false;
    return run(async () => {
      const campaign = await api.startCampaign(config);
      setSelected(campaign.id);
      onCampaignUpdate(campaign);
    }, "Could not start the run.");
  }
  function cancel() {
    if (!api || !active) return;
    void run(async () => {
      await api.cancelRun(active.id);
    }, "Could not cancel the run.");
  }
  function download(run: RedteamRun | CampaignReport, profileOnly = false) {
    downloadJson(
      `plenger-${profileOnly ? "profile" : "run"}-${run.id}.json`,
      profileOnly && run.kind === "redteam-campaign" ? run.plan : run,
    );
  }
  return (
    <>
      {report && (
        <div className="run-report-toolbar campaign-history">
          <label htmlFor={`${id}-history`} className="run-history-label">
            Viewing saved test
            <Select
              id={`${id}-history`}
              value={report.id}
              onValueChange={setSelected}
              items={savedTests.map((item) => ({
                value: item.id,
                label: `${item.kind === "redteam-campaign" ? `${item.plan.model} · ${item.plan.repetitions} repetitions` : item.model} · ${formatDateTime(item.createdAt, "locale")}`,
              }))}
            />
          </label>
          <div className="run-actions">
            <Button className="button button-secondary" onClick={() => download(report)}>
              <Icon name="download" />
              Export result
            </Button>
            {report.kind === "redteam-campaign" && (
              <Button className="button button-secondary" onClick={() => download(report, true)}>
                Export test profile
              </Button>
            )}
            {active && (
              <Button className="button button-secondary" disabled={pending} onClick={cancel}>
                Stop current test
              </Button>
            )}
          </div>
        </div>
      )}
      {report &&
        (report.kind === "redteam-campaign" ? (
          <>
            <CampaignResults key={report.id} report={report} plan={plan} />
            <CampaignComparison
              key={`comparison-${report.id}`}
              after={report}
              campaigns={campaigns}
            />
          </>
        ) : (
          <RedteamResults report={report} plan={plan} />
        ))}
      <details
        className="panel run-panel run-setup"
        open={!report}
        key={report ? "repeat" : "initial"}
      >
        <summary className="disclosure-heading run-setup-heading">
          <span>{report ? "Configure another test" : "Run a security test"}</span>
          <Icon name="chevron" />
        </summary>
        <RunSetupForm
          plan={plan}
          profile={profile}
          providers={providers}
          disabled={disabled}
          active={!!active}
          pending={pending}
          error={error}
          onStart={start}
        />
      </details>
    </>
  );
}

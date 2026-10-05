import type { SavedRunProfile } from "../../../src/dashboard/contract.ts";
import type { CampaignReport } from "../../../src/redteam/campaign.ts";
import type { ProjectPlan } from "../../../src/redteam/plan.ts";
import type { SavedProvider } from "../../../src/redteam/provider-config.ts";
import type { RedteamRun } from "../../../src/redteam/run.ts";
import { EmptyState } from "../shared/EmptyState.tsx";
import { Icon } from "../shared/icons.tsx";
import { SectionSummary } from "../shared/SectionSummary.tsx";
import { TechnicalDisclosure } from "../shared/TechnicalDisclosure.tsx";
import { Button } from "../shared/ui.tsx";
import { DependencyReview } from "./DependencyReview.tsx";
import { PendingChecklist } from "./PendingChecklist.tsx";
import { ReadinessCard } from "./ReadinessCard.tsx";
import { RedteamRunner } from "./RedteamRunner.tsx";
import { SourceCoverage } from "./SourceCoverage.tsx";
import { TargetList } from "./TargetList.tsx";

export function RedteamView({
  project,
  plan,
  busy,
  disabled,
  error,
  onPlan,
  runs,
  campaigns,
  profile,
  providers,
  onCampaignUpdate,
}: {
  project: string;
  plan: ProjectPlan | null;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onPlan: (target?: string) => void;
  runs: RedteamRun[];
  campaigns: CampaignReport[];
  profile: SavedRunProfile | null;
  providers: SavedProvider[];
  onCampaignUpdate: (campaign: CampaignReport) => void;
}) {
  const hasResults = runs.length + campaigns.length > 0;
  const reviewButton = (
    <Button
      type="button"
      className="button button-secondary"
      disabled={disabled || !project.trim()}
      onClick={() => onPlan()}
    >
      <Icon name="scan" />
      {busy ? "Reviewing project…" : plan ? "Refresh test setup" : "Review test setup"}
    </Button>
  );
  return (
    <section className="stack" aria-labelledby="redteam-heading">
      {!hasResults ? (
        <div className="section-heading view-section-intro">
          <div>
            <h2 id="redteam-heading">Security tests</h2>
            <p className="muted">
              Review observed weaknesses, test coverage, and the next steps to take.
            </p>
          </div>
          {reviewButton}
        </div>
      ) : (
        <h2 id="redteam-heading" className="sr-only">
          Security test results
        </h2>
      )}

      {error && (
        <div className="status-banner error-banner plan-callout" role="alert">
          <span className="callout-icon">
            <Icon name="findings" />
          </span>
          <div className="callout-body">
            <h3>Could not review this project</h3>
            <p>{error}</p>
            <p>Check the selected folder, then retry the review.</p>
          </div>
        </div>
      )}
      {busy && (
        <p className="muted" role="status">
          Inspecting the selected project and preparing its source review…
        </p>
      )}
      {!plan && !busy && (
        <EmptyState
          className="panel empty-state"
          icon="redteam"
          iconClassName="empty-state-symbol"
          title="Start with a project review"
          titleLevel="h3"
          description="Choose a project folder, then select Review test setup to see the entry points Plenger can prepare."
        />
      )}
      {plan && (
        <>
          <RedteamRunner
            key={plan.root}
            plan={plan}
            runs={runs}
            campaigns={campaigns}
            profile={profile}
            providers={providers}
            disabled={disabled}
            onCampaignUpdate={onCampaignUpdate}
          />
          <details
            className="redteam-preparation"
            open={!hasResults}
            key={`${plan.root}-${!hasResults ? "first" : "results"}`}
          >
            <SectionSummary
              icon="checklist"
              title="Test setup and supported targets"
              description="Preparation summary, discovered targets, source coverage and dependencies."
              meta={`${plan.targets.length} ${plan.targets.length === 1 ? "target" : "targets"}`}
            />
            <div className="stack">
              {runs.length > 0 && (
                <div className="section-heading">
                  <div>
                    <h3>Source preparation</h3>
                    <p className="muted">Review the current project before starting a new test.</p>
                  </div>
                  {reviewButton}
                </div>
              )}
              <ReadinessCard plan={plan} />
              <TargetList plan={plan} disabled={disabled} onPlan={onPlan} />
              <div className="inventory-grid plan-detail-grid">
                <SourceCoverage plan={plan} />
                <DependencyReview plan={plan} />
              </div>
              <PendingChecklist plan={plan} />
              <TechnicalDisclosure
                className="panel snapshot-details"
                title="Source snapshot identity"
              >
                <p className="muted">
                  This digest covers captured runtime source and reviewed manifests. It does not
                  cover undiscovered project resources.
                </p>
                <code className="digest">{plan.sourceDigest}</code>
                <p className="muted">
                  Capture policy: {plan.sources.policy} · Project resources:{" "}
                  {plan.sources.resources} · Execution ready: {String(plan.executionReady)}
                </p>
              </TechnicalDisclosure>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

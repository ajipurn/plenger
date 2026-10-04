import { useId, useState } from "react";
import type { CampaignReport } from "../../../src/redteam/campaign.ts";
import { compareCampaigns } from "../../../src/redteam/comparison.ts";
import { downloadJson } from "../shared/download.ts";
import { formatDateTime, percent as formatPercent } from "../shared/format.ts";
import { Icon } from "../shared/icons.tsx";
import { useElementScrollbars } from "../shared/ScrollArea.tsx";
import { Button, Input, Select } from "../shared/ui.tsx";

const percent = (value: number | null) =>
  value === null ? "Not established" : formatPercent(value);
const delta = (value: number | null) =>
  value === null ? "Not qualified" : `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)} pp`;

export function CampaignComparison({
  after,
  campaigns,
}: {
  after: CampaignReport;
  campaigns: CampaignReport[];
}) {
  const id = useId();
  const [beforeId, setBeforeId] = useState("");
  const [change, setChange] = useState("");
  const scrollbars = useElementScrollbars<HTMLDivElement>("x");
  const candidates = campaigns.filter((item) => item.id !== after.id && item.finishedAt);
  const before = candidates.find((item) => item.id === beforeId);
  const comparison = before && change.trim() ? compareCampaigns(before, after, change) : null;
  function download() {
    if (!comparison) return;
    downloadJson(`plenger-comparison-${before?.id}-${after.id}.json`, comparison);
  }
  if (!candidates.length || !after.finishedAt) return null;
  return (
    <details className="panel campaign-comparison">
      <summary className="disclosure-heading">
        Compare with a previous test <Icon name="chevron" />
      </summary>
      <div className="technical-content">
        <p className="muted">
          Choose an explicit before campaign and describe your change. Cases, model settings, scope
          and runtime must match; each attack needs at least 20 usable trials in each build.
        </p>
        <div className="campaign-comparison-form">
          <label htmlFor={`${id}-before`}>
            Before campaign
            <Select
              id={`${id}-before`}
              value={beforeId}
              onValueChange={setBeforeId}
              items={[
                { value: "", label: "Choose a previous test" },
                ...candidates.map((item) => ({
                  value: item.id,
                  label: `${item.plan.model} · ${item.plan.repetitions} repetitions · ${formatDateTime(item.createdAt, "locale")}`,
                })),
              ]}
            />
          </label>
          <label htmlFor={`${id}-change`}>
            Intended change
            <Input
              id={`${id}-change`}
              value={change}
              onChange={(event) =>
                setChange(
                  Array.from(event.target.value)
                    .map((character) => (character.charCodeAt(0) < 32 ? " " : character))
                    .join(""),
                )
              }
              maxLength={1000}
              placeholder="For example, require approval before a price override"
            />
          </label>
        </div>
        {comparison && (
          <>
            <p role="status" className="run-context-note">
              <strong>
                {comparison.eligible ? "Comparison requirements met" : "Comparison not qualified"}.
              </strong>{" "}
              {comparison.eligible
                ? "The differences below are descriptive; they do not establish statistical significance or application safety."
                : "Review the differences in configuration and missing evidence below. A smoke result cannot establish that a mitigation worked."}
            </p>
            {comparison.reasons.length > 0 && (
              <ul>
                {comparison.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
            {comparison.changes.length > 0 && (
              <p className="muted">{comparison.changes.join(" ")}</p>
            )}
            <div className="campaign-table" ref={scrollbars}>
              <table>
                <caption>Model attack results before and after</caption>
                <thead>
                  <tr>
                    <th scope="col">Attack</th>
                    <th scope="col">Before</th>
                    <th scope="col">After</th>
                    <th scope="col">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.cases.map((item) => (
                    <tr key={item.caseId}>
                      <th scope="row">
                        {after.plan.cases.find((c) => c.id === item.caseId)?.title ?? item.caseId}
                      </th>
                      {[item.before, item.after].map((stats, index) => (
                        <td key={index === 0 ? "before" : "after"}>
                          {percent(stats?.rate ?? null)}
                          <span className="campaign-cell-note">
                            {stats?.evaluable ?? 0} / {stats?.planned ?? 0} usable tests
                          </span>
                          {stats?.interval && (
                            <span className="campaign-cell-note">
                              95%: {percent(stats.interval.low)}–{percent(stats.interval.high)}
                            </span>
                          )}
                        </td>
                      ))}
                      <td>{delta(item.rateChange)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              Normal task completion: {comparison.taskCompletion.before.passed}/
              {comparison.taskCompletion.before.planned} before →{" "}
              {comparison.taskCompletion.after.passed}/{comparison.taskCompletion.after.planned}{" "}
              after. Change: {delta(comparison.taskCompletion.change)}.
            </p>
            <p className="muted">
              {comparison.taskCompletion.before.missing} before and{" "}
              {comparison.taskCompletion.after.missing} after tasks lack completion evidence.
              Refusing every task can reduce attack success while also breaking legitimate use.
            </p>
            <p className="muted">
              The after campaign keeps its own finding and coverage gates. Comparing with a previous
              finding never suppresses it.
            </p>
            <p className="muted">{comparison.assumptions.join(" ")}</p>
            <Button className="button button-secondary" onClick={download}>
              <Icon name="download" />
              Export comparison
            </Button>
          </>
        )}
      </div>
    </details>
  );
}

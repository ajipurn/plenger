import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";
import {
  type DismissalBasis,
  type FindingStatus,
  findingOrigins,
  findingValidation,
  type ReviewPath,
  type SecurityFinding,
  type SecurityScanSummary,
} from "../../../src/dashboard/contract.ts";
import { SEVERITIES } from "../../../src/rules/model.ts";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { Button } from "../shared/ui.tsx";

export const statusLabel: Record<FindingStatus, string> = {
  new: "New",
  triaged: "Triaged",
  "in-progress": "In progress",
  resolved: "Resolved",
  dismissed: "Dismissed",
};
export const validationLabel = {
  "source-supported": "Source-supported",
  "needs-review": "Needs review",
  dismissed: "Dismissed by review",
  unvalidated: "Unvalidated",
} as const;
export function originLabel(finding: SecurityFinding): string {
  return findingOrigins(finding)
    .map((origin) => (origin === "ai" ? "AI review" : "Static rule"))
    .join(" + ");
}
/** Resolved and dismissed findings are closed; every other status is open. */
export function isOpenStatus(status: FindingStatus): boolean {
  return status !== "resolved" && status !== "dismissed";
}
/** What a validation dismissal rests on. */
export const dismissalLabel: Record<DismissalBasis, string> = {
  control: "Control",
  unreachable: "Unreachable",
  contradicted: "Contradicted",
  duplicate: "Duplicate",
};
/** How a review closed a path the static scan traced. */
export const closureLabel: Record<ReviewPath["closure"], string> = {
  finding: "Finding",
  safe: "Safe",
  open: "Open",
  unclosed: "Not closed",
};
export const scanStatusLabel = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
export const phaseLabel = {
  reading: "Reading source",
  discovering: "Threat modeling and discovery",
  validating: "Validating findings",
  finished: "Finished",
};
export function date(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
/** Update only the timer between API polls, and stop ticking as soon as the scan ends. */
export function ScanDuration({ scan }: { scan: SecurityScanSummary }) {
  const [now, setNow] = useState(() => Date.now());
  const running = scan.status === "running";
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const ms = running ? now - new Date(scan.startedAt).getTime() : scan.durationMs;
  const total = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  return (
    <span className="tabular-nums whitespace-nowrap">
      {total >= 60 && (
        <>
          <MorphNumber value={Math.floor(total / 60)} />m{" "}
        </>
      )}
      <MorphNumber value={total < 60 ? total : String(total % 60).padStart(2, "0")} />s
    </span>
  );
}
export function ScanStatus({ scan }: { scan: SecurityScanSummary }) {
  return (
    <span className={`security-status scan-${scan.status}`}>{scanStatusLabel[scan.status]}</span>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="security-empty">
      <h2>{title}</h2>
      <p className="muted">{description}</p>
      {action}
    </div>
  );
}
export function FindingsTable({
  findings,
  names,
  scanId,
  projectId,
}: {
  findings: SecurityFinding[];
  names: Map<string, string>;
  scanId?: string;
  projectId?: string;
}) {
  const context = new URLSearchParams({
    ...(scanId ? { scan: scanId } : {}),
    ...(projectId ? { project: projectId } : {}),
  }).toString();
  return (
    <div className="security-table-scroll">
      <table className="security-table">
        <caption className="sr-only">Security findings</caption>
        <thead>
          <tr>
            <th scope="col" aria-sort="descending">
              Severity <span aria-hidden="true">↓</span>
            </th>
            <th scope="col">Finding</th>
            <th scope="col">Validation</th>
            <th scope="col">Status</th>
            <th scope="col">Detected</th>
          </tr>
        </thead>
        <tbody>
          {findings
            .toSorted((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))
            .map((finding) => (
              <tr key={finding.id}>
                <td>
                  <span className={`badge ${finding.severity}`}>{finding.severity}</span>
                </td>
                <td>
                  <Link
                    className="security-row-link"
                    to={`/findings/${encodeURIComponent(finding.id)}${context ? `?${context}` : ""}`}
                  >
                    {finding.title}
                  </Link>
                  <span className="security-cell-caption">
                    {names.get(finding.repositoryId) ?? "Project"} <span aria-hidden="true">·</span>{" "}
                    {originLabel(finding)}
                  </span>
                </td>
                <td>
                  <span className="security-status">
                    {validationLabel[findingValidation(finding)]}
                  </span>
                </td>
                <td>
                  <span className={`security-status finding-${finding.status}`}>
                    {statusLabel[finding.status]}
                  </span>
                </td>
                <td className="muted security-date">{date(finding.detectedAt)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
export function Pagination({
  page,
  count,
  total,
  onChange,
}: {
  page: number;
  count: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.ceil(total / count);
  return (
    <div className="security-pagination">
      <span className="muted">
        <MorphNumber value={total} /> {total === 1 ? "result" : "results"}
      </span>
      {pages > 1 && (
        <div>
          <Button
            className="button button-secondary"
            disabled={page === 0}
            onClick={() => onChange(page - 1)}
          >
            Previous
          </Button>
          <span>
            <MorphNumber value={page + 1} /> / <MorphNumber value={pages} />
          </span>
          <Button
            className="button button-secondary"
            disabled={page >= pages - 1}
            onClick={() => onChange(page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

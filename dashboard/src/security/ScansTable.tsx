import { Link } from "react-router";
import type { SecurityScanSummary } from "../../../src/dashboard/contract.ts";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { costDescription, usdCounterLabel } from "./ScanBilling.tsx";
import { date, legacyScanLabel, ScanDuration, ScanStatus } from "./ui.tsx";

export function ScansTable({
  scans,
  names,
  projectId,
}: {
  scans: SecurityScanSummary[];
  names: Map<string, string>;
  projectId?: string;
}) {
  return (
    <div className="security-table-scroll">
      <table className="security-table security-scans-table">
        <caption className="sr-only">Security scans</caption>
        <thead>
          <tr>
            <th scope="col">Started ↓</th>
            <th scope="col">Source</th>
            <th scope="col">Duration</th>
            <th scope="col">Tokens used</th>
            <th scope="col">Estimated cost</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {scans.map((scan) => (
            <tr key={scan.id}>
              <td className="security-date">
                <MorphNumber value={date(scan.startedAt)} variant="text" />
              </td>
              <td>
                <Link
                  className="security-row-link"
                  to={`/scans/${encodeURIComponent(scan.id)}${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`}
                >
                  {names.get(scan.repositoryId) ?? "Project"}
                </Link>
                <span className="security-cell-caption">
                  {[legacyScanLabel(scan), scan.revision.commit?.slice(0, 7) ?? "Local files"]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </td>
              <td>
                <ScanDuration scan={scan} />
              </td>
              <td
                className="security-number"
                title={
                  scan.tokensComplete === false
                    ? "Partial token total. Some responses did not report usage."
                    : undefined
                }
              >
                {scan.tokens === null ? (
                  scan.status === "running" ? (
                    "Waiting"
                  ) : (
                    "Unavailable"
                  )
                ) : (
                  <MorphNumber value={scan.tokens} />
                )}
              </td>
              <td title={scan.cost ? costDescription(scan.cost) : undefined}>
                {scan.cost ? (
                  <MorphNumber value={usdCounterLabel(scan.cost.totalUsd)} />
                ) : scan.workflow === "static" ? (
                  "No model usage"
                ) : scan.status === "running" ? (
                  "Waiting"
                ) : (
                  "Unavailable"
                )}
              </td>
              <td>
                <ScanStatus scan={scan} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

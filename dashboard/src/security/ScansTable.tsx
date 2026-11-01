import { Link } from "react-router";
import type { SecurityScanSummary } from "../../../src/dashboard/contract.ts";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import {
  type SortColumns,
  SortHeader,
  type TableSort,
  useTableSort,
} from "../shared/table-sort.tsx";
import { costDescription, usdCounterLabel } from "./ScanBilling.tsx";
import { date, legacyScanLabel, ScanDuration, ScanStatus, scanStatusLabel } from "./ui.tsx";

export type ScanSortKey = "started" | "source" | "duration" | "tokens" | "cost" | "status";
/** Scan columns. A scan that has not finished sorts by the time it has run so far. */
export function scanSortColumns(
  names: Map<string, string>,
): SortColumns<SecurityScanSummary, ScanSortKey> {
  return {
    started: { value: (scan) => Date.parse(scan.startedAt), first: "descending" },
    source: { value: (scan) => names.get(scan.repositoryId) ?? "" },
    duration: {
      value: (scan) =>
        scan.finishedAt ? scan.durationMs : Date.now() - Date.parse(scan.startedAt),
      first: "descending",
    },
    tokens: { value: (scan) => scan.tokens, first: "descending" },
    cost: { value: (scan) => scan.cost?.totalUsd ?? null, first: "descending" },
    status: { value: (scan) => Object.keys(scanStatusLabel).indexOf(scan.status) },
  };
}
export const SCAN_DEFAULT_SORT: TableSort<ScanSortKey> = {
  key: "started",
  direction: "descending",
};

export function ScansTable({
  scans,
  names,
  projectId,
}: {
  scans: SecurityScanSummary[];
  names: Map<string, string>;
  projectId?: string;
}) {
  const { sort, toggle, apply } = useTableSort(scanSortColumns(names), SCAN_DEFAULT_SORT);
  return (
    <div className="security-table-scroll">
      <table className="security-table security-scans-table">
        <caption className="sr-only">Security scans</caption>
        <thead>
          <tr>
            <SortHeader column="started" sort={sort} onSort={toggle}>
              Started
            </SortHeader>
            <SortHeader column="source" sort={sort} onSort={toggle}>
              Source
            </SortHeader>
            <SortHeader column="duration" sort={sort} onSort={toggle}>
              Duration
            </SortHeader>
            <SortHeader column="tokens" sort={sort} onSort={toggle}>
              Tokens used
            </SortHeader>
            <SortHeader column="cost" sort={sort} onSort={toggle}>
              Estimated cost
            </SortHeader>
            <SortHeader column="status" sort={sort} onSort={toggle}>
              Status
            </SortHeader>
          </tr>
        </thead>
        <tbody>
          {apply(scans).map((scan) => (
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

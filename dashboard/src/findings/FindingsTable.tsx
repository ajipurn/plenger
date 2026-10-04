import type { Finding, Rule } from "../../../src/rules/model.ts";
import { Icon } from "../shared/icons.tsx";
import { Button } from "../shared/ui.tsx";
import { FindingTitle } from "./FindingTitle.tsx";

export function FindingsTable({
  findings,
  rules,
  selectedId,
  onOpen,
}: {
  findings: Finding[];
  rules: Rule[];
  /** The finding highlighted while the detail drawer is open. */
  selectedId: string | null;
  onOpen: (finding: Finding, trigger: HTMLButtonElement | null) => void;
}) {
  return (
    <table className="findings-table">
      <caption className="sr-only">
        Source findings. Open a finding to review its evidence and remediation.
      </caption>
      <colgroup>
        <col className="finding-severity-column" />
        <col className="finding-name-column" />
        <col className="finding-source-column" />
        <col className="finding-confidence-column" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">Severity</th>
          <th scope="col">Finding</th>
          <th scope="col">Source</th>
          <th scope="col">Confidence</th>
        </tr>
      </thead>
      <tbody>
        {findings.map((finding) => {
          const matchingRule = rules.find((item) => item.id === finding.rule);
          const filenameStart = finding.location.path.lastIndexOf("/") + 1;
          return (
            <tr
              key={finding.fingerprint}
              className={`finding-table-row ${selectedId === finding.fingerprint ? "is-selected" : ""}`}
              onClick={(event) => {
                onOpen(
                  finding,
                  event.currentTarget.querySelector<HTMLButtonElement>(".finding-open"),
                );
              }}
            >
              <td className="finding-severity-cell">
                <span className={`badge ${finding.severity}`}>{finding.severity}</span>
              </td>
              <td className="finding-name-cell">
                <Button
                  className="finding-open"
                  aria-label={`Review finding: ${finding.title.replaceAll("`", "")}`}
                  aria-haspopup="dialog"
                >
                  <span className="finding-table-title">
                    <FindingTitle title={matchingRule?.title ?? finding.title} />
                  </span>
                  <span className="finding-table-meta">
                    <span>{finding.rule}</span>
                    <span className="finding-subject">{finding.subject.name}</span>
                  </span>
                </Button>
                <span className="finding-mobile-confidence">{finding.confidence} confidence</span>
              </td>
              <td
                className="finding-source-cell"
                title={`${finding.location.path}:${finding.location.line}:${finding.location.column}`}
              >
                <code className="finding-source-file">
                  {finding.location.path.slice(filenameStart)}:{finding.location.line}
                </code>
                <code className="finding-source-directory">
                  {finding.location.path.slice(0, filenameStart) || "Project root"}
                </code>
              </td>
              <td className="finding-confidence-cell">
                <span className="finding-confidence">{finding.confidence}</span>
                <Icon name="chevron" />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

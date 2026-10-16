import type { SecurityFinding } from "../../../src/dashboard/contract.ts";
import { statusLabel } from "./ui.tsx";

/** Each ribbon is calculated from the currently filtered findings. */
export function SeverityFlow({ findings }: { findings: SecurityFinding[] }) {
  if (!findings.length) return null;
  const severities = (["critical", "high", "medium", "low"] as const).filter((severity) =>
    findings.some((item) => item.severity === severity),
  );
  const statuses = (["new", "triaged", "in-progress", "resolved", "dismissed"] as const).filter(
    (status) => findings.some((item) => item.status === status),
  );
  const unit = Math.min(4, 84 / findings.length);
  const middle = severities.map((severity, index) => ({
    severity,
    count: findings.filter((item) => item.severity === severity).length,
    center: ((index + 1) * 260) / (severities.length + 1),
  }));
  const right = statuses.map((status, index) => ({
    status,
    count: findings.filter((item) => item.status === status).length,
    center: ((index + 1) * 260) / (statuses.length + 1),
    used: 0,
  }));
  let leftUsed = 0;
  const ribbon = (x0: number, y0: number, x1: number, y1: number, height: number) =>
    `M${x0},${y0} C${(x0 + x1) / 2},${y0} ${(x0 + x1) / 2},${y1} ${x1},${y1} L${x1},${y1 + height} C${(x0 + x1) / 2},${y1 + height} ${(x0 + x1) / 2},${y0 + height} ${x0},${y0 + height}Z`;
  return (
    <section className="security-flow" aria-label="Severity and status">
      <h2>Severity and status</h2>
      <div className="security-flow-scroll">
        <svg
          viewBox="0 0 1100 280"
          role="img"
          aria-label={`${findings.length} findings grouped by severity and triage status`}
        >
          {middle.map((node) => {
            const y = node.center - (node.count * unit) / 2;
            const leftY = 130 - (findings.length * unit) / 2 + leftUsed;
            leftUsed += node.count * unit;
            let middleUsed = 0;
            return (
              <g key={node.severity}>
                <path
                  d={ribbon(14, leftY, 520, y, node.count * unit)}
                  className={`security-ribbon ribbon-${node.severity}`}
                />
                {right.map((target) => {
                  const count = findings.filter(
                    (item) => item.severity === node.severity && item.status === target.status,
                  ).length;
                  if (!count) return null;
                  const toY = target.center - (target.count * unit) / 2 + target.used;
                  const fromY = y + middleUsed;
                  middleUsed += count * unit;
                  target.used += count * unit;
                  return (
                    <path
                      key={target.status}
                      d={ribbon(522, fromY, 1010, toY, count * unit)}
                      className={`security-ribbon ribbon-${node.severity}`}
                    />
                  );
                })}
                <line
                  x1="520"
                  x2="520"
                  y1={y - 2}
                  y2={y + node.count * unit + 2}
                  className={`security-flow-marker marker-${node.severity}`}
                />
                <text x="528" y={y - 8} className="security-flow-label">
                  {node.severity[0]?.toUpperCase()}
                  {node.severity.slice(1)}
                </text>
                <text x="528" y={y + 12}>
                  {node.count}
                </text>
              </g>
            );
          })}
          <line
            x1="14"
            x2="14"
            y1={130 - (findings.length * unit) / 2}
            y2={130 + (findings.length * unit) / 2}
            className="security-flow-marker"
          />
          <text x="20" y={124 - (findings.length * unit) / 2} className="security-flow-label">
            Findings
          </text>
          <text x="20" y={142 - (findings.length * unit) / 2}>
            {findings.length}
          </text>
          {right.map((node) => (
            <g key={node.status}>
              <line
                x1="1010"
                x2="1010"
                y1={node.center - (node.count * unit) / 2}
                y2={node.center + (node.count * unit) / 2}
                className="security-flow-marker"
              />
              <text x="1018" y={node.center - 6} className="security-flow-label">
                {statusLabel[node.status]}
              </text>
              <text x="1018" y={node.center + 12}>
                {node.count}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </section>
  );
}

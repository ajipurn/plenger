import { useId } from "react";
import { Link } from "react-router";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from "recharts";
import type { DashboardScan, DashboardScanSummary } from "../../src/dashboard/model.ts";
import { SEVERITIES } from "../../src/rules/model.ts";
import { Icon } from "./icons.tsx";
import { MorphNumber } from "./MorphNumber.tsx";

type ScanPoint = DashboardScanSummary & { label: string };
const timestamp = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );

function ScanTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload.length) return null;
  const point = payload[0]?.payload as ScanPoint | undefined;
  if (!point) return null;
  return (
    <div className="overview-chart-tooltip">
      <p>{timestamp(point.createdAt)}</p>
      <strong>{point.findings.toLocaleString()} findings</strong>
      <span>{point.files.toLocaleString()} source files</span>
    </div>
  );
}

function SeverityTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload.length) return null;
  const point = payload[0]?.payload as { name: string; count: number } | undefined;
  if (!point) return null;
  return (
    <div className="overview-chart-tooltip">
      <p>{point.name} severity</p>
      <strong>{point.count.toLocaleString()} findings</strong>
    </div>
  );
}

export default function OverviewCharts({
  report,
  history,
}: {
  report: DashboardScan;
  history: DashboardScanSummary[];
}) {
  const gradientId = `scan-trend-${useId().replaceAll(":", "")}`;
  const current: DashboardScanSummary = {
    id: report.id,
    createdAt: report.createdAt,
    project: report.scan.root,
    findings: report.scan.findings.length,
    files: report.scan.files.length,
  };
  const trend: ScanPoint[] = [
    ...new Map(
      [...history.filter((item) => item.project === current.project), current].map((item) => [
        item.id,
        item,
      ]),
    ).values(),
  ]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .slice(-12)
    .map((item, index) => ({ ...item, label: `Scan ${index + 1}` }));
  const severity = SEVERITIES.map((level) => ({
    name: level.charAt(0).toUpperCase() + level.slice(1),
    count: report.scan.findings.filter((finding) => finding.severity === level).length,
    color: `var(--${level === "low" ? "muted" : level})`,
  }));
  const highImpact = (severity[0]?.count ?? 0) + (severity[1]?.count ?? 0);
  const maxFindings = Math.max(1, ...trend.map((item) => item.findings));

  return (
    <div className="overview-chart-grid">
      <section className="panel overview-chart-panel" aria-labelledby="scan-trend-heading">
        <div className="overview-chart-heading">
          <div>
            <p className="eyebrow">Scan activity</p>
            <h2 id="scan-trend-heading">Findings over scans</h2>
            <p className="muted">
              {trend.length === 1
                ? "Your first saved snapshot for this project."
                : `Last ${trend.length} saved snapshots for this project.`}
            </p>
          </div>
          <Link className="text-link" to="/history">
            History <Icon name="chevron" />
          </Link>
        </div>
        <div className="overview-chart-canvas">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <AreaChart
              data={trend}
              margin={{ top: 12, right: 16, bottom: 0, left: 0 }}
              accessibilityLayer
            >
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--navigation-accent)" stopOpacity={0.22} />
                  <stop offset="100%" stopColor="var(--navigation-accent)" stopOpacity={0.015} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--line)" strokeDasharray="3 5" vertical={false} />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{ fill: "var(--muted)", fontSize: 11 }}
                tickMargin={12}
                interval="preserveStartEnd"
              />
              <YAxis
                allowDecimals={false}
                domain={[0, Math.ceil(maxFindings * 1.15)]}
                axisLine={false}
                tickLine={false}
                tick={{ fill: "var(--muted)", fontSize: 11 }}
                width={36}
                tickMargin={8}
              />
              <Tooltip
                content={ScanTooltip}
                cursor={{ stroke: "var(--line-strong)", strokeDasharray: "3 5" }}
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="findings"
                name="Findings"
                stroke="var(--navigation-accent)"
                strokeWidth={2}
                fill={`url(#${gradientId})`}
                isAnimationActive={false}
                dot={{ r: 3, fill: "var(--surface)", strokeWidth: 2 }}
                activeDot={{
                  r: 5,
                  fill: "var(--navigation-accent)",
                  stroke: "var(--surface)",
                  strokeWidth: 3,
                }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="overview-chart-footnote">
          <span className="overview-series-dot" />
          <span>
            {trend.length === 1
              ? "Run another scan to compare snapshots."
              : "Finding counts per snapshot. Scan scope and rules may differ."}
          </span>
        </div>
        <table className="sr-only">
          <caption>Saved scans for the selected project</caption>
          <thead>
            <tr>
              <th>Captured</th>
              <th>Findings</th>
              <th>Source files</th>
            </tr>
          </thead>
          <tbody>
            {trend.map((item) => (
              <tr key={item.id}>
                <td>{timestamp(item.createdAt)}</td>
                <td>{item.findings}</td>
                <td>{item.files}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel overview-chart-panel" aria-labelledby="severity-chart-heading">
        <div className="overview-chart-heading">
          <div>
            <p className="eyebrow">Review priorities</p>
            <h2 id="severity-chart-heading">Findings by severity</h2>
            <p className="muted">Distribution in the selected snapshot.</p>
          </div>
        </div>
        <div className="overview-chart-canvas">
          {report.scan.findings.length === 0 ? (
            <div className="overview-empty-severity">
              {severity.map((item) => (
                <div key={item.name}>
                  <span>{item.name}</span>
                  <span className="overview-empty-track" aria-hidden="true" />
                  <strong>0</strong>
                </div>
              ))}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart
                data={severity}
                layout="vertical"
                margin={{ top: 8, right: 32, bottom: 8, left: 0 }}
                accessibilityLayer
              >
                <XAxis
                  type="number"
                  hide
                  domain={[0, Math.max(1, ...severity.map((item) => item.count))]}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={64}
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "var(--muted)", fontSize: 12 }}
                />
                <Tooltip content={SeverityTooltip} cursor={false} isAnimationActive={false} />
                <Bar
                  dataKey="count"
                  name="Findings"
                  barSize={10}
                  radius={[0, 5, 5, 0]}
                  background={{ fill: "var(--paper)", radius: 5 }}
                  isAnimationActive={false}
                >
                  {severity.map((item) => (
                    <Cell key={item.name} fill={item.color} />
                  ))}
                  <LabelList dataKey="count" position="right" fill="var(--ink)" fontSize={12} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="overview-chart-footnote">
          <strong>
            <MorphNumber value={highImpact} />
          </strong>
          <span>critical or high severity findings to review</span>
        </div>
        <table className="sr-only">
          <caption>Findings by severity in the selected snapshot</caption>
          <thead>
            <tr>
              <th>Severity</th>
              <th>Findings</th>
            </tr>
          </thead>
          <tbody>
            {severity.map((item) => (
              <tr key={item.name}>
                <td>{item.name}</td>
                <td>{item.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

import { useId, useState } from "react";
import { SCAN_DEPTHS, type SecurityScan } from "../../../src/dashboard/contract.ts";
import { Icon } from "../shared/icons.tsx";
import { Button } from "../shared/ui.tsx";
import { phaseLabel } from "./ui.tsx";

const SCAN_STEPS = [
  {
    phase: "reading",
    title: "Read source",
    description: "Reading local files and preparing the static scan.",
  },
  {
    phase: "discovering",
    title: "Review code",
    description: "Mapping architecture, assessing STRIDE threats, and discovering findings.",
  },
  {
    phase: "validating",
    title: "Validate findings",
    description: "Checking candidates against the source, callers, and existing safeguards.",
  },
] as const;

/** State indication for a running scan, with motion confined to a decorative illustration. */
export function ScanProgress({ scan, cancelling }: { scan: SecurityScan; cancelling: boolean }) {
  const [paused, setPaused] = useState(false);
  const current = SCAN_STEPS.findIndex((step) => step.phase === scan.phase);
  const batch = Math.min(scan.reviews.length + 1, SCAN_DEPTHS[scan.depth].batches);
  return (
    <section
      className="security-scan-progress"
      aria-label="Scan progress"
      data-phase={scan.phase}
      data-animation-paused={paused || cancelling}
    >
      <div className="security-scan-progress-heading">
        <ScanIllustration />
        <div className="security-scan-progress-copy" role="status">
          <p className="security-scan-progress-kicker">
            <span>{SCAN_DEPTHS[scan.depth].label} scan</span>
            <span aria-hidden="true">·</span>
            <span>
              {scan.mode === "explore" ? `Exploring review ${batch}` : `Source batch ${batch}`}
            </span>
          </p>
          <h2>{cancelling ? "Cancelling scan" : phaseLabel[scan.phase]}</h2>
          <p className="muted">
            {cancelling
              ? "Waiting for the current request to stop. Completed static results remain available."
              : SCAN_STEPS[current]?.description}
          </p>
        </div>
      </div>
      <ol className="security-scan-steps" aria-label="Analysis stages">
        {SCAN_STEPS.map((step, index) => (
          <li
            key={step.phase}
            data-state={index < current ? "complete" : index === current ? "current" : "pending"}
            aria-current={index === current ? "step" : undefined}
          >
            <span className="security-scan-step-number" aria-hidden="true">
              {index < current ? <Icon name="check" /> : index + 1}
            </span>
            <span>
              {step.title}
              <small>
                {index < current
                  ? "Complete"
                  : index === current
                    ? cancelling
                      ? "Stopping…"
                      : "In progress"
                    : "Pending"}
              </small>
            </span>
          </li>
        ))}
      </ol>
      {scan.activity?.length ? (
        <div className="security-scan-activity">
          <h3>Activity</h3>
          <ol aria-label="Recent scan activity">
            {scan.activity
              .slice(-12)
              .reverse()
              .map((entry) => (
                <li key={`${entry.at}-${entry.detail}`} data-kind={entry.kind}>
                  <time dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString()}</time>
                  <span>
                    {scan.mode === "explore" ? "Review" : "Batch"} {entry.batch + 1} ·{" "}
                    {entry.detail}
                  </span>
                  <span className="muted">{entry.tokens.toLocaleString()} tokens</span>
                </li>
              ))}
          </ol>
        </div>
      ) : null}
      <div className="security-scan-progress-footer">
        <p className="security-scan-progress-note">
          <Icon name="info" /> You can leave this page. The scan continues in the local service.
        </p>
        {!cancelling && (
          <Button
            className="button button-quiet security-scan-animation-toggle"
            onClick={() => setPaused((value) => !value)}
          >
            {paused ? "Resume animation" : "Pause animation"}
          </Button>
        )}
      </div>
    </section>
  );
}

function ScanIllustration() {
  const id = useId();
  return (
    <svg
      className="security-scan-illustration"
      viewBox="0 0 220 180"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <pattern id={`${id}-grid`} width="12" height="12" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.7" fill="currentColor" />
        </pattern>
        <linearGradient id={`${id}-beam`} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="currentColor" stopOpacity="0" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.12" />
        </linearGradient>
        <clipPath id={`${id}-source`}>
          <rect x="36" y="65" width="96" height="77" rx="3" />
        </clipPath>
      </defs>
      <rect
        x="6"
        y="8"
        width="208"
        height="164"
        rx="24"
        fill={`url(#${id}-grid)`}
        className="scan-art-grid"
      />
      <rect
        x="47"
        y="29"
        width="88"
        height="120"
        rx="10"
        transform="rotate(-8 91 89)"
        className="scan-art-back-page"
      />
      <path
        d="M132 91h18a8 8 0 0 0 8-8V62h22M132 111h18a8 8 0 0 1 8 8v22h22"
        className="scan-art-connection"
      />
      <circle cx="134" cy="91" r="2.5" className="scan-art-packet" />
      <g transform="translate(0 202) scale(1 -1)">
        <circle cx="134" cy="91" r="2.5" className="scan-art-packet scan-art-packet-bottom" />
      </g>
      <rect x="173" y="47" width="30" height="30" rx="9" className="scan-art-node" />
      <path d="M183 59h10m-10 6h6" className="scan-art-node-lines" />
      <rect x="175" y="128" width="26" height="26" rx="8" className="scan-art-node" />
      <circle cx="184" cy="141" r="1.5" fill="currentColor" />
      <circle cx="192" cy="141" r="1.5" fill="currentColor" />
      <rect x="35" y="42" width="98" height="112" rx="10" className="scan-art-page" />
      <path d="M35 65h98" className="scan-art-connection" />
      <g className="scan-art-page-dots" fill="currentColor">
        <circle cx="47" cy="54" r="1.5" />
        <circle cx="53" cy="54" r="1.5" />
        <circle cx="59" cy="54" r="1.5" />
      </g>
      <g className="scan-art-code" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
        <path d="M48 79h16m7 0h26" />
        <path d="M56 90h25m7 0h29" />
        <path d="M56 101h17m7 0h22" />
        <path d="M56 112h36m7 0h18" />
        <path d="M48 123h14m7 0h20" />
        <path d="M48 134h30" />
      </g>
      <g clipPath={`url(#${id}-source)`}>
        <g className="scan-art-beam">
          <rect x="36" y="65" width="96" height="26" fill={`url(#${id}-beam)`} />
          <path d="M36 91h96" stroke="currentColor" strokeOpacity="0.65" />
        </g>
      </g>
      <circle cx="162" cy="104" r="31" className="scan-art-halo" />
      <circle cx="162" cy="104" r="25" className="scan-art-badge" />
      <path d="m162 86 14 5v12c0 10-14 18-14 18s-14-8-14-18V91l14-5Z" className="scan-art-shield" />
      <g className="scan-art-glyph scan-art-glyph-reading">
        <path d="m159 98-5 5 5 5m6-10 5 5-5 5" />
      </g>
      <g className="scan-art-glyph scan-art-glyph-discovering">
        <circle cx="160" cy="101" r="5" />
        <path d="m164 105 5 5" />
      </g>
      <g className="scan-art-glyph scan-art-glyph-validating">
        <path d="m155 103 5 5 9-10" />
      </g>
    </svg>
  );
}

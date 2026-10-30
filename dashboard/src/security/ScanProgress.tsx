import { useId, useState } from "react";
import {
  SCAN_DEPTHS,
  type ScanActivity,
  type SecurityScan,
} from "../../../src/dashboard/contract.ts";
import { Icon } from "../shared/icons.tsx";
import { MorphNumber, NumericText } from "../shared/MorphNumber.tsx";
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
/** Latest steps listed under the active stage; the saved timeline keeps more. */
const RECENT_ACTIVITY = 6;

/** A running scan's stages on a timeline, with its latest steps under the active stage. */
export function ScanProgress({ scan, cancelling }: { scan: SecurityScan; cancelling: boolean }) {
  const steps = scan.workflow === "static" ? SCAN_STEPS.slice(0, 1) : SCAN_STEPS;
  const current =
    scan.phase === "finished" ? steps.length : steps.findIndex((step) => step.phase === scan.phase);
  const round = Math.min(scan.reviews.length + 1, SCAN_DEPTHS[scan.depth].batches);
  const activity = scan.activity ?? [];
  const latest = activity.at(-1);
  // Motion marks steps that arrive while the page is open, not the history it opened with.
  const [openedAt] = useState(() => latest?.at ?? "");
  const arrived = (entry: ScanActivity) => entry.at > openedAt;
  return (
    <section
      className="security-scan-progress"
      aria-label="Scan progress"
      data-phase={scan.phase}
      data-cancelling={cancelling}
    >
      <div className="security-scan-progress-heading">
        <ScanIllustration
          step={
            !cancelling && latest && arrived(latest) ? `${latest.at}-${latest.detail}` : undefined
          }
        />
        <div className="security-scan-progress-copy" role="status">
          <p className="security-scan-progress-kicker">
            <span>
              {scan.workflow === "static" ? "Static scan" : `${SCAN_DEPTHS[scan.depth].label} scan`}
            </span>
            {scan.workflow !== "static" && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  Round <MorphNumber value={round} />
                </span>
              </>
            )}
          </p>
          <h2>{cancelling ? "Cancelling scan" : phaseLabel[scan.phase]}</h2>
        </div>
        {latest && (
          <p className="security-scan-progress-tokens">
            <MorphNumber value={latest.tokens} /> tokens
          </p>
        )}
      </div>
      <ol className="security-scan-steps" aria-label="Analysis stages">
        {steps.map((step, index) => {
          const state = index < current ? "complete" : index === current ? "current" : "pending";
          return (
            <li
              key={step.phase}
              data-state={state}
              aria-current={state === "current" ? "step" : undefined}
            >
              <span className="security-scan-step-number" aria-hidden="true">
                {state === "complete" ? <Icon name="check" /> : <MorphNumber value={index + 1} />}
              </span>
              <div className="security-scan-step-body">
                <p className="security-scan-step-title">
                  {step.phase === "reading" && scan.parentScanId ? "Load saved source" : step.title}
                  <small>
                    {state === "complete"
                      ? "Complete"
                      : state === "pending"
                        ? "Pending"
                        : cancelling
                          ? "Stopping…"
                          : "In progress"}
                  </small>
                </p>
                {state === "current" && (
                  <p className="muted">
                    {cancelling
                      ? "Waiting for the current request to stop. Completed static results remain available."
                      : step.phase === "reading" && scan.parentScanId
                        ? "Loading the saved static result and preparing source for AI review."
                        : step.description}
                  </p>
                )}
                {index === Math.min(current, steps.length - 1) && activity.length > 0 && (
                  <ol className="security-scan-activity" aria-label="Recent scan activity">
                    {activity
                      .slice(-RECENT_ACTIVITY)
                      .reverse()
                      .map((entry) => (
                        <li
                          key={`${entry.at}-${entry.detail}`}
                          data-kind={entry.kind}
                          data-arrived={arrived(entry) || undefined}
                        >
                          <time dateTime={entry.at}>
                            <MorphNumber
                              value={new Date(entry.at).toLocaleTimeString()}
                              variant="text"
                            />
                          </time>
                          <span>
                            <span className="muted">
                              Round <MorphNumber value={entry.batch + 1} /> ·
                            </span>{" "}
                            <NumericText>{entry.detail}</NumericText>
                          </span>
                        </li>
                      ))}
                  </ol>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="security-scan-progress-note">
        <Icon name="info" /> You can leave this page. The scan continues in the local service.
      </p>
    </section>
  );
}

/**
 * Source and shield art: the active phase loops while the scan works, and a ring leaves the
 * shield once for each step that arrives while the page is open.
 */
function ScanIllustration({ step }: { step: string | undefined }) {
  const id = useId();
  return (
    <svg
      className="security-scan-illustration"
      viewBox="0 0 220 180"
      fill="none"
      aria-hidden="true"
      focusable="false"
      data-step={step ? "" : undefined}
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
      {/* A new key remounts the ring, which restarts its one-shot animation. */}
      <circle key={step} cx="162" cy="104" r="31" className="scan-art-ping" />
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

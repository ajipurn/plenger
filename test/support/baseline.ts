import type { Baseline } from "../../src/report/policy.ts";
import type { Finding } from "../../src/rules/index.ts";

/** A baseline file that records every given finding as reviewed. */
export function baselineOf(findings: Finding[]): Baseline {
  return {
    schemaVersion: 1,
    findings: findings
      .map(({ fingerprint, rule, location }) => ({ fingerprint, rule, path: location.path }))
      .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
  };
}

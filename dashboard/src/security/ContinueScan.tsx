import { useId, useState } from "react";
import {
  remainingBudget,
  SCAN_BUDGET_LIMITS,
  type SecurityScan,
} from "../../../src/dashboard/contract.ts";
import { useApi } from "../app/DashboardContext.tsx";
import { errorMessage } from "../shared/async.ts";
import { Icon } from "../shared/icons.tsx";
import { NumericText } from "../shared/MorphNumber.tsx";
import { Button, Input } from "../shared/ui.tsx";
import { RUNNING_SCAN_REASON } from "./running-scan.ts";

/**
 * Continues a Full coverage scan that paused or stopped at its limit, under a new limit for
 * what it spends from now on. Later rounds skip files already sent whole. A paused scan
 * starts from what is left of its limit, and one that had no limit continues without one.
 * The scan header continues a paused scan as it is, so here a paused scan only offers
 * another limit, when it has one.
 */
export function ContinueScan({
  scan,
  disabled,
  onContinued,
}: {
  scan: SecurityScan;
  disabled: boolean;
  onContinued: (scan: SecurityScan) => Promise<void>;
}) {
  const api = useApi();
  const id = useId();
  const paused = scan.status === "paused";
  const left = paused ? remainingBudget(scan) : null;
  const limited = !paused || left !== null;
  const start = paused ? left : (scan.budget ?? null);
  const kind = start?.kind ?? "tokens";
  const [value, setValue] = useState(() =>
    start?.kind === "usd"
      ? start.usd.toFixed(2)
      : String(start?.kind === "tokens" ? start.tokens : SCAN_BUDGET_LIMITS.defaultTokens),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const amount = Number(value);
  const valid =
    Number.isFinite(amount) &&
    (kind === "tokens"
      ? Number.isSafeInteger(amount) &&
        amount >= SCAN_BUDGET_LIMITS.minTokens &&
        amount <= SCAN_BUDGET_LIMITS.maxTokens
      : amount >= SCAN_BUDGET_LIMITS.minUsd && amount <= SCAN_BUDGET_LIMITS.maxUsd);
  async function submit() {
    if (!api || !valid) return;
    setBusy(true);
    setError("");
    try {
      const next = await api.continueSecurityScan(
        scan.id,
        kind === "tokens"
          ? { kind: "tokens", tokens: amount }
          : { kind: "usd", usd: Math.round(amount * 100) / 100 },
      );
      await onContinued(next);
    } catch (failure) {
      setError(errorMessage(failure, "Unable to continue this scan."));
    } finally {
      setBusy(false);
    }
  }
  const covered = scan.coverage
    ? `${scan.coverage.sentFiles} of ${scan.coverage.eligibleFiles} files covered`
    : "";
  return (
    <section className="security-continue-scan" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>{paused ? "Scan paused" : "Continue this scan"}</h2>
      <p className="muted">
        <NumericText>
          {paused
            ? `The scan is paused${covered ? ` with ${covered}` : ""}; the round that was running starts again.${scan.error ? ` ${scan.error}` : ""}`
            : scan.status === "failed"
              ? `A later round failed${covered ? ` with ${covered}` : ""}; the rounds before it stand.`
              : `The scan stopped at its limit${covered ? ` with ${covered}` : ""}.`}
        </NumericText>{" "}
        {!limited
          ? "Continuing runs the remaining rounds with no limit, as before; files already sent whole are skipped."
          : paused
            ? "Continuing runs the remaining rounds under the limit below, set to what is left; files already sent whole are skipped."
            : "Continuing runs more rounds under a new limit for what it spends from now on; files already sent whole are skipped."}
        <NumericText>
          {scan.continuations?.length
            ? ` It has continued ${scan.continuations.length} ${scan.continuations.length === 1 ? "time" : "times"}.`
            : ""}
        </NumericText>
      </p>
      {limited && (
        <form
          className="security-continue-scan-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor={`${id}-limit`}>{paused ? "Limit" : "New limit"}</label>
          <div className="security-scan-limit-input">
            <Input
              id={`${id}-limit`}
              type="number"
              inputMode={kind === "tokens" ? "numeric" : "decimal"}
              step={kind === "tokens" ? 1000 : 0.01}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-invalid={!valid}
              disabled={busy || disabled}
            />
            <span className="security-scan-limit-unit" aria-hidden="true">
              {kind === "tokens" ? "tokens" : "USD"}
            </span>
          </div>
          <Button
            className={paused ? "button button-secondary" : "button button-primary"}
            type="submit"
            {...(disabled ? { title: RUNNING_SCAN_REASON } : {})}
            disabled={busy || disabled || !valid}
          >
            <Icon name="play" />{" "}
            {busy ? "Continuing…" : paused ? "Continue with this limit" : "Continue scan"}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="error-message">
          <NumericText>{error}</NumericText>
        </p>
      )}
    </section>
  );
}

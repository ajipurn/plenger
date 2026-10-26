import { useId, useState } from "react";
import { SCAN_BUDGET_LIMITS, type SecurityScan } from "../../../src/dashboard/contract.ts";
import { useApi } from "../app/DashboardContext.tsx";
import { errorMessage } from "../shared/async.ts";
import { Button, Input } from "../shared/ui.tsx";

/**
 * Continues a Full coverage scan that stopped at its limit, under a new limit for what it
 * spends from now on. Later rounds skip files already sent whole.
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
  const kind = scan.budget?.kind ?? "tokens";
  const [value, setValue] = useState(() =>
    scan.budget?.kind === "usd"
      ? scan.budget.usd.toFixed(2)
      : String(
          scan.budget?.kind === "tokens" ? scan.budget.tokens : SCAN_BUDGET_LIMITS.defaultTokens,
        ),
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
      <h2 id={`${id}-heading`}>Continue this scan</h2>
      <p className="muted">
        {scan.status === "failed"
          ? `A later round failed${covered ? ` with ${covered}` : ""}; the rounds before it stand.`
          : `The scan stopped at its limit${covered ? ` with ${covered}` : ""}.`}{" "}
        Continuing runs more rounds under a new limit for what it spends from now on; files already
        sent whole are skipped.
        {scan.continuations?.length
          ? ` It has continued ${scan.continuations.length} ${scan.continuations.length === 1 ? "time" : "times"}.`
          : ""}
      </p>
      <form
        className="security-continue-scan-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label htmlFor={`${id}-limit`}>New limit</label>
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
          className="button button-primary"
          type="submit"
          disabled={busy || disabled || !valid}
        >
          {busy ? "Continuing…" : "Continue scan"}
        </Button>
      </form>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
    </section>
  );
}

import type { SecurityReview } from "../../../src/dashboard/contract.ts";
import {
  BILLING_PRICE_FIELDS,
  type CostSummary,
  tokenCost,
} from "../../../src/redteam/model-pricing.ts";
import { Icon } from "../shared/icons.tsx";
import { MorphNumber, NumericText } from "../shared/MorphNumber.tsx";

export function costLabel(cost: CostSummary | null | undefined): string {
  return cost ? usdLabel(cost.totalUsd) : "Unavailable";
}

export function usdLabel(totalUsd: number, minimumFractionDigits = 2): string {
  return totalUsd > 0 && totalUsd < 0.000001
    ? "< $0.000001"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits,
        maximumFractionDigits: 6,
      }).format(totalUsd);
}

/** Keep decimal places aligned as the cost changes. */
export function usdCounterLabel(totalUsd: number): string {
  return usdLabel(totalUsd, 6);
}

export function costDescription(cost: CostSummary | null | undefined): string {
  const basis =
    cost?.basis === "api-equivalent"
      ? "USD · Standard OpenAI API rates. Subscription billing and quota are separate."
      : cost?.basis === "mixed"
        ? "USD · API rates applied to reported usage. Subscription billing and quota are separate."
        : "USD · Prices captured when the scan started.";
  return cost?.complete === false
    ? `${basis} Partial estimate. Some usage could not be priced.`
    : basis;
}
const labels = {
  input: "Input (uncached)",
  output: "Output",
  cacheWrite5m: "Cache write · 5 minutes",
  cacheWrite1h: "Cache write · 1 hour",
  cacheRead: "Cache hits and refreshes",
  cacheWrite: "Cache write · Default lifetime",
};

export function ScanBilling({ reviews }: { reviews: SecurityReview[] }) {
  if (!reviews.some((review) => review.request.billing || review.request.validatorBilling))
    return null;
  return (
    <details className="security-billing">
      <summary>
        <Icon name="chevron" />
        <span>Token usage and cost details</span>
      </summary>
      <div className="security-billing-body">
        <p className="muted">
          USD estimates use the prices captured when this scan started. They are not an invoice and
          exclude taxes, discounts and other service charges. Incomplete usage is never assumed to
          be zero.
        </p>
        {reviews.some(
          (review) =>
            review.request.billing?.basis === "api-equivalent" ||
            review.request.validatorBilling?.basis === "api-equivalent",
        ) && (
          <p className="muted">
            Subscription estimates use standard OpenAI API prices for the reported tokens.
            Subscription billing and quota are separate.
          </p>
        )}
        {reviews.map((review, index) => (
          <div key={review.id}>
            {review.request.billing && (
              <BillingSection
                id={`${review.id}-discovery`}
                title={`Round ${index + 1} · discovery · ${review.provider.model}`}
                billing={review.request.billing}
              />
            )}
            {review.validator && review.request.validatorBilling && (
              <BillingSection
                id={`${review.id}-validator`}
                title={`Round ${index + 1} · validation · ${review.validator.model}`}
                billing={review.request.validatorBilling}
              />
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

function BillingSection({
  id,
  title,
  billing,
}: {
  id: string;
  title: string;
  billing: NonNullable<SecurityReview["request"]["billing"]>;
}) {
  return (
    <section>
      <h3>
        <NumericText>{title}</NumericText>
      </h3>
      <p className="muted">
        <NumericText>
          {billing.pricing
            ? `Estimated cost: ${costLabel(billing.cost)}. ${billing.cost?.complete ? "" : "Some requests or token details could not be priced."}`
            : "No saved model prices. Usage is shown without a cost estimate."}
        </NumericText>
      </p>
      {!billing.usage.length && <p className="muted">No token usage was reported.</p>}
      {billing.usage.map((usage) => {
        const charge = billing.pricing ? tokenCost(billing.pricing, usage) : null;
        const rates = charge?.longContext
          ? billing.pricing?.longContext?.rates
          : billing.pricing?.rates;
        const counts = {
          input: usage.inputTokens,
          output: usage.outputTokens,
          cacheWrite5m: usage.cacheWrite5mTokens,
          cacheWrite1h: usage.cacheWrite1hTokens,
          cacheRead: usage.cacheReadTokens,
          cacheWrite: usage.cacheWriteTokens ?? 0,
        };
        return (
          <div className="security-table-scroll" key={`${id}-${usage.request}`}>
            <table className="security-table security-billing-table">
              <caption>
                Reported request <MorphNumber value={usage.request} />
                {charge?.longContext ? " · Long context rates" : ""}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  <th scope="col">Tokens</th>
                  <th scope="col">USD / MTok</th>
                  <th scope="col">Estimated USD</th>
                </tr>
              </thead>
              <tbody>
                {BILLING_PRICE_FIELDS.filter(
                  (field) => rates?.[field] !== undefined || counts[field],
                ).map((field) => (
                  <tr key={field}>
                    <th scope="row">
                      <NumericText>{labels[field]}</NumericText>
                    </th>
                    <td>
                      <MorphNumber value={counts[field] ?? "Unknown"} />
                    </td>
                    <td>
                      <MorphNumber value={charge && rates ? (rates[field] ?? "—") : "—"} />
                    </td>
                    <td>
                      <MorphNumber
                        value={
                          charge
                            ? costLabel({
                                currency: "USD",
                                totalUsd: charge.amounts[field] ?? 0,
                                complete: true,
                              })
                            : "—"
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {usage.cacheWrite5mTokens === null && (
              <p className="muted">
                Cache writes: <MorphNumber value={usage.cacheCreationTokens} /> tokens. The provider
                did not report their lifetimes; this request cannot be priced.
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}

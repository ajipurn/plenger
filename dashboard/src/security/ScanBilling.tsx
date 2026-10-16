import type { SecurityReview } from "../../../src/dashboard/contract.ts";
import { type CostSummary, PRICE_FIELDS, tokenCost } from "../../../src/redteam/model-pricing.ts";

export function costLabel(cost: CostSummary | null | undefined): string {
  if (!cost) return "Unavailable";
  const amount =
    cost.totalUsd > 0 && cost.totalUsd < 0.000001
      ? "< $0.000001"
      : new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          minimumFractionDigits: 2,
          maximumFractionDigits: 6,
        }).format(cost.totalUsd);
  return cost.complete ? amount : `At least ${amount}`;
}
const labels = {
  input: "Input (uncached)",
  output: "Output",
  cacheWrite5m: "Cache write · 5 minutes",
  cacheWrite1h: "Cache write · 1 hour",
  cacheRead: "Cache hits and refreshes",
};

export function ScanBilling({ reviews }: { reviews: SecurityReview[] }) {
  if (!reviews.some((review) => review.request.billing)) return null;
  return (
    <details className="security-billing">
      <summary>Token usage and cost details</summary>
      <p className="muted">
        USD estimates use the prices captured when this scan started. They are not an invoice and
        exclude taxes, discounts and other service charges. Incomplete usage is never assumed to be
        zero.
      </p>
      {reviews.map((review, index) => {
        const billing = review.request.billing;
        if (!billing) return null;
        return (
          <section key={review.id}>
            <h3>
              Source batch {index + 1} · {review.provider.model}
            </h3>
            <p className="muted">
              {billing.pricing
                ? `${costLabel(billing.cost)} estimated. ${billing.cost?.complete ? "" : "Some requests or cache write lifetimes could not be priced."}`
                : "No saved model prices. Usage is shown without a cost estimate."}
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
              };
              return (
                <div className="security-table-scroll" key={`${review.id}-${usage.request}`}>
                  <table className="security-table security-billing-table">
                    <caption>
                      Reported request {usage.request}
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
                      {PRICE_FIELDS.map((field) => (
                        <tr key={field}>
                          <th scope="row">{labels[field]}</th>
                          <td>{counts[field]?.toLocaleString() ?? "Unknown"}</td>
                          <td>{charge && rates ? rates[field] : "—"}</td>
                          <td>
                            {charge
                              ? costLabel({
                                  currency: "USD",
                                  totalUsd: charge.amounts[field],
                                  complete: true,
                                })
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {usage.cacheWrite5mTokens === null && (
                    <p className="muted">
                      Cache writes: {usage.cacheCreationTokens.toLocaleString()} tokens. The
                      provider did not report their lifetimes; this request cannot be priced.
                    </p>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}
    </details>
  );
}

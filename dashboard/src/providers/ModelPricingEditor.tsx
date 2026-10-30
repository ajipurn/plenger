import { useCallback, useEffect, useId, useRef, useState } from "react";
import { MODEL_PRICING_LIMITS, MODELS_DEV_PRICING } from "../../../src/redteam/constants.ts";
import type { ModelPricing, TokenRates } from "../../../src/redteam/model-pricing.ts";
import type { PricingProvider } from "../../../src/redteam/models-dev-pricing.ts";
import { useApi } from "../app/DashboardContext.tsx";
import { errorMessage } from "../shared/async.ts";
import { MorphNumber, NumericText } from "../shared/MorphNumber.tsx";
import { Button } from "../shared/ui.tsx";

const price = (value: number | undefined) =>
  value === undefined
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 6,
      }).format(value);

/** Read-only catalog shared by provider settings and automatic scan price snapshots. */
export function ModelPricingEditor({
  provider,
  apiEquivalent = false,
  models,
  defaultModel,
  value,
  onChange,
  disabled,
  active,
  onLoadingChange,
}: {
  provider: PricingProvider;
  apiEquivalent?: boolean;
  models: { id: string; name: string }[];
  defaultModel: string;
  value: ModelPricing[];
  onChange: (value: ModelPricing[]) => void;
  disabled: boolean;
  active: boolean;
  onLoadingChange: (loading: boolean) => void;
}) {
  const id = useId();
  const api = useApi();
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [stale, setStale] = useState<string[]>([]);
  const request = useRef<AbortController | null>(null);
  const current = useRef({ value, onChange });
  current.current = { value, onChange };
  const names = new Map(models.map((item) => [item.id, item.name]));
  const allModels = [
    ...new Set([defaultModel, ...value.map((item) => item.model), ...names.keys()].filter(Boolean)),
  ].sort((a, b) => (a === defaultModel ? -1 : b === defaultModel ? 1 : a.localeCompare(b)));
  const modelKey = allModels.slice(0, MODEL_PRICING_LIMITS.models).join("\n");
  const ids = modelKey ? modelKey.split("\n") : [];
  const load = useCallback(
    async (key: string, refresh: boolean) => {
      if (!api) return;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      onLoadingChange(true);
      setErrors({});
      setStale([]);
      const queue = key.split("\n").filter(Boolean);
      try {
        await Promise.all(
          Array.from({ length: Math.min(4, queue.length) }, async () => {
            while (queue.length && !controller.signal.aborted) {
              const model = queue.shift();
              if (!model) break;
              const existing = current.current.value.find((item) => item.model === model);
              if (
                !refresh &&
                existing?.source &&
                Date.now() - Date.parse(existing.source.fetchedAt) < MODELS_DEV_PRICING.cacheMs
              )
                continue;
              if (!existing && current.current.value.length >= MODEL_PRICING_LIMITS.models)
                continue;
              try {
                const result = await api.modelPricing(
                  { provider, model, refresh },
                  controller.signal,
                );
                if (controller.signal.aborted) return;
                const next = [
                  ...current.current.value.filter((item) => item.model !== model),
                  result.pricing,
                ];
                current.current = { ...current.current, value: next };
                current.current.onChange(next);
                if (result.stale) setStale((previous) => [...previous, model]);
              } catch (failure) {
                if (!controller.signal.aborted)
                  setErrors((previous) => ({
                    ...previous,
                    [model]: errorMessage(failure, "Unable to load pricing. Retry the refresh."),
                  }));
              }
            }
          }),
        );
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          onLoadingChange(false);
        }
      }
    },
    [api, provider, onLoadingChange],
  );
  useEffect(() => {
    if (active && modelKey) void load(modelKey, false);
    return () => {
      request.current?.abort();
      setLoading(false);
      onLoadingChange(false);
    };
  }, [active, modelKey, load, onLoadingChange]);
  return (
    <section className="provider-pricing" aria-labelledby={`${id}-heading`}>
      <div className="provider-pricing-heading">
        <h3 id={`${id}-heading`}>Model pricing</h3>
        <a
          href={
            provider === "openai"
              ? "https://developers.openai.com/api/docs/pricing"
              : "https://platform.claude.com/docs/en/about-claude/pricing"
          }
          target="_blank"
          rel="noreferrer"
        >
          Pricing reference ↗
        </a>
      </div>
      <p className="muted">
        Standard API prices from{" "}
        <a href="https://models.dev" target="_blank" rel="noreferrer">
          Models.dev
        </a>
        , in USD per <MorphNumber value={1} /> million tokens.
      </p>
      {apiEquivalent && (
        <p className="muted">
          Subscription estimates use standard OpenAI API prices for the reported tokens.
          Subscription billing and quota are separate.
        </p>
      )}
      <div className="provider-actions">
        <Button
          className="button button-secondary"
          disabled={disabled || loading || !ids.length}
          onClick={() => void load(modelKey, true)}
        >
          {loading ? "Loading pricing…" : "Refresh pricing"}
        </Button>
      </div>
      <p className="muted" role="status">
        {loading
          ? "Loading model prices…"
          : stale.length
            ? "Some prices could not be updated. Showing the last saved rates."
            : Object.keys(errors).length
              ? "Some prices are unavailable. Refresh to try again; existing prices are kept."
              : ""}
      </p>
      {!ids.length ? (
        <p className="muted">Choose a default model or load models in Connection to see prices.</p>
      ) : (
        <section className="security-table-scroll provider-pricing-list" aria-label="Model prices">
          <table className="security-table">
            <caption className="sr-only">
              {provider === "openai" ? "OpenAI" : "Anthropic"} API model prices in USD per million
              tokens
            </caption>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Input</th>
                <th scope="col">Output</th>
                <th scope="col">Cache read</th>
              </tr>
            </thead>
            {ids.map((model) => {
              const pricing = value.find((item) => item.model === model);
              return (
                <tbody key={model}>
                  <tr>
                    <th scope="row">
                      <span>{names.get(model) ?? model}</span>
                      {model === defaultModel && <span className="tag">Default</span>}
                      {names.get(model) && names.get(model) !== model && (
                        <code className="provider-model-id muted">{model}</code>
                      )}
                    </th>
                    <td>
                      {pricing ? (
                        <MorphNumber value={price(pricing.rates.input)} />
                      ) : loading ? (
                        "Loading…"
                      ) : (
                        "Unavailable"
                      )}
                    </td>
                    <td>
                      <MorphNumber value={price(pricing?.rates.output)} />
                    </td>
                    <td>
                      <MorphNumber value={price(pricing?.rates.cacheRead)} />
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={4}>
                      {pricing && (
                        <details className="provider-price-details">
                          <summary>Pricing details</summary>
                          <p className="muted">
                            {pricing.source ? (
                              <>
                                Source: Models.dev · Updated{" "}
                                <time dateTime={pricing.source.fetchedAt}>
                                  <MorphNumber
                                    value={new Date(pricing.source.fetchedAt).toLocaleString()}
                                    variant="text"
                                  />
                                </time>
                              </>
                            ) : (
                              "Previously saved rates. Refresh pricing to use the Models.dev catalog."
                            )}
                          </p>
                          <CacheRates rates={pricing.rates} provider={provider} />
                          {pricing.longContext && (
                            <>
                              <p>
                                Long context: above{" "}
                                <MorphNumber value={pricing.longContext.threshold} /> input tokens,
                                including cache.
                              </p>
                              <p>
                                Input <MorphNumber value={price(pricing.longContext.rates.input)} />{" "}
                                · Output{" "}
                                <MorphNumber value={price(pricing.longContext.rates.output)} /> ·
                                Cache read{" "}
                                <MorphNumber value={price(pricing.longContext.rates.cacheRead)} />
                              </p>
                              <CacheRates rates={pricing.longContext.rates} provider={provider} />
                            </>
                          )}
                        </details>
                      )}
                      {errors[model] && (
                        <p className="muted">
                          {pricing ? "Update failed. Showing saved prices." : errors[model]}
                        </p>
                      )}
                    </td>
                  </tr>
                </tbody>
              );
            })}
          </table>
        </section>
      )}
      {allModels.length > ids.length && (
        <p className="muted">
          Showing <MorphNumber value={ids.length} /> models, including the default and saved prices.
        </p>
      )}
      <p className="muted">
        Prices refresh after <MorphNumber value={24} /> hours and are checked when a scan starts.
        Each scan keeps its original price snapshot. Estimates exclude discounts, taxes and other
        service charges.
      </p>
    </section>
  );
}

function CacheRates({ rates, provider }: { rates: TokenRates; provider: PricingProvider }) {
  return (
    <p className="muted">
      {provider === "anthropic" ? (
        <NumericText>{`Cache write · 5 minutes: ${price(rates.cacheWrite5m)} · 1 hour: ${price(rates.cacheWrite1h)}`}</NumericText>
      ) : rates.cacheWrite === undefined ? (
        "No separate cache-write price listed."
      ) : (
        <>
          Cache write · Default lifetime: <MorphNumber value={price(rates.cacheWrite)} />
        </>
      )}
    </p>
  );
}

import { useId } from "react";
import { MODEL_PRICING_LIMITS } from "../../../src/redteam/constants.ts";
import {
  type ModelPricing,
  PRICE_FIELDS,
  type TokenRates,
  validateModelPricing,
} from "../../../src/redteam/model-pricing.ts";
import { Checkbox, Input, Select } from "../shared/ui.tsx";

type RateDraft = Record<(typeof PRICE_FIELDS)[number], string>;
export interface PricingDraft {
  model: string;
  rates: RateDraft;
  longContext?: { threshold: string; rates: RateDraft };
}
const labels = {
  input: "Input (uncached)",
  output: "Output",
  cacheWrite5m: "Cache write · 5 minutes",
  cacheWrite1h: "Cache write · 1 hour",
  cacheRead: "Cache hits and refreshes",
};
const blankRates = (): RateDraft => ({
  input: "",
  output: "",
  cacheWrite5m: "",
  cacheWrite1h: "",
  cacheRead: "",
});
const draftRates = (rates: TokenRates): RateDraft =>
  Object.fromEntries(PRICE_FIELDS.map((field) => [field, String(rates[field])])) as RateDraft;
export function pricingDrafts(pricing: ModelPricing[]): PricingDraft[] {
  return pricing.map((item) => ({
    model: item.model,
    rates: draftRates(item.rates),
    ...(item.longContext
      ? {
          longContext: {
            threshold: String(item.longContext.threshold),
            rates: draftRates(item.longContext.rates),
          },
        }
      : {}),
  }));
}
export function pricingValues(drafts: PricingDraft[]): ModelPricing[] {
  const number = (value: string, model: string): number => {
    if (!value.trim() || !Number.isFinite(Number(value)))
      throw new Error(`Complete all pricing fields for ${model}, or turn off its custom pricing.`);
    return Number(value);
  };
  const rates = (value: RateDraft, model: string) =>
    Object.fromEntries(PRICE_FIELDS.map((field) => [field, number(value[field], model)]));
  return validateModelPricing(
    drafts.map((item) => ({
      model: item.model,
      rates: rates(item.rates, item.model),
      ...(item.longContext
        ? {
            longContext: {
              threshold: number(item.longContext.threshold, item.model),
              rates: rates(item.longContext.rates, item.model),
            },
          }
        : {}),
    })),
  );
}

export function ModelPricingEditor({
  models,
  defaultModel,
  value,
  onChange,
  disabled,
  selectedModel,
  onSelectModel,
}: {
  models: { id: string; name: string }[];
  defaultModel: string;
  value: PricingDraft[];
  onChange: (value: PricingDraft[]) => void;
  disabled: boolean;
  selectedModel: string;
  onSelectModel: (model: string) => void;
}) {
  const id = useId();
  const options = new Map(models.map((item) => [item.id, item.name]));
  for (const item of value) if (!options.has(item.model)) options.set(item.model, item.model);
  if (defaultModel && !options.has(defaultModel)) options.set(defaultModel, defaultModel);
  const model = options.has(selectedModel)
    ? selectedModel
    : defaultModel || options.keys().next().value || "";
  const draft = value.find((item) => item.model === model);
  function update(next: PricingDraft) {
    onChange([...value.filter((item) => item.model !== model), next]);
  }
  return (
    <section className="provider-pricing" aria-labelledby={`${id}-heading`}>
      <div className="provider-pricing-heading">
        <h3 id={`${id}-heading`}>Model pricing</h3>
        <a
          href="https://platform.claude.com/docs/en/about-claude/pricing"
          target="_blank"
          rel="noreferrer"
        >
          Pricing reference ↗
        </a>
      </div>
      <p className="muted">
        Set your rates to estimate scan costs. All prices are in USD per 1 million tokens.
      </p>
      <div className="provider-pricing-model">
        <label htmlFor={`${id}-model`}>Model</label>
        <Select
          id={`${id}-model`}
          label="Pricing model"
          value={model}
          items={[...options].map(([key, name]) => ({
            value: key,
            label: `${name}${value.some((item) => item.model === key) ? " · Custom prices" : ""}`,
          }))}
          onValueChange={onSelectModel}
          disabled={disabled || !options.size}
          placeholder="Load models first"
        />
        {model ? (
          <code className="provider-model-id muted">{model}</code>
        ) : (
          <p className="muted">Choose a default model or load models in Connection first.</p>
        )}
      </div>
      {model && (
        <Checkbox
          isSelected={!!draft}
          isDisabled={disabled || (!draft && value.length >= MODEL_PRICING_LIMITS.models)}
          onChange={(checked) =>
            checked
              ? update({ model, rates: blankRates() })
              : onChange(value.filter((item) => item.model !== model))
          }
        >
          Set prices for this model
        </Checkbox>
      )}
      {draft && (
        <>
          <RateFields
            rates={draft.rates}
            prefix={`${id}-standard`}
            title="Token prices"
            onChange={(rates) => update({ ...draft, rates })}
          />
          <Checkbox
            isSelected={!!draft.longContext}
            isDisabled={disabled}
            onChange={(checked) => {
              const { longContext: _previous, ...base } = draft;
              update(
                checked ? { ...base, longContext: { threshold: "", rates: blankRates() } } : base,
              );
            }}
          >
            Add a long context price tier
          </Checkbox>
          {draft.longContext && (
            <fieldset className="provider-long-context">
              <legend>Long context tier</legend>
              <label htmlFor={`${id}-threshold`}>Prompt length threshold (tokens)</label>
              <Input
                id={`${id}-threshold`}
                type="number"
                min={1}
                step={1}
                required
                value={draft.longContext.threshold}
                onChange={(event) =>
                  update({
                    ...draft,
                    longContext: {
                      rates: draft.longContext?.rates ?? blankRates(),
                      threshold: event.target.value,
                    },
                  })
                }
              />
              <p className="muted">
                Applies to the entire request above this input length, including cached tokens.
              </p>
              <RateFields
                prefix={`${id}-long`}
                title="Long context prices"
                rates={draft.longContext.rates}
                onChange={(rates) =>
                  update({
                    ...draft,
                    longContext: { threshold: draft.longContext?.threshold ?? "", rates },
                  })
                }
              />
            </fieldset>
          )}
        </>
      )}
      {!draft && model && (
        <div className="provider-pricing-empty">
          <p>No prices set for this model</p>
          <p className="muted">
            Enable pricing above to add rates. Until then, scan costs show as unavailable.
          </p>
        </div>
      )}
      {value.length > 0 && (
        <p className="muted provider-pricing-count">
          {value.length === 1
            ? "1 model has custom prices."
            : `${value.length} models have custom prices.`}{" "}
          Switch models to edit another.
        </p>
      )}
      <details className="provider-pricing-help">
        <summary>How cost estimates work</summary>
        <p className="muted">
          Each scan keeps a snapshot of these rates. Costs use reported token usage and exclude
          taxes, discounts and other service charges. Enter 0 for a free category.
        </p>
        <p className="muted">
          Setting cache prices does not enable prompt caching. Rates are entered manually and are
          not updated from Claude automatically.
        </p>
      </details>
    </section>
  );
}

function RateFields({
  rates,
  prefix,
  onChange,
  title,
}: {
  rates: RateDraft;
  prefix: string;
  onChange: (rates: RateDraft) => void;
  title: string;
}) {
  return (
    <fieldset className="provider-rate-table">
      <legend className="sr-only">{title}</legend>
      <div className="provider-rate-heading" aria-hidden="true">
        <span>{title}</span>
        <span>USD / 1M tokens</span>
      </div>
      {PRICE_FIELDS.map((field) => (
        <label key={field} htmlFor={`${prefix}-${field}`} className="provider-rate-row">
          <span>{labels[field]}</span>
          <span className="provider-rate-input">
            <span aria-hidden="true">$</span>
            <Input
              id={`${prefix}-${field}`}
              type="number"
              inputMode="decimal"
              min={0}
              max={MODEL_PRICING_LIMITS.perMillion}
              step="any"
              value={rates[field]}
              aria-label={`${labels[field]} (USD per 1 million tokens)`}
              placeholder="0.00"
              required
              onChange={(event) => onChange({ ...rates, [field]: event.target.value })}
            />
          </span>
        </label>
      ))}
    </fieldset>
  );
}

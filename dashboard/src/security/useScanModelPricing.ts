import { useEffect, useState } from "react";
import { MODELS_DEV_PRICING } from "../../../src/redteam/constants.ts";
import type { ModelPricing } from "../../../src/redteam/model-pricing.ts";
import {
  modelPricingProvider,
  providerModelPricing,
  type SavedProvider,
} from "../../../src/redteam/provider-config.ts";
import type { DashboardApi } from "../api/client.ts";

/** Only the models selected for a limited scan need a price lookup. Fresh cached rates are immediate. */
export function useScanModelPricing(
  api: DashboardApi | null,
  provider: SavedProvider | undefined,
  model: string,
  active: boolean,
) {
  const namespace = modelPricingProvider(provider?.provider);
  const key = `${provider?.id}:${namespace}:${model}`;
  const fallback = provider ? providerModelPricing(provider, model) : undefined;
  const fresh =
    !!fallback?.source &&
    Date.now() - Date.parse(fallback.source.fetchedAt) < MODELS_DEV_PRICING.cacheMs;
  const [loaded, setLoaded] = useState<{
    key: string;
    pricing: ModelPricing | undefined;
    loading: boolean;
  } | null>(null);
  useEffect(() => {
    if (!active || !api || !namespace || !model || fresh) return;
    const controller = new AbortController();
    setLoaded({ key, pricing: fallback, loading: true });
    api
      .modelPricing({ provider: namespace, model }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setLoaded({ key, pricing: result.pricing, loading: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ key, pricing: fallback, loading: false });
      });
    return () => controller.abort();
  }, [active, api, namespace, model, key, fresh, fallback]);
  const current = loaded?.key === key ? loaded : null;
  return {
    pricing: fresh ? fallback : (current?.pricing ?? fallback),
    loading: !!(active && api && namespace && model && !fresh && (!current || current.loading)),
  };
}

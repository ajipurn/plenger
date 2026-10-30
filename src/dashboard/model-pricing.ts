import { MODELS_DEV_PRICING } from "../redteam/constants.ts";
import { fetchModelPricing, type PricingProvider } from "../redteam/models-dev-pricing.ts";
import { modelPricingProvider, type SavedProvider } from "../redteam/provider-config.ts";
import type { ProviderRepository } from "../storage/provider-repository.ts";
import type { ModelPricingResult } from "./contract.ts";

/** Public prices are cached independently of credentials and snapshotted by each scan. */
export class ModelPricingCatalog {
  readonly #store: ProviderRepository;
  readonly #load: typeof fetchModelPricing;
  constructor(store: ProviderRepository, load = fetchModelPricing) {
    this.#store = store;
    this.#load = load;
  }

  async load(
    provider: PricingProvider,
    model: string,
    refresh = false,
    signal?: AbortSignal,
  ): Promise<ModelPricingResult> {
    const cached = this.#store.readModelPricing(model, provider);
    if (
      !refresh &&
      cached?.source &&
      Date.now() - Date.parse(cached.source.fetchedAt) < MODELS_DEV_PRICING.cacheMs
    )
      return { pricing: cached, stale: false };
    try {
      const pricing = await this.#load(model, signal, undefined, provider);
      this.#store.saveModelPricing(pricing, provider);
      return { pricing, stale: false };
    } catch (error) {
      if (!refresh && cached && !signal?.aborted) return { pricing: cached, stale: true };
      throw error;
    }
  }

  async forScan(saved: SavedProvider, model: string) {
    const previous = saved.modelPricing?.find((item) => item.model === model);
    const provider = modelPricingProvider(saved.provider);
    if (!provider) return previous;
    try {
      return (await this.load(provider, model)).pricing;
    } catch {
      return previous;
    }
  }
}

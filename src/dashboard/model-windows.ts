import { MODELS_DEV_PRICING } from "../redteam/constants.ts";
import { fetchModelWindow } from "../redteam/models-dev-window.ts";
import { modelWindowProvider, type SavedProvider } from "../redteam/provider-config.ts";
import type { ProviderRepository } from "../storage/provider-repository.ts";

/**
 * Input windows that size a scan's rounds. A provider's own model catalog comes first;
 * otherwise public Models.dev windows, cached like prices.
 */
export class ModelWindowCatalog {
  readonly #store: ProviderRepository;
  readonly #load: typeof fetchModelWindow;
  constructor(store: ProviderRepository, load = fetchModelWindow) {
    this.#store = store;
    this.#load = load;
  }

  /** The model's input window, or null when it is unknown and rounds keep their defaults. */
  async forScan(
    saved: SavedProvider,
    apiKey: string | undefined,
    model: string,
  ): Promise<number | null> {
    const listed = this.#store.modelInputTokens(saved, apiKey, model);
    const provider = modelWindowProvider(saved);
    if (listed !== null || !provider) return listed;
    const cached = this.#store.readModelWindow(provider, model);
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < MODELS_DEV_PRICING.cacheMs)
      return cached.inputTokens;
    try {
      const window = await this.#load(provider, model);
      // Unlisted names, such as a model typed halfway, are looked up again next time.
      if (window.inputTokens !== null) this.#store.saveModelWindow(provider, model, window);
      return window.inputTokens;
    } catch {
      // A failed lookup never blocks a scan; an earlier window still applies.
      return cached?.inputTokens ?? null;
    }
  }
}

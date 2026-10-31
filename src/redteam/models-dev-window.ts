import { isRecord } from "../shared/guards.ts";
import { MODELS_DEV_PRICING } from "./constants.ts";
import { fetchModelsDevRecord } from "./models-dev-pricing.ts";

/** The input tokens a model accepts, from Models.dev; null when it lists none. */
export interface ModelWindow {
  inputTokens: number | null;
  fetchedAt: string;
}

/** Record names Models.dev uses; no slashes, so a lookup stays inside its directory. */
const RECORD_NAME = /^[a-z0-9][a-z0-9.-]{0,127}$/;
const BASE_MODEL = /^[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9.-]{0,127}$/;

/**
 * The input window of `model` on `provider`'s own endpoint: the provider record's limit,
 * else the limit of the base model it names. Public records only; never send provider
 * credentials or project source.
 */
export async function fetchModelWindow(
  provider: string,
  model: string,
  signal?: AbortSignal,
  dispatch: typeof fetch = fetch,
): Promise<ModelWindow> {
  const fetchedAt = new Date().toISOString();
  if (!RECORD_NAME.test(provider) || !RECORD_NAME.test(model))
    return { inputTokens: null, fetchedAt };
  const record = await fetchModelsDevRecord(
    `${MODELS_DEV_PRICING.baseUrl}${provider}/models/${model}.toml`,
    signal,
    dispatch,
  );
  const listed = windowOf(record);
  if (listed !== null || !isRecord(record) || typeof record.base_model !== "string")
    return { inputTokens: listed, fetchedAt };
  if (!BASE_MODEL.test(record.base_model)) return { inputTokens: null, fetchedAt };
  const base = await fetchModelsDevRecord(
    `${MODELS_DEV_PRICING.modelsUrl}${record.base_model}.toml`,
    signal,
    dispatch,
  );
  return { inputTokens: windowOf(base), fetchedAt };
}

/** A record's input limit, or its context window when it lists no separate input limit. */
function windowOf(record: unknown): number | null {
  if (!isRecord(record) || record.schema !== 2 || !isRecord(record.limit)) return null;
  const limit = record.limit.input ?? record.limit.context;
  return Number.isSafeInteger(limit) && (limit as number) > 0 ? (limit as number) : null;
}

/** A cached window as saved, or null when it no longer has that shape. */
export function validateModelWindow(value: unknown): ModelWindow | null {
  if (
    !isRecord(value) ||
    typeof value.fetchedAt !== "string" ||
    Number.isNaN(Date.parse(value.fetchedAt)) ||
    !(
      value.inputTokens === null ||
      (Number.isSafeInteger(value.inputTokens) && (value.inputTokens as number) > 0)
    )
  )
    return null;
  return { inputTokens: value.inputTokens as number | null, fetchedAt: value.fetchedAt };
}

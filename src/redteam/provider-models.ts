import { isRecord } from "../shared/guards.ts";
import { redact } from "../shared/secrets.ts";
import { ANTHROPIC, PROVIDER_MODEL_LIMITS as LIMITS, MODEL_ID } from "./constants.ts";
import { ModelProviderHttpError, type ProviderAccess, readModelJson } from "./provider.ts";
import {
  hasProviderModelCatalog,
  PROVIDER_URLS,
  type ProviderSettings,
  providerBaseUrl,
} from "./provider-config.ts";

export interface ProviderModel {
  id: string;
  name: string;
}

export type ProviderModelConnection = Pick<ProviderSettings, "provider" | "baseUrl"> & {
  apiKey: string;
};

/** Catalog requests never generate text, save credentials, follow redirects, or retry. */
export async function listProviderModels(
  access: Pick<ProviderAccess, "provider" | "baseUrl" | "apiKey">,
  signal?: AbortSignal,
  dispatch: typeof fetch = fetch,
): Promise<ProviderModel[]> {
  if (!hasProviderModelCatalog(access.provider) || !access.apiKey)
    throw new Error("Enter an API key for Anthropic or OpenAI before loading models.");
  const models = new Map<string, ProviderModel>();
  const cursors = new Set<string>();
  const timeout = AbortSignal.timeout(LIMITS.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let cursor: string | undefined;
  try {
    for (let page = 0; page < LIMITS.pages; page++) {
      const url = new URL(
        `${providerBaseUrl(access.baseUrl ?? PROVIDER_URLS[access.provider])}/models`,
      );
      if (access.provider === "anthropic") {
        url.searchParams.set("limit", String(LIMITS.pageSize));
        if (cursor) url.searchParams.set("after_id", cursor);
      }
      const raw = await catalogJson(url.href, access, combined, dispatch);
      if (!Array.isArray(raw.data) || raw.data.length > LIMITS.models)
        throw new Error("Invalid model catalog.");
      for (const value of raw.data) {
        if (!isRecord(value) || !validModelId(value.id) || value.id.includes(access.apiKey))
          throw new Error("Invalid model catalog.");
        const name =
          typeof value.display_name === "string" && value.display_name.trim()
            ? value.display_name
            : value.id;
        models.set(value.id, {
          id: value.id,
          name: Array.from(redact(name, [access.apiKey]), (char) =>
            char.charCodeAt(0) < 32 ? " " : char,
          )
            .join("")
            .slice(0, LIMITS.nameLength),
        });
        if (models.size > LIMITS.models) throw new Error("Model catalog exceeds the size limit.");
      }
      if (access.provider !== "anthropic" || raw.has_more === false) return [...models.values()];
      if (raw.has_more !== true || !validModelId(raw.last_id) || cursors.has(raw.last_id))
        throw new Error("Invalid model catalog pagination.");
      cursor = raw.last_id;
      cursors.add(cursor);
    }
    throw new Error("Model catalog exceeds the page limit.");
  } catch (error) {
    if (error instanceof ModelProviderHttpError)
      throw new Error(
        `Unable to load models: provider returned HTTP ${error.status}. Check the API key and base URL.`,
      );
    throw new Error("Unable to load models. Check the API key, base URL and provider connection.");
  }
}

/** Claude requires max_tokens. Resolve its model-specific ceiling without a pinned model table. */
export async function anthropicModelOutputLimit(
  access: ProviderAccess,
  signal: AbortSignal,
  dispatch: typeof fetch,
): Promise<number | null> {
  const base = providerBaseUrl(access.baseUrl ?? PROVIDER_URLS.anthropic);
  const raw = await catalogJson(
    `${base}/models/${encodeURIComponent(access.model)}`,
    access,
    signal,
    dispatch,
  );
  if (!validModelId(raw.id)) throw new Error("Invalid Claude model information.");
  // Older compatible endpoints may not expose model limits. The host allowance still applies.
  if (raw.max_tokens == null) return null;
  if (!Number.isSafeInteger(raw.max_tokens) || (raw.max_tokens as number) < 1)
    throw new Error("Invalid Claude model output limit.");
  return raw.max_tokens as number;
}

function validModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID.test(value) && !value.includes("://");
}

async function catalogJson(
  url: string,
  access: Pick<ProviderAccess, "provider" | "apiKey">,
  signal: AbortSignal,
  dispatch: typeof fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await dispatch(url, {
      method: "GET",
      redirect: "error",
      signal,
      headers:
        access.provider === "anthropic"
          ? { "x-api-key": access.apiKey as string, "anthropic-version": ANTHROPIC.version }
          : { Authorization: `Bearer ${access.apiKey}` },
    });
  } catch {
    throw new Error("Model catalog connection failed or was interrupted.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ModelProviderHttpError(response.status);
  }
  const raw = await readModelJson(response, LIMITS.bytes);
  if (!isRecord(raw)) throw new Error("Invalid model catalog.");
  return raw;
}

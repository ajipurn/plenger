import { isRecord } from "../shared/guards.ts";
import {
  ANTHROPIC,
  API_KEY_MAX_LENGTH,
  CHATGPT,
  MAX_OUTPUT_TOKENS,
  MODEL_ID,
  PROVIDERS,
  type ProviderId,
  TEMPERATURE_RANGE,
} from "./constants.ts";
import { type ModelPricing, validateModelPricing } from "./model-pricing.ts";
import type { ProviderAccess } from "./provider.ts";

export const PROVIDER_URLS: Record<ProviderId, string> = {
  ollama: "http://127.0.0.1:11434/v1",
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  chatgpt: CHATGPT.resource,
  anthropic: "https://api.anthropic.com/v1",
};

export interface ProviderSettings {
  name: string;
  provider: ProviderId;
  model: string;
  baseUrl: string;
  temperature: number | null;
  /** Null uses provider defaults, subject to the operation's token budget. */
  maxOutputTokens: number | null;
}
export interface SavedProvider extends ProviderSettings {
  modelPricing?: ModelPricing[];
  id: string;
  isDefault: boolean;
  hasApiKey: boolean;
  /** Display-only mask with at most the last four characters. Never a replacement key. */
  apiKeyPreview?: string;
  /** Display identity from a verified ChatGPT sign-in. Never a credential. */
  chatgptAccount?: string;
  createdAt: string;
  updatedAt: string;
}
export interface ProviderInput extends ProviderSettings {
  modelPricing?: ModelPricing[];
  id?: string;
  isDefault?: boolean;
  /** Omit to retain; an empty string explicitly removes the saved credential. */
  apiKey?: string;
}
/** The non-secret connection settings recorded with a run or campaign plan. */
export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  temperature: number | null;
  maxOutputTokens: number | null;
}
const PROVIDER_CONFIG_KEYS = ["id", "name", "baseUrl", "temperature", "maxOutputTokens"];

/** Normalise a provider base URL: HTTPS, or HTTP on loopback, without credentials or query. */
export function providerBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Enter a valid provider base URL.");
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    input.length > 2048
  )
    throw new Error(
      "Use HTTPS, or HTTP on localhost, with no credentials or query in the base URL.",
    );
  return url.href.replace(/\/+$/, "");
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

export function hasProviderModelCatalog(value: unknown): value is "openai" | "anthropic" {
  return value === "openai" || value === "anthropic";
}

function isModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID.test(value) && !value.includes("://");
}

function isPrintable(value: string, maxLength: number): boolean {
  return value.length <= maxLength && !Array.from(value).some((char) => char.charCodeAt(0) < 32);
}

/**
 * The checks every provider surface shares: supported provider, model ID, optional
 * API key shape, temperature range and output allowance. Absent optional fields pass;
 * callers decide which fields they require.
 */
export function validateProviderSettings(settings: {
  provider: unknown;
  model: unknown;
  apiKey?: unknown;
  temperature?: unknown;
  maxOutputTokens?: unknown;
  baseUrl?: unknown;
}): void {
  if (!isProviderId(settings.provider) || !isModelId(settings.model))
    throw new Error("Choose a supported provider and enter a model ID.");
  if (
    settings.provider === "chatgpt" &&
    (settings.apiKey ||
      settings.temperature != null ||
      (settings.baseUrl !== undefined && settings.baseUrl !== CHATGPT.resource))
  )
    throw new Error(
      "ChatGPT uses browser sign-in, its fixed endpoint and the model's default temperature.",
    );
  if (
    settings.apiKey !== undefined &&
    (typeof settings.apiKey !== "string" || !isPrintable(settings.apiKey, API_KEY_MAX_LENGTH))
  )
    throw new Error("Enter your selected provider's API key for this run.");
  const { temperature, maxOutputTokens } = settings;
  if (
    settings.provider === "anthropic" &&
    typeof temperature === "number" &&
    temperature > ANTHROPIC.maxTemperature
  )
    throw new Error(
      "Use a Claude temperature from 0 to 1, or leave it blank for the model default.",
    );
  if (
    (temperature != null &&
      (typeof temperature !== "number" ||
        !Number.isFinite(temperature) ||
        temperature < TEMPERATURE_RANGE.min ||
        temperature > TEMPERATURE_RANGE.max)) ||
    (maxOutputTokens === null && !hasProviderModelCatalog(settings.provider)) ||
    (maxOutputTokens != null &&
      (!Number.isSafeInteger(maxOutputTokens) ||
        (maxOutputTokens as number) < 1 ||
        (maxOutputTokens as number) > MAX_OUTPUT_TOKENS))
  )
    throw new Error("Check the provider temperature and output limit.");
}

/** Allow-listed settings only; never persist arbitrary request headers or source-discovered keys. */
export function validateProviderInput(value: unknown): ProviderInput {
  if (!isRecord(value)) throw new Error("Enter provider settings.");
  const input = value;
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "id",
          "name",
          "provider",
          "model",
          "baseUrl",
          "temperature",
          "maxOutputTokens",
          "isDefault",
          "apiKey",
          "modelPricing",
        ].includes(key),
    ) ||
    typeof input.name !== "string" ||
    !input.name.trim() ||
    !isPrintable(input.name, 80) ||
    typeof input.baseUrl !== "string" ||
    input.temperature === undefined ||
    input.maxOutputTokens === undefined ||
    (input.id !== undefined &&
      (typeof input.id !== "string" || !/^[a-f0-9-]{36}$/.test(input.id))) ||
    (input.isDefault !== undefined && typeof input.isDefault !== "boolean")
  )
    throw new Error(
      "Check the provider name, model, temperature (0–2) and output limit (1–16384).",
    );
  validateProviderSettings({
    provider: input.provider,
    model: input.model,
    apiKey: input.apiKey,
    temperature: input.temperature,
    maxOutputTokens: input.maxOutputTokens,
    baseUrl: input.baseUrl,
  });
  const modelPricing =
    input.modelPricing === undefined ? undefined : validateModelPricing(input.modelPricing);
  if (modelPricing?.length && input.provider !== "anthropic")
    throw new Error("Model pricing currently supports native Anthropic connections.");
  return {
    name: input.name.trim(),
    provider: input.provider as ProviderId,
    model: input.model as string,
    baseUrl: providerBaseUrl(input.baseUrl),
    temperature: input.temperature as number | null,
    maxOutputTokens: input.maxOutputTokens as number | null,
    ...(modelPricing === undefined ? {} : { modelPricing }),
    ...(input.id === undefined ? {} : { id: input.id as string }),
    ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault as boolean }),
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey as string }),
  };
}

/** The exportable, credential-free settings of a saved connection. */
export function providerConfigFromSaved(saved: SavedProvider): ProviderConfig {
  return {
    id: saved.id,
    name: saved.name,
    baseUrl: saved.baseUrl,
    temperature: saved.temperature,
    maxOutputTokens: saved.maxOutputTokens,
  };
}

/** Run access from exported connection settings plus an optionally supplied key. */
export function accessFromProviderConfig(
  settings: Omit<ProviderSettings, "name">,
  apiKey?: string,
): ProviderAccess {
  return {
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    temperature: settings.temperature,
    maxOutputTokens: settings.maxOutputTokens,
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}

/** Exported plan settings must be the exact non-secret shape; credentials are rejected. */
export function validateProviderConfig(
  config: unknown,
  provider: ProviderId,
  model: string,
): asserts config is ProviderConfig {
  if (
    !isRecord(config) ||
    Object.keys(config).some((key) => !PROVIDER_CONFIG_KEYS.includes(key)) ||
    typeof config.id !== "string" ||
    typeof config.name !== "string" ||
    typeof config.baseUrl !== "string" ||
    providerBaseUrl(config.baseUrl) !== config.baseUrl ||
    config.temperature === undefined ||
    config.maxOutputTokens === undefined
  )
    throw new Error("Invalid non-secret provider settings in campaign plan.");
  try {
    validateProviderSettings({ ...config, provider, model });
  } catch {
    throw new Error("Invalid non-secret provider settings in campaign plan.");
  }
}

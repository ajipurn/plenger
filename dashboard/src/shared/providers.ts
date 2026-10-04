import type { ProviderAccess } from "../../../src/redteam/provider.ts";

export type ProviderKind = ProviderAccess["provider"];

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  ollama: "Ollama",
  openai: "OpenAI",
  gemini: "Google Gemini",
};

export const PROVIDER_OPTIONS: { value: ProviderKind; label: string }[] = (
  ["ollama", "openai", "gemini"] as const
).map((value) => ({ value, label: PROVIDER_LABELS[value] }));

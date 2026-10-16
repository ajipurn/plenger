import { PROVIDERS } from "../../../src/redteam/constants.ts";
import type { ProviderAccess } from "../../../src/redteam/provider.ts";

export type ProviderKind = ProviderAccess["provider"];

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  ollama: "Ollama",
  openai: "OpenAI",
  gemini: "Google Gemini",
  anthropic: "Anthropic Claude",
  chatgpt: "ChatGPT subscription (experimental)",
};

export const PROVIDER_OPTIONS: { value: ProviderKind; label: string }[] = (
  ["ollama", ...PROVIDERS.filter((provider) => provider !== "ollama")] as const
).map((value) => ({ value, label: PROVIDER_LABELS[value] }));

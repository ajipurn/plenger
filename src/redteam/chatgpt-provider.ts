import { ChatgptAuthError } from "./chatgpt-auth.ts";
import { CHATGPT } from "./constants.ts";
import type { ProviderAccess, RunProvider } from "./provider.ts";
import { createResponsesProvider } from "./responses-provider.ts";

/** SIWC uses the public Responses API. No Codex credentials or agent process are involved. */
export function createChatgptProvider(access: ProviderAccess, dispatch: typeof fetch): RunProvider {
  const accessToken = access.accessToken;
  if (!accessToken)
    throw new ChatgptAuthError("Sign in with ChatGPT in Settings > Providers first.");
  return createResponsesProvider(
    access,
    {
      label: "ChatGPT",
      name: "chatgpt",
      url: `${CHATGPT.resource}/responses`,
      credential: (signal) => accessToken(signal),
      backend: "chatgpt",
    },
    dispatch,
  );
}

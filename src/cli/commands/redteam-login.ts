import { chatgptModels, signInChatgpt } from "../../redteam/chatgpt-auth.ts";
import { CHATGPT } from "../../redteam/constants.ts";
import { PROVIDER_URLS, validateProviderInput } from "../../redteam/provider-config.ts";
import { ProviderRepository } from "../../storage/provider-repository.ts";
import { COMMON_OPTIONS, parseCommandArgs, requireNonemptyPaths } from "../args.ts";
import { describe, type Io, UsageError } from "../io.ts";

export const REDTEAM_LOGIN_USAGE = `Usage:
  plenger redteam login --provider <name-or-id> [--model <id>] [--data-dir <dir>]

Sign in with ChatGPT in your browser and save a subscription provider.
Creates a named ChatGPT provider if it does not exist. Reuses its registration on later sign-ins.
The first available model is selected for a new provider unless --model is supplied.
Use the same --data-dir as the dashboard. Ctrl-C cancels sign-in.
Subscription usage and model availability depend on your ChatGPT account.
Token limits are observed after each response; they are not hard spending caps.
`;

export async function redteamLoginCommand(argv: string[], io: Io): Promise<number> {
  const { values } = parseCommandArgs(
    "redteam login",
    argv,
    {
      ...COMMON_OPTIONS,
      provider: { type: "string" },
      model: { type: "string" },
      "data-dir": { type: "string" },
    },
    0,
  );
  requireNonemptyPaths(values, ["data-dir"]);
  if (!values.provider?.trim() || values.model === "")
    throw new UsageError("--provider needs a name or id; --model needs a model id when supplied");
  try {
    validateProviderInput({
      name: values.provider,
      provider: "chatgpt",
      model: values.model ?? "pending-sign-in",
      baseUrl: PROVIDER_URLS.chatgpt,
      temperature: null,
      maxOutputTokens: 4096,
    });
  } catch (error) {
    throw new UsageError(describe(error));
  }
  // The default folder is resolved by the store.
  const store = await ProviderRepository.open(values["data-dir"]);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const previous = store.providers
      .readProviders()
      .find((item) => item.id === values.provider || item.name === values.provider);
    if (previous && previous.provider !== "chatgpt")
      throw new UsageError("This name belongs to another provider. Choose a new name for ChatGPT.");
    const saved =
      previous ??
      store.providers.saveProvider({
        name: values.provider,
        provider: "chatgpt",
        model: values.model ?? "pending-sign-in",
        baseUrl: PROVIDER_URLS.chatgpt,
        temperature: null,
        maxOutputTokens: 4096,
      });
    let { session, sealed } = store.providers.readChatgptSession(saved.id);
    if (session.refreshLease && session.refreshLease.until > Date.now())
      throw new Error("ChatGPT is refreshing this connection. Try signing in again shortly.");
    session = await signInChatgpt({
      hostId: await store.providers.chatgptHostId(),
      ...(session.clientId === CHATGPT.dynamicClient ? {} : { previous: session }),
      signal: controller.signal,
      onAuthorize: (url) =>
        io.stdout(`Continue with ChatGPT. Open this link on this computer:\n${url}\n`),
      onRegistration: async (registration) => {
        sealed = store.providers.saveChatgptSession(saved.id, registration, sealed);
      },
    });
    store.providers.saveChatgptSession(saved.id, session, sealed);
    if (!session.credentials) throw new Error("ChatGPT sign-in did not provide model access.");
    const models = await chatgptModels(session.credentials.accessToken, controller.signal);
    const model =
      values.model ??
      (previous && previous.model !== "pending-sign-in" ? previous.model : models[0]?.id);
    if (!model || !models.some((item) => item.id === model)) {
      io.stdout(
        `Sign-in saved. Available models: ${models.map((item) => item.id).join(", ") || "none"}\n`,
      );
      throw new Error(
        "Choose an available model in the dashboard's Providers page before running tests.",
      );
    }
    store.providers.saveProvider({
      id: saved.id,
      name: saved.name,
      provider: saved.provider,
      model,
      baseUrl: saved.baseUrl,
      temperature: null,
      maxOutputTokens: saved.maxOutputTokens,
    });
    io.stdout(
      `ChatGPT provider saved: ${saved.name} (${model}).\nSelect it in the dashboard or use --provider with redteam run.\nManage subscription usage: ${CHATGPT.usageUrl}\n`,
    );
    return 0;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    store.close();
  }
}

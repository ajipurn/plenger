import { isPricingModel } from "../../redteam/models-dev-pricing.ts";
import { testProviderConnection } from "../../redteam/provider.ts";
import {
  hasProviderModelCatalog,
  type ProviderInput,
  providerBaseUrl,
  validateProviderInput,
  validateProviderSettings,
} from "../../redteam/provider-config.ts";
import { listProviderModels } from "../../redteam/provider-models.ts";
import { errorMessage } from "../../shared/guards.ts";
import { StoreValidationError } from "../../storage/store.ts";
import {
  API,
  type DeleteResult,
  type ModelPricingResult,
  PROVIDER_SETTINGS_BYTES,
  type ProviderModelsResult,
  type ProviderTestResult,
} from "../contract.ts";
import { expectKeys, HttpError, jsonRequest, requireString } from "../http.ts";
import type { Route } from "../router.ts";
import type { Services } from "../services.ts";

/** Saved model connections. Keys go in; they never come back out through these routes. */
export function providerRoutes({ store, chatgptLogin, pricing }: Services): Route[] {
  async function selectedId(request: Parameters<typeof jsonRequest>[0]): Promise<string> {
    const body = await jsonRequest(request);
    const message = "Choose a saved provider.";
    expectKeys(body, ["id"], message);
    return requireString(body.id, message);
  }
  return [
    {
      method: "POST",
      path: API.modelPricing,
      handler: async ({ request, response }) => {
        const body = await jsonRequest(request);
        const message = "Choose an Anthropic or OpenAI model for automatic pricing.";
        expectKeys(body, ["provider", "model", "refresh"], message);
        const provider = body.provider ?? "anthropic";
        if (
          !hasProviderModelCatalog(provider) ||
          !isPricingModel(body.model, provider) ||
          (body.refresh !== undefined && typeof body.refresh !== "boolean")
        )
          throw new HttpError(400, message);
        const controller = new AbortController();
        const disconnect = () => controller.abort();
        response.once("close", disconnect);
        try {
          const result: ModelPricingResult = await pricing.load(
            provider,
            body.model,
            body.refresh as boolean | undefined,
            controller.signal,
          );
          return { status: 200, body: result };
        } catch (error) {
          throw new HttpError(400, errorMessage(error));
        } finally {
          response.off("close", disconnect);
        }
      },
    },
    {
      method: "GET",
      path: API.providerModels,
      handler: ({ url }) => {
        const id = requireString(url.searchParams.get("id"), "Choose a saved provider.");
        const saved = store.readProviders().find((item) => item.id === id);
        if (!saved) throw new HttpError(404, "Provider not found.");
        if (!hasProviderModelCatalog(saved.provider) || !saved.hasApiKey)
          return { status: 200, body: null };
        const { apiKey } = store.resolveProvider(id).access;
        const models = apiKey
          ? store.providers.readModelCatalog({
              provider: saved.provider,
              baseUrl: saved.baseUrl,
              apiKey,
            })
          : null;
        return { status: 200, body: models === null ? null : { models } };
      },
    },
    {
      method: "POST",
      path: API.providerModels,
      handler: async ({ request, response }) => {
        const body = await jsonRequest(request);
        const message = "Choose Anthropic or OpenAI and enter its base URL and API key.";
        expectKeys(body, ["id", "provider", "baseUrl", "apiKey", "refresh"], message);
        if (
          !hasProviderModelCatalog(body.provider) ||
          (body.refresh !== undefined && typeof body.refresh !== "boolean")
        )
          throw new HttpError(400, message);
        const provider = body.provider;
        let baseUrl: string;
        try {
          baseUrl = providerBaseUrl(requireString(body.baseUrl, message));
          validateProviderSettings({ provider, model: "catalog", apiKey: body.apiKey });
        } catch {
          throw new HttpError(400, message);
        }
        let apiKey = body.apiKey as string | undefined;
        if (body.id !== undefined) {
          const id = requireString(body.id, message);
          const saved = store.readProviders().find((item) => item.id === id);
          if (!saved) throw new HttpError(404, "Provider not found.");
          if (!apiKey && saved.provider === provider && saved.baseUrl === baseUrl)
            apiKey = store.resolveProvider(id).access.apiKey;
        }
        if (!apiKey) throw new HttpError(400, "Enter an API key before loading models.");
        const connection = { provider, baseUrl, apiKey };
        const cached = body.refresh ? null : store.providers.readModelCatalog(connection);
        if (cached !== null) return { status: 200, body: { models: cached } };
        const controller = new AbortController();
        const disconnect = () => controller.abort();
        response.once("close", disconnect);
        let result: ProviderModelsResult;
        try {
          result = { models: await listProviderModels(connection, controller.signal) };
        } catch (error) {
          throw new HttpError(400, errorMessage(error));
        } finally {
          response.off("close", disconnect);
        }
        store.providers.saveModelCatalog(connection, result.models);
        return { status: 200, body: result };
      },
    },
    {
      method: "POST",
      path: API.chatgptLogin,
      handler: async ({ request }) => ({
        status: 200,
        body: await chatgptLogin.start(await jsonRequest(request)),
      }),
    },
    {
      method: "GET",
      path: API.chatgptLoginStatus,
      handler: ({ url }) => ({
        status: 200,
        body: chatgptLogin.status(
          requireString(url.searchParams.get("id"), "Choose a ChatGPT sign-in."),
        ),
      }),
    },
    {
      method: "POST",
      path: API.cancelChatgptLogin,
      handler: async ({ request }) => ({
        status: 200,
        body: await chatgptLogin.cancel(await selectedId(request)),
      }),
    },
    {
      method: "GET",
      path: API.providers,
      handler: () => ({
        status: 200,
        body: store.readProviders({ keyPreviews: true, pricingCache: true }),
      }),
    },
    {
      method: "POST",
      path: API.providers,
      handler: async ({ request }) => {
        const body = await jsonRequest(request, PROVIDER_SETTINGS_BYTES);
        let input: ProviderInput;
        try {
          input = validateProviderInput(body);
        } catch (error) {
          // Field-level messages written for the person filling in the form.
          throw new HttpError(400, errorMessage(error), { cause: error });
        }
        try {
          return { status: 200, body: store.saveProvider(input) };
        } catch (error) {
          // Only the store's own refusals are the caller's concern; SQLite and I/O
          // failures are internal and must not reach the page.
          if (error instanceof StoreValidationError)
            throw new HttpError(400, error.message, { cause: error });
          throw error;
        }
      },
    },
    {
      method: "POST",
      path: API.deleteProvider,
      handler: async ({ request }) => {
        const id = await selectedId(request);
        if (!store.deleteProvider(id)) throw new HttpError(404, "Provider not found.");
        const result: DeleteResult = { deleted: true };
        return { status: 200, body: result };
      },
    },
    {
      method: "POST",
      path: API.testProvider,
      handler: async ({ request }) => {
        const id = await selectedId(request);
        let access: ReturnType<typeof store.resolveProvider>["access"];
        try {
          ({ access } = store.resolveProvider(id));
        } catch (error) {
          if (error instanceof StoreValidationError)
            throw new HttpError(400, error.message, { cause: error });
          throw error;
        }
        try {
          const connection = await testProviderConnection(access);
          const result: ProviderTestResult = { connected: true, ...connection };
          return { status: 200, body: result };
        } catch (error) {
          // `testProviderConnection` already reduced the failure to a safe category.
          throw new HttpError(400, errorMessage(error), { cause: error });
        }
      },
    },
  ];
}

import { randomUUID } from "node:crypto";
import { ChatgptAuthError, chatgptModels, signInChatgpt } from "../redteam/chatgpt-auth.ts";
import { CHATGPT } from "../redteam/constants.ts";
import { type ProviderInput, validateProviderInput } from "../redteam/provider-config.ts";
import { isRecord } from "../shared/guards.ts";
import { StoreValidationError } from "../storage/errors.ts";
import type { ProviderRepository } from "../storage/provider-repository.ts";
import type { ChatgptLoginResult } from "./contract.ts";
import { HttpError } from "./http.ts";

interface Attempt {
  result: ChatgptLoginResult;
  controller: AbortController;
  task: Promise<void>;
}

/** One browser sign-in per dashboard. Only public progress crosses the HTTP boundary. */
export class ChatgptLogin {
  readonly #providers: ProviderRepository;
  #attempt: Attempt | undefined;
  #closed = false;

  constructor(providers: ProviderRepository) {
    this.#providers = providers;
  }

  async start(value: unknown): Promise<ChatgptLoginResult> {
    if (this.#closed) throw new HttpError(409, "The dashboard is shutting down.");
    if (this.#attempt?.result.state === "pending")
      throw new HttpError(409, "Finish or cancel the current ChatGPT sign-in first.");
    // The saved registration only admits the account and workspace it was issued to, so
    // another account signs in under a new one.
    const { anotherAccount = false, ...settings } = isRecord(value) ? value : {};
    if (typeof anotherAccount !== "boolean")
      throw new HttpError(400, "Choose whether to sign in with another account.");
    let input: ProviderInput;
    try {
      input = validateProviderInput(isRecord(value) ? settings : value);
      if (input.provider !== "chatgpt") throw new Error("Choose ChatGPT subscription to sign in.");
    } catch (error) {
      throw new HttpError(
        400,
        error instanceof Error ? error.message : "Check the provider settings.",
      );
    }
    let provider: ChatgptLoginResult["provider"];
    try {
      provider = this.#providers.saveProvider(input);
    } catch (error) {
      if (error instanceof StoreValidationError) throw new HttpError(400, error.message);
      throw error;
    }
    const attempt: Attempt = {
      result: { id: randomUUID(), state: "pending", provider, models: [] },
      controller: new AbortController(),
      task: Promise.resolve(),
    };
    this.#attempt = attempt;
    let ready: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    attempt.task = (async () => {
      try {
        let { session, sealed } = this.#providers.readChatgptSession(provider.id);
        if (session.refreshLease && session.refreshLease.until > Date.now()) throw new Error();
        session = await signInChatgpt({
          hostId: await this.#providers.chatgptHostId(),
          ...(session.clientId === CHATGPT.dynamicClient || anotherAccount
            ? {}
            : { previous: session }),
          signal: attempt.controller.signal,
          onAuthorize: (url) => {
            attempt.result.authorizationUrl = url;
            ready();
          },
          onRegistration: async (registration) => {
            attempt.controller.signal.throwIfAborted();
            sealed = this.#providers.saveChatgptSession(provider.id, registration, sealed);
          },
        });
        attempt.controller.signal.throwIfAborted();
        this.#providers.saveChatgptSession(provider.id, session, sealed);
        if (!session.credentials) throw new Error();
        const models = await chatgptModels(
          session.credentials.accessToken,
          attempt.controller.signal,
        );
        attempt.controller.signal.throwIfAborted();
        const current = this.#providers.readProviders().find((item) => item.id === provider.id);
        if (current?.provider !== "chatgpt") throw new Error();
        if (!models.length)
          throw new ChatgptAuthError(
            "ChatGPT sign-in succeeded, but this account returned no available models.",
          );
        const model = models.some((item) => item.id === current.model)
          ? current.model
          : models[0]?.id;
        if (!model) throw new Error();
        // Saved first so the provider below carries the list into later editor sessions.
        this.#providers.saveChatgptModels(current.id, models);
        attempt.result.provider = this.#providers.saveProvider({
          id: current.id,
          name: current.name,
          provider: current.provider,
          model,
          baseUrl: current.baseUrl,
          temperature: null,
          maxOutputTokens: current.maxOutputTokens,
        });
        attempt.result.models = models;
        attempt.result.state = "connected";
      } catch (error) {
        attempt.result.state = attempt.controller.signal.aborted ? "cancelled" : "failed";
        if (attempt.result.state === "failed")
          attempt.result.error =
            error instanceof ChatgptAuthError
              ? error.message
              : "Could not finish ChatGPT sign-in. Allow plan usage in the browser, check your connection, then try again.";
      } finally {
        delete attempt.result.authorizationUrl;
        ready();
      }
    })();
    await started;
    return structuredClone(attempt.result);
  }

  status(id: string): ChatgptLoginResult {
    if (this.#attempt?.result.id !== id)
      throw new HttpError(404, "This ChatGPT sign-in is no longer available. Try again.");
    return structuredClone(this.#attempt.result);
  }

  async cancel(id: string): Promise<ChatgptLoginResult> {
    this.status(id);
    const attempt = this.#attempt;
    if (attempt?.result.state === "pending") {
      attempt.controller.abort();
      await attempt.task;
    }
    return this.status(id);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#attempt?.controller.abort();
    await this.#attempt?.task;
  }
}

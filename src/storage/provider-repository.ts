import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { type ChatgptSession, refreshChatgpt } from "../redteam/chatgpt-auth.ts";
import { CHATGPT } from "../redteam/constants.ts";
import type { ProviderAccess } from "../redteam/provider.ts";
import {
  accessFromProviderConfig,
  type ProviderInput,
  type ProviderSettings,
  type SavedProvider,
  validateProviderInput,
} from "../redteam/provider-config.ts";
import type { ProviderModel, ProviderModelConnection } from "../redteam/provider-models.ts";
import { maskAccount, redactReport } from "../shared/secrets.ts";
import { parsePayload, Storage, textColumn } from "./database.ts";
import { StoreValidationError } from "./errors.ts";
import {
  chatgptHostId,
  openProviderKey,
  providerEncryptionKey,
  providerModelCacheKey,
  redactedProviderKey,
  sealProviderKey,
} from "./provider-secrets.ts";

/** What `model_providers.payload` holds: the settings minus the columns stored beside it. */
type ProviderPayload = ProviderSettings & {
  modelPricing?: NonNullable<SavedProvider["modelPricing"]>;
  createdAt: string;
  updatedAt: string;
  chatgptAccount?: string;
};

/** A saved connection together with the access the engine needs to call it. */
export interface ResolvedProvider {
  saved: SavedProvider;
  access: ProviderAccess;
}

/**
 * Saved model connections. API keys are sealed with the data directory's key before
 * they reach SQLite. Only engine access and a bounded display hint unseal them.
 */
export class ProviderRepository {
  readonly #storage: Storage;
  readonly #key: Buffer;

  constructor(storage: Storage, key: Buffer) {
    this.#storage = storage;
    this.#key = key;
  }

  /**
   * Open just this repository, as the CLI does: the schema is migrated but nothing
   * else is touched, so a dashboard running against the same data directory keeps
   * its active runs.
   */
  static async open(dataDir?: string): Promise<{ providers: ProviderRepository; close(): void }> {
    const storage = await Storage.open(dataDir);
    try {
      const key = await providerEncryptionKey(storage.directory);
      return { providers: new ProviderRepository(storage, key), close: () => storage.close() };
    } catch (error) {
      storage.close();
      throw error;
    }
  }

  chatgptHostId(): Promise<string> {
    return chatgptHostId(this.#storage.directory);
  }

  /**
   * Every connection, the default first then by name. `keyPreviews` adds the masked
   * display hint, which unseals each key; only the provider list for the page asks for it.
   */
  readProviders(options: { keyPreviews?: boolean } = {}): SavedProvider[] {
    return this.#storage.database
      .prepare(
        "SELECT id, is_default, payload, credential FROM model_providers ORDER BY is_default DESC, name",
      )
      .all()
      .map((row) => {
        const payload = parsePayload<ProviderPayload>(row);
        const id = textColumn(row, "id");
        const credential =
          payload.provider !== "chatgpt" && typeof row.credential === "string"
            ? row.credential
            : null;
        return {
          ...payload,
          // Rows written before masking still hold the full address.
          ...(payload.chatgptAccount
            ? { chatgptAccount: maskAccount(payload.chatgptAccount) }
            : {}),
          id,
          isDefault: row.is_default === 1,
          hasApiKey: credential !== null,
          ...(credential !== null && options.keyPreviews
            ? { apiKeyPreview: redactedProviderKey(this.#key, id, credential) }
            : {}),
        };
      });
  }

  /**
   * Create or update a connection. A saved key is retained across edits unless the
   * provider or base URL changes, so a key never silently travels to a new endpoint.
   */
  saveProvider(value: ProviderInput): SavedProvider {
    const input = validateProviderInput(value);
    const id = input.id ?? randomUUID();
    const providers = this.readProviders();
    const old = providers.find((item) => item.id === id);
    if (input.id && !old)
      throw new StoreValidationError("This provider was deleted. Create a new provider.");
    if (
      providers.some(
        (item) => item.id !== id && item.name.toLowerCase() === input.name.toLowerCase(),
      )
    )
      throw new StoreValidationError("Choose a different provider name.");
    const sameDestination = old?.provider === input.provider && old.baseUrl === input.baseUrl;
    const credential =
      input.apiKey !== undefined
        ? input.apiKey
          ? sealProviderKey(this.#key, id, input.apiKey)
          : null
        : sameDestination
          ? this.#credential(id)
          : null;
    if (input.provider !== "ollama" && input.provider !== "chatgpt" && !credential)
      throw new StoreValidationError("Enter an API key for this provider.");
    const isDefault = input.isDefault ?? old?.isDefault ?? providers.length === 0;
    const now = new Date().toISOString();
    const modelPricing = input.modelPricing ?? (sameDestination ? old?.modelPricing : undefined);
    const payload: ProviderPayload = {
      name: input.name,
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl,
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
      ...(modelPricing === undefined ? {} : { modelPricing }),
      ...(input.provider === "chatgpt" && sameDestination && credential && old?.chatgptAccount
        ? { chatgptAccount: old.chatgptAccount }
        : {}),
    };
    this.#storage.transaction(() => {
      if (isDefault) this.#storage.database.exec("UPDATE model_providers SET is_default = 0");
      this.#storage.database
        .prepare(
          "INSERT INTO model_providers (id, name, is_default, payload, credential) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_default = excluded.is_default, payload = excluded.payload, credential = excluded.credential",
        )
        .run(id, input.name, isDefault ? 1 : 0, JSON.stringify(payload), credential);
    });
    return {
      ...payload,
      id,
      isDefault,
      hasApiKey: input.provider !== "chatgpt" && credential !== null,
      ...(input.provider !== "chatgpt" && credential !== null
        ? { apiKeyPreview: redactedProviderKey(this.#key, id, credential) }
        : {}),
    };
  }

  deleteProvider(id: string): boolean {
    return (
      this.#storage.database.prepare("DELETE FROM model_providers WHERE id = ?").run(id).changes !==
      0
    );
  }

  /** Catalogs survive edits and restarts, but only match the same provider, endpoint and key. */
  readModelCatalog(connection: ProviderModelConnection): ProviderModel[] | null {
    const row = this.#storage.database
      .prepare("SELECT payload FROM provider_model_catalogs WHERE connection_id = ?")
      .get(providerModelCacheKey(this.#key, connection));
    return row ? parsePayload<ProviderModel[]>(row) : null;
  }

  saveModelCatalog(connection: ProviderModelConnection, models: ProviderModel[]): void {
    const catalog = structuredClone(models);
    redactReport(catalog, [connection.apiKey]);
    this.#storage.database
      .prepare(
        "INSERT INTO provider_model_catalogs (connection_id, payload) VALUES (?, ?) ON CONFLICT(connection_id) DO UPDATE SET payload = excluded.payload",
      )
      .run(providerModelCacheKey(this.#key, connection), JSON.stringify(catalog));
  }

  /** The connection plus its unsealed key, for the engine only; never for API responses. */
  resolveProvider(id: string): ResolvedProvider {
    const saved = this.readProviders().find((item) => item.id === id);
    if (!saved) throw new StoreValidationError("Choose a saved provider in Providers.");
    const credential = this.#credential(id);
    if (saved.provider === "chatgpt") {
      const directory = this.#storage.directory;
      return {
        saved,
        access: {
          ...accessFromProviderConfig(saved),
          accessToken: (signal) => chatgptAccessToken(directory, id, signal),
        },
      };
    }
    return {
      saved,
      access: accessFromProviderConfig(
        saved,
        credential === null ? undefined : openProviderKey(this.#key, id, credential),
      ),
    };
  }

  /** Internal OAuth state. This is never returned by dashboard routes or exported. */
  readChatgptSession(id: string): {
    session: ChatgptSession & { refreshLease?: { id: string; until: number } };
    sealed: string | null;
  } {
    if (this.readProviders().find((item) => item.id === id)?.provider !== "chatgpt")
      throw new StoreValidationError("Choose a saved ChatGPT provider.");
    const sealed = this.#credential(id);
    return {
      session: sealed
        ? JSON.parse(openProviderKey(this.#key, id, sealed))
        : { clientId: CHATGPT.dynamicClient },
      sealed,
    };
  }

  /** Compare-and-swap prevents account replacement or concurrent refresh from overwriting tokens. */
  saveChatgptSession(id: string, session: ChatgptSession, expected: string | null): string {
    this.readChatgptSession(id);
    const sealed = sealProviderKey(this.#key, id, JSON.stringify(session));
    const identity = session.credentials ? (session.email ?? session.subject) : undefined;
    // Only the masked identity is stored; the full address stays in the sealed session.
    const account = identity === undefined ? undefined : maskAccount(identity);
    const changed = this.#storage.database
      .prepare(
        "UPDATE model_providers SET credential = ?, payload = json_patch(payload, ?) WHERE id = ? AND credential IS ? AND json_extract(payload, '$.provider') = 'chatgpt'",
      )
      .run(sealed, JSON.stringify({ chatgptAccount: account ?? null }), id, expected).changes;
    if (!changed)
      throw new StoreValidationError(
        "ChatGPT connection changed. Retry after the current sign-in or refresh finishes.",
      );
    return sealed;
  }

  #credential(id: string): string | null {
    const row = this.#storage.database
      .prepare("SELECT credential FROM model_providers WHERE id = ?")
      .get(id);
    const credential = row?.credential;
    return typeof credential === "string" ? credential : null;
  }
}

/** Cross-process refresh lease. No SQLite transaction stays open across a network await. */
async function chatgptAccessToken(
  directory: string,
  id: string,
  signal: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + CHATGPT.requestTimeoutMs;
  for (;;) {
    signal.throwIfAborted();
    const store = await ProviderRepository.open(directory);
    let claimed: string | undefined;
    let previous: ChatgptSession | undefined;
    try {
      const { session, sealed } = store.providers.readChatgptSession(id);
      if (!session.credentials)
        throw new Error("Sign in with plenger redteam login --provider <name> first.");
      if (session.credentials.expiresAt > Date.now() + 60_000)
        return session.credentials.accessToken;
      if (!session.refreshLease || session.refreshLease.until <= Date.now()) {
        const { refreshLease: _lease, ...saved } = session;
        previous = saved;
        const leased = {
          ...saved,
          refreshLease: { id: randomUUID(), until: Date.now() + CHATGPT.requestTimeoutMs * 3 },
        };
        claimed = store.providers.saveChatgptSession(id, leased, sealed);
      }
    } finally {
      store.close();
    }
    if (claimed && previous) {
      let refreshed: ChatgptSession;
      try {
        refreshed = await refreshChatgpt(previous, signal);
      } catch (error) {
        const store = await ProviderRepository.open(directory);
        try {
          store.providers.saveChatgptSession(id, previous, claimed);
        } finally {
          store.close();
        }
        throw error;
      }
      const store = await ProviderRepository.open(directory);
      try {
        store.providers.saveChatgptSession(id, refreshed, claimed);
      } finally {
        store.close();
      }
      if (!refreshed.credentials) throw new Error("ChatGPT refresh did not provide model access.");
      return refreshed.credentials.accessToken;
    }
    if (Date.now() >= deadline)
      throw new Error("ChatGPT refresh is already running. Try again shortly.");
    await setTimeout(50, undefined, { signal });
  }
}

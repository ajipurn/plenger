import { randomUUID } from "node:crypto";
import type { ProviderAccess } from "../redteam/provider.ts";
import {
  accessFromProviderConfig,
  type ProviderInput,
  type ProviderSettings,
  type SavedProvider,
  validateProviderInput,
} from "../redteam/provider-config.ts";
import { parsePayload, Storage, textColumn } from "./database.ts";
import { StoreValidationError } from "./errors.ts";
import { openProviderKey, providerEncryptionKey, sealProviderKey } from "./provider-secrets.ts";

/** What `model_providers.payload` holds: the settings minus the columns stored beside it. */
type ProviderPayload = ProviderSettings & { createdAt: string; updatedAt: string };

/** A saved connection together with the access the engine needs to call it. */
export interface ResolvedProvider {
  saved: SavedProvider;
  access: ProviderAccess;
}

/**
 * Saved model connections. API keys are sealed with the data directory's key before
 * they reach SQLite and are only unsealed by `resolveProvider`.
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

  /** Every connection without its key, the default first then by name. */
  readProviders(): SavedProvider[] {
    return this.#storage.database
      .prepare(
        "SELECT id, is_default, payload, credential IS NOT NULL AS has_key FROM model_providers ORDER BY is_default DESC, name",
      )
      .all()
      .map((row) => ({
        ...parsePayload<ProviderPayload>(row),
        id: textColumn(row, "id"),
        isDefault: row.is_default === 1,
        hasApiKey: row.has_key === 1,
      }));
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
    if (input.provider !== "ollama" && !credential)
      throw new StoreValidationError("Enter an API key for this provider.");
    const isDefault = input.isDefault ?? old?.isDefault ?? providers.length === 0;
    const now = new Date().toISOString();
    const payload: ProviderPayload = {
      name: input.name,
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl,
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
    };
    this.#storage.transaction(() => {
      if (isDefault) this.#storage.database.exec("UPDATE model_providers SET is_default = 0");
      this.#storage.database
        .prepare(
          "INSERT INTO model_providers (id, name, is_default, payload, credential) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_default = excluded.is_default, payload = excluded.payload, credential = excluded.credential",
        )
        .run(id, input.name, isDefault ? 1 : 0, JSON.stringify(payload), credential);
    });
    return { ...payload, id, isDefault, hasApiKey: credential !== null };
  }

  deleteProvider(id: string): boolean {
    return (
      this.#storage.database.prepare("DELETE FROM model_providers WHERE id = ?").run(id).changes !==
      0
    );
  }

  /** The connection plus its unsealed key, for the engine only; never for API responses. */
  resolveProvider(id: string): ResolvedProvider {
    const saved = this.readProviders().find((item) => item.id === id);
    if (!saved) throw new StoreValidationError("Choose a saved provider in Providers.");
    const credential = this.#credential(id);
    return {
      saved,
      access: accessFromProviderConfig(
        saved,
        credential === null ? undefined : openProviderKey(this.#key, id, credential),
      ),
    };
  }

  #credential(id: string): string | null {
    const row = this.#storage.database
      .prepare("SELECT credential FROM model_providers WHERE id = ?")
      .get(id);
    const credential = row?.credential;
    return typeof credential === "string" ? credential : null;
  }
}

import type { FileFacts } from "../facts/model.ts";
import type { Language } from "../languages.ts";
import { detectFile } from "./detect.ts";
import { emptyInventory, type Inventory } from "./model.ts";

export type * from "./model.ts";

/** Collects per-file inventories into one, merging framework and unrecognised-import lists. */
export class InventoryBuilder {
  readonly #inventory = emptyInventory();
  readonly #localModules: ReadonlySet<string>;

  /** `localModules`: the project's own top-level Python modules (see modules.ts). */
  constructor(localModules: ReadonlySet<string> = new Set()) {
    this.#localModules = localModules;
  }

  addFile(path: string, language: Language, facts: FileFacts): void {
    const file = detectFile(path, language, facts, this.#localModules);
    const target = this.#inventory;
    target.models.push(...file.models);
    target.llmCalls.push(...file.llmCalls);
    target.agents.push(...file.agents);
    target.tools.push(...file.tools);
    target.mcpServers.push(...file.mcpServers);
    target.mcpClients.push(...file.mcpClients);
    target.prompts.push(...file.prompts);
    target.dataStores.push(...file.dataStores);
    target.entryPoints.push(...file.entryPoints);
    for (const framework of file.frameworks) {
      const existing = target.frameworks.find((candidate) => candidate.id === framework.id);
      if (existing === undefined)
        target.frameworks.push({ ...framework, files: [...framework.files] });
      else existing.files.push(...framework.files);
    }
    for (const entry of file.unrecognised) {
      const existing = target.unrecognised.find((candidate) => candidate.module === entry.module);
      if (existing === undefined) target.unrecognised.push({ ...entry, files: [...entry.files] });
      else existing.files.push(...entry.files);
    }
  }

  build(): Inventory {
    const inventory = this.#inventory;
    inventory.frameworks.sort(
      (a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name),
    );
    inventory.unrecognised.sort(
      (a, b) => b.files.length - a.files.length || a.module.localeCompare(b.module),
    );
    return inventory;
  }
}

import type { Project } from "../project/project.ts";
import { ProjectDetector } from "./detect/index.ts";
import { emptyInventory, type Inventory } from "./model.ts";

export type * from "./model.ts";

/** Detects the agent inventory of a linked project. */
export function buildInventory(project: Project): Inventory {
  const inventory = emptyInventory();
  for (const file of new ProjectDetector(project).run()) {
    inventory.models.push(...file.models);
    inventory.llmCalls.push(...file.llmCalls);
    inventory.agents.push(...file.agents);
    inventory.tools.push(...file.tools);
    inventory.mcpServers.push(...file.mcpServers);
    inventory.mcpClients.push(...file.mcpClients);
    inventory.prompts.push(...file.prompts);
    inventory.dataStores.push(...file.dataStores);
    inventory.entryPoints.push(...file.entryPoints);
    for (const framework of file.frameworks) {
      const existing = inventory.frameworks.find((candidate) => candidate.id === framework.id);
      if (existing === undefined)
        inventory.frameworks.push({ ...framework, files: [...framework.files] });
      else existing.files.push(...framework.files);
    }
    for (const entry of file.unrecognised) {
      const existing = inventory.unrecognised.find(
        (candidate) => candidate.module === entry.module,
      );
      if (existing === undefined)
        inventory.unrecognised.push({ ...entry, files: [...entry.files] });
      else existing.files.push(...entry.files);
    }
  }
  inventory.frameworks.sort(
    (a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name),
  );
  inventory.unrecognised.sort(
    (a, b) => b.files.length - a.files.length || a.module.localeCompare(b.module),
  );
  return inventory;
}

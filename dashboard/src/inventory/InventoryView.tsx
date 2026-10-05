import type { DashboardScan } from "../../../src/dashboard/contract.ts";
import { InventoryBrowser } from "./InventoryBrowser.tsx";
import { inventoryCategories } from "./inventory-items.ts";

export function InventoryView({ report }: { report: DashboardScan }) {
  const inventory = report.scan.inventory;
  const categories = inventoryCategories(inventory);
  return (
    <InventoryBrowser
      categories={categories}
      frameworks={inventory.frameworks}
      unrecognised={inventory.unrecognised}
      initialCategory={
        inventory.agents.length > 0
          ? "Agents"
          : (categories.find((category) => category.items.length > 0)?.title ?? "Models")
      }
    />
  );
}

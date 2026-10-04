import type { DashboardScan } from "../../../src/dashboard/contract.ts";
import { plural } from "../shared/format.ts";
import { Icon } from "../shared/icons.tsx";
import { TechnicalDisclosure } from "../shared/TechnicalDisclosure.tsx";
import { InventoryBrowser } from "./InventoryBrowser.tsx";
import { inventoryCategories } from "./inventory-items.ts";

export function InventoryView({ report }: { report: DashboardScan }) {
  const inventory = report.scan.inventory;
  const categories = inventoryCategories(inventory);
  return (
    <section className="stack" aria-labelledby="inventory-heading">
      <h2 id="inventory-heading" className="sr-only">
        Source inventory
      </h2>
      <details className="framework-overview">
        <summary className="disclosure-heading">
          <span className="category-heading-main">
            <span className="category-icon">
              <Icon name="frameworks" />
            </span>
            <span>Frameworks</span>
            <span className="category-count">{inventory.frameworks.length}</span>
            <span className="framework-summary muted">
              {inventory.frameworks.length > 0
                ? `${inventory.frameworks
                    .slice(0, 4)
                    .map((framework) => framework.name)
                    .join(
                      ", ",
                    )}${inventory.frameworks.length > 4 ? ` +${inventory.frameworks.length - 4} more` : ""}`
                : "None observed"}
            </span>
          </span>
          <Icon name="chevron" />
        </summary>
        <div className="framework-content">
          {inventory.frameworks.length > 0 ? (
            <div className="capabilities framework-chips">
              {inventory.frameworks.map((framework) => (
                <span className="tag" key={framework.id}>
                  {framework.name} · {framework.files.length}{" "}
                  {plural(framework.files.length, "file")}
                </span>
              ))}
            </div>
          ) : (
            <p className="muted">No supported AI frameworks observed.</p>
          )}
          {inventory.unrecognised.length > 0 && (
            <TechnicalDisclosure
              title={`Unrecognized AI imports (${inventory.unrecognised.length})`}
              scrollable
            >
              <ul className="review-list">
                {inventory.unrecognised.map((item) => (
                  <li className="review-row" key={item.module}>
                    <code className="review-path">{item.module}</code>
                    <span className="review-note muted">{item.files.join(", ")}</span>
                  </li>
                ))}
              </ul>
            </TechnicalDisclosure>
          )}
        </div>
      </details>
      <InventoryBrowser
        categories={categories}
        initialCategory={
          inventory.agents.length > 0
            ? "Agents"
            : (categories.find((category) => category.items.length > 0)?.title ?? "Models")
        }
      />
    </section>
  );
}

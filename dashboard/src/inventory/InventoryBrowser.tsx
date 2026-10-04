import { Tabs } from "@base-ui/react/tabs";
import { useId, useState } from "react";
import { Icon } from "../shared/icons.tsx";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { Select } from "../shared/ui.tsx";
import { InventoryCategory, icons } from "./InventoryCategory.tsx";
import type { InventoryCategory as Category } from "./inventory-items.ts";

export function InventoryBrowser({
  categories,
  initialCategory,
}: {
  categories: Category[];
  initialCategory: string;
}) {
  const [category, setCategory] = useState(initialCategory);
  const categoryId = useId();
  return (
    <Tabs.Root
      className="panel inventory-browser"
      value={category}
      onValueChange={(value) => {
        if (typeof value === "string") setCategory(value);
      }}
      orientation="vertical"
    >
      <div className="inventory-sidebar">
        <p className="eyebrow">Browse inventory</p>
        <Tabs.List className="inventory-tabs" aria-label="Inventory categories" activateOnFocus>
          {categories.map(({ title, items }) => (
            <Tabs.Tab className="inventory-tab" key={title} value={title}>
              <Icon name={icons[title] ?? "inventory"} />
              <span>{title}</span>
              <span className="inventory-tab-count">
                <MorphNumber value={items.length} />
              </span>
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </div>
      <label className="inventory-category-select" htmlFor={categoryId}>
        <span className="eyebrow">Browse inventory</span>
        <Select
          id={categoryId}
          value={category}
          onValueChange={setCategory}
          items={categories.map(({ title, items }) => ({
            value: title,
            label: `${title} (${items.length})`,
          }))}
        />
      </label>
      {categories.map(({ title, items }) => (
        <Tabs.Panel key={title} value={title} className="inventory-tab-panel">
          <InventoryCategory title={title} items={items} />
        </Tabs.Panel>
      ))}
    </Tabs.Root>
  );
}

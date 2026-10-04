import { Tabs } from "@base-ui/react/tabs";
import { useId, useState } from "react";
import { Icon } from "../shared/icons.tsx";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { useElementScrollbars } from "../shared/ScrollArea.tsx";
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
  const scrollbars = useElementScrollbars<HTMLDivElement>();
  function selectCategory(value: string) {
    setCategory(value);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  return (
    <Tabs.Root
      className="inventory-browser"
      value={category}
      onValueChange={(value) => {
        if (typeof value === "string") selectCategory(value);
      }}
      orientation="vertical"
    >
      <div className="inventory-sidebar">
        <div
          className="inventory-sidebar-scroll"
          ref={scrollbars}
          data-overlayscrollbars-initialize=""
        >
          <p className="eyebrow">Categories</p>
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
      </div>
      <label className="inventory-category-select" htmlFor={categoryId}>
        <span className="eyebrow">Category</span>
        <Select
          id={categoryId}
          value={category}
          onValueChange={selectCategory}
          items={categories.map(({ title, items }) => ({
            value: title,
            label: `${title} (${items.length})`,
          }))}
        />
      </label>
      {categories.map(({ title, items }) => (
        <Tabs.Panel key={title} value={title} className="panel inventory-tab-panel">
          <InventoryCategory title={title} items={items} />
        </Tabs.Panel>
      ))}
    </Tabs.Root>
  );
}

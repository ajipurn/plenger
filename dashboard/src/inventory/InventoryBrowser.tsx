import { Tabs } from "@base-ui/react/tabs";
import { useId, useState } from "react";
import type { Inventory } from "../../../src/inventory/model.ts";
import { Icon } from "../shared/icons.tsx";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { Select } from "../shared/ui.tsx";
import { InventoryCategory, icons } from "./InventoryCategory.tsx";
import { InventoryFrameworks } from "./InventoryFrameworks.tsx";
import type { InventoryCategory as Category } from "./inventory-items.ts";

const frameworksTab = "Frameworks";

export function InventoryBrowser({
  categories,
  frameworks,
  unrecognised,
  initialCategory,
}: {
  categories: Category[];
  frameworks: Inventory["frameworks"];
  unrecognised: Inventory["unrecognised"];
  initialCategory: string;
}) {
  const [category, setCategory] = useState(initialCategory);
  const categoryId = useId();
  const tabs = [
    { title: frameworksTab, count: frameworks.length, icon: "frameworks" as const },
    ...categories.map(({ title, items }) => ({
      title,
      count: items.length,
      icon: icons[title] ?? "inventory",
    })),
  ];
  function selectCategory(value: string) {
    setCategory(value);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  return (
    <Tabs.Root
      className="subnav-layout inventory-layout"
      value={category}
      onValueChange={(value) => {
        if (typeof value === "string") selectCategory(value);
      }}
      orientation="vertical"
    >
      <aside className="subnav">
        <p className="eyebrow">Categories</p>
        <Tabs.List className="subnav-list" aria-label="Inventory categories" activateOnFocus>
          {tabs.map(({ title, count, icon }) => (
            <Tabs.Tab className="subnav-item" key={title} value={title}>
              <Icon name={icon} />
              <span>{title}</span>
              <span className="subnav-count">
                <MorphNumber value={count} />
              </span>
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <label className="inventory-category-select" htmlFor={categoryId}>
          <span className="sr-only">Category</span>
          <Select
            id={categoryId}
            value={category}
            onValueChange={selectCategory}
            items={tabs.map(({ title, count }) => ({ value: title, label: `${title} (${count})` }))}
          />
        </label>
      </aside>
      <div className="subnav-content">
        <Tabs.Panel value={frameworksTab}>
          <InventoryFrameworks frameworks={frameworks} unrecognised={unrecognised} />
        </Tabs.Panel>
        {categories.map(({ title, items }) => (
          <Tabs.Panel key={title} value={title}>
            <InventoryCategory title={title} items={items} />
          </Tabs.Panel>
        ))}
      </div>
    </Tabs.Root>
  );
}

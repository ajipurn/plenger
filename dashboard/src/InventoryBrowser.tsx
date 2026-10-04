import { Tabs } from "@base-ui/react/tabs";
import { useId, useRef, useState } from "react";
import { Drawer } from "vaul";
import type { Capability, Location } from "../../src/inventory/model.ts";
import { Icon, type IconName } from "./icons.tsx";
import { MorphNumber } from "./MorphNumber.tsx";
import { useElementScrollbars } from "./ScrollArea.tsx";
import { Button, Input, Select } from "./ui.tsx";

export interface InventoryItem {
  id: string;
  name: string;
  location: Location;
  framework?: string;
  preview: [string, string][];
  toolCount?: number;
  unresolvedTools?: number;
  description?: string | null;
  rows: [string, string][];
  capabilities?: Capability[];
  prompt?: string;
}

const icons: Record<string, IconName> = {
  Models: "models",
  Agents: "agents",
  Tools: "tools",
  "LLM calls": "llm-calls",
  "Entry points": "entry-points",
  "MCP servers": "mcp-servers",
  "MCP clients": "mcp-clients",
  "Data stores": "data-stores",
  Prompts: "prompts",
};
const descriptions: Record<string, string> = {
  Models: "Provider clients and model configuration",
  Agents: "Agent declarations and their linked tools",
  Tools: "Functions available to agents",
  "LLM calls": "Model invocations observed in source",
  "Entry points": "HTTP and MCP request handlers",
  "MCP servers": "Tools and resources exposed through MCP",
  "MCP clients": "Connections to external MCP servers",
  "Data stores": "Storage and retrieval integrations",
  Prompts: "System, user, and template instructions",
};

function Configuration({ item }: { item: InventoryItem }) {
  return (
    <div className="inventory-config-chips">
      {item.preview.map(([label, value]) => (
        <span className="inventory-config-chip" key={label} title={`${label}: ${value}`}>
          {label === "Tools" && item.toolCount !== undefined ? (
            `${item.toolCount} ${item.toolCount === 1 ? "tool" : "tools"}`
          ) : (
            <>
              <span className="inventory-chip-label">{label}</span> {value}
            </>
          )}
        </span>
      ))}
      {!!item.unresolvedTools && (
        <span className="inventory-config-chip inventory-unresolved">
          {item.unresolvedTools} unresolved
        </span>
      )}
    </div>
  );
}

function InventoryDetails({ item }: { item: InventoryItem }) {
  const capabilities = [
    ...new Map((item.capabilities ?? []).map((value) => [JSON.stringify(value), value])).values(),
  ];
  return (
    <div className="stack inventory-item-content">
      <div className="inventory-detail-source">
        <Icon name="source-files" />
        <code>
          {item.location.path}:{item.location.line}:{item.location.column}
        </code>
      </div>
      {item.description && <p>{item.description}</p>}
      <dl className="detail-list">
        {item.rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {item.prompt !== undefined && (
        <div>
          <h4>Captured prompt</h4>
          <pre className="code-block">
            <code>{item.prompt}</code>
          </pre>
        </div>
      )}
      {item.capabilities && (
        <div>
          <h4>Observed capabilities</h4>
          {capabilities.length === 0 ? (
            <p className="muted">No capabilities observed in this scope.</p>
          ) : (
            <ul className="evidence-list">
              {capabilities.map((capability) => (
                <li key={JSON.stringify(capability)}>
                  <div className="capability-heading">
                    <span className="tag">{capability.kind.replaceAll("_", " ")}</span>
                    <code>{capability.target}</code>
                    {capability.hosted && <span className="tag">Provider hosted</span>}
                  </div>
                  <div className="capability-location">
                    <code>
                      {capability.location.path}:{capability.location.line}
                    </code>
                  </div>
                  {!!capability.guards?.length && (
                    <p className="muted capability-guards">
                      Observed checks: {capability.guards.join(", ")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const pageSize = 20;
function InventoryCategory({ title, items }: { title: string; items: InventoryItem[] }) {
  const [query, setQuery] = useState("");
  const [framework, setFramework] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<InventoryItem | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const categoryRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const popupScrollbars = useElementScrollbars<HTMLDivElement>();
  const searchId = useId();
  const frameworkId = useId();
  const search = query.trim().toLowerCase();
  const frameworks = [
    ...new Set(items.map((item) => item.framework).filter((value): value is string => !!value)),
  ].sort();
  const filtered = items.filter(
    (item) =>
      (!framework || item.framework === framework) &&
      (!search ||
        [
          item.name,
          item.framework,
          item.location.path,
          `${item.location.line}:${item.location.column}`,
          item.description,
          item.prompt,
          ...item.rows.flat(),
          ...item.preview.flat(),
        ].some((value) => value?.toLowerCase().includes(search))),
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * pageSize;
  const visible = filtered.slice(start, start + pageSize);
  const hasFilters = !!search || !!framework;
  function changePage(nextPage: number) {
    setPage(nextPage);
    categoryRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }

  return (
    <div className="inventory-category" ref={categoryRef}>
      <div className="inventory-table-toolbar">
        <div className="inventory-category-title">
          <h3>{title}</h3>
          <span className="inventory-category-total">
            <MorphNumber value={filtered.length} />
          </span>
        </div>
        <label className="inventory-search" htmlFor={searchId}>
          <span className="sr-only">Search {title.toLowerCase()}</span>
          <span className="search-field">
            <Icon name="search" />
            <Input
              id={searchId}
              type="search"
              value={query}
              placeholder="Name, configuration, or file…"
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
          </span>
        </label>
        <label className="inventory-framework-filter" htmlFor={frameworkId}>
          <span className="sr-only">Filter {title.toLowerCase()} by framework</span>
          <Select
            id={frameworkId}
            value={framework}
            onValueChange={(value) => {
              setFramework(value);
              setPage(1);
            }}
            items={[
              { value: "", label: "All frameworks" },
              ...frameworks.map((value) => ({ value, label: value })),
            ]}
          />
        </label>
      </div>
      <p className="inventory-category-description muted">{descriptions[title]}</p>
      {filtered.length === 0 ? (
        <div className="inventory-empty">
          <span className="category-icon">
            <Icon name={hasFilters ? "search" : (icons[title] ?? "inventory")} />
          </span>
          <h4>{hasFilters ? "No matching declarations" : `No ${title.toLowerCase()} observed`}</h4>
          <p className="muted">
            {hasFilters
              ? "Try another search or framework."
              : "None found in the scanned source files."}
          </p>
          {hasFilters && (
            <Button
              className="button button-secondary"
              onClick={() => {
                setQuery("");
                setFramework("");
                setPage(1);
              }}
            >
              Clear filters
            </Button>
          )}
        </div>
      ) : (
        <table className="inventory-table" aria-label={`${title} declarations`}>
          <colgroup>
            <col className="inventory-name-column" />
            <col className="inventory-config-column" />
            <col className="inventory-source-column" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Declaration</th>
              <th scope="col" className="inventory-config-cell">
                Configuration
              </th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((item) => {
              const filenameStart = item.location.path.lastIndexOf("/") + 1;
              const openDetails = (button: HTMLButtonElement | null) => {
                returnFocus.current = button;
                setSelected(item);
                setDrawerOpen(true);
              };
              return (
                <tr
                  className="inventory-data-row"
                  data-selected={(drawerOpen && selected?.id === item.id) || undefined}
                  key={item.id}
                  onClick={(event) => {
                    openDetails(event.currentTarget.querySelector("button"));
                  }}
                >
                  <td className="inventory-name-cell">
                    <Button
                      className="inventory-row-trigger"
                      aria-haspopup="dialog"
                      aria-label={`View details for ${item.name}, ${item.location.path}:${item.location.line}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        openDetails(event.currentTarget);
                      }}
                    >
                      <span className="inventory-name-content">
                        <span className="inventory-item-name" title={item.name}>
                          {item.name}
                        </span>
                        {item.framework && (
                          <span className="inventory-framework">{item.framework}</span>
                        )}
                      </span>
                      <Icon name="chevron" />
                    </Button>
                    <div className="inventory-mobile-preview">
                      <Configuration item={item} />
                    </div>
                  </td>
                  <td className="inventory-config-cell">
                    <Configuration item={item} />
                  </td>
                  <td
                    className="inventory-source-cell"
                    title={`${item.location.path}:${item.location.line}:${item.location.column}`}
                  >
                    <code className="inventory-source-file">
                      {item.location.path.slice(filenameStart)}:{item.location.line}
                    </code>
                    {filenameStart > 0 && (
                      <code className="inventory-source-directory">
                        {item.location.path.slice(0, filenameStart)}
                      </code>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="inventory-table-controls">
        <p className="count-label" role="status">
          {filtered.length === 0 ? (
            "0 declarations"
          ) : (
            <>
              <MorphNumber value={start + 1} />–<MorphNumber value={start + visible.length} /> of{" "}
              <MorphNumber value={filtered.length} />{" "}
              {filtered.length === 1 ? "declaration" : "declarations"}
            </>
          )}
        </p>
        <nav className="inventory-pagination" aria-label={`${title} pages`}>
          <Button
            className="button button-secondary"
            disabled={currentPage === 1}
            onClick={() => changePage(currentPage - 1)}
          >
            <Icon name="chevron" className="previous-page-icon" />
            Previous
          </Button>
          <span className="count-label">
            <MorphNumber value={currentPage} /> / <MorphNumber value={pageCount} />
          </span>
          <Button
            className="button button-secondary"
            disabled={currentPage === pageCount}
            onClick={() => changePage(currentPage + 1)}
          >
            Next
            <Icon name="chevron" />
          </Button>
        </nav>
      </div>
      <Drawer.Root
        direction="right"
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        autoFocus
        repositionInputs={false}
      >
        <Drawer.Portal>
          <Drawer.Overlay className="inventory-drawer-overlay" />
          <Drawer.Content
            className="inventory-detail-panel"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              returnFocus.current?.focus({ preventScroll: true });
            }}
          >
            <div className="inventory-detail-heading">
              <div>
                <p className="eyebrow">{title} · Declaration details</p>
                <Drawer.Title>{selected?.name}</Drawer.Title>
                <Drawer.Description className="muted">
                  {selected?.framework ?? "Observed in source"}
                </Drawer.Description>
              </div>
              <Drawer.Close asChild>
                <Button className="icon-button" aria-label="Close declaration details">
                  <Icon name="close" />
                </Button>
              </Drawer.Close>
            </div>
            <div
              className="inventory-detail-scroll"
              ref={popupScrollbars}
              data-overlayscrollbars-initialize=""
              data-vaul-no-drag
            >
              {selected && <InventoryDetails item={selected} />}
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    </div>
  );
}

export function InventoryBrowser({
  categories,
  initialCategory,
}: {
  categories: { title: string; items: InventoryItem[] }[];
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

import { useId, useRef, useState } from "react";
import { DetailDrawer } from "../shared/DetailDrawer.tsx";
import { EmptyState } from "../shared/EmptyState.tsx";
import { plural } from "../shared/format.ts";
import { Icon, type IconName } from "../shared/icons.tsx";
import { MorphNumber } from "../shared/MorphNumber.tsx";
import { Pagination, usePagination } from "../shared/Pagination.tsx";
import { SearchField } from "../shared/SearchField.tsx";
import { Button, Select } from "../shared/ui.tsx";
import { InventoryDetails } from "./InventoryDetails.tsx";
import type { InventoryItem } from "./inventory-items.ts";

export const icons: Record<string, IconName> = {
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
  Models: "Provider clients and model configuration.",
  Agents: "Agent declarations and their linked tools.",
  Tools: "Functions available to agents.",
  "LLM calls": "Model invocations observed in source.",
  "Entry points": "HTTP and MCP request handlers.",
  "MCP servers": "Tools and resources exposed through MCP.",
  "MCP clients": "Connections to external MCP servers.",
  "Data stores": "Storage and retrieval integrations.",
  Prompts: "System, user, and template instructions.",
};

function Configuration({ item }: { item: InventoryItem }) {
  return (
    <div className="inventory-config-chips">
      {item.preview.map(([label, value]) => (
        <span className="inventory-config-chip" key={label} title={`${label}: ${value}`}>
          {label === "Tools" && item.toolCount !== undefined ? (
            `${item.toolCount} ${plural(item.toolCount, "tool")}`
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

const pageSize = 20;
export function InventoryCategory({ title, items }: { title: string; items: InventoryItem[] }) {
  const [query, setQuery] = useState("");
  const [framework, setFramework] = useState("");
  const [selected, setSelected] = useState<InventoryItem | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const categoryRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
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
  const pagination = usePagination(filtered, pageSize);
  const hasFilters = !!search || !!framework;
  function changePage(nextPage: number) {
    pagination.goTo(nextPage);
    categoryRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }

  return (
    <div className="inventory-category" ref={categoryRef}>
      <div className="subnav-content-heading">
        <div>
          <h2>
            {title}{" "}
            <span className="tag">
              <MorphNumber value={items.length} />
            </span>
          </h2>
          <p className="muted">{descriptions[title]}</p>
        </div>
      </div>
      <div className="panel inventory-panel">
        <div className="inventory-toolbar">
          <label className="inventory-search" htmlFor={searchId}>
            <span className="sr-only">Search {title.toLowerCase()}</span>
            <SearchField
              as="span"
              id={searchId}
              value={query}
              placeholder="Name, configuration, or file…"
              onChange={(value) => {
                setQuery(value);
                pagination.reset();
              }}
            />
          </label>
          <label className="inventory-framework-filter" htmlFor={frameworkId}>
            <span className="sr-only">Filter {title.toLowerCase()} by framework</span>
            <Select
              id={frameworkId}
              value={framework}
              onValueChange={(value) => {
                setFramework(value);
                pagination.reset();
              }}
              items={[
                { value: "", label: "All frameworks" },
                ...frameworks.map((value) => ({ value, label: value })),
              ]}
            />
          </label>
        </div>
        {filtered.length === 0 ? (
          <EmptyState
            className="inventory-empty"
            icon={hasFilters ? "search" : (icons[title] ?? "inventory")}
            iconClassName="inventory-empty-symbol"
            title={hasFilters ? "No matching declarations" : `No ${title.toLowerCase()} observed`}
            titleLevel="h3"
            description={
              hasFilters
                ? "Try another search or framework."
                : "None found in the scanned source files."
            }
            descriptionClassName="muted"
          >
            {hasFilters && (
              <Button
                className="button button-secondary"
                onClick={() => {
                  setQuery("");
                  setFramework("");
                  pagination.reset();
                }}
              >
                Clear filters
              </Button>
            )}
          </EmptyState>
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
              {pagination.visible.map((item) => {
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
                <MorphNumber value={pagination.start + 1} />–<MorphNumber value={pagination.end} />{" "}
                of <MorphNumber value={filtered.length} /> {plural(filtered.length, "declaration")}
              </>
            )}
          </p>
          <Pagination
            page={pagination.page}
            pageCount={pagination.pageCount}
            label={`${title} pages`}
            onPageChange={changePage}
          />
        </div>
      </div>
      <DetailDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        className="inventory-detail-panel"
        headingClassName="inventory-detail-heading"
        eyebrow={<>{title} · Declaration details</>}
        title={selected?.name}
        description={selected?.framework ?? "Observed in source"}
        descriptionClassName="muted"
        closeLabel="Close declaration details"
        returnFocus={() => returnFocus.current}
      >
        {selected && <InventoryDetails item={selected} />}
      </DetailDrawer>
    </div>
  );
}

import { useState } from "react";
import { useSearchParams } from "react-router";

export type SortDirection = "ascending" | "descending";
export interface TableSort<Key extends string> {
  key: Key;
  direction: SortDirection;
}
/**
 * How each sortable column orders rows. `first` is the direction of the first click:
 * dates, counts and severity start with the largest, text with A.
 */
export type SortColumns<Item, Key extends string> = Record<
  Key,
  { value: (item: Item) => string | number | null; first?: SortDirection }
>;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** A stable sort; rows without a value stay last in both directions. */
export function sortRows<Item, Key extends string>(
  items: readonly Item[],
  columns: SortColumns<Item, Key>,
  sort: TableSort<Key> | null,
): Item[] {
  if (!sort) return [...items];
  const { value } = columns[sort.key];
  const sign = sort.direction === "ascending" ? 1 : -1;
  return items
    .map((item, index) => ({ item, index, key: value(item) }))
    .sort((a, b) => {
      if (a.key === null || b.key === null)
        return a.key === b.key ? a.index - b.index : a.key === null ? 1 : -1;
      const order =
        typeof a.key === "number" && typeof b.key === "number"
          ? a.key - b.key
          : collator.compare(String(a.key), String(b.key));
      return order === 0 ? a.index - b.index : order * sign;
    })
    .map(({ item }) => item);
}

/**
 * The sort of one table, kept in the `sort` search parameter (`-detected` is descending)
 * so it survives opening a row and coming back. A page that paginates calls this too and
 * sorts the whole list before slicing it; both read the same parameter. With a `null`
 * fallback the rows keep their given order until a column is chosen.
 */
export function useTableSort<Item, Key extends string>(
  columns: SortColumns<Item, Key>,
  fallback: TableSort<Key> | null,
) {
  const [params, setParams] = useSearchParams();
  const raw = params.get("sort") ?? "";
  const key = raw.replace(/^-/, "");
  const sort: TableSort<Key> | null = Object.hasOwn(columns, key)
    ? { key: key as Key, direction: raw.startsWith("-") ? "descending" : "ascending" }
    : fallback;
  function toggle(next: Key) {
    const direction: SortDirection =
      sort?.key === next
        ? sort.direction === "ascending"
          ? "descending"
          : "ascending"
        : (columns[next].first ?? "ascending");
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        if (fallback && next === fallback.key && direction === fallback.direction)
          updated.delete("sort");
        else updated.set("sort", `${direction === "descending" ? "-" : ""}${next}`);
        return updated;
      },
      { replace: true },
    );
  }
  return {
    sort,
    toggle,
    apply: (items: readonly Item[]) => sortRows(items, columns, sort),
  };
}

/** Calls `reset` when the sort changes, so a paginated list starts again on page one. */
export function useSortReset(sort: TableSort<string> | null, reset: () => void) {
  const key = sort ? `${sort.direction}:${sort.key}` : "";
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    reset();
  }
}

/** A column header that sorts its table; the sorted column carries `aria-sort`. */
export function SortHeader<Key extends string>({
  column,
  sort,
  onSort,
  className,
  children,
}: {
  column: Key;
  sort: TableSort<Key> | null;
  onSort: (column: Key) => void;
  className?: string;
  children: string;
}) {
  const active = sort?.key === column;
  return (
    <th scope="col" className={className} {...(active ? { "aria-sort": sort.direction } : {})}>
      <button type="button" className="table-sort" onClick={() => onSort(column)}>
        {children}
        <span className="table-sort-icon" aria-hidden="true">
          {active ? (sort.direction === "ascending" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}

import { useCallback, useState } from "react";
import { Icon } from "./icons.tsx";
import { MorphNumber } from "./MorphNumber.tsx";
import { Button } from "./ui.tsx";

/** One-based paging over a filtered list; the page clamps when the list shrinks. */
export function usePagination<T>(items: T[], pageSize: number) {
  const [requested, goTo] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(requested, pageCount);
  const start = (page - 1) * pageSize;
  const end = Math.min(start + pageSize, items.length);
  const reset = useCallback(() => goTo(1), []);
  return { page, pageCount, start, end, visible: items.slice(start, end), goTo, reset };
}

export function Pagination({
  page,
  pageCount,
  label,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  label: string;
  onPageChange: (page: number) => void;
}) {
  return (
    <nav className="inventory-pagination" aria-label={label}>
      <Button
        className="button button-secondary"
        disabled={page === 1}
        onClick={() => onPageChange(page - 1)}
      >
        <Icon name="chevron" className="previous-page-icon" /> Previous
      </Button>
      <span className="count-label">
        <MorphNumber value={page} /> / <MorphNumber value={pageCount} />
      </span>
      <Button
        className="button button-secondary"
        disabled={page === pageCount}
        onClick={() => onPageChange(page + 1)}
      >
        Next <Icon name="chevron" />
      </Button>
    </nav>
  );
}

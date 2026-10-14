"use client";

import * as React from "react";
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from "lucide-react";

// Tester feedback (Carly's prototype review, item 18, Slide 9: "Number of
// Records" — All Apps View / list screens): page size needs to support up
// to 100 records, was capped at 50. Shared by every screen that paginates
// via usePagination()/PaginationFooter below, so this one array covers all
// of them at once.
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export function usePagination<T>(items: T[], initialPageSize = 10) {
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(initialPageSize);

  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const clampedPage = Math.min(page, pageCount);

  // Reset to page 1 whenever the underlying item count shrinks below the current page,
  // e.g. after a search filter narrows the result set. Adjusted during render
  // (React's documented pattern) rather than in an effect.
  if (page > pageCount) setPage(1);

  const start = (clampedPage - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);

  return {
    pageItems,
    page: clampedPage,
    pageCount,
    pageSize,
    total: items.length,
    setPage,
    setPageSize: (n: number) => {
      setPageSize(n);
      setPage(1);
    },
  };
}

export function PaginationFooter({
  page,
  pageCount,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  onPageChange: (p: number) => void;
  onPageSizeChange: (n: number) => void;
}) {
  return (
    <div className="mt-2 flex shrink-0 flex-wrap items-center justify-between gap-3 text-[12.5px] text-muted">
      <div className="flex items-center gap-2">
        <span>Show</span>
        <select
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          className="h-7 rounded-md border border-border-strong bg-surface px-1.5 text-[12.5px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span>Records{total > 0 ? ` (${total} total)` : ""}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <PagerButton disabled={page <= 1} onClick={() => onPageChange(1)} label="First page">
          <ChevronFirst className="h-3.5 w-3.5" />
        </PagerButton>
        <PagerButton disabled={page <= 1} onClick={() => onPageChange(page - 1)} label="Previous page">
          <ChevronLeft className="h-3.5 w-3.5" />
        </PagerButton>
        <span className="tabular-nums px-1">
          {page} / {pageCount}
        </span>
        <PagerButton disabled={page >= pageCount} onClick={() => onPageChange(page + 1)} label="Next page">
          <ChevronRight className="h-3.5 w-3.5" />
        </PagerButton>
        <PagerButton disabled={page >= pageCount} onClick={() => onPageChange(pageCount)} label="Last page">
          <ChevronLast className="h-3.5 w-3.5" />
        </PagerButton>
      </div>
    </div>
  );
}

function PagerButton({
  disabled,
  onClick,
  label,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border-strong bg-surface text-foreground hover:bg-accent-bg disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

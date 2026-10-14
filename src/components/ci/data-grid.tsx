"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, RotateCw, Search, X } from "lucide-react";
import { Table, TableWrap, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { PaginationFooter, usePagination } from "@/components/ui/pagination";
import { ColumnsMenu } from "@/components/ci/columns-menu";
import { cn } from "@/lib/utils";

export interface GridColumn<T> {
  key: string;
  label: string;
  /** CI Prototype: dropdown filter for list columns, text filter for the rest; null = no filter. */
  filter: "select" | "text" | null;
  numeric?: boolean;
  /** Text used for display, filtering, search and (unless numeric) sorting. */
  value: (row: T) => string;
  /** Raw value for numeric / date sorting. */
  sortValue?: (row: T) => number;
  render?: (row: T) => React.ReactNode;
}

export type SortState = { key: string; dir: 1 | -1 } | null;

// The white pill filter control inside each purple
// header cell — reused here for both the dropdown and the text variant.
const FILTER_CONTROL =
  "w-full max-w-[8.5rem] rounded border px-1 py-0.5 text-[10px] font-normal normal-case focus:outline-none";
const filterTone = (active: boolean) =>
  active ? "border-accent bg-white text-foreground font-semibold" : "border-white/50 bg-white/90 text-muted-2";

function HeaderCell<T>({
  column,
  options,
  filterValue,
  onFilter,
  sort,
  onSort,
}: {
  column: GridColumn<T>;
  options: string[];
  filterValue: string;
  onFilter: (key: string, value: string) => void;
  sort: SortState;
  onSort: (key: string) => void;
}) {
  const sorted = sort?.key === column.key ? sort.dir : 0;
  const SortIcon = sorted === 1 ? ArrowUp : sorted === -1 ? ArrowDown : ArrowUpDown;
  return (
    <TH className="max-w-none overflow-visible whitespace-normal" aria-sort={sorted === 1 ? "ascending" : sorted === -1 ? "descending" : "none"}>
      <div className="flex flex-col gap-1">
        {/* BRD §7.1 / CI Prototype: sort by clicking the column header. */}
        <button
          type="button"
          onClick={() => onSort(column.key)}
          title={`Sort by ${column.label}`}
          className="inline-flex max-w-[8.5rem] items-center gap-1 text-left font-bold"
        >
          <span className="truncate">{column.label}</span>
          <SortIcon className={cn("h-3 w-3 shrink-0", sorted ? "opacity-100" : "opacity-50")} />
        </button>
        {column.filter === "select" && (
          <select
            value={filterValue || "All"}
            onChange={(e) => onFilter(column.key, e.target.value === "All" ? "" : e.target.value)}
            aria-label={`Filter by ${column.label}`}
            className={cn(FILTER_CONTROL, "cursor-pointer", filterTone(Boolean(filterValue)))}
          >
            <option value="All">All</option>
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        )}
        {column.filter === "text" && (
          <input
            value={filterValue}
            onChange={(e) => onFilter(column.key, e.target.value)}
            placeholder="Filter"
            aria-label={`Filter by ${column.label}`}
            className={cn(FILTER_CONTROL, filterTone(Boolean(filterValue)))}
          />
        )}
      </div>
    </TH>
  );
}

/**
 * The CI grid — the shared table look and toolbar (search, Reload, Clear
 * filters, Show Columns, pagination footer) with the CI Prototype / BRD §7.1
 * behaviour: a filter on every column and sort by header. Low data volume
 * (BRD §9) means filtering, sorting and paging run in the browser over the
 * complete in-scope dataset, so Export always gets every matching row.
 */
export function DataGrid<T>({
  columns,
  rows,
  rowKey,
  actions,
  actionsLabel = "",
  actionsAt = "start",
  toolbar,
  emptyState,
  loading,
  onReload,
  defaultSort = null,
  searchText,
  searchPlaceholder = "Search…",
}: {
  columns: GridColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  actions?: (row: T) => React.ReactNode;
  /** Heading of the actions column (empty by default). */
  actionsLabel?: string;
  /** Which side the actions column sits on (default: the start). */
  actionsAt?: "start" | "end";
  /**
   * Left-aligned toolbar content; receives every row currently matching search +
   * filters, and the columns currently shown (Show Columns), in display order.
   */
  toolbar?: (filtered: T[], shownColumns: GridColumn<T>[]) => React.ReactNode;
  /** Shown instead of the table when there's nothing to show at all (e.g. database not connected). */
  emptyState?: React.ReactNode;
  loading?: boolean;
  onReload?: () => void;
  defaultSort?: SortState;
  /** Extra text a row should match in keyword search (e.g. its Record ID). */
  searchText?: (row: T) => string;
  searchPlaceholder?: string;
}) {
  const [search, setSearch] = React.useState("");
  const [filters, setFilters] = React.useState<Record<string, string>>({});
  const [sort, setSort] = React.useState<SortState>(defaultSort);
  const [visible, setVisible] = React.useState<Set<string>>(() => new Set(columns.map((c) => c.key)));

  const shownColumns = columns.filter((c) => visible.has(c.key));
  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  const options = React.useMemo(() => {
    const map = new Map<string, string[]>();
    for (const c of columns) {
      if (c.filter !== "select") continue;
      const set = new Set(rows.map((r) => c.value(r)).filter((v) => v !== ""));
      map.set(c.key, Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
    }
    return map;
  }, [columns, rows]);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = rows.filter((r) => {
      for (const c of columns) {
        const f = filters[c.key];
        if (!f) continue;
        const v = c.value(r);
        if (c.filter === "select" ? v !== f : !v.toLowerCase().includes(f.toLowerCase())) return false;
      }
      if (!q) return true;
      return columns.some((c) => c.value(r).toLowerCase().includes(q)) || (searchText?.(r).toLowerCase().includes(q) ?? false);
    });
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col) {
        out.sort((a, b) => {
          const cmp = col.sortValue
              ? col.sortValue(a) - col.sortValue(b)
              : col.value(a).localeCompare(col.value(b), undefined, { numeric: true });
          return cmp * sort.dir;
        });
      }
    }
    return out;
  }, [rows, columns, filters, search, sort, searchText]);

  const { pageItems, page, pageCount, pageSize, total, setPage, setPageSize } = usePagination(filtered, 100);

  function onFilter(key: string, value: string) {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  }

  function onSort(key: string) {
    setSort((s) => (s?.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
    setPage(1);
  }

  function reload() {
    setSearch("");
    setFilters({});
    setPage(1);
    onReload?.();
  }

  const colSpan = shownColumns.length + (actions ? 1 : 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-2">{toolbar?.(filtered, shownColumns)}</div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative w-[220px] shrink-0 sm:w-[260px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-2" />
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder={searchPlaceholder}
              aria-label="Search"
              className="h-7 w-full rounded-md border border-border-strong bg-surface pl-8 pr-2.5 text-[12.5px] text-foreground focus:border-accent focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={reload}
            title="Reload"
            aria-label="Reload"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border-strong bg-surface text-muted transition-colors hover:bg-accent-bg hover:text-accent"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={() => setFilters({})}
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12.5px] font-medium text-muted hover:text-danger"
            >
              <X className="h-3.5 w-3.5" /> Clear filters ({activeFilterCount})
            </button>
          )}
          <ColumnsMenu columns={columns} visible={visible} onChange={setVisible} />
        </div>
      </div>

      {loading && <div className="mb-1.5 shrink-0 text-[13px] text-muted">Loading…</div>}

      {emptyState && !loading ? (
        <TableWrap>{emptyState}</TableWrap>
      ) : (
        <>
          <TableWrap scroll>
            <Table>
              <THead>
                <TR>
                  {actions && actionsAt === "start" && <TH>{actionsLabel}</TH>}
                  {shownColumns.map((c) => (
                    <HeaderCell
                      key={c.key}
                      column={c}
                      options={options.get(c.key) ?? []}
                      filterValue={filters[c.key] ?? ""}
                      onFilter={onFilter}
                      sort={sort}
                      onSort={onSort}
                    />
                  ))}
                  {actions && actionsAt === "end" && <TH>{actionsLabel}</TH>}
                </TR>
              </THead>
              <TBody>
                {pageItems.map((r) => (
                  <TR key={rowKey(r)}>
                    {actions && actionsAt === "start" && <TD>{actions(r)}</TD>}
                    {shownColumns.map((c) => (
                      <TD key={c.key} className={cn(c.numeric && "tabular-nums")}>
                        {c.render ? c.render(r) : c.value(r) || <span className="text-muted-2">—</span>}
                      </TD>
                    ))}
                    {actions && actionsAt === "end" && <TD>{actions(r)}</TD>}
                  </TR>
                ))}
                {!loading && pageItems.length === 0 && (
                  <TR>
                    <TD colSpan={Math.max(colSpan, 1)} className="py-10 text-center text-muted">
                      {rows.length === 0 ? "No rows yet." : "No rows match the current filters."}
                    </TD>
                  </TR>
                )}
              </TBody>
            </Table>
          </TableWrap>
          <PaginationFooter
            page={page}
            pageCount={pageCount}
            pageSize={pageSize}
            total={total}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </>
      )}
    </div>
  );
}

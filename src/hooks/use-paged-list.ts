"use client";

import * as React from "react";

/** What a server-paginated list endpoint returns. */
export interface PageResult<T> {
  items: T[];
  total: number;
}

export interface PagedQuery {
  limit: number;
  offset: number;
}

/**
 * Server-side paging for when a CI
 * list is too large to load in full (today the CI grids load every in-scope
 * row — BRD §9 low volume). Not used yet.
 *
 *  - every filter/sort change resets to the first page;
 *  - a response that arrives after a newer request was sent is ignored
 *    (request-id guard), so fast typing never shows stale rows;
 *  - if rows disappear and the current page no longer exists, it moves to
 *    the last valid page.
 */
export function usePagedList<T, Q extends PagedQuery>(fetchPage: (query: Q) => Promise<PageResult<T>>, initialQuery: Q) {
  const fetchRef = React.useRef(fetchPage);
  React.useEffect(() => {
    fetchRef.current = fetchPage;
  });

  const [query, setQuery] = React.useState<Q>(initialQuery);
  const [items, setItems] = React.useState<T[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const requestIdRef = React.useRef(0);

  const load = React.useCallback(async (q: Q) => {
    const requestId = ++requestIdRef.current;
    try {
      const page = await fetchRef.current(q);
      if (requestId !== requestIdRef.current) return;
      setItems(page.items);
      setTotal(page.total);
      setError(null);
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      setItems([]);
      setTotal(0);
      setError(e);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load(query);
  }, [load, query]);

  const pageCount = Math.max(1, Math.ceil(total / query.limit));
  const page = Math.floor(query.offset / query.limit) + 1;
  const lastValidOffset = (pageCount - 1) * query.limit;
  if (total > 0 && query.offset > lastValidOffset) {
    // Adjusting state during render (React's documented pattern) instead of in an effect.
    setQuery((q) => ({ ...q, offset: lastValidOffset }));
  }

  const setPage = React.useCallback((p: number) => {
    setLoading(true);
    setQuery((q) => ({ ...q, offset: Math.max(0, (p - 1) * q.limit) }));
  }, []);
  const setPageSize = React.useCallback((limit: number) => {
    setLoading(true);
    setQuery((q) => ({ ...q, limit, offset: 0 }));
  }, []);
  const setFilters = React.useCallback((patch: Partial<Omit<Q, "limit" | "offset">>) => {
    setLoading(true);
    setQuery((q) => ({ ...q, ...patch, offset: 0 }));
  }, []);
  const refresh = React.useCallback(() => {
    setLoading(true);
    void load(query);
  }, [load, query]);

  return { items, total, loading, error, query, page, pageSize: query.limit, pageCount, setPage, setPageSize, setFilters, refresh };
}

/**
 * Every row matching a query, fetched page by page from a paginated endpoint
 * (for Export, so it never exports only the visible page).
 */
export async function fetchAllPages<T, Q extends PagedQuery>(
  fetchPage: (query: Q) => Promise<PageResult<T>>,
  query: Omit<Q, "limit" | "offset">,
  pageSize = 200
): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await fetchPage({ ...query, limit: pageSize, offset } as Q);
    all.push(...page.items);
    if (offset + pageSize >= page.total || page.items.length === 0) break;
  }
  return all;
}

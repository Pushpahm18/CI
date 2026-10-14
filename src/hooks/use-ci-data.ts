"use client";

import * as React from "react";
import { ApiError, isNotConfigured } from "@/lib/ci/api";

interface State<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
}

/**
 * Loads one CI API resource once on mount and tracks the three states every
 * CI screen distinguishes: loading, "CI database table configuration is pending", and a
 * real error. `reload()` re-fetches on demand (Reload buttons, after a save).
 */
export function useCiData<T>(load: () => Promise<T>) {
  const loadRef = React.useRef(load);
  React.useEffect(() => {
    loadRef.current = load;
  });
  const [state, setState] = React.useState<State<T>>({ data: null, error: null, loading: true });

  const fetchOnce = React.useCallback(
    (): Promise<Omit<State<T>, "loading">> =>
      loadRef.current().then(
        (data) => ({ data, error: null }),
        (error: unknown) => ({ data: null, error })
      ),
    []
  );

  React.useEffect(() => {
    let cancelled = false;
    void fetchOnce().then((result) => {
      if (!cancelled) setState({ ...result, loading: false });
    });
    return () => {
      cancelled = true;
    };
  }, [fetchOnce]);

  const reload = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    const result = await fetchOnce();
    setState({ ...result, loading: false });
  }, [fetchOnce]);

  /** Re-fetches in the background: the current data stays on screen (no "Loading…"), and is replaced when the fresh data arrives. */
  const refresh = React.useCallback(async () => {
    const result = await fetchOnce();
    setState((s) => (result.error ? s : { data: result.data, error: null, loading: false }));
  }, [fetchOnce]);

  /** Updates the loaded data in place (used right after the server has confirmed a save, so the screen changes at once). */
  const mutate = React.useCallback((update: (current: T) => T) => {
    setState((s) => (s.data === null ? s : { ...s, data: update(s.data) }));
  }, []);

  const { data, error, loading } = state;
  return {
    data,
    loading,
    error,
    notConfigured: isNotConfigured(error),
    /** Names of the CI tables whose configuration is still pending (from the server's NOT_CONFIGURED details). */
    pendingTables: error instanceof ApiError && isNotConfigured(error) ? error.details : [],
    errorMessage: error && !isNotConfigured(error) ? (error instanceof Error ? error.message : "Failed to load.") : null,
    reload,
    refresh,
    mutate,
  };
}

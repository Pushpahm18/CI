"use client";

import * as React from "react";

/**
 * Delays reflecting `value` until it stops changing for `delayMs` — the
 * search box itself stays instantly responsive (bound directly to the raw,
 * un-debounced state), only the value handed to the server query or filter
 * is delayed. A Databricks round trip can take several
 * seconds, so sending a server-side search on every keystroke fired many
 * overlapping requests whose responses could arrive out of order. Debouncing
 * (plus usePagedList's ignore-stale-response guard) means one request per
 * pause in typing.
 */
export function useDebouncedValue<T>(value: T, delayMs = 400): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

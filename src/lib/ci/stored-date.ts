/**
 * Display format for the stored created / modified dates in the grids, dd-mmm-yyyy as in the CI Prototype: 06-Jan-2024 (the time is
 * left out unless asked for: 06-Jan-2024 14:30). Only the text shown changes; the stored value is untouched. The date and time are read from the stored
 * text itself (the UTC date and time Databricks returns, e.g. 2024-01-06T00:00:00.000Z), with no time-zone shift, so the day never
 * moves. A value that is not a recognisable date is returned exactly as stored.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// 2024-01-06 | 2024-01-06T00:00:00(.000)(Z) | 2024-01-06 14:30:05
const STORED = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]00:?00)?$/;

export function formatStoredDate(stored: string, withTime = false): string {
  const m = String(stored ?? "").trim().match(STORED);
  if (!m) return stored;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return stored;
  const date = `${m[3]}-${MONTHS[month - 1]}-${m[1]}`;
  return withTime && m[4] !== undefined ? `${date} ${m[4]}:${m[5]}` : date;
}

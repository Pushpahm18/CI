/**
 * Generic value converters for mapping Databricks rows to application models
 * and back.
 *
 * The Statement Execution API (server/db/warehouse.ts) returns every value
 * as JSON (numbers and dates usually as strings, blanks as null), so each
 * table gets a pair of mapper functions built from these helpers:
 *
 *   rowToX(row)   Databricks row  -> application model (read path)
 *   xToRow(model) application model -> Databricks row  (write path, then
 *                 buildMerge()/buildInsert() in server/db/sql.ts)
 *
 * The CI table mappers (server/ci/databricks/mappers.ts) are written once
 * the real CI column names are known — see docs/ci-technical-reference.md.
 */

/** Trimmed string; `fallback` for null/undefined/blank. */
export function str(value: unknown, fallback = ""): string {
  if (value == null) return fallback;
  const s = String(value).trim();
  return s ? s : fallback;
}

/** Finite number; `fallback` for null/blank/non-numeric. */
export function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return value !== null && value !== "" && Number.isFinite(n) ? n : fallback;
}

/** Finite number, or null when blank/non-numeric (for nullable numeric columns). */
export function numOrNull(value: unknown): number | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** ISO timestamp; `fallback` when the stored value is blank or not a parseable date. */
export function iso(value: unknown, fallback: string): string {
  if (value instanceof Date) return value.toISOString();
  const s = str(value);
  if (!s) return fallback;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

/** Date-only "YYYY-MM-DD"; `fallback` when blank or unparseable. */
export function isoDate(value: unknown, fallback = ""): string {
  const s = iso(value, "");
  return s ? s.slice(0, 10) : fallback;
}

/** Splits a comma-separated stored list ("Micron, SK Hynix") into trimmed, non-empty values. */
export function splitList(raw: unknown): string[] {
  return str(raw)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * A stored scope column -> "All" or a list. "All" (any casing) is All; a
 * blank value is All only when `emptyMeansAll` — otherwise it's no access,
 * so a missing value can never widen what a user can see.
 */
export function scopeFromText(value: unknown, emptyMeansAll = false): string[] | "All" {
  const v = str(value);
  if (!v) return emptyMeansAll ? "All" : [];
  if (v.toLowerCase() === "all") return "All";
  return splitList(v);
}

/** The reverse of scopeFromText(): "All" or a comma-separated list. */
export function scopeToText(scope: string[] | "All"): string {
  return scope === "All" ? "All" : scope.join(", ");
}

/**
 * A text-typed active/inactive flag: "true" = active, "false" = inactive,
 * with "1"/"inactive"/"no" also treated as inactive for rows still holding an
 * older representation — the exact rule of SAMBA's isInactiveFlag()
 * (src/server/db/mappers.ts). Anything else, including blank, is active.
 */
export function isInactiveFlag(value: unknown): boolean {
  const s = str(value).toLowerCase();
  return s === "1" || s === "false" || s === "inactive" || s === "no";
}

/** Serialises structured data (e.g. an audit entry's field changes) into one STRING column. */
export function toJsonColumn(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

/** Reads a JSON STRING column back; `fallback` for blank or non-JSON text (never throws). */
export function fromJsonColumn<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

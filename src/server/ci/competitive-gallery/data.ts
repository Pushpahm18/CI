import type { AccountScope, ScopeSetting } from "@/server/ci/authorization/scope";
import { qCol, qTable, sqlLiteral } from "@/server/db/sql";
import type { GalleryColumn } from "@/types/ci-api";

/** Rows the gallery loads at most (BRD §9: low volume). One extra is read to detect truncation. */
export const GALLERY_ROW_LIMIT = 5000;

/** Read-only: lists the table's real columns. The table name is a validated server constant. */
export function buildDescribeStatement(table: string): string {
  return `DESCRIBE TABLE ${qTable(table)}`;
}

export interface ScopeColumns {
  customer: string;
  segment: string;
  region: string;
}

/**
 * Read-only: every column, no assumed names, no ORDER BY (the order column is
 * unknown). With a scope (Account Team) the query itself is limited to rows
 * whose Customer AND Segment AND Region are all listed; the values are escaped
 * with sqlLiteral and the column names are validated server constants.
 */
/**
 * The WHERE predicates of an Account Team scope: a dimension set to All adds none; a list adds  column IN (...)
 * (values escaped with sqlLiteral, column names are validated server constants). No scope -> no predicates.
 */
export function scopePredicates(filter?: { columns: ScopeColumns; scope: AccountScope }): string[] {
  const predicate = (column: string, setting: ScopeSetting) => (setting === "All" ? null : `${qCol(column)} IN (${setting.map((v) => sqlLiteral(v)).join(", ")})`);
  return filter
    ? [predicate(filter.columns.customer, filter.scope.customers), predicate(filter.columns.segment, filter.scope.segments), predicate(filter.columns.region, filter.scope.regions)].filter((p): p is string => p !== null)
    : [];
}

export function buildSelectStatement(
  table: string,
  limit = GALLERY_ROW_LIMIT,
  filter?: { columns: ScopeColumns; scope: AccountScope },
  /** SQL ORDER BY expression, built from validated server constants only (see newestFirstOrder). */
  orderBy?: string
): string {
  const predicates = scopePredicates(filter);
  const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
  const order = orderBy ? ` ORDER BY ${orderBy}` : "";
  return `SELECT * FROM ${qTable(table)}${where}${order} LIMIT ${Math.trunc(limit) + 1}`;
}

/** Most recently created-or-modified first (same stamp as the Home "recent" list), ties broken by row id so the order is stable. */
export function newestFirstOrder(columns: { modifiedOn: string; createdOn: string; recordId: string }): string {
  const stamp = `COALESCE(${qCol(columns.modifiedOn)}, CAST(${qCol(columns.createdOn)} AS TIMESTAMP))`;
  return `${stamp} DESC, ${qCol(columns.recordId)} DESC`;
}

/**
 * DESCRIBE returns col_name / data_type / comment rows, then (for partitioned
 * tables) a blank row and "# Partition Information" sections. Only the leading
 * block is the column list.
 */
export function parseDescribe(rows: Record<string, unknown>[]): GalleryColumn[] {
  const columns: GalleryColumn[] = [];
  for (const row of rows) {
    const name = String(row.col_name ?? "").trim();
    if (!name || name.startsWith("#")) break;
    columns.push({ name, type: String(row.data_type ?? "").trim() });
  }
  return columns;
}

function toText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Keeps exactly the described columns, every value as text. */
export function toGalleryRow(row: Record<string, unknown>, columns: GalleryColumn[]): Record<string, string> {
  return Object.fromEntries(columns.map((c) => [c.name, toText(row[c.name])]));
}


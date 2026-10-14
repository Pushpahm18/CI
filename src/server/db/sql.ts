import { executeQuery, executeStatement } from "@/server/db/warehouse";

/**
 * Generic, server-only SQL building blocks for Databricks SQL. The CI
 * Databricks repository builds
 * its statements from these — see docs/ci-technical-reference.md.
 *
 * Statements are sent as plain SQL text through warehouse.ts (the Statement
 * Execution API), so EVERY value must go through sqlLiteral() and every
 * column name through qCol(). Never concatenate raw user input into SQL.
 */

/** Quotes a column / identifier with backticks (any backtick inside is stripped). */
export function qCol(name: string): string {
  return `\`${name.replace(/`/g, "")}\``;
}

/**
 * Quotes a fully-qualified table name (catalog.schema.table), each part
 * backtick-quoted. Table names come from server config, never from a request.
 */
export function qTable(fullName: string): string {
  return fullName.split(".").map(qCol).join(".");
}

/** A fragment of SQL that sqlLiteral() passes through unchanged. Only ever built by helpers in this file from validated input. */
export class SqlRaw {
  constructor(readonly sql: string) {}
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/** CAST('2026-10-12T09:00:00.000Z' AS TIMESTAMP) — an explicit cast, so a TIMESTAMP column never depends on implicit string conversion. */
export function tsLiteral(iso: string): SqlRaw {
  if (!ISO_TIMESTAMP.test(iso)) throw new Error("Invalid timestamp.");
  return new SqlRaw(`CAST('${iso}' AS TIMESTAMP)`);
}

/** Renders a value as a SQL literal: NULL, number, TRUE/FALSE, or a single-quoted string with quotes escaped. */
export function sqlLiteral(value: unknown): string {
  if (value instanceof SqlRaw) return value.sql;
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** `col IN ('a', 'b')` — or a never-true predicate for an empty list (so it can't widen a query). */
export function sqlIn(column: string, values: readonly unknown[]): string {
  if (values.length === 0) return "1 = 0";
  return `${qCol(column)} IN (${values.map(sqlLiteral).join(", ")})`;
}

/**
 * A filter value counts only if it's a real, non-blank selection that isn't
 * the dropdown's own "All" sentinel — so "All" never reaches a WHERE clause
 * as `col = 'All'` (which matches nothing).
 */
export function isActiveFilterValue(value: string | undefined | null): value is string {
  if (value == null) return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.toLowerCase() !== "all";
}

/** Joins WHERE predicates with AND; "" when there are none. */
export function whereClause(predicates: string[]): string {
  return predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
}

/**
 * Upsert one row by its primary key (Delta MERGE). Never deletes or
 * truncates: it updates the matching row in place or inserts it, so a save
 * can't wipe rows it didn't touch. `insertOnly` columns (e.g. CreatedOn,
 * CreatedBy) are written on INSERT only, so an edit can never overwrite a
 * value that must be set once, at creation.
 */
export function buildMerge(
  table: string,
  pk: string,
  row: Record<string, unknown>,
  insertOnly?: Record<string, unknown>
): string {
  return buildMergeMany(table, pk, [row], insertOnly ? [insertOnly] : undefined);
}

/**
 * The batch form of buildMerge(): ONE MERGE statement for many rows, so the
 * whole batch is applied or none of it is (CI Import's all-or-nothing rule).
 * Every row must have the same columns.
 */
export function buildMergeMany(
  table: string,
  pk: string,
  rows: Record<string, unknown>[],
  insertOnly?: Record<string, unknown>[]
): string {
  if (rows.length === 0) throw new Error(`MERGE into ${table} needs at least one row`);
  const cols = Object.keys(rows[0]);
  if (!cols.includes(pk)) throw new Error(`MERGE into ${table} requires primary key ${pk}`);
  const insertOnlyCols = insertOnly?.[0] ? Object.keys(insertOnly[0]) : [];
  const allCols = [...cols, ...insertOnlyCols];

  const sourceRows = rows.map((row, i) => {
    const values = allCols.map((c) => `${sqlLiteral(cols.includes(c) ? row[c] : insertOnly![i]?.[c])} AS ${qCol(c)}`);
    return `SELECT ${values.join(", ")}`;
  });
  const updateSet = cols
    .filter((c) => c !== pk)
    .map((c) => `t.${qCol(c)} = s.${qCol(c)}`)
    .join(", ");
  const matchedClause = updateSet ? `WHEN MATCHED THEN UPDATE SET ${updateSet}` : "";
  return `MERGE INTO ${qTable(table)} AS t
    USING (${sourceRows.join(" UNION ALL ")}) AS s
    ON t.${qCol(pk)} = s.${qCol(pk)}
    ${matchedClause}
    WHEN NOT MATCHED THEN INSERT (${allCols.map(qCol).join(", ")}) VALUES (${allCols.map((c) => `s.${qCol(c)}`).join(", ")})`;
}

/** Append-only insert of one or more rows (audit trail, change notes). */
export function buildInsert(table: string, rows: Record<string, unknown>[]): string {
  if (rows.length === 0) throw new Error(`INSERT into ${table} needs at least one row`);
  const cols = Object.keys(rows[0]);
  const values = rows.map((r) => `(${cols.map((c) => sqlLiteral(r[c])).join(", ")})`).join(", ");
  return `INSERT INTO ${qTable(table)} (${cols.map(qCol).join(", ")}) VALUES ${values}`;
}

/** `DELETE … WHERE key IN (…)` — used only to undo this request's own partial writes (see withCompensation()). */
export function buildDeleteByKeys(table: string, keyColumn: string, keys: readonly unknown[]): string {
  return `DELETE FROM ${qTable(table)} WHERE ${sqlIn(keyColumn, keys)}`;
}

/** A `LIMIT … OFFSET …` page, clamped to sane bounds (default 100, max 200). */
export function pageClause(limit: number | undefined, offset: number | undefined, max = 200): string {
  const l = Math.min(Math.max(Math.trunc(Number(limit ?? 100)) || 100, 1), max);
  const o = Math.max(Math.trunc(Number(offset ?? 0)) || 0, 0);
  return `LIMIT ${l} OFFSET ${o}`;
}

/**
 * Next human-readable sequential ID such as "CI-0042": MAX of the numeric
 * suffix of existing IDs with this prefix, plus one. On its own this can
 * race with a concurrent insert — always pair it with insertRowIfAbsent()
 * and retry (see insertWithNewId()).
 */
export async function nextSequentialId(table: string, idColumn: string, prefix: string, pad = 4): Promise<string> {
  const start = prefix.length + 2; // SUBSTRING is 1-indexed; skip "PREFIX-"
  const rows = await executeQuery<{ maxSeq: number | string | null }>(
    `SELECT MAX(CAST(SUBSTRING(${qCol(idColumn)}, ${start}) AS INT)) AS maxSeq
     FROM ${qTable(table)}
     WHERE ${qCol(idColumn)} RLIKE ${sqlLiteral(`^${prefix}-[0-9]+$`)}`
  );
  const next = Number(rows[0]?.maxSeq ?? 0) + 1;
  return `${prefix}-${String(next).padStart(pad, "0")}`;
}

/**
 * Inserts `row` only if no row already has the same `uniqueColumn` value
 * (INSERT … SELECT … WHERE NOT EXISTS), then re-reads to confirm it landed.
 * Returns false when the value was taken by a concurrent writer.
 */
export async function insertRowIfAbsent(table: string, uniqueColumn: string, row: Record<string, unknown>): Promise<boolean> {
  const cols = Object.keys(row);
  const target = qTable(table);
  try {
    await executeStatement(
      `INSERT INTO ${target} (${cols.map(qCol).join(", ")})
       SELECT ${cols.map((c) => `${sqlLiteral(row[c])} AS ${qCol(c)}`).join(", ")}
       WHERE NOT EXISTS (SELECT 1 FROM ${target} WHERE ${qCol(uniqueColumn)} = ${sqlLiteral(row[uniqueColumn])})`
    );
  } catch (error) {
    // Most likely a concurrent Delta write conflict — the caller retries with a new ID.
    console.error("[sql] insertRowIfAbsent failed, will retry:", error instanceof Error ? error.message : error);
    return false;
  }
  const check = await executeQuery<{ cnt: number | string }>(
    `SELECT COUNT(*) AS cnt FROM ${target} WHERE ${qCol(uniqueColumn)} = ${sqlLiteral(row[uniqueColumn])}`
  );
  return Number(check[0]?.cnt ?? 0) > 0;
}

/**
 * Safe ID generation: mint the next sequential ID,
 * insert only if it's still free, and retry with a fresh ID on a collision.
 * `buildRow` receives the candidate ID and returns the full row to insert.
 */
export async function insertWithNewId(
  table: string,
  idColumn: string,
  prefix: string,
  buildRow: (id: string) => Record<string, unknown>,
  attempts = 5
): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const id = await nextSequentialId(table, idColumn, prefix);
    if (await insertRowIfAbsent(table, idColumn, buildRow(id))) return id;
  }
  throw new Error(`Could not allocate a unique ${idColumn} after ${attempts} attempts.`);
}

/**
 * Databricks SQL has no multi-statement transaction here, so a save that
 * writes several statements undoes its own earlier writes if a later one
 * fails. `undo` runs best-effort;
 * the original error is always re-thrown.
 */
export async function withCompensation<T>(work: () => Promise<T>, undo: () => Promise<void>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    try {
      await undo();
    } catch (cleanupError) {
      console.error("[sql] compensating cleanup failed:", cleanupError instanceof Error ? cleanupError.message : cleanupError);
    }
    throw error;
  }
}

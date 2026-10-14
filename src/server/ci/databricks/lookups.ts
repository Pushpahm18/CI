import { randomUUID } from "node:crypto";
import type { LookupValue } from "@/types/ci";
import { executeReadOnlyQuery } from "@/server/db/read-only";
import { num, str } from "@/server/db/row-values";
import { COMPETITIVE_GALLERY_SOURCE, LOOKUP_COLUMNS, LOOKUP_USAGE_COLUMNS, CI_TABLES, ciTableName, tableName, type CiTables } from "@/server/db/schema";
import { buildMerge, buildMergeMany, qCol, qTable, sqlLiteral, tsLiteral } from "@/server/db/sql";
import { executeStatement } from "@/server/db/warehouse";
import { hasWarehouseBackend } from "@/server/config";

/**
 * Lookups on corp_marketing_dev.ci.ci_lookup (column names: server/db/schema.ts
 * LOOKUP_COLUMNS). One row per list value. This file is the only place that
 * reads or writes that table:
 *
 *   list        SELECT the mapped columns, ordered by list then position
 *   add         one MERGE (insert) keyed on lookup_id
 *   rename      one UPDATE setting lookup_value
 *   remove      one UPDATE setting is_active = FALSE — never a DELETE: a removed
 *               value only stops appearing in new dropdowns (CI Prototype)
 *   reorder     one UPDATE setting display_order for the whole list at once
 *
 * The usage count is a plain COUNT over ALL ci_main rows (inactive ones included)
 * and is independent of ci_lookup.is_active, which only decides whether a value
 * is offered.
 *
 * Every data-changing statement passes assertLookupWriteStatement() first: a
 * single MERGE INTO / UPDATE of ci_lookup and nothing else.
 */

const C = LOOKUP_COLUMNS;

export interface LookupStoreDeps {
  query(statement: string): Promise<Record<string, unknown>[]>;
  execute(statement: string): Promise<void>;
  now(): string;
  newId(): string;
}

const defaultDeps: LookupStoreDeps = {
  query: (statement) => executeReadOnlyQuery(statement),
  execute: (statement) => executeStatement(statement),
  now: () => new Date().toISOString(),
  newId: () => randomUUID(),
};

export interface LookupUsage {
  /** "List|Value" → number of ci_main rows holding that value. */
  counts: Record<string, number>;
  /** The lists a count is available for. */
  categories: string[];
}

export interface LookupStore {
  listLookups(): Promise<LookupValue[]>;
  addLookup(category: string, value: string, sortOrder: number, actor?: string): Promise<LookupValue>;
  /** Adds many values with ONE statement (all or none). */
  addLookups(items: { category: string; value: string; sortOrder: number }[], actor?: string): Promise<LookupValue[]>;
  renameLookup(id: string, value: string, actor?: string): Promise<void>;
  deactivateLookup(id: string, actor?: string): Promise<void>;
  reorderLookups(category: string, orderedIds: string[], actor?: string): Promise<void>;
  usage(): Promise<LookupUsage>;
}

// ---------------------------------------------------------------- statements

export function buildListStatement(table: string): string {
  return `SELECT ${[C.id, C.type, C.value, C.order, C.active].map(qCol).join(", ")} FROM ${qTable(table)} ORDER BY ${qCol(C.type)}, ${qCol(C.order)}`;
}

/** Active only when the flag is exactly true: a NULL or unreadable flag never offers a value in a dropdown. */
export function rowToLookup(row: Record<string, unknown>): LookupValue {
  return {
    id: str(row[C.id]),
    category: str(row[C.type]),
    value: str(row[C.value]),
    sortOrder: num(row[C.order], 0),
    active: String(row[C.active]).toLowerCase() === "true",
  };
}

export function buildInsertStatement(table: string, input: { id: string; category: string; value: string; sortOrder: number; actor: string; now: string }): string {
  return buildMerge(table, C.id, {
    [C.id]: input.id,
    [C.type]: input.category,
    [C.value]: input.value,
    [C.order]: input.sortOrder,
    [C.active]: true,
    [C.createdBy]: input.actor,
    [C.createdOn]: tsLiteral(input.now),
    [C.modifiedBy]: input.actor,
    [C.modifiedOn]: tsLiteral(input.now),
  });
}

export function buildInsertManyStatement(table: string, inputs: { id: string; category: string; value: string; sortOrder: number; actor: string; now: string }[]): string {
  return buildMergeMany(
    table,
    C.id,
    inputs.map((i) => ({
      [C.id]: i.id,
      [C.type]: i.category,
      [C.value]: i.value,
      [C.order]: i.sortOrder,
      [C.active]: true,
      [C.createdBy]: i.actor,
      [C.createdOn]: tsLiteral(i.now),
      [C.modifiedBy]: i.actor,
      [C.modifiedOn]: tsLiteral(i.now),
    }))
  );
}

export function buildDeactivateStatement(table: string, input: { id: string; actor: string; now: string }): string {
  return `UPDATE ${qTable(table)} SET ${qCol(C.active)} = FALSE, ${qCol(C.modifiedBy)} = ${sqlLiteral(input.actor)}, ${qCol(C.modifiedOn)} = ${sqlLiteral(tsLiteral(input.now))} WHERE ${qCol(C.id)} = ${sqlLiteral(input.id)}`;
}

/** Renames one value. Rows already using the old text keep it (CI Prototype); only the list entry changes. */
export function buildRenameStatement(table: string, input: { id: string; value: string; actor: string; now: string }): string {
  return `UPDATE ${qTable(table)} SET ${qCol(C.value)} = ${sqlLiteral(input.value)}, ${qCol(C.modifiedBy)} = ${sqlLiteral(input.actor)}, ${qCol(C.modifiedOn)} = ${sqlLiteral(tsLiteral(input.now))} WHERE ${qCol(C.id)} = ${sqlLiteral(input.id)}`;
}

/** One UPDATE for the whole list: position i+1 for the i-th id, only rows of that list. */
export function buildReorderStatement(table: string, input: { category: string; orderedIds: string[]; actor: string; now: string }): string {
  const cases = input.orderedIds.map((id, i) => `WHEN ${sqlLiteral(id)} THEN ${i + 1}`).join(" ");
  const ids = input.orderedIds.map((id) => sqlLiteral(id)).join(", ");
  return `UPDATE ${qTable(table)} SET ${qCol(C.order)} = CASE ${qCol(C.id)} ${cases} END, ${qCol(C.modifiedBy)} = ${sqlLiteral(input.actor)}, ${qCol(C.modifiedOn)} = ${sqlLiteral(tsLiteral(input.now))} WHERE ${qCol(C.type)} = ${sqlLiteral(input.category)} AND ${qCol(C.id)} IN (${ids})`;
}

/** The only data-changing statements Lookups may send: one MERGE INTO or UPDATE of its own table. */
export function assertLookupWriteStatement(table: string, statement: string): void {
  const withoutLiterals = statement.replace(/'(?:[^']|'')*'/g, "''");
  const target = qTable(table).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^\\s*(MERGE INTO|UPDATE)\\s+${target}(\\s|$)`).test(withoutLiterals) || withoutLiterals.includes(";")) {
    throw new Error("Refused: unexpected write statement for the Lookups table.");
  }
}

/** One read-only statement: how many ci_main rows use each value of each list that has a mapped column. */
export function buildUsageStatement(mainTable: string): { statement: string; categories: string[] } | null {
  const parts: string[] = [];
  const categories: string[] = [];
  for (const [category, mapped] of Object.entries(LOOKUP_USAGE_COLUMNS)) {
    if (!mapped) continue;
    const col = qCol(mapped.column);
    // Numeric column counted under list labels: exact numeric match only; anything else is NULL and not counted.
    const value = mapped.numericLabels
      ? `CASE ${col} ${Object.entries(mapped.numericLabels).map(([n, label]) => `WHEN ${Number(n)} THEN ${sqlLiteral(label)}`).join(" ")} END`
      : mapped.asText
        ? `CAST(${col} AS STRING)`
        : col;
    parts.push(`SELECT ${sqlLiteral(category)} AS t, ${value} AS v, COUNT(*) AS n FROM ${qTable(mainTable)} GROUP BY ${value}`);
    categories.push(category);
  }
  return parts.length ? { statement: parts.join(" UNION ALL "), categories } : null;
}

// ---------------------------------------------------------------- store

export function createLookupStore(table: string, mainTable: string | null, deps: LookupStoreDeps = defaultDeps): LookupStore {
  const write = async (statement: string) => {
    assertLookupWriteStatement(table, statement);
    await deps.execute(statement);
  };
  return {
    async listLookups() {
      return (await deps.query(buildListStatement(table))).map(rowToLookup);
    },
    async addLookup(category, value, sortOrder, actor = "") {
      const id = deps.newId();
      await write(buildInsertStatement(table, { id, category, value, sortOrder, actor, now: deps.now() }));
      return { id, category, value, sortOrder, active: true };
    },
    async addLookups(items, actor = "") {
      if (items.length === 0) return [];
      const now = deps.now();
      const rows = items.map((i) => ({ id: deps.newId(), category: i.category, value: i.value, sortOrder: i.sortOrder, actor, now }));
      await write(buildInsertManyStatement(table, rows));
      return rows.map((r) => ({ id: r.id, category: r.category, value: r.value, sortOrder: r.sortOrder, active: true }));
    },
    async renameLookup(id, value, actor = "") {
      await write(buildRenameStatement(table, { id, value, actor, now: deps.now() }));
    },
    async deactivateLookup(id, actor = "") {
      await write(buildDeactivateStatement(table, { id, actor, now: deps.now() }));
    },
    async reorderLookups(category, orderedIds, actor = "") {
      if (orderedIds.length === 0) return;
      await write(buildReorderStatement(table, { category, orderedIds, actor, now: deps.now() }));
    },
    async usage() {
      const built = mainTable ? buildUsageStatement(mainTable) : null;
      if (!built) return { counts: {}, categories: [] };
      const counts: Record<string, number> = {};
      for (const row of await deps.query(built.statement)) {
        const value = row.v == null ? "" : String(row.v);
        if (value) counts[`${row.t}|${value}`] = num(row.n, 0);
      }
      return { counts, categories: built.categories };
    },
  };
}

/** The store for the configured ci_lookup table, or null while it is not configured or no warehouse is available. */
export function getLookupStore(tables: CiTables = CI_TABLES): LookupStore | null {
  const table = ciTableName("lookups", tables);
  if (!table || !hasWarehouseBackend()) return null;
  return createLookupStore(table, COMPETITIVE_GALLERY_SOURCE ? tableName(COMPETITIVE_GALLERY_SOURCE) : null);
}

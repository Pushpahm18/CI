import { randomUUID } from "node:crypto";
import { hasWarehouseBackend } from "@/server/config";
import { executeReadOnlyQuery } from "@/server/db/read-only";
import { iso, str } from "@/server/db/row-values";
import { CI_TABLES, USER_ACCESS_COLUMNS as C, ciTableName, type CiTables } from "@/server/db/schema";
import { qCol, qTable, sqlLiteral, tsLiteral } from "@/server/db/sql";
import { executeStatement } from "@/server/db/warehouse";

/**
 * User Access on corp_marketing_dev.ci.ci_user_access (columns: server/db/schema.ts USER_ACCESS_COLUMNS, the table's own;
 * none added). SAMBA's samba_user, in CI's own table: one row per person added on the User Access screen, with their name
 * and email.
 *
 *   list    every row, newest first - no active filter, like SAMBA
 *   has     does an ACTIVE row exist for this email (the second step of the sign-in gate)
 *   add     ONE guarded MERGE that inserts the row only if no row exists for that email (even under a race)
 *
 * Add-only: nothing here updates or deletes. Every data-changing statement passes assertUserAccessWriteStatement() first.
 * Who the row is attributed to (Created By / Modified By) is decided by the service from the verified session.
 */

export interface UserAccessRow {
  id: string;
  name: string;
  /** Lower-cased (stored in user_email). */
  email: string;
  createdBy: string;
  createdOn: string;
  modifiedBy: string;
  modifiedOn: string;
  active: boolean | null;
}

const SELECTED = [C.id, C.userName, C.email, C.createdBy, C.createdOn, C.modifiedBy, C.modifiedOn, C.active];

/** Every row with an email, newest first (SAMBA's order and filter). */
export function buildListAccessStatement(table: string): string {
  return `SELECT ${SELECTED.map(qCol).join(", ")} FROM ${qTable(table)}
     WHERE ${qCol(C.email)} IS NOT NULL AND ${qCol(C.email)} <> ''
     ORDER BY ${qCol(C.createdOn)} DESC`;
}

/** How many ACTIVE rows this email has (compared case-insensitively). */
export function buildHasAccessStatement(table: string, email: string): string {
  return `SELECT COUNT(*) AS cnt FROM ${qTable(table)}
     WHERE LOWER(TRIM(${qCol(C.email)})) = ${sqlLiteral(email.trim().toLowerCase())} AND ${qCol(C.active)} = TRUE`;
}

function flag(value: unknown): boolean | null {
  const s = String(value ?? "").trim().toLowerCase();
  return s === "true" ? true : s === "false" ? false : null;
}

export function rowToAccess(row: Record<string, unknown>): UserAccessRow {
  return {
    id: str(row[C.id]),
    name: str(row[C.userName]),
    email: str(row[C.email]).toLowerCase(),
    createdBy: str(row[C.createdBy]),
    createdOn: iso(row[C.createdOn], ""),
    modifiedBy: str(row[C.modifiedBy]),
    modifiedOn: iso(row[C.modifiedOn], ""),
    active: flag(row[C.active]),
  };
}

export interface NewAccessRow {
  id: string;
  name: string;
  email: string;
  actor: string;
  now: string;
}

/** Inserts only when no row has this email (any state): an existing row is left untouched. */
export function buildAddAccessStatement(table: string, r: NewAccessRow): string {
  const values: [string, unknown][] = [
    [C.id, r.id],
    [C.userName, r.name],
    [C.email, r.email.trim().toLowerCase()],
    [C.createdBy, r.actor],
    [C.createdOn, tsLiteral(r.now)],
    [C.modifiedBy, r.actor],
    [C.modifiedOn, tsLiteral(r.now)],
    [C.active, true],
  ];
  return `MERGE INTO ${qTable(table)} AS t
    USING (SELECT ${values.map(([c, v]) => `${sqlLiteral(v)} AS ${qCol(c)}`).join(", ")}) AS s
    ON LOWER(TRIM(t.${qCol(C.email)})) = s.${qCol(C.email)}
    WHEN NOT MATCHED THEN INSERT (${values.map(([c]) => qCol(c)).join(", ")}) VALUES (${values.map(([c]) => `s.${qCol(c)}`).join(", ")})`;
}

/** The only data-changing statement this table may receive from here: one MERGE INTO itself (insert when absent). */
export function assertUserAccessWriteStatement(table: string, statement: string): void {
  const withoutLiterals = statement.replace(/'(?:[^']|'')*'/g, "''");
  const target = qTable(table).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^\\s*MERGE INTO\\s+${target}(\\s|$)`).test(withoutLiterals) || withoutLiterals.includes(";") || /WHEN MATCHED/i.test(withoutLiterals)) {
    throw new Error("Refused: unexpected write statement for the User Access table.");
  }
}

export interface UserAccessDeps {
  query(statement: string): Promise<Record<string, unknown>[]>;
  execute(statement: string): Promise<void>;
  now(): string;
  newId(): string;
}

const defaultDeps: UserAccessDeps = {
  query: (statement) => executeReadOnlyQuery(statement),
  execute: (statement) => executeStatement(statement),
  now: () => new Date().toISOString(),
  newId: () => randomUUID(),
};

export interface UserAccessStore {
  list(): Promise<UserAccessRow[]>;
  has(email: string): Promise<boolean>;
  newId(): string;
  now(): string;
  /** Inserts the row unless the email already has one; returns false when it was already there. */
  add(row: Omit<NewAccessRow, "now">): Promise<boolean>;
}

export function createUserAccessStore(table: string, deps: UserAccessDeps = defaultDeps): UserAccessStore {
  const list = async () => (await deps.query(buildListAccessStatement(table))).map(rowToAccess);
  return {
    list,
    async has(email) {
      const key = email.trim().toLowerCase();
      if (!key) return false;
      const rows = await deps.query(buildHasAccessStatement(table, key));
      return Number(rows[0]?.cnt ?? 0) > 0;
    },
    newId: () => deps.newId(),
    now: () => deps.now(),
    async add(row) {
      const statement = buildAddAccessStatement(table, { ...row, now: deps.now() });
      assertUserAccessWriteStatement(table, statement);
      await deps.execute(statement);
      // The MERGE inserts nothing when the email already has a row, so confirm that OUR row is the one that landed.
      return (await list()).some((r) => r.id === row.id);
    },
  };
}

/** The store, or null while the table is not configured or no warehouse is available. */
export function getUserAccessStore(tables: CiTables = CI_TABLES): UserAccessStore | null {
  const table = ciTableName("userAccess", tables);
  return table && hasWarehouseBackend() ? createUserAccessStore(table) : null;
}

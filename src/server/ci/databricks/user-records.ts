import { randomUUID } from "node:crypto";
import type { CiUserRecordRaw } from "@/types/ci-api";
import { executeReadOnlyQuery } from "@/server/db/read-only";
import { iso, str } from "@/server/db/row-values";
import { CI_TABLES, CI_USER_COLUMNS, ciTableName, type CiTables } from "@/server/db/schema";
import { qCol, qTable, sqlLiteral, tsLiteral } from "@/server/db/sql";
import { executeStatement } from "@/server/db/warehouse";
import { hasWarehouseBackend } from "@/server/config";

/**
 * corp_marketing_dev.ci.ci_user_management (columns: server/db/schema.ts
 * CI_USER_COLUMNS). This file is the only reader and writer of that table.
 *
 *   list        SELECT the mapped columns; values are returned exactly as stored
 *   insert      ONE guarded MERGE that inserts the row only if no record exists
 *               for that email (one record per email, even under a race)
 *   update      ONE UPDATE of name / role / scope, keyed on ci_user_id
 *   setActive   ONE UPDATE of is_active + status (deactivate / reactivate)
 *
 * Nothing is ever deleted. Every data-changing statement passes
 * assertUserWriteStatement() first: a single MERGE INTO / UPDATE of this table.
 * Who may call the writes is decided by the service (Corporate Marketing only).
 */

const C = CI_USER_COLUMNS;

export interface UserRecordDeps {
  query(statement: string): Promise<Record<string, unknown>[]>;
  execute(statement: string): Promise<void>;
  now(): string;
  newId(): string;
}

const defaultDeps: UserRecordDeps = {
  query: (statement) => executeReadOnlyQuery(statement),
  execute: (statement) => executeStatement(statement),
  now: () => new Date().toISOString(),
  newId: () => randomUUID(),
};

export function buildUserRecordsStatement(table: string): string {
  const cols = [C.id, C.userName, C.email, C.role, C.customer, C.segment, C.region, C.status, C.lastSignIn, C.active, C.modifiedBy, C.modifiedOn];
  return `SELECT ${cols.map(qCol).join(", ")} FROM ${qTable(table)} ORDER BY ${qCol(C.email)}, ${qCol(C.id)}`;
}

/** true / false only for an exact stored boolean; anything else (NULL, text) is null — never guessed. */
function flag(value: unknown): boolean | null {
  const s = String(value ?? "").trim().toLowerCase();
  return s === "true" ? true : s === "false" ? false : null;
}

export function rowToUserRecord(row: Record<string, unknown>): CiUserRecordRaw {
  return {
    id: str(row[C.id]),
    userName: str(row[C.userName]),
    email: str(row[C.email]),
    role: str(row[C.role]),
    customer: str(row[C.customer]),
    segment: str(row[C.segment]),
    region: str(row[C.region]),
    status: str(row[C.status]),
    lastSignIn: str(row[C.lastSignIn]),
    isActive: flag(row[C.active]),
    modifiedBy: str(row[C.modifiedBy]),
    modifiedOn: iso(row[C.modifiedOn], ""),
  };
}

export interface NewUserRow {
  id: string;
  userName: string;
  email: string;
  role: string;
  customer: string;
  segment: string;
  region: string;
  status: string;
  actor: string;
  now: string;
}

function insertValues(r: NewUserRow): [string, unknown][] {
  const email = r.email.trim().toLowerCase();
  return [
    [C.id, r.id],
    [C.userName, r.userName],
    [C.email, email],
    [C.role, r.role],
    [C.customer, r.customer],
    [C.segment, r.segment],
    [C.region, r.region],
    [C.status, r.status],
    [C.active, true],
    [C.createdBy, r.actor],
    [C.createdOn, tsLiteral(r.now)],
    [C.modifiedBy, r.actor],
    [C.modifiedOn, tsLiteral(r.now)],
  ];
}

/** Inserts only when no record has this email (case-insensitive): an existing record is left untouched. */
export function buildInsertUserStatement(table: string, r: NewUserRow): string {
  const values = insertValues(r);
  const cols = values.map(([c]) => qCol(c));
  return `MERGE INTO ${qTable(table)} AS t
    USING (SELECT ${values.map(([c, v]) => `${sqlLiteral(v)} AS ${qCol(c)}`).join(", ")}) AS s
    ON LOWER(TRIM(t.${qCol(C.email)})) = s.${qCol(C.email)}
    WHEN NOT MATCHED THEN INSERT (${cols.join(", ")}) VALUES (${values.map(([c]) => `s.${qCol(c)}`).join(", ")})`;
}

export function buildUpdateUserStatement(
  table: string,
  r: { id: string; userName: string; role: string; customer: string; segment: string; region: string; actor: string; now: string }
): string {
  const set = [
    [C.userName, r.userName],
    [C.role, r.role],
    [C.customer, r.customer],
    [C.segment, r.segment],
    [C.region, r.region],
    [C.modifiedBy, r.actor],
    [C.modifiedOn, tsLiteral(r.now)],
  ] as const;
  return `UPDATE ${qTable(table)} SET ${set.map(([c, v]) => `${qCol(c)} = ${sqlLiteral(v)}`).join(", ")} WHERE ${qCol(C.id)} = ${sqlLiteral(r.id)}`;
}

export function buildSetActiveStatement(table: string, r: { id: string; active: boolean; status: string; actor: string; now: string }): string {
  const set = [
    [C.active, r.active],
    [C.status, r.status],
    [C.modifiedBy, r.actor],
    [C.modifiedOn, tsLiteral(r.now)],
  ] as const;
  return `UPDATE ${qTable(table)} SET ${set.map(([c, v]) => `${qCol(c)} = ${sqlLiteral(v)}`).join(", ")} WHERE ${qCol(C.id)} = ${sqlLiteral(r.id)}`;
}

/** The only data-changing statements this table may receive: one MERGE INTO or UPDATE of itself. */
export function assertUserWriteStatement(table: string, statement: string): void {
  const withoutLiterals = statement.replace(/'(?:[^']|'')*'/g, "''");
  const target = qTable(table).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^\\s*(MERGE INTO|UPDATE)\\s+${target}(\\s|$)`).test(withoutLiterals) || withoutLiterals.includes(";")) {
    throw new Error("Refused: unexpected write statement for the CI user table.");
  }
}

export interface UserRecordStore {
  list(): Promise<CiUserRecordRaw[]>;
}

export interface UserRecordWriter extends UserRecordStore {
  newId(): string;
  now(): string;
  /** Inserts the record unless the email already has one; returns false when the email was already taken. */
  insert(row: Omit<NewUserRow, "now">): Promise<boolean>;
  update(row: { id: string; userName: string; role: string; customer: string; segment: string; region: string; actor: string }): Promise<void>;
  setActive(row: { id: string; active: boolean; status: string; actor: string }): Promise<void>;
}

export function createUserRecordStore(table: string, deps: Pick<UserRecordDeps, "query"> = defaultDeps): UserRecordStore {
  return { list: async () => (await deps.query(buildUserRecordsStatement(table))).map(rowToUserRecord) };
}

export function createUserRecordWriter(table: string, deps: UserRecordDeps = defaultDeps): UserRecordWriter {
  const write = async (statement: string) => {
    assertUserWriteStatement(table, statement);
    await deps.execute(statement);
  };
  const list = async () => (await deps.query(buildUserRecordsStatement(table))).map(rowToUserRecord);
  return {
    list,
    newId: () => deps.newId(),
    now: () => deps.now(),
    async insert(row) {
      await write(buildInsertUserStatement(table, { ...row, now: deps.now() }));
      // The MERGE inserts nothing when the email already has a record, so confirm that OUR row is the one that landed.
      return (await list()).some((u) => u.id === row.id);
    },
    update: (row) => write(buildUpdateUserStatement(table, { ...row, now: deps.now() })),
    setActive: (row) => write(buildSetActiveStatement(table, { ...row, now: deps.now() })),
  };
}

/** The read-only store, or null while the table is not configured or no warehouse is available. */
export function getUserRecordStore(tables: CiTables = CI_TABLES): UserRecordStore | null {
  const table = ciTableName("userManagement", tables);
  return table && hasWarehouseBackend() ? createUserRecordStore(table) : null;
}

/** The store that can also write, or null while the table is not configured or no warehouse is available. */
export function getUserRecordWriter(tables: CiTables = CI_TABLES): UserRecordWriter | null {
  const table = ciTableName("userManagement", tables);
  return table && hasWarehouseBackend() ? createUserRecordWriter(table) : null;
}

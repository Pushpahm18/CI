import { buildInsert, qCol, qTable, sqlLiteral, tsLiteral } from "@/server/db/sql";
import { iso, str } from "@/server/db/row-values";
import type { LoginHistoryColumns } from "@/server/db/schema";
import type { LoginHistoryOptionalColumn, LoginHistoryRecord } from "@/types/ci-api";

/**
 * SQL builders and row mapping for CI's Login History table. Behaviour follows
 * SAMBA's Login History (loadLoginHistory / recordLogin in SAMBA
 * src/server/db/delta-store.ts):
 *   list   → every row that has an email, newest first;
 *   record → one new row per completed sign-in: id, email, name (the email when
 *            the name is blank), the sign-in time, and - where the table has the column
 *            and the value is known - the person's role. The event is always "Signed in"
 *            and the result "Success"; only successful sign-ins are recorded. APPEND-ONLY:
 *            one INSERT, never an update or delete (the write guard enforces it).
 *
 * Nothing here knows a table or column name: both arrive as a `target`, resolved
 * from server/db/schema.ts once the CI table is confirmed (PENDING-CI-TABLE).
 */

export interface LoginHistoryTarget {
  /** catalog.schema.table */
  table: string;
  columns: LoginHistoryColumns;
}

export const OPTIONAL_COLUMNS: LoginHistoryOptionalColumn[] = ["role", "event", "result", "device", "ipAddress", "note"];

/** The optional columns this table actually has (named in the mapping). */
export function mappedOptionalColumns({ columns }: LoginHistoryTarget): LoginHistoryOptionalColumn[] {
  return OPTIONAL_COLUMNS.filter((key) => Boolean(columns[key]));
}

/**
 * The list query: every row with an email, newest first, selecting only the
 * mapped columns. `email` limits it to one person's own sign-ins (Sales view).
 */
export function buildListStatement(target: LoginHistoryTarget, options: { email?: string } = {}): string {
  const { table, columns: c } = target;
  const selected = [c.id, c.name, c.email, c.loginTime, ...mappedOptionalColumns(target).map((k) => c[k] as string)];
  const own = options.email ? ` AND LOWER(${qCol(c.email)}) = ${sqlLiteral(options.email.trim().toLowerCase())}` : "";
  return `SELECT ${selected.map(qCol).join(", ")} FROM ${qTable(table)}
     WHERE ${qCol(c.email)} IS NOT NULL AND ${qCol(c.email)} <> ''${own}
     ORDER BY ${qCol(c.loginTime)} DESC`;
}

/** The one row recorded for a sign-in. */
export function newLoginRow(
  { columns: c }: LoginHistoryTarget,
  input: { id: string; email: string; name: string; now: string; role?: string }
): Record<string, unknown> {
  const email = input.email.trim();
  const row: Record<string, unknown> = {
    [c.id]: input.id,
    [c.email]: email,
    [c.name]: input.name.trim() || email,
    // Explicit casts: the time columns are TIMESTAMP and never depend on implicit string conversion.
    [c.loginTime]: tsLiteral(input.now),
  };
  if (c.createdOn) row[c.createdOn] = tsLiteral(input.now);
  // Only the columns the table has. Device / IP address / Note are not known at sign-in time, so they are left out (NULL)
  // rather than invented. The role is the person's CI role when they have a valid User Management record, otherwise NULL.
  if (c.role && input.role) row[c.role] = input.role;
  if (c.event) row[c.event] = "Signed in";
  if (c.result) row[c.result] = "Success";
  return row;
}

/** One append-only INSERT of the row. */
export function buildInsertStatement(target: LoginHistoryTarget, row: Record<string, unknown>): string {
  return buildInsert(target.table, [row]);
}

/** The only data-changing statement Login History may send: a single INSERT INTO its own table. */
export function assertLoginHistoryWriteStatement(target: LoginHistoryTarget, statement: string): void {
  const withoutLiterals = statement.replace(/'(?:[^']|'')*'/g, "''");
  if (!withoutLiterals.trimStart().startsWith(`INSERT INTO ${qTable(target.table)} `) || withoutLiterals.includes(";")) {
    throw new Error("Refused: unexpected write statement for the Login History table.");
  }
}

/** Databricks row → screen record. */
export function rowToLoginRecord(target: LoginHistoryTarget, row: Record<string, unknown>): LoginHistoryRecord {
  const c = target.columns;
  const record: LoginHistoryRecord = {
    id: str(row[c.id]),
    email: str(row[c.email]),
    name: str(row[c.name]),
    loginTime: iso(row[c.loginTime], ""),
  };
  for (const key of mappedOptionalColumns(target)) record[key] = str(row[c[key] as string]);
  return record;
}

/**
 * Last line of defence for every data-changing statement the CI server sends
 * (executeStatement in warehouse.ts calls this before contacting Databricks).
 *
 * A write is allowed only when it is MERGE INTO / UPDATE / INSERT INTO /
 * DELETE FROM on a table in corp_marketing_dev.ci, plus TWO tables outside it:
 * the audit history, corp_marketing_dev.audit.ci_audit_history, and the login
 * history, corp_marketing_dev.audit.ci_login_history (named in
 * AUDIT_WRITE_TABLES below; every other table in the audit schema stays
 * refused). Both are append-only: INSERT INTO is the only verb allowed on
 * them - never UPDATE, DELETE or MERGE. Anything that mentions the
 * SAMBA schema or a SAMBA table, any other catalog or schema, any statement
 * without a recognisable target, and any DDL or maintenance command (DROP,
 * TRUNCATE, ALTER, CREATE, VACUUM, OPTIMIZE, GRANT, ...) is refused. Quoted
 * string values are ignored, so a value such as 'samba' cannot trip the guard
 * and cannot hide a table name.
 */

const CI_PREFIX = "corp_marketing_dev.ci.";
/** Tables outside corp_marketing_dev.ci that CI may write to: exactly the audit history and the login history, nothing else. */
const AUDIT_WRITE_TABLES = new Set(["corp_marketing_dev.audit.ci_audit_history", "corp_marketing_dev.audit.ci_login_history"]);
const FORBIDDEN = /\b(DROP|TRUNCATE|ALTER|CREATE|VACUUM|OPTIMIZE|GRANT|REVOKE|RESTORE|COPY|CALL)\b/i;
const SAMBA = /\bsamba\b|\bsamba_/i;
const TARGET = /\b(MERGE\s+INTO|UPDATE|INSERT\s+(?:INTO|OVERWRITE)|DELETE\s+FROM)\s+(\w+\.\w+\.\w+)/gi;

export class WriteRefusedError extends Error {}

export function assertCiWriteStatement(statement: string): void {
  const text = statement.replace(/'(?:[^']|'')*'/g, "''").replace(/`/g, "");
  if (SAMBA.test(text)) throw new WriteRefusedError("Refused: CI never writes to SAMBA tables.");
  if (FORBIDDEN.test(text)) throw new WriteRefusedError("Refused: this command is not allowed on the CI write path.");
  const targets = Array.from(text.matchAll(TARGET), (m) => ({ verb: m[1].toUpperCase().replace(/\s+/g, " "), table: m[2].toLowerCase() }));
  if (targets.length === 0) throw new WriteRefusedError("Refused: the write has no recognisable target table.");
  if (!targets.every((t) => t.table.startsWith(CI_PREFIX) || AUDIT_WRITE_TABLES.has(t.table))) {
    throw new WriteRefusedError("Refused: CI may only write to tables in corp_marketing_dev.ci (and the audit and login history tables).");
  }
  if (targets.some((t) => AUDIT_WRITE_TABLES.has(t.table) && t.verb !== "INSERT INTO")) {
    throw new WriteRefusedError("Refused: the audit and login history are append-only (INSERT only).");
  }
}

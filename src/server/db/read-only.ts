import { executeQuery } from "@/server/db/warehouse";

/**
 * Read-only statement guard. A statement is allowed only if it is a single
 * SELECT / WITH … SELECT / DESCRIBE statement: no `;` (so no second
 * statement can be appended) and none of the data- or schema-changing
 * keywords anywhere. Anything else is refused BEFORE Databricks is
 * contacted. Use executeReadOnlyQuery() for every read path.
 */
const READ_START = /^\s*(SELECT|WITH|DESCRIBE)\b/i;
const WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|REPLACE|GRANT|REVOKE|COPY|OPTIMIZE|VACUUM|RESTORE|CALL|SET|USE)\b/i;

export class ReadOnlyViolationError extends Error {}

export function assertReadOnlyStatement(statement: string): void {
  // Keyword check ignores the contents of quoted string literals ('...'), so a
  // value such as 'Updated by' can't trip it, while identifiers and SQL text still do.
  const withoutLiterals = statement.replace(/'(?:[^']|'')*'/g, "''");
  if (!READ_START.test(withoutLiterals) || withoutLiterals.includes(";") || WRITE_KEYWORDS.test(withoutLiterals)) {
    throw new ReadOnlyViolationError("Refused: only a single read-only SELECT statement may be sent on this path.");
  }
}

export async function executeReadOnlyQuery<T extends Record<string, unknown> = Record<string, unknown>>(statement: string): Promise<T[]> {
  assertReadOnlyStatement(statement);
  return executeQuery<T>(statement);
}

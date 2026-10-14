import { randomUUID } from "node:crypto";
import { NotConfiguredError } from "@/server/ci/errors";
import {
  assertLoginHistoryWriteStatement,
  buildInsertStatement,
  buildListStatement,
  mappedOptionalColumns,
  newLoginRow,
  rowToLoginRecord,
  type LoginHistoryTarget,
} from "@/server/ci/login-history/data";
import { hasWarehouseBackend } from "@/server/config";
import { executeReadOnlyQuery } from "@/server/db/read-only";
import { CI_TABLE_LABELS, CI_TABLES, LOGIN_HISTORY_COLUMNS, ciTableName, type CiTables, type LoginHistoryColumns } from "@/server/db/schema";
import { executeStatement } from "@/server/db/warehouse";
import type { LoginHistoryOptionalColumn, LoginHistoryRecord } from "@/types/ci-api";

/**
 * Data access for CI Login History — its own repository, separate from the main
 * CiRepository and from SAMBA's tables. Until the CI table and its columns are
 * confirmed (server/db/schema.ts: CI_TABLES.loginHistory and
 * LOGIN_HISTORY_COLUMNS) it reads nothing and records nothing.
 *
 * PENDING-CI-TABLE: this is the integration point. Once both are filled in,
 * the Databricks-backed methods below activate with no other code change
 * (after the real columns have been checked against what a row needs).
 */

export interface LoginHistoryRepository {
  /** Every recorded sign-in, newest first (or only one person's with `email`). Refuses while the table is pending. */
  list(options?: { email?: string }): Promise<LoginHistoryRecord[]>;
  /** The optional columns (Role, Event, Result, Device, IP address, Note) the configured table has. */
  optionalColumns(): LoginHistoryOptionalColumn[];
  /**
   * Records one SUCCESSFUL sign-in (event "Signed in", result "Success"). BEST-EFFORT, like SAMBA: it never
   * throws — a failure here must never block someone signing in — and it does nothing
   * while the table is pending, the connection is unavailable, or the email is blank.
   * `role` is the person's CI role when known (otherwise the column stays NULL).
   */
  record(email: string, name: string, options?: { role?: string }): Promise<void>;
}

export interface LoginHistoryDeps {
  query(statement: string): Promise<Record<string, unknown>[]>;
  execute(statement: string): Promise<void>;
  now(): string;
  newId(): string;
  connected(): boolean;
}

const defaultDeps: LoginHistoryDeps = {
  query: (statement) => executeReadOnlyQuery(statement),
  execute: (statement) => executeStatement(statement),
  now: () => new Date().toISOString(),
  newId: () => randomUUID(),
  connected: hasWarehouseBackend,
};

/** The table + columns to use, or null while either is still pending. */
export function resolveLoginHistoryTarget(
  tables: CiTables = CI_TABLES,
  columns: LoginHistoryColumns | null = LOGIN_HISTORY_COLUMNS
): LoginHistoryTarget | null {
  const table = ciTableName("loginHistory", tables);
  return table && columns ? { table, columns } : null;
}

/** Why the target is unresolved, in the same wording as every other pending screen. */
function pendingError(tables: CiTables): NotConfiguredError {
  if (tables.loginHistory === null) return new NotConfiguredError([CI_TABLE_LABELS.loginHistory]);
  // Table named, but its column mapping is still missing.
  return new NotConfiguredError(
    [`${CI_TABLE_LABELS.loginHistory} (column mapping)`],
    `CI database table configuration is pending: ${CI_TABLE_LABELS.loginHistory} (column mapping).`
  );
}

/**
 * Builds the repository for a resolved target (or null = pending). `tables` is
 * only used to word the pending message; it is injectable so this can be tested
 * without depending on the live schema.
 */
export function createLoginHistoryRepository(
  target: LoginHistoryTarget | null,
  deps: LoginHistoryDeps = defaultDeps,
  tables: CiTables = CI_TABLES
): LoginHistoryRepository {
  if (!target) {
    return {
      list: async () => {
        throw pendingError(tables);
      },
      optionalColumns: () => [],
      record: async () => {},
    };
  }
  return {
    async list(options) {
      const rows = await deps.query(buildListStatement(target, options));
      return rows.map((row) => rowToLoginRecord(target, row));
    },
    optionalColumns: () => mappedOptionalColumns(target),
    async record(email, name, options) {
      const trimmed = email.trim();
      if (!trimmed || !deps.connected()) return;
      try {
        const row = newLoginRow(target, { id: deps.newId(), email: trimmed, name, now: deps.now(), role: options?.role });
        const statement = buildInsertStatement(target, row);
        assertLoginHistoryWriteStatement(target, statement);
        await deps.execute(statement);
      } catch (error) {
        // Logged for the server only; never thrown (see the interface comment).
        console.error("[CI] login history: recording a sign-in failed:", error instanceof Error ? error.message : error);
      }
    },
  };
}

/** The repository the application uses, built from the schema's current configuration. */
export function getLoginHistoryRepository(): LoginHistoryRepository {
  return createLoginHistoryRepository(resolveLoginHistoryTarget());
}

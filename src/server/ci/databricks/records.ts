import type { CompetitiveRecord } from "@/types/ci";
import type { DataScope } from "@/lib/ci/rules";
import { WAFER_SIZE_LABELS, waferStoredForInput } from "@/lib/ci/wafer-size";
import { randomUUID } from "node:crypto";
import { FLAT_FILE_ROW_LIMIT, rowToFlatRecord } from "@/server/ci/competitive-ff/data";
import { scopePredicates } from "@/server/ci/competitive-gallery/data";
import { ConflictError, ValidationError } from "@/server/ci/errors";
import { hasWarehouseBackend } from "@/server/config";
import { MAIN_COLUMNS as M } from "@/server/db/main-columns";
import { executeReadOnlyQuery } from "@/server/db/read-only";
import { CI_TABLES, MAIN_SCOPE_COLUMNS, ciTableName, type CiTables } from "@/server/db/schema";
import { SqlRaw, qCol, qTable, sqlIn, sqlLiteral, tsLiteral } from "@/server/db/sql";
import { executeStatement } from "@/server/db/warehouse";

/**
 * Competitive rows on corp_marketing_dev.ci.ci_main (columns: server/db/main-columns.ts, verified with DESCRIBE).
 *
 *   list / get   only live rows (is_active = TRUE); a Sales scope is applied in the WHERE clause, so out-of-scope
 *                rows never leave the database
 *   create       ONE INSERT of one row with a new UUID Record ID (the existing rows' ids are UUIDs), is_active = TRUE and the next
 *                Application ID CI-nnnn (highest stored number + 1, as in SAMBA: inserted only if that id is free, read back,
 *                and retried with a fresh number if another create took it first)
 *   update       ONE UPDATE of the editable columns of one live row, keyed on ci_id
 *
 * Nothing is ever deleted, and Created By / Created Date are written once, at creation. Every data-changing statement
 * passes assertRecordWriteStatement() first. Who the row is attributed to (Created By / Modified By) is decided by the
 * service from the verified session, never from the request.
 *
 * ci_main.created_date is a DATE and modified_date a TIMESTAMP (column types are not changed): the service's UTC
 * calendar day is written as a DATE, and its full ISO time as the TIMESTAMP.
 */

export interface RecordStore {
  listRecords(scope: DataScope): Promise<CompetitiveRecord[]>;
  getRecord(recordId: string): Promise<CompetitiveRecord | null>;
  getRecords(recordIds: string[]): Promise<CompetitiveRecord[]>;
  createRecord(record: Omit<CompetitiveRecord, "recordId">): Promise<CompetitiveRecord>;
  updateRecord(record: CompetitiveRecord): Promise<void>;
  /** Sets is_active = FALSE on one row (undoing a create); nothing is deleted. */
  discardRecord(recordId: string): Promise<void>;
}

export interface RecordStoreDeps {
  query(statement: string): Promise<Record<string, unknown>[]>;
  execute(statement: string): Promise<void>;
  newId(): string;
}

const defaultDeps: RecordStoreDeps = {
  query: (statement) => executeReadOnlyQuery(statement),
  execute: (statement) => executeStatement(statement),
  newId: () => randomUUID(),
};

const ALL_COLUMNS = Object.values(M).map(qCol).join(", ");
const LIVE = `${qCol(M.active)} = TRUE`;

export function buildListRecordsStatement(table: string, scope: DataScope, limit = FLAT_FILE_ROW_LIMIT): string {
  const predicates = [LIVE, ...scopePredicates({ columns: MAIN_SCOPE_COLUMNS, scope: { customers: scope.customers, segments: scope.segments, regions: scope.regions } })];
  return `SELECT ${ALL_COLUMNS} FROM ${qTable(table)} WHERE ${predicates.join(" AND ")} ORDER BY ${qCol(M.createdOn)} DESC, ${qCol(M.recordId)} LIMIT ${Math.trunc(limit)}`;
}

export function buildGetRecordsStatement(table: string, recordIds: string[]): string {
  return `SELECT ${ALL_COLUMNS} FROM ${qTable(table)} WHERE ${LIVE} AND ${sqlIn(M.recordId, recordIds)}`;
}

/** A DATE literal from a "YYYY-MM-DD" day (validated), so a DATE column never depends on implicit string conversion. */
function dateLiteral(day: string): SqlRaw {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Invalid date.");
  return new SqlRaw(`CAST('${day}' AS DATE)`);
}

const text = (v: string): string | null => (v.trim() === "" ? null : v);

/** The stored number for a Wafer Size (approved sizes 300 / 200 / 150, written as the label or simply 300mm); anything else is refused, never guessed. */
function waferForStorage(label: string): number | null {
  if (label.trim() === "") return null;
  const mapped = waferStoredForInput(label);
  if (mapped !== null) return mapped;
  throw new ValidationError([`Wafer Size "${label}" is not one of the approved sizes: ${Object.values(WAFER_SIZE_LABELS).join(", ")}. Change it in Lookups > Wafer Size.`]);
}

function whole(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new ValidationError([`${label} must be a whole number.`]);
  return n;
}

/** The editable columns (everything except the id and the created-once columns). */
function editableValues(r: Omit<CompetitiveRecord, "recordId">): [string, unknown][] {
  return [
    [M.quarter, text(r.quarter)],
    [M.year, whole(r.year, "Year")],
    [M.customer, text(r.customer)],
    [M.fabLocation, text(r.fabLocation)],
    [M.fabRegion, text(r.fabRegion)],
    [M.servedMarket, text(r.servedMarket)],
    [M.technologyNode, text(r.technologyNode)],
    [M.waferSize, waferForStorage(r.waferSize)],
    [M.processApplication, text(r.processApplication)],
    [M.processType, text(r.processType)],
    [M.processLocation, text(r.processLocation)],
    [M.films, text(r.films)],
    [M.productLine, text(r.productLine)],
    [M.topCompetitor, text(r.topCompetitor)],
    [M.productName, text(r.productName)],
    [M.processModules, text(r.processModules)],
    [M.orderType, text(r.orderType)],
    [M.actualOrder, Number.isFinite(r.actualOrder) ? r.actualOrder : null],
    [M.asp, Number.isFinite(r.asp) ? r.asp : null],
    [M.currency, text(r.currency)],
    [M.revenue, Number.isFinite(r.revenue) ? r.revenue : null],
    [M.toolType, text(r.toolType)],
  ];
}

/** Every Application ID starts with this prefix, then "-", then a zero-padded running number: CI-0001, CI-0002, ... */
export const APPLICATION_ID_PREFIX = "CI";
const APPLICATION_ID_DIGITS = 4;
/** How many times a create picks a fresh number when another create took it first (the same retry SAMBA uses). */
export const APPLICATION_ID_ATTEMPTS = 5;

/** The highest number already used with this prefix, on any row (live or not, so a number is never reused). */
export function buildMaxApplicationSeqStatement(table: string): string {
  const col = qCol(M.applicationId);
  return (
    `SELECT MAX(TRY_CAST(SUBSTRING(${col}, ${APPLICATION_ID_PREFIX.length + 2}) AS BIGINT)) AS maxSeq FROM ${qTable(table)} ` +
    `WHERE ${col} RLIKE ${sqlLiteral(`^${APPLICATION_ID_PREFIX}-[0-9]+$`)}`
  );
}

/** CI-0502 from the current maximum 501 (a blank table starts at CI-0001). The number just grows past 9999. */
export function applicationIdFor(maxSeq: unknown): string {
  const next = (Number.isFinite(Number(maxSeq)) ? Number(maxSeq) : 0) + 1;
  return `${APPLICATION_ID_PREFIX}-${String(next).padStart(APPLICATION_ID_DIGITS, "0")}`;
}

/**
 * One INSERT of one row, written only if no row already has this Application ID (INSERT ... SELECT ... WHERE NOT EXISTS in a
 * single statement, as SAMBA does). The database has no UNIQUE constraint, so createRecord() also reads the row back.
 */
export function buildInsertRecordStatement(table: string, recordId: string, r: Omit<CompetitiveRecord, "recordId">, applicationId: string): string {
  const row = Object.entries(
    Object.fromEntries([
      [M.recordId, recordId],
      ...editableValues(r),
      [M.createdBy, r.createdBy],
      [M.createdOn, dateLiteral(r.createdOn)],
      [M.modifiedBy, null],
      [M.modifiedOn, null],
      [M.active, true],
      [M.applicationId, applicationId],
    ])
  );
  const columns = row.map(([c]) => qCol(c)).join(", ");
  const selected = row.map(([c, v]) => `${sqlLiteral(v)} AS ${qCol(c)}`).join(", ");
  return (
    `INSERT INTO ${qTable(table)} (${columns}) SELECT ${selected} ` +
    `WHERE NOT EXISTS (SELECT 1 FROM ${qTable(table)} WHERE ${qCol(M.applicationId)} = ${sqlLiteral(applicationId)})`
  );
}

export function buildRecordLandedStatement(table: string, recordId: string): string {
  return `SELECT COUNT(*) AS cnt FROM ${qTable(table)} WHERE ${qCol(M.recordId)} = ${sqlLiteral(recordId)}`;
}

export function buildUpdateRecordStatement(table: string, r: CompetitiveRecord): string {
  const set: [string, unknown][] = [
    ...editableValues(r),
    [M.modifiedBy, r.modifiedBy ?? null],
    [M.modifiedOn, r.modifiedOn ? tsLiteral(r.modifiedOn) : null],
  ];
  return `UPDATE ${qTable(table)} SET ${set.map(([c, v]) => `${qCol(c)} = ${sqlLiteral(v)}`).join(", ")} WHERE ${qCol(M.recordId)} = ${sqlLiteral(r.recordId)} AND ${LIVE}`;
}

export function buildDiscardRecordStatement(table: string, recordId: string): string {
  return `UPDATE ${qTable(table)} SET ${qCol(M.active)} = FALSE WHERE ${qCol(M.recordId)} = ${sqlLiteral(recordId)}`;
}

/** The only data-changing statements ci_main may receive from this store: one INSERT INTO or one UPDATE of itself. */
export function assertRecordWriteStatement(table: string, statement: string): void {
  const withoutLiterals = statement.replace(/'(?:[^']|'')*'/g, "''");
  const target = qTable(table).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^\\s*(INSERT INTO|UPDATE)\\s+${target}(\\s|$)`).test(withoutLiterals) || withoutLiterals.includes(";")) {
    throw new Error("Refused: unexpected write statement for the competitive info table.");
  }
}

export function createRecordStore(table: string, deps: RecordStoreDeps = defaultDeps): RecordStore {
  const write = async (statement: string) => {
    assertRecordWriteStatement(table, statement);
    await deps.execute(statement);
  };
  const getRecords = async (recordIds: string[]) => {
    if (recordIds.length === 0) return [];
    return (await deps.query(buildGetRecordsStatement(table, recordIds))).map(rowToFlatRecord);
  };
  return {
    async listRecords(scope) {
      return (await deps.query(buildListRecordsStatement(table, scope))).map(rowToFlatRecord);
    },
    getRecords,
    async getRecord(recordId) {
      return (await getRecords([recordId]))[0] ?? null;
    },
    async createRecord(record) {
      // Pick the next Application ID, insert only if nobody has it, and confirm the row landed; if another create took the
      // number first (or Databricks rejected a concurrent write), pick a fresh one and try again.
      const recordId = deps.newId();
      for (let attempt = 0; attempt < APPLICATION_ID_ATTEMPTS; attempt++) {
        const [top] = await deps.query(buildMaxApplicationSeqStatement(table));
        const statement = buildInsertRecordStatement(table, recordId, record, applicationIdFor(top?.maxSeq));
        try {
          await write(statement);
        } catch (error) {
          if (error instanceof ValidationError) throw error;
          console.error("[CI] creating a row failed (likely a concurrent write); trying the next Application ID:", error instanceof Error ? error.message : error);
          continue;
        }
        const [landed] = await deps.query(buildRecordLandedStatement(table, recordId));
        if (Number(landed?.cnt ?? 0) > 0) return { ...record, recordId };
      }
      throw new ConflictError(`Could not get a free Application ID after ${APPLICATION_ID_ATTEMPTS} attempts. Please save again.`);
    },
    async updateRecord(record) {
      await write(buildUpdateRecordStatement(table, record));
    },
    async discardRecord(recordId) {
      await write(buildDiscardRecordStatement(table, recordId));
    },
  };
}

/** The store, or null while the table is not configured or no warehouse is available. */
export function getRecordStore(tables: CiTables = CI_TABLES): RecordStore | null {
  const table = ciTableName("competitiveInfo", tables);
  return table && hasWarehouseBackend() ? createRecordStore(table) : null;
}

import { randomUUID } from "node:crypto";
import type { AuditAction, AuditEntry, FieldChange } from "@/types/ci";
import { FIELDS } from "@/lib/ci/field-spec";
import { hasWarehouseBackend } from "@/server/config";
import { executeReadOnlyQuery } from "@/server/db/read-only";
import { iso, str } from "@/server/db/row-values";
import { AUDIT_HISTORY_COLUMNS as C, CI_TABLES, ciTableName, type CiTables } from "@/server/db/schema";
import { buildInsert, qCol, qTable, sqlLiteral, tsLiteral } from "@/server/db/sql";
import { executeStatement } from "@/server/db/warehouse";

/**
 * Audit history on corp_marketing_dev.audit.ci_audit_history (columns: server/db/schema.ts AUDIT_HISTORY_COLUMNS -
 * the table's own columns, none added). APPEND-ONLY: the only statement ever sent is INSERT INTO, and the write
 * guard (server/db/write-guard.ts) refuses UPDATE / DELETE / MERGE on this table.
 *
 * One row per changed field. The rows of one change share the same entity, record, action, person and time, which is
 * how they are put back together into one entry when read. A change with no field detail is one row with an empty field.
 *
 *   entity_name       what changed: "Competitive Info", "User", "Lookup", "Dependent Lookup"
 *   record_id         the record's id (ci_main.ci_id, ci_user_id, lookup_id, ...)
 *   action_taken      Created, Edited, Deactivated, ...
 *   field_name        the field's label ("Fab Location")
 *   old_value / new_value   NULL when there was no value
 *   comments          the Change Note text, where there is one. A change made through Import starts with one marker line,
 *                     `[Bulk Import: <type> | file: <name>]`, because the table has no column for the import type or file
 *                     (see encodeImportSource). Older rows have no marker and read back exactly as before.
 *   action_by         "Name <email>": the verified signed-in person (the table has no separate email column)
 */

export const ENTITY_COMPETITIVE_INFO = "Competitive Info";

export interface AuditInput {
  entity: string;
  recordId: string;
  action: string;
  changes: FieldChange[];
  note?: string;
  /** Name of the verified signed-in person. */
  actionByName: string;
  /** Their verified email, when known. */
  actionByEmail?: string;
  /** ISO timestamp (the service's clock). */
  at: string;
  /** Set when the change was made through Import (stored as a marker line at the start of comments). */
  importType?: ImportType;
  sourceFile?: string;
}

export type ImportType = NonNullable<AuditEntry["importType"]>;
const IMPORT_TYPES: readonly ImportType[] = ["Historic Load", "Bulk Update", "Excel Import"];
const MARKER = /^\[Bulk Import: (Historic Load|Bulk Update|Excel Import)(?: \| file: ([^\]\r\n]*))?\]\r?\n?/;

/** The text stored in comments: the import marker line (when the change came from an Import) followed by the Change Note. */
export function encodeImportSource(note: string | undefined, importType?: ImportType, sourceFile?: string): string | null {
  const text = note ? note : "";
  if (!importType || !IMPORT_TYPES.includes(importType)) return text ? text : null;
  const file = (sourceFile ?? "").replace(/[\]\r\n]+/g, " ").trim().slice(0, 200);
  return `[Bulk Import: ${importType}${file ? ` | file: ${file}` : ""}]${text ? "\n" + text : ""}`;
}

/** Splits stored comments back into the Change Note and, for an Import, its type and file. */
export function decodeImportSource(comments: string): { note: string; importType?: ImportType; sourceFile?: string } {
  const m = comments.match(MARKER);
  if (!m) return { note: comments };
  return { note: comments.slice(m[0].length), importType: m[1] as ImportType, sourceFile: m[2]?.trim() || undefined };
}

/** "Ann Lee <ann@corp.com>"; just the name when no email is known. */
export function formatActionBy(name: string, email?: string): string {
  const n = name.trim();
  const e = (email ?? "").trim();
  return e && n.toLowerCase() !== e.toLowerCase() ? `${n} <${e}>` : n || e;
}

/** Splits "Ann Lee <ann@corp.com>" back into a name and an email (email "" when there is none). */
export function parseActionBy(value: string): { name: string; email: string } {
  const m = value.match(/^(.*?)\s*<([^<>]+)>\s*$/);
  return m ? { name: m[1].trim(), email: m[2].trim() } : { name: value.trim(), email: "" };
}

const orNull = (v: string): string | null => (v === "" ? null : v);

export function auditRows(inputs: AuditInput[], newId: () => string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const input of inputs) {
    const by = formatActionBy(input.actionByName, input.actionByEmail);
    const parts = input.changes.length ? input.changes : [null];
    for (const change of parts) {
      rows.push({
        [C.id]: newId(),
        [C.entity]: input.entity,
        [C.recordId]: input.recordId,
        [C.action]: input.action,
        [C.field]: change ? change.label : null,
        [C.oldValue]: change ? orNull(change.previous) : null,
        [C.newValue]: change ? orNull(change.current) : null,
        [C.comments]: encodeImportSource(input.note, input.importType, input.sourceFile),
        [C.actionBy]: by,
        [C.actionTimestamp]: tsLiteral(input.at),
        [C.createdBy]: by,
        [C.createdOn]: tsLiteral(input.at),
        [C.modifiedBy]: by,
        [C.modifiedOn]: tsLiteral(input.at),
      });
    }
  }
  return rows;
}

export function buildInsertAuditStatement(table: string, inputs: AuditInput[], newId: () => string): string {
  return buildInsert(table, auditRows(inputs, newId));
}

/** The only data-changing statement the audit history may receive: one INSERT INTO this table. */
export function assertAuditWriteStatement(table: string, statement: string): void {
  const withoutLiterals = statement.replace(/'(?:[^']|'')*'/g, "''");
  if (!withoutLiterals.trimStart().startsWith(`INSERT INTO ${qTable(table)} `) || withoutLiterals.includes(";")) {
    throw new Error("Refused: unexpected write statement for the audit history table.");
  }
}

const SELECTED = [C.id, C.entity, C.recordId, C.action, C.field, C.oldValue, C.newValue, C.comments, C.actionBy, C.actionTimestamp];

export function buildListAuditStatement(table: string, entity: string, recordId: string): string {
  return `SELECT ${SELECTED.map(qCol).join(", ")} FROM ${qTable(table)}
     WHERE ${qCol(C.entity)} = ${sqlLiteral(entity)} AND ${qCol(C.recordId)} = ${sqlLiteral(recordId)}
     ORDER BY ${qCol(C.actionTimestamp)} DESC, ${qCol(C.id)}`;
}

const keyForLabel = (label: string) => FIELDS.find((f) => f.label === label)?.key ?? label;

/** Puts the per-field rows of each change back together as one entry, newest first. */
export function rowsToEntries(rows: Record<string, unknown>[]): AuditEntry[] {
  const entries = new Map<string, AuditEntry>();
  for (const row of rows) {
    const at = iso(row[C.actionTimestamp], "");
    const action = str(row[C.action]);
    const by = str(row[C.actionBy]);
    const key = `${at}|${action}|${by}`;
    let entry = entries.get(key);
    if (!entry) {
      const who = parseActionBy(by);
      const source = decodeImportSource(str(row[C.comments]));
      entry = {
        id: str(row[C.id]),
        recordId: str(row[C.recordId]),
        action: action as AuditAction,
        actionTakenBy: who.name,
        actorEmail: who.email || undefined,
        dateTime: at,
        changes: [],
        note: source.note,
        ...(source.importType ? { importType: source.importType, sourceFile: source.sourceFile } : {}),
      };
      entries.set(key, entry);
    }
    const label = str(row[C.field]);
    if (label) entry.changes.push({ field: keyForLabel(label), label, previous: str(row[C.oldValue]), current: str(row[C.newValue]) });
  }
  return Array.from(entries.values());
}

export interface AuditHistoryDeps {
  query(statement: string): Promise<Record<string, unknown>[]>;
  execute(statement: string): Promise<void>;
  newId(): string;
}

const defaultDeps: AuditHistoryDeps = {
  query: (statement) => executeReadOnlyQuery(statement),
  execute: (statement) => executeStatement(statement),
  newId: () => randomUUID(),
};

export interface AuditHistoryStore {
  list(entity: string, recordId: string): Promise<AuditEntry[]>;
  add(inputs: AuditInput[]): Promise<void>;
}

export function createAuditHistoryStore(table: string, deps: AuditHistoryDeps = defaultDeps): AuditHistoryStore {
  return {
    async list(entity, recordId) {
      return rowsToEntries(await deps.query(buildListAuditStatement(table, entity, recordId)));
    },
    async add(inputs) {
      if (inputs.length === 0) return;
      const statement = buildInsertAuditStatement(table, inputs, deps.newId);
      assertAuditWriteStatement(table, statement);
      await deps.execute(statement);
    },
  };
}

/** The store, or null while the table is not configured or no warehouse is available. */
export function getAuditHistoryStore(tables: CiTables = CI_TABLES): AuditHistoryStore | null {
  const table = ciTableName("auditTrail", tables);
  return table && hasWarehouseBackend() ? createAuditHistoryStore(table) : null;
}

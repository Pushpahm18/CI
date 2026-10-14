import { randomUUID } from "node:crypto";
import type { ChangeNote } from "@/types/ci";
import { hasWarehouseBackend } from "@/server/config";
import { executeReadOnlyQuery } from "@/server/db/read-only";
import { iso, str } from "@/server/db/row-values";
import { CHANGE_NOTE_COLUMNS as C, CI_TABLES, ciTableName, type CiTables } from "@/server/db/schema";
import { buildInsert, qCol, qTable, sqlLiteral, tsLiteral } from "@/server/db/sql";
import { executeStatement } from "@/server/db/warehouse";

/**
 * Change notes on corp_marketing_dev.ci.ci_change_note (columns: server/db/schema.ts CHANGE_NOTE_COLUMNS - the
 * table's own columns, none added).
 *
 *   list   the live (is_active = TRUE / NULL) notes of one competitive row, oldest first
 *   add    ONE append-only INSERT of the notes; nothing is ever updated or deleted here
 *
 * Every data-changing statement passes assertNoteWriteStatement() first: a single INSERT INTO this table.
 * Who the note is attributed to ("Action Taken By") is decided by the service from the verified session.
 */

export interface NoteInput {
  recordId: string;
  actionTakenBy: string;
  /** ISO timestamp (the service's clock). */
  dateTime: string;
  notes: string;
}

export interface ChangeNoteDeps {
  query(statement: string): Promise<Record<string, unknown>[]>;
  execute(statement: string): Promise<void>;
  newId(): string;
}

const defaultDeps: ChangeNoteDeps = {
  query: (statement) => executeReadOnlyQuery(statement),
  execute: (statement) => executeStatement(statement),
  newId: () => randomUUID(),
};

const SELECTED = [C.id, C.recordId, C.actionTakenBy, C.actionTimestamp, C.notes];

export function buildListNotesStatement(table: string, recordId: string): string {
  return `SELECT ${SELECTED.map(qCol).join(", ")} FROM ${qTable(table)}
     WHERE ${qCol(C.recordId)} = ${sqlLiteral(recordId)} AND (${qCol(C.active)} IS NULL OR ${qCol(C.active)} = TRUE)
     ORDER BY ${qCol(C.actionTimestamp)} ASC, ${qCol(C.id)}`;
}

export function rowToNote(row: Record<string, unknown>): ChangeNote {
  return {
    id: str(row[C.id]),
    recordId: str(row[C.recordId]),
    actionTakenBy: str(row[C.actionTakenBy]),
    dateTime: iso(row[C.actionTimestamp], ""),
    notes: String(row[C.notes] ?? ""),
  };
}

/** One row per note. created_* / modified_* carry the same person and time as the note itself. */
export function noteRows(notes: NoteInput[], newId: () => string): Record<string, unknown>[] {
  return notes.map((n) => ({
    [C.id]: newId(),
    [C.recordId]: n.recordId,
    [C.actionTakenBy]: n.actionTakenBy,
    [C.actionTimestamp]: tsLiteral(n.dateTime),
    [C.notes]: n.notes,
    [C.createdBy]: n.actionTakenBy,
    [C.createdOn]: tsLiteral(n.dateTime),
    [C.modifiedBy]: n.actionTakenBy,
    [C.modifiedOn]: tsLiteral(n.dateTime),
    [C.active]: true,
  }));
}

export function buildInsertNotesStatement(table: string, notes: NoteInput[], newId: () => string): string {
  return buildInsert(table, noteRows(notes, newId));
}

/** The only data-changing statement change notes may receive: one INSERT INTO this table. */
export function assertNoteWriteStatement(table: string, statement: string): void {
  const withoutLiterals = statement.replace(/'(?:[^']|'')*'/g, "''");
  if (!withoutLiterals.trimStart().startsWith(`INSERT INTO ${qTable(table)} `) || withoutLiterals.includes(";")) {
    throw new Error("Refused: unexpected write statement for the change notes table.");
  }
}

export interface ChangeNoteStore {
  list(recordId: string): Promise<ChangeNote[]>;
  add(notes: NoteInput[]): Promise<void>;
}

export function createChangeNoteStore(table: string, deps: ChangeNoteDeps = defaultDeps): ChangeNoteStore {
  return {
    async list(recordId) {
      return (await deps.query(buildListNotesStatement(table, recordId))).map(rowToNote);
    },
    async add(notes) {
      if (notes.length === 0) return;
      const statement = buildInsertNotesStatement(table, notes, deps.newId);
      assertNoteWriteStatement(table, statement);
      await deps.execute(statement);
    },
  };
}

/** The store, or null while the table is not configured or no warehouse is available. */
export function getChangeNoteStore(tables: CiTables = CI_TABLES): ChangeNoteStore | null {
  const table = ciTableName("changeNotes", tables);
  return table && hasWarehouseBackend() ? createChangeNoteStore(table) : null;
}

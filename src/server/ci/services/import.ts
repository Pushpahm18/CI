import type { AuditEntry, ChangeNote, CiUser, CompetitiveRecord } from "@/types/ci";
import { getCiRepository } from "@/server/ci/repository";
import { requireRole } from "@/server/ci/current-user";
import { ValidationError } from "@/server/ci/errors";
import { importRecipients, notify } from "@/server/ci/notifications";
import { diffRecords } from "@/lib/ci/rules";
import { buildHistoricPreview } from "@/lib/ci/import/historic";
import { buildBulkPreview } from "@/lib/ci/import/bulk";
import { buildExcelRowsPreview } from "@/lib/ci/import/add-rows";
import { RECORD_ID_LABEL } from "@/lib/ci/field-spec";
import { headerIndex } from "@/lib/ci/import/parse-values";
import type {
  BulkPreview,
  ExcelRowsPreview,
  HistoricOptions,
  HistoricPreview,
  ImportCommitResult,
  ParsedSheet,
} from "@/lib/ci/import/types";
import { emptyRecord, loadFormOptions, todayIso } from "@/server/ci/services/competitive-info";

/**
 * CI Import service (BRD §7.5) — Corporate Marketing only. The browser only
 * reads the file; every check runs here, and Commit re-runs the full
 * validation on the server rather than trusting an earlier preview. Nothing
 * is written while any blocking error exists (no partial commit), and all
 * writes go to the same CI main data source as Add/Edit, through the
 * repository's batch methods, with an audit entry for every row.
 */

/** Guard against accidental huge payloads; larger historic loads belong in a staging-table flow. */
const MAX_IMPORT_ROWS = 20_000;

function sanitiseSheet(input: unknown): ParsedSheet {
  const s = (input ?? {}) as Partial<ParsedSheet>;
  if (!Array.isArray(s.headers) || !Array.isArray(s.rows)) {
    throw new ValidationError(["The file could not be read. Choose a .xlsx or .csv file and try again."]);
  }
  if (s.rows.length > MAX_IMPORT_ROWS) {
    throw new ValidationError([`The file has ${s.rows.length} rows; the maximum per import is ${MAX_IMPORT_ROWS}. Split the file and import it in parts.`]);
  }
  return {
    fileName: String(s.fileName ?? "file").slice(0, 255),
    sheetName: s.sheetName ? String(s.sheetName).slice(0, 255) : undefined,
    headers: s.headers.map((h) => String(h ?? "").trim()),
    rows: s.rows.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? "")) : [])),
  };
}

function sanitiseOptions(input: unknown): HistoricOptions {
  const o = (input ?? {}) as Partial<HistoricOptions>;
  const overrides: Record<string, string> = {};
  if (o.mappingOverrides && typeof o.mappingOverrides === "object") {
    for (const [k, v] of Object.entries(o.mappingOverrides)) overrides[String(k)] = String(v ?? "");
  }
  return { loadNotCompetitor: o.loadNotCompetitor !== false, mappingOverrides: overrides };
}

// ---------------------------------------------------------------- historic load

export async function previewHistoric(user: CiUser, sheetInput: unknown, optionsInput: unknown): Promise<HistoricPreview> {
  requireRole(user, ["CM"]);
  const [options, users] = await Promise.all([loadFormOptions(), getCiRepository().listUsers()]);
  return buildHistoricPreview(sanitiseSheet(sheetInput), { ...options, users, today: todayIso() }, sanitiseOptions(optionsInput));
}

export async function commitHistoric(user: CiUser, sheetInput: unknown, optionsInput: unknown): Promise<ImportCommitResult> {
  const preview = await previewHistoric(user, sheetInput, optionsInput);
  if (!preview.canCommit) {
    const blocked = preview.summary.held > 0 || preview.missingColumns.length > 0;
    throw new ValidationError(
      [
        blocked
          ? `${preview.summary.held} row(s) have blocking errors${preview.missingColumns.length ? " and columns are missing" : ""}.`
          : "The file has no rows to load.",
      ],
      blocked ? "Nothing was loaded — fix the highlighted problems and validate again." : "Nothing was loaded."
    );
  }
  const toLoad = preview.rows.filter((r) => (r.status === "ready" || r.status === "flagged") && r.record);
  const repo = getCiRepository();
  const created = await repo.createRecords(toLoad.map((r) => r.record!));

  const now = new Date().toISOString();
  const notes: Omit<ChangeNote, "id">[] = created.map((rec, i) => ({
    recordId: rec.recordId,
    actionTakenBy: user.name,
    dateTime: now,
    // BRD §7.5: the old Notes column becomes the first Change Note.
    notes: toLoad[i].changeNote,
  }));
  const audit: Omit<AuditEntry, "id">[] = created.map((rec, i) => ({
    recordId: rec.recordId,
    action: "Imported",
    actionTakenBy: user.name,
    actorEmail: user.email,
    dateTime: now,
    changes: diffRecords({ ...emptyRecord(), recordId: rec.recordId }, rec),
    note: toLoad[i].changeNote,
    importType: "Historic Load",
    sourceFile: preview.fileName,
  }));
  await repo.addNotes(notes);
  await repo.addAudit(audit);

  // CI Prototype: one summary email to Corporate Marketing per import (delivery pending configuration).
  const notification = await notify({ kind: "imported", importedBy: user.name, rowCount: created.length }, importRecipients(await repo.listUsers()));
  return {
    importType: "Historic Load",
    inserted: created.length,
    updated: 0,
    skipped: preview.summary.emptySkipped + preview.summary.notLoaded,
    flagged: preview.summary.flagged,
    notification,
  };
}

// ---------------------------------------------------------------- bulk update

async function bulkPreviewFor(user: CiUser, sheet: ParsedSheet, changeNote: string): Promise<BulkPreview> {
  const idx = headerIndex(sheet.headers)(RECORD_ID_LABEL);
  const ids = idx >= 0 ? Array.from(new Set(sheet.rows.map((r) => String(r[idx] ?? "").trim()).filter(Boolean))) : [];
  const repo = getCiRepository();
  const [options, existing] = await Promise.all([loadFormOptions(), ids.length ? repo.getRecords(ids) : Promise.resolve([])]);
  return buildBulkPreview(sheet, { ...options, user, existing: new Map(existing.map((r) => [r.recordId, r])) }, changeNote);
}

export async function previewBulk(user: CiUser, sheetInput: unknown, changeNote: unknown): Promise<BulkPreview> {
  requireRole(user, ["CM"]);
  return bulkPreviewFor(user, sanitiseSheet(sheetInput), String(changeNote ?? ""));
}

export async function commitBulk(user: CiUser, sheetInput: unknown, changeNote: unknown): Promise<ImportCommitResult> {
  requireRole(user, ["CM"]);
  const preview = await bulkPreviewFor(user, sanitiseSheet(sheetInput), String(changeNote ?? ""));
  if (!preview.canCommit) {
    const blocked = preview.summary.invalid > 0 || preview.missingColumns.length > 0;
    throw new ValidationError(
      [
        blocked
          ? `${preview.summary.invalid} row(s) have blocking errors${preview.missingColumns.length ? " and columns are missing" : ""}.`
          : "No row in the file changes anything (rows are empty or identical to the current data).",
      ],
      blocked ? "Nothing was updated — fix the highlighted problems and validate again." : "Nothing was updated."
    );
  }
  const repo = getCiRepository();
  const updates = preview.rows.filter((r) => r.status === "update" && r.record);
  const now = new Date().toISOString();
  const records: CompetitiveRecord[] = updates.map((u) => ({ ...u.record!, modifiedBy: user.name, modifiedOn: now }));
  await repo.updateRecords(records);
  await repo.addNotes(updates.map((u) => ({ recordId: u.recordId, actionTakenBy: user.name, dateTime: now, notes: u.changeNote })));
  await repo.addAudit(
    updates.map((u) => ({
      recordId: u.recordId,
      action: "Edited" as const,
      actionTakenBy: user.name,
      actorEmail: user.email,
      dateTime: now,
      changes: u.changes,
      note: u.changeNote,
      importType: "Bulk Update" as const,
      sourceFile: preview.fileName,
    }))
  );
  const notification = await notify({ kind: "imported", importedBy: user.name, rowCount: records.length }, importRecipients(await repo.listUsers()));
  return {
    importType: "Bulk Update",
    inserted: 0,
    updated: records.length,
    skipped: preview.summary.emptySkipped + preview.summary.noChange,
    flagged: 0,
    notification,
  };
}

// ---------------------------------------------------------------- add rows from Excel

/** CI Prototype Import: the first Change Note of every row added from an Excel file. */
const EXCEL_IMPORT_NOTE = "Imported by Corporate Marketing (Excel).";

export async function previewExcelRows(user: CiUser, sheetInput: unknown): Promise<ExcelRowsPreview> {
  requireRole(user, ["CM"]);
  return buildExcelRowsPreview(sanitiseSheet(sheetInput), { ...(await loadFormOptions()), user, today: todayIso() });
}

/**
 * Adds the valid rows of the file (CI Prototype: rows with problems are listed
 * and left out). The whole validation is re-run here, so a tampered preview
 * cannot add anything the form would refuse; nothing is added when the
 * template does not match or no row is valid.
 */
export async function commitExcelRows(user: CiUser, sheetInput: unknown): Promise<ImportCommitResult> {
  const preview = await previewExcelRows(user, sheetInput);
  if (!preview.canCommit) {
    throw new ValidationError(
      [preview.missingColumns.length ? `Missing column(s): ${preview.missingColumns.join(", ")}.` : "The file has no valid rows to add."],
      "Nothing was added."
    );
  }
  const toAdd = preview.rows.filter((r) => r.status === "ready" && r.record);
  const repo = getCiRepository();
  const created = await repo.createRecords(toAdd.map((r) => r.record!));

  const now = new Date().toISOString();
  await repo.addNotes(created.map((rec) => ({ recordId: rec.recordId, actionTakenBy: user.name, dateTime: now, notes: EXCEL_IMPORT_NOTE })));
  await repo.addAudit(
    created.map((rec) => ({
      recordId: rec.recordId,
      action: "Imported" as const,
      actionTakenBy: user.name,
      actorEmail: user.email,
      dateTime: now,
      changes: diffRecords({ ...emptyRecord(), recordId: rec.recordId }, rec),
      note: EXCEL_IMPORT_NOTE,
      importType: "Excel Import" as const,
      sourceFile: preview.fileName,
    }))
  );
  const notification = await notify({ kind: "imported", importedBy: user.name, rowCount: created.length }, importRecipients(await repo.listUsers()));
  return {
    importType: "Excel Import",
    inserted: created.length,
    updated: 0,
    skipped: preview.summary.emptySkipped + preview.summary.invalid,
    flagged: 0,
    notification,
  };
}

import type { CiUser, CompetitiveInput, CompetitiveRecord, FormOptions } from "@/types/ci";
import { FIELDS, RECORD_ID_LABEL, USER_FIELDS } from "@/lib/ci/field-spec";
import { computeRevenue, diffRecords, fabRegionFor, validateInputIssues, type UserFieldKey } from "@/lib/ci/rules";
import { headerIndex, isBlankRow, missingHeaders, parseAmount, unexpectedHeaders } from "@/lib/ci/import/parse-values";
import type { BulkPreview, BulkPreviewRow, ImportIssue, IssueSeverity, ParsedSheet } from "@/lib/ci/import/types";

/**
 * Bulk Update (BRD §7.5 — updates existing rows only). Rows are identified by the
 * system Record ID (BRD §7.1) and validated with the same rules as a manual
 * Edit by Corporate Marketing. Pure: nothing is written here.
 */

/** Optional per-row note column; otherwise the batch Change Note applies. */
export const BULK_CHANGE_NOTE_COLUMN = "Change Note";

/** Template = the grid's own export: Record ID + the 21 user-entered columns are required. */
export const BULK_REQUIRED_COLUMNS = [RECORD_ID_LABEL, ...USER_FIELDS.map((f) => f.label)];

/** Calculated / system columns an exported file carries; accepted and ignored. */
const BULK_IGNORED_COLUMNS = FIELDS.filter((f) => f.input === "auto").map((f) => f.label);

export interface BulkContext extends FormOptions {
  /** The acting Corporate Marketing user (BRD §4: CM edits any row, any year). */
  user: CiUser;
  /** Existing rows for the Record IDs in the file. */
  existing: Map<string, CompetitiveRecord>;
}

export function buildBulkPreview(sheet: ParsedSheet, ctx: BulkContext, batchChangeNote: string): BulkPreview {
  const missingColumns = missingHeaders(sheet.headers, BULK_REQUIRED_COLUMNS);
  const unexpectedColumns = unexpectedHeaders(sheet.headers, [
    ...BULK_REQUIRED_COLUMNS,
    ...BULK_IGNORED_COLUMNS,
    BULK_CHANGE_NOTE_COLUMN,
  ]);
  const idx = headerIndex(sheet.headers);
  const cell = (row: string[], label: string) => {
    const at = idx(label);
    return at >= 0 ? String(row[at] ?? "").trim() : "";
  };

  const idCounts = new Map<string, number>();
  for (const r of sheet.rows) {
    const id = cell(r, RECORD_ID_LABEL);
    if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }

  let notFound = 0;
  const rows: BulkPreviewRow[] = sheet.rows.map((raw, i) => {
    const line = i + 2;
    const issues: ImportIssue[] = [];
    const add = (field: string, value: string, message: string, severity: IssueSeverity = "error") =>
      issues.push({ row: line, field, value, message, severity });

    if (isBlankRow(raw)) return { line, recordId: "", status: "empty", changes: [], changeNote: "", issues };

    const recordId = cell(raw, RECORD_ID_LABEL);
    const changeNote = cell(raw, BULK_CHANGE_NOTE_COLUMN) || batchChangeNote.trim();
    if (!changeNote) add(BULK_CHANGE_NOTE_COLUMN, "", "A Change Note is required for every update");

    if (!recordId) {
      add(RECORD_ID_LABEL, "", "Record ID is required to identify the row to update");
      return { line, recordId, status: "error", changes: [], changeNote, issues };
    }
    if ((idCounts.get(recordId) ?? 0) > 1) add(RECORD_ID_LABEL, recordId, "Record ID appears more than once in the file");
    const existing = ctx.existing.get(recordId);
    if (!existing) {
      notFound++;
      add(RECORD_ID_LABEL, recordId, "No CI row with this Record ID");
      return { line, recordId, status: "error", changes: [], changeNote, issues };
    }

    // Build the edited row from the file, exactly as a manual Edit would.
    const values = Object.fromEntries(USER_FIELDS.map((f) => [f.key, cell(raw, f.label)])) as Record<UserFieldKey, string>;
    const numbers: Partial<Record<"actualOrder" | "asp", number>> = {};
    for (const key of ["actualOrder", "asp"] as const) {
      const label = FIELDS.find((f) => f.key === key)!.label;
      const parsed = parseAmount(values[key]);
      if (!parsed.ok) add(label, values[key], `${label} must be a number`);
      else numbers[key] = parsed.value;
    }
    const input: CompetitiveInput = {
      ...values,
      actualOrder: numbers.actualOrder ?? 0,
      asp: numbers.asp ?? 0,
    };
    for (const issue of validateInputIssues(input, { ...ctx, user: ctx.user }, existing)) {
      if (!issues.some((x) => x.field === issue.label)) add(issue.label, issue.value, issue.message);
    }

    const updated: CompetitiveRecord = {
      ...existing,
      ...input,
      fabRegion: fabRegionFor(ctx.reference, input.customer, input.fabLocation),
      revenue: computeRevenue(input.actualOrder, input.asp) ?? 0,
    };
    const changes = diffRecords(existing, updated);
    const blocking = issues.some((x) => x.severity === "error");
    if (!blocking && changes.length === 0) add("Row", recordId, "No changes — row skipped", "info");
    return {
      line,
      recordId,
      status: blocking ? "error" : changes.length ? "update" : "no-change",
      input,
      record: updated,
      changes,
      changeNote,
      issues,
    };
  });

  const issues = rows.flatMap((r) => r.issues);
  const count = (s: BulkPreviewRow["status"]) => rows.filter((r) => r.status === s).length;
  const summary = {
    totalRows: rows.length,
    emptySkipped: count("empty"),
    validUpdates: count("update"),
    noChange: count("no-change"),
    invalid: count("error"),
    notFound,
    errors: issues.filter((x) => x.severity === "error").length,
    warnings: issues.filter((x) => x.severity === "warning").length,
  };
  return {
    importType: "Bulk Update",
    fileName: sheet.fileName,
    missingColumns,
    unexpectedColumns,
    rows,
    issues,
    summary,
    // No partial commit: every row must be valid before anything is updated.
    canCommit: missingColumns.length === 0 && summary.invalid === 0 && summary.validUpdates > 0,
  };
}

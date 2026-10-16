import type { CiUser, CompetitiveInput, CompetitiveRecord, FormOptions } from "@/types/ci";
import { FIELDS, MANDATORY_FIELDS, USER_FIELDS } from "@/lib/ci/field-spec";
import { computeRevenue, diffRecords, fabRegionFor, validateInputIssues, type UserFieldKey } from "@/lib/ci/rules";
import { headerIndex, isBlankRow, missingHeaders, parseAmount, unexpectedHeaders } from "@/lib/ci/import/parse-values";
import type { ExcelRowsPreview, ExcelRowsPreviewRow, ImportIssue, IssueSeverity, ParsedSheet } from "@/lib/ci/import/types";

/**
 * Add or update rows from Excel (CI Prototype Import): a workbook whose first row is the grid's own column headings.
 * A line with no Application ID adds a new row; a line with the Application ID of an existing row updates that row
 * ("Download existing rows", edit, import again). Every row is checked with the same rules as manual entry
 * (validateInputIssues): mandatory fields, positive numbers, every dropdown / dependent value being one the form would
 * offer. Fab Region and Revenue are calculated; Created By and Date default to the importing person and today for new
 * rows. Pure: nothing is written here.
 *
 * Rows with problems are listed and left out; the valid rows can still be imported. (A template mismatch - a missing
 * column - blocks the whole file.)
 */

/** The first column: blank = add a new row, an existing row's Application ID = update that row. */
export const EXCEL_ID_LABEL = "Application ID";
/** The prototype calls the same column "Record ID"; a file that uses that heading is read the same way. */
const EXCEL_ID_ALIAS = "Record ID";

/** The template = Application ID, then the 20 user-entered grid columns, labelled as on screen. */
export const EXCEL_ROWS_TEMPLATE_HEADERS = [EXCEL_ID_LABEL, ...USER_FIELDS.map((f) => f.label)];

/** Columns a file must carry (Film(s) is the only optional one; the Application ID column is optional: without it every line is a new row). */
export const EXCEL_ROWS_REQUIRED_COLUMNS = MANDATORY_FIELDS.filter((f) => f.input !== "auto").map((f) => f.label);

/** Calculated / system columns an exported file carries; accepted and ignored. */
const IGNORED_COLUMNS = FIELDS.filter((f) => f.input === "auto").map((f) => f.label);

export interface ExcelRowsContext extends FormOptions {
  /** The acting Corporate Marketing user: becomes Created By on new rows. */
  user: CiUser;
  /** Today (yyyy-mm-dd): becomes the Date of new rows. */
  today: string;
  /** Existing rows for the Application IDs in the file, keyed by the lower-cased Application ID. */
  existing: Map<string, CompetitiveRecord>;
}

/** The key an Application ID is looked up by (trimmed, case-insensitive). */
export const applicationIdKey = (id: string) => id.trim().toLowerCase();

/** The Application ID cell of a data row: the "Application ID" column, else the prototype's "Record ID" column. */
export function applicationIdOf(headers: readonly string[], row: readonly string[]): string {
  const idx = headerIndex(headers);
  const at = idx(EXCEL_ID_LABEL) >= 0 ? idx(EXCEL_ID_LABEL) : idx(EXCEL_ID_ALIAS);
  return at >= 0 ? String(row[at] ?? "").trim() : "";
}

export function buildExcelRowsPreview(sheet: ParsedSheet, ctx: ExcelRowsContext): ExcelRowsPreview {
  const missingColumns = missingHeaders(sheet.headers, EXCEL_ROWS_REQUIRED_COLUMNS);
  const unexpectedColumns = unexpectedHeaders(sheet.headers, [...EXCEL_ROWS_TEMPLATE_HEADERS, ...IGNORED_COLUMNS, EXCEL_ID_ALIAS]);
  const idx = headerIndex(sheet.headers);
  const cell = (row: string[], label: string) => {
    const at = idx(label);
    return at >= 0 ? String(row[at] ?? "").trim() : "";
  };

  const idCounts = new Map<string, number>();
  for (const r of sheet.rows) {
    const id = applicationIdOf(sheet.headers, r);
    if (id) idCounts.set(applicationIdKey(id), (idCounts.get(applicationIdKey(id)) ?? 0) + 1);
  }

  const rows: ExcelRowsPreviewRow[] = sheet.rows.map((raw, i) => {
    const line = i + 2;
    const issues: ImportIssue[] = [];
    const add = (field: string, value: string, message: string, severity: IssueSeverity = "error") =>
      issues.push({ row: line, field, value, message, severity });

    if (isBlankRow(raw)) return { line, status: "empty", applicationId: "", changes: [], issues };

    const applicationId = applicationIdOf(sheet.headers, raw);
    let existing: CompetitiveRecord | undefined;
    if (applicationId) {
      existing = ctx.existing.get(applicationIdKey(applicationId));
      if (!existing) add(EXCEL_ID_LABEL, applicationId, `Application ID “${applicationId}” does not exist. Leave it blank to add a new row`);
      if ((idCounts.get(applicationIdKey(applicationId)) ?? 0) > 1) add(EXCEL_ID_LABEL, applicationId, `Application ID ${applicationId} appears twice in the file`);
    }

    const values = Object.fromEntries(USER_FIELDS.map((f) => [f.key, cell(raw, f.label)])) as Record<UserFieldKey, string>;
    const numbers: Partial<Record<"actualOrder" | "asp", number>> = {};
    for (const key of ["actualOrder", "asp"] as const) {
      const label = FIELDS.find((f) => f.key === key)!.label;
      const parsed = parseAmount(values[key]);
      if (!parsed.ok) {
        if (values[key] !== "") add(label, values[key], `${label} must be a number`);
      } else numbers[key] = parsed.value;
    }
    const input: CompetitiveInput = { ...values, actualOrder: numbers.actualOrder ?? 0, asp: numbers.asp ?? 0 };
    for (const issue of validateInputIssues(input, { ...ctx, user: ctx.user }, existing)) {
      if (!issues.some((x) => x.field === issue.label)) add(issue.label, issue.value, issue.message);
    }
    const blocking = issues.some((x) => x.severity === "error");
    const derived = { fabRegion: fabRegionFor(ctx.reference, input.customer, input.fabLocation), revenue: computeRevenue(input.actualOrder, input.asp) ?? 0 };

    if (existing) {
      const updated: CompetitiveRecord = { ...existing, ...input, ...derived };
      const changes = diffRecords(existing, updated);
      return { line, status: blocking ? "error" : changes.length ? "update" : "unchanged", applicationId, updated, changes, issues };
    }
    const record: Omit<CompetitiveRecord, "recordId"> = { ...input, ...derived, createdBy: ctx.user.name, createdOn: ctx.today };
    return { line, status: blocking ? "error" : "new", applicationId, record, changes: [], issues };
  });

  const issues = rows.flatMap((r) => r.issues);
  const count = (s: ExcelRowsPreviewRow["status"]) => rows.filter((r) => r.status === s).length;
  const summary = {
    totalRows: rows.length,
    emptySkipped: count("empty"),
    added: count("new"),
    updated: count("update"),
    unchanged: count("unchanged"),
    invalid: count("error"),
    errors: issues.filter((x) => x.severity === "error").length,
  };
  return {
    importType: "Excel Import",
    fileName: sheet.fileName,
    missingColumns,
    unexpectedColumns,
    rows,
    issues,
    summary,
    // A template mismatch blocks the file; otherwise the valid rows can be imported even if some rows have problems.
    canCommit: missingColumns.length === 0 && summary.added + summary.updated > 0,
  };
}

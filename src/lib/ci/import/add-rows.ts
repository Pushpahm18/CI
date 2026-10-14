import type { CiUser, CompetitiveInput, CompetitiveRecord, FormOptions } from "@/types/ci";
import { FIELDS, MANDATORY_FIELDS, USER_FIELDS } from "@/lib/ci/field-spec";
import { computeRevenue, fabRegionFor, validateInputIssues, type UserFieldKey } from "@/lib/ci/rules";
import { headerIndex, isBlankRow, missingHeaders, parseAmount, unexpectedHeaders } from "@/lib/ci/import/parse-values";
import type { ExcelRowsPreview, ExcelRowsPreviewRow, ImportIssue, IssueSeverity, ParsedSheet } from "@/lib/ci/import/types";

/**
 * Add rows from Excel (CI Prototype Import): a workbook whose first row is the
 * grid's own column headings, one new CI row per line. Every row is checked
 * with the same rules as manual entry (validateInputIssues): mandatory fields,
 * positive numbers, every dropdown / dependent value being one the form would
 * offer. Fab Region and Revenue are calculated, and Created By / Date default
 * to the importing person and today. Pure: nothing is written here.
 *
 * Prototype behaviour: rows with problems are listed and left out; the valid
 * rows can still be imported. (A template mismatch — a missing column — blocks
 * the whole file.)
 */

/** The template = the 20 user-entered grid columns, labelled as on screen. */
export const EXCEL_ROWS_TEMPLATE_HEADERS = USER_FIELDS.map((f) => f.label);

/** Columns a file must carry (Film(s) is the only optional one). */
export const EXCEL_ROWS_REQUIRED_COLUMNS = MANDATORY_FIELDS.filter((f) => f.input !== "auto").map((f) => f.label);

/** Calculated / system columns an exported file carries; accepted and ignored. */
const IGNORED_COLUMNS = FIELDS.filter((f) => f.input === "auto").map((f) => f.label);

export interface ExcelRowsContext extends FormOptions {
  /** The acting Corporate Marketing user: becomes Created By. */
  user: CiUser;
  /** Today (yyyy-mm-dd): becomes the Date. */
  today: string;
}

export function buildExcelRowsPreview(sheet: ParsedSheet, ctx: ExcelRowsContext): ExcelRowsPreview {
  const missingColumns = missingHeaders(sheet.headers, EXCEL_ROWS_REQUIRED_COLUMNS);
  const unexpectedColumns = unexpectedHeaders(sheet.headers, [...EXCEL_ROWS_TEMPLATE_HEADERS, ...IGNORED_COLUMNS, "Record ID"]);
  const idx = headerIndex(sheet.headers);
  const cell = (row: string[], label: string) => {
    const at = idx(label);
    return at >= 0 ? String(row[at] ?? "").trim() : "";
  };

  const rows: ExcelRowsPreviewRow[] = sheet.rows.map((raw, i) => {
    const line = i + 2;
    const issues: ImportIssue[] = [];
    const add = (field: string, value: string, message: string, severity: IssueSeverity = "error") =>
      issues.push({ row: line, field, value, message, severity });

    if (isBlankRow(raw)) return { line, status: "empty", issues };

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
    for (const issue of validateInputIssues(input, { ...ctx, user: ctx.user })) {
      if (!issues.some((x) => x.field === issue.label)) add(issue.label, issue.value, issue.message);
    }

    const record: Omit<CompetitiveRecord, "recordId"> = {
      ...input,
      fabRegion: fabRegionFor(ctx.reference, input.customer, input.fabLocation),
      revenue: computeRevenue(input.actualOrder, input.asp) ?? 0,
      createdBy: ctx.user.name,
      createdOn: ctx.today,
    };
    return { line, status: issues.some((x) => x.severity === "error") ? "error" : "ready", record, issues };
  });

  const issues = rows.flatMap((r) => r.issues);
  const count = (s: ExcelRowsPreviewRow["status"]) => rows.filter((r) => r.status === s).length;
  const summary = {
    totalRows: rows.length,
    emptySkipped: count("empty"),
    ready: count("ready"),
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
    canCommit: missingColumns.length === 0 && summary.ready > 0,
  };
}

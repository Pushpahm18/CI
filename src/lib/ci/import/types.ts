import type { CompetitiveInput, CompetitiveRecord, FieldChange } from "@/types/ci";

/** Shared shapes for CI Import (Historic Load and Bulk Update). */

export type ImportType = "Historic Load" | "Bulk Update" | "Excel Import";

export type IssueSeverity = "error" | "warning" | "info";

/** One row of the validation / error report (BRD §7.5; Row, Field, Value, Error, Severity). */
export interface ImportIssue {
  /** 1-based line in the file (header = line 1). */
  row: number;
  field: string;
  value: string;
  message: string;
  severity: IssueSeverity;
}

/** A parsed file as the server receives it: header row + data rows, all cells as text. */
export interface ParsedSheet {
  fileName: string;
  sheetName?: string;
  headers: string[];
  rows: string[][];
}

// ---------------------------------------------------------------- historic load

/** Fields whose file values are mapped onto CI list values (CI Prototype value-mapping table). */
export type MappedField = "customer" | "servedMarket" | "processType" | "topCompetitor";

export type MappingStatus = "exact" | "cleaned" | "suggested" | "mapped" | "unmapped";

export interface ValueMapping {
  field: MappedField;
  label: string;
  /** The value as it appears in the file. */
  source: string;
  /** The CI list value it maps to ("" when unmapped). */
  target: string;
  status: MappingStatus;
  /** Valid CI values the user can map to. */
  options: string[];
}

export type HistoricRowStatus = "ready" | "flagged" | "held" | "empty" | "not-loaded";

export interface HistoricPreviewRow {
  line: number;
  status: HistoricRowStatus;
  /** The transformed row that would be written (absent for empty rows). */
  record?: Omit<CompetitiveRecord, "recordId">;
  /** Old Notes → first Change Note. */
  changeNote: string;
  /** The row's values exactly as in the file, by historic column (row review shows these for held rows). */
  source: Record<string, string>;
  sourceCreatedBy: string;
  sourceAsp: string;
  sourceRevenue: string;
  issues: ImportIssue[];
}

export interface HistoricOptions {
  /** CI Prototype: load rows noted "Not competitor…" (flagged, note kept as the Change Note). */
  loadNotCompetitor: boolean;
  /** User-chosen mappings: `${field}|${sourceValue}` → CI value. */
  mappingOverrides: Record<string, string>;
}

export interface HistoricSummary {
  totalRows: number;
  emptySkipped: number;
  ready: number;
  flagged: number;
  held: number;
  notLoaded: number;
  inserts: number;
  errors: number;
  warnings: number;
}

export interface HistoricPreview {
  importType: "Historic Load";
  fileName: string;
  missingColumns: string[];
  unexpectedColumns: string[];
  mappings: ValueMapping[];
  rows: HistoricPreviewRow[];
  issues: ImportIssue[];
  summary: HistoricSummary;
  /** True only when there are no blocking errors and at least one row to load. */
  canCommit: boolean;
}

// ---------------------------------------------------------------- bulk update

export type BulkRowStatus = "update" | "no-change" | "error" | "empty";

export interface BulkPreviewRow {
  line: number;
  recordId: string;
  status: BulkRowStatus;
  input?: CompetitiveInput;
  /** The full row as it would be saved (Fab Region and Revenue re-derived). */
  record?: CompetitiveRecord;
  changes: FieldChange[];
  changeNote: string;
  issues: ImportIssue[];
}

export interface BulkSummary {
  totalRows: number;
  emptySkipped: number;
  validUpdates: number;
  noChange: number;
  invalid: number;
  notFound: number;
  errors: number;
  warnings: number;
}

export interface BulkPreview {
  importType: "Bulk Update";
  fileName: string;
  missingColumns: string[];
  unexpectedColumns: string[];
  rows: BulkPreviewRow[];
  issues: ImportIssue[];
  summary: BulkSummary;
  canCommit: boolean;
}

export interface ImportCommitResult {
  importType: ImportType;
  inserted: number;
  updated: number;
  skipped: number;
  flagged: number;
  notification: { recipients: number; delivered: boolean };
}

// ---------------------------------------------------------------- add / update rows from Excel

/** new = added; update = an existing row that changes; unchanged = an existing row identical to the file; error = left out. */
export type ExcelRowStatus = "new" | "update" | "unchanged" | "error" | "empty";

export interface ExcelRowsPreviewRow {
  /** 1-based line in the file (header = line 1). */
  line: number;
  status: ExcelRowStatus;
  /** The Application ID in the file ("" = a new row). */
  applicationId: string;
  /** A new row: as it would be created (Fab Region and Revenue derived; Created By / Date set). */
  record?: Omit<CompetitiveRecord, "recordId">;
  /** An update: the full row as it would be saved (Fab Region and Revenue re-derived). */
  updated?: CompetitiveRecord;
  /** An update: what changes, field by field. */
  changes: FieldChange[];
  issues: ImportIssue[];
}

export interface ExcelRowsSummary {
  totalRows: number;
  emptySkipped: number;
  added: number;
  updated: number;
  unchanged: number;
  invalid: number;
  errors: number;
}

export interface ExcelRowsPreview {
  importType: "Excel Import";
  fileName: string;
  missingColumns: string[];
  unexpectedColumns: string[];
  rows: ExcelRowsPreviewRow[];
  issues: ImportIssue[];
  summary: ExcelRowsSummary;
  /** True when the template matches and at least one row would be added or updated. Rows with problems are left out. */
  canCommit: boolean;
}

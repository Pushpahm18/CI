import { FIELD_BY_KEY, FIELDS, RECORD_ID_LABEL, USER_FIELDS } from "@/lib/ci/field-spec";
import type { CompetitiveRecord } from "@/types/ci";
import { formatDate } from "@/lib/utils";

/**
 * The CI import template = the grid's own column headings (CI Prototype), so
 * a file exported with "Export to excel" can be filled in and imported back.
 * Every user-entered column must be present; calculated/system columns
 * (Record ID, Fab Region, Revenue, Created Date) are ignored if present, and
 * Created By is optional (kept for historic rows).
 */
export const TEMPLATE_HEADERS = USER_FIELDS.map((f) => f.label);

export function missingTemplateHeaders(headers: string[]): string[] {
  const present = new Set(headers.map((h) => h.trim().toLowerCase()));
  return TEMPLATE_HEADERS.filter((h) => !present.has(h.toLowerCase()));
}

/** One export row: Record ID plus the 25 fields, labelled exactly as on screen. */
export function recordToExportRow(r: CompetitiveRecord, keys = FIELDS.map((f) => f.key)): Record<string, unknown> {
  const row: Record<string, unknown> = { [RECORD_ID_LABEL]: r.recordId };
  for (const key of keys) {
    const spec = FIELD_BY_KEY[key];
    row[spec.label] = key === "createdOn" && r.createdOn ? formatDate(r.createdOn) : r[key];
  }
  return row;
}

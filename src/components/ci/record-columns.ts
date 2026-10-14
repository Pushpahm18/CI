import type { CompetitiveRecord } from "@/types/ci";
import { FIELD_BY_KEY, FIELDS, RECORD_ID_LABEL, type FieldKey } from "@/lib/ci/field-spec";
import { formatDate } from "@/lib/utils";
import type { GridColumn } from "@/components/ci/data-grid";

/** Display formatting per the CI Prototype: whole numbers for counts, 2 decimals for ASP/Revenue. */
export function displayValue(r: CompetitiveRecord, key: FieldKey): string {
  const raw = r[key];
  if (raw === null || raw === undefined || raw === "") return "";
  if (key === "createdOn") return formatDate(String(raw));
  if (key === "asp" || key === "revenue") {
    const n = Number(raw);
    return Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(raw);
  }
  if (key === "actualOrder") {
    const n = Number(raw);
    return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : String(raw);
  }
  return String(raw);
}

export function recordColumn(key: FieldKey): GridColumn<CompetitiveRecord> {
  const spec = FIELD_BY_KEY[key];
  return {
    key,
    label: spec.label,
    filter: spec.filter,
    numeric: spec.numeric,
    value: (r) => displayValue(r, key),
    sortValue: spec.numeric
      ? (r) => Number(r[key]) || 0
      : key === "createdOn"
        ? (r) => Date.parse(r.createdOn) || 0
        : undefined,
  };
}

/** All Competitive Info View: the 25 fields in BRD order. */
export const ALL_VIEW_COLUMNS: GridColumn<CompetitiveRecord>[] = FIELDS.map((f) => recordColumn(f.key));

export const RECORD_ID_COLUMN: GridColumn<CompetitiveRecord> = {
  key: "recordId",
  label: RECORD_ID_LABEL,
  filter: "text",
  value: (r) => r.recordId,
};

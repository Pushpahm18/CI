import { describe, expect, it } from "vitest";
import { buildBulkPreview, BULK_REQUIRED_COLUMNS } from "@/lib/ci/import/bulk";
import { RECORD_ID_LABEL, USER_FIELDS } from "@/lib/ci/field-spec";
import { TEST_OPTIONS, TEST_USERS } from "@/lib/ci/import/test-fixtures";
import type { CompetitiveRecord } from "@/types/ci";
import type { ParsedSheet } from "@/lib/ci/import/types";

const EXISTING: CompetitiveRecord = {
  recordId: "CI-0001",
  quarter: "Q1",
  year: "2025",
  customer: "Samsung",
  fabLocation: "Samsung Hwaseong",
  fabRegion: "Korea",
  servedMarket: "Foundry",
  technologyNode: "L5",
  waferSize: '300mm (12")',
  processApplication: "DPT",
  processType: "Sacrificial - Conformal",
  processLocation: "FEOL",
  films: "SiO",
  productLine: "PEALD",
  topCompetitor: "AMAT",
  productName: "Producer",
  processModules: "2",
  orderType: "Module",
  actualOrder: 2,
  asp: 2.3,
  currency: "EUR",
  revenue: 4.6,
  toolType: "SiO-QCM",
  createdBy: "Shruti Mehta",
  createdOn: "2025-02-01",
};

function rowFrom(r: CompetitiveRecord, patch: Partial<Record<string, string>> = {}): string[] {
  return BULK_REQUIRED_COLUMNS.map((label) => {
    if (label in patch) return patch[label]!;
    if (label === RECORD_ID_LABEL) return r.recordId;
    const spec = USER_FIELDS.find((f) => f.label === label)!;
    return String(r[spec.key]);
  });
}

const ctx = { ...TEST_OPTIONS, user: TEST_USERS[0], existing: new Map([[EXISTING.recordId, EXISTING]]) };
const sheet = (rows: string[][], headers = BULK_REQUIRED_COLUMNS): ParsedSheet => ({ fileName: "bulk.csv", headers, rows });

describe("bulk update", () => {
  it("updates an existing row and recalculates Revenue", () => {
    const p = buildBulkPreview(sheet([rowFrom(EXISTING, { "Actual Order (#)": "4" })]), ctx, "Corrected quantity");
    expect(p.rows[0].status).toBe("update");
    expect(p.rows[0].record?.revenue).toBe(9.2);
    expect(p.rows[0].changes.map((c) => c.field)).toEqual(expect.arrayContaining(["actualOrder", "revenue"]));
    expect(p.canCommit).toBe(true);
  });
  it("requires a Change Note", () => {
    const p = buildBulkPreview(sheet([rowFrom(EXISTING, { "Film(s)": "SiN" })]), ctx, "  ");
    expect(p.rows[0].status).toBe("error");
    expect(p.canCommit).toBe(false);
  });
  it("accepts a per-row Change Note column instead of the batch note", () => {
    const headers = [...BULK_REQUIRED_COLUMNS, "Change Note"];
    const p = buildBulkPreview(sheet([[...rowFrom(EXISTING, { "Film(s)": "SiN" }), "Row note"]], headers), ctx, "");
    expect(p.rows[0].status).toBe("update");
    expect(p.rows[0].changeNote).toBe("Row note");
  });
  it("reports a Record ID that doesn't exist", () => {
    const p = buildBulkPreview(sheet([rowFrom(EXISTING, { [RECORD_ID_LABEL]: "CI-9999" })]), ctx, "note");
    expect(p.summary.notFound).toBe(1);
    expect(p.canCommit).toBe(false);
  });
  it("requires a Record ID", () => {
    const p = buildBulkPreview(sheet([rowFrom(EXISTING, { [RECORD_ID_LABEL]: "" })]), ctx, "note");
    expect(p.rows[0].issues[0].field).toBe(RECORD_ID_LABEL);
  });
  it("rejects the same Record ID twice in one file", () => {
    const r = rowFrom(EXISTING, { "Film(s)": "SiN" });
    const p = buildBulkPreview(sheet([r, r]), ctx, "note");
    expect(p.summary.invalid).toBe(2);
  });
  it("validates lookups with the manual-entry rules", () => {
    const p = buildBulkPreview(sheet([rowFrom(EXISTING, { Customer: "Nobody Inc" })]), ctx, "note");
    expect(p.rows[0].status).toBe("error");
  });
  it("skips rows with no changes", () => {
    const p = buildBulkPreview(sheet([rowFrom(EXISTING)]), ctx, "note");
    expect(p.rows[0].status).toBe("no-change");
    expect(p.canCommit).toBe(false);
  });
  it("rejects a file missing template columns", () => {
    const p = buildBulkPreview(sheet([["CI-0001"]], [RECORD_ID_LABEL]), ctx, "note");
    expect(p.missingColumns.length).toBeGreaterThan(0);
    expect(p.canCommit).toBe(false);
  });
});

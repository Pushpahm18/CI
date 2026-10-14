import { describe, expect, it } from "vitest";
import { buildExcelRowsPreview, EXCEL_ROWS_REQUIRED_COLUMNS, EXCEL_ROWS_TEMPLATE_HEADERS } from "@/lib/ci/import/add-rows";
import { TEST_OPTIONS, TEST_USERS } from "@/lib/ci/import/test-fixtures";
import type { ParsedSheet } from "@/lib/ci/import/types";

// Fake values only (src/lib/ci/import/test-fixtures.ts): nothing here touches a database.

const GOOD: Record<string, string> = {
  Quarter: "Q1",
  Year: "2025",
  Customer: "Samsung",
  "Fab Location": "Samsung Hwaseong",
  "Served Market": "Foundry",
  "Technology Node": "L5",
  "Wafer Size (mm)": '300mm (12")',
  "Process Application": "DPT",
  "Process Type": "Sacrificial - Conformal",
  "Process Location": "FEOL",
  "Film(s)": "",
  "Product Line": "PEALD",
  "Top Competitor": "AMAT",
  "Product Name": "Producer",
  "Process Modules": "2",
  "Order Type": "Module",
  "Actual Order (#)": "4",
  "ASP (in million) in Sales Currency": "2.5",
  Currency: "USD",
  "Tool Type": "SiO-QCM",
};

const ctx = { ...TEST_OPTIONS, user: TEST_USERS[0], today: "2026-10-12" };
const row = (patch: Record<string, string> = {}) => EXCEL_ROWS_TEMPLATE_HEADERS.map((h) => ({ ...GOOD, ...patch })[h] ?? "");
const sheet = (rows: string[][], headers: string[] = EXCEL_ROWS_TEMPLATE_HEADERS): ParsedSheet => ({ fileName: "rows.xlsx", headers, rows });

describe("add rows from Excel", () => {
  it("the template is the 20 user-entered columns and Film(s) is the only optional one", () => {
    expect(EXCEL_ROWS_TEMPLATE_HEADERS).toHaveLength(20);
    expect(EXCEL_ROWS_REQUIRED_COLUMNS).toHaveLength(19);
    expect(EXCEL_ROWS_REQUIRED_COLUMNS).not.toContain("Film(s)");
  });

  it("accepts a valid row and fills Fab Region, Revenue, Created By and Date", () => {
    const p = buildExcelRowsPreview(sheet([row()]), ctx);
    expect(p.rows[0].status).toBe("ready");
    expect(p.rows[0].record).toMatchObject({ fabRegion: "Korea", revenue: 10, createdBy: "Shruti Mehta", createdOn: "2026-10-12", productName: "Producer" });
    expect(p.canCommit).toBe(true);
  });

  it("lists rows with problems but still lets the valid rows through", () => {
    const p = buildExcelRowsPreview(sheet([row(), row({ Customer: "Nobody Inc" })]), ctx);
    expect(p.summary).toMatchObject({ ready: 1, invalid: 1 });
    expect(p.rows[1].issues[0]).toMatchObject({ row: 3, field: "Customer" });
    expect(p.canCommit).toBe(true);
  });

  it("checks the dependent lists: product must belong to the competitor", () => {
    const p = buildExcelRowsPreview(sheet([row({ "Top Competitor": "LAM", "Product Name": "Producer" })]), ctx);
    expect(p.rows[0].status).toBe("error");
    expect(p.rows[0].issues.some((i) => i.field === "Product Name")).toBe(true);
  });

  it("requires positive numbers and rejects text amounts", () => {
    const p = buildExcelRowsPreview(sheet([row({ "Actual Order (#)": "abc" }), row({ "ASP (in million) in Sales Currency": "0" })]), ctx);
    expect(p.rows.map((r) => r.status)).toEqual(["error", "error"]);
    expect(p.canCommit).toBe(false);
  });

  it("skips empty rows and blocks the whole file when a column is missing", () => {
    expect(buildExcelRowsPreview(sheet([row(), row({ Quarter: "", Year: "", Customer: "" }).map(() => "")]), ctx).summary.emptySkipped).toBe(1);
    const p = buildExcelRowsPreview(sheet([["Q1"]], ["Quarter"]), ctx);
    expect(p.missingColumns.length).toBeGreaterThan(0);
    expect(p.canCommit).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { applicationIdKey, buildExcelRowsPreview, EXCEL_ID_LABEL, EXCEL_ROWS_REQUIRED_COLUMNS, EXCEL_ROWS_TEMPLATE_HEADERS } from "@/lib/ci/import/add-rows";
import { TEST_OPTIONS, TEST_USERS } from "@/lib/ci/import/test-fixtures";
import type { ParsedSheet } from "@/lib/ci/import/types";
import type { CompetitiveRecord } from "@/types/ci";

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

/** An existing row that matches GOOD exactly. */
const EXISTING: CompetitiveRecord = {
  recordId: "11111111-aaaa",
  applicationId: "CI-0001",
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
  films: "",
  productLine: "PEALD",
  topCompetitor: "AMAT",
  productName: "Producer",
  processModules: "2",
  orderType: "Module",
  actualOrder: 4,
  asp: 2.5,
  currency: "USD",
  revenue: 10,
  toolType: "SiO-QCM",
  createdBy: "Old Owner",
  createdOn: "2025-01-01",
};

const existing = new Map([[applicationIdKey("CI-0001"), EXISTING]]);
const ctx = { ...TEST_OPTIONS, user: TEST_USERS[0], today: "2026-10-12", existing };
const row = (patch: Record<string, string> = {}) => EXCEL_ROWS_TEMPLATE_HEADERS.map((h) => ({ ...GOOD, ...patch })[h] ?? "");
const sheet = (rows: string[][], headers: string[] = EXCEL_ROWS_TEMPLATE_HEADERS): ParsedSheet => ({ fileName: "rows.xlsx", headers, rows });

describe("add or update rows from Excel", () => {
  it("the template is the Application ID plus the 20 user-entered columns; Film(s) is the only optional one", () => {
    expect(EXCEL_ROWS_TEMPLATE_HEADERS[0]).toBe(EXCEL_ID_LABEL);
    expect(EXCEL_ROWS_TEMPLATE_HEADERS).toHaveLength(21);
    expect(EXCEL_ROWS_REQUIRED_COLUMNS).toHaveLength(19);
    expect(EXCEL_ROWS_REQUIRED_COLUMNS).not.toContain("Film(s)");
    expect(EXCEL_ROWS_REQUIRED_COLUMNS).not.toContain(EXCEL_ID_LABEL);
  });

  it("a line with no Application ID is a new row, with Fab Region, Revenue, Created By and Date filled in", () => {
    const p = buildExcelRowsPreview(sheet([row()]), ctx);
    expect(p.rows[0].status).toBe("new");
    expect(p.rows[0].record).toMatchObject({ fabRegion: "Korea", revenue: 10, createdBy: "Shruti Mehta", createdOn: "2026-10-12", productName: "Producer" });
    expect(p.summary).toMatchObject({ added: 1, updated: 0, unchanged: 0, invalid: 0 });
    expect(p.canCommit).toBe(true);
  });

  it("a line with an existing Application ID updates that row and lists what changes; the creator is kept", () => {
    const p = buildExcelRowsPreview(sheet([row({ [EXCEL_ID_LABEL]: "CI-0001", "Actual Order (#)": "5" })]), ctx);
    expect(p.rows[0].status).toBe("update");
    expect(p.rows[0].changes.map((c) => c.label)).toContain("Actual Order (#)");
    expect(p.rows[0].updated).toMatchObject({ recordId: "11111111-aaaa", actualOrder: 5, revenue: 12.5, createdBy: "Old Owner", createdOn: "2025-01-01" });
    expect(p.summary).toMatchObject({ added: 0, updated: 1 });
    expect(p.canCommit).toBe(true);
  });

  it("an existing row identical to the file is unchanged and is not imported", () => {
    const p = buildExcelRowsPreview(sheet([row({ [EXCEL_ID_LABEL]: "ci-0001" })]), ctx);
    expect(p.rows[0].status).toBe("unchanged");
    expect(p.summary).toMatchObject({ unchanged: 1, added: 0, updated: 0 });
    expect(p.canCommit).toBe(false);
  });

  it("an unknown Application ID is a problem that says to leave it blank to add; a repeated one is a problem too", () => {
    const p = buildExcelRowsPreview(sheet([row({ [EXCEL_ID_LABEL]: "CI-9999" }), row({ [EXCEL_ID_LABEL]: "CI-0001" }), row({ [EXCEL_ID_LABEL]: "CI-0001" })]), ctx);
    expect(p.rows[0].status).toBe("error");
    expect(p.rows[0].issues[0].message).toBe("Application ID “CI-9999” does not exist. Leave it blank to add a new row");
    expect(p.rows[1].status).toBe("error");
    expect(p.rows[2].issues.some((i) => i.message === "Application ID CI-0001 appears twice in the file")).toBe(true);
  });

  it("reads the prototype's \"Record ID\" heading the same way", () => {
    const headers = ["Record ID", ...EXCEL_ROWS_TEMPLATE_HEADERS.slice(1)];
    const p = buildExcelRowsPreview(sheet([row({ [EXCEL_ID_LABEL]: "CI-0001", "Actual Order (#)": "6" })], headers), ctx);
    expect(p.rows[0].status).toBe("update");
  });

  it("a file without an Application ID column adds every line as a new row", () => {
    const headers = EXCEL_ROWS_TEMPLATE_HEADERS.slice(1);
    const p = buildExcelRowsPreview(sheet([row().slice(1)], headers), ctx);
    expect(p.missingColumns).toEqual([]);
    expect(p.rows[0].status).toBe("new");
  });

  it("lists rows with problems but still lets the valid rows through", () => {
    const p = buildExcelRowsPreview(sheet([row(), row({ Customer: "Nobody Inc" })]), ctx);
    expect(p.summary).toMatchObject({ added: 1, invalid: 1 });
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
    expect(buildExcelRowsPreview(sheet([row(), row().map(() => "")]), ctx).summary.emptySkipped).toBe(1);
    const p = buildExcelRowsPreview(sheet([["Q1"]], ["Quarter"]), ctx);
    expect(p.missingColumns.length).toBeGreaterThan(0);
    expect(p.canCommit).toBe(false);
  });
});

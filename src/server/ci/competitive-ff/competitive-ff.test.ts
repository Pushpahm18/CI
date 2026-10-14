import { describe, expect, it, vi } from "vitest";
import { assertReadOnlyStatement } from "@/server/db/read-only";
import { CiError, ForbiddenError, NotConfiguredError } from "@/server/ci/errors";
import { FLAT_FILE_ROW_LIMIT, buildFlatFileStatement, rowToFlatRecord } from "@/server/ci/competitive-ff/data";
import { loadFlatFile, type FlatFileDeps } from "@/server/ci/competitive-ff/service";

// Fakes only: no database connection is opened.

const id = { email: "cm@example.com", name: "CM" };
const raw = {
  ci_id: "e7d9", quarter: "Q2", year: "2026", customer: "Samsung", fab_location: "Samsung Austin", fab_region: "KOR", served_market: "Foundry",
  technology_node: "L14", wafer_size_mm: "300.0", process_application: "Isolation", process_type: "Sacrificial - Conformal", process_location: "Channel",
  films: null, product_line: "PEALD", top_competitor: "Wonik IPS", product_name: "Batch ALD", process_modules: "1", order_type: "Tool",
  actual_order: "6.0", asp_million: "4.71", currency: "USD", revenue_sales_currency: "28.259999999999998", tool_type: "Y2O3-DCM",
  created_by: "M. Tanaka", created_date: "2026-04-02", modified_by: null, modified_date: null, is_active: "true",
};

describe("Competitive FF data", () => {
  it("is one read-only statement over the verified ci_main columns, live rows only, newest first, one row over the limit", () => {
    const sql = buildFlatFileStatement("corp_marketing_dev.ci.ci_main");
    expect(() => assertReadOnlyStatement(sql)).not.toThrow();
    expect(sql).toContain("`ci_id`");
    expect(sql).toContain("`revenue_sales_currency`");
    expect(sql).toContain("WHERE `is_active` = TRUE");
    expect(sql).toContain("ORDER BY `created_date` DESC");
    expect(sql).toMatch(new RegExp(`LIMIT ${FLAT_FILE_ROW_LIMIT + 1}$`));
  });

  it("maps a row: numbers are numbers, blanks are empty, the wafer size shows its approved label", () => {
    const r = rowToFlatRecord(raw);
    expect(r).toMatchObject({ recordId: "e7d9", year: "2026", customer: "Samsung", fabRegion: "KOR", waferSize: '300mm (12")', films: "", actualOrder: 6, asp: 4.71, currency: "USD", createdBy: "M. Tanaka", createdOn: "2026-04-02" });
    expect(r.revenue).toBeCloseTo(28.26, 5);
    expect(r.modifiedBy).toBeUndefined();
  });

  it("a wafer size outside the approved three is shown exactly as stored", () => {
    expect(rowToFlatRecord({ ...raw, wafer_size_mm: "450.0" }).waferSize).toBe("450.0");
  });
});

describe("loadFlatFile", () => {
  const make = (over: Partial<FlatFileDeps> = {}): FlatFileDeps => ({
    source: () => ({ catalog: "corp_marketing_dev", schema: "ci", table: "ci_main" }),
    requireConnected: vi.fn(),
    authorize: vi.fn(async () => ({})),
    query: vi.fn(async () => [raw]),
    ...over,
  });

  it("returns the mapped rows for Corporate Marketing", async () => {
    const res = await loadFlatFile(id, make());
    expect(res.records).toHaveLength(1);
    expect(res.truncated).toBe(false);
  });

  it("an Account Team (or any refused) caller gets the refusal and no rows, even though the read started alongside", async () => {
    const query = vi.fn(async () => [raw]);
    await expect(loadFlatFile(id, make({ authorize: async () => { throw new ForbiddenError("Corporate Marketing access is required."); }, query }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("reports truncation instead of silently cutting rows", async () => {
    const many = Array.from({ length: FLAT_FILE_ROW_LIMIT + 1 }, () => raw);
    const res = await loadFlatFile(id, make({ query: async () => many }));
    expect(res.records).toHaveLength(FLAT_FILE_ROW_LIMIT);
    expect(res.truncated).toBe(true);
  });

  it("says the table configuration is pending when there is no source, and reads nothing", async () => {
    const query = vi.fn(async () => []);
    await expect(loadFlatFile(id, make({ source: () => null, query }))).rejects.toBeInstanceOf(NotConfiguredError);
    expect(query).not.toHaveBeenCalled();
  });

  it("hides the database's own error text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = (await loadFlatFile(id, make({ query: async () => { throw new Error("PERMISSION_DENIED token dapiSECRET"); } })).catch((e) => e)) as CiError;
    expect(err).toBeInstanceOf(CiError);
    expect(err.message).not.toMatch(/PERMISSION|dapi/);
    spy.mockRestore();
  });
});

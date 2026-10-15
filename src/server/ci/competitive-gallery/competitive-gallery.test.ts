import { describe, expect, it, vi } from "vitest";
import { CiError, NotConfiguredError } from "@/server/ci/errors";
import { GALLERY_ROW_LIMIT, buildDescribeStatement, buildSelectStatement, newestFirstOrder, parseDescribe, toGalleryRow } from "@/server/ci/competitive-gallery/data";
import { loadGallery, type GalleryServiceDeps } from "@/server/ci/competitive-gallery/service";
import { assertReadOnlyStatement } from "@/server/db/read-only";

// Fake table and column names only: nothing here reads any real table.
const TABLE = "test_catalog.test_schema.test_table";
const identity = { email: "a@example.com", name: "A" };

function deps(over: Partial<GalleryServiceDeps> = {}): GalleryServiceDeps {
  return {
    source: () => ({ catalog: "test_catalog", schema: "test_schema", table: "test_table" }),
    requireConnected: vi.fn(),
    authorize: vi.fn().mockResolvedValue({ role: "Corporate Marketing", scope: null }),
    scopeColumns: () => ({ customer: "c_cust", segment: "c_seg", region: "c_reg" }),
    query: vi.fn(async (s: string) =>
      s.startsWith("DESCRIBE")
        ? [{ col_name: "c_one", data_type: "string" }, { col_name: "c_two", data_type: "int" }, { col_name: "", data_type: "" }, { col_name: "# Partition Information", data_type: "" }, { col_name: "c_part", data_type: "string" }]
        : [{ c_one: "x", c_two: 1, extra: "ignored" }, { c_one: null, c_two: null }]
    ),
    ...over,
  };
}

describe("gallery statements", () => {
  it("are single read-only statements", () => {
    expect(() => assertReadOnlyStatement(buildDescribeStatement(TABLE))).not.toThrow();
    expect(() => assertReadOnlyStatement(buildSelectStatement(TABLE))).not.toThrow();
    expect(buildSelectStatement(TABLE)).toBe("SELECT * FROM `test_catalog`.`test_schema`.`test_table` LIMIT " + (GALLERY_ROW_LIMIT + 1));
  });
  it("orders newest first, stays read-only, and keeps the scope predicates", () => {
    const order = newestFirstOrder({ modifiedOn: "m", createdOn: "c", recordId: "id" });
    const sql = buildSelectStatement(TABLE, 10, { columns: { customer: "c_cust", segment: "c_seg", region: "c_reg" }, scope: { customers: ["A"], segments: "All", regions: "All" } }, order);
    expect(() => assertReadOnlyStatement(sql)).not.toThrow();
    expect(sql).toBe("SELECT * FROM `test_catalog`.`test_schema`.`test_table` WHERE `c_cust` IN ('A') ORDER BY COALESCE(`m`, CAST(`c` AS TIMESTAMP)) DESC, `id` DESC LIMIT 11");
  });
  it("parseDescribe stops at the first blank / # row", () => {
    expect(parseDescribe([{ col_name: "a", data_type: "int" }, { col_name: "" }, { col_name: "b" }])).toEqual([{ name: "a", type: "int" }]);
  });
  it("toGalleryRow keeps only described columns, as text", () => {
    expect(toGalleryRow({ a: 1, b: null, z: "no" }, [{ name: "a", type: "int" }, { name: "b", type: "string" }])).toEqual({ a: "1", b: "" });
  });
});

describe("loadGallery", () => {
  it("returns the described columns and the rows as text", async () => {
    const res = await loadGallery(identity, deps());
    expect(res.table).toBe(TABLE);
    expect(res.columns.map((c) => c.name)).toEqual(["c_one", "c_two"]);
    expect(res.rows).toEqual([{ c_one: "x", c_two: "1" }, { c_one: "", c_two: "" }]);
    expect(res.truncated).toBe(false);
  });
  it("reports pending configuration without touching the database", async () => {
    const d = deps({ source: () => null });
    await expect(loadGallery(identity, d)).rejects.toBeInstanceOf(NotConfiguredError);
    expect(d.query).not.toHaveBeenCalled();
  });
  it("authorizes before reading", async () => {
    const d = deps({ authorize: vi.fn().mockRejectedValue(new CiError("no", 403, "FORBIDDEN")) });
    await expect(loadGallery(identity, d)).rejects.toMatchObject({ status: 403 });
    expect(d.query).not.toHaveBeenCalled();
  });
  it("flags truncation", async () => {
    const many = Array.from({ length: GALLERY_ROW_LIMIT + 1 }, () => ({ c_one: "x", c_two: 1 }));
    const d = deps({ query: vi.fn(async (s: string) => (s.startsWith("DESCRIBE") ? [{ col_name: "c_one", data_type: "string" }] : many)) });
    const res = await loadGallery(identity, d);
    expect(res.truncated).toBe(true);
    expect(res.rows).toHaveLength(GALLERY_ROW_LIMIT);
  });
  it("hides Databricks error text from the caller", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps({ query: vi.fn().mockRejectedValue(new Error("secret host detail")) });
    await expect(loadGallery(identity, d)).rejects.toMatchObject({ status: 502, message: expect.not.stringContaining("secret") });
    spy.mockRestore();
  });
});

describe("Account Team scope", () => {
  const scope = { customers: ["UMC"], segments: ["Foundry"], regions: ["TWN"] };
  const rows = [
    { c_cust: "UMC", c_seg: "Foundry", c_reg: "TWN", c_other: "in" },
    { c_cust: "UMC", c_seg: "Logic", c_reg: "TWN", c_other: "wrong segment" },
    { c_cust: "Intel", c_seg: "Foundry", c_reg: "TWN", c_other: "wrong customer" },
    { c_cust: "UMC", c_seg: "Foundry", c_reg: "KOR", c_other: "wrong region" },
    { c_cust: "UMC", c_seg: "Foundry", c_reg: "", c_other: "no region" },
  ];
  const describeRows = [{ col_name: "c_cust", data_type: "string" }, { col_name: "c_seg", data_type: "string" }, { col_name: "c_reg", data_type: "string" }, { col_name: "c_other", data_type: "string" }];
  const scoped = (over: Partial<GalleryServiceDeps> = {}) =>
    deps({
      authorize: vi.fn().mockResolvedValue({ role: "Account Team", scope }),
      // a misbehaving source that ignores the WHERE clause: the service must still filter every row
      query: vi.fn(async (s: string) => (s.startsWith("DESCRIBE") ? describeRows : rows)),
      ...over,
    });

  it("puts all three dimensions in the query and drops every out-of-scope row even if the source returned them", async () => {
    const d = scoped();
    const res = await loadGallery(identity, d);
    const select = (d.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string).find((q) => q.startsWith("SELECT"))!;
    expect(select).toContain("WHERE `c_cust` IN ('UMC') AND `c_seg` IN ('Foundry') AND `c_reg` IN ('TWN')");
    expect(res.rows.map((r) => r.c_other)).toEqual(["in"]);
    expect(() => assertReadOnlyStatement(select)).not.toThrow();
  });

  it("refuses rather than serving unfiltered when the scope columns are not in the table", async () => {
    const d = scoped({ query: vi.fn(async (s: string) => (s.startsWith("DESCRIBE") ? [{ col_name: "c_cust", data_type: "string" }] : rows)) });
    await expect(loadGallery(identity, d)).rejects.toMatchObject({ status: 403 });
    expect((d.query as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).startsWith("SELECT"))).toBe(false);
  });

  it("escapes a hostile scope value", async () => {
    const d = scoped({ authorize: vi.fn().mockResolvedValue({ role: "Account Team", scope: { ...scope, customers: ["x'); DROP TABLE t; --"] } }) });
    await loadGallery(identity, d);
    const select = (d.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string).find((q) => q.startsWith("SELECT"))!;
    expect(select).toContain("'x''); DROP TABLE t; --'");
  });

  it("a dimension set to All adds no predicate and needs no column; only the listed ones filter", async () => {
    const d = scoped({
      authorize: vi.fn().mockResolvedValue({ role: "Account Team", scope: { customers: ["UMC"], segments: "All", regions: "All" } }),
      query: vi.fn(async (s: string) => (s.startsWith("DESCRIBE") ? [{ col_name: "c_cust", data_type: "string" }, { col_name: "c_other", data_type: "string" }] : rows)),
    });
    const res = await loadGallery(identity, d);
    const select = (d.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string).find((q) => q.startsWith("SELECT"))!;
    expect(select).toContain("WHERE `c_cust` IN ('UMC')");
    expect(select).not.toContain("c_seg");
    expect(select).not.toContain("c_reg");
    expect(res.rows.map((r) => r.c_other)).toEqual(["in", "wrong segment", "wrong region", "no region"]);
  });

  it("All / All / All has no WHERE clause at all", async () => {
    const d = scoped({ authorize: vi.fn().mockResolvedValue({ role: "Account Team", scope: { customers: "All", segments: "All", regions: "All" } }) });
    await loadGallery(identity, d);
    const select = (d.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string).find((q) => q.startsWith("SELECT"))!;
    expect(select).not.toContain("WHERE");
  });

  it("Corporate Marketing is not filtered", async () => {
    const d = scoped({ authorize: vi.fn().mockResolvedValue({ role: "Corporate Marketing", scope: null }) });
    expect((await loadGallery(identity, d)).rows).toHaveLength(5);
  });
});

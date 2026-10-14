import { describe, expect, it, vi } from "vitest";
import { assertReadOnlyStatement } from "@/server/db/read-only";
import { LOOKUP_USAGE_COLUMNS } from "@/server/db/schema";
import {
  assertLookupWriteStatement,
  buildDeactivateStatement,
  buildInsertStatement,
  buildListStatement,
  buildReorderStatement,
  buildUsageStatement,
  createLookupStore,
  rowToLookup,
  type LookupStoreDeps,
} from "@/server/ci/databricks/lookups";

// Fake table names and an in-memory fake database only: nothing here opens a Databricks connection.

const TABLE = "test_catalog.test_schema.test_lookup";
const T = "`test_catalog`.`test_schema`.`test_lookup`";
const NOW = "2026-10-12T09:00:00.000Z";

describe("statements", () => {
  it("lists with the mapped columns only, as a read-only SELECT", () => {
    const sql = buildListStatement(TABLE);
    expect(sql).toBe(
      `SELECT \`lookup_id\`, \`lookup_type\`, \`lookup_value\`, \`display_order\`, \`is_active\` FROM ${T} ORDER BY \`lookup_type\`, \`display_order\``
    );
    expect(() => assertReadOnlyStatement(sql)).not.toThrow();
  });

  it("maps a row; only an exact true flag is active", () => {
    const row = { lookup_id: " a ", lookup_type: "Quarter", lookup_value: " Q1 ", display_order: "2", is_active: "true" };
    const mapped = rowToLookup(row);
    expect(mapped.category).toBe("Quarter");
    expect(mapped.sortOrder).toBe(2);
    expect(mapped.active).toBe(true);
    for (const flag of [null, undefined, "false", "", "1"]) expect(rowToLookup({ ...row, is_active: flag }).active).toBe(false);
  });

  it("adds with one MERGE that carries all the table's columns and escapes quotes", () => {
    const sql = buildInsertStatement(TABLE, { id: "i1", category: "Quarter", value: "Q'5", sortOrder: 5, actor: "Ann", now: NOW });
    expect(sql.startsWith(`MERGE INTO ${T}`)).toBe(true);
    expect(sql).toContain("'Q''5'");
    for (const c of ["lookup_id", "lookup_type", "lookup_value", "display_order", "is_active", "created_by", "created_on", "modified_by", "modified_on"]) {
      expect(sql).toContain(`\`${c}\``);
    }
    expect(() => assertLookupWriteStatement(TABLE, sql)).not.toThrow();
  });

  it("removes by setting inactive: an UPDATE keyed on the id, never a DELETE", () => {
    const sql = buildDeactivateStatement(TABLE, { id: "i1", actor: "Ann", now: NOW });
    expect(sql).toContain("SET `is_active` = FALSE");
    expect(sql).toMatch(/WHERE `lookup_id` = 'i1'$/);
    expect(sql).not.toMatch(/DELETE/i);
    expect(() => assertLookupWriteStatement(TABLE, sql)).not.toThrow();
  });

  it("reorders a whole list in one UPDATE limited to that list's ids", () => {
    const sql = buildReorderStatement(TABLE, { category: "Quarter", orderedIds: ["b", "a"], actor: "Ann", now: NOW });
    expect(sql).toContain("CASE `lookup_id` WHEN 'b' THEN 1 WHEN 'a' THEN 2 END");
    expect(sql).toContain("WHERE `lookup_type` = 'Quarter' AND `lookup_id` IN ('b', 'a')");
    expect(() => assertLookupWriteStatement(TABLE, sql)).not.toThrow();
  });

  it("the write guard accepts only a single MERGE INTO / UPDATE of its own table", () => {
    const bad = [
      `DELETE FROM ${T}`,
      `DROP TABLE ${T}`,
      `TRUNCATE TABLE ${T}`,
      "UPDATE `other`.`schema`.`table` SET x = 1",
      "MERGE INTO `corp_marketing_dev`.`samba`.`samba_user` AS t USING (SELECT 1) AS s ON 1=1",
      `UPDATE ${T} SET \`is_active\` = FALSE; DELETE FROM ${T}`,
    ];
    for (const statement of bad) expect(() => assertLookupWriteStatement(TABLE, statement)).toThrow(/Refused/);
  });

  it("a hostile value cannot break out of its string", () => {
    const sql = buildInsertStatement(TABLE, { id: "i", category: "Quarter", value: "x'); DROP TABLE t; --", sortOrder: 1, actor: "a", now: NOW });
    expect(() => assertLookupWriteStatement(TABLE, sql)).not.toThrow();
    expect(sql).toContain("'x''); DROP TABLE t; --'");
  });

  it("counts usage only for lists with a mapped ci_main column, as one read-only statement", () => {
    const built = buildUsageStatement("test_catalog.test_schema.test_main")!;
    expect(built.categories).toContain("Wafer Size");
    expect(Object.values(LOOKUP_USAGE_COLUMNS).filter(Boolean)).toHaveLength(built.categories.length);
    expect(built.statement).toContain("CAST(`year` AS STRING)");
    expect(built.statement).toContain("CASE `wafer_size_mm` WHEN 150 THEN '150mm (6\")' WHEN 200 THEN '200mm (8\")' WHEN 300 THEN '300mm (12\")' END");
    // the count covers every ci_main row: no active/inactive filter, and ci_lookup.is_active is not involved
    expect(built.statement).not.toMatch(/is_active|WHERE/i);
    expect(() => assertReadOnlyStatement(built.statement)).not.toThrow();
  });
});

function fakeDb() {
  const execute = vi.fn<(statement: string) => Promise<void>>(async () => {});
  const query = vi.fn<(statement: string) => Promise<Record<string, unknown>[]>>(async () => [
    { t: "Quarter", v: "Q1", n: "3" },
    { t: "Year", v: "2025", n: 2 },
    { t: "Quarter", v: null, n: 9 },
  ]);
  const deps: LookupStoreDeps = { query, execute, now: () => NOW, newId: () => "new-id" };
  return { deps, query, execute };
}

describe("store (fake database)", () => {
  it("add sends exactly one guarded MERGE and returns the new value", async () => {
    const { deps, execute } = fakeDb();
    const created = await createLookupStore(TABLE, null, deps).addLookup("Quarter", "Q9", 4, "Ann");
    expect(created).toEqual({ id: "new-id", category: "Quarter", value: "Q9", sortOrder: 4, active: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].startsWith(`MERGE INTO ${T}`)).toBe(true);
  });

  it("remove and reorder each send exactly one UPDATE; an empty reorder sends nothing", async () => {
    const { deps, execute } = fakeDb();
    const store = createLookupStore(TABLE, null, deps);
    await store.deactivateLookup("x", "Ann");
    await store.reorderLookups("Quarter", ["a", "b"], "Ann");
    await store.reorderLookups("Quarter", [], "Ann");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.every(([s]) => s.startsWith(`UPDATE ${T}`))).toBe(true);
  });

  it("usage maps counts, ignores blank values, and is empty when ci_main is not configured", async () => {
    const { deps } = fakeDb();
    const usage = await createLookupStore(TABLE, "test_catalog.test_schema.test_main", deps).usage();
    expect(usage.counts).toEqual({ "Quarter|Q1": 3, "Year|2025": 2 });
    expect(usage.categories).toContain("Quarter");
    expect(await createLookupStore(TABLE, null, deps).usage()).toEqual({ counts: {}, categories: [] });
  });

  it("a failed write is not swallowed", async () => {
    const { deps } = fakeDb();
    deps.execute = vi.fn(async () => {
      throw new Error("PERMISSION_DENIED");
    });
    await expect(createLookupStore(TABLE, null, deps).deactivateLookup("x")).rejects.toThrow("PERMISSION_DENIED");
  });
});

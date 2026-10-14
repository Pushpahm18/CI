import { describe, expect, it } from "vitest";
import {
  buildDeleteByKeys,
  buildInsert,
  buildMerge,
  buildMergeMany,
  isActiveFilterValue,
  pageClause,
  qCol,
  qTable,
  sqlIn,
  sqlLiteral,
  whereClause,
  withCompensation,
} from "@/server/db/sql";
import { fromJsonColumn, iso, isInactiveFlag, num, numOrNull, scopeFromText, scopeToText, splitList, str, toJsonColumn } from "@/server/db/row-values";

const T = "cat.sch.tbl";

describe("sql helpers", () => {
  it("escapes literals and identifiers", () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral(3.5)).toBe("3.5");
    expect(sqlLiteral(Number.NaN)).toBe("'NaN'");
    expect(sqlLiteral(true)).toBe("TRUE");
    expect(qCol("a`b")).toBe("`ab`");
    expect(qTable(T)).toBe("`cat`.`sch`.`tbl`");
    expect(sqlLiteral("x'; DROP TABLE t; --")).toBe("'x''; DROP TABLE t; --'");
  });

  it("builds IN / WHERE without widening on empty input", () => {
    expect(sqlIn("customer", [])).toBe("1 = 0");
    expect(sqlIn("customer", ["A", "B"])).toBe("`customer` IN ('A', 'B')");
    expect(whereClause([])).toBe("");
    expect(whereClause(["a = 1", "b = 2"])).toBe("WHERE a = 1 AND b = 2");
    expect(isActiveFilterValue("All")).toBe(false);
    expect(isActiveFilterValue("  ")).toBe(false);
    expect(isActiveFilterValue("Micron")).toBe(true);
  });

  it("MERGE updates non-key columns only and keeps insert-only columns out of UPDATE", () => {
    const sql = buildMerge(T, "id", { id: "CI-0001", customer: "UMC" }, { created_on: "2026-01-01" });
    expect(sql).toContain("MERGE INTO `cat`.`sch`.`tbl` AS t");
    expect(sql).toContain("ON t.`id` = s.`id`");
    expect(sql).toContain("WHEN MATCHED THEN UPDATE SET t.`customer` = s.`customer`");
    expect(sql).not.toMatch(/UPDATE SET[^\n]*created_on/);
    expect(sql).toContain("INSERT (`id`, `customer`, `created_on`)");
    expect(() => buildMerge(T, "id", { customer: "UMC" })).toThrow(/primary key/);
  });

  it("batch MERGE is a single statement over all rows", () => {
    const sql = buildMergeMany(T, "id", [
      { id: "1", v: "a" },
      { id: "2", v: "b" },
    ]);
    expect(sql.match(/MERGE INTO/g)).toHaveLength(1);
    expect(sql).toContain("UNION ALL");
  });

  it("builds inserts, deletes and page clauses", () => {
    expect(buildInsert(T, [{ a: 1, b: "x" }])).toBe("INSERT INTO `cat`.`sch`.`tbl` (`a`, `b`) VALUES (1, 'x')");
    expect(buildDeleteByKeys(T, "id", ["1"])).toBe("DELETE FROM `cat`.`sch`.`tbl` WHERE `id` IN ('1')");
    expect(pageClause(undefined, undefined)).toBe("LIMIT 100 OFFSET 0");
    expect(pageClause(5000, -3)).toBe("LIMIT 200 OFFSET 0");
  });

  it("runs the compensating undo and rethrows the original error", async () => {
    let undone = false;
    await expect(
      withCompensation(
        async () => {
          throw new Error("write 2 failed");
        },
        async () => {
          undone = true;
        }
      )
    ).rejects.toThrow("write 2 failed");
    expect(undone).toBe(true);
  });
});

describe("row-values mappers", () => {
  it("converts blanks and bad values safely", () => {
    expect(str(null, "—")).toBe("—");
    expect(str("  x ")).toBe("x");
    expect(num("12.5")).toBe(12.5);
    expect(num("", 7)).toBe(7);
    expect(numOrNull("abc")).toBeNull();
    expect(iso("not a date", "fallback")).toBe("fallback");
    expect(iso("2026-03-01T00:00:00Z", "")).toBe("2026-03-01T00:00:00.000Z");
  });

  it("round-trips scope columns and never widens a blank scope by default", () => {
    expect(splitList("Micron, SK Hynix ,")).toEqual(["Micron", "SK Hynix"]);
    expect(scopeFromText("all")).toBe("All");
    expect(scopeFromText("")).toEqual([]);
    expect(scopeFromText("", true)).toBe("All");
    expect(scopeToText(["A", "B"])).toBe("A, B");
    expect(scopeFromText(scopeToText(["A", "B"]))).toEqual(["A", "B"]);
    expect(isInactiveFlag("false")).toBe(true);
    expect(isInactiveFlag("true")).toBe(false);
  });

  it("stores structured data as JSON and reads it back without throwing", () => {
    const changes = [{ field: "asp", previous: "1", current: "2" }];
    expect(fromJsonColumn(toJsonColumn(changes), [])).toEqual(changes);
    expect(fromJsonColumn("free text", [])).toEqual([]);
    expect(toJsonColumn(null)).toBeNull();
  });
});

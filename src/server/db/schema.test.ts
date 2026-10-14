import { describe, expect, it } from "vitest";
import {
  assertIdentifier,
  CI_TABLE_LABELS,
  CI_TABLES,
  ciTableName,
  tableName,
  type CiTableKey,
  type CiTables,
} from "@/server/db/schema";

// Pure tests only: no Databricks connection, no queries.

describe("identifier validation", () => {
  it("accepts plain identifiers and rejects anything that could alter a query", () => {
    expect(assertIdentifier("sb_ServerMarket")).toBe("sb_ServerMarket");
    expect(assertIdentifier("_x1")).toBe("_x1");
    for (const bad of ["", "a b", "a.b", "a;b", "a`b", "1abc", "a-b", "x'; DROP TABLE t; --"]) {
      expect(() => assertIdentifier(bad)).toThrow(/Invalid SQL identifier/);
    }
  });

  it("builds a validated catalog.schema.table name", () => {
    expect(tableName({ catalog: "c", schema: "s", table: "t" })).toBe("c.s.t");
    expect(() => tableName({ catalog: "c", schema: "s.x", table: "t" })).toThrow();
    expect(() => tableName({ catalog: "c", schema: "s", table: "t; --" })).toThrow();
  });
});

describe("CI tables", () => {
  const keys = Object.keys(CI_TABLE_LABELS) as CiTableKey[];

  it("has a label and an entry (null = pending, or a valid name) for every table", () => {
    expect(Object.keys(CI_TABLES).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(CI_TABLE_LABELS[key].length).toBeGreaterThan(0);
      expect(() => ciTableName(key)).not.toThrow();
    }
  });

  it("returns null for a pending table and the full name once configured", () => {
    const tables = { ...CI_TABLES, lookups: { catalog: "c", schema: "s", table: "t" } } as CiTables;
    expect(ciTableName("lookups", tables)).toBe("c.s.t");
    expect(ciTableName("competitiveInfo", { ...tables, competitiveInfo: null })).toBeNull();
  });

  it("rejects a configured table whose name is not a plain identifier", () => {
    const bad = { ...CI_TABLES, lookups: { catalog: "c", schema: "s", table: "t; DROP" } } as CiTables;
    expect(() => ciTableName("lookups", bad)).toThrow();
  });
});

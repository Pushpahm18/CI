import { describe, expect, it, vi } from "vitest";
import { assertReadOnlyStatement } from "@/server/db/read-only";
import { ForbiddenError, NotConfiguredError, ValidationError } from "@/server/ci/errors";
import { buildAnalysisStatements, buildAnalysisWhere, loadFfAnalysis, parseAnalysisQuery, type AnalysisDeps } from "@/server/ci/competitive-ff/analysis";
import { comparePeriods } from "@/lib/ci/ff-analysis";

// Fakes only: no database connection is opened.
const id = { email: "cm@example.com", name: "CM" };

describe("analysis SQL", () => {
  it("every statement is a single read-only SELECT over live rows only, with no row limit", () => {
    const s = buildAnalysisStatements("corp_marketing_dev.ci.ci_main", { year: ["2026"], customer: ["O'Neil"] }, "topCompetitor");
    for (const sql of Object.values(s)) {
      expect(() => assertReadOnlyStatement(sql)).not.toThrow();
      expect(sql).toContain("`is_active` = TRUE");
      expect(sql).not.toMatch(/LIMIT/);
    }
    expect(s.totals).toContain("CAST(`year` AS STRING) IN ('2026')");
    expect(s.totals).toContain("CAST(`customer` AS STRING) IN ('O''Neil')");
    expect(s.groups).toContain("GROUP BY CAST(`top_competitor` AS STRING), CAST(`currency` AS STRING)");
  });

  it("revenue is grouped by currency and numbers are read with TRY_CAST, never changed", () => {
    const s = buildAnalysisStatements("c.s.t", {}, "customer");
    expect(s.groups).toContain("SUM(TRY_CAST(`revenue_sales_currency` AS DOUBLE))");
    expect(s.groups).toContain("`currency`");
  });

  it("no selection means no filter on that field", () => {
    expect(buildAnalysisWhere({ year: [], quarter: undefined })).toBe("WHERE `is_active` = TRUE");
  });

  it("the filter choices come from all live rows, not the filtered ones", () => {
    expect(buildAnalysisStatements("c.s.t", { year: ["2026"] }, "customer").options).not.toContain("IN (");
  });
});

describe("parseAnalysisQuery", () => {
  it("reads repeated filter values and the group", () => {
    const { filters, group } = parseAnalysisQuery(new URL("http://x/api?group=year&customer=A&customer=B&bogus=1"));
    expect(group).toBe("year");
    expect(filters).toEqual({ customer: ["A", "B"] });
  });
  it("refuses an unknown group", () => {
    expect(() => parseAnalysisQuery(new URL("http://x/api?group=ci_id"))).toThrow(ValidationError);
  });
});

describe("comparePeriods", () => {
  it("orders by year then quarter, not alphabetically", () => {
    const list = [
      { year: "2026", quarter: "Q1" },
      { year: "2025", quarter: "Q4" },
      { year: "2025", quarter: "Q2" },
      { year: "2100", quarter: "Q1" },
      { year: "2026", quarter: "Q10" },
      { year: "2026", quarter: "Q2" },
    ].sort(comparePeriods);
    expect(list.map((p) => `${p.year} ${p.quarter}`)).toEqual(["2025 Q2", "2025 Q4", "2026 Q1", "2026 Q2", "2026 Q10", "2100 Q1"]);
  });
});

describe("loadFfAnalysis", () => {
  const make = (query: AnalysisDeps["query"], over: Partial<AnalysisDeps> = {}): AnalysisDeps => ({
    source: () => ({ catalog: "corp_marketing_dev", schema: "ci", table: "ci_main" }),
    requireConnected: vi.fn(),
    authorize: vi.fn(async () => ({})),
    query,
    ...over,
  });

  const fake = async (sql: string): Promise<Record<string, unknown>[]> => {
    if (sql.includes("COUNT(DISTINCT")) return [{ n: "3", customers: "2", competitors: "1", qty: "30.0" }];
    if (sql.includes("UNION ALL")) return [{ k: "year", v: "2026" }, { k: "year", v: "2025" }, { k: "customer", v: "B" }];
    if (sql.includes("AS d2")) {
      return [
        { d0: "2026", d1: "Q1", d2: "USD", n: "1", qty: "5", rev: "10" },
        { d0: "2025", d1: "Q4", d2: "KRW", n: "1", qty: "5", rev: "1000" },
        { d0: "2025", d1: "Q4", d2: "USD", n: "1", qty: "20", rev: "7" },
      ];
    }
    return [
      { d0: "A", d1: "USD", n: "2", qty: "25", rev: "17" },
      { d0: "A", d1: "KRW", n: "1", qty: "5", rev: "1000" },
      { d0: null, d1: "", n: "1", qty: null, rev: null },
    ];
  };

  it("keeps revenue per currency, blank groups blank, periods chronological, options sorted", async () => {
    const res = await loadFfAnalysis(id, {}, "customer", make(fake));
    expect(res.totals).toEqual({ rows: 3, customers: 2, competitors: 1, quantity: 30 });
    const a = res.groups.find((g) => g.key === "A")!;
    expect(a).toMatchObject({ rows: 3, quantity: 30 });
    expect(a.revenue).toEqual([{ currency: "KRW", amount: 1000 }, { currency: "USD", amount: 17 }]);
    expect(res.groups.some((g) => g.key === "")).toBe(true);
    expect(res.periods.map((p) => `${p.year} ${p.quarter}`)).toEqual(["2025 Q4", "2026 Q1"]);
    expect(res.periods[0].revenue).toHaveLength(2);
    expect(res.options.year).toEqual(["2025", "2026"]);
  });

  it("a refused caller gets the refusal; no source reads nothing", async () => {
    await expect(loadFfAnalysis(id, {}, "customer", make(fake, { authorize: async () => { throw new ForbiddenError("no"); } }))).rejects.toBeInstanceOf(ForbiddenError);
    const query = vi.fn(fake);
    await expect(loadFfAnalysis(id, {}, "customer", make(query, { source: () => null }))).rejects.toBeInstanceOf(NotConfiguredError);
    expect(query).not.toHaveBeenCalled();
  });
});

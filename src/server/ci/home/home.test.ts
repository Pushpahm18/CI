import { describe, expect, it, vi } from "vitest";
import { assertReadOnlyStatement } from "@/server/db/read-only";
import { CiError, ForbiddenError, NotConfiguredError } from "@/server/ci/errors";
import { buildHomeRecentStatement, buildHomeStatsStatement, rowToHomeRecent, rowToHomeStats } from "@/server/ci/home/data";
import { loadHome, type HomeDeps } from "@/server/ci/home/service";

// Fakes only: no database connection is opened.

const T = "corp_marketing_dev.ci.ci_main";
const id = { email: "p@example.com", name: "P" };
const scope = { customers: ["Micron"], segments: "All" as const, regions: ["KOR"] };
const cols = { customer: "customer", segment: "served_market", region: "fab_region" };
const recentRow = (o: Record<string, unknown> = {}) => ({ ci_id: "r1", application_id: "CI-0001", customer: "Micron", served_market: "DRAM", fab_region: "KOR", quarter: "Q1", year: "2026", updated_at: "2026-10-01T09:00:00Z", ...o });

describe("Home statements", () => {
  it("are read-only, live rows only, with the scope in the WHERE clause when there is one", () => {
    for (const sql of [buildHomeStatsStatement(T), buildHomeRecentStatement(T), buildHomeStatsStatement(T, { columns: cols, scope }), buildHomeRecentStatement(T, { columns: cols, scope })]) {
      expect(() => assertReadOnlyStatement(sql)).not.toThrow();
      expect(sql).toContain("`is_active` = TRUE");
    }
    const scoped = buildHomeStatsStatement(T, { columns: cols, scope });
    expect(scoped).toContain("`customer` IN ('Micron')");
    expect(scoped).toContain("`fab_region` IN ('KOR')");
    expect(scoped).not.toContain("served_market` IN"); // All adds no predicate
    expect(buildHomeStatsStatement(T)).not.toContain(" IN (");
  });

  it("the recent list is newest first (modified, else created) and limited", () => {
    const sql = buildHomeRecentStatement(T);
    expect(sql).toContain("COALESCE(`modified_date`, CAST(`created_date` AS TIMESTAMP))");
    expect(sql).toMatch(/DESC, `ci_id` LIMIT 6$/);
  });

  it("maps the rows", () => {
    expect(rowToHomeStats({ n: "500", customers: "20", competitors: "18" })).toEqual({ rows: 500, customers: 20, competitors: 18 });
    expect(rowToHomeStats(undefined)).toEqual({ rows: 0, customers: 0, competitors: 0 });
    expect(rowToHomeRecent(recentRow())).toMatchObject({ recordId: "r1", applicationId: "CI-0001", customer: "Micron", servedMarket: "DRAM", quarter: "Q1", year: "2026", updatedAt: "2026-10-01T09:00:00Z" });
  });
});

describe("loadHome", () => {
  const make = (over: Partial<HomeDeps> = {}) => {
    const query = vi.fn(async (sql: string) => (sql.includes("COUNT(*)") ? [{ n: "3", customers: "2", competitors: "2" }] : [recentRow()]));
    const deps: HomeDeps = {
      source: () => ({ catalog: "corp_marketing_dev", schema: "ci", table: "ci_main" }),
      requireConnected: vi.fn(),
      authorize: vi.fn(async () => ({ role: "Corporate Marketing" as const, scope: null })),
      scopeColumns: () => cols,
      query,
      ...over,
    };
    return { deps, query };
  };

  it("Corporate Marketing: unfiltered counts and the recent rows", async () => {
    const { deps, query } = make();
    const res = await loadHome(id, deps);
    expect(res).toEqual({ rows: 3, customers: 2, competitors: 2, recent: [{ recordId: "r1", applicationId: "CI-0001", customer: "Micron", servedMarket: "DRAM", quarter: "Q1", year: "2026", updatedAt: "2026-10-01T09:00:00Z" }] });
    expect(query.mock.calls.every(([sql]) => !sql.includes(" IN ("))).toBe(true);
  });

  it("Account Team: the scope is in both queries, and a returned row outside it is dropped", async () => {
    const query = vi.fn(async (sql: string) => (sql.includes("COUNT(*)") ? [{ n: "1", customers: "1", competitors: "1" }] : [recentRow(), recentRow({ ci_id: "r2", customer: "Intel" }), recentRow({ ci_id: "r3", fab_region: "CHN" })]));
    const { deps } = make({ authorize: async () => ({ role: "Account Team" as const, scope }), query });
    const res = await loadHome(id, deps);
    expect(query.mock.calls.every(([sql]) => sql.includes("`customer` IN ('Micron')"))).toBe(true);
    expect(res.recent.map((r) => r.recordId)).toEqual(["r1"]);
  });

  it("a refused caller gets the refusal and no query is sent", async () => {
    const { deps, query } = make({ authorize: async () => { throw new ForbiddenError("no"); } });
    await expect(loadHome(id, deps)).rejects.toBeInstanceOf(ForbiddenError);
    expect(query).not.toHaveBeenCalled();
  });

  it("says the table configuration is pending when there is no source", async () => {
    const { deps, query } = make({ source: () => null });
    await expect(loadHome(id, deps)).rejects.toBeInstanceOf(NotConfiguredError);
    expect(query).not.toHaveBeenCalled();
  });

  it("hides the database's own error text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = make({ query: async () => { throw new Error("PERMISSION_DENIED token dapiSECRET"); } });
    const err = (await loadHome(id, deps).catch((e) => e)) as CiError;
    expect(err).toBeInstanceOf(CiError);
    expect(err.message).not.toMatch(/PERMISSION|dapi/);
    spy.mockRestore();
  });
});

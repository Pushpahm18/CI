import { describe, expect, it, vi } from "vitest";
import { CiError, ConflictError } from "@/server/ci/errors";
import { previewLookupRemoval, removeLookupValue, type LookupsServiceDeps } from "@/server/ci/lookups/service";
import { dependentImpactOf, impactFingerprint } from "@/server/ci/lookups/deactivation-impact";
import { assertDependentWriteStatement, buildDependentSetActiveManyStatement, createDependentLookupStore, type DependentLookupRow } from "@/server/ci/databricks/dependent-lookups";
import { assertCiWriteStatement } from "@/server/db/write-guard";
import { assertLookupWriteStatement, createLookupStore } from "@/server/ci/databricks/lookups";
import type { LookupValue } from "@/types/ci";

// Fakes only: no database connection is opened.
const identity = { email: "cm@example.com", name: "CM" } as never;

const row = (id: string, p1t: string, p1: string, p2t: string, p2: string, ct: string, c: string, active = true): DependentLookupRow => ({
  id, parentType1: p1t, parentValue1: p1, parentType2: p2t, parentValue2: p2, childType: ct, childValue: c, sortOrder: 1, active,
});

const DEPENDENTS: DependentLookupRow[] = [
  row("f1", "Customer", "Micron", "Fab Location", "Boise", "Fab Region", "US"),
  row("f2", "Customer", "Micron", "Fab Location", "Taichung", "Fab Region", "Taiwan"),
  row("f3", "Customer", "Intel", "Fab Location", "Hillsboro", "Fab Region", "US"),
  row("f4", "Customer", "Micron", "Fab Location", "Old", "Fab Region", "US", false), // already inactive: not counted
  row("n1", "Customer", "Micron", "Served Market", "DRAM", "Technology Node", "1z"),
  row("n2", "Customer", "Intel", "Served Market", "DRAM", "Technology Node", "10nm"),
  row("n3", "Customer", "Intel", "Served Market", "Logic", "Technology Node", "7nm"),
  row("p1", "Served Market", "DRAM", "", "", "Process Location", "Boise Line"),
  row("c1", "Top Competitor", "TEL", "", "", "Product Name", "Tactras"),
];

const LOOKUPS: LookupValue[] = [
  { id: "cu1", category: "Customer", value: "Micron", sortOrder: 1, active: true },
  { id: "sm1", category: "Served Market", value: "DRAM", sortOrder: 1, active: true },
  { id: "tc1", category: "Top Competitor", value: "TEL", sortOrder: 1, active: true },
  { id: "fr1", category: "Fab Region", value: "US", sortOrder: 1, active: true },
  { id: "q1", category: "Quarter", value: "Q1", sortOrder: 1, active: true },
];

function make(over: Partial<LookupsServiceDeps> = {}) {
  const repo = {
    listLookups: vi.fn(async () => LOOKUPS),
    addLookup: vi.fn(), addLookups: vi.fn(), renameLookup: vi.fn(), reorderLookups: vi.fn(),
    deactivateLookup: vi.fn<(id: string, actor: string) => Promise<void>>(async () => {}),
  };
  // A store that remembers writes, like the real table: what is switched off is no longer listed as active.
  const state = DEPENDENTS.map((r) => ({ ...r }));
  const store = {
    list: vi.fn(async () => state.map((r) => ({ ...r }))),
    setActiveMany: vi.fn<(ids: string[], active: boolean, actor: string) => Promise<void>>(async (ids, active) => {
      for (const r of state) if (ids.includes(r.id)) r.active = active;
    }),
  };
  const deps: LookupsServiceDeps = {
    requireTables: vi.fn(), requireConnected: vi.fn(),
    authorize: vi.fn(async () => ({ userName: "CM", email: "cm@example.com" })),
    repository: () => repo as never,
    usage: async () => ({ counts: {}, categories: [] }),
    dependents: () => store,
    audit: vi.fn(async () => {}),
    ...over,
  };
  return { deps, repo, store, state };
}

const fp = (category: string, value: string, rows = DEPENDENTS) => dependentImpactOf(category, value, rows).summary.fingerprint;
const auditOf = (deps: LookupsServiceDeps) => vi.mocked(deps.audit).mock.calls.flatMap((c) => c[0]);
const calls = (store: { setActiveMany: { mock: { calls: [string[], boolean, string][] } } }) => store.setActiveMany.mock.calls.map((c) => `${[...c[0]].sort().join(",")}:${c[1]}`);
const sorted = (ids: string[]) => [...ids].sort().join(",");

describe("dependentImpactOf", () => {
  it("Customer: its Fab Locations (with Fab Region) and Technology Nodes; inactive rows are not counted", () => {
    const { rows, summary } = dependentImpactOf("Customer", "Micron", DEPENDENTS);
    expect(rows.map((r) => r.id).sort()).toEqual(["f1", "f2", "n1"]);
    expect(summary.groups.map((g) => g.count)).toEqual([2, 1]);
    expect(summary.groups[0].names).toContain("Micron · Boise (US)");
  });
  it("Served Market: Process Locations (parent 1) and Technology Nodes (parent 2)", () => {
    expect(dependentImpactOf("Served Market", "DRAM", DEPENDENTS).rows.map((r) => r.id).sort()).toEqual(["n1", "n2", "p1"]);
  });
  it("Top Competitor: Product Name mappings", () => {
    expect(dependentImpactOf("Top Competitor", "TEL", DEPENDENTS).rows.map((r) => r.id)).toEqual(["c1"]);
  });
  it("Fab Region: the Fab Locations that use it", () => {
    expect(dependentImpactOf("Fab Region", "US", DEPENDENTS).rows.map((r) => r.id).sort()).toEqual(["f1", "f3"]);
  });
  it("matches case-insensitively and ignores other lists", () => {
    expect(dependentImpactOf("Customer", "micron", DEPENDENTS).summary.total).toBe(3);
    expect(dependentImpactOf("Quarter", "Q1", DEPENDENTS).summary.total).toBe(0);
  });
  it("the fingerprint depends only on which rows are affected, not their order", () => {
    expect(impactFingerprint(["b", "a"])).toBe(impactFingerprint(["a", "b"]));
    expect(impactFingerprint(["a"])).not.toBe(impactFingerprint(["a", "b"]));
  });
});

describe("previewLookupRemoval", () => {
  it("returns the impact and its fingerprint without changing anything", async () => {
    const { deps, repo, store } = make();
    const impact = await previewLookupRemoval(identity, "cu1", deps);
    expect(impact.total).toBe(3);
    expect(impact.fingerprint).toBe(fp("Customer", "Micron"));
    expect(store.setActiveMany).not.toHaveBeenCalled();
    expect(repo.deactivateLookup).not.toHaveBeenCalled();
  });
  it("is empty for a list that has no dependents", async () => {
    expect((await previewLookupRemoval(identity, "q1", make().deps)).total).toBe(0);
  });
});

const CASES: [string, string, string, string[]][] = [
  ["Customer", "cu1", "Micron", ["f1", "f2", "n1"]],
  ["Served Market", "sm1", "DRAM", ["n1", "n2", "p1"]],
  ["Top Competitor", "tc1", "TEL", ["c1"]],
  ["Fab Region", "fr1", "US", ["f1", "f3"]],
];

/** A new mapping for the value, as another person could add it while the dialog is open. */
const extraMapping = (category: string, value: string, id = "x1") =>
  category === "Fab Region" ? row(id, "Customer", "Intel", "Fab Location", "New", "Fab Region", value)
  : category === "Top Competitor" ? row(id, "Top Competitor", value, "", "", "Product Name", "New")
  : category === "Served Market" ? row(id, "Served Market", value, "", "", "Process Location", "New")
  : row(id, "Customer", value, "Fab Location", "New", "Fab Region", "US");

describe("removeLookupValue with dependents", () => {
  for (const [category, id, value, expected] of CASES) {
    describe(category, () => {
      it("cancel: without a confirmation nothing is written (409)", async () => {
        const { deps, repo, store } = make();
        await expect(removeLookupValue(identity, id, deps)).rejects.toBeInstanceOf(ConflictError);
        expect(store.setActiveMany).not.toHaveBeenCalled();
        expect(repo.deactivateLookup).not.toHaveBeenCalled();
        expect(deps.audit).not.toHaveBeenCalled();
      });
      it("confirmed: dependents off in ONE statement, then the value, and every row audited", async () => {
        const { deps, repo, store } = make();
        await removeLookupValue(identity, id, deps, { confirmedImpact: fp(category, value) });
        expect(calls(store)[0]).toBe(`${sorted(expected)}:false`);
        expect(store.setActiveMany.mock.calls.filter((c) => c[1] === false)).toHaveLength(1);
        expect(repo.deactivateLookup).toHaveBeenCalledWith(id, "CM");
        expect(auditOf(deps).map((e) => e.recordId).sort()).toEqual([id, ...expected].sort());
      });
      it("concurrent change: a mapping added after the review -> refused, nothing changed", async () => {
        const { deps, repo, store } = make();
        const reviewed = fp(category, value);
        store.list.mockResolvedValue([...DEPENDENTS, extraMapping(category, value)]);
        await expect(removeLookupValue(identity, id, deps, { confirmedImpact: reviewed })).rejects.toBeInstanceOf(ConflictError);
        expect(store.setActiveMany).not.toHaveBeenCalled();
        expect(repo.deactivateLookup).not.toHaveBeenCalled();
      });
      it("concurrent change: a mapping removed after the review -> refused, nothing changed", async () => {
        const { deps, store } = make();
        store.list.mockResolvedValue(DEPENDENTS.filter((r) => r.id !== expected[0]));
        await expect(removeLookupValue(identity, id, deps, { confirmedImpact: fp(category, value) })).rejects.toBeInstanceOf(ConflictError);
        expect(store.setActiveMany).not.toHaveBeenCalled();
      });
      it("partial failure: dependents could not be switched off -> value untouched, no audit", async () => {
        const { deps, repo, store } = make();
        store.setActiveMany.mockRejectedValueOnce(new Error("warehouse down"));
        await expect(removeLookupValue(identity, id, deps, { confirmedImpact: fp(category, value) })).rejects.toBeInstanceOf(CiError);
        expect(repo.deactivateLookup).not.toHaveBeenCalled();
        expect(deps.audit).not.toHaveBeenCalled();
      });
      it("partial failure: the value could not be deactivated -> dependents are switched back on", async () => {
        const { deps, repo, store } = make();
        repo.deactivateLookup.mockRejectedValueOnce(new Error("warehouse down"));
        await expect(removeLookupValue(identity, id, deps, { confirmedImpact: fp(category, value) })).rejects.toBeInstanceOf(CiError);
        expect(calls(store)).toEqual([`${sorted(expected)}:false`, `${sorted(expected)}:true`]);
        expect(deps.audit).not.toHaveBeenCalled();
      });
      it("rollback failure: reported plainly, ids logged, state audited, and a retry completes the deactivation", async () => {
        const { deps, repo, store } = make();
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        repo.deactivateLookup.mockRejectedValueOnce(new Error("warehouse down"));
        store.setActiveMany.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("still down"));
        const err = await removeLookupValue(identity, id, deps, { confirmedImpact: fp(category, value) }).catch((e) => e);
        expect(err).toBeInstanceOf(CiError);
        expect(err.message).toMatch(/could not be switched back on/);
        expect(err.message).toMatch(/Retry/);
        expect(log.mock.calls.flat().join(" ")).toContain(expected[0]);
        expect(auditOf(deps).map((e) => e.recordId).sort()).toEqual([...expected].sort());
        // The mappings are now inactive; the retry sees nothing left to switch off and finishes the value.
        const afterFailure = DEPENDENTS.map((r) => (expected.includes(r.id) ? { ...r, active: false } : r));
        store.list.mockResolvedValue(afterFailure);
        vi.mocked(deps.audit).mockClear();
        await removeLookupValue(identity, id, deps, { confirmedImpact: fp(category, value, afterFailure) });
        expect(repo.deactivateLookup).toHaveBeenLastCalledWith(id, "CM");
        log.mockRestore();
      });
    });
  }

  it("a mapping added while the value was being deactivated is switched off too, and audited", async () => {
    const { deps, store, state } = make();
    const late = extraMapping("Top Competitor", "TEL", "late1");
    const first = store.list.getMockImplementation()!;
    store.list.mockImplementationOnce(first).mockImplementationOnce(async () => [...state.map((r) => ({ ...r })), late]);
    await removeLookupValue(identity, "tc1", deps, { confirmedImpact: fp("Top Competitor", "TEL") });
    expect(calls(store)).toEqual(["c1:false", "late1:false"]);
    expect(auditOf(deps).map((e) => e.recordId)).toEqual(["tc1", "c1", "late1"]);
  });
  it("if the final check fails the person is told, and what was done is still audited", async () => {
    const { deps, store } = make();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    store.list.mockResolvedValueOnce(DEPENDENTS).mockRejectedValueOnce(new Error("read failed"));
    await expect(removeLookupValue(identity, "tc1", deps, { confirmedImpact: fp("Top Competitor", "TEL") })).rejects.toThrow(/final check/);
    expect(auditOf(deps).map((e) => e.recordId)).toEqual(["tc1", "c1"]);
    log.mockRestore();
  });
  it("fails closed when the dependent lists are unavailable", async () => {
    const { deps, repo } = make({ dependents: () => null });
    await expect(removeLookupValue(identity, "cu1", deps, { confirmedImpact: "x" })).rejects.toBeInstanceOf(CiError);
    expect(repo.deactivateLookup).not.toHaveBeenCalled();
  });
  it("other lists deactivate without confirmation and without touching dependents", async () => {
    const { deps, repo, store } = make();
    await removeLookupValue(identity, "q1", deps);
    expect(repo.deactivateLookup).toHaveBeenCalledWith("q1", "CM");
    expect(store.list).not.toHaveBeenCalled();
    expect(store.setActiveMany).not.toHaveBeenCalled();
  });
});

describe("history is preserved (soft deactivation only)", () => {
  const table = "corp_marketing_dev.ci.ci_lookup_dependent";
  it("the cascade statement is a single UPDATE of is_active; never a DELETE, never ci_main", () => {
    const off = buildDependentSetActiveManyStatement(table, { ids: ["a", "b"], active: false, actor: "CM", now: "2026-01-01T00:00:00.000Z" });
    expect(off).toMatch(/^UPDATE .*SET `is_active` = FALSE/);
    expect(off).not.toMatch(/DELETE|ci_main/i);
    expect(() => assertDependentWriteStatement(table, off)).not.toThrow();
    expect(() => assertCiWriteStatement(off)).not.toThrow();
    expect(buildDependentSetActiveManyStatement(table, { ids: ["a"], active: true, actor: "CM", now: "2026-01-01T00:00:00.000Z" })).toMatch(/`is_active` = TRUE/);
  });
  it("multi-statement / transaction text is refused by the write guards, so no BEGIN ... COMMIT can be sent", () => {
    expect(() => assertDependentWriteStatement(table, "UPDATE `corp_marketing_dev`.`ci`.`ci_lookup_dependent` SET x = 1; UPDATE other SET y = 2")).toThrow();
    expect(() => assertCiWriteStatement("BEGIN TRANSACTION")).toThrow();
  });
});

describe("Delete in both lookup screens = soft deactivation in Databricks (end to end through the real stores)", () => {
  it("a dropdown value Delete sends one UPDATE ... is_active = FALSE, never a DELETE", async () => {
    const sent: string[] = [];
    const store = createLookupStore("corp_marketing_dev.ci.ci_lookup", null, { query: async () => [], execute: async (s) => void sent.push(s), now: () => "2026-01-01T00:00:00.000Z", newId: () => "n" });
    await store.deactivateLookup("lk1", "CM");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^UPDATE `corp_marketing_dev`\.`ci`\.`ci_lookup` SET `is_active` = FALSE/);
    expect(sent[0]).toContain("WHERE `lookup_id` = 'lk1'");
    expect(sent[0]).not.toMatch(/DELETE/i);
  });
  it("a dependent value Delete sends one UPDATE ... is_active = FALSE, never a DELETE", async () => {
    const sent: string[] = [];
    const store = createDependentLookupStore("corp_marketing_dev.ci.ci_lookup_dependent", { execute: async (s) => void sent.push(s), now: () => "2026-01-01T00:00:00.000Z" });
    await store.deactivate("dp1", "CM");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^UPDATE `corp_marketing_dev`\.`ci`\.`ci_lookup_dependent` SET `is_active` = FALSE/);
    expect(sent[0]).not.toMatch(/DELETE/i);
  });
  it("both stores refuse a DELETE outright", () => {
    expect(() => assertDependentWriteStatement("corp_marketing_dev.ci.ci_lookup_dependent", "DELETE FROM `corp_marketing_dev`.`ci`.`ci_lookup_dependent` WHERE 1 = 1")).toThrow();
    expect(() => assertLookupWriteStatement("corp_marketing_dev.ci.ci_lookup", "DELETE FROM `corp_marketing_dev`.`ci`.`ci_lookup` WHERE 1 = 1")).toThrow();
  });
});

import { describe, expect, it, vi } from "vitest";
import { ForbiddenError, NotConfiguredError } from "@/server/ci/errors";
import { dependentListsFrom, type DependentLookupRow } from "@/server/ci/databricks/dependent-lookups";
import { loadDependentLists, type DependentListsDeps } from "@/server/ci/dependent-lists/service";

// Fakes only: no database connection is opened.

const row = (o: Partial<DependentLookupRow>): DependentLookupRow => ({
  id: "r", parentType1: "", parentValue1: "", parentType2: "", parentValue2: "", childType: "", childValue: "", sortOrder: 0, active: true, ...o,
});

const fab = (c: string, f: string, r: string, order = 0) =>
  row({ id: `${c}-${f}`, parentType1: "Customer", parentValue1: c, parentType2: "Fab Location", parentValue2: f, childType: "Fab Region", childValue: r, sortOrder: order });
const product = (c: string, p: string, order = 0, active = true) =>
  row({ id: `${c}-${p}`, parentType1: "Top Competitor", parentValue1: c, childType: "Product Name", childValue: p, sortOrder: order, active });
const loc = (m: string, l: string, order = 0) => row({ id: `${m}-${l}`, parentType1: "Served Market", parentValue1: m, childType: "Process Location", childValue: l, sortOrder: order });
const node = (c: string, m: string, n: string, order = 0) =>
  row({ id: `${c}-${m}-${n}`, parentType1: "Customer", parentValue1: c, parentType2: "Served Market", parentValue2: m, childType: "Technology Node", childValue: n, sortOrder: order });

describe("dependentListsFrom", () => {
  it("builds all four lists in stored display order", () => {
    const out = dependentListsFrom([
      product("TEL", "B", 2), product("TEL", "A", 1), loc("DRAM", "STI"), node("Micron", "NAND", "130s"), fab("Micron", "Micron Lehi", "North America"),
    ]);
    expect(out.competitorProducts).toEqual([{ competitor: "TEL", product: "A" }, { competitor: "TEL", product: "B" }]);
    expect(out.processLocations).toEqual([{ servedMarket: "DRAM", processLocation: "STI" }]);
    expect(out.technologyNodes).toEqual([{ customer: "Micron", servedMarket: "NAND", technologyNode: "130s" }]);
    expect(out.customerFabs).toEqual([{ customer: "Micron", fabLocation: "Micron Lehi", fabRegion: "North America" }]);
    expect(out.issues).toEqual([]);
  });

  it("an empty table gives empty lists, never sample data", () => {
    expect(dependentListsFrom([])).toEqual({ customerFabs: [], competitorProducts: [], processLocations: [], technologyNodes: [], entries: [], issues: [] });
  });

  it("ignores inactive rows and rows with other type strings; reports incomplete and repeated rows", () => {
    const out = dependentListsFrom([
      product("TEL", "Old", 0, false),
      row({ id: "x", parentType1: "Vendor", parentValue1: "TEL", childType: "Product Name", childValue: "Z" }),
      product("TEL", ""),
      product("AMAT", "Producer"),
      product("AMAT", "producer"),
      node("Micron", "", "130s"),
    ]);
    expect(out.competitorProducts).toEqual([{ competitor: "AMAT", product: "Producer" }]);
    expect(out.technologyNodes).toEqual([]);
    expect(out.issues).toHaveLength(3);
  });
});

describe("loadDependentLists", () => {
  const deps = (over: Partial<DependentListsDeps> = {}): DependentListsDeps => ({
    requireTables: vi.fn(), requireConnected: vi.fn(), authorize: vi.fn(async () => ({})), rows: async () => [loc("DRAM", "STI")], ...over,
  });

  it("returns the lists for an authorized caller", async () => {
    const out = await loadDependentLists({ email: "a@b.c", name: "A" }, deps());
    expect(out.processLocations).toHaveLength(1);
  });

  it("a pending table reads nothing; an unauthorized caller gets the refusal and no data", async () => {
    const rows = vi.fn(async () => [loc("DRAM", "STI")]);
    await expect(loadDependentLists({ email: "a@b.c", name: "A" }, deps({ requireTables: () => { throw new NotConfiguredError(["x"]); }, rows }))).rejects.toBeInstanceOf(NotConfiguredError);
    expect(rows).not.toHaveBeenCalled();
    await expect(loadDependentLists({ email: "a@b.c", name: "A" }, deps({ authorize: async () => { throw new ForbiddenError("no"); }, rows }))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

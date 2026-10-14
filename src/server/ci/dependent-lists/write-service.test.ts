import { describe, expect, it, vi } from "vitest";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/ci/errors";
import {
  assertDependentWriteStatement,
  buildDependentDeactivateStatement,
  buildDependentInsertStatement,
  buildDependentReorderStatement,
  buildDependentSetStatement,
  createDependentLookupStore,
  type DependentLookupRow,
  type DependentLookupStore,
} from "@/server/ci/databricks/dependent-lookups";
import { addDependentEntries, addDependentEntry, removeDependentEntry, renameDependentEntry, reorderDependentEntries, type DependentWriteServiceDeps } from "@/server/ci/dependent-lists/write-service";

// Fakes only: no database connection is opened and nothing is written.

const T = "corp_marketing_dev.ci.ci_lookup_dependent";
const who = { email: "cm@example.com", name: "CM" };
const row = (o: Partial<DependentLookupRow>): DependentLookupRow => ({
  id: "r", parentType1: "", parentValue1: "", parentType2: "", parentValue2: "", childType: "", childValue: "", sortOrder: 0, active: true, ...o,
});
const product = (id: string, comp: string, p: string, order: number) => row({ id, parentType1: "Top Competitor", parentValue1: comp, childType: "Product Name", childValue: p, sortOrder: order });
const fab = (id: string, c: string, f: string, r: string, order = 1) =>
  row({ id, parentType1: "Customer", parentValue1: c, parentType2: "Fab Location", parentValue2: f, childType: "Fab Region", childValue: r, sortOrder: order });

function wire(rows: DependentLookupRow[], lookups: { category: string; value: string }[] = [{ category: "Customer", value: "Micron" }, { category: "Customer", value: "CI_TEST_CUST" }, { category: "Top Competitor", value: "TEL" }, { category: "Served Market", value: "DRAM" }, { category: "Fab Region", value: "Japan" }]) {
  const store = {
    list: vi.fn(async () => rows),
    insert: vi.fn(async () => "new-id"),
    insertMany: vi.fn(async (inputs: unknown[]) => inputs.map((_, i) => `bulk-${i}`)),
    setValue: vi.fn(async () => {}),
    deactivate: vi.fn(async () => {}),
    reorder: vi.fn(async () => {}),
  } satisfies DependentLookupStore;
  const deps: DependentWriteServiceDeps = {
    requireTables: vi.fn(), requireConnected: vi.fn(), authorize: vi.fn(async () => ({ userName: "CM" })), store: () => store,
    lookups: async () => lookups.map((l, i) => ({ id: String(i), category: l.category, value: l.value, sortOrder: i, active: true })),
    audit: vi.fn(async () => {}),
  };
  return { store, deps };
}

describe("statements", () => {
  const input = { id: "i1", actor: "CM", now: "2026-10-12T09:00:00.000Z" };
  it("a fab is stored as Customer + Fab Location -> Fab Region; the others use their own parents", () => {
    const fabSql = buildDependentInsertStatement(T, { ...input, list: "fab", parent1: "Micron", parent2: "", value: "Micron Lehi", region: "North America", sortOrder: 1 });
    for (const part of ["'Customer' AS `parent_type_1`", "'Micron' AS `parent_value_1`", "'Fab Location' AS `parent_type_2`", "'Micron Lehi' AS `parent_value_2`", "'Fab Region' AS `child_type`", "'North America' AS `child_value`"]) expect(fabSql).toContain(part);
    const nodeSql = buildDependentInsertStatement(T, { ...input, list: "node", parent1: "Micron", parent2: "NAND", value: "130s", sortOrder: 1 });
    expect(nodeSql).toContain("'Technology Node' AS `child_type`");
    expect(nodeSql).toContain("'NAND' AS `parent_value_2`");
  });
  it("only a single MERGE / UPDATE of the dependent table is allowed; never a DELETE", () => {
    for (const sql of [
      buildDependentInsertStatement(T, { ...input, list: "comp", parent1: "TEL", parent2: "", value: "x", sortOrder: 1 }),
      buildDependentSetStatement(T, { id: "i1", column: "childValue", value: "y", actor: "CM", now: input.now }),
      buildDependentDeactivateStatement(T, input),
      buildDependentReorderStatement(T, { orderedIds: ["a", "b"], actor: "CM", now: input.now }),
    ]) expect(() => assertDependentWriteStatement(T, sql)).not.toThrow();
    for (const bad of [`DELETE FROM ${T}`, `UPDATE other.t SET a = 1`, `UPDATE ${T} SET a = 1; DROP TABLE x`, `DROP TABLE ${T}`]) {
      expect(() => assertDependentWriteStatement(T, bad)).toThrow(/Refused/);
    }
  });
  it("a value containing a quote or a semicolon cannot escape its literal", () => {
    const sql = buildDependentSetStatement(T, { id: "i1", column: "childValue", value: "x'; DROP TABLE t; --", actor: "CM", now: input.now });
    expect(() => assertDependentWriteStatement(T, sql)).not.toThrow();
  });
  it("the store sends writes through the guard and the injected executor only", async () => {
    const execute = vi.fn(async () => {});
    const store = createDependentLookupStore(T, { query: async () => [], execute, now: () => "2026-10-12T09:00:00.000Z", newId: () => "id1" });
    await store.insert({ list: "comp", parent1: "TEL", parent2: "", value: "A", sortOrder: 1, actor: "CM" });
    await store.deactivate("id1", "CM");
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe("dependent lookup audit history (after the change; by the verified signed-in person)", () => {
  const entries = (deps: DependentWriteServiceDeps) => vi.mocked(deps.audit).mock.calls.flatMap((c) => c[0]);
  const withEmail = (deps: DependentWriteServiceDeps) => { deps.authorize = vi.fn(async () => ({ userName: "CM", email: "cm@example.com" })); return deps; };

  it("Add records the list, parent, value and position", async () => {
    const { deps } = wire([product("p1", "TEL", "A", 1)]);
    await addDependentEntry(who, { list: "comp", parent1: "TEL", value: "B" }, withEmail(deps));
    expect(entries(deps)[0]).toMatchObject({ entity: "Dependent Lookup", recordId: "new-id", action: "Created", actionByName: "CM", actionByEmail: "cm@example.com", note: "List: Product Name; TEL" });
    expect(entries(deps)[0].changes.map((c) => [c.label, c.previous, c.current])).toEqual([
      ["List", "", "Product Name"], ["Top Competitor", "", "TEL"], ["Product Name", "", "B"], ["Sort Order", "", "2"],
    ]);
  });

  it("Add of a fab also records its Fab Region", async () => {
    const { deps } = wire([fab("f1", "Micron", "Micron Boise", "North America")]);
    await addDependentEntry(who, { list: "fab", parent1: "Micron", value: "Micron Lehi", region: "Japan" }, deps);
    expect(entries(deps)[0].changes.map((c) => c.label)).toEqual(["List", "Customer", "Fab Location", "Fab Region", "Sort Order"]);
  });

  it("Bulk add records one entry per row that was saved", async () => {
    const { deps } = wire([product("p1", "TEL", "A", 1)]);
    await addDependentEntries(who, { items: [{ list: "comp", parent1: "TEL", value: "B" }, { list: "comp", parent1: "TEL", value: "A" }, { list: "comp", parent1: "TEL", value: "C" }] }, deps);
    expect(entries(deps).map((e) => [e.recordId, e.changes.find((c) => c.label === "Product Name")?.current])).toEqual([["bulk-0", "B"], ["bulk-1", "C"]]);
  });

  it("Rename records the old and new value", async () => {
    const { deps } = wire([product("p1", "TEL", "A", 1)]);
    await renameDependentEntry(who, "p1", { value: "A2" }, deps);
    expect(entries(deps)[0]).toMatchObject({ recordId: "p1", action: "Edited" });
    expect(entries(deps)[0].changes.map((c) => [c.label, c.previous, c.current])).toEqual([["Product Name", "A", "A2"]]);
  });

  it("Remove records Deactivated; Reorder records only the values that moved", async () => {
    const a = wire([product("p1", "TEL", "A", 1), product("p2", "TEL", "B", 2)]);
    await removeDependentEntry(who, "p1", a.deps);
    expect(entries(a.deps)[0]).toMatchObject({ recordId: "p1", action: "Deactivated" });
    const b = wire([product("p1", "TEL", "A", 1), product("p2", "TEL", "B", 2), product("p3", "TEL", "C", 3)]);
    await reorderDependentEntries(who, { list: "comp", parent1: "TEL", orderedIds: ["p1", "p3", "p2"] }, b.deps);
    expect(entries(b.deps).map((e) => [e.recordId, e.changes[0].previous, e.changes[0].current])).toEqual([["p3", "3", "2"], ["p2", "2", "3"]]);
  });

  it("says plainly that the change was saved when its audit entry could not be written", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { store, deps } = wire([product("p1", "TEL", "A", 1)]);
    deps.audit = vi.fn(async () => { throw new Error("down dapiSECRET"); });
    await expect(addDependentEntry(who, { list: "comp", parent1: "TEL", value: "B" }, deps)).rejects.toThrow(/saved, but its audit history entry could not be written/);
    expect(store.insert).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("writes no audit entry for a refused request", async () => {
    const { deps } = wire([product("p1", "TEL", "A", 1)]);
    await expect(addDependentEntry(who, { list: "comp", parent1: "TEL", value: "a" }, deps)).rejects.toBeInstanceOf(ValidationError);
    expect(deps.audit).not.toHaveBeenCalled();
  });
});

describe("addDependentEntry", () => {
  it("adds a product under a Top Competitor that is in the dropdown list, next in order", async () => {
    const { store, deps } = wire([product("p1", "TEL", "A", 1), product("p2", "TEL", "B", 2)]);
    await addDependentEntry(who, { list: "comp", parent1: "TEL", value: "C" }, deps);
    expect(store.insert).toHaveBeenCalledWith({ list: "comp", parent1: "TEL", parent2: "", value: "C", region: undefined, sortOrder: 3, actor: "CM" });
  });
  it("refuses a parent that is not in its dropdown list, a duplicate (any case) and an unknown Fab Region", async () => {
    const { store, deps } = wire([product("p1", "TEL", "A", 1), fab("f1", "Micron", "Lehi", "Japan")]);
    await expect(addDependentEntry(who, { list: "comp", parent1: "Nobody", value: "C" }, deps)).rejects.toBeInstanceOf(ValidationError);
    await expect(addDependentEntry(who, { list: "comp", parent1: "TEL", value: "a" }, deps)).rejects.toMatchObject({ details: [expect.stringMatching(/already exists/)] });
    await expect(addDependentEntry(who, { list: "fab", parent1: "Micron", value: "Boise", region: "Mars" }, deps)).rejects.toMatchObject({ details: [expect.stringMatching(/not a known Fab Region/)] });
    await expect(addDependentEntry(who, { list: "fab", parent1: "Micron", value: "Boise" }, deps)).rejects.toBeInstanceOf(ValidationError);
    await expect(addDependentEntry(who, { list: "fab", parent1: "Nobody Inc", value: "Boise", region: "Japan" }, deps)).rejects.toMatchObject({ details: [expect.stringMatching(/not in the Customer list/)] });
    expect(store.insert).not.toHaveBeenCalled();
  });
  it("a node needs a Served Market from the dropdown list", async () => {
    const { store, deps } = wire([]);
    await expect(addDependentEntry(who, { list: "node", parent1: "Micron", parent2: "Nope", value: "130s" }, deps)).rejects.toBeInstanceOf(ValidationError);
    await addDependentEntry(who, { list: "node", parent1: "Micron", parent2: "DRAM", value: "130s" }, deps);
    expect(store.insert).toHaveBeenCalledTimes(1);
  });
  it("a caller who is not authorized is refused and nothing is written (the reads started alongside are discarded)", async () => {
    const { store, deps } = wire([]);
    deps.authorize = async () => { throw new ForbiddenError("no"); };
    await expect(addDependentEntry(who, { list: "comp", parent1: "TEL", value: "A" }, deps)).rejects.toBeInstanceOf(ForbiddenError);
    expect(store.insert).not.toHaveBeenCalled();
    expect(store.insertMany).not.toHaveBeenCalled();
  });
  it("authorization wins even when a read fails at the same time", async () => {
    const { store, deps } = wire([]);
    deps.authorize = async () => { throw new ForbiddenError("no"); };
    store.list.mockRejectedValue(new Error("PERMISSION_DENIED dapiSECRET"));
    await expect(addDependentEntry(who, { list: "comp", parent1: "TEL", value: "A" }, deps)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("addDependentEntries (bulk, one write)", () => {
  it("saves the valid rows in ONE statement and reports the refused ones, including repeats inside the batch", async () => {
    const { store, deps } = wire([product("p1", "TEL", "A", 1)]);
    const res = await addDependentEntries(who, { items: [
      { list: "comp", parent1: "TEL", value: "B" },
      { list: "comp", parent1: "TEL", value: "b" },
      { list: "comp", parent1: "TEL", value: "A" },
      { list: "comp", parent1: "Nobody", value: "C" },
      { list: "comp", parent1: "TEL", value: "C" },
    ] }, deps);
    expect(store.insertMany).toHaveBeenCalledTimes(1);
    const sent = store.insertMany.mock.calls[0][0] as { value: string; sortOrder: number }[];
    expect(sent.map((r) => [r.value, r.sortOrder])).toEqual([["B", 2], ["C", 3]]);
    expect(res.results.map((r) => r.ok)).toEqual([true, false, false, false, true]);
  });
  it("is refused for an unauthorized caller and rejects an empty or oversized batch", async () => {
    const { store, deps } = wire([]);
    await expect(addDependentEntries(who, { items: [] }, deps)).rejects.toBeInstanceOf(ValidationError);
    await expect(addDependentEntries(who, { items: Array.from({ length: 501 }, () => ({})) }, deps)).rejects.toBeInstanceOf(ValidationError);
    deps.authorize = async () => { throw new ForbiddenError("no"); };
    await expect(addDependentEntries(who, { items: [{ list: "comp", parent1: "TEL", value: "A" }] }, deps)).rejects.toBeInstanceOf(ForbiddenError);
    expect(store.insertMany).not.toHaveBeenCalled();
  });
});

describe("rename, remove, reorder", () => {
  it("renames a product via child_value and a fab via parent_value_2; a fab's region via child_value", async () => {
    const { store, deps } = wire([product("p1", "TEL", "A", 1), fab("f1", "Micron", "Lehi", "Japan")]);
    await renameDependentEntry(who, "p1", { value: "A2" }, deps);
    expect(store.setValue).toHaveBeenLastCalledWith("p1", "childValue", "A2", "CM");
    await renameDependentEntry(who, "f1", { value: "Lehi 2", region: "Japan" }, deps);
    expect(store.setValue).toHaveBeenLastCalledWith("f1", "parentValue2", "Lehi 2", "CM");
    await renameDependentEntry(who, "f1", { region: "Japan" }, deps);
    expect(store.setValue).toHaveBeenCalledTimes(2);
  });
  it("refuses renaming onto an existing value and unknown ids", async () => {
    const { deps } = wire([product("p1", "TEL", "A", 1), product("p2", "TEL", "B", 2)]);
    await expect(renameDependentEntry(who, "p1", { value: "b" }, deps)).rejects.toMatchObject({ details: [expect.stringMatching(/already exists/)] });
    await expect(renameDependentEntry(who, "zz", { value: "x" }, deps)).rejects.toBeInstanceOf(NotFoundError);
    await expect(renameDependentEntry(who, "bad id!", { value: "x" }, deps)).rejects.toBeInstanceOf(ValidationError);
  });
  it("remove only deactivates", async () => {
    const { store, deps } = wire([product("p1", "TEL", "A", 1)]);
    await removeDependentEntry(who, "p1", deps);
    expect(store.deactivate).toHaveBeenCalledWith("p1", "CM");
    await expect(removeDependentEntry(who, "nope", deps)).rejects.toBeInstanceOf(NotFoundError);
  });
  it("reorder must list exactly the ids of that parent group", async () => {
    const { store, deps } = wire([product("p1", "TEL", "A", 1), product("p2", "TEL", "B", 2), product("p3", "AMAT", "C", 1)]);
    await reorderDependentEntries(who, { list: "comp", parent1: "TEL", parent2: "", orderedIds: ["p2", "p1"] }, deps);
    expect(store.reorder).toHaveBeenCalledWith(["p2", "p1"], "CM");
    await expect(reorderDependentEntries(who, { list: "comp", parent1: "TEL", parent2: "", orderedIds: ["p2"] }, deps)).rejects.toBeInstanceOf(ValidationError);
    await expect(reorderDependentEntries(who, { list: "comp", parent1: "TEL", parent2: "", orderedIds: ["p1", "p3"] }, deps)).rejects.toBeInstanceOf(ValidationError);
  });
});

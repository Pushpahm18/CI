import { describe, expect, it, vi } from "vitest";
import { CiError, ForbiddenError, NotFoundError, ValidationError } from "@/server/ci/errors";
import { addLookupValue, addLookupValues, loadLookups, removeLookupValue, reorderLookupValues, type LookupsServiceDeps } from "@/server/ci/lookups/service";
import type { LookupValue } from "@/types/ci";

// Fakes only: no database connection is opened.

const identity = { email: "cm@example.com", name: "Corporate Person" } as never;

const seed = (): LookupValue[] => [
  { id: "q1", category: "Quarter", value: "Q1", sortOrder: 1, active: true },
  { id: "q2", category: "Quarter", value: "Q2", sortOrder: 2, active: true },
  { id: "q3", category: "Quarter", value: "Q3", sortOrder: 3, active: false },
  { id: "c1", category: "Currency", value: "USD", sortOrder: 1, active: true },
];

function make(over: Partial<LookupsServiceDeps> = {}) {
  const data = seed();
  const repo = {
    listLookups: vi.fn(async () => data),
    addLookup: vi.fn(async (category: string, value: string, sortOrder: number) => ({ id: "n1", category, value, sortOrder, active: true })),
    addLookups: vi.fn(async (items: { category: string; value: string; sortOrder: number }[]) => items.map((i, n) => ({ id: `b${n}`, ...i, active: true }))),
    renameLookup: vi.fn(async () => {}),
    deactivateLookup: vi.fn(async () => {}),
    reorderLookups: vi.fn(async () => {}),
  };
  const deps: LookupsServiceDeps = {
    requireTables: vi.fn(),
    requireConnected: vi.fn(),
    authorize: vi.fn(async () => ({ userName: "Corporate Person" })),
    repository: () => repo,
    usage: async () => ({ counts: { "Quarter|Q1": 2 }, categories: ["Quarter"] }),
    audit: vi.fn(async () => {}),
    ...over,
  };
  return { deps, repo };
}

describe("lookups audit history (after the change; by the verified signed-in person)", () => {
  const who = { userName: "Corporate Person", email: "cm@example.com" };
  const calls = (deps: LookupsServiceDeps) => vi.mocked(deps.audit).mock.calls.flatMap((c) => c[0]);

  it("Add records a Created entry with the list, value and position", async () => {
    const { deps } = make({ authorize: vi.fn(async () => who) });
    await addLookupValue(identity, { category: "Quarter", value: "Q5" }, deps);
    expect(calls(deps)).toHaveLength(1);
    expect(calls(deps)[0]).toMatchObject({ entity: "Lookup", recordId: "n1", action: "Created", note: "List: Quarter", actionByName: "Corporate Person", actionByEmail: "cm@example.com" });
    expect(calls(deps)[0].changes.map((c) => [c.label, c.previous, c.current])).toEqual([["List", "", "Quarter"], ["Value", "", "Q5"], ["Sort Order", "", "3"]]);
  });

  it("Bulk add records one Created entry per value that was saved, none for refused rows", async () => {
    const { deps } = make({ authorize: vi.fn(async () => who) });
    await addLookupValues(identity, { items: [{ category: "Quarter", value: "Q7" }, { category: "Quarter", value: "q1" }, { category: "Currency", value: "EUR" }] }, deps);
    expect(calls(deps).map((c) => [c.recordId, c.changes[1].current])).toEqual([["b0", "Q7"], ["b1", "EUR"]]);
  });

  it("Remove records Deactivated for that value", async () => {
    const { deps } = make({ authorize: vi.fn(async () => who) });
    await removeLookupValue(identity, "q1", deps);
    expect(calls(deps)[0]).toMatchObject({ entity: "Lookup", recordId: "q1", action: "Deactivated", note: "List: Quarter; Value: Q1" });
    expect(calls(deps)[0].changes.map((c) => [c.label, c.previous, c.current])).toEqual([["Active", "true", "false"]]);
  });

  it("Reorder records only the values whose position changed", async () => {
    const { deps } = make({ authorize: vi.fn(async () => who) });
    await reorderLookupValues(identity, { category: "Quarter", orderedIds: ["q2", "q1"] }, deps);
    expect(calls(deps).map((c) => [c.recordId, c.changes[0].previous, c.changes[0].current])).toEqual([["q2", "2", "1"], ["q1", "1", "2"]]);
    const same = make({ authorize: vi.fn(async () => who) });
    await reorderLookupValues(identity, { category: "Quarter", orderedIds: ["q1", "q2"] }, same.deps);
    expect(calls(same.deps)).toEqual([]);
  });

  it("says plainly that the change was saved when its audit entry could not be written", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, repo } = make({ audit: vi.fn(async () => { throw new Error("down dapiSECRET"); }) });
    const err = (await addLookupValue(identity, { category: "Quarter", value: "Q9" }, deps).catch((e) => e)) as CiError;
    expect(err).toBeInstanceOf(CiError);
    expect(err.message).toContain("The change was saved, but its audit history entry could not be written");
    expect(err.message).not.toMatch(/dapi|down/);
    expect(repo.addLookup).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("writes no audit entry for a refused request", async () => {
    const { deps } = make({ authorize: vi.fn(async () => who) });
    await expect(addLookupValue(identity, { category: "Quarter", value: "q1" }, deps)).rejects.toBeInstanceOf(ValidationError);
    expect(deps.audit).not.toHaveBeenCalled();
  });
});

describe("lookups service", () => {
  it("loads the lists with their usage counts", async () => {
    const { deps } = make();
    const res = await loadLookups(identity, deps);
    expect(res.lookups).toHaveLength(4);
    expect(res.usage).toEqual({ "Quarter|Q1": 2 });
    expect(res.usageCategories).toEqual(["Quarter"]);
  });

  it("stops before authorizing when the table is pending or the database is not connected", async () => {
    const a = make({
      requireTables: () => {
        throw new CiError("CI database table configuration is pending: Lookups.", 503, "NOT_CONFIGURED");
      },
    });
    await expect(loadLookups(identity, a.deps)).rejects.toThrow("pending: Lookups");
    expect(a.deps.authorize).not.toHaveBeenCalled();

    const b = make({
      requireConnected: () => {
        throw new CiError("not connected", 503, "DISABLED");
      },
    });
    await expect(loadLookups(identity, b.deps)).rejects.toThrow("not connected");
    expect(b.deps.authorize).not.toHaveBeenCalled();
  });

  it("a caller who is not allowed changes nothing", async () => {
    const c = make({
      authorize: async () => {
        throw new ForbiddenError("no");
      },
    });
    await expect(loadLookups(identity, c.deps)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addLookupValue(identity, { category: "Quarter", value: "Q5" }, c.deps)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(removeLookupValue(identity, "q1", c.deps)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reorderLookupValues(identity, { category: "Quarter", orderedIds: ["q1", "q2"] }, c.deps)).rejects.toBeInstanceOf(ForbiddenError);
    expect(c.repo.addLookup).not.toHaveBeenCalled();
    expect(c.repo.deactivateLookup).not.toHaveBeenCalled();
    expect(c.repo.reorderLookups).not.toHaveBeenCalled();
  });

  it("adds at the end of the list, records the signed-in person, and refuses duplicates in any case", async () => {
    const { deps, repo } = make();
    await addLookupValue(identity, { category: "Quarter", value: "  Q5 " }, deps);
    expect(repo.addLookup).toHaveBeenCalledWith("Quarter", "Q5", 3, "Corporate Person");
    await expect(addLookupValue(identity, { category: "Quarter", value: "q1" }, deps)).rejects.toBeInstanceOf(ValidationError);
    // a removed (inactive) value may be added again
    await expect(addLookupValue(identity, { category: "Quarter", value: "Q3" }, deps)).resolves.toBeTruthy();
  });

  it("validates the list name and the value", async () => {
    const { deps, repo } = make();
    const bodies: unknown[] = [{ category: "Not A List", value: "x" }, { category: "Quarter", value: "   " }, { category: "Quarter", value: "x".repeat(201) }, null, "text"];
    for (const body of bodies) await expect(addLookupValue(identity, body, deps)).rejects.toBeInstanceOf(ValidationError);
    expect(repo.addLookup).not.toHaveBeenCalled();
  });

  it("removes only an existing active value, by a well-formed id", async () => {
    const { deps, repo } = make();
    await removeLookupValue(identity, "q1", deps);
    expect(repo.deactivateLookup).toHaveBeenCalledWith("q1", "Corporate Person");
    await expect(removeLookupValue(identity, "q3", deps)).rejects.toBeInstanceOf(NotFoundError);
    await expect(removeLookupValue(identity, "zzz", deps)).rejects.toBeInstanceOf(NotFoundError);
    await expect(removeLookupValue(identity, "a'; DROP TABLE t; --", deps)).rejects.toBeInstanceOf(ValidationError);
  });

  it("reorders only when the ids are exactly the list's active values", async () => {
    const { deps, repo } = make();
    await reorderLookupValues(identity, { category: "Quarter", orderedIds: ["q2", "q1"] }, deps);
    expect(repo.reorderLookups).toHaveBeenCalledWith("Quarter", ["q2", "q1"], "Corporate Person");
    const bad: unknown[] = [["q1"], ["q1", "q1"], ["q1", "q2", "q3"], ["q1", "c1"], "q1", []];
    for (const orderedIds of bad) {
      await expect(reorderLookupValues(identity, { category: "Quarter", orderedIds }, deps)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(repo.reorderLookups).toHaveBeenCalledTimes(1);
  });

  it("hides the database's own error text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = make();
    deps.repository = () => ({
      listLookups: async () => {
        throw new Error("PERMISSION_DENIED token dapiSECRET");
      },
      addLookup: vi.fn(),
      addLookups: vi.fn(),
      renameLookup: vi.fn(),
      deactivateLookup: vi.fn(),
      reorderLookups: vi.fn(),
    });
    const hidden = (await loadLookups(identity, deps).catch((e) => e)) as CiError;
    expect(hidden).toBeInstanceOf(CiError);
    expect(hidden.message).not.toMatch(/PERMISSION|dapi/);
    spy.mockRestore();
  });

  it("bulk add saves the valid rows in ONE write, in order, and reports the refused rows", async () => {
    const { deps, repo } = make();
    const res = await addLookupValues(identity, { items: [
      { category: "Quarter", value: "Q4" },
      { category: "Quarter", value: "q1" },
      { category: "Quarter", value: "Q4" },
      { category: "Nope", value: "X" },
      { category: "Currency", value: "EUR" },
      { category: "Currency", value: "  " },
    ] }, deps);
    expect(repo.addLookups).toHaveBeenCalledTimes(1);
    expect((repo.addLookups.mock.calls[0] as unknown as [{ category: string; value: string; sortOrder: number }[]])[0]).toEqual([
      { category: "Quarter", value: "Q4", sortOrder: 3 },
      { category: "Currency", value: "EUR", sortOrder: 2 },
    ]);
    expect(res.results.map((r) => r.ok)).toEqual([true, false, false, false, true, false]);
  });

  it("bulk add is refused for an unauthorized caller (nothing written) and for an empty or oversized batch", async () => {
    const { deps, repo } = make({ authorize: async () => { throw new ForbiddenError("no"); } });
    await expect(addLookupValues(identity, { items: [{ category: "Quarter", value: "Q9" }] }, deps)).rejects.toBeInstanceOf(ForbiddenError);
    expect(repo.addLookups).not.toHaveBeenCalled();
    const ok = make();
    await expect(addLookupValues(identity, { items: [] }, ok.deps)).rejects.toBeInstanceOf(ValidationError);
    await expect(addLookupValues(identity, { items: Array.from({ length: 501 }, () => ({})) }, ok.deps)).rejects.toBeInstanceOf(ValidationError);
  });
});

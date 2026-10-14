import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CiUser, CompetitiveInput, CompetitiveRecord } from "@/types/ci";
import type { CiRepository } from "@/server/ci/repository";

/**
 * Add / Edit save a row TOGETHER with its Change Note and its audit history entry. These tests run the real service against the
 * in-memory repository (no database, no React) with a repository that can be told to fail at the note or audit step.
 */

vi.mock("@/auth", () => ({ auth: async () => null, signIn: vi.fn(), signOut: vi.fn() }));

let override: Partial<CiRepository> = {};
vi.mock("@/server/ci/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/ci/repository")>();
  const { getMockCiRepository } = await import("@/server/ci/testing/mock-repository");
  return { ...actual, getCiRepository: () => ({ ...getMockCiRepository(), ...override }) };
});

const { getCiRepository } = await import("@/server/ci/repository");
const ci = await import("@/server/ci/services/competitive-info");
const { CiError } = await import("@/server/ci/errors");
const { FULL_SCOPE } = await import("@/lib/ci/rules");

const THIS_YEAR = String(new Date().getFullYear());

function row(): Omit<CompetitiveRecord, "recordId"> {
  return {
    quarter: "Q1", year: THIS_YEAR, customer: "UMC", fabLocation: "UMC Hsinchu", fabRegion: "Taiwan", servedMarket: "Foundry", technologyNode: "28nm",
    waferSize: '300mm (12")', processApplication: "Liner", processType: "Selective", processLocation: "STI", films: "", productLine: "ALD",
    topCompetitor: "TEL", productName: "Trias", processModules: "2", orderType: "Module", actualOrder: 2, asp: 1.5, currency: "USD", revenue: 3,
    toolType: "ALD-VF", createdBy: "Seed", createdOn: "2026-01-01",
  };
}

function input(patch: Partial<CompetitiveInput> = {}): CompetitiveInput {
  const { fabRegion: _r, revenue: _v, createdBy: _c, createdOn: _d, ...rest } = row();
  void _r; void _v; void _c; void _d;
  return { ...rest, ...patch };
}

let cm: CiUser;

beforeAll(async () => {
  cm = { ...(await getCiRepository().findUserByEmail("shruti.mehta@example.com"))!, name: "Verified Person", email: "verified@corp.example.com" };
});
beforeEach(() => {
  override = {};
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const liveRows = async () => (await getCiRepository().listRecords(FULL_SCOPE)).length;

describe("Add saves the row, its Change Note and its audit entry as the verified signed-in person", () => {
  it("attributes all three to the signed-in user, with their email on the audit entry", async () => {
    const repo = getCiRepository();
    const addNotes = vi.spyOn(repo, "addNotes");
    override = { addNotes: (n) => repo.addNotes(n), addAudit: (a) => repo.addAudit(a) };
    const res = await ci.createRecordFor(cm, { input: input({ customer: "UMC" }), notes: ["First entry"] });
    expect(res.record.createdBy).toBe("Verified Person");
    const notes = await repo.listNotes(res.record.recordId);
    expect(notes.map((n) => [n.actionTakenBy, n.notes])).toEqual([["Verified Person", "First entry"]]);
    const audit = await repo.listAudit(res.record.recordId);
    expect(audit[0]).toMatchObject({ action: "Created", actionTakenBy: "Verified Person", actorEmail: "verified@corp.example.com", note: "First entry" });
    expect(audit[0].changes.length).toBeGreaterThan(5);
    void addNotes;
  });

  it("a client-sent createdBy or modifiedBy in the request is ignored", async () => {
    const spoof = { input: { ...input(), createdBy: "Someone Else", modifiedBy: "Someone Else" } as CompetitiveInput, notes: ["x"] };
    const res = await ci.createRecordFor(cm, spoof);
    expect(res.record.createdBy).toBe("Verified Person");
    expect(res.record.modifiedBy).toBeUndefined();
  });
});

describe("a row is never left saved without its note and audit entry", () => {
  it("Add: if the audit entry cannot be written the new row is set inactive and the person is told nothing was saved", async () => {
    const before = await liveRows();
    const discard = vi.fn(getCiRepository().discardRecord);
    override = { addAudit: async () => { throw new Error("warehouse down dapiSECRET"); }, discardRecord: discard };
    const err = (await ci.createRecordFor(cm, { input: input(), notes: ["n"] }).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(CiError);
    expect(err.message).toContain("The row was not saved");
    expect(err.message).not.toMatch(/dapi|warehouse/);
    expect(discard).toHaveBeenCalledTimes(1);
    override = {};
    expect(await liveRows()).toBe(before);
  });

  it("Add: if the Change Note cannot be written the row is undone before any audit entry exists", async () => {
    const before = await liveRows();
    const addAudit = vi.fn(async () => {});
    override = { addNotes: async () => { throw new Error("down"); }, addAudit };
    await expect(ci.createRecordFor(cm, { input: input(), notes: ["n"] })).rejects.toThrow(/The row was not saved/);
    expect(addAudit).not.toHaveBeenCalled();
    override = {};
    expect(await liveRows()).toBe(before);
  });

  it("Edit: if the audit entry cannot be written the row gets its previous values back", async () => {
    const created = await ci.createRecordFor(cm, { input: input({ customer: "UMC" }), notes: ["first"] });
    const id = created.record.recordId;
    override = { addAudit: async () => { throw new Error("down"); } };
    await expect(ci.updateRecordFor(cm, id, { input: input({ productLine: "CVD" }), notes: ["change"] })).rejects.toThrow(/The row was not saved/);
    override = {};
    const stored = await getCiRepository().getRecord(id);
    expect(stored?.productLine).toBe("ALD");
    expect(stored?.modifiedBy).toBeUndefined();
  });

  it("Edit: a successful edit records the note and the audit entry with the changed fields and who made them", async () => {
    const created = await ci.createRecordFor(cm, { input: input(), notes: ["first"] });
    const id = created.record.recordId;
    const res = await ci.updateRecordFor(cm, id, { input: input({ productLine: "CVD" }), notes: ["switch line"] });
    expect(res.record.modifiedBy).toBe("Verified Person");
    const audit = await getCiRepository().listAudit(id);
    const edited = audit.find((a) => a.action === "Edited")!;
    expect(edited).toMatchObject({ actionTakenBy: "Verified Person", actorEmail: "verified@corp.example.com", note: "switch line" });
    expect(edited.changes.map((c) => [c.label, c.previous, c.current])).toEqual([["Product Line", "ALD", "CVD"]]);
    expect((await getCiRepository().listNotes(id)).map((n) => n.notes)).toEqual(["first", "switch line"]);
  });

  it("a Change Note is still required, and nothing is written without one", async () => {
    const before = await liveRows();
    await expect(ci.createRecordFor(cm, { input: input(), notes: ["  "] })).rejects.toThrow();
    expect(await liveRows()).toBe(before);
  });
});

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CiUser, CompetitiveInput, CompetitiveRecord } from "@/types/ci";

/**
 * Server-side authorization tests for the BRD 1.1 role model: Corporate
 * Marketing (full scope + management), Sales (Customer AND Segment AND
 * Region scope, no management). They exercise the real services against the
 * in-memory repository — no React involved.
 */

vi.mock("@/auth", () => ({ auth: async () => null, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/server/ci/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/ci/repository")>();
  const { getMockCiRepository } = await import("@/server/ci/testing/mock-repository");
  return { ...actual, getCiRepository: () => getMockCiRepository() };
});

const { getCiRepository } = await import("@/server/ci/repository");
const ci = await import("@/server/ci/services/competitive-info");
const mgmt = await import("@/server/ci/services/management");
const imp = await import("@/server/ci/services/import");
const { rowRecipients } = await import("@/server/ci/notifications");
const { fieldOptions, blankForm, canEditRecord, editWindowMessage } = await import("@/lib/ci/rules");
const { ForbiddenError, NotFoundError, ValidationError } = await import("@/server/ci/errors");

const repo = getCiRepository();
const THIS_YEAR = String(new Date().getFullYear());

function row(customer: string, servedMarket: string, fabLocation: string, fabRegion: string, year = THIS_YEAR): Omit<CompetitiveRecord, "recordId"> {
  return {
    quarter: "Q1", year, customer, fabLocation, fabRegion, servedMarket, technologyNode: "28nm", waferSize: '300mm (12")',
    processApplication: "Liner", processType: "Selective", processLocation: "STI", films: "", productLine: "ALD",
    topCompetitor: "TEL", productName: "Trias", processModules: "2", orderType: "Module",
    actualOrder: 2, asp: 1.5, currency: "USD", revenue: 3, toolType: "ALD-VF", createdBy: "Shruti Mehta", createdOn: "2026-01-01",
  };
}

/** A complete, valid Add payload for UMC / Foundry / UMC Hsinchu (Taiwan). */
function input(patch: Partial<CompetitiveInput> = {}): CompetitiveInput {
  const { fabRegion: _r, revenue: _v, createdBy: _c, createdOn: _d, ...rest } = row("UMC", "Foundry", "UMC Hsinchu", "Taiwan");
  void _r; void _v; void _c; void _d;
  return { ...rest, ...patch };
}

let cm: CiUser;
let salesA: CiUser; // Customer UMC, Segment Foundry, Region Taiwan
let salesB: CiUser; // Customers UMC+Samsung, Segments Foundry+Logic, Regions Taiwan+Korea
const ids: Record<string, string> = {};

beforeAll(async () => {
  cm = (await repo.findUserByEmail("shruti.mehta@example.com"))!;
  salesA = await repo.createUser({ name: "Sales A", email: "sales.a@test", role: "Sales", customerScope: ["UMC"], segmentScope: ["Foundry"], regionScope: ["Taiwan"], status: "Active" });
  salesB = await repo.createUser({
    name: "Sales B", email: "sales.b@test", role: "Sales",
    customerScope: ["UMC", "Samsung"], segmentScope: ["Foundry", "Logic"], regionScope: ["Taiwan", "Korea"], status: "Active",
  });
  const created = await repo.createRecords([
    row("UMC", "Foundry", "UMC Hsinchu", "Taiwan"), // R1 — A: visible
    row("UMC", "Logic", "UMC Tainan", "Taiwan"), //    R2 — other segment
    row("Intel", "Foundry", "Intel Arizona", "North America"), // R3 — other customer + region
    row("Samsung", "Foundry", "Samsung Hwaseong", "Korea"), // R4 — other customer
    row("UMC", "Foundry", "UMC Singapore", "SEA"), // R5 — same customer + segment, other region
  ]);
  ["R1", "R2", "R3", "R4", "R5"].forEach((k, i) => (ids[k] = created[i].recordId));
});

const visible = async (u: CiUser) => (await ci.listRecordsFor(u)).map((r) => r.recordId).sort();

describe("All Competitive Info — data scope is applied on the server", () => {
  it("Corporate Marketing sees every row", async () => {
    expect(await visible(cm)).toEqual(Object.values(ids).sort());
  });
  it("Sales A (UMC / Foundry / Taiwan) sees only R1 — Customer AND Segment AND Region", async () => {
    expect(await visible(salesA)).toEqual([ids.R1]);
  });
  it("Sales B with several values per scope sees R1, R2 and R4 only", async () => {
    expect(await visible(salesB)).toEqual([ids.R1, ids.R2, ids.R4].sort());
  });
  it("the repository query itself receives the scope (not filtered later in React)", async () => {
    const spy = vi.spyOn(repo, "listRecords");
    await ci.listRecordsFor(salesA);
    expect(spy).toHaveBeenCalledWith({ customers: ["UMC"], segments: ["Foundry"], regions: ["Taiwan"] });
    spy.mockRestore();
  });
});

describe("Record ID manipulation by a Sales user", () => {
  it("can open an in-scope row", async () => {
    expect((await ci.getRecordFor(salesA, ids.R1)).record.recordId).toBe(ids.R1);
  });
  it("cannot open, audit or update an out-of-scope row (reported as not found)", async () => {
    await expect(ci.getRecordFor(salesA, ids.R3)).rejects.toBeInstanceOf(NotFoundError);
    await expect(ci.getAuditFor(salesA, ids.R5)).rejects.toBeInstanceOf(NotFoundError);
    await expect(ci.updateRecordFor(salesA, ids.R4, { input: input(), notes: ["x"] })).rejects.toBeInstanceOf(NotFoundError);
  });
  it("cannot move an in-scope row out of scope by editing Customer / Fab", async () => {
    await expect(
      ci.updateRecordFor(salesA, ids.R1, { input: input({ customer: "Intel", fabLocation: "Intel Arizona" }), notes: ["x"] })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ci.updateRecordFor(salesA, ids.R1, { input: input({ fabLocation: "UMC Singapore" }), notes: ["x"] })).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });
});

describe("Add — submitted values are checked against the scope", () => {
  it("Sales cannot add for another customer or a fab outside their Region (tampered payload)", async () => {
    await expect(ci.createRecordFor(salesA, { input: input({ customer: "Intel", fabLocation: "Intel Arizona" }), notes: ["x"] })).rejects.toBeInstanceOf(
      ForbiddenError
    );
    await expect(ci.createRecordFor(salesA, { input: input({ fabLocation: "UMC Singapore" }), notes: ["x"] })).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("Sales can add a row for any Year: the edit window follows the created date, which is today for a new row", async () => {
    const { record } = await ci.createRecordFor(salesA, { input: input({ year: "2020" }), notes: ["x"] });
    expect(record.year).toBe("2020");
  });
  it("Sales can add inside their scope; Fab Region is derived on the server", async () => {
    const { record } = await ci.createRecordFor(salesA, { input: input(), notes: ["New order seen at fab"] });
    expect(record.fabRegion).toBe("Taiwan");
    expect(record.createdBy).toBe("Sales A");
  });
  it("Corporate Marketing can add for any customer and region", async () => {
    const { record } = await ci.createRecordFor(cm, {
      input: input({ customer: "Intel", fabLocation: "Intel Arizona", servedMarket: "Logic", technologyNode: "1207", processLocation: "STI" }),
      notes: ["CM entry"],
    });
    expect(record.fabRegion).toBe("North America");
  });
});

describe("Corporate Marketing-only services reject Sales", () => {
  const forbidden = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(ForbiddenError);
  it("Competitive FF, Import (historic + bulk)", async () => {
    await forbidden(ci.listFlatFile(salesA));
    await forbidden(imp.previewHistoric(salesA, { fileName: "x", headers: [], rows: [] }, {}));
    await forbidden(imp.commitHistoric(salesA, { fileName: "x", headers: [], rows: [] }, {}));
    await forbidden(imp.previewBulk(salesA, { fileName: "x", headers: [], rows: [] }, "note"));
    await forbidden(imp.commitBulk(salesA, { fileName: "x", headers: [], rows: [] }, "note"));
  });
  it("User Management", async () => {
    await forbidden(mgmt.listUsersFor(salesA));
    await forbidden(mgmt.createUserFor(salesA, { name: "X", email: "x@test", role: "CM", customerScope: "All", segmentScope: "All", regionScope: "All" }));
    await forbidden(mgmt.updateUserFor(salesA, salesA.id, { name: "X", email: "x@test", role: "CM", customerScope: "All", segmentScope: "All", regionScope: "All" }));
    await forbidden(mgmt.offboardPreviewFor(salesA, salesB.id));
    await forbidden(mgmt.offboardUserFor(salesA, salesB.id, cm.id));
  });
  it("Lookups, Sequential Dropdown Lookup and Reference Data", async () => {
    await forbidden(mgmt.listLookupsFor(salesA));
    await forbidden(mgmt.addLookupFor(salesA, "Currency", "GBP"));
    await forbidden(mgmt.removeLookupFor(salesA, "lk1"));
    await forbidden(mgmt.reorderLookupsFor(salesA, "Quarter", []));
    await forbidden(mgmt.referenceDataFor(salesA));
  });
  it("Corporate Marketing is allowed all of them", async () => {
    expect((await mgmt.listUsersFor(cm)).users.length).toBeGreaterThan(0);
    expect((await mgmt.listLookupsFor(cm)).length).toBeGreaterThan(0);
    expect((await mgmt.referenceDataFor(cm)).customerFabs.length).toBeGreaterThan(0);
    expect((await ci.listFlatFile(cm)).length).toBeGreaterThan(0);
    expect((await imp.previewHistoric(cm, { fileName: "x", headers: ["Quarter"], rows: [["Q1"]] }, {})).canCommit).toBe(false);
  });
});

describe("User Management — CI role model", () => {
  it("there is no Admin role", async () => {
    await expect(
      mgmt.createUserFor(cm, { name: "Old Admin", email: "admin@test.example", role: "Admin" as never, customerScope: "All", segmentScope: "All", regionScope: "All" })
    ).rejects.toBeInstanceOf(ValidationError);
  });
  it("a Sales user needs each scope to be All or at least one value", async () => {
    await expect(
      mgmt.createUserFor(cm, { name: "S", email: "s1@test.example", role: "Sales", customerScope: ["UMC"], segmentScope: "All", regionScope: [] })
    ).rejects.toBeInstanceOf(ValidationError);
    const ok = await mgmt.createUserFor(cm, { name: "S", email: "s2@test.example", role: "Sales", customerScope: ["UMC"], segmentScope: "All", regionScope: ["Taiwan"] });
    expect(ok.regionScope).toEqual(["Taiwan"]);
  });
  it("Corporate Marketing always gets full scope", async () => {
    const u = await mgmt.createUserFor(cm, { name: "C", email: "c@test.example", role: "CM", customerScope: ["UMC"], segmentScope: [], regionScope: [] });
    expect([u.customerScope, u.segmentScope, u.regionScope]).toEqual(["All", "All", "All"]);
  });
});

describe("Scope also drives notifications, dropdowns and the edit window", () => {
  it("only users whose scope covers the row (plus Corporate Marketing) are notified", async () => {
    const recipients = rowRecipients(await repo.listUsers(), { customer: "Intel", servedMarket: "Foundry", fabRegion: "North America" }).map((u) => u.email);
    expect(recipients).not.toContain("sales.a@test");
    expect(recipients).toContain("shruti.mehta@example.com");
  });
  it("Sales only gets fabs in their Region scope", async () => {
    const options = { lookups: await repo.listLookups(), reference: await repo.getReferenceData() };
    const fabs = fieldOptions("fabLocation", { ...blankForm(), customer: "UMC" }, { ...options, user: salesA });
    expect(fabs.sort()).toEqual(["UMC Hsinchu", "UMC Tainan"]);
  });
  it("Account Team can edit a row only until 31 Dec of the year it was created; Corporate Marketing always can", () => {
    const row = { customer: "UMC", servedMarket: "Foundry", fabRegion: "Taiwan", createdOn: "2026-10-16" };
    expect(canEditRecord(salesA, row, new Date("2026-10-17T09:00:00Z"))).toBe(true);
    expect(canEditRecord(salesA, row, new Date("2026-12-31T23:59:59Z"))).toBe(true);
    expect(canEditRecord(salesA, row, new Date("2027-01-01T00:00:00Z"))).toBe(false);
    expect(canEditRecord(cm, row, new Date("2030-06-01T00:00:00Z"))).toBe(true);
    // A created date that cannot be read is locked, never open.
    expect(canEditRecord(salesA, { ...row, createdOn: "" }, new Date("2026-10-17T09:00:00Z"))).toBe(false);
  });
  it("the locked message names the year it was created in", () => {
    expect(editWindowMessage("2026-10-16")).toContain("until 31 Dec 2026");
  });
});

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CiUser, CompetitiveRecord } from "@/types/ci";

// The real import service against the in-memory repository (fake data only): no database is opened.

vi.mock("@/auth", () => ({ auth: async () => null, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/server/ci/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/ci/repository")>();
  const { getMockCiRepository } = await import("@/server/ci/testing/mock-repository");
  return { ...actual, getCiRepository: () => getMockCiRepository() };
});

const { getCiRepository } = await import("@/server/ci/repository");
const imp = await import("@/server/ci/services/import");
const { EXCEL_ID_LABEL, EXCEL_ROWS_TEMPLATE_HEADERS } = await import("@/lib/ci/import/add-rows");
const { USER_FIELDS } = await import("@/lib/ci/field-spec");
const { ForbiddenError, ValidationError } = await import("@/server/ci/errors");

const repo = getCiRepository();
const THIS_YEAR = String(new Date().getFullYear());

/** A row the form would accept: UMC / Foundry / UMC Hsinchu. */
const base = {
  quarter: "Q1", year: THIS_YEAR, customer: "UMC", fabLocation: "UMC Hsinchu", servedMarket: "Foundry", technologyNode: "28nm", waferSize: '300mm (12")',
  processApplication: "Liner", processType: "Selective", processLocation: "STI", films: "", productLine: "ALD", topCompetitor: "TEL", productName: "Trias",
  processModules: "2", orderType: "Module", actualOrder: 2, asp: 1.5, currency: "USD", toolType: "ALD-VF",
} as const;

const line = (id: string, patch: Partial<Record<keyof typeof base, string | number>> = {}) => {
  const v: Record<string, unknown> = { ...base, ...patch };
  return [id, ...USER_FIELDS.map((f) => String(v[f.key] ?? ""))];
};
const sheet = (rows: string[][]) => ({ fileName: "rows.xlsx", headers: EXCEL_ROWS_TEMPLATE_HEADERS, rows });

let cm: CiUser;
let sales: CiUser;
let seeded: CompetitiveRecord;

beforeAll(async () => {
  cm = (await repo.findUserByEmail("shruti.mehta@example.com"))!;
  sales = await repo.createUser({ name: "Sales X", email: "sales.x@test", role: "Sales", customerScope: ["UMC"], segmentScope: ["Foundry"], regionScope: ["Taiwan"], status: "Active" });
  [seeded] = await repo.createRecords([
    { ...base, fabRegion: "Taiwan", revenue: 3, createdBy: "Old Owner", createdOn: "2026-01-01" } as Omit<CompetitiveRecord, "recordId">,
  ]);
});

describe("Excel import service", () => {
  it("adds new rows (each with its audit entry and first Change Note) and updates existing rows, in one import", async () => {
    const before = (await repo.listRecords({ customers: "All", segments: "All", regions: "All" })).length;
    const res = await imp.commitExcelRows(cm, sheet([line("", { actualOrder: 7 }), line(seeded.recordId, { actualOrder: 9 })]));
    expect(res).toMatchObject({ importType: "Excel Import", inserted: 1, updated: 1 });

    const all = await repo.listRecords({ customers: "All", segments: "All", regions: "All" });
    expect(all).toHaveLength(before + 1);
    const updated = (await repo.getRecord(seeded.recordId))!;
    expect(updated).toMatchObject({ actualOrder: 9, revenue: 13.5, createdBy: "Old Owner", modifiedBy: "Shruti Mehta" });
    const added = all.find((r) => r.actualOrder === 7)!;
    expect(added).toMatchObject({ createdBy: "Shruti Mehta" });

    const addedAudit = (await repo.listAudit(added.recordId))[0];
    expect(addedAudit).toMatchObject({ action: "Imported", importType: "Excel Import", sourceFile: "rows.xlsx" });
    const editedAudit = (await repo.listAudit(seeded.recordId)).find((a) => a.action === "Edited")!;
    expect(editedAudit).toMatchObject({ importType: "Excel Import", note: "Updated by Corporate Marketing through Excel import." });
    expect(editedAudit.changes.map((c) => c.label)).toContain("Actual Order (#)");
    expect((await repo.listNotes(added.recordId))[0].notes).toBe("Imported by Corporate Marketing (Excel).");
  });

  it("an unchanged existing row is left alone and nothing is imported when there is nothing to add or update", async () => {
    const current = (await repo.getRecord(seeded.recordId))!;
    const same = line(seeded.recordId, { actualOrder: current.actualOrder, asp: current.asp });
    const preview = await imp.previewExcelRows(cm, sheet([same]));
    expect(preview.summary).toMatchObject({ unchanged: 1, added: 0, updated: 0 });
    await expect(imp.commitExcelRows(cm, sheet([same]))).rejects.toBeInstanceOf(ValidationError);
  });

  it("puts everything back when a later step fails: new rows switched off, updated rows restored", async () => {
    const before = (await repo.listRecords({ customers: "All", segments: "All", regions: "All" })).length;
    const original = (await repo.getRecord(seeded.recordId))!;
    const spy = vi.spyOn(repo, "addAudit").mockRejectedValueOnce(new Error("audit down"));
    await expect(imp.commitExcelRows(cm, sheet([line("", { actualOrder: 11 }), line(seeded.recordId, { actualOrder: 12 })]))).rejects.toThrow(/not saved/);
    spy.mockRestore();
    expect(await repo.listRecords({ customers: "All", segments: "All", regions: "All" })).toHaveLength(before);
    expect((await repo.getRecord(seeded.recordId))!.actualOrder).toBe(original.actualOrder);
  });

  it("only Corporate Marketing can import, and a file over the row limit is refused before anything is read", async () => {
    await expect(imp.previewExcelRows(sales, sheet([line("")]))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(imp.commitExcelRows(sales, sheet([line("")]))).rejects.toBeInstanceOf(ForbiddenError);
    const huge = Array.from({ length: imp.MAX_EXCEL_ROWS + 1 }, () => line(""));
    await expect(imp.previewExcelRows(cm, sheet(huge))).rejects.toBeInstanceOf(ValidationError);
  });

  it("a row with problems is listed and left out while the valid rows are imported", async () => {
    const res = await imp.commitExcelRows(cm, sheet([line("", { actualOrder: 21 }), line("", { customer: "Nobody Inc", actualOrder: 22 })]));
    expect(res).toMatchObject({ inserted: 1, updated: 0 });
    const all = await repo.listRecords({ customers: "All", segments: "All", regions: "All" });
    expect(all.some((r) => r.actualOrder === 21)).toBe(true);
    expect(all.some((r) => r.actualOrder === 22)).toBe(false);
    expect(EXCEL_ID_LABEL).toBe("Application ID");
  });
});

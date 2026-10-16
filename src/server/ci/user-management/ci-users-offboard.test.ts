import { describe, expect, it, vi } from "vitest";
import { ForbiddenError, ValidationError } from "@/server/ci/errors";
import { assertReadOnlyStatement } from "@/server/db/read-only";
import type { UserRecordWriter } from "@/server/ci/databricks/user-records";
import { buildOwnedCountsStatement, buildOwnedRowIdsStatement, offboardCiUser, offboardDetails, offboardNote, parseOffboardNote, previewOffboard, type OffboardDeps } from "@/server/ci/user-management/ci-users-offboard";
import { mergeScopeText } from "@/lib/ci/user-offboard";
import type { CiUserRecordRaw } from "@/types/ci-api";

// Fakes only: no database connection is opened.
const identity = { email: "cm@example.com", name: "CM" };
const rec = (over: Partial<CiUserRecordRaw>): CiUserRecordRaw => ({
  id: "x", userName: "X", email: "x@example.com", role: "Account Team", customer: '["UMC"]', segment: '["Foundry"]', region: '["TWN"]',
  status: "Active", lastSignIn: "", isActive: true, ...over,
});
const CM = rec({ id: "cm", userName: "Corp Marketing", email: "cm@example.com", role: "Corporate Marketing", customer: "All", segment: "All", region: "All" });
const CM2 = rec({ id: "cm2", userName: "Cara", email: "cara@example.com", role: "Corporate Marketing", customer: "All", segment: "All", region: "All" });
const LEAVER = rec({ id: "l", userName: "Lee", email: "lee@example.com", customer: '["TSMC"]' });
const OWNER = rec({ id: "o", userName: "Olu", email: "olu@example.com", customer: '["UMC"]' });

function setup(users: CiUserRecordRaw[], ids: string[] = ["r1", "r2", "r3"], over: Partial<OffboardDeps> = {}) {
  const rows = users.map((u) => ({ ...u }));
  const order: string[] = [];
  const audit = vi.fn(async () => { order.push("audit"); });
  const writer: UserRecordWriter = {
    list: async () => rows.map((r) => ({ ...r })),
    newId: () => "n",
    now: () => "2026-10-16T09:00:00.000Z",
    insert: vi.fn(async () => true),
    update: vi.fn(async (r) => { order.push("update"); Object.assign(rows.find((u) => u.id === r.id)!, { customer: r.customer, segment: r.segment, region: r.region }); }),
    setActive: vi.fn(async (r) => { order.push("setActive"); Object.assign(rows.find((u) => u.id === r.id)!, { isActive: r.active, status: r.status }); }),
  };
  const deps: OffboardDeps = {
    requireTables: vi.fn(),
    requireConnected: vi.fn(),
    authorize: vi.fn(async () => ({ email: "cm@example.com", userName: "CM" })),
    writer: () => writer,
    ownedRowIds: vi.fn(async () => ids),
    audit,
    ...over,
  };
  return { deps, writer, rows, audit, order };
}

describe("off-board SQL", () => {
  it("reads ci_main only, live rows, exact name, with the name escaped", () => {
    const ids = buildOwnedRowIdsStatement("c.s.ci_main", "O'Neil");
    const counts = buildOwnedCountsStatement("c.s.ci_main");
    for (const sql of [ids, counts]) {
      expect(() => assertReadOnlyStatement(sql)).not.toThrow();
      expect(sql).toContain("`is_active` = TRUE");
    }
    expect(ids).toContain("= 'O''Neil'");
    expect(counts).toContain("GROUP BY");
  });
});

describe("mergeScopeText", () => {
  it("is All if either side is All, otherwise the union; invalid scope is not guessed", () => {
    expect(mergeScopeText("All", '["A"]')).toBe("All");
    expect(mergeScopeText('["A"]', '["B","A"]')).toBe('["A","B"]');
    expect(mergeScopeText("", '["A"]')).toBeNull();
  });
});

describe("previewOffboard", () => {
  it("counts the leaver's rows", async () => {
    const { deps } = setup([CM, LEAVER, OWNER]);
    expect(await previewOffboard(identity, "l", deps)).toEqual({ ownedRows: 3, blocked: null });
  });
  it("says why a user cannot be off-boarded, without counting", async () => {
    const { deps } = setup([CM, LEAVER]);
    const r = await previewOffboard(identity, "cm", deps);
    expect(r.blocked).toMatch(/off-board yourself/);
    expect(deps.ownedRowIds).not.toHaveBeenCalled();
  });
});

describe("offboardDetails", () => {
  it("reads who took over, and the combined scope, from the audit entries written at off-board time", async () => {
    const off = rec({ ...LEAVER, isActive: false, status: "Off-boarded" });
    const s = setup([CM, off, OWNER]);
    const when = "2026-10-16T09:00:00.000Z";
    const auditList = async (id: string) =>
      id === "l"
        ? [{ id: "1", recordId: "l", action: "Deactivated", actionTakenBy: "CM", dateTime: when, changes: [], note: offboardNote(3, "Olu", "olu@example.com") }]
        : [{ id: "2", recordId: "o", action: "Edited", actionTakenBy: "CM", dateTime: when, changes: [{ field: "Customer", label: "Customer", previous: '["UMC"]', current: '["UMC","TSMC"]' }], note: "Scope combined with Lee (lee@example.com), who was off-boarded." }];
    const res = await offboardDetails(identity, "l", { ...s.deps, auditList } as never);
    expect(res).toMatchObject({ found: true, rows: 3, newOwner: { name: "Olu", email: "olu@example.com", role: "Account Team" }, by: "CM", scopeCombined: true });
    expect(res.found && res.scope).toEqual([{ label: "Customer", before: '["UMC"]', after: '["UMC","TSMC"]' }]);
  });

  it("says details were not found when there is no off-board entry, and parses the note both ways", async () => {
    const s = setup([CM, LEAVER]);
    expect(await offboardDetails(identity, "l", { ...s.deps, auditList: async () => [] } as never)).toEqual({ found: false, leaverName: "Lee" });
    expect(parseOffboardNote(offboardNote(1, "Ann (Lee)", "a@x.com"))).toEqual({ rows: 1, name: "Ann (Lee)", email: "a@x.com" });
    expect(parseOffboardNote("something else")).toBeNull();
  });
});

describe("offboardCiUser", () => {
  it("audits every row first, merges Account Team scope, then marks the leaver Off-boarded", async () => {
    const { deps, rows, audit, order } = setup([CM, LEAVER, OWNER]);
    const res = await offboardCiUser(identity, "l", { reassignToUserId: "o" }, deps);
    expect(res.reassignedRows).toBe(3);
    const rowAudit = (audit.mock.calls[0] as unknown as [{ action: string; recordId: string; changes: { previous: string; current: string }[] }[]])[0];
    expect(rowAudit.map((a) => a.recordId)).toEqual(["r1", "r2", "r3"]);
    expect(rowAudit[0]).toMatchObject({ action: "Reassigned", changes: [{ previous: "Lee", current: "Olu" }] });
    expect(order).toEqual(["audit", "audit", "update", "audit", "setActive"]);
    expect(rows.find((u) => u.id === "o")!.customer).toBe('["UMC","TSMC"]');
    expect(rows.find((u) => u.id === "l")).toMatchObject({ isActive: false, status: "Off-boarded" });
  });

  it("does not touch the new owner's scope when the owner is Corporate Marketing", async () => {
    const { deps, writer } = setup([CM, LEAVER, CM2]);
    await offboardCiUser(identity, "l", { reassignToUserId: "cm2" }, deps);
    expect(writer.update).not.toHaveBeenCalled();
    expect(writer.setActive).toHaveBeenCalled();
  });

  it("refuses yourself, an inactive or missing new owner, a shared name, and a bad scope - changing nothing", async () => {
    const a = setup([CM, LEAVER]);
    await expect(offboardCiUser(identity, "cm", { reassignToUserId: "l" }, a.deps)).rejects.toBeInstanceOf(ValidationError);
    const b = setup([CM, LEAVER, rec({ id: "o", userName: "Olu", email: "o@example.com", isActive: false, status: "Off-boarded" })]);
    await expect(offboardCiUser(identity, "l", { reassignToUserId: "o" }, b.deps)).rejects.toBeInstanceOf(ValidationError);
    await expect(offboardCiUser(identity, "l", { reassignToUserId: "l" }, b.deps)).rejects.toBeInstanceOf(ValidationError);
    const c = setup([CM, LEAVER, OWNER, rec({ id: "dup", userName: "Lee", email: "lee2@example.com" })]);
    const shared = (await offboardCiUser(identity, "l", { reassignToUserId: "o" }, c.deps).catch((e) => e)) as ValidationError;
    expect((shared.details ?? []).join(" ")).toMatch(/cannot be told apart/);
    const d = setup([CM, LEAVER, rec({ id: "o", userName: "Olu", email: "o@example.com", customer: "bad" })]);
    await expect(offboardCiUser(identity, "l", { reassignToUserId: "o" }, d.deps)).rejects.toBeInstanceOf(ValidationError);
    for (const s of [a, b, c, d]) {
      expect(s.audit).not.toHaveBeenCalled();
      expect(s.writer.setActive).not.toHaveBeenCalled();
    }
  });

  it("changes nothing when the audit cannot be written", async () => {
    const { deps, writer } = setup([CM, LEAVER, OWNER], ["r1"], { audit: async () => { throw new Error("down"); } });
    await expect(offboardCiUser(identity, "l", { reassignToUserId: "o" }, deps)).rejects.toThrow(/nothing was saved/);
    expect(writer.update).not.toHaveBeenCalled();
    expect(writer.setActive).not.toHaveBeenCalled();
  });

  it("a refused caller gets the refusal", async () => {
    const { deps } = setup([CM, LEAVER, OWNER], ["r1"], { authorize: async () => { throw new ForbiddenError("no"); } });
    await expect(offboardCiUser(identity, "l", { reassignToUserId: "o" }, deps)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

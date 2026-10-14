import { describe, expect, it, vi } from "vitest";
import { ConflictError, DisabledError, ForbiddenError, NotFoundError, ValidationError } from "@/server/ci/errors";
import { assertCiWriteStatement } from "@/server/db/write-guard";
import {
  assertUserWriteStatement,
  buildInsertUserStatement,
  buildSetActiveStatement,
  buildUpdateUserStatement,
  createUserRecordWriter,
  type UserRecordWriter,
} from "@/server/ci/databricks/user-records";
import { USER_EDIT_DELETE_ENABLED, createCiUser, deactivateCiUser, parseUserBody, reactivateCiUser, updateCiUser, type CiUsersWriteDeps } from "@/server/ci/user-management/ci-users-write";
import type { CiUserRecordRaw } from "@/types/ci-api";

// Fake table names and an in-memory fake database only: nothing here opens a Databricks connection.

const TABLE = "corp_marketing_dev.ci.test_users";
const NOW = "2026-10-12T09:00:00.000Z";
const identity = { email: "cm@example.com", name: "Corp Marketing" };

const rec = (over: Partial<CiUserRecordRaw>): CiUserRecordRaw => ({
  id: "x", userName: "X", email: "x@example.com", role: "Account Team", customer: '["UMC"]', segment: '["Foundry"]', region: '["TWN"]',
  status: "Active", lastSignIn: "", isActive: true, ...over,
});
const CM = rec({ id: "cm", userName: "Corp Marketing", email: "cm@example.com", role: "Corporate Marketing", customer: "All", segment: "All", region: "All" });
const CM2 = rec({ id: "cm2", email: "cm2@example.com", role: "Corporate Marketing", customer: "All", segment: "All", region: "All" });
const AT = rec({ id: "at", userName: "Ann", email: "ann@example.com" });

function fakeWriter(initial: CiUserRecordRaw[]) {
  const rows = initial.map((r) => ({ ...r })); // copies: tests must not share mutable records
  const calls: string[] = [];
  const writer: UserRecordWriter = {
    list: async () => rows.map((r) => ({ ...r })),
    newId: () => "new-user-id",
    now: () => NOW,
    insert: vi.fn(async (r) => {
      calls.push("insert");
      if (rows.some((u) => u.email.toLowerCase() === r.email.toLowerCase())) return false; // the MERGE would insert nothing
      rows.push(rec({ id: r.id, userName: r.userName, email: r.email, role: r.role, customer: r.customer, segment: r.segment, region: r.region, status: r.status }));
      return true;
    }),
    update: vi.fn(async (r) => {
      calls.push("update");
      const t = rows.find((u) => u.id === r.id)!;
      Object.assign(t, { userName: r.userName, role: r.role, customer: r.customer, segment: r.segment, region: r.region });
    }),
    setActive: vi.fn(async (r) => {
      calls.push("setActive");
      Object.assign(rows.find((u) => u.id === r.id)!, { isActive: r.active, status: r.status });
    }),
  };
  return { writer, rows, calls };
}

function deps(initial: CiUserRecordRaw[], over: Partial<CiUsersWriteDeps> = {}) {
  const f = fakeWriter(initial);
  const d: CiUsersWriteDeps = {
    requireTables: vi.fn(),
    requireConnected: vi.fn(),
    authorize: vi.fn(async () => ({ email: "cm@example.com", userName: "Corp Marketing" })),
    // Default: no directory check (pass-through); the directory tests below override it.
    directoryUser: async (email, typedName) => ({ email: email.trim().toLowerCase(), userName: typedName.trim() }),
    writer: () => f.writer,
    editsEnabled: () => true,
    masters: async () => ({}),
    audit: vi.fn(async () => {}),
    ...over,
  };
  return { d, ...f };
}

/** Rejects with a ValidationError whose detail messages match. */
async function expectValidation(promise: Promise<unknown>, pattern?: RegExp) {
  const err = (await promise.then(() => null, (e) => e)) as ValidationError | null;
  expect(err).toBeInstanceOf(ValidationError);
  if (pattern) expect((err!.details ?? []).join(" ")).toMatch(pattern);
}

const body = { userName: "New Person", email: "New.Person@Example.com", role: "Account Team", customers: ["UMC"], segments: ["Foundry"], regions: ["TWN"] };

describe("user write statements", () => {
  it("the insert is one MERGE that inserts only when the email is free, with explicit timestamp casts, and passes both write guards", () => {
    const sql = buildInsertUserStatement(TABLE, { id: "id1", userName: "A'B", email: "A@X.com", role: "Account Team", customer: '["a"]', segment: '["b"]', region: '["c"]', status: "Active", actor: "Me", now: NOW });
    expect(sql.startsWith("MERGE INTO `corp_marketing_dev`.`ci`.`test_users` AS t")).toBe(true);
    expect(sql).toContain("ON LOWER(TRIM(t.`user_email`)) = s.`user_email`");
    expect(sql).not.toContain("WHEN MATCHED");
    expect(sql).toContain("'a@x.com'");
    expect(sql).toContain("'A''B'");
    expect(sql).toContain("CAST('2026-10-12T09:00:00.000Z' AS TIMESTAMP)");
    expect(sql).not.toContain("last_sign_in");
    expect(() => assertUserWriteStatement(TABLE, sql)).not.toThrow();
    expect(() => assertCiWriteStatement(sql)).not.toThrow();
  });

  it("update and deactivate are single UPDATEs keyed on the id; nothing is ever deleted", () => {
    const up = buildUpdateUserStatement(TABLE, { id: "i", userName: "N", role: "Account Team", customer: "c", segment: "s", region: "r", actor: "Me", now: NOW });
    const off = buildSetActiveStatement(TABLE, { id: "i", active: false, status: "Off-boarded", actor: "Me", now: NOW });
    for (const sql of [up, off]) {
      expect(sql.startsWith("UPDATE `corp_marketing_dev`.`ci`.`test_users` SET")).toBe(true);
      expect(sql).toMatch(/WHERE `ci_user_id` = 'i'$/);
      expect(sql).not.toMatch(/DELETE/i);
      expect(() => assertUserWriteStatement(TABLE, sql)).not.toThrow();
    }
    expect(off).toContain("`is_active` = FALSE");
    expect(off).toContain("`status` = 'Off-boarded'");
    expect(up).not.toContain("user_email");
  });

  it("the table guard refuses anything else, including SAMBA and a second statement", () => {
    for (const bad of [`DELETE FROM ${TABLE}`, "UPDATE `corp_marketing_dev`.`samba`.`samba_usermanagement` SET a = 1", `UPDATE \`corp_marketing_dev\`.\`ci\`.\`test_users\` SET a = 1; DROP TABLE x`]) {
      expect(() => assertUserWriteStatement(TABLE, bad)).toThrow(/Refused/);
    }
  });

  it("the writer sends every statement through the guard and reports whether its row landed", async () => {
    const sent: string[] = [];
    const rows: Record<string, unknown>[] = [];
    const w = createUserRecordWriter(TABLE, {
      query: async () => rows,
      execute: async (s) => { sent.push(s); if (!rows.length) rows.push({ ci_user_id: "id1", user_email: "a@x.com", is_active: "true" }); },
      now: () => NOW,
      newId: () => "id1",
    });
    expect(await w.insert({ id: "id1", userName: "A", email: "a@x.com", role: "Account Team", customer: "c", segment: "s", region: "r", status: "Active", actor: "Me" })).toBe(true);
    expect(await w.insert({ id: "other", userName: "A", email: "a@x.com", role: "Account Team", customer: "c", segment: "s", region: "r", status: "Active", actor: "Me" })).toBe(false);
    expect(sent.every((s) => s.startsWith("MERGE INTO"))).toBe(true);
  });
});

describe("createCiUser", () => {
  it("adds one validated record and returns it", async () => {
    const { d, rows } = deps([CM]);
    const res = await createCiUser(identity, body, d);
    expect(res.user).toMatchObject({ id: "new-user-id", email: "new.person@example.com", role: "Account Team", customer: '["UMC"]', status: "Active", isActive: true });
    expect(rows.map((r) => r.id)).toContain("new-user-id");
  });

  it("is refused before anything is read or written when the caller is not authorized", async () => {
    const { d, calls } = deps([CM], { authorize: async () => { throw new ForbiddenError("no"); } });
    await expect(createCiUser(identity, body, d)).rejects.toBeInstanceOf(ForbiddenError);
    expect(calls).toEqual([]);
  });

  it("stops at the table or connection check before authorizing", async () => {
    const { d } = deps([CM], { requireConnected: () => { throw new ConflictError("offline"); } });
    await expect(createCiUser(identity, body, d)).rejects.toThrow("offline");
    expect(d.authorize).not.toHaveBeenCalled();
  });

  it("validates on the server: roles, scope and malformed bodies are refused with nothing written", async () => {
    const bads: unknown[] = [
      { ...body, role: "Admin" },
      { ...body, role: "Account Team", customers: ["All"] },
      { ...body, segments: [] },
      { ...body, email: "not-an-email" },
      { ...body, userName: "" },
      { ...body, customers: "UMC" },
      null,
      "text",
    ];
    for (const b of bads) {
      const { d, calls } = deps([CM]);
      await expect(createCiUser(identity, b, d), JSON.stringify(b)).rejects.toBeInstanceOf(ValidationError);
      expect(calls).toEqual([]);
    }
  });

  it("keeps one record per email: an existing record, even an inactive one, blocks a new one", async () => {
    for (const existing of [AT, rec({ id: "old", email: "new.person@example.com", isActive: false, status: "Off-boarded" })]) {
      const { d, calls } = deps([CM, existing]);
      await expect(createCiUser(identity, { ...body, email: existing.email.toUpperCase() }, d)).rejects.toBeInstanceOf(ValidationError);
      expect(calls).toEqual([]);
    }
  });

  it("a race for the same email is caught after the insert: the loser gets a conflict, not a duplicate", async () => {
    const { d, rows } = deps([CM]);
    const writer = d.writer();
    const original = writer.insert;
    writer.insert = async (r) => { rows.push(rec({ id: "winner", email: r.email })); return original(r); };
    await expect(createCiUser(identity, body, d)).rejects.toBeInstanceOf(ConflictError);
    expect(rows.filter((r) => r.email === "new.person@example.com")).toHaveLength(1);
  });

  it("Corporate Marketing is saved as All / All / All whatever scope was sent", async () => {
    const { d } = deps([CM]);
    const res = await createCiUser(identity, { ...body, role: "Corporate Marketing", customers: ["X"] }, d);
    expect(res.user).toMatchObject({ customer: "All", segment: "All", region: "All" });
  });

  it("hides the database's own error text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { d } = deps([CM]);
    d.writer().insert = async () => { throw new Error("PERMISSION_DENIED dapiSECRET"); };
    const err = (await createCiUser(identity, body, d).catch((e) => e)) as Error;
    expect(err.message).not.toMatch(/PERMISSION|dapi/);
    spy.mockRestore();
  });
});

describe("user audit history (written first, by the verified signed-in person)", () => {
  const auditCalls = (d: CiUsersWriteDeps) => vi.mocked(d.audit).mock.calls.flatMap((c) => c[0]);

  it("Add records every saved field as a Created entry with the signed-in person's name and email", async () => {
    const { d } = deps([CM]);
    await createCiUser(identity, body, d);
    const [entry] = auditCalls(d);
    expect(entry).toMatchObject({ entity: "User", recordId: "new-user-id", action: "Created", actionByName: "Corp Marketing", actionByEmail: "cm@example.com", at: NOW });
    expect(entry.changes.map((c) => [c.label, c.previous, c.current])).toEqual([
      ["User Name", "", "New Person"],
      ["User Email", "", "new.person@example.com"],
      ["Role", "", "Account Team"],
      ["Customer", "", '["UMC"]'],
      ["Served Market", "", '["Foundry"]'],
      ["Region", "", '["TWN"]'],
      ["Status", "", "Active"],
    ]);
  });

  it("Add saves nothing when the audit entry cannot be written", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { d, calls } = deps([CM], { audit: vi.fn(async () => { throw new Error("warehouse down dapiSECRET"); }) });
    const err = (await createCiUser(identity, body, d).catch((e) => e)) as Error;
    expect(err.message).toContain("nothing was saved");
    expect(err.message).not.toMatch(/dapi|warehouse/);
    expect(calls).toEqual([]);
    spy.mockRestore();
  });

  it("Add never audits a request that failed validation or authorization", async () => {
    const a = deps([CM]);
    await expect(createCiUser(identity, { ...body, role: "Admin" }, a.d)).rejects.toBeInstanceOf(ValidationError);
    expect(a.d.audit).not.toHaveBeenCalled();
    const b = deps([CM], { authorize: async () => { throw new ForbiddenError("no"); } });
    await expect(createCiUser(identity, body, b.d)).rejects.toBeInstanceOf(ForbiddenError);
    expect(b.d.audit).not.toHaveBeenCalled();
  });

  it("Edit records only the fields that changed, with old and new values, before writing", async () => {
    const { d, calls } = deps([CM, AT]);
    await updateCiUser(identity, "at", { userName: "Ann Lee", email: "ann@example.com", role: "Account Team", customers: ["UMC", "TSMC"], segments: ["Foundry"], regions: ["TWN"] }, d);
    const entries = auditCalls(d);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entity: "User", recordId: "at", action: "Edited", actionByName: "Corp Marketing", actionByEmail: "cm@example.com" });
    expect(entries[0].changes.map((c) => [c.label, c.previous, c.current])).toEqual([
      ["User Name", "Ann", "Ann Lee"],
      ["Customer", '["UMC"]', '["UMC","TSMC"]'],
    ]);
    expect(calls).toEqual(["update"]);
  });

  it("Edit with nothing changed is refused and writes nothing (no empty audit entry either)", async () => {
    const { d, calls } = deps([CM, AT]);
    await expectValidation(updateCiUser(identity, "at", { userName: "Ann", email: "ann@example.com", role: "Account Team", customers: ["UMC"], segments: ["Foundry"], regions: ["TWN"] }, d), /No changes to save/);
    expect(d.audit).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("Deactivate and Reactivate each record the Active and Status change", async () => {
    const off = deps([CM, AT]);
    await deactivateCiUser(identity, "at", off.d);
    expect(auditCalls(off.d)[0]).toMatchObject({ action: "Deactivated", recordId: "at" });
    expect(auditCalls(off.d)[0].changes.map((c) => [c.label, c.previous, c.current])).toEqual([["Active", "true", "false"], ["Status", "Active", "Off-boarded"]]);
    const on = deps([CM, rec({ id: "gone", email: "gone@example.com", isActive: false, status: "Off-boarded" })]);
    await reactivateCiUser(identity, "gone", on.d);
    expect(auditCalls(on.d)[0]).toMatchObject({ action: "Reactivated", recordId: "gone" });
    expect(auditCalls(on.d)[0].changes.map((c) => [c.label, c.previous, c.current])).toEqual([["Active", "false", "true"], ["Status", "Off-boarded", "Active"]]);
  });

  it("Deactivate changes nothing when the audit entry cannot be written", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { d, calls } = deps([CM, AT], { audit: vi.fn(async () => { throw new Error("down"); }) });
    await expect(deactivateCiUser(identity, "at", d)).rejects.toThrow(/nothing was saved/);
    expect(calls).toEqual([]);
    spy.mockRestore();
  });
});

describe("createCiUser: identity and directory", () => {
  it("records the authorized session user as Created By and ignores any identity fields in the request", async () => {
    const { d } = deps([CM]);
    const spoof = { ...body, createdBy: "Someone Else", modifiedBy: "Someone Else", actor: "Someone Else", actorEmail: "boss@example.com", created_by: "Someone Else" };
    await createCiUser(identity, spoof, d);
    const sent = (d.writer().insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent.actor).toBe("Corp Marketing");
    expect(JSON.stringify(sent)).not.toContain("Someone Else");
    expect(d.authorize).toHaveBeenCalledWith(identity);
  });

  it("saves the directory's own email and display name, not the typed ones", async () => {
    const { d, rows } = deps([CM], { directoryUser: async () => ({ email: "new.person@corp.example.com", userName: "New Person (Directory)" }) });
    const res = await createCiUser(identity, { ...body, email: "typed@elsewhere.com", userName: "Typed Name" }, d);
    expect(res.user).toMatchObject({ email: "new.person@corp.example.com", userName: "New Person (Directory)" });
    expect(rows.some((r) => r.email === "new.person@corp.example.com" && r.userName === "New Person (Directory)")).toBe(true);
    expect(rows.some((r) => r.email === "typed@elsewhere.com")).toBe(false);
  });

  it("writes nothing when the person cannot be verified in the directory", async () => {
    const { d, calls } = deps([CM], { directoryUser: async () => { throw new ValidationError(["That email is not in the Microsoft organization directory."]); } });
    await expect(createCiUser(identity, body, d)).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toEqual([]);
  });

  it("one record per person: a record saved earlier under the person's other address (UPN vs mail) blocks a new one", async () => {
    const olderUnderUpn = rec({ id: "old", userName: "Cal", email: "cal@corp.onmicrosoft.com" });
    const { d, calls } = deps([CM, olderUnderUpn], {
      directoryUser: async () => ({ email: "cal.ray@corp.example.com", userName: "Cal Ray", aliases: ["cal.ray@corp.example.com", "cal@corp.onmicrosoft.com"] }),
    });
    const err = (await createCiUser(identity, { ...body, email: "cal.ray@corp.example.com" }, d).catch((e) => e)) as ValidationError;
    expect(err).toBeInstanceOf(ValidationError);
    expect((err.details ?? []).join(" ")).toContain("already has a CI user record (cal@corp.onmicrosoft.com)");
    expect(calls).toEqual([]);
  });

  it("checks authorization before the directory is consulted", async () => {
    const directoryUser = vi.fn(async () => ({ email: "a@b.com", userName: "A" }));
    const { d } = deps([CM], { directoryUser, authorize: async () => { throw new ForbiddenError("no"); } });
    await expect(createCiUser(identity, body, d)).rejects.toBeInstanceOf(ForbiddenError);
    expect(directoryUser).not.toHaveBeenCalled();
  });
});

describe("Edit / Deactivate / Reactivate: on in the shipped code, and refused when the switch is off", () => {
  it("are enabled in the shipped code", () => {
    expect(USER_EDIT_DELETE_ENABLED).toBe(true);
  });

  it("refuse after authorization, with nothing read or written, when the switch is off", async () => {
    for (const run of [
      (d: CiUsersWriteDeps) => updateCiUser(identity, "at", { userName: "A", email: "ann@example.com", role: "Account Team", customers: "All", segments: "All", regions: "All" }, d),
      (d: CiUsersWriteDeps) => deactivateCiUser(identity, "at", d),
      (d: CiUsersWriteDeps) => reactivateCiUser(identity, "at", d),
    ]) {
      const { d, calls } = deps([CM, AT], { editsEnabled: () => false });
      await expect(run(d)).rejects.toBeInstanceOf(DisabledError);
      expect(d.authorize).toHaveBeenCalled(); // an unauthorized caller is still refused first
      expect(calls).toEqual([]);
    }
    const { d } = deps([CM, AT], { editsEnabled: () => false, authorize: async () => { throw new ForbiddenError("no"); } });
    await expect(deactivateCiUser(identity, "at", d)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("Account Team scope on Add: All and specific values in any combination", () => {
  it("stores All as the text All and lists as JSON arrays, with Corporate Marketing fixed to All", async () => {
    const combos: Array<[unknown, unknown, unknown, [string, string, string]]> = [
      ["All", "All", "All", ["All", "All", "All"]],
      [["UMC"], "All", "All", ['["UMC"]', "All", "All"]],
      [["UMC"], ["Foundry"], "All", ['["UMC"]', '["Foundry"]', "All"]],
      [["UMC"], ["Foundry"], ["TWN"], ['["UMC"]', '["Foundry"]', '["TWN"]']],
    ];
    for (const [customers, segments, regions, [c, s, g]] of combos) {
      const { d } = deps([CM]);
      const res = await createCiUser(identity, { ...body, customers, segments, regions }, d);
      expect(res.user).toMatchObject({ customer: c, segment: s, region: g });
    }
  });

  it("refuses conflicting or invalid scopes: All mixed with values, an empty list, a bad shape, a text value", async () => {
    for (const bad of [{ customers: ["All", "UMC"] }, { customers: ["all"] }, { segments: [] }, { regions: "all" }, { regions: "KOR" }, { customers: [1] }, { segments: { x: 1 } }]) {
      const { d, calls } = deps([CM]);
      await expect(createCiUser(identity, { ...body, ...bad }, d), JSON.stringify(bad)).rejects.toBeInstanceOf(ValidationError);
      expect(calls).toEqual([]);
    }
  });

  it("checks selected values against the approved lists the server has (Served Market, Region), and not against a missing one", async () => {
    const withMasters = deps([CM], { masters: async () => ({ segments: ["Foundry", "Logic"], regions: ["KOR", "TWN"] }) });
    await expect(createCiUser(identity, { ...body, segments: ["Quantum"] }, withMasters.d)).rejects.toBeInstanceOf(ValidationError);
    await expect(createCiUser(identity, { ...body, regions: ["MARS"] }, withMasters.d)).rejects.toBeInstanceOf(ValidationError);
    expect(withMasters.calls).toEqual([]);
    const ok = await createCiUser(identity, { ...body, customers: ["Any Customer"], segments: ["Logic"], regions: ["KOR"] }, withMasters.d);
    expect(ok.user.segment).toBe('["Logic"]');
  });

  it("a duplicate email is refused case-insensitively", async () => {
    const { d } = deps([CM, AT]);
    await expect(createCiUser(identity, { ...body, email: "ANN@EXAMPLE.COM" }, d)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("updateCiUser", () => {
  const edit: Record<string, unknown> = { userName: "Ann Lee", email: "ann@example.com", role: "Account Team", customers: ["UMC", "TSMC"], segments: ["Foundry"], regions: ["TWN"] };

  it("updates name, role and scope on the same id and keeps the email and status", async () => {
    const { d, rows } = deps([CM, AT]);
    const res = await updateCiUser(identity, "at", edit, d);
    expect(res.user).toMatchObject({ id: "at", userName: "Ann Lee", customer: '["UMC","TSMC"]', email: "ann@example.com", isActive: true });
    expect(rows.filter((r) => r.id === "at")).toHaveLength(1);
  });

  it("refuses an email change, an unknown id, an invalid scope and a malformed id", async () => {
    const { d, calls } = deps([CM, AT]);
    await expect(updateCiUser(identity, "at", { ...edit, email: "other@example.com" }, d)).rejects.toBeInstanceOf(ValidationError);
    await expect(updateCiUser(identity, "nope", edit, d)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateCiUser(identity, "at", { ...edit, regions: [] }, d)).rejects.toBeInstanceOf(ValidationError);
    await expect(updateCiUser(identity, "a'; DROP TABLE t; --", edit, d)).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toEqual([]);
  });

  it("cannot change your own role, and cannot demote the last active Corporate Marketing user", async () => {
    const cmEdit = { userName: "Corp Marketing", email: "cm@example.com", role: "Account Team", customers: ["A"], segments: ["B"], regions: ["C"] };
    const own = deps([CM, CM2]);
    await expectValidation(updateCiUser(identity, "cm", cmEdit, own.d), /your own role/);
    const last = deps([CM, AT], { authorize: async () => ({ email: "other@example.com", userName: "Other" }) });
    await expectValidation(updateCiUser(identity, "cm", cmEdit, last.d), /At least one active Corporate Marketing/);
    expect(own.calls).toEqual([]);
    expect(last.calls).toEqual([]);
  });

  it("promoting an Account Team user to Corporate Marketing stores All / All / All", async () => {
    const { d } = deps([CM, AT]);
    const res = await updateCiUser(identity, "at", { ...edit, role: "Corporate Marketing" }, d);
    expect(res.user).toMatchObject({ role: "Corporate Marketing", customer: "All", segment: "All", region: "All" });
  });
});

describe("deactivate and reactivate (no physical delete)", () => {
  it("deactivation sets is_active false and status Off-boarded on the same row", async () => {
    const { d, rows } = deps([CM, AT]);
    const res = await deactivateCiUser(identity, "at", d);
    expect(res.user).toMatchObject({ id: "at", isActive: false, status: "Off-boarded" });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === "at")).toMatchObject({ isActive: false, status: "Off-boarded" });
  });

  it("refuses self-deactivation, the last Corporate Marketing user, an unknown id and a repeat", async () => {
    await expectValidation(deactivateCiUser(identity, "cm", deps([CM, CM2]).d), /your own account/);
    const other = { authorize: async () => ({ email: "other@example.com", userName: "Other" }) };
    await expectValidation(deactivateCiUser(identity, "cm", deps([CM, AT], other).d), /At least one active Corporate Marketing/);
    await expect(deactivateCiUser(identity, "nope", deps([CM, AT]).d)).rejects.toBeInstanceOf(NotFoundError);
    const off = rec({ id: "off", email: "off@example.com", isActive: false, status: "Off-boarded" });
    await expectValidation(deactivateCiUser(identity, "off", deps([CM, off]).d), /already deactivated/);
  });

  it("reactivation restores a deactivated user and refuses an active one", async () => {
    const off = rec({ id: "off", email: "off@example.com", isActive: false, status: "Off-boarded" });
    const { d } = deps([CM, off, AT]);
    expect((await reactivateCiUser(identity, "off", d)).user).toMatchObject({ isActive: true, status: "Active" });
    await expectValidation(reactivateCiUser(identity, "at", d), /already active/);
  });

  it("unauthorized callers cannot deactivate or reactivate", async () => {
    const { d, calls } = deps([CM, AT], { authorize: async () => { throw new ForbiddenError("no"); } });
    await expect(deactivateCiUser(identity, "at", d)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reactivateCiUser(identity, "at", d)).rejects.toBeInstanceOf(ForbiddenError);
    expect(calls).toEqual([]);
  });
});

describe("parseUserBody", () => {
  it("accepts the form shape and rejects anything else", () => {
    expect(parseUserBody(body)).toMatchObject({ userName: "New Person", customers: ["UMC"] });
    for (const bad of [{}, { ...body, regions: [1] }, { ...body, email: 5 }, undefined]) expect(() => parseUserBody(bad)).toThrow(ValidationError);
  });
});

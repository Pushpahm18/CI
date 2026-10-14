import { describe, expect, it, vi } from "vitest";
import { CiError, ConflictError, ForbiddenError, NotConfiguredError, ValidationError } from "@/server/ci/errors";
import { ACCESS_DUPLICATE_MESSAGE, ACCESS_SELECT_MESSAGE, addUserAccessEntry, listUserAccess, type UserAccessServiceDeps } from "@/server/ci/user-access/entries";
import type { UserAccessRow, UserAccessStore } from "@/server/ci/databricks/user-access";

// Fakes only: no database connection and no Microsoft Graph call.

const identity = { email: "cm@corp.example.com", name: "Verified Person" };
const NOW = "2026-10-14T10:00:00.000Z";

const row = (id: string, email: string, name = "", over: Partial<UserAccessRow> = {}): UserAccessRow => ({
  id, name, email, createdBy: "Verified Person", createdOn: "2026-10-13T09:00:00.000Z", modifiedBy: "Verified Person", modifiedOn: "2026-10-13T09:00:00.000Z", active: true, ...over,
});

function make(rows: UserAccessRow[] = [], over: Partial<UserAccessServiceDeps> = {}) {
  const added: { id: string; name: string; email: string; actor: string }[] = [];
  const store: UserAccessStore = {
    list: async () => rows,
    has: async () => true,
    newId: () => "new-id",
    now: () => NOW,
    add: vi.fn(async (r) => { added.push(r); return true; }),
  };
  const deps: UserAccessServiceDeps = {
    requireTables: vi.fn(),
    requireConnected: vi.fn(),
    authorize: vi.fn(async () => ({ email: "cm@corp.example.com", userName: "Verified Person" })),
    store: () => store,
    directoryUser: async (email, typed) => ({ email: email.trim().toLowerCase(), userName: typed.trim() }),
    audit: vi.fn(async () => {}),
    ...over,
  };
  return { deps, store, added };
}

describe("listUserAccess", () => {
  it("lists the people with the name and email stored on each row, and when and by whom they were added", async () => {
    const { deps } = make([row("a", "ann@corp.example.com", "Ann Lee", { modifiedOn: "" }), row("b", "bob@corp.example.com", "Bob Ray")]);
    const res = await listUserAccess(identity, deps);
    expect(res.entries.map((e) => [e.name, e.email, e.modifiedBy])).toEqual([
      ["Ann Lee", "ann@corp.example.com", "Verified Person"],
      ["Bob Ray", "bob@corp.example.com", "Verified Person"],
    ]);
    expect(res.entries[0].modifiedOn).toBe("2026-10-13T09:00:00.000Z"); // falls back to the created time
  });

  it("checks the tables and connection before authorizing, authorizes before reading, and hides database errors", async () => {
    const pending = make([], { requireTables: () => { throw new NotConfiguredError(["CI User Access"]); } });
    await expect(listUserAccess(identity, pending.deps)).rejects.toBeInstanceOf(NotConfiguredError);
    expect(pending.deps.authorize).not.toHaveBeenCalled();
    const denied = make([], { authorize: async () => { throw new ForbiddenError("no"); } });
    await expect(listUserAccess(identity, denied.deps)).rejects.toBeInstanceOf(ForbiddenError);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = make([], { store: () => ({ list: async () => { throw new Error("PERMISSION_DENIED dapiSECRET"); } }) as unknown as UserAccessStore });
    const err = (await listUserAccess(identity, broken.deps).catch((e) => e)) as CiError;
    expect(err).toBeInstanceOf(CiError);
    expect(err.message).not.toMatch(/PERMISSION|dapi/);
    spy.mockRestore();
  });
});

describe("addUserAccessEntry", () => {
  const body = { email: "New.Person@Corp.example.com", username: "New Person" };

  it("adds one person: audit entry first (who added whom), then the row with their name and email, attributed to the verified signed-in user", async () => {
    const { deps, store, added } = make();
    const res = await addUserAccessEntry(identity, body, deps);
    expect(res.entry).toMatchObject({ id: "new-id", email: "new.person@corp.example.com", name: "New Person", modifiedBy: "Verified Person" });
    expect(added).toEqual([{ id: "new-id", name: "New Person", email: "new.person@corp.example.com", actor: "Verified Person" }]);
    const [audit] = vi.mocked(deps.audit).mock.calls[0][0];
    expect(audit).toMatchObject({ entity: "User Access", recordId: "new-id", action: "Created", actionByName: "Verified Person", actionByEmail: "cm@corp.example.com", at: NOW });
    expect(audit.changes.map((c) => [c.label, c.previous, c.current])).toEqual([["User Name", "", "New Person"], ["User Email", "", "new.person@corp.example.com"]]);
    // the audit entry is written before the row
    expect(vi.mocked(deps.audit).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(store.add).mock.invocationCallOrder[0]);
  });

  it("saves the directory's own email and name, and ignores identity fields the browser sends", async () => {
    const { deps, added } = make([], { directoryUser: async () => ({ email: "dir@corp.example.com", userName: "Directory Person", aliases: ["dir@corp.example.com", "dir@corp.onmicrosoft.com"] }) });
    const res = await addUserAccessEntry(identity, { ...body, createdBy: "Someone Else", modifiedBy: "Someone Else", actor: "Someone Else" }, deps);
    expect(res.entry).toMatchObject({ email: "dir@corp.example.com", name: "Directory Person", modifiedBy: "Verified Person" });
    expect(added[0]).toMatchObject({ name: "Directory Person", actor: "Verified Person" });
    expect(JSON.stringify(vi.mocked(deps.audit).mock.calls)).not.toContain("Someone Else");
  });

  it("refuses a person already in the table with SAMBA's wording, writing nothing", async () => {
    const { deps, store } = make([row("x", "new.person@corp.example.com", "New Person")]);
    const err = (await addUserAccessEntry(identity, body, deps).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toBe(ACCESS_DUPLICATE_MESSAGE);
    expect(store.add).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("recognises the same person under their other address (mail vs UPN)", async () => {
    const both = async () => ({ email: "new.person@corp.example.com", userName: "New Person", aliases: ["new.person@corp.example.com", "new.person@corp.onmicrosoft.com"] });
    const { deps, store } = make([row("x", "new.person@corp.onmicrosoft.com", "New Person")], { directoryUser: both });
    await expect(addUserAccessEntry(identity, body, deps)).rejects.toThrow(ACCESS_DUPLICATE_MESSAGE);
    expect(store.add).not.toHaveBeenCalled();
  });

  it("an inactive row still counts as a duplicate (SAMBA has no active state)", async () => {
    const { deps } = make([row("x", "new.person@corp.example.com", "New Person", { active: false })]);
    await expect(addUserAccessEntry(identity, body, deps)).rejects.toBeInstanceOf(ConflictError);
  });

  it("reports a duplicate that appeared between the check and the save, after the audit entry", async () => {
    const { deps, store } = make();
    vi.mocked(store.add).mockResolvedValueOnce(false);
    await expect(addUserAccessEntry(identity, body, deps)).rejects.toThrow(ACCESS_DUPLICATE_MESSAGE);
  });

  it("needs a selected person, a valid email and sane lengths, and writes nothing otherwise", async () => {
    for (const bad of [null, "text", {}, { email: "a@b.com" }, { username: "A" }, { email: "  ", username: "A" }, { email: 5, username: "A" }]) {
      const { deps, store } = make();
      const err = (await addUserAccessEntry(identity, bad, deps).catch((e) => e)) as ValidationError;
      expect(err, JSON.stringify(bad)).toBeInstanceOf(ValidationError);
      expect(err.details).toEqual([ACCESS_SELECT_MESSAGE]);
      expect(store.add).not.toHaveBeenCalled();
    }
    const { deps } = make();
    await expect(addUserAccessEntry(identity, { email: "not-an-email", username: "A" }, deps)).rejects.toBeInstanceOf(ValidationError);
    await expect(addUserAccessEntry(identity, { email: "a@b.com", username: "x".repeat(201) }, deps)).rejects.toBeInstanceOf(ValidationError);
  });

  it("is refused before anything is read or written when the caller is not authorized or the tables are not ready", async () => {
    const a = make([], { authorize: async () => { throw new ForbiddenError("no"); } });
    await expect(addUserAccessEntry(identity, body, a.deps)).rejects.toBeInstanceOf(ForbiddenError);
    expect(a.deps.audit).not.toHaveBeenCalled();
    expect(a.store.add).not.toHaveBeenCalled();
    const b = make([], { requireTables: () => { throw new NotConfiguredError(["CI User Access"]); } });
    await expect(addUserAccessEntry(identity, body, b.deps)).rejects.toBeInstanceOf(NotConfiguredError);
    expect(b.deps.authorize).not.toHaveBeenCalled();
  });

  it("saves nothing when the audit entry cannot be written, and hides the reason", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, store } = make([], { audit: vi.fn(async () => { throw new Error("warehouse down dapiSECRET"); }) });
    const err = (await addUserAccessEntry(identity, body, deps).catch((e) => e)) as Error;
    expect(err.message).toContain("nothing was saved");
    expect(err.message).not.toMatch(/dapi|warehouse/);
    expect(store.add).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("refuses a person the directory cannot verify, writing nothing", async () => {
    const { deps, store } = make([], { directoryUser: async () => { throw new ValidationError(["That email is not in the Microsoft organization directory."]); } });
    await expect(addUserAccessEntry(identity, body, deps)).rejects.toBeInstanceOf(ValidationError);
    expect(deps.audit).not.toHaveBeenCalled();
    expect(store.add).not.toHaveBeenCalled();
  });
});

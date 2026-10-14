import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  AUTHORIZATION_PENDING_MESSAGE,
  CI_TABLE_AUTHORIZATION_APPROVED,
  authorizeCiUser,
  actorNameFor,
  authorizeCorporateMarketing,
  decideCiAccess,
  type CiAccessDeps,
} from "@/server/ci/authorization/ci-access";
import { ForbiddenError } from "@/server/ci/errors";
import { WriteRefusedError } from "@/server/db/write-guard";
import type { CiUserRecordRaw } from "@/types/ci-api";

// Fakes only: no database connection is opened.

const rec = (over: Partial<CiUserRecordRaw> = {}): CiUserRecordRaw => ({
  id: "t1", userName: "Test Person", email: "test@example.com", role: "Corporate Marketing",
  customer: "All", segment: "All", region: "All", status: "Active", lastSignIn: "", isActive: true, ...over,
});
const identity = { email: "Test@Example.com", name: "Test" };

describe("decideCiAccess (strict, fail closed)", () => {
  it("allows exactly one active, well-formed record for the email (case-insensitive)", () => {
    const d = decideCiAccess([rec()], "TEST@example.com ");
    expect(d).toMatchObject({ allowed: true, role: "Corporate Marketing", email: "test@example.com" });
    expect(decideCiAccess([rec({ role: "Account Team", customer: '["UMC"]', segment: '["Foundry"]', region: '["TWN"]', status: " active " })], "test@example.com")).toMatchObject({
      allowed: true,
      role: "Account Team",
      scope: { customers: ["UMC"], segments: ["Foundry"], regions: ["TWN"] },
    });
    expect(d).toMatchObject({ scope: null });
  });

  it("denies when there is no record, an empty table, or no email", () => {
    expect(decideCiAccess([], "test@example.com").allowed).toBe(false);
    expect(decideCiAccess([rec({ email: "other@example.com" })], "test@example.com").allowed).toBe(false);
    expect(decideCiAccess([rec()], "  ").allowed).toBe(false);
  });

  it("denies a NULL or inactive flag, several active rows, a conflicting status and unknown roles", () => {
    for (const row of [
      rec({ isActive: null }),
      rec({ isActive: false }),
      rec({ status: "Disabled" }),
      rec({ status: "Off-boarded" }),
      rec({ status: "" }),
      rec({ role: "Admin" }),
      rec({ role: "Sales" }),
      rec({ role: "corporate marketing" }),
      rec({ role: "" }),
    ]) expect(decideCiAccess([row], "test@example.com").allowed, JSON.stringify(row)).toBe(false);
    expect(decideCiAccess([rec({ id: "a" }), rec({ id: "b" })], "test@example.com").allowed).toBe(false);
    expect(decideCiAccess([rec(), rec({ id: "b", isActive: null })], "test@example.com").allowed).toBe(false);
  });

  it("Account Team needs three valid scopes (All or a JSON array); a missing, comma-list, malformed or mixed dimension denies", () => {
    const ok = { role: "Account Team", customer: '["UMC"]', segment: '["Foundry"]', region: '["TWN"]' };
    expect(decideCiAccess([rec(ok)], "test@example.com").allowed).toBe(true);
    for (const key of ["customer", "segment", "region"] as const) {
      for (const bad of ["", "all", "UMC,TSMC", "[oops", "[]", '["All"]', '["All","UMC"]', '["UMC","UMC"]']) {
        expect(decideCiAccess([rec({ ...ok, [key]: bad })], "test@example.com").allowed, key + ":" + bad).toBe(false);
      }
    }
  });

  it("Corporate Marketing is not scoped, whatever its scope columns hold", () => {
    const d = decideCiAccess([rec({ customer: '["X"]', segment: "", region: "junk" })], "test@example.com");
    expect(d).toMatchObject({ allowed: true, role: "Corporate Marketing", scope: null });
  });

  it("Account Team may be given All for any dimension, in any combination", () => {
    const at = { role: "Account Team" };
    for (const [customer, segment, region] of [
      ["All", "All", "All"],
      ['["UMC"]', "All", "All"],
      ['["UMC"]', '["Foundry"]', "All"],
      ['["UMC"]', '["Foundry"]', '["TWN"]'],
      ["All", "All", '["TWN"]'],
    ]) {
      expect(decideCiAccess([rec({ ...at, customer, segment, region })], "test@example.com").allowed, [customer, segment, region].join("|")).toBe(true);
    }
    expect(decideCiAccess([rec({ ...at, customer: "All", segment: "All", region: "All" })], "test@example.com")).toMatchObject({ role: "Account Team", scope: { customers: "All", segments: "All", regions: "All" } });
  });

  it("an All scope never grants access by itself", () => {
    expect(decideCiAccess([rec({ role: "Account Team", isActive: false })], "test@example.com").allowed).toBe(false);
    expect(decideCiAccess([rec({ role: "", customer: "All", segment: "All", region: "All" })], "test@example.com").allowed).toBe(false);
  });
});

describe("authorizeCiUser", () => {
  const make = (records: CiUserRecordRaw[], hasEntry = true): CiAccessDeps => ({ approved: () => true, requireTables: vi.fn(), requireConnected: vi.fn(), listRecords: async () => records, hasAccessEntry: async () => hasEntry });

  it("returns role and validated scope for Account Team and no scope for Corporate Marketing", async () => {
    expect(await authorizeCiUser(identity, make([rec({ role: "Account Team", customer: '["UMC"]', segment: '["Foundry"]', region: '["TWN"]' })]))).toMatchObject({ role: "Account Team", scope: { customers: ["UMC"], segments: ["Foundry"], regions: ["TWN"] } });
    expect(await authorizeCiUser(identity, make([rec()]))).toMatchObject({ role: "Corporate Marketing", scope: null });
  });

  it("an Account Team person needs a User Access row as well; Corporate Marketing does not", async () => {
    const at = rec({ role: "Account Team", customer: '["UMC"]', segment: '["Foundry"]', region: '["TWN"]' });
    await expect(authorizeCiUser(identity, make([at], false))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await authorizeCiUser(identity, make([at], true))).toMatchObject({ role: "Account Team" });
    const hasAccessEntry = vi.fn(async () => false);
    expect(await authorizeCiUser(identity, { ...make([rec()]), hasAccessEntry })).toMatchObject({ role: "Corporate Marketing" });
    expect(hasAccessEntry).not.toHaveBeenCalled();
  });

  it("looks the row up by the verified session email, and a failed lookup denies instead of letting the person in", async () => {
    const at = rec({ role: "Account Team", customer: '["UMC"]', segment: '["Foundry"]', region: '["TWN"]' });
    const hasAccessEntry = vi.fn(async () => true);
    await authorizeCiUser(identity, { ...make([at]), hasAccessEntry });
    expect(hasAccessEntry).toHaveBeenCalledWith("test@example.com");
    await expect(authorizeCiUser(identity, { ...make([at]), hasAccessEntry: async () => { throw new Error("warehouse down"); } })).rejects.toThrow("warehouse down");
  });

  it("refuses when there is no valid record, or the Account Team scope is invalid", async () => {
    await expect(authorizeCiUser(identity, make([]))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(authorizeCiUser(identity, make([rec({ role: "Account Team", customer: "UMC,TSMC" })]))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("authorizeCorporateMarketing", () => {
  const make = (over: Partial<CiAccessDeps> = {}) => {
    const deps: CiAccessDeps = { approved: () => true, requireTables: vi.fn(), requireConnected: vi.fn(), listRecords: vi.fn(async () => [rec()]), hasAccessEntry: async () => true, ...over };
    return deps;
  };

  it("is approved in the shipped code, and still fails closed when no user record exists", async () => {
    expect(CI_TABLE_AUTHORIZATION_APPROVED).toBe(true);
    const empty = make({ listRecords: async () => [] });
    await expect(authorizeCorporateMarketing(identity, empty)).rejects.toThrow("Corporate Marketing access is required.");
  });

  it("only a verified Corporate Marketing record passes", async () => {
    // Created By / Modified By is the signed-in person's own (verified) display name, not the name typed on their record.
    expect(await authorizeCorporateMarketing(identity, make())).toEqual({ email: "test@example.com", userName: "Test" });
    await expect(authorizeCorporateMarketing(identity, make({ listRecords: async () => [rec({ role: "Account Team", customer: '["UMC"]', segment: '["Foundry"]', region: '["TWN"]' })] }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(authorizeCorporateMarketing(identity, make({ listRecords: async () => [] }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("falls back to the record's name only when the session has no real name (Auth.js uses the email)", async () => {
    const noName = { email: "Test@Example.com", name: "Test@Example.com" };
    expect(await authorizeCorporateMarketing(noName, make())).toEqual({ email: "test@example.com", userName: "Test Person" });
    expect(await authorizeCorporateMarketing({ email: "test@example.com", name: "  " }, make())).toEqual({ email: "test@example.com", userName: "Test Person" });
    expect(actorNameFor({ email: "a@b.com", name: "Ann Lee" }, "Record Name")).toBe("Ann Lee");
  });

  it("the local dev login gets nothing: it has no record, so it is refused even when switched on", async () => {
    const dev = { email: "dev.user@localhost", name: "Local Dev User" };
    await expect(authorizeCorporateMarketing(dev, make())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the master switch, when turned off, stops before tables, connection or records are touched", async () => {
    const deps = make({ approved: () => false });
    await expect(authorizeCorporateMarketing(identity, deps)).rejects.toThrow(AUTHORIZATION_PENDING_MESSAGE);
    expect(deps.requireTables).not.toHaveBeenCalled();
    expect(deps.listRecords).not.toHaveBeenCalled();
  });
});

describe("no SAMBA authorization and no SAMBA writes from CI", () => {
  it("executeStatement refuses a SAMBA write before contacting Databricks", async () => {
    const { executeStatement } = await import("@/server/db/warehouse");
    await expect(executeStatement("MERGE INTO `corp_marketing_dev`.`samba`.`samba_usermanagement` AS t USING (SELECT 1) AS s ON 1=1")).rejects.toBeInstanceOf(WriteRefusedError);
    await expect(executeStatement("DELETE FROM `corp_marketing_dev`.`samba`.`samba_user`")).rejects.toBeInstanceOf(WriteRefusedError);
  });

  it("the non-login screens authorize through the CI authorizer, not SAMBA or a bypass", () => {
    const files = [
      "src/server/ci/form-options/service.ts",
      "src/server/ci/lookups/service.ts",
    ];
    // User Management (list and Add User) uses the same check plus the development-only rule in dev-access.ts.
    for (const f of ["src/server/ci/user-management/ci-users.ts", "src/server/ci/user-management/ci-users-write.ts"]) {
      const text = readFileSync(f, "utf8");
      expect(text, f).toContain("authorizeUserManagement");
      expect(text, f).not.toMatch(/authorizeUserAccessManager|samba_|isDevMockAuthEnabled|NODE_ENV/);
    }
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, f).toContain("authorizeCorporateMarketing");
      expect(text, f).not.toContain("authorizeUserAccessManager");
      expect(text, f).not.toMatch(/samba_usermanagement|requireCorporateMarketingActor/);
    }
    // The Microsoft directory list belongs to Add User, so it follows User Management's rule (dev-access.ts), never a SAMBA check.
    const directory = readFileSync("src/server/ci/user-access/service.ts", "utf8");
    expect(directory).toContain("authorizeUserManagement");
    expect(directory).not.toMatch(/authorizeUserAccessManager|samba_|requireCorporateMarketingActor/);
    const gallery = readFileSync("src/server/ci/competitive-gallery/service.ts", "utf8");
    expect(gallery).toContain("authorizeCiUser");
    expect(gallery).not.toMatch(/authorizeUserAccessManager|samba_|isDevMockAuthEnabled/);
    const auth = readFileSync("src/server/ci/authorization/ci-access.ts", "utf8");
    expect(auth).not.toMatch(/isDevMockAuthEnabled|NODE_ENV|samba_/);
  });
});

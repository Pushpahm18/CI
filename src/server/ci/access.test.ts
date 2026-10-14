import { describe, expect, it, vi } from "vitest";
import { resolveCiAccess, roleMayOpenPage, CM_ONLY_PAGES, type AccessCheckDeps } from "@/server/ci/access";
import type { CiUserRecordRaw } from "@/types/ci-api";

// Fakes only: no database connection is opened.

const rec = (over: Partial<CiUserRecordRaw> = {}): CiUserRecordRaw => ({
  id: "t", userName: "T", email: "t@example.com", role: "Corporate Marketing", customer: "All", segment: "All", region: "All",
  status: "Active", lastSignIn: "", isActive: true, ...over,
});
const deps = (records: CiUserRecordRaw[], approved = true, hasEntry = true): AccessCheckDeps => ({ approved: () => approved, listRecords: async () => records, hasAccessEntry: async () => hasEntry });

describe("page-level gate (resolveCiAccess) fails closed", () => {
  it("authorizes only a valid active record, and returns its role", async () => {
    expect(await resolveCiAccess("T@example.com", deps([rec()]))).toMatchObject({ status: "authorized", role: "Corporate Marketing", user: { role: "CM", customerScope: "All" } });
    const at = await resolveCiAccess("t@example.com", deps([rec({ role: "Account Team", customer: '["UMC"]', segment: '["Foundry"]', region: '["TWN"]' })]));
    expect(at).toMatchObject({ status: "authorized", role: "Account Team", user: { role: "Sales", customerScope: ["UMC"], segmentScope: ["Foundry"], regionScope: ["TWN"] } });
  });

  it("an Account Team user with All for some or every dimension is authorized, with exactly that scope", async () => {
    const r = await resolveCiAccess("t@example.com", deps([rec({ role: "Account Team", customer: '["UMC"]', segment: "All", region: "All" })]));
    expect(r).toMatchObject({ status: "authorized", user: { role: "Sales", customerScope: ["UMC"], segmentScope: "All", regionScope: "All" } });
  });

  it("denies a signed-in person when the user table is empty, has no row for them, or the row is unusable", async () => {
    for (const records of [[], [rec({ email: "other@example.com" })], [rec({ isActive: false })], [rec({ isActive: null })], [rec({ status: "Off-boarded" })], [rec({ role: "Admin" })], [rec(), rec({ id: "2" })], [rec({ role: "Account Team", customer: "oops" })], [rec({ role: "Account Team", customer: '["A"]', segment: "all", region: '["B"]' })]]) {
      expect(await resolveCiAccess("t@example.com", deps(records))).toEqual({ status: "denied" });
    }
  });

  it("denies when the master switch is off, and never swallows a failed check", async () => {
    expect(await resolveCiAccess("t@example.com", deps([rec()], false))).toEqual({ status: "denied" });
    const failing: AccessCheckDeps = { approved: () => true, listRecords: async () => { throw new Error("warehouse down"); }, hasAccessEntry: async () => true };
    await expect(resolveCiAccess("t@example.com", failing)).rejects.toThrow("warehouse down");
  });
});

describe("local development: no exemption, mock records only", () => {
  const OLD = { ...process.env };
  const restore = () => { vi.unstubAllEnvs(); process.env = { ...OLD }; };

  it("with the dev login on, the dev login is judged by the same rule over MOCK records, never by Databricks", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_MOCK_AUTH", "true");
    vi.stubEnv("DEV_MOCK_AUTH_EMAIL", "");
    const dev = await resolveCiAccess("dev.user@localhost");
    expect(dev).toMatchObject({ status: "authorized", role: "Corporate Marketing", user: { id: "MOCK-DEV" } });
    vi.stubEnv("DEV_MOCK_AUTH_EMAIL", "mock.at1@mock.invalid");
    expect(await resolveCiAccess("mock.at1@mock.invalid")).toMatchObject({ status: "authorized", role: "Account Team", user: { id: "MOCK-2" } });
    // mock users with problems are denied by the same rule
    for (const e of ["mock.inactive@mock.invalid", "mock.null@mock.invalid", "mock.dup@mock.invalid"]) {
      vi.stubEnv("DEV_MOCK_AUTH_EMAIL", e);
      expect(await resolveCiAccess(e), e).toEqual({ status: "denied" });
    }
    restore();
  });

  it("without the dev login, an unknown person is denied: the mock records are never consulted", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEV_MOCK_AUTH", "true");
    vi.stubEnv("DATABRICKS_HOST", "");
    expect(await resolveCiAccess("dev.user@localhost")).toEqual({ status: "denied" });
    expect(await resolveCiAccess("mock.cm@mock.invalid")).toEqual({ status: "denied" });
    restore();
  });

  it("the dev login gets no real data: the API authorizers read the real table only", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_MOCK_AUTH", "true");
    vi.stubEnv("DATABRICKS_HOST", "");
    const { authorizeCiUser } = await import("@/server/ci/authorization/ci-access");
    await expect(authorizeCiUser({ email: "dev.user@localhost", name: "Local Dev User" })).rejects.toThrow();
    await expect(authorizeCiUser({ email: "mock.cm@mock.invalid", name: "x" })).rejects.toThrow();
    restore();
  });
});

describe("page-level gate: the User Access step (SAMBA's two-step gate)", () => {
  const accountTeam = rec({ role: "Account Team", customer: '["UMC"]', segment: '["Foundry"]', region: '["TWN"]' });

  it("an Account Team person without a User Access row is denied, with one they are authorized", async () => {
    expect(await resolveCiAccess("t@example.com", deps([accountTeam], true, false))).toEqual({ status: "denied" });
    expect((await resolveCiAccess("t@example.com", deps([accountTeam], true, true))).status).toBe("authorized");
  });

  it("Corporate Marketing is exempt: it is authorized without a row, and the row is never even looked up", async () => {
    const hasAccessEntry = vi.fn(async () => false);
    const result = await resolveCiAccess("t@example.com", { approved: () => true, listRecords: async () => [rec()], hasAccessEntry });
    expect(result.status).toBe("authorized");
    expect(hasAccessEntry).not.toHaveBeenCalled();
  });

  it("an invalid record is denied before the row is looked up, and a failed lookup of the row is not swallowed", async () => {
    const hasAccessEntry = vi.fn(async () => true);
    expect(await resolveCiAccess("t@example.com", { approved: () => true, listRecords: async () => [rec({ role: "Admin" })], hasAccessEntry })).toEqual({ status: "denied" });
    expect(hasAccessEntry).not.toHaveBeenCalled();
    const failing: AccessCheckDeps = { approved: () => true, listRecords: async () => [accountTeam], hasAccessEntry: async () => { throw new Error("warehouse down"); } };
    await expect(resolveCiAccess("t@example.com", failing)).rejects.toThrow("warehouse down");
  });
});

describe("role-based page access", () => {
  it("Corporate Marketing may open every page", () => {
    for (const p of ["/", "/competitive-info", ...CM_ONLY_PAGES]) expect(roleMayOpenPage("Corporate Marketing", p)).toBe(true);
  });

  it("Account Team may open Home and All Competitive Info View, and none of the administrative pages (including sub-paths)", () => {
    expect(roleMayOpenPage("Account Team", "/")).toBe(true);
    expect(roleMayOpenPage("Account Team", "/competitive-info")).toBe(true);
    for (const p of ["/user-management", "/user-access", "/lookups", "/sequential-lookup", "/import", "/competitive-ff", "/admin", "/admin/users", "/lookups/x"]) {
      expect(roleMayOpenPage("Account Team", p), p).toBe(false);
    }
  });
});

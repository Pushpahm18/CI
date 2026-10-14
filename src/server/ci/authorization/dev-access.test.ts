import { afterEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, NotConfiguredError } from "@/server/ci/errors";
import { authorizeCorporateMarketing, type CiAccessDeps } from "@/server/ci/authorization/ci-access";
import { authorizeUserManagement } from "@/server/ci/authorization/dev-access";
import { loadCiUserRecords, type CiUsersServiceDeps } from "@/server/ci/user-management/ci-users";
import { createCiUser, deactivateCiUser, updateCiUser, type CiUsersWriteDeps } from "@/server/ci/user-management/ci-users-write";
import type { UserRecordWriter } from "@/server/ci/databricks/user-records";
import type { CiUserRecordRaw } from "@/types/ci-api";

// Fakes only: no database connection is opened.

const devLogin = { email: "Dev.User@Localhost", name: "Local Dev User" };
const denyAll = async () => {
  throw new ForbiddenError("Corporate Marketing access is required.");
};
const rec = (over: Partial<CiUserRecordRaw>): CiUserRecordRaw => ({
  id: "x", userName: "X", email: "x@example.com", role: "Account Team", customer: "All", segment: "All", region: "All",
  status: "Active", lastSignIn: "", isActive: true, ...over,
});

afterEach(() => vi.unstubAllEnvs());

describe("authorizeUserManagement: normal Corporate Marketing check, plus a development-only rule", () => {
  it("a real Corporate Marketing user passes by the normal check, never touching the development rule", async () => {
    const dev = vi.fn(() => true);
    const out = await authorizeUserManagement(devLogin, async () => ({ email: "cm@example.com", userName: "CM" }), dev);
    expect(out).toEqual({ email: "cm@example.com", userName: "CM" });
    expect(dev).not.toHaveBeenCalled();
  });

  it("in a development build with the dev login on, a caller the normal check refuses is allowed (User Management only)", async () => {
    const out = await authorizeUserManagement(devLogin, denyAll, () => true);
    expect(out).toEqual({ email: "dev.user@localhost", userName: "Local Dev User" });
  });

  it("never applies outside the dev login: production, test and flag-off builds are refused exactly as before", async () => {
    for (const [NODE_ENV, DEV_MOCK_AUTH] of [["production", "true"], ["production", "false"], ["test", "true"], ["development", "false"], ["development", ""], [undefined, "true"]] as const) {
      vi.stubEnv("NODE_ENV", NODE_ENV as string);
      vi.stubEnv("DEV_MOCK_AUTH", DEV_MOCK_AUTH);
      await expect(authorizeUserManagement(devLogin, denyAll), `${NODE_ENV}/${DEV_MOCK_AUTH}`).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("uses the real environment switch: development + DEV_MOCK_AUTH=true allows, production + DEV_MOCK_AUTH=true refuses", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_MOCK_AUTH", "true");
    await expect(authorizeUserManagement(devLogin, denyAll)).resolves.toMatchObject({ email: "dev.user@localhost" });
    vi.stubEnv("NODE_ENV", "production");
    await expect(authorizeUserManagement(devLogin, denyAll)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("only turns a refusal into access; other failures (table pending, database down) still stop the request", async () => {
    const pending = async () => {
      throw new NotConfiguredError(["CI User Management"]);
    };
    await expect(authorizeUserManagement(devLogin, pending, () => true)).rejects.toBeInstanceOf(NotConfiguredError);
  });
});

describe("the development rule does not widen anything else", () => {
  it("the normal Corporate Marketing authorizer, used by every other screen, still refuses the dev login even in a development build", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_MOCK_AUTH", "true");
    const deps: CiAccessDeps = { approved: () => true, requireTables: vi.fn(), requireConnected: vi.fn(), listRecords: async () => [], hasAccessEntry: async () => true };
    await expect(authorizeCorporateMarketing({ email: "dev.user@localhost", name: "Dev" }, deps)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Edit / Deactivate honour the switch for the dev login too (refused when it is off)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_MOCK_AUTH", "true");
    const writer = { list: async () => [rec({ id: "u1" })], update: vi.fn(), setActive: vi.fn() } as unknown as UserRecordWriter;
    const deps: CiUsersWriteDeps = {
      editsEnabled: () => false, masters: async () => ({}), requireTables: vi.fn(), requireConnected: vi.fn(),
      authorize: (i) => authorizeUserManagement(i, denyAll), directoryUser: async (email, name) => ({ email: email.trim().toLowerCase(), userName: name.trim() }), writer: () => writer, audit: async () => {},
    };
    await expect(deactivateCiUser(devLogin, "u1", deps)).rejects.toThrow(/switched off/);
    await expect(updateCiUser(devLogin, "u1", { userName: "A", email: "x@example.com", role: "Account Team", customers: "All", segments: "All", regions: "All" }, deps)).rejects.toThrow(/switched off/);
    expect(writer.update).not.toHaveBeenCalled();
    expect(writer.setActive).not.toHaveBeenCalled();
  });
});

describe("Add User saves directly, and only reports success once the database confirms the row", () => {
  const body = { userName: "Local Dev User", email: "dev.user@localhost", role: "Corporate Marketing", customers: "All", segments: "All", regions: "All" };

  function wire(opts: { landed?: boolean } = {}) {
    const rows: CiUserRecordRaw[] = [];
    const writer: UserRecordWriter = {
      list: async () => rows.map((r) => ({ ...r })),
      newId: () => "new-id",
      now: () => "2026-10-12T09:00:00.000Z",
      // the real writer re-reads after the MERGE and returns whether the row is there; this fake can simulate "the database did not take it"
      insert: vi.fn(async (r) => {
        if (opts.landed === false) return false;
        rows.push(rec({ id: r.id, userName: r.userName, email: r.email, role: r.role, customer: r.customer, segment: r.segment, region: r.region }));
        return true;
      }),
      update: vi.fn(),
      setActive: vi.fn(),
    };
    const deps: CiUsersWriteDeps = {
      editsEnabled: () => false, masters: async () => ({}), requireTables: vi.fn(), requireConnected: vi.fn(),
      authorize: (i) => authorizeUserManagement(i, denyAll), directoryUser: async (email, name) => ({ email: email.trim().toLowerCase(), userName: name.trim() }), writer: () => writer, audit: async () => {},
    };
    return { deps, rows, writer };
  }

  it("in development, the dev login saves the entered record and the row is in the table", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_MOCK_AUTH", "true");
    const { deps, rows } = wire();
    const res = await createCiUser(devLogin, body, deps);
    expect(res.user).toMatchObject({ email: "dev.user@localhost", role: "Corporate Marketing", customer: "All", segment: "All", region: "All", status: "Active", isActive: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "dev.user@localhost", role: "Corporate Marketing" });
  });

  it("in production (or without the dev login) the same request is refused and nothing is written", async () => {
    for (const env of [{ NODE_ENV: "production", DEV_MOCK_AUTH: "true" }, { NODE_ENV: "development", DEV_MOCK_AUTH: "false" }, { NODE_ENV: "test", DEV_MOCK_AUTH: "true" }]) {
      vi.stubEnv("NODE_ENV", env.NODE_ENV);
      vi.stubEnv("DEV_MOCK_AUTH", env.DEV_MOCK_AUTH);
      const { deps, writer } = wire();
      await expect(createCiUser(devLogin, body, deps), JSON.stringify(env)).rejects.toBeInstanceOf(ForbiddenError);
      expect(writer.insert).not.toHaveBeenCalled();
    }
  });

  it("does NOT report success when the database did not confirm the row", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_MOCK_AUTH", "true");
    const { deps, rows } = wire({ landed: false });
    await expect(createCiUser(devLogin, body, deps)).rejects.toThrow(/already has a CI user record/);
    expect(rows).toEqual([]);
  });

  it("a database failure is an error, never a fake success", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_MOCK_AUTH", "true");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, writer } = wire();
    writer.insert = async () => {
      throw new Error("PERMISSION_DENIED dapiSECRET");
    };
    const err = (await createCiUser(devLogin, body, deps).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toMatch(/PERMISSION|dapi/);
    spy.mockRestore();
  });

  it("the user list uses the same rule, so the saved record can be shown", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_MOCK_AUTH", "true");
    const deps: CiUsersServiceDeps = { requireTables: vi.fn(), requireConnected: vi.fn(), authorize: (i) => authorizeUserManagement(i, denyAll), list: async () => [rec({ id: "u1" })] };
    expect((await loadCiUserRecords(devLogin, deps)).users).toHaveLength(1);
    vi.stubEnv("NODE_ENV", "production");
    await expect(loadCiUserRecords(devLogin, deps)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

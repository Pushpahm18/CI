import { afterEach, describe, expect, it, vi } from "vitest";
import { isDevMockAuthEnabled } from "@/server/dev-auth";
import { CiError, ForbiddenError } from "@/server/ci/errors";
import { authorizeUserAccessManager, devAccessEnabled, type AccessDeps } from "@/server/ci/user-access/access";
import { listDirectory, type UserAccessDeps } from "@/server/ci/user-access/service";

// Isolated tests only. Nothing here opens a Databricks connection or calls Microsoft
// Graph: the directory and authorization are replaced by in-memory fakes.

const identity = { email: "admin@example.com", name: "Admin Person" };

afterEach(() => vi.unstubAllEnvs());

function makeDeps(over: Partial<UserAccessDeps> = {}) {
  const authorize = vi.fn(async () => ({ email: "admin@example.com", userName: "Admin Person" }));
  const deps: UserAccessDeps = {
    authorize,
    devAccess: () => false,
    directoryConfigured: () => true,
    directory: vi.fn(async () => [{ id: "1", displayName: "Ann Lee", userPrincipalName: "ann@example.com", mail: "", email: "ann@example.com" }]),
    ...over,
  };
  return { deps, authorize };
}

describe("listDirectory (fake directory)", () => {
  it("reports 'not configured' honestly instead of returning users", async () => {
    const { deps } = makeDeps({ directoryConfigured: () => false, devAccess: () => false });
    expect(await listDirectory(identity, deps)).toEqual({ users: [], configured: false, manualEntryAllowed: false });
  });

  it("offers manual entry only in local development while directory search is unconfigured", async () => {
    const { deps } = makeDeps({ directoryConfigured: () => false, devAccess: () => true });
    expect(await listDirectory(identity, deps)).toEqual({ users: [], configured: false, manualEntryAllowed: true });
  });

  it("returns the directory users when configured, without manual entry", async () => {
    const { deps } = makeDeps({ devAccess: () => true });
    expect(await listDirectory(identity, deps)).toEqual({
      users: [{ id: "1", displayName: "Ann Lee", userPrincipalName: "ann@example.com", mail: "", email: "ann@example.com" }],
      configured: true,
      manualEntryAllowed: false,
    });
  });

  it("hides a directory failure's details behind a generic message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = makeDeps({
      directory: vi.fn(async () => {
        throw new Error("Unable to reach Microsoft Graph. secret-detail");
      }),
    });
    const error = await listDirectory(identity, deps).catch((e) => e);
    expect(error).toBeInstanceOf(CiError);
    expect((error as CiError).message).toBe("Unable to load organization users. Please try again.");
    spy.mockRestore();
  });

  it("explains a missing Graph permission (403) so an administrator knows what to grant", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = makeDeps({
      directory: vi.fn(async () => {
        throw new Error("Microsoft Graph user list failed (403).");
      }),
    });
    const error = (await listDirectory(identity, deps).catch((e) => e)) as CiError;
    expect(error).toBeInstanceOf(CiError);
    expect(error.message).toContain("User.Read.All");
    expect(error.message).toContain("admin consent");
    spy.mockRestore();
  });

  it("in local development only, a failed directory still allows typing a name and email, with the reason shown", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.fn(async () => {
      throw new Error("Microsoft Graph user list failed (403).");
    });
    const dev = makeDeps({ directory: failing, devAccess: () => true }).deps;
    const res = await listDirectory(identity, dev);
    expect(res).toMatchObject({ users: [], configured: true, manualEntryAllowed: true });
    expect(res.unavailable).toContain("User.Read.All");
    const prod = makeDeps({ directory: failing, devAccess: () => false }).deps;
    await expect(listDirectory(identity, prod)).rejects.toBeInstanceOf(CiError);
    spy.mockRestore();
  });

  it("refuses an unauthorized caller", async () => {
    const { deps } = makeDeps({
      authorize: vi.fn(async () => {
        throw new ForbiddenError();
      }),
    });
    await expect(listDirectory(identity, deps)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("authorization", () => {
  const accessDeps = (over: Partial<AccessDeps> = {}) => {
    const requireConnected = vi.fn();
    const requireCorporateMarketing = vi.fn(async () => ({ email: "cm@example.com", userName: "CM Person" }));
    const deps: AccessDeps = { devAccess: () => false, requireConnected, requireCorporateMarketing, ...over };
    return { deps, requireConnected, requireCorporateMarketing };
  };

  it("outside local development it requires a verified Corporate Marketing user", async () => {
    const { deps, requireConnected, requireCorporateMarketing } = accessDeps();
    expect(await authorizeUserAccessManager(identity, deps)).toEqual({ email: "cm@example.com", userName: "CM Person" });
    expect(requireConnected).toHaveBeenCalledTimes(1);
    expect(requireCorporateMarketing).toHaveBeenCalledWith(identity);
  });

  it("a non-Corporate-Marketing user is refused", async () => {
    const { deps } = accessDeps({
      requireCorporateMarketing: vi.fn(async () => {
        throw new ForbiddenError("Corporate Marketing access is required.");
      }),
    });
    await expect(authorizeUserAccessManager(identity, deps)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("local development with the dev login skips the check and records the signed-in name", async () => {
    const { deps, requireConnected, requireCorporateMarketing } = accessDeps({ devAccess: () => true });
    expect(await authorizeUserAccessManager({ email: "Dev.User@Localhost", name: "Local Dev User" }, deps)).toEqual({
      email: "dev.user@localhost",
      userName: "Local Dev User",
    });
    expect(requireConnected).not.toHaveBeenCalled();
    expect(requireCorporateMarketing).not.toHaveBeenCalled();
    expect(devAccessEnabled(deps)).toBe(true);
  });

  it("the bypass is on only for `next dev` with DEV_MOCK_AUTH=true — never in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEV_MOCK_AUTH", "true");
    expect(isDevMockAuthEnabled()).toBe(false);
    vi.stubEnv("NODE_ENV", "test");
    expect(isDevMockAuthEnabled()).toBe(false);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_MOCK_AUTH", "false");
    expect(isDevMockAuthEnabled()).toBe(false);
    vi.stubEnv("DEV_MOCK_AUTH", "");
    expect(isDevMockAuthEnabled()).toBe(false);
    vi.stubEnv("DEV_MOCK_AUTH", "true");
    expect(isDevMockAuthEnabled()).toBe(true);
  });
});

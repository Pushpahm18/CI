import type { SessionIdentity } from "@/server/ci/current-user";
import { CiError } from "@/server/ci/errors";
import { authorizeUserManagement } from "@/server/ci/authorization/dev-access";
import type { UserAccessActor } from "@/server/ci/user-access/access";
import { isDirectoryConfigured, listDirectoryUsers, DirectoryConfigError } from "@/server/ci/user-access/directory";
import { describeDirectoryFailure } from "@/server/ci/user-access/resolve";
import { isDevMockAuthEnabled } from "@/server/dev-auth";
import type { DirectoryUser, DirectoryUsersResponse } from "@/types/ci-api";

/**
 * The Microsoft Entra ID directory the Add User picker searches (server/ci/user-access/directory.ts).
 * READ-ONLY: it never touches Databricks and never writes anything. The caller must be a
 * verified Corporate Marketing user (the CI User Management record decides, fail closed), with the
 * same development-login allowance User Management itself has (authorization/dev-access.ts), which
 * can never apply in production.
 *
 * The dependencies (authorization, directory) are injectable so the flow can be unit-tested
 * against fakes; the defaults are the real, server-only implementations.
 */

export interface UserAccessDeps {
  authorize(identity: SessionIdentity): Promise<UserAccessActor>;
  devAccess(): boolean;
  directoryConfigured(): boolean;
  directory(): Promise<DirectoryUser[]>;
}

const defaultDeps: UserAccessDeps = {
  authorize: (identity) => authorizeUserManagement(identity),
  devAccess: isDevMockAuthEnabled,
  directoryConfigured: () => isDirectoryConfigured(),
  directory: listDirectoryUsers,
};

/** The directory the picker searches. Read-only; never returns users it did not get from Entra. */
export async function listDirectory(identity: SessionIdentity, deps: UserAccessDeps = defaultDeps): Promise<DirectoryUsersResponse> {
  await deps.authorize(identity);
  const configured = deps.directoryConfigured();
  // Manual entry exists only for local development while directory search is unconfigured.
  const notConfigured: DirectoryUsersResponse = { users: [], configured: false, manualEntryAllowed: deps.devAccess() };
  if (!configured) return notConfigured;
  try {
    return { users: await deps.directory(), configured: true, manualEntryAllowed: false };
  } catch (error) {
    if (error instanceof DirectoryConfigError) return notConfigured;
    console.error("[CI] user-access: loading the Entra directory failed:", error instanceof Error ? error.message : error);
    const reason = describeDirectoryFailure(error);
    // Local development only: typing a name and email stays possible while the directory cannot be read.
    if (deps.devAccess()) return { users: [], configured: true, manualEntryAllowed: true, unavailable: reason };
    throw new CiError(reason, 502, "INTERNAL");
  }
}

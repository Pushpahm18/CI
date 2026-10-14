import type { SessionIdentity } from "@/server/ci/current-user";
import { CiError } from "@/server/ci/errors";
import { getLoginHistoryRepository, type LoginHistoryRepository } from "@/server/ci/login-history/repository";
import { STANDALONE_REQUIRES, requireTablesConfigured } from "@/server/ci/readiness";
import { authorizeUserAccessManager, type UserAccessActor } from "@/server/ci/user-access/access";
import { requireConnected } from "@/server/ci/connection";
import type { LoginHistoryResponse } from "@/types/ci-api";

/**
 * The Login History screen's data: who signed in, newest first. Read-only.
 *
 * Order: the Login History table must be configured (otherwise the screen
 * reports "CI database table configuration is pending: Login History" and
 * nothing is attempted) → Databricks must be connected → read. The authorization
 * function (server/ci/user-access/access.ts: local development with the dev login,
 * otherwise a verified Corporate Marketing user) decides the SCOPE: allowed → every
 * user's sign-ins; not allowed → only the caller's own (CI Prototype "My Login History").
 *
 * Dependencies are injectable so the flow can be unit-tested against fakes.
 */

export interface LoginHistoryServiceDeps {
  requireTables(): void;
  requireConnected(): void;
  authorize(identity: SessionIdentity): Promise<UserAccessActor>;
  repository(): LoginHistoryRepository;
}

const defaultDeps: LoginHistoryServiceDeps = {
  requireTables: () => requireTablesConfigured(STANDALONE_REQUIRES.loginHistoryView),
  requireConnected,
  authorize: (identity) => authorizeUserAccessManager(identity),
  repository: getLoginHistoryRepository,
};

export async function listLoginHistory(identity: SessionIdentity, deps: LoginHistoryServiceDeps = defaultDeps): Promise<LoginHistoryResponse> {
  deps.requireTables();
  deps.requireConnected();
  // CI Prototype: Corporate Marketing sees every user's sign-ins, everyone else only their own.
  // The person is the verified session email, never anything the browser sends.
  let scope: "all" | "own" = "all";
  try {
    await deps.authorize(identity);
  } catch (error) {
    if (error instanceof CiError && error.status === 403) scope = "own";
    else throw error;
  }
  try {
    const repository = deps.repository();
    const records = await repository.list(scope === "own" ? { email: identity.email } : undefined);
    return { records, scope, optionalColumns: repository.optionalColumns() };
  } catch (error) {
    // Expected, already-safe errors (pending configuration, etc.) pass through unchanged.
    if (error instanceof CiError) throw error;
    // The Databricks message goes to the server log only; the browser gets a safe sentence.
    console.error("[CI] login history: loading from Databricks failed:", error instanceof Error ? error.message : error);
    throw new CiError("Login History could not be loaded from Databricks. Check the server log for details.", 502, "INTERNAL");
  }
}

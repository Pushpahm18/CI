import type { SessionIdentity } from "@/server/ci/current-user";
import { requireTablesConfigured, STANDALONE_REQUIRES } from "@/server/ci/readiness";
import { safely } from "@/server/ci/lookups/service";
import { authorizeUserManagement } from "@/server/ci/authorization/dev-access";
import { requireConnected } from "@/server/ci/connection";
import { getUserRecordStore, type UserRecordStore } from "@/server/ci/databricks/user-records";
import { loadOwnedRowCounts } from "@/server/ci/user-management/ci-users-offboard";
import type { CiUserRecordRaw, CiUserRecordsResponse } from "@/types/ci-api";

/**
 * Read-only list of corp_marketing_dev.ci.ci_user_management, exactly as
 * stored. Order: table configured → Databricks connected → caller authorized
 * (same single function as Lookups and the gallery) → read. Nothing here is
 * used to authorize anyone, and nothing is written.
 */

export interface CiUsersServiceDeps {
  requireTables(): void;
  requireConnected(): void;
  authorize(identity: SessionIdentity): Promise<unknown>;
  list(): Promise<CiUserRecordRaw[]>;
  /** Live ci_main rows per created_by name; a failure here only hides the "Rows owned" column. */
  ownedRows?(): Promise<Record<string, number>>;
}

const defaultDeps: CiUsersServiceDeps = {
  requireTables: () => requireTablesConfigured(STANDALONE_REQUIRES.userRecordsView),
  requireConnected,
  authorize: (identity) => authorizeUserManagement(identity),
  list: async () => (getUserRecordStore() as UserRecordStore | null)?.list() ?? [],
  ownedRows: () => loadOwnedRowCounts(),
};

export async function loadCiUserRecords(identity: SessionIdentity, deps: CiUsersServiceDeps = defaultDeps): Promise<CiUserRecordsResponse> {
  deps.requireTables();
  deps.requireConnected();
  await deps.authorize(identity);
  return safely(async () => {
    const [users, ownedRows] = await Promise.all([deps.list(), Promise.resolve(deps.ownedRows?.()).catch(() => undefined)]);
    return ownedRows ? { users, ownedRows } : { users };
  }, "loaded");
}

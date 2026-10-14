import { CI_ROLE_NAMES, CI_TABLE_AUTHORIZATION_APPROVED, ciUserFrom, decideCiAccess, type CiRoleName } from "@/server/ci/authorization/ci-access";
import { getUserRecordStore } from "@/server/ci/databricks/user-records";
import { getUserAccessStore } from "@/server/ci/databricks/user-access";
import { devMockAuthRecords } from "@/lib/ci/dev-mock-users";
import { isDevMockAuthEnabled } from "@/server/dev-auth";
import type { CiUser } from "@/types/ci";
import type { CiUserRecordRaw } from "@/types/ci-api";

/**
 * Page-level gate (src/proxy.ts) and session user, fail closed. A signed-in
 * person may open CI pages only when ci_user_management holds exactly one valid,
 * active record for their email (decideCiAccess - the same rule the API routes
 * use). No record, an empty table, an unconfigured table or a missing connection
 * all mean "denied". A failure of the check itself throws, and the proxy then
 * denies too. This is never the only control: every API route authorizes again
 * server-side, with the real table only.
 *
 * Local development: when the dev login is on (next dev + DEV_MOCK_AUTH), the
 * decision is made by the SAME rule over clearly marked MOCK records
 * (lib/ci/dev-mock-users.ts) instead of Databricks. That gives page shells to the
 * developer; it is not an exemption from the rule, and it never reaches the API
 * routes, which read the real table only (User Management has one development-only
 * rule of its own, see authorization/dev-access.ts).
 */

export type CiAccess = { status: "authorized"; role: CiRoleName; user: CiUser } | { status: "denied" };

/** Pages only Corporate Marketing may open (Account Team: Home and All Competitive Info View). */
export const CM_ONLY_PAGES = ["/user-management", "/user-access", "/lookups", "/sequential-lookup", "/import", "/competitive-ff", "/admin"];

export function roleMayOpenPage(role: CiRoleName, pathname: string): boolean {
  if (role === CI_ROLE_NAMES.corporateMarketing) return true;
  return !CM_ONLY_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export interface AccessCheckDeps {
  approved(): boolean;
  listRecords(email: string): Promise<CiUserRecordRaw[]>;
  /** Whether this email has an active User Access row (ci_user_access); needed by Account Team (Corporate Marketing is exempt). */
  hasAccessEntry(email: string): Promise<boolean>;
}

const defaultDeps: AccessCheckDeps = {
  approved: () => CI_TABLE_AUTHORIZATION_APPROVED,
  listRecords: async (email) => {
    if (isDevMockAuthEnabled()) return devMockAuthRecords(process.env.DEV_MOCK_AUTH_EMAIL?.trim() || email);
    return (await getUserRecordStore()?.list()) ?? [];
  },
  // The local development login is judged over clearly marked MOCK records, so it has no ci_user_access row to look for.
  hasAccessEntry: async (email) => (isDevMockAuthEnabled() ? true : ((await getUserAccessStore()?.has(email)) ?? false)),
};

export async function resolveCiAccess(email: string, deps: AccessCheckDeps = defaultDeps): Promise<CiAccess> {
  if (!deps.approved()) return { status: "denied" };
  const d = decideCiAccess(await deps.listRecords(email), email);
  if (!d.allowed) return { status: "denied" };
  if (d.role === CI_ROLE_NAMES.accountTeam && !(await deps.hasAccessEntry(d.email))) return { status: "denied" };
  const user: CiUser = ciUserFrom(d);
  return { status: "authorized", role: d.role, user };
}

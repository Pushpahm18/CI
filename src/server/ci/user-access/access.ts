import type { SessionIdentity } from "@/server/ci/current-user";
import { authorizeCorporateMarketing } from "@/server/ci/authorization/ci-access";
import { requireConnected } from "@/server/ci/connection";
import { isDevMockAuthEnabled } from "@/server/dev-auth";

/*
 * ===========================================================================
 * LOGIN HISTORY AUTHORIZATION — one place, easy to replace.
 * ===========================================================================
 * The screen is for Corporate Marketing only. The rule has two parts:
 *
 * 1. TEMPORARY-DEV-ACCESS (local development only). Allowed ONLY when the
 *    existing local dev login is on: `next dev` (NODE_ENV=development) AND
 *    DEV_MOCK_AUTH=true — exactly server/dev-auth.ts isDevMockAuthEnabled().
 *    A production build (`next build` / `next start` / a deployed app) always
 *    has NODE_ENV=production, so this branch can never run there, whatever
 *    environment variables are set. There is no hard-coded identity and no
 *    "allow everyone" flag.
 *
 * 2. Everywhere else the caller must be a verified Corporate Marketing user:
 *    the signed-in session email (Auth.js, server-side — never taken from the
 *    request) must hold the one active "Corporate Marketing" record in the CI
 *    User Management table (authorizeCorporateMarketing). This is real
 *    server-side enforcement on every API call; the page hides nothing on its own.
 */

export interface UserAccessActor {
  email: string;
  userName: string;
}

export interface AccessDeps {
  devAccess(): boolean;
  requireConnected(): void;
  requireCorporateMarketing(identity: SessionIdentity): Promise<UserAccessActor>;
}

const defaultAccessDeps: AccessDeps = {
  devAccess: isDevMockAuthEnabled,
  requireConnected,
  requireCorporateMarketing: (identity) => authorizeCorporateMarketing(identity),
};

/** True only for local development with the dev login on — never in production. */
export function devAccessEnabled(deps: Pick<AccessDeps, "devAccess"> = defaultAccessDeps): boolean {
  return deps.devAccess();
}

/** Who may use Login History and the Microsoft directory search. Returns the person to record as the actor. */
export async function authorizeUserAccessManager(
  identity: SessionIdentity,
  deps: AccessDeps = defaultAccessDeps
): Promise<UserAccessActor> {
  if (deps.devAccess()) return { email: identity.email.trim().toLowerCase(), userName: identity.name }; // TEMPORARY-DEV-ACCESS
  deps.requireConnected();
  return deps.requireCorporateMarketing(identity);
}

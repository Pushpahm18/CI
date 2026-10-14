import type { SessionIdentity } from "@/server/ci/current-user";
import { ForbiddenError } from "@/server/ci/errors";
import { authorizeCorporateMarketing } from "@/server/ci/authorization/ci-access";
import { isDevMockAuthEnabled } from "@/server/dev-auth";

/*
 * ===========================================================================
 * DEVELOPMENT-ONLY ACCESS FOR USER MANAGEMENT (listing users and Add User)
 * ===========================================================================
 * Normally the caller must be an authorized Corporate Marketing user
 * (authorizeCorporateMarketing). The one exception is a LOCAL development
 * build with the local development login switched on, so a developer can create
 * users in the development table without a Microsoft sign-in or a first user.
 *
 * It can never apply in production: isDevMockAuthEnabled() is true only when
 * NODE_ENV === "development" (set by `next dev`; a production build and a
 * deployed app always run as "production") AND DEV_MOCK_AUTH === "true". It
 * covers User Management only: Lookups, the gallery and every other screen keep
 * the normal check, and Edit / Deactivate stay switched off for everyone.
 * Once a Corporate Marketing record exists for the developer's email the normal
 * check passes by itself and this rule is simply never reached.
 */

export async function authorizeUserManagement(
  identity: SessionIdentity,
  authorize: (identity: SessionIdentity) => Promise<{ email: string; userName: string }> = (i) => authorizeCorporateMarketing(i),
  devAccess: () => boolean = isDevMockAuthEnabled
): Promise<{ email: string; userName: string }> {
  try {
    return await authorize(identity);
  } catch (error) {
    if (error instanceof ForbiddenError && devAccess()) {
      const email = identity.email.trim().toLowerCase();
      return { email, userName: identity.name || email };
    }
    throw error;
  }
}

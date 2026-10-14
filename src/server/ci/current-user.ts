import { auth } from "@/auth";
import type { CiRole, CiUser } from "@/types/ci";
import { authorizeCiUser, ciUserFrom } from "@/server/ci/authorization/ci-access";
import { ForbiddenError, UnauthenticatedError } from "@/server/ci/errors";

export interface SessionIdentity {
  email: string;
  name: string;
}

/** The verified Microsoft (Entra ID) identity from the Auth.js session — never trusted from the request body. */
export async function getSessionIdentity(): Promise<SessionIdentity> {
  const session = await auth();
  const email = session?.user?.email?.trim();
  if (!email) throw new UnauthenticatedError();
  return { email, name: session?.user?.name ?? email };
}

/**
 * The signed-in person's CI User Management record (role + Customer / Served Market / Region scope), read from
 * corp_marketing_dev.ci.ci_user_management by the same strict, fail-closed rule as every other screen
 * (authorizeCiUser; no development bypass). Throws ForbiddenError for someone with no valid, active record.
 * The name on the returned user is the verified Microsoft display name, which is what Created By / Modified By record.
 */
export async function resolveCurrentUser(known?: SessionIdentity): Promise<CiUser> {
  const identity = known ?? (await getSessionIdentity());
  return ciUserFrom(await authorizeCiUser(identity));
}

export function requireRole(user: CiUser, roles: CiRole[]): void {
  if (!roles.includes(user.role)) throw new ForbiddenError();
}

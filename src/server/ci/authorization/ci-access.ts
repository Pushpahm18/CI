import type { SessionIdentity } from "@/server/ci/current-user";
import { ForbiddenError } from "@/server/ci/errors";
import { requireTablesConfigured, STANDALONE_REQUIRES } from "@/server/ci/readiness";
import { requireConnected } from "@/server/ci/connection";
import { getUserRecordStore } from "@/server/ci/databricks/user-records";
import { getUserAccessStore } from "@/server/ci/databricks/user-access";
import { accountScopeFrom, type AccountScope } from "@/server/ci/authorization/scope";
import type { CiUser } from "@/types/ci";
import type { CiUserRecordRaw } from "@/types/ci-api";

/*
 * ===========================================================================
 * CI AUTHORIZATION — fail closed. One place; every protected CI screen calls
 * authorizeCorporateMarketing().
 * ===========================================================================
 * The only source is corp_marketing_dev.ci.ci_user_management. SAMBA's tables
 * are never consulted, and there is NO development bypass: the local dev login
 * gets no access to real CI data (the User Management page offers a clearly
 * labelled, browser-only mock preview instead).
 *
 * The approach is approved. With no approved user record (today the table is
 * empty) nobody is authorized, so this fails closed by itself. The rule
 * (decideCiAccess) denies unless ALL hold:
 *   - the signed-in email (Auth.js session, never the request) has records;
 *   - none of those records has an unreadable / NULL is_active;
 *   - exactly ONE record has is_active = TRUE (none, or several, = denied);
 *   - its status is "Active" - the vocabulary CI code already uses is
 *     Active / Off-boarded, so blank, NULL, Off-boarded or anything else = denied;
 *   - its role_name is exactly "Account Team" or "Corporate Marketing".
 * A Customer / Segment / Region value of "All" never grants anything by itself.
 * Account Team additionally needs a VALID scope: Customer, Segment and Region
 * must each parse as a JSON array of text (authorization/scope.ts). A missing,
 * invalid or "All" dimension denies the person entirely; it never widens access.
 * Corporate Marketing is not scoped (full access), whatever its scope columns hold.
 *
 * Second step (User Access, as in SAMBA): an Account Team person must ALSO have an active row in ci_user_access. Corporate
 * Marketing does not need one (so User Access can always be opened to add people). A missing or unreadable ci_user_access
 * row means "denied".
 */

export const CI_ROLE_NAMES = { accountTeam: "Account Team", corporateMarketing: "Corporate Marketing" } as const;
export type CiRoleName = (typeof CI_ROLE_NAMES)[keyof typeof CI_ROLE_NAMES];

/** The CI authorization approach is approved. Set to false to refuse every protected call without touching a database. */
export const CI_TABLE_AUTHORIZATION_APPROVED = true;

export const AUTHORIZATION_PENDING_MESSAGE =
  "CI authorization is awaiting approval, so protected CI data is unavailable. No access has been granted.";

export type AccessDecision =
  | { allowed: true; id: string; role: CiRoleName; email: string; userName: string; scope: AccountScope | null }
  | { allowed: false; reason: string };

const deny = (reason: string): AccessDecision => ({ allowed: false, reason });

export function decideCiAccess(records: CiUserRecordRaw[], email: string): AccessDecision {
  const key = email.trim().toLowerCase();
  if (!key) return deny("No signed-in email.");
  const mine = records.filter((r) => r.email.trim().toLowerCase() === key);
  if (mine.length === 0) return deny("No CI user record for this email.");
  if (mine.some((r) => r.isActive === null)) return deny("A CI user record for this email has no clear active flag.");
  const active = mine.filter((r) => r.isActive === true);
  if (active.length === 0) return deny("The CI user record for this email is inactive.");
  if (active.length > 1) return deny("More than one active CI user record exists for this email.");
  const row = active[0];
  const status = row.status.trim().toLowerCase();
  if (status !== "active") return deny("The CI user record's status is not Active.");
  const role = Object.values(CI_ROLE_NAMES).find((r) => r === row.role);
  if (!role) return deny("The CI user record has an unrecognised role.");
  if (role === CI_ROLE_NAMES.corporateMarketing) return { allowed: true, id: row.id, role, email: key, userName: row.userName || key, scope: null };
  const scope = accountScopeFrom(row);
  if (!scope.ok) return deny(scope.reason);
  return { allowed: true, id: row.id, role, email: key, userName: row.userName || key, scope: scope.scope };
}

/**
 * The name recorded as Created By / Modified By: the signed-in person's own display name from the
 * verified Microsoft session (never from the request). Only when the session carries no real name
 * (Auth.js falls back to the email) is the name on their CI User Management record used instead.
 */
export function actorNameFor(identity: SessionIdentity, recordName: string): string {
  const sessionName = identity.name?.trim() ?? "";
  const email = identity.email.trim().toLowerCase();
  return sessionName && sessionName.toLowerCase() !== email ? sessionName : recordName;
}

export interface CiAccessDeps {
  approved(): boolean;
  requireTables(): void;
  requireConnected(): void;
  listRecords(): Promise<CiUserRecordRaw[]>;
  /** Whether this email has an active row on the User Access screen (ci_user_access). Fails closed: false when it cannot be read. */
  hasAccessEntry(email: string): Promise<boolean>;
}

const defaultDeps: CiAccessDeps = {
  approved: () => CI_TABLE_AUTHORIZATION_APPROVED,
  requireTables: () => requireTablesConfigured(STANDALONE_REQUIRES.userRecordsView),
  requireConnected,
  listRecords: async () => (await getUserRecordStore()?.list()) ?? [],
  hasAccessEntry: async (email) => (await getUserAccessStore()?.has(email)) ?? false,
};

/** What an authorized person may do: their role and, for Account Team, the validated scope (null = Corporate Marketing, unscoped). */
export interface CiGrant {
  /** The person's ci_user_id. */
  id: string;
  role: CiRoleName;
  email: string;
  userName: string;
  scope: AccountScope | null;
}

/** The CiUser the services work with, from a validated access decision or grant (Account Team is "Sales" in the app's role model). */
export function ciUserFrom(d: { id: string; role: CiRoleName; email: string; userName: string; scope: AccountScope | null }): CiUser {
  const isCm = d.role === CI_ROLE_NAMES.corporateMarketing;
  return {
    id: d.id,
    name: d.userName,
    email: d.email,
    role: isCm ? "CM" : "Sales",
    customerScope: d.scope ? d.scope.customers : "All",
    segmentScope: d.scope ? d.scope.segments : "All",
    regionScope: d.scope ? d.scope.regions : "All",
    status: "Active",
  };
}

/** Any valid CI role. Throws ForbiddenError when there is no valid, active record. */
export async function authorizeCiUser(identity: SessionIdentity, deps: CiAccessDeps = defaultDeps): Promise<CiGrant> {
  if (!deps.approved()) throw new ForbiddenError(AUTHORIZATION_PENDING_MESSAGE);
  deps.requireTables();
  deps.requireConnected();
  const decision = decideCiAccess(await deps.listRecords(), identity.email);
  if (!decision.allowed) throw new ForbiddenError("Your account has not been given access to Competitive Intelligence.");
  // SAMBA's two-step gate: an Account Team person also needs a User Access row. Corporate Marketing is exempt (as SAMBA's Admin is),
  // so someone can always open User Access to add the first people; without that exemption nobody could be added.
  if (decision.role === CI_ROLE_NAMES.accountTeam && !(await deps.hasAccessEntry(decision.email))) {
    throw new ForbiddenError("Your account has not been given access to Competitive Intelligence.");
  }
  const { id, role, email, userName, scope } = decision;
  return { id, role, email, userName: actorNameFor(identity, userName), scope };
}

/** Corporate Marketing only. Returns the person to record as the actor; throws ForbiddenError otherwise. */
export async function authorizeCorporateMarketing(
  identity: SessionIdentity,
  deps: CiAccessDeps = defaultDeps
): Promise<{ email: string; userName: string }> {
  if (!deps.approved()) throw new ForbiddenError(AUTHORIZATION_PENDING_MESSAGE);
  deps.requireTables();
  deps.requireConnected();
  const decision = decideCiAccess(await deps.listRecords(), identity.email);
  if (!decision.allowed || decision.role !== CI_ROLE_NAMES.corporateMarketing) {
    throw new ForbiddenError("Corporate Marketing access is required.");
  }
  return { email: decision.email, userName: actorNameFor(identity, decision.userName) };
}

import { accountScopeFrom } from "@/server/ci/authorization/scope";
import type { CiUserRecordRaw } from "@/types/ci-api";

/**
 * Lock-out and ownership rules for changing CI users (pure). The server applies
 * them to the real table; the local mock list applies the same ones so the UI
 * can be tried without a database.
 *
 *  - There is no physical delete: "delete" means deactivate (is_active = false,
 *    status = "Off-boarded"), and a deactivated person can be reactivated, because
 *    CI keeps one record per email.
 *  - Nobody can deactivate themselves or change their own role.
 *  - At least one active Corporate Marketing user must always remain.
 */

/** The two CI roles. No Admin role. */
export const USER_ROLES = ["Account Team", "Corporate Marketing"] as const;
export const CM_ROLE ="Corporate Marketing";
export const STATUS_ACTIVE = "Active";
export const STATUS_OFFBOARDED = "Off-boarded";

const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function isActiveRecord(u: CiUserRecordRaw): boolean {
  return u.isActive === true && u.status.trim().toLowerCase() === STATUS_ACTIVE.toLowerCase();
}

const isActiveCm = (u: CiUserRecordRaw) => isActiveRecord(u) && u.role === CM_ROLE;

/** Another active Corporate Marketing user besides `target` exists. */
const otherActiveCm = (target: CiUserRecordRaw, all: CiUserRecordRaw[]) => all.some((u) => u.id !== target.id && isActiveCm(u));

export function checkRoleChange(target: CiUserRecordRaw, newRole: string, all: CiUserRecordRaw[], actorEmail: string): string | null {
  if (target.role === newRole) return null;
  if (sameEmail(target.email, actorEmail)) return "You cannot change your own role.";
  if (isActiveCm(target) && !otherActiveCm(target, all)) return "At least one active Corporate Marketing user must remain.";
  return null;
}

export function checkDeactivate(target: CiUserRecordRaw, all: CiUserRecordRaw[], actorEmail: string): string | null {
  if (target.isActive === false) return "This user is already deactivated.";
  if (sameEmail(target.email, actorEmail)) return "You cannot deactivate your own account.";
  if (isActiveCm(target) && !otherActiveCm(target, all)) return "At least one active Corporate Marketing user must remain.";
  return null;
}

/** A reactivated person must come back with a role and scope that grant access as stored, so an invalid record is fixed (Edit) first. */
export function checkReactivationRecord(target: CiUserRecordRaw): string | null {
  if (!USER_ROLES.some((r) => r === target.role)) return `The stored role “${target.role}” is not valid. Edit the record before reactivating.`;
  if (target.role === CM_ROLE) return null;
  const scope = accountScopeFrom(target);
  return scope.ok ? null : `${scope.reason} Edit the record before reactivating.`;
}

export function checkReactivate(target: CiUserRecordRaw): string | null {
  return target.isActive === true && target.status.trim().toLowerCase() === STATUS_ACTIVE.toLowerCase() ? "This user is already active." : null;
}

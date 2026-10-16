import { parseScopeDimension, serializeScopeDimension, SCOPE_ALL, type ScopeSetting } from "@/server/ci/authorization/scope";
import { USER_ROLES } from "@/lib/ci/user-form";
import { checkDeactivate, isActiveRecord } from "@/lib/ci/user-rules";
import type { CiUserRecordRaw } from "@/types/ci-api";

/**
 * Off-boarding rules (pure; the server applies them to the real table, the page uses them to fill the dialog).
 *
 *  - Only an active user can be off-boarded; nobody off-boards themselves; one active Corporate Marketing user always remains.
 *  - The rows the leaver created go to another ACTIVE user (any role).
 *  - When both are Account Team, the new owner's scope becomes the union of the two, per dimension (All if either side is All).
 *  - Rows are matched to the leaver by the exact user name stored in ci_main.created_by. If another record in
 *    ci_user_management has the same name the rows cannot be told apart, so the off-board is refused.
 */

export const ACCOUNT_TEAM_ROLE = USER_ROLES[0];

const sameName = (a: string, b: string) => a.trim() === b.trim();

/** Why this user cannot be off-boarded, or null. */
export function checkOffboard(leaver: CiUserRecordRaw, all: CiUserRecordRaw[], actorEmail: string): string | null {
  if (!isActiveRecord(leaver)) return "Only an active user can be off-boarded.";
  const blocked = checkDeactivate(leaver, all, actorEmail);
  if (blocked) return blocked.replace("deactivate your own account", "off-board yourself");
  const name = leaver.userName.trim();
  if (name && all.some((u) => u.id !== leaver.id && sameName(u.userName, name))) {
    return `Another user record is also named “${name}”, so the rows created by this name cannot be told apart. Nothing was changed.`;
  }
  return null;
}

/** The other active users who can take over the leaver's rows. */
export function takeoverCandidates(leaver: CiUserRecordRaw, all: CiUserRecordRaw[]): CiUserRecordRaw[] {
  return all.filter((u) => u.id !== leaver.id && isActiveRecord(u));
}

/** True when the new owner inherits the leaver's scope (both are Account Team). */
export const inheritsScope = (leaver: CiUserRecordRaw, owner: CiUserRecordRaw) => leaver.role === ACCOUNT_TEAM_ROLE && owner.role === ACCOUNT_TEAM_ROLE;

/** One scope dimension: the union of two stored values, as the text to store. Null when either stored value is not a valid scope (never guessed). */
export function mergeScopeText(a: string, b: string): string | null {
  const pa = parseScopeDimension(a);
  const pb = parseScopeDimension(b);
  if (!pa.ok || !pb.ok) return null;
  if (pa.setting === SCOPE_ALL || pb.setting === SCOPE_ALL) return SCOPE_ALL;
  const union: ScopeSetting = Array.from(new Set([...pa.setting, ...pb.setting]));
  return serializeScopeDimension(union);
}

/** The new owner's scope after taking over, or null if either side's stored scope is invalid. */
export function mergedScope(owner: CiUserRecordRaw, leaver: CiUserRecordRaw): { customer: string; segment: string; region: string } | null {
  const customer = mergeScopeText(owner.customer, leaver.customer);
  const segment = mergeScopeText(owner.segment, leaver.segment);
  const region = mergeScopeText(owner.region, leaver.region);
  return customer && segment && region ? { customer, segment, region } : null;
}

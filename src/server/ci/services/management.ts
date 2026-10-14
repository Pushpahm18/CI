import { CI_ROLES, type CiRole, type CiUser, type LookupValue, type ReferenceData, type ScopeValue } from "@/types/ci";
import type { SaveUserRequest } from "@/types/ci-api";
import { getCiRepository } from "@/server/ci/repository";
import { requireRole } from "@/server/ci/current-user";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/ci/errors";
import { FIELDS, LOOKUP_CATEGORIES } from "@/lib/ci/field-spec";
import { FULL_SCOPE } from "@/lib/ci/rules";

/**
 * BRD 1.1 §4 / §7.6: there is no separate Admin role — Corporate Marketing
 * sets up and manages users and maintains Lookups, Sequential Dropdown
 * Lookup and Reference Data. Sales has no access to any of these.
 */
const ADMIN_SCREEN_ROLES: CiRole[] = ["CM"];
const EMAIL_RE = /^\S+@\S+\.\S+$/;

function isEmptyScope(scope: ScopeValue | undefined): boolean {
  return !scope || (scope !== "All" && scope.length === 0);
}

function mergeScopes(a: ScopeValue, b: ScopeValue): ScopeValue {
  if (a === "All" || b === "All") return "All";
  return Array.from(new Set([...a, ...b]));
}

/**
 * User Management validation (CI Prototype): name, a valid and unique email,
 * one role (Sales or Corporate Marketing), and for Sales a Customer, Segment
 * and Region scope that is each either "All" or at least one value
 * (BRD 1.1 §7.6). Corporate Marketing always covers everything.
 */
function validateUser(request: SaveUserRequest, existing: CiUser[], selfId?: string): Omit<CiUser, "id" | "status"> {
  const errors: string[] = [];
  const name = request.name?.trim() ?? "";
  const email = request.email?.trim() ?? "";
  if (!name) errors.push("Enter a name.");
  if (!EMAIL_RE.test(email)) errors.push("Enter a valid email address.");
  if (!CI_ROLES.includes(request.role)) errors.push("Choose a role (Sales or Corporate Marketing).");
  if (existing.some((u) => u.id !== selfId && u.email.toLowerCase() === email.toLowerCase())) {
    errors.push("That email is already in use.");
  }
  if (request.role === "Sales") {
    if ([request.customerScope, request.segmentScope, request.regionScope].some(isEmptyScope)) {
      errors.push("Each scope (Customer, Segment, Region) is either All or at least one selected value.");
    }
  }
  if (errors.length) throw new ValidationError(errors);
  const salesScope = request.role === "Sales";
  return {
    name,
    email,
    role: request.role,
    customerScope: salesScope ? request.customerScope : "All",
    segmentScope: salesScope ? request.segmentScope : "All",
    regionScope: salesScope ? request.regionScope : "All",
  };
}

export async function listUsersFor(actor: CiUser): Promise<{ users: CiUser[]; ownedRows: Record<string, number> }> {
  requireRole(actor, ADMIN_SCREEN_ROLES);
  const repo = getCiRepository();
  const [users, records] = await Promise.all([repo.listUsers(), repo.listRecords(FULL_SCOPE)]);
  // CI Prototype "Rows owned" column (BRD §5.5 ownership).
  const ownedRows = Object.fromEntries(users.map((u) => [u.id, records.filter((r) => r.createdBy === u.name).length]));
  return { users, ownedRows };
}

export async function createUserFor(actor: CiUser, request: SaveUserRequest): Promise<CiUser> {
  requireRole(actor, ADMIN_SCREEN_ROLES);
  const repo = getCiRepository();
  const fields = validateUser(request, await repo.listUsers());
  return repo.createUser({ ...fields, status: "Active" });
}

export async function updateUserFor(actor: CiUser, id: string, request: SaveUserRequest): Promise<CiUser> {
  requireRole(actor, ADMIN_SCREEN_ROLES);
  const repo = getCiRepository();
  const users = await repo.listUsers();
  const current = users.find((u) => u.id === id);
  if (!current) throw new NotFoundError("User not found.");
  return repo.updateUser({ ...current, ...validateUser(request, users, id) });
}

async function countOwnedRows(user: CiUser): Promise<number> {
  const records = await getCiRepository().listRecords(FULL_SCOPE);
  return records.filter((r) => r.createdBy === user.name).length;
}

/** BRD 1.1 §5.5: on off-boarding, Corporate Marketing is told the user owns rows so ownership can be reassigned. */
export async function offboardPreviewFor(actor: CiUser, id: string): Promise<number> {
  requireRole(actor, ADMIN_SCREEN_ROLES);
  const user = await getCiRepository().getUser(id);
  if (!user) throw new NotFoundError("User not found.");
  return countOwnedRows(user);
}

/**
 * CI Prototype off-boarding: the leaver's rows move to any other active user
 * (each with a "Reassigned" audit entry), a Sales replacement inherits the
 * leaver's Customer, Segment and Region scope, and the leaver is marked
 * Off-boarded. Rows stay, and the leaver
 * stays visible in the audit trail (BRD §5.5).
 */
export async function offboardUserFor(actor: CiUser, id: string, reassignToUserId: string): Promise<number> {
  requireRole(actor, ADMIN_SCREEN_ROLES);
  if (id === actor.id) throw new ForbiddenError("You cannot off-board yourself.");
  const repo = getCiRepository();
  const [leaver, target] = await Promise.all([repo.getUser(id), repo.getUser(reassignToUserId)]);
  if (!leaver || leaver.status !== "Active") throw new NotFoundError("User not found.");
  if (!target || target.status !== "Active" || target.id === leaver.id) {
    throw new ValidationError(["Choose an active user to take over the rows."]);
  }

  const recordIds = await repo.reassignRecords(leaver.name, target.name);
  const now = new Date().toISOString();
  if (recordIds.length) {
    await repo.addAudit(
      recordIds.map((recordId) => ({
        recordId,
        action: "Reassigned" as const,
        actionTakenBy: actor.name,
        dateTime: now,
        changes: [{ field: "createdBy", label: "Created By", previous: leaver.name, current: target.name }],
        actorEmail: actor.email,
        note: "Owner off-boarded; rows reassigned by Corporate Marketing.",
      }))
    );
  }
  if (leaver.role === "Sales" && target.role === "Sales") {
    await repo.updateUser({
      ...target,
      customerScope: mergeScopes(target.customerScope, leaver.customerScope),
      segmentScope: mergeScopes(target.segmentScope, leaver.segmentScope),
      regionScope: mergeScopes(target.regionScope, leaver.regionScope),
    });
  }
  await repo.setUserStatus(leaver.id, "Off-boarded");
  return recordIds.length;
}

// ---------------------------------------------------------------- lookups

export async function listLookupsFor(actor: CiUser): Promise<LookupValue[]> {
  requireRole(actor, ADMIN_SCREEN_ROLES);
  return getCiRepository().listLookups();
}

/** CI Prototype: "used by N rows" next to each value. */
export async function lookupUsageFor(actor: CiUser): Promise<Record<string, number>> {
  requireRole(actor, ADMIN_SCREEN_ROLES);
  const records = await getCiRepository().listRecords(FULL_SCOPE);
  const usage: Record<string, number> = {};
  for (const field of FIELDS) {
    if (!field.lookupCategory) continue;
    for (const r of records) {
      const key = `${field.lookupCategory}|${String(r[field.key])}`;
      usage[key] = (usage[key] ?? 0) + 1;
    }
  }
  return usage;
}

export async function addLookupFor(actor: CiUser, category: string, value: string): Promise<LookupValue> {
  requireRole(actor, ADMIN_SCREEN_ROLES);
  const name = value?.trim() ?? "";
  if (!(LOOKUP_CATEGORIES as readonly string[]).includes(category)) throw new ValidationError(["Unknown list."]);
  if (!name) throw new ValidationError(["Enter a value."]);
  const repo = getCiRepository();
  const inCategory = (await repo.listLookups()).filter((l) => l.category === category && l.active);
  // CI Prototype: duplicate check is case-insensitive.
  if (inCategory.some((l) => l.value.toLowerCase() === name.toLowerCase())) {
    throw new ValidationError([`“${name}” is already in the list.`]);
  }
  const nextOrder = inCategory.reduce((max, l) => Math.max(max, l.sortOrder), 0) + 1;
  return repo.addLookup(category, name, nextOrder);
}

/** CI Prototype: removing a value keeps it on existing rows; it just stops appearing in new dropdowns. */
export async function removeLookupFor(actor: CiUser, id: string): Promise<void> {
  requireRole(actor, ADMIN_SCREEN_ROLES);
  await getCiRepository().deactivateLookup(id);
}

/** BRD §7.6 Sequential Dropdown Lookup: controls non-alphabetical display order. */
export async function reorderLookupsFor(actor: CiUser, category: string, orderedIds: string[]): Promise<void> {
  requireRole(actor, ADMIN_SCREEN_ROLES);
  if (!(LOOKUP_CATEGORIES as readonly string[]).includes(category)) throw new ValidationError(["Unknown list."]);
  if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== "string")) throw new ValidationError(["Invalid order."]);
  await getCiRepository().reorderLookups(category, orderedIds);
}

// ---------------------------------------------------------------- reference data

/** BRD §7.6 Reference Data — read-only in this release. */
export async function referenceDataFor(actor: CiUser): Promise<ReferenceData> {
  requireRole(actor, ADMIN_SCREEN_ROLES);
  return getCiRepository().getReferenceData();
}

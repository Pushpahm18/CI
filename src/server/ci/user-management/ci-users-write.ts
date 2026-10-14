import type { SessionIdentity } from "@/server/ci/current-user";
import { ConflictError, DisabledError, NotConfiguredError, NotFoundError, ValidationError } from "@/server/ci/errors";
import { requireTablesConfigured, STANDALONE_REQUIRES } from "@/server/ci/readiness";
import { safely } from "@/server/ci/lookups/service";
import { authorizeUserManagement } from "@/server/ci/authorization/dev-access";
import { requireConnected } from "@/server/ci/connection";
import { getUserRecordWriter, type UserRecordWriter } from "@/server/ci/databricks/user-records";
import { serializeScopeDimension, type ScopeSetting } from "@/server/ci/authorization/scope";
import { getLookupStore } from "@/server/ci/databricks/lookups";
import { resolveDirectoryUser, type ResolvedPerson } from "@/server/ci/user-access/resolve";
import { ENTITY_USER, auditBeforeChange, change, diff, writeAuditHistory, type AuditWriter } from "@/server/ci/audit";
import { validateUserForm, type ScopeInput, type UserFormContext, type UserFormValues } from "@/lib/ci/user-form";
import { CM_ROLE, STATUS_ACTIVE, STATUS_OFFBOARDED, checkDeactivate, checkReactivate, checkRoleChange } from "@/lib/ci/user-rules";
import type { CiUserRecordRaw, CiUserWriteResponse } from "@/types/ci-api";

/**
 * Add / Edit / Deactivate / Reactivate for CI users, on
 * corp_marketing_dev.ci.ci_user_management ONLY (never a SAMBA table).
 *
 * Every call: table configured -> Databricks connected -> caller authorized as
 * Corporate Marketing (from the verified session, never the request) -> validate
 * on the server (the same rules as the form; the person must be in the Microsoft
 * directory) -> one guarded write. The actor
 * recorded as Created By / Modified By is the authorized person's name.
 *
 * Every change is recorded in the audit history FIRST (who, what, old and new values, when - the verified signed-in
 * person); if that cannot be written, nothing is saved.
 *
 * Add, Edit, Deactivate and Reactivate are all enabled (the owner approved them). One switch,
 * USER_EDIT_DELETE_ENABLED, turns Edit / Deactivate / Reactivate off again: they then refuse,
 * after authorization, with nothing written.
 *
 * "Delete" is deactivation (is_active = false, status = "Off-boarded"): no row is
 * ever removed. CI keeps ONE record per email, so a deactivated person is
 * reactivated, not re-added. Nobody can deactivate themselves or change their own
 * role, and one active Corporate Marketing user always remains.
 */

/** Edit / Deactivate / Reactivate are approved and on. Set to false to refuse them again without touching anything else. */
export const USER_EDIT_DELETE_ENABLED = true;

export const EDIT_DISABLED_MESSAGE = "Editing and deactivating users is switched off on this server. No change was made.";

export interface CiUsersWriteDeps {
  /** Whether Edit / Deactivate / Reactivate may run. */
  editsEnabled(): boolean;
  /** Approved value lists to validate scope against (only non-empty lists are enforced). */
  masters(): Promise<NonNullable<UserFormContext["masters"]>>;
  requireTables(): void;
  requireConnected(): void;
  authorize(identity: SessionIdentity): Promise<{ email: string; userName: string }>;
  /** Confirms the person is in the Microsoft directory and returns the directory's own email and name (the browser's are never trusted). */
  directoryUser(email: string, typedName: string): Promise<{ email: string; userName: string } & Partial<Pick<ResolvedPerson, "aliases">>>;
  writer(): UserRecordWriter;
  /** Writes the audit history entries (corp_marketing_dev.audit.ci_audit_history). */
  audit: AuditWriter;
}

/** Served Market and Region (Fab Region) are Lookups lists in ci_lookup. Customer has no approved master yet, so it is checked for shape only. */
async function lookupMasters(): Promise<NonNullable<UserFormContext["masters"]>> {
  const store = getLookupStore();
  if (!store) return {};
  const active = (await store.listLookups()).filter((l) => l.active);
  const list = (category: string) => active.filter((l) => l.category === category).map((l) => l.value);
  return { segments: list("Served Market"), regions: list("Fab Region") };
}

const defaultDeps: CiUsersWriteDeps = {
  editsEnabled: () => USER_EDIT_DELETE_ENABLED,
  masters: lookupMasters,
  requireTables: () => requireTablesConfigured(STANDALONE_REQUIRES.userRecordsView),
  requireConnected,
  authorize: (identity) => authorizeUserManagement(identity),
  directoryUser: (email, typedName) => resolveDirectoryUser(email, typedName),
  writer: () => {
    const w = getUserRecordWriter();
    if (!w) throw new NotConfiguredError(["CI User Management"]);
    return w;
  },
  audit: writeAuditHistory,
};

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

async function prepare(identity: SessionIdentity, deps: CiUsersWriteDeps) {
  deps.requireTables();
  deps.requireConnected();
  return deps.authorize(identity);
}

const stringList = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);

/** A scope dimension from the request: the text "All", or a list of text. Anything else is refused. */
const scopeInput = (v: unknown): ScopeInput | null => (v === "All" ? "All" : stringList(v));

/** Reads the form body defensively: wrong shapes are a validation error, never a crash or a guess. */
export function parseUserBody(body: unknown): UserFormValues {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const customers = scopeInput(b.customers ?? []);
  const segments = scopeInput(b.segments ?? []);
  const regions = scopeInput(b.regions ?? []);
  if (typeof b.userName !== "string" || typeof b.email !== "string" || typeof b.role !== "string" || !customers || !segments || !regions) {
    throw new ValidationError(["The user details are not in the expected format."]);
  }
  return { userName: b.userName, email: b.email, role: b.role, customers, segments, regions };
}

function requireId(id: unknown): string {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new ValidationError(["Invalid user id."]);
  return id;
}

function scopeTexts(values: UserFormValues): { customer: string; segment: string; region: string } {
  const text = (v: ScopeInput) => serializeScopeDimension(v as ScopeSetting);
  return values.role === CM_ROLE
    ? { customer: "All", segment: "All", region: "All" }
    : { customer: text(values.customers), segment: text(values.segments), region: text(values.regions) };
}

const toRecord = (id: string, r: { userName: string; email: string; role: string; customer: string; segment: string; region: string }, prev?: CiUserRecordRaw): CiUserRecordRaw => ({
  id,
  userName: r.userName,
  email: r.email,
  role: r.role,
  customer: r.customer,
  segment: r.segment,
  region: r.region,
  status: prev?.status ?? STATUS_ACTIVE,
  lastSignIn: prev?.lastSignIn ?? "",
  isActive: prev ? prev.isActive : true,
});

/**
 * Add one user. The caller must be an authorized Corporate Marketing user, with one
 * development-only exception for the local development login (authorization/dev-access.ts),
 * which can never apply in production. The record is saved only when the database confirms
 * it: the insert re-reads the table and reports a conflict if the row is not there.
 */
export async function createCiUser(identity: SessionIdentity, body: unknown, deps: CiUsersWriteDeps = defaultDeps): Promise<CiUserWriteResponse> {
  const actor = await prepare(identity, deps);
  const sent = parseUserBody(body);
  return safely(async () => {
    // The saved email and name come from the Microsoft directory, not from the browser.
    const person = await deps.directoryUser(sent.email, sent.userName);
    const values = { ...sent, email: person.email, userName: person.userName };
    const writer = deps.writer();
    const existing = await writer.list();
    // One record per PERSON: a record saved earlier under their other address (UPN vs mail) also blocks a new one.
    const aliases = person.aliases ?? [person.email];
    const clash = existing.find((u) => aliases.includes(u.email.trim().toLowerCase()));
    if (clash) throw new ValidationError([`This person already has a CI user record (${clash.email}). CI keeps one record per person, so edit that record instead.`]);
    const id = writer.newId();
    const masters = await deps.masters();
    const result = validateUserForm(values, { existing, signedIn: { name: actor.userName, email: actor.email }, newId: () => id, masters });
    if (!result.proposed) throw new ValidationError(Object.values(result.errors).filter((m): m is string => Boolean(m)));
    const p = result.proposed;
    await auditBeforeChange(deps.audit, [
      {
        entity: ENTITY_USER,
        recordId: p.ci_user_id,
        action: "Created",
        changes: [
          change("User Name", "", p.user_name),
          change("User Email", "", p.user_email),
          change("Role", "", p.role_name),
          change("Customer", "", p.customer),
          change("Served Market", "", p.segment),
          change("Region", "", p.region),
          change("Status", "", p.status),
        ],
        actionByName: actor.userName,
        actionByEmail: actor.email,
        at: writer.now(),
      },
    ]);
    const row = {
      id: p.ci_user_id,
      userName: p.user_name,
      email: p.user_email,
      role: p.role_name,
      customer: p.customer,
      segment: p.segment,
      region: p.region,
      status: p.status,
      actor: actor.userName,
    };
    // The insert is only reported as done once the table has been read back and the row is there.
    if (!(await writer.insert(row))) throw new ConflictError("This email already has a CI user record. CI keeps one record per email.");
    return { user: toRecord(p.ci_user_id, { userName: p.user_name, email: p.user_email, role: p.role_name, customer: p.customer, segment: p.segment, region: p.region }) };
  }, "saved");
}

export async function updateCiUser(identity: SessionIdentity, idInput: unknown, body: unknown, deps: CiUsersWriteDeps = defaultDeps): Promise<CiUserWriteResponse> {
  const actor = await prepare(identity, deps);
  if (!deps.editsEnabled()) throw new DisabledError(EDIT_DISABLED_MESSAGE);
  const id = requireId(idInput);
  const values = parseUserBody(body);
  return safely(async () => {
    const writer = deps.writer();
    const all = await writer.list();
    const target = all.find((u) => u.id === id);
    if (!target) throw new NotFoundError("That user was not found.");
    if (values.email.trim().toLowerCase() !== target.email.trim().toLowerCase()) throw new ValidationError(["The email cannot be changed. Add a new user instead."]);
    const result = validateUserForm({ ...values, email: target.email }, { existing: all.filter((u) => u.id !== id), signedIn: { name: actor.userName, email: actor.email }, masters: await deps.masters() });
    if (!result.proposed) throw new ValidationError(Object.values(result.errors).filter((m): m is string => Boolean(m)));
    const blocked = checkRoleChange(target, result.proposed.role_name, all, actor.email);
    if (blocked) throw new ValidationError([blocked]);
    const p = result.proposed;
    const scope = scopeTexts({ ...values, role: p.role_name });
    const changes = [
      diff("User Name", target.userName, p.user_name),
      diff("Role", target.role, p.role_name),
      diff("Customer", target.customer, scope.customer),
      diff("Served Market", target.segment, scope.segment),
      diff("Region", target.region, scope.region),
    ].filter((c): c is NonNullable<typeof c> => c !== null);
    if (changes.length === 0) throw new ValidationError(["No changes to save."]);
    await auditBeforeChange(deps.audit, [{ entity: ENTITY_USER, recordId: id, action: "Edited", changes, actionByName: actor.userName, actionByEmail: actor.email, at: writer.now() }]);
    await writer.update({ id, userName: p.user_name, role: p.role_name, ...scope, actor: actor.userName });
    return { user: toRecord(id, { userName: p.user_name, email: target.email, role: p.role_name, ...scope }, target) };
  }, "saved");
}

async function setActive(identity: SessionIdentity, idInput: unknown, active: boolean, deps: CiUsersWriteDeps): Promise<CiUserWriteResponse> {
  const actor = await prepare(identity, deps);
  if (!deps.editsEnabled()) throw new DisabledError(EDIT_DISABLED_MESSAGE);
  const id = requireId(idInput);
  return safely(async () => {
    const writer = deps.writer();
    const all = await writer.list();
    const target = all.find((u) => u.id === id);
    if (!target) throw new NotFoundError("That user was not found.");
    const blocked = active ? checkReactivate(target) : checkDeactivate(target, all, actor.email);
    if (blocked) throw new ValidationError([blocked]);
    const status = active ? STATUS_ACTIVE : STATUS_OFFBOARDED;
    await auditBeforeChange(deps.audit, [
      {
        entity: ENTITY_USER,
        recordId: id,
        action: active ? "Reactivated" : "Deactivated",
        changes: [change("Active", target.isActive === null ? "" : String(target.isActive), String(active)), change("Status", target.status, status)],
        note: `${target.userName || target.email} (${target.email})`,
        actionByName: actor.userName,
        actionByEmail: actor.email,
        at: writer.now(),
      },
    ]);
    await writer.setActive({ id, active, status, actor: actor.userName });
    return { user: { ...target, isActive: active, status } };
  }, "saved");
}

export const deactivateCiUser = (identity: SessionIdentity, id: unknown, deps: CiUsersWriteDeps = defaultDeps) => setActive(identity, id, false, deps);
export const reactivateCiUser = (identity: SessionIdentity, id: unknown, deps: CiUsersWriteDeps = defaultDeps) => setActive(identity, id, true, deps);

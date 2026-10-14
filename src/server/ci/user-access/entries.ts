import type { SessionIdentity } from "@/server/ci/current-user";
import { ConflictError, NotConfiguredError, ValidationError } from "@/server/ci/errors";
import { requireTablesConfigured, STANDALONE_REQUIRES } from "@/server/ci/readiness";
import { safely } from "@/server/ci/lookups/service";
import { authorizeUserManagement } from "@/server/ci/authorization/dev-access";
import { requireConnected } from "@/server/ci/connection";
import { ENTITY_USER_ACCESS, auditBeforeChange, change, writeAuditHistory, type AuditWriter } from "@/server/ci/audit";
import { getUserAccessStore, type UserAccessRow, type UserAccessStore } from "@/server/ci/databricks/user-access";
import { resolveDirectoryUser, type ResolvedPerson } from "@/server/ci/user-access/resolve";
import { CI_TABLE_LABELS } from "@/server/db/schema";
import type { UserAccessEntry, UserAccessResponse } from "@/types/ci-api";

/**
 * The User Access screen, as in SAMBA (Admin > User Access): an ADD-ONLY list of the people added to the application,
 * on corp_marketing_dev.ci.ci_user_access (the table's own user_name and user_email columns). You pick a person from the
 * Microsoft directory (their email fills in); their name and email are saved. A person already in the table is refused
 * with SAMBA's wording, whichever of their addresses (mail or UPN) the row uses. There is no edit and no delete here.
 *
 * It is the first step of the sign-in gate: an Account Team person also needs an active row here (Corporate Marketing
 * does not, so someone can always open this screen) - see server/ci/authorization/ci-access.ts. Every add writes its
 * audit history entry FIRST (who added whom and when); if that fails nothing is saved.
 *
 * Only Corporate Marketing may list or add (with the development-login allowance User Management has); the person
 * recorded as Created By / Modified By is the verified signed-in user, never anything the browser sends.
 */

export const ACCESS_DUPLICATE_MESSAGE = "For the selected values, the user is already included in the Table.";
export const ACCESS_SELECT_MESSAGE = "Search and select a username from the organization directory.";

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const LOCALHOST_RE = /^[^\s@,;]+@localhost$/i;
/** A real address, or name@localhost in a development build only (the local development login's form). */
const emailOk = (email: string) => EMAIL_RE.test(email) || (process.env.NODE_ENV === "development" && LOCALHOST_RE.test(email));

export interface UserAccessServiceDeps {
  requireTables(): void;
  requireConnected(): void;
  authorize(identity: SessionIdentity): Promise<{ email: string; userName: string }>;
  store(): UserAccessStore;
  directoryUser(email: string, typedName: string): Promise<Pick<ResolvedPerson, "email" | "userName"> & Partial<Pick<ResolvedPerson, "aliases">>>;
  audit: AuditWriter;
}

const defaultDeps: UserAccessServiceDeps = {
  requireTables: () => requireTablesConfigured(STANDALONE_REQUIRES.userAccessView),
  requireConnected,
  authorize: (identity) => authorizeUserManagement(identity),
  store: () => {
    const s = getUserAccessStore();
    if (!s) throw new NotConfiguredError([CI_TABLE_LABELS.userAccess]);
    return s;
  },
  directoryUser: (email, typedName) => resolveDirectoryUser(email, typedName),
  audit: writeAuditHistory,
};

function toEntry(row: UserAccessRow): UserAccessEntry {
  return { id: row.id, name: row.name, email: row.email, createdOn: row.createdOn, modifiedBy: row.modifiedBy, modifiedOn: row.modifiedOn || row.createdOn };
}

/** Every person added, newest first (like SAMBA). Read-only. */
export async function listUserAccess(identity: SessionIdentity, deps: UserAccessServiceDeps = defaultDeps): Promise<UserAccessResponse> {
  deps.requireTables();
  deps.requireConnected();
  await deps.authorize(identity);
  return safely(async () => ({ entries: (await deps.store().list()).map(toEntry) }), "loaded");
}

/** Add ONE person. Order: tables and connection -> authorize -> validate -> directory check -> duplicate check -> audit entry -> save. */
export async function addUserAccessEntry(identity: SessionIdentity, body: unknown, deps: UserAccessServiceDeps = defaultDeps): Promise<{ entry: UserAccessEntry }> {
  deps.requireTables();
  deps.requireConnected();
  const actor = await deps.authorize(identity);
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof b.email !== "string" || typeof b.username !== "string" || !b.email.trim() || !b.username.trim()) throw new ValidationError([ACCESS_SELECT_MESSAGE]);
  return safely(async () => {
    const person = await deps.directoryUser(b.email as string, b.username as string);
    const email = person.email.trim().toLowerCase();
    const name = person.userName.trim() || email;
    if (!email || email.length > 254 || !emailOk(email)) throw new ValidationError(["The user's email is not a valid email address."]);
    if (name.length > 200) throw new ValidationError(["The user's name must be 200 characters or fewer."]);

    const store = deps.store();
    const aliases = person.aliases ?? [email];
    const existing = await store.list();
    if (existing.some((r) => aliases.includes(r.email))) throw new ConflictError(ACCESS_DUPLICATE_MESSAGE);

    const id = store.newId();
    await auditBeforeChange(deps.audit, [
      {
        entity: ENTITY_USER_ACCESS,
        recordId: id,
        action: "Created",
        changes: [change("User Name", "", name), change("User Email", "", email)],
        actionByName: actor.userName,
        actionByEmail: actor.email,
        at: store.now(),
      },
    ]);
    if (!(await store.add({ id, name, email, actor: actor.userName }))) throw new ConflictError(ACCESS_DUPLICATE_MESSAGE);
    const now = store.now();
    return { entry: toEntry({ id, name, email, createdBy: actor.userName, createdOn: now, modifiedBy: actor.userName, modifiedOn: now, active: true }) };
  }, "saved");
}

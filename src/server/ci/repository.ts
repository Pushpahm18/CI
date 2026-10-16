import type {
  AuditEntry,
  ChangeNote,
  CiUser,
  CiUserStatus,
  CompetitiveRecord,
  LookupValue,
  ReferenceData,
} from "@/types/ci";
import type { DataScope } from "@/lib/ci/rules";
import { NotConfiguredError } from "@/server/ci/errors";
import { pendingTables } from "@/server/ci/readiness";
import { CI_TABLE_LABELS, CI_TABLES, type CiTableKey, type CiTables } from "@/server/db/schema";
import { getLookupStore, type LookupStore } from "@/server/ci/databricks/lookups";
import { ENTITY_COMPETITIVE_INFO, getAuditHistoryStore, type AuditHistoryStore } from "@/server/ci/databricks/audit-history";
import { getChangeNoteStore, type ChangeNoteStore } from "@/server/ci/databricks/change-notes";
import { dependentListsFrom, getDependentLookupStore } from "@/server/ci/databricks/dependent-lookups";
import { getRecordStore, type RecordStore } from "@/server/ci/databricks/records";
import { getUserRecordStore, type UserRecordStore } from "@/server/ci/databricks/user-records";
import { ciUserFrom, decideCiAccess } from "@/server/ci/authorization/ci-access";

/**
 * Data access for CI — the ONLY layer that will talk to Databricks. Business
 * rules (scope, edit window, validation, audit, notification) live in
 * server/ci/services/*, so connecting the real tables later means
 * implementing this interface and nothing else.
 *
 * Every implementation must run its SQL through server/db/warehouse.ts
 * (server-only, forwarded-user-token / service-principal auth), build it with
 * server/db/sql.ts (sqlLiteral()/qCol(), buildMerge(), insertWithNewId() ...)
 * and map rows with server/db/row-values.ts — never string-concatenate raw
 * input. See docs/ci-technical-reference.md.
 */
export interface CiRepository {
  // users (BRD §7.6 User Management)
  findUserByEmail(email: string): Promise<CiUser | null>;
  getUser(id: string): Promise<CiUser | null>;
  listUsers(): Promise<CiUser[]>;
  createUser(user: Omit<CiUser, "id">): Promise<CiUser>;
  updateUser(user: CiUser): Promise<CiUser>;
  setUserStatus(id: string, status: CiUserStatus): Promise<void>;

  // competitive rows (BRD §8 main table)
  /**
   * Rows inside the caller's data scope (Customer AND Segment AND Fab Region;
   * "All" = no restriction). The Databricks implementation must apply this in
   * the WHERE clause, so out-of-scope rows never leave the database.
   */
  listRecords(scope: DataScope): Promise<CompetitiveRecord[]>;
  getRecord(recordId: string): Promise<CompetitiveRecord | null>;
  /** Batch read by Record ID (Bulk Update); unknown IDs are simply absent. */
  getRecords(recordIds: string[]): Promise<CompetitiveRecord[]>;
  /** Batch read by Application ID (Excel import's key); unknown ids are simply absent. */
  getRecordsByApplicationIds(applicationIds: string[]): Promise<CompetitiveRecord[]>;
  /** Inserts and returns the row with its system-assigned Record ID. */
  createRecord(record: Omit<CompetitiveRecord, "recordId">): Promise<CompetitiveRecord>;
  updateRecord(record: CompetitiveRecord): Promise<void>;
  /** Soft-deletes a row (is_active = FALSE; nothing is removed). Used only to undo a save whose change note or audit entry could not be written. */
  discardRecord(recordId: string): Promise<void>;
  /**
   * Batch writes for Import. Implementations must apply the whole batch or
   * nothing (e.g. one MERGE/INSERT statement or a staging-table promote), so
   * an import is never half-saved.
   */
  createRecords(records: Omit<CompetitiveRecord, "recordId">[]): Promise<CompetitiveRecord[]>;
  updateRecords(records: CompetitiveRecord[]): Promise<void>;
  /** Moves Created By ownership; returns the affected Record IDs. */
  reassignRecords(fromCreatedBy: string, toCreatedBy: string): Promise<string[]>;

  // change notes + audit (append-only)
  listNotes(recordId: string): Promise<ChangeNote[]>;
  addNotes(notes: Omit<ChangeNote, "id">[]): Promise<void>;
  listAudit(recordId: string): Promise<AuditEntry[]>;
  addAudit(entries: Omit<AuditEntry, "id">[]): Promise<void>;

  // lookups (BRD §7.6 Lookups / Sequential Dropdown Lookup)
  listLookups(): Promise<LookupValue[]>;
  /** `actor` = the signed-in person's name, recorded as Created By / Modified By where the table has them. */
  addLookup(category: string, value: string, sortOrder: number, actor?: string): Promise<LookupValue>;
  addLookups(items: { category: string; value: string; sortOrder: number }[], actor?: string): Promise<LookupValue[]>;
  renameLookup(id: string, value: string, actor?: string): Promise<void>;
  deactivateLookup(id: string, actor?: string): Promise<void>;
  reorderLookups(category: string, orderedIds: string[], actor?: string): Promise<void>;

  // reference data (BRD §7.6 Reference Data — read-only in this release)
  getReferenceData(): Promise<ReferenceData>;
}

/**
 * The tables each repository method reads or writes (names: server/db/schema.ts).
 * Typed over every method of CiRepository, so adding a method forces
 * declaring its tables. A Databricks implementation is added per table, only
 * once that table's name and columns are confirmed.
 */
export const REPOSITORY_METHOD_TABLES: Record<keyof CiRepository, readonly CiTableKey[]> = {
  findUserByEmail: ["users"],
  getUser: ["users"],
  listUsers: ["users"],
  createUser: ["users"],
  updateUser: ["users"],
  setUserStatus: ["users"],
  listRecords: ["competitiveInfo"],
  getRecord: ["competitiveInfo"],
  getRecords: ["competitiveInfo"],
  getRecordsByApplicationIds: ["competitiveInfo"],
  createRecord: ["competitiveInfo"],
  updateRecord: ["competitiveInfo"],
  discardRecord: ["competitiveInfo"],
  createRecords: ["competitiveInfo"],
  updateRecords: ["competitiveInfo"],
  reassignRecords: ["competitiveInfo"],
  listNotes: ["changeNotes"],
  addNotes: ["changeNotes"],
  listAudit: ["auditTrail"],
  addAudit: ["auditTrail"],
  listLookups: ["lookups"],
  addLookup: ["lookups"],
  addLookups: ["lookups"],
  renameLookup: ["lookups"],
  deactivateLookup: ["lookups"],
  reorderLookups: ["lookups"],
  getReferenceData: ["customerFabs", "competitorProducts", "processLocations", "technologyNodes"],
};

/**
 * A repository whose every method refuses. While a method's tables have no
 * configuration it names exactly those pending tables; if they are configured
 * but their Databricks integration has not been written yet, it says that
 * instead. It never returns data and never contacts Databricks. `tables` is
 * injectable so this can be tested without depending on the live schema.
 */
export function createRefusingRepository(tables: CiTables = CI_TABLES): CiRepository {
  function refuse(method: keyof CiRepository): never {
    const needed = REPOSITORY_METHOD_TABLES[method];
    const pending = pendingTables(needed, tables);
    if (pending.length > 0) throw new NotConfiguredError(pending);
    const labels = needed.map((k) => CI_TABLE_LABELS[k]).join(", ");
    throw new NotConfiguredError([], `The Databricks integration for ${labels} has not been implemented yet.`);
  }
  return Object.fromEntries(
    (Object.keys(REPOSITORY_METHOD_TABLES) as (keyof CiRepository)[]).map((method) => [method, async () => refuse(method)])
  ) as unknown as CiRepository;
}

/**
 * The repository the application uses until each table's Databricks
 * implementation exists. There is NO mock or sample-data fallback anywhere in
 * the application flow (test fixtures live in server/ci/testing and are
 * importable only by tests).
 */
const pendingRepository = createRefusingRepository();

/** The Databricks-backed parts that can be swapped into the repository; a part that is null (table not configured / no warehouse) keeps refusing. */
export interface RepositoryParts {
  records?: RecordStore | null;
  notes?: ChangeNoteStore | null;
  audit?: AuditHistoryStore | null;
  /** Read-only: the CI users, as the app's own user model. */
  users?: UserRecordStore | null;
  /** Customers + the dependent lists (Customer -> Fab, Competitor -> Product, ...), read from ci_lookup / ci_lookup_dependent. */
  referenceData?: (() => Promise<ReferenceData>) | null;
}

/** The valid, active CI users in a user-record list, as CiUser (the same strict rule as sign-in; invalid records are left out). */
export function usersFromRecords(records: Awaited<ReturnType<UserRecordStore["list"]>>): CiUser[] {
  const emails = Array.from(new Set(records.map((r) => r.email.trim().toLowerCase()).filter(Boolean)));
  const users: CiUser[] = [];
  for (const email of emails) {
    const d = decideCiAccess(records, email);
    if (d.allowed) users.push(ciUserFrom(d));
  }
  return users;
}

/**
 * The pending repository with each table's real implementation swapped in as it
 * is connected: Lookups (ci_lookup), plus - through `parts` - the competitive rows (ci_main), change notes
 * (ci_change_note), audit history (audit.ci_audit_history), the users (ci_user_management, read-only) and the
 * reference data. Everything else still refuses.
 */
export function composeRepository(base: CiRepository, lookups: LookupStore | null, parts: RepositoryParts = {}): CiRepository {
  let repo: CiRepository = base;
  if (lookups) {
    repo = {
      ...repo,
      listLookups: () => lookups.listLookups(),
      addLookup: (category, value, sortOrder, actor) => lookups.addLookup(category, value, sortOrder, actor),
      addLookups: (items, actor) => lookups.addLookups(items, actor),
      renameLookup: (id, value, actor) => lookups.renameLookup(id, value, actor),
      deactivateLookup: (id, actor) => lookups.deactivateLookup(id, actor),
      reorderLookups: (category, orderedIds, actor) => lookups.reorderLookups(category, orderedIds, actor),
    };
  }
  const { records, notes, audit, users, referenceData } = parts;
  if (records) {
    repo = {
      ...repo,
      listRecords: (scope) => records.listRecords(scope),
      getRecord: (id) => records.getRecord(id),
      getRecords: (ids) => records.getRecords(ids),
      getRecordsByApplicationIds: (ids) => records.getRecordsByApplicationIds(ids),
      createRecord: (record) => records.createRecord(record),
      createRecords: (items) => records.createRecords(items),
      updateRecord: (record) => records.updateRecord(record),
      updateRecords: (items) => records.updateRecords(items),
      discardRecord: (id) => records.discardRecord(id),
    };
  }
  if (notes) {
    repo = {
      ...repo,
      listNotes: (recordId) => notes.list(recordId),
      addNotes: (items) => notes.add(items.map((n) => ({ recordId: n.recordId, actionTakenBy: n.actionTakenBy, dateTime: n.dateTime, notes: n.notes }))),
    };
  }
  if (audit) {
    repo = {
      ...repo,
      listAudit: (recordId) => audit.list(ENTITY_COMPETITIVE_INFO, recordId),
      addAudit: (entries) =>
        audit.add(
          entries.map((e) => ({
            entity: ENTITY_COMPETITIVE_INFO,
            recordId: e.recordId,
            action: e.action,
            changes: e.changes,
            note: e.note,
            actionByName: e.actionTakenBy,
            actionByEmail: e.actorEmail,
            at: e.dateTime,
            importType: e.importType,
            sourceFile: e.sourceFile,
          }))
        ),
    };
  }
  if (users) {
    repo = {
      ...repo,
      listUsers: async () => usersFromRecords(await users.list()),
      findUserByEmail: async (email) => {
        const key = email.trim().toLowerCase();
        return (await repo.listUsers()).find((u) => u.email.toLowerCase() === key) ?? null;
      },
      getUser: async (id) => (await repo.listUsers()).find((u) => u.id === id) ?? null,
    };
  }
  if (referenceData) repo = { ...repo, getReferenceData: () => referenceData() };
  return repo;
}

/** Customers (ci_lookup) + the dependent lists (ci_lookup_dependent) as the app's reference data. */
function liveReferenceData(lookups: LookupStore): () => Promise<ReferenceData> {
  return async () => {
    const dependent = getDependentLookupStore();
    const [all, rows] = await Promise.all([lookups.listLookups(), dependent ? dependent.list() : Promise.resolve([])]);
    const dep = dependentListsFrom(rows);
    const customers = all.filter((l) => l.category === "Customer" && l.active).sort((a, b) => a.sortOrder - b.sortOrder).map((l) => l.value);
    return { customers, customerFabs: dep.customerFabs, competitorProducts: dep.competitorProducts, processLocations: dep.processLocations, technologyNodes: dep.technologyNodes };
  };
}

export function getCiRepository(): CiRepository {
  // PENDING: return a Databricks-backed repository, table by table, once the
  // real table names and columns have been provided and confirmed
  // (server/db/schema.ts). Until then every call is refused as above.
  const lookups = getLookupStore();
  return composeRepository(pendingRepository, lookups, {
    records: getRecordStore(),
    notes: getChangeNoteStore(),
    audit: getAuditHistoryStore(),
    users: getUserRecordStore(),
    referenceData: lookups ? liveReferenceData(lookups) : null,
  });
}

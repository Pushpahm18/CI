import { CI_TABLE_LABELS, CI_TABLES, type CiTableKey, type CiTables } from "@/server/db/schema";
import { NotConfiguredError } from "@/server/ci/errors";

/**
 * Per-table readiness: which CI tables a request needs, and which of them are
 * still pending (no configuration in server/db/schema.ts). A request that
 * needs a pending table is refused up front with
 * "CI database table configuration is pending: <table names>" — it never
 * falls back to sample data, and no query is attempted.
 */

/**
 * Tables each API route needs, taken from the repository calls its service
 * makes (server/ci/services/*). Every route needs `users`, because the
 * signed-in person's role and scope are resolved from it first.
 *
 * Notes:
 *  - importRun covers both Preview and Commit (the route serves both); Preview
 *    alone does not use change notes or the audit trail.
 *  - lookups "in use" counts read competitive rows, so lookupsView needs them.
 */
export const REQUIRES = {
  // The user is resolved from ci_user_management (userManagement); reference data comes from ci_lookup_dependent.
  competitiveInfoList: ["userManagement", "competitiveInfo"],
  competitiveInfoRecord: ["userManagement", "competitiveInfo", "changeNotes"],
  competitiveInfoAudit: ["userManagement", "competitiveInfo", "auditTrail"],
  competitiveInfoFormOptions: ["userManagement", "lookups", "dependentLookups"],
  competitiveInfoSave: ["userManagement", "competitiveInfo", "changeNotes", "auditTrail", "lookups", "dependentLookups"],
  importRun: [
    "users",
    "competitiveInfo",
    "changeNotes",
    "auditTrail",
    "lookups",
    "customerFabs",
    "competitorProducts",
    "processLocations",
    "technologyNodes",
  ],
  lookupsView: ["users", "lookups", "competitiveInfo"],
  lookupsWrite: ["users", "lookups"],
  referenceData: ["users", "customerFabs", "competitorProducts", "processLocations", "technologyNodes"],
  // Repository-based CI user administration (the User Management screen itself
  // reads the shared table directly and does not use these).
  userAdminList: ["users", "competitiveInfo"],
  userAdminSave: ["users"],
  userAdminOffboardPreview: ["users", "competitiveInfo"],
  userAdminOffboard: ["users", "competitiveInfo", "auditTrail"],
} as const satisfies Record<string, readonly CiTableKey[]>;

export type CiRequirement = keyof typeof REQUIRES;

/**
 * Features with their own repository (not CiRepository) and no dependency on the
 * CI users table: the tables each needs. Login History reads and records
 * sign-ins itself (server/ci/login-history). Lookups reads and maintains the
 * dropdown lists itself (server/ci/lookups, on ci_lookup).
 */
export const STANDALONE_REQUIRES = {
  loginHistoryView: ["loginHistory"],
  lookupsView: ["lookups"],
  userRecordsView: ["userManagement"],
  // The User Access screen reads and adds to ci_user_access; the sign-in gate also reads it for Account Team.
  userAccessView: ["userAccess"],
  dependentLookupsView: ["dependentLookups"],
} as const satisfies Record<string, readonly CiTableKey[]>;

/** Human-readable names of the tables in `keys` that have no configuration yet. */
export function pendingTables(keys: readonly CiTableKey[], tables: CiTables = CI_TABLES): string[] {
  return Array.from(new Set(keys)).filter((k) => tables[k] === null).map((k) => CI_TABLE_LABELS[k]);
}

/** Throws NotConfiguredError naming every pending table in `keys`; returns when all are configured. */
export function requireTablesConfigured(keys: readonly CiTableKey[], tables: CiTables = CI_TABLES): void {
  const pending = pendingTables(keys, tables);
  if (pending.length > 0) throw new NotConfiguredError(pending);
}

/** Every table some screen needs and that is still pending (for the health check). */
export function pendingRequiredTables(tables: CiTables = CI_TABLES): string[] {
  const needed = new Set<CiTableKey>([...Object.values(REQUIRES).flat(), ...Object.values(STANDALONE_REQUIRES).flat()]);
  return pendingTables(Array.from(needed), tables);
}

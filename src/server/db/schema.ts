/**
 * CENTRAL DATABRICKS SCHEMA — the one place every Databricks table name and
 * column name is written. Queries, mappers and services refer to these
 * constants (directly or through a thin alias) and never repeat a name, so a
 * backend rename is a one-line change here.
 *
 * Rules:
 *  - Names are server-side constants. They are never read from a request,
 *    the browser or an environment variable.
 *  - Every name is validated as a plain SQL identifier when this module loads
 *    (assertIdentifier), so a typo fails loudly instead of producing bad SQL.
 *    Values are still escaped with sqlLiteral() and names quoted with
 *    qCol()/qTable() in server/db/sql.ts.
 *  - Application code uses stable property names (`segment`, `userName`);
 *    only this file knows the Databricks name behind them (`sb_ServerMarket`).
 *  - A CI table is added below ONLY when the backend team has named it AND its
 *    columns are confirmed. CI uses corp_marketing_dev.ci only; no SAMBA table is named here.
 */

import { WAFER_SIZE_COLUMN, WAFER_SIZE_LABELS } from "@/lib/ci/wafer-size";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Returns `name` when it is a plain SQL identifier (letters, digits, underscore); throws otherwise. */
export function assertIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Invalid SQL identifier: ${JSON.stringify(name)}`);
  return name;
}

export interface TableRef {
  catalog: string;
  schema: string;
  table: string;
}

/** "catalog.schema.table", with each part validated. */
export function tableName(ref: TableRef): string {
  return [ref.catalog, ref.schema, ref.table].map(assertIdentifier).join(".");
}

// ---------------------------------------------------------------------------
// All Competitive Info gallery source — IN USE (read-only). The gallery shows
// whatever columns this table actually has (DESCRIBE at request time), so no
// column name is written anywhere in the code. Change catalog / schema / table
// here and the gallery follows. Set to null to switch the gallery off
// ("configuration is pending").
// ---------------------------------------------------------------------------

export const COMPETITIVE_GALLERY_SOURCE: TableRef | null = { catalog: "corp_marketing_dev", schema: "ci", table: "ci_main" };

/**
 * The ci_main columns an Account Team user's scope is matched against (verified
 * against the live table): Customer, Segment (= Served Market) and Region
 * (= Fab Region, stored as codes such as KOR / CHN / US / TWN / JPN).
 */
export const MAIN_SCOPE_COLUMNS = { customer: "customer", segment: "served_market", region: "fab_region" } as const;

/** Label used in the "configuration is pending" message when the source above is null. */
export const COMPETITIVE_GALLERY_LABEL = "All Competitive Info table";

// ---------------------------------------------------------------------------
// CI tables — PENDING. None has been named yet, so none is connected.
// ---------------------------------------------------------------------------

export type CiTableKey =
  | "competitiveInfo"
  | "changeNotes"
  | "auditTrail"
  | "users"
  | "lookups"
  | "dependentLookups"
  | "userManagement"
  | "userAccess"
  | "customerFabs"
  | "competitorProducts"
  | "processLocations"
  | "technologyNodes"
  | "loginHistory"
  | "importStaging";

/** Human-readable names, used in the "configuration is pending" messages. */
export const CI_TABLE_LABELS: Record<CiTableKey, string> = {
  competitiveInfo: "Competitive Info",
  changeNotes: "Change Notes",
  auditTrail: "Audit Trail",
  users: "CI Users",
  lookups: "Lookups",
  dependentLookups: "Dependent Lookups",
  userManagement: "CI User Management",
  userAccess: "CI User Access",
  customerFabs: "Reference Data: Customers and Fabs",
  competitorProducts: "Reference Data: Competitors and Products",
  processLocations: "Reference Data: Process Locations",
  technologyNodes: "Reference Data: Technology Nodes",
  loginHistory: "Login History",
  importStaging: "Import Staging",
};

export type CiTables = Record<CiTableKey, TableRef | null>;

/**
 * `null` = pending: the backend team has not provided this table yet, so any
 * screen that needs it reports "CI database table configuration is pending".
 * Replace a `null` with { catalog, schema, table } (and add its confirmed
 * columns beside it) only when the real details are known.
 *
 * `importStaging` is not required by any screen yet.
 */
export const CI_TABLES: CiTables = {
  // ci_main: the competitive rows (columns: server/db/main-columns.ts).
  competitiveInfo: { catalog: "corp_marketing_dev", schema: "ci", table: "ci_main" },
  // Change notes live in ci; the audit history lives in the separate `audit` schema (the write guard allows exactly that one table).
  changeNotes: { catalog: "corp_marketing_dev", schema: "ci", table: "ci_change_note" },
  auditTrail: { catalog: "corp_marketing_dev", schema: "audit", table: "ci_audit_history" },
  users: null,
  lookups: { catalog: "corp_marketing_dev", schema: "ci", table: "ci_lookup" },
  dependentLookups: { catalog: "corp_marketing_dev", schema: "ci", table: "ci_lookup_dependent" },
  // Read-only access to ci_user_management only. `users` (which drives CI sign-in authorization) stays pending on purpose.
  userManagement: { catalog: "corp_marketing_dev", schema: "ci", table: "ci_user_management" },
  // User Access (SAMBA-style, add-only): the people added to the application, with name and email. Columns: USER_ACCESS_COLUMNS.
  userAccess: { catalog: "corp_marketing_dev", schema: "ci", table: "ci_user_access" },
  customerFabs: null,
  competitorProducts: null,
  processLocations: null,
  technologyNodes: null,
  // Login History lives in the separate `audit` schema (the write guard allows INSERT into exactly this table and the audit history).
  loginHistory: { catalog: "corp_marketing_dev", schema: "audit", table: "ci_login_history" },
  importStaging: null,
};

/**
 * The columns CI's Login History table must provide: each logical field the
 * screen shows or records, mapped to its physical column name. The screen is
 * modelled on SAMBA's Login History (who signed in and when), so these four
 * are what it needs; add a column here only if the real CI table also
 * requires one to insert a row.
 *
 * PENDING-CI-TABLE: null until the backend team names the table
 * (CI_TABLES.loginHistory) AND confirms these four columns. While either is
 * null the screen reports "CI database table configuration is pending: Login
 * History" and nothing is read or recorded.
 */
export interface LoginHistoryColumns {
  /** Unique row id. */
  id: string;
  /** Email address of the person who signed in. */
  email: string;
  /** Display name of the person who signed in. */
  name: string;
  /** When they signed in (a timestamp column). */
  loginTime: string;
  /**
   * Optional columns (CI Prototype Login History: Role, Event, Result, Device,
   * IP address, Note). A column is read, shown and written ONLY when it is named
   * here, so the screen never invents data for a column the table does not have.
   */
  role?: string;
  event?: string;
  result?: string;
  device?: string;
  ipAddress?: string;
  note?: string;
  /** Written with the same time as the sign-in (the table has this column). Never shown. */
  createdOn?: string;
}

/** corp_marketing_dev.audit.ci_login_history, columns verified with DESCRIBE TABLE; none added or invented. */
export const LOGIN_HISTORY_COLUMNS: LoginHistoryColumns | null = {
  id: "login_id",
  email: "user_email",
  name: "user_name",
  loginTime: "login_timestamp",
  role: "role_name",
  event: "event_type",
  result: "result",
  device: "device_info",
  ipAddress: "ip_address",
  note: "note",
  createdOn: "created_on",
};

/**
 * Lookups (dropdown lists) — CI_TABLES.lookups = corp_marketing_dev.ci.ci_lookup.
 * Column names verified against the live table definition (information_schema).
 * One row per list value: `type` is the list (category) name exactly as the
 * Lookups screen shows it, `order` is the Sequential Dropdown position.
 */
export const LOOKUP_COLUMNS = {
  id: "lookup_id",
  type: "lookup_type",
  value: "lookup_value",
  order: "display_order",
  active: "is_active",
  createdBy: "created_by",
  createdOn: "created_on",
  modifiedBy: "modified_by",
  modifiedOn: "modified_on",
} as const;

/**
 * Which ci_main column holds each list's value, for the "used by N rows" count
 * on the Lookups screen. `null` = no count shown for that list. `numericLabels`
 * counts a numeric column under list labels (Wafer Size).
 * `asText` casts a non-text column (Year is an integer) before comparing.
 */
export const LOOKUP_USAGE_COLUMNS: Record<string, { column: string; asText?: boolean; numericLabels?: Readonly<Record<number, string>> } | null> = {
  Quarter: { column: "quarter" },
  Year: { column: "year", asText: true },
  Customer: { column: "customer" },
  "Served Market": { column: "served_market" },
  // Approved mapping (lib/ci/wafer-size.ts): stored 150 / 200 / 300 count under the matching list label.
  "Wafer Size": { column: WAFER_SIZE_COLUMN, numericLabels: WAFER_SIZE_LABELS },
  "Process Type": { column: "process_type" },
  "Process Location": { column: "process_location" },
  "Top Competitor": { column: "top_competitor" },
  "Product Line": { column: "product_line" },
  "Process Modules (#)": { column: "process_modules" },
  "Tool Type": { column: "tool_type" },
  Currency: { column: "currency" },
  "Order Type": { column: "order_type" },
  "Fab Region": { column: "fab_region" },
};

/**
 * Dependent lookups — CI_TABLES.dependentLookups = corp_marketing_dev.ci.ci_lookup_dependent.
 * Column names verified against the live table definition. Up to two parents
 * and one child per row. The parent_type / child_type STRINGS that mean
 * "Customer → Fab Location" etc. are NOT defined anywhere in code: they are
 * pending approval, so rows are read raw and never interpreted.
 */
export const DEPENDENT_LOOKUP_COLUMNS = {
  id: "dependent_lookup_id",
  parentType1: "parent_type_1",
  parentValue1: "parent_value_1",
  parentType2: "parent_type_2",
  parentValue2: "parent_value_2",
  childType: "child_type",
  childValue: "child_value",
  order: "display_order",
  active: "is_active",
  // Audit columns (verified with DESCRIBE TABLE on ci_lookup_dependent).
  createdBy: "created_by",
  createdOn: "created_on",
  modifiedBy: "modified_by",
  modifiedOn: "modified_on",
} as const;

/**
 * CI user records — CI_TABLES.userManagement = corp_marketing_dev.ci.ci_user_management.
 * Read-only. Which column decides access (status or is_active), whether a
 * person has one row or several, and how scope is stored are all undecided, so
 * values are returned exactly as stored.
 */
export const CI_USER_COLUMNS = {
  id: "ci_user_id",
  userName: "user_name",
  email: "user_email",
  role: "role_name",
  customer: "customer",
  segment: "segment",
  region: "region",
  status: "status",
  lastSignIn: "last_sign_in",
  active: "is_active",
  createdBy: "created_by",
  createdOn: "created_on",
  modifiedBy: "modified_by",
  modifiedOn: "modified_on",
} as const;

/**
 * Change notes — CI_TABLES.changeNotes = corp_marketing_dev.ci.ci_change_note. Columns verified with DESCRIBE
 * TABLE; no column is added or invented. One row per note on a competitive row (`ci_id` = ci_main.ci_id).
 */
export const CHANGE_NOTE_COLUMNS = {
  id: "change_note_id",
  recordId: "ci_id",
  actionTakenBy: "action_taken_by",
  actionTimestamp: "action_timestamp",
  notes: "additional_notes",
  createdBy: "created_by",
  createdOn: "created_on",
  modifiedBy: "modified_by",
  modifiedOn: "modified_on",
  active: "is_active",
} as const;

/**
 * Audit history — CI_TABLES.auditTrail = corp_marketing_dev.audit.ci_audit_history. Columns verified with DESCRIBE
 * TABLE; no column is added or invented. One row per changed field: `entity_name` says what changed (for example
 * "Competitive Info" or "User") and `record_id` which record.
 */
export const AUDIT_HISTORY_COLUMNS = {
  id: "audit_id",
  entity: "entity_name",
  recordId: "record_id",
  action: "action_taken",
  field: "field_name",
  oldValue: "old_value",
  newValue: "new_value",
  comments: "comments",
  actionBy: "action_by",
  actionTimestamp: "action_timestamp",
  createdBy: "created_by",
  createdOn: "created_on",
  modifiedBy: "modified_by",
  modifiedOn: "modified_on",
} as const;

/**
 * User Access — CI_TABLES.userAccess = corp_marketing_dev.ci.ci_user_access. Columns verified with DESCRIBE TABLE; none added.
 * One row per person added on the User Access screen (SAMBA's samba_user, in CI's own table): their name and email, plus
 * who added them and when.
 */
export const USER_ACCESS_COLUMNS = {
  id: "ci_user_access_id",
  userName: "user_name",
  email: "user_email",
  createdBy: "created_by",
  createdOn: "created_on",
  modifiedBy: "modified_by",
  modifiedOn: "modified_on",
  active: "is_active",
} as const;

/** The fully-qualified name of a configured CI table, or null while it is pending. */
export function ciTableName(key: CiTableKey, tables: CiTables = CI_TABLES): string | null {
  const ref = tables[key];
  return ref ? tableName(ref) : null;
}

// ---------------------------------------------------------------------------
// Validate every configured name once, when the module loads.
// ---------------------------------------------------------------------------

(Object.keys(CI_TABLES) as CiTableKey[]).forEach((key) => ciTableName(key));
/** A configured Login History column mapping must be plain identifiers; null (pending) is fine. */
export function assertLoginHistoryColumns(columns: LoginHistoryColumns | null): void {
  if (columns) Object.values(columns).filter((v): v is string => typeof v === "string").forEach(assertIdentifier);
}
assertLoginHistoryColumns(LOGIN_HISTORY_COLUMNS);
if (COMPETITIVE_GALLERY_SOURCE) tableName(COMPETITIVE_GALLERY_SOURCE);
Object.values(LOOKUP_COLUMNS).forEach(assertIdentifier);
Object.values(DEPENDENT_LOOKUP_COLUMNS).forEach(assertIdentifier);
Object.values(MAIN_SCOPE_COLUMNS).forEach(assertIdentifier);
Object.values(CI_USER_COLUMNS).forEach(assertIdentifier);
Object.values(CHANGE_NOTE_COLUMNS).forEach(assertIdentifier);
Object.values(USER_ACCESS_COLUMNS).forEach(assertIdentifier);
Object.values(AUDIT_HISTORY_COLUMNS).forEach(assertIdentifier);
Object.values(LOOKUP_USAGE_COLUMNS).forEach((u) => u && assertIdentifier(u.column));
Object.keys(WAFER_SIZE_LABELS).forEach((k) => { if (!Number.isFinite(Number(k))) throw new Error("Invalid wafer size mapping."); });



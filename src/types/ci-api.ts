import type {
  AuditEntry,
  ChangeNote,
  CiRole,
  CiUser,
  CompetitiveInput,
  CompetitiveRecord,
  FormOptions,
  LookupValue,
  ReferenceData,
  ScopeValue,
} from "@/types/ci";
import type { HistoricOptions, ParsedSheet } from "@/lib/ci/import/types";

/** Error codes every CI API route can return alongside an HTTP status. */
export type ApiErrorCode =
  | "NOT_CONFIGURED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "EDIT_WINDOW_CLOSED"
  | "CONFLICT"
  | "DISABLED"
  | "INTERNAL";

export interface ApiErrorBody {
  error: string;
  code: ApiErrorCode;
  details?: string[];
}

/**
 * GET /api/session. `dataStatus` tells the UI whether the CI database is
 * reachable at all, separately from whether this person has a CI role.
 */
export interface SessionResponse {
  email: string;
  name: string;
  dataStatus: "connected" | "not-configured" | "error";
  /** Null while the database isn't connected, or when no User Management record matches. */
  user: CiUser | null;
}

/** One of the most recently updated rows on Home. */
export interface HomeRecentRow {
  recordId: string;
  /** ci_main.application_id as stored (shown on Home instead of the long record id; "" when the row has none). */
  applicationId: string;
  customer: string;
  servedMarket: string;
  quarter: string;
  year: string;
  /** ISO date or date-time of the last change (modified, else created). */
  updatedAt: string;
}

export interface HomeResponse {
  /** Live rows in the person's view. */
  rows: number;
  customers: number;
  competitors: number;
  recent: HomeRecentRow[];
}

export interface RecordsResponse {
  records: CompetitiveRecord[];
  /** Competitive FF only: true when the table holds more live rows than \`rowLimit\` and the rest were not loaded. */
  truncated?: boolean;
  rowLimit?: number;
}

export interface RecordDetailResponse {
  record: CompetitiveRecord;
  notes: ChangeNote[];
}

export interface SaveRecordRequest {
  input: CompetitiveInput;
  /** New Change Note(s); the first is mandatory. */
  notes: string[];
}

export interface SaveRecordResponse {
  record: CompetitiveRecord;
  notification: NotificationOutcome;
}

/** Email delivery is pending configuration — this never claims an email was sent when it wasn't. */
export interface NotificationOutcome {
  recipients: number;
  delivered: boolean;
}

export interface AuditResponse {
  entries: AuditEntry[];
}

/** The cascading lists exactly as stored in ci_lookup_dependent, in display order; `issues` names rows that were left out. */
export interface DependentListsResponse {
  customerFabs: ReferenceData["customerFabs"];
  competitorProducts: ReferenceData["competitorProducts"];
  processLocations: ReferenceData["processLocations"];
  technologyNodes: ReferenceData["technologyNodes"];
  /** Every row with its id, for editing and ordering. */
  entries: DependentEntryDto[];
  issues: string[];
}

export interface DependentEntryDto {
  id: string;
  list: "comp" | "proc" | "fab" | "node";
  parent1: string;
  parent2: string;
  value: string;
  region?: string;
  sortOrder: number;
}

export interface DependentAddRequest {
  list: DependentEntryDto["list"];
  parent1: string;
  parent2?: string;
  value: string;
  region?: string;
}

export type FormOptionsResponse =FormOptions & {
  /** Dropdowns that cannot be offered yet (source or mapping not approved); shown to the user, never filled with sample values. */
  pendingSources: string[];
};

/** One ci_user_management row exactly as stored — no access or scope interpretation. */
export interface CiUserRecordRaw {
  id: string;
  userName: string;
  email: string;
  role: string;
  customer: string;
  segment: string;
  region: string;
  status: string;
  lastSignIn: string;
  /** true / false as stored; null when the column is NULL or unreadable. */
  isActive: boolean | null;
  /** modified_by as stored ("" when blank). */
  modifiedBy?: string;
  /** modified_on as an ISO timestamp ("" when blank). */
  modifiedOn?: string;
}

/** POST / PUT / DELETE / reactivate on /api/user-management/ci-users */
export interface CiUserWriteResponse {
  user: CiUserRecordRaw;
}

/** GET /api/user-management/ci-users */
export interface CiUserRecordsResponse {
  users: CiUserRecordRaw[];
  /** Live ci_main rows per created_by name, counted by Databricks. Absent when ci_main could not be read. */
  ownedRows?: Record<string, number>;
}

/** GET /api/user-management/ci-users/{id}/offboard: rows the leaver created, or why they cannot be off-boarded. */
export interface CiOffboardPreviewResponse {
  ownedRows: number;
  blocked: string | null;
}

/** GET /api/user-management/ci-users/{id}/offboard-details: who took over, read from the audit history. */
export type CiOffboardDetailsResponse =
  | { found: false; leaverName: string }
  | {
      found: true;
      leaverName: string;
      newOwner: { name: string; email: string; role: string };
      rows: number;
      at: string;
      by: string;
      /** The new owner's scope before and after it was combined with the leaver's (empty when no scope changed). */
      scope: { label: string; before: string; after: string }[];
      scopeCombined: boolean;
    };

/** POST /api/user-management/ci-users/{id}/offboard */
export interface CiOffboardResponse {
  reassignedRows: number;
  user: CiUserRecordRaw;
  newOwner: CiUserRecordRaw;
}

/** POST /api/competitive-info/import — see lib/ci/import/types.ts for the preview/result shapes. */
export interface ImportApiRequest {
  importType: "historic" | "bulk" | "excel";
  mode: "preview" | "commit";
  sheet: ParsedSheet;
  /** Historic Load only. */
  options?: HistoricOptions;
  /** Bulk Update only: the Change Note applied to every updated row (unless the file has its own). */
  changeNote?: string;
}

export interface UsersResponse {
  users: CiUser[];
  /** User id → number of rows they own (Created By) — CI Prototype "Rows owned". */
  ownedRows: Record<string, number>;
}

export interface SaveUserRequest {
  name: string;
  email: string;
  role: CiRole;
  customerScope: ScopeValue;
  segmentScope: ScopeValue;
  regionScope: ScopeValue;
}

export interface OffboardPreviewResponse {
  ownedRows: number;
}

export interface OffboardRequest {
  reassignToUserId: string;
}

export interface OffboardResponse {
  reassignedRows: number;
}

export interface LookupsResponse {
  lookups: LookupValue[];
  /** "Category|Value" → number of rows using it (CI Prototype "used by N rows"). */
  usage: Record<string, number>;
  /** The lists whose "used by N rows" count is available (a list without one shows no count rather than 0). */
  usageCategories: string[];
}

export interface AddLookupRequest {
  category: string;
  value: string;
}

export interface ReorderLookupsRequest {
  category: string;
  orderedIds: string[];
}

export type ReferenceDataResponse = ReferenceData;

/** One person on the User Access screen (a row of ci_user_access). */
export interface UserAccessEntry {
  id: string;
  name: string;
  email: string;
  createdOn: string;
  modifiedBy: string;
  modifiedOn: string;
}

/** GET /api/user-access */
export interface UserAccessResponse {
  entries: UserAccessEntry[];
}

/** One Microsoft Entra ID directory user (id, display name, user principal name only). */
export interface DirectoryUser {
  id: string;
  displayName: string;
  userPrincipalName: string;
  /** The mail attribute, "" when the person has none. */
  mail: string;
  /** The email CI saves and matches at sign-in: mail when present, otherwise the user principal name (lib/ci/identity-email.ts). */
  email: string;
}

export interface DirectoryUsersResponse {
  users: DirectoryUser[];
  /** False when the Entra settings (AZURE_TENANT_ID / CLIENT_ID / CLIENT_SECRET) are missing on the server. */
  configured: boolean;
  /** True only in local development: lets the form take a name and email by hand while directory search is unconfigured. */
  manualEntryAllowed: boolean;
  /** Why the directory could not be read (local development only; elsewhere the request fails with this message). */
  unavailable?: string;
}

// ---------------------------------------------------------------------------
// Login History (server/ci/login-history): who signed in, and when. Read-only
// on screen; rows are recorded when a sign-in completes.
// ---------------------------------------------------------------------------

export interface LoginHistoryRecord {
  id: string;
  /** Email of the person who signed in. */
  email: string;
  /** Display name of the person who signed in. */
  name: string;
  /** ISO timestamp of the sign-in ("" when the row has none). */
  loginTime: string;
  /** Present only when the CI Login History table has that optional column (see LoginHistoryColumns). */
  role?: string;
  event?: string;
  result?: string;
  device?: string;
  ipAddress?: string;
  note?: string;
}

/** The optional Login History columns a table may carry, in display order. */
export type LoginHistoryOptionalColumn = "role" | "event" | "result" | "device" | "ipAddress" | "note";

export interface LoginHistoryResponse {
  records: LoginHistoryRecord[];
  /** "all" = every user's sign-ins (Corporate Marketing); "own" = only the signed-in person's (everyone else). */
  scope: "all" | "own";
  /** Which optional columns the configured table has (so the screen only shows real ones). */
  optionalColumns: LoginHistoryOptionalColumn[];
}

/** One column of the configured All Competitive Info table, as the database reports it. */
export interface GalleryColumn {
  name: string;
  type: string;
}

/** The All Competitive Info gallery: the configured table's real columns and rows (read-only). */
export interface GalleryResponse {
  /** catalog.schema.table the data was read from. */
  table: string;
  columns: GalleryColumn[];
  /** Column name → value as text ("" for NULL). */
  rows: Record<string, string>[];
  /** True when the table holds more rows than the screen loads. */
  truncated: boolean;
  rowLimit: number;
}

/** What deactivating an independent dropdown value (Customer, Served Market, Top Competitor, Fab Region) also deactivates. */
export interface LookupDeactivationImpact {
  category: string;
  value: string;
  /** Active dependent mappings that will be deactivated with the value. */
  total: number;
  /** Identifies exactly these rows; sent back with the confirmation so the server can tell if they changed since the review. */
  fingerprint: string;
  groups: { label: string; count: number; /** The first few, for the confirmation (count is the full number). */ names: string[] }[];
}

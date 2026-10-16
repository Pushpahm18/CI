// Competitive Intelligence (CI) domain types — CI BRD (CI-BRD-001) and the
// CI Prototype are the source of truth for every shape here. Persistence
// shapes (Databricks tables/columns) are deliberately NOT modelled here:
// the CI tables don't exist yet, so server/ci/repository.ts maps to them
// once their real structure is provided.

/**
 * BRD 1.1 §4: two business roles and no separate Admin role — Corporate
 * Marketing also sets up and manages users. One role per user (CI Prototype).
 */
export type CiRole = "Sales" | "CM";

export const CI_ROLES: CiRole[] = ["Sales", "CM"];

export const CI_ROLE_LABELS: Record<CiRole, string> = {
  Sales: "Account Team",
  CM: "Corporate Marketing",
};

/** A scope list, or "All" (the User Management scope convention). */
export type ScopeValue = string[] | "All";

export type CiUserStatus = "Active" | "Off-boarded";

export interface CiUser {
  id: string;
  name: string;
  email: string;
  role: CiRole;
  /** BRD 1.1 §4: rows are scoped by Customer… */
  customerScope: ScopeValue;
  /** …Segment (= Served Market, BRD glossary)… */
  segmentScope: ScopeValue;
  /**
   * …and Region. BRD 1.1 open item 7: "Region (Fab Region) is added to a
   * user's scope alongside Customer and Segment, and all three must match" —
   * matched against the row's Fab Region; values come from the fab master.
   */
  regionScope: ScopeValue;
  status: CiUserStatus;
}

/** One competitive row — the 24 fields of the CI Prototype (BRD §7.2) plus the system Record ID. */
export interface CompetitiveRecord {
  recordId: string;
  /** ci_main.application_id as stored (CI-0001, ...): the id people see and use in Excel imports. Absent on a row not yet saved. */
  applicationId?: string;
  quarter: string;
  year: string;
  customer: string;
  fabLocation: string;
  /** System-filled from Fab Location (read-only). */
  fabRegion: string;
  servedMarket: string;
  technologyNode: string;
  waferSize: string;
  processApplication: string;
  processType: string;
  processLocation: string;
  /** The only optional user-entered field. */
  films: string;
  productLine: string;
  topCompetitor: string;
  /** Competitor product — a cascade of Top Competitor (CI Prototype: one Product Name field). */
  productName: string;
  processModules: string;
  orderType: string;
  actualOrder: number;
  asp: number;
  currency: string;
  /** System-calculated: Actual Order x ASP, in millions of Currency. */
  revenue: number;
  toolType: string;
  /** Autofilled with the signed-in user on save; not editable. */
  createdBy: string;
  /** Autofilled with the entry date (ISO yyyy-mm-dd). */
  createdOn: string;
  modifiedBy?: string;
  modifiedOn?: string;
}

/** The fields a user enters on Add/Edit (20 user-entered fields). */
export type CompetitiveInput = Omit<
  CompetitiveRecord,
  "recordId" | "fabRegion" | "revenue" | "createdBy" | "createdOn" | "modifiedBy" | "modifiedOn"
>;

/** Change Note grid row (BRD §5.3: Action Taken By, Date & Time, Additional Notes). */
export interface ChangeNote {
  id: string;
  recordId: string;
  actionTakenBy: string;
  dateTime: string;
  notes: string;
}

export type AuditAction = "Created" | "Edited" | "Imported" | "Reassigned";

export interface FieldChange {
  field: string;
  label: string;
  previous: string;
  current: string;
}

/** Append-only audit entry (BRD §7.3). */
export interface AuditEntry {
  id: string;
  recordId: string;
  action: AuditAction;
  actionTakenBy: string;
  /** Email of the person who made the change, where known. */
  actorEmail?: string;
  dateTime: string;
  changes: FieldChange[];
  note: string;
  /** Set for changes made through Import (BRD §7.5). */
  importType?: "Historic Load" | "Bulk Update" | "Excel Import";
  sourceFile?: string;
}

export interface LookupValue {
  id: string;
  category: string;
  value: string;
  /** Sequential Dropdown Lookup order (lower first). */
  sortOrder: number;
  /** Removing a value keeps it on existing rows; it only stops appearing in new dropdowns (CI Prototype). */
  active: boolean;
}

export interface CustomerFab {
  customer: string;
  fabLocation: string;
  fabRegion: string;
}

export interface CompetitorProduct {
  competitor: string;
  product: string;
}

export interface MarketProcessLocation {
  servedMarket: string;
  processLocation: string;
}

export interface CustomerMarketNode {
  customer: string;
  servedMarket: string;
  technologyNode: string;
}

/** BRD §7.6 Reference Data: the cascading lists. Read-only in this release. */
export interface ReferenceData {
  customers: string[];
  customerFabs: CustomerFab[];
  competitorProducts: CompetitorProduct[];
  processLocations: MarketProcessLocation[];
  technologyNodes: CustomerMarketNode[];
}

export interface FormOptions {
  lookups: LookupValue[];
  reference: ReferenceData;
}

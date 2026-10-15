import type { CompetitiveRecord } from "@/types/ci";

/**
 * The 25-column CI data specification (BRD §7.2), in the BRD's column order,
 * with the column labels the CI Prototype uses on its grid and form. One
 * definition shared by the grid, the Add/Edit form, Export, Import and
 * server-side validation so they can never drift apart.
 */

export type FieldKey = Exclude<keyof CompetitiveRecord, "recordId" | "modifiedBy" | "modifiedOn">;

/** How the field is entered on the Add/Edit form (CI Prototype FORM spec). */
export type InputKind = "select" | "cascade" | "text" | "number" | "auto";

/** How the grid's column filter works (CI Prototype: dropdown for list columns, text for the rest). */
export type FilterKind = "select" | "text";

export interface FieldSpec {
  key: FieldKey;
  label: string;
  input: InputKind;
  /** User-entered and mandatory (BRD §7.2: 20 mandatory, Film(s) optional). */
  mandatory: boolean;
  filter: FilterKind;
  numeric?: boolean;
  /** Lookups category feeding a plain dropdown (BRD Appendix A / CI Prototype lists). */
  lookupCategory?: string;
}

export const LOOKUP_CATEGORIES = [
  "Quarter",
  "Year",
  "Customer",
  "Served Market",
  "Wafer Size",
  "Process Type",
  "Process Location",
  "Top Competitor",
  "Product Line",
  "Process Modules (#)",
  "Tool Type",
  "Currency",
  "Order Type",
  "Fab Region",
] as const;

/** Independent lists whose deactivation also deactivates dependent mappings, so it needs a confirmation that shows the impact. */
export const CASCADING_CATEGORIES = ["Customer", "Served Market", "Top Competitor", "Fab Region"] as const;
export const isCascadingCategory = (category: string) => (CASCADING_CATEGORIES as readonly string[]).includes(category);

// Labels and filter types follow the updated CI Prototype grid (BRD 1.1 field names).
export const FIELDS: FieldSpec[] = [
  { key: "quarter", label: "Quarter", input: "select", mandatory: true, filter: "select", lookupCategory: "Quarter" },
  { key: "year", label: "Year", input: "select", mandatory: true, filter: "select", lookupCategory: "Year" },
  { key: "customer", label: "Customer", input: "select", mandatory: true, filter: "select" },
  { key: "fabLocation", label: "Fab Location", input: "cascade", mandatory: true, filter: "select" },
  { key: "fabRegion", label: "Fab Region", input: "auto", mandatory: false, filter: "select", lookupCategory: "Fab Region" },
  { key: "servedMarket", label: "Served Market", input: "select", mandatory: true, filter: "select", lookupCategory: "Served Market" },
  { key: "technologyNode", label: "Technology Node", input: "cascade", mandatory: true, filter: "text" },
  { key: "waferSize", label: "Wafer Size (mm)", input: "select", mandatory: true, filter: "select", lookupCategory: "Wafer Size" },
  { key: "processApplication", label: "Process Application", input: "text", mandatory: true, filter: "text" },
  { key: "processType", label: "Process Type", input: "select", mandatory: true, filter: "select", lookupCategory: "Process Type" },
  { key: "processLocation", label: "Process Location", input: "cascade", mandatory: true, filter: "select", lookupCategory: "Process Location" },
  { key: "films", label: "Film(s)", input: "text", mandatory: false, filter: "text" },
  { key: "productLine", label: "Product Line", input: "select", mandatory: true, filter: "select", lookupCategory: "Product Line" },
  { key: "topCompetitor", label: "Top Competitor", input: "select", mandatory: true, filter: "select", lookupCategory: "Top Competitor" },
  { key: "productName", label: "Product Name", input: "cascade", mandatory: true, filter: "select" },
  { key: "processModules", label: "Process Modules", input: "select", mandatory: true, filter: "select", numeric: true, lookupCategory: "Process Modules (#)" },
  { key: "orderType", label: "Order Type", input: "select", mandatory: true, filter: "select", lookupCategory: "Order Type" },
  { key: "actualOrder", label: "Actual Order (#)", input: "number", mandatory: true, filter: "text", numeric: true },
  { key: "asp", label: "ASP (in million) in Sales Currency", input: "number", mandatory: true, filter: "text", numeric: true },
  { key: "currency", label: "Currency", input: "select", mandatory: true, filter: "select", lookupCategory: "Currency" },
  { key: "revenue", label: "Revenue in Sales Currency", input: "auto", mandatory: false, filter: "text", numeric: true },
  { key: "toolType", label: "Tool Type", input: "select", mandatory: true, filter: "select", lookupCategory: "Tool Type" },
  { key: "createdBy", label: "Created By", input: "auto", mandatory: false, filter: "select" },
  { key: "createdOn", label: "Date", input: "auto", mandatory: false, filter: "text" },
];

export const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f])) as Record<FieldKey, FieldSpec>;

/** The 20 fields a user enters (everything except the 4 system/auto fields). */
export const USER_FIELDS = FIELDS.filter((f) => f.input !== "auto");

export const MANDATORY_FIELDS = FIELDS.filter((f) => f.mandatory);

/** Competitive FF's flat-file columns (CI Prototype FFCOLS), after the Record ID. */
export const FF_FIELD_KEYS: FieldKey[] = [
  "year",
  "quarter",
  "customer",
  "fabRegion",
  "servedMarket",
  "technologyNode",
  "topCompetitor",
  "productName",
  "productLine",
  "orderType",
  "actualOrder",
  "asp",
  "currency",
  "revenue",
];

export const RECORD_ID_LABEL = "Record ID";

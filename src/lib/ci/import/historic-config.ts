import type { IssueSeverity } from "@/lib/ci/import/types";

/**
 * Historic Load configuration — every business rule that the CI Prototype /
 * BRD §7.5 fixes for historic regional files lives here, so it can be
 * reviewed and changed in one place without touching the import logic.
 */

/** Column layout of the regional historic files (CI Prototype, Korea file layout). All are required. */
export const HISTORIC_COLUMNS = [
  "Quarter",
  "Year",
  "Customer",
  "Fab Location",
  "Served Market",
  "Technology Node",
  "Wafer Size (mm)",
  "Process Application",
  "Process Type",
  "Process Location",
  "Film(s)",
  "Top Competitor",
  "Product Line",
  "Product Name",
  "Process Modules",
  "Actual Order (#)",
  "ASP (Euro)",
  "Revenue (Euro)",
  "Notes",
  "Created By",
  "Date",
  "Tooltype",
] as const;

export type HistoricColumn = (typeof HISTORIC_COLUMNS)[number];

/**
 * Optional column. When a file carries a per-row Currency, amounts are still
 * only unit-converted (full amount → millions) and keep that currency; no
 * FX conversion is applied (none is approved).
 */
export const OPTIONAL_CURRENCY_COLUMN = "Currency";

/** BRD §7.5: old amounts are full Euro amounts, loaded with Currency = EUR, converted to millions. */
export const HISTORIC_SOURCE_CURRENCY = "EUR";

/** CI Prototype precision for historic amounts: ASP to 4 decimals, Revenue to 2. */
export const HISTORIC_ASP_DECIMALS = 4;
export const HISTORIC_REVENUE_DECIMALS = 2;

/** BRD §7.5: Wafer Size defaults to 300 mm (the CI list value starting with "300mm"). */
export const DEFAULT_WAFER_PATTERN = /^300\s*mm/i;

/** CI Prototype: rows whose note says "Not competitor…" are flagged, not skipped. */
export const NOT_COMPETITOR_PATTERN = /not competitor/i;

/** BRD §5.5: placeholder owner when a historic row has no Created By name. */
export const PLACEHOLDER_OWNER = "Unassigned (historic)";
export const UNMATCHED_OWNER_SUFFIX = " (unmatched)";

/** Default first Change Note when the old file has no Notes for a row. */
export const DEFAULT_HISTORIC_NOTE = "Historic load from regional file.";

/**
 * Known spelling variants seen in the historic files (CI Prototype). They
 * are offered as "suggested — confirm" mappings, never applied silently.
 * Keys are normalised (see normaliseValue()).
 */
export const SUGGESTED_MAPPINGS: Record<string, string> = {
  ips: "Wonik IPS",
  jusung: "Jusung Engineering",
  eugenetech: "Eugene",
};

/**
 * How serious each historic check is. "error" blocks the whole load (no
 * partial commit); "warning" is shown but loads. Defaults follow the BRD
 * ("validated against the same rules as manual entry") except where the CI
 * Prototype explicitly allows historic rows through.
 */
export const HISTORIC_RULE_SEVERITY: Record<
  | "fabNotInMaster"
  | "valueNotInList"
  | "technologyNodeNotForCustomerMarket"
  | "processLocationNotForMarket"
  | "productNameNotForCompetitor"
  | "duplicateRowInFile",
  IssueSeverity
> = {
  // CI Prototype: "Fabs not in the master load with Fab Region blank".
  fabNotInMaster: "warning",
  valueNotInList: "error",
  technologyNodeNotForCustomerMarket: "error",
  processLocationNotForMarket: "error",
  productNameNotForCompetitor: "error",
  duplicateRowInFile: "warning",
};

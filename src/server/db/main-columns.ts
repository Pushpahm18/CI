import { assertIdentifier } from "@/server/db/schema";

/**
 * ci_main (corp_marketing_dev.ci.ci_main): the column behind each competitive-row field. Verified with DESCRIBE TABLE
 * on the live table; nothing here is guessed. is_active is the soft-delete flag (only TRUE rows are live data).
 * Used by Competitive FF (server/ci/competitive-ff). Kept in its own module, next to the schema constants.
 */
export const MAIN_COLUMNS = {
  recordId: "ci_id",
  quarter: "quarter",
  year: "year",
  customer: "customer",
  fabLocation: "fab_location",
  fabRegion: "fab_region",
  servedMarket: "served_market",
  technologyNode: "technology_node",
  waferSize: "wafer_size_mm",
  processApplication: "process_application",
  processType: "process_type",
  processLocation: "process_location",
  films: "films",
  productLine: "product_line",
  topCompetitor: "top_competitor",
  productName: "product_name",
  processModules: "process_modules",
  orderType: "order_type",
  actualOrder: "actual_order",
  asp: "asp_million",
  currency: "currency",
  revenue: "revenue_sales_currency",
  toolType: "tool_type",
  createdBy: "created_by",
  createdOn: "created_date",
  modifiedBy: "modified_by",
  modifiedOn: "modified_date",
  active: "is_active",
  /** The last column of ci_main (string, e.g. CI-0001), shown first in All Competitive Info View. */
  applicationId: "application_id",
} as const;

Object.values(MAIN_COLUMNS).forEach(assertIdentifier);

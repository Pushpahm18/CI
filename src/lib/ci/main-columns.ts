/**
 * The few ci_main column names the browser needs (the full verified map is server/db/main-columns.ts, which a test keeps in
 * step with this). The All Competitive Info grid is built from the table's real columns, so the row actions find the Record ID
 * and the values that title the audit drawer by these names.
 */
export const RECORD_COLUMNS = {
  recordId: "ci_id",
  customer: "customer",
  servedMarket: "served_market",
  quarter: "quarter",
  year: "year",
  createdOn: "created_date",
  modifiedOn: "modified_date",
  active: "is_active",
  applicationId: "application_id",
} as const;

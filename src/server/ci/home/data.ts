import { scopePredicates, type ScopeColumns } from "@/server/ci/competitive-gallery/data";
import type { AccountScope } from "@/server/ci/authorization/scope";
import { MAIN_COLUMNS } from "@/server/db/main-columns";
import { num, str } from "@/server/db/row-values";
import { qCol, qTable } from "@/server/db/sql";
import type { HomeRecentRow } from "@/types/ci-api";

export const HOME_RECENT_COUNT = 6;

type Filter = { columns: ScopeColumns; scope: AccountScope } | undefined;

/** Live rows only (is_active = TRUE), plus the person's scope when they have one (Account Team). Corporate Marketing has no scope: every live row. */
function where(filter: Filter): string {
  const M = MAIN_COLUMNS;
  return `WHERE ${[`${qCol(M.active)} = TRUE`, ...scopePredicates(filter)].join(" AND ")}`;
}

/** Read-only: how many live rows are in the person's view, and how many distinct customers and top competitors they cover. */
export function buildHomeStatsStatement(table: string, filter?: Filter): string {
  const M = MAIN_COLUMNS;
  return `SELECT COUNT(*) AS ${qCol("n")}, COUNT(DISTINCT ${qCol(M.customer)}) AS ${qCol("customers")}, COUNT(DISTINCT ${qCol(M.topCompetitor)}) AS ${qCol("competitors")} FROM ${qTable(table)} ${where(filter)}`;
}

/** Read-only: the most recently created-or-modified live rows in the person's view, newest first. */
export function buildHomeRecentStatement(table: string, filter?: Filter, limit = HOME_RECENT_COUNT): string {
  const M = MAIN_COLUMNS;
  const stamp = `COALESCE(${qCol(M.modifiedOn)}, CAST(${qCol(M.createdOn)} AS TIMESTAMP))`;
  const cols = [M.recordId, M.customer, M.servedMarket, M.fabRegion, M.quarter, M.year].map(qCol).join(", ");
  return `SELECT ${cols}, ${stamp} AS ${qCol("updated_at")} FROM ${qTable(table)} ${where(filter)} ORDER BY ${stamp} DESC, ${qCol(M.recordId)} LIMIT ${Math.trunc(limit)}`;
}

export function rowToHomeRecent(row: Record<string, unknown>): HomeRecentRow & { region: string } {
  const M = MAIN_COLUMNS;
  return {
    recordId: str(row[M.recordId]),
    customer: str(row[M.customer]),
    servedMarket: str(row[M.servedMarket]),
    quarter: str(row[M.quarter]),
    year: str(row[M.year]),
    updatedAt: str(row.updated_at),
    region: str(row[M.fabRegion]),
  };
}

export function rowToHomeStats(row: Record<string, unknown> | undefined): { rows: number; customers: number; competitors: number } {
  return { rows: num(row?.n), customers: num(row?.customers), competitors: num(row?.competitors) };
}

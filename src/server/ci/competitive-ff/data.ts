import { MAIN_COLUMNS } from "@/server/db/main-columns";
import { qCol, qTable } from "@/server/db/sql";
import { num, str } from "@/server/db/row-values";
import { waferDisplay } from "@/lib/ci/wafer-size";
import type { CompetitiveRecord } from "@/types/ci";

/** Rows Competitive FF loads at most (BRD §9: low volume). One extra is read to detect truncation. */
export const FLAT_FILE_ROW_LIMIT = 5000;


/**
 * Read-only: the live (is_active = TRUE) rows of ci_main with the verified columns, newest first.
 * Corporate Marketing only (the service authorizes); there is no scope filter because CM sees every row.
 */
export function buildFlatFileStatement(table: string, limit = FLAT_FILE_ROW_LIMIT): string {
  const M = MAIN_COLUMNS;
  const cols = Object.values(M).map(qCol).join(", ");
  return `SELECT ${cols} FROM ${qTable(table)} WHERE ${qCol(M.active)} = TRUE ORDER BY ${qCol(M.createdOn)} DESC, ${qCol(M.recordId)} LIMIT ${Math.trunc(limit) + 1}`;
}

/** A ci_main row as the screens' CompetitiveRecord. Text stays as stored; numbers are numbers; the wafer size shows its label when it is one of the approved three. */
export function rowToFlatRecord(row: Record<string, unknown>): CompetitiveRecord {
  const M = MAIN_COLUMNS;
  return {
    recordId: str(row[M.recordId]),
    quarter: str(row[M.quarter]),
    year: str(row[M.year]),
    customer: str(row[M.customer]),
    fabLocation: str(row[M.fabLocation]),
    fabRegion: str(row[M.fabRegion]),
    servedMarket: str(row[M.servedMarket]),
    technologyNode: str(row[M.technologyNode]),
    waferSize: waferDisplay(str(row[M.waferSize])),
    processApplication: str(row[M.processApplication]),
    processType: str(row[M.processType]),
    processLocation: str(row[M.processLocation]),
    films: str(row[M.films]),
    productLine: str(row[M.productLine]),
    topCompetitor: str(row[M.topCompetitor]),
    productName: str(row[M.productName]),
    processModules: str(row[M.processModules]),
    orderType: str(row[M.orderType]),
    actualOrder: num(row[M.actualOrder]),
    asp: num(row[M.asp]),
    currency: str(row[M.currency]),
    revenue: num(row[M.revenue]),
    toolType: str(row[M.toolType]),
    createdBy: str(row[M.createdBy]),
    createdOn: str(row[M.createdOn]),
    modifiedBy: str(row[M.modifiedBy]) || undefined,
    modifiedOn: str(row[M.modifiedOn]) || undefined,
  };
}

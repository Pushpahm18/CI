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

/**
 * A ci_main row for the Competitive FF GRID: every column exactly as stored in Databricks (the SQL result text, nothing trimmed,
 * mapped, labelled, converted to a number or reformatted; a NULL is an empty string). The fields typed as numbers on
 * CompetitiveRecord carry the stored text here, which the grid shows as it is. Only the Competitive FF screen uses this.
 */
export function rowToFlatDisplayRecord(row: Record<string, unknown>): CompetitiveRecord {
  const M = MAIN_COLUMNS;
  const text = (v: unknown): string => (v == null ? "" : String(v));
  const asNumberField = (v: unknown) => text(v) as unknown as number;
  return {
    recordId: text(row[M.recordId]),
    quarter: text(row[M.quarter]),
    year: text(row[M.year]),
    customer: text(row[M.customer]),
    fabLocation: text(row[M.fabLocation]),
    fabRegion: text(row[M.fabRegion]),
    servedMarket: text(row[M.servedMarket]),
    technologyNode: text(row[M.technologyNode]),
    waferSize: text(row[M.waferSize]),
    processApplication: text(row[M.processApplication]),
    processType: text(row[M.processType]),
    processLocation: text(row[M.processLocation]),
    films: text(row[M.films]),
    productLine: text(row[M.productLine]),
    topCompetitor: text(row[M.topCompetitor]),
    productName: text(row[M.productName]),
    processModules: text(row[M.processModules]),
    orderType: text(row[M.orderType]),
    actualOrder: asNumberField(row[M.actualOrder]),
    asp: asNumberField(row[M.asp]),
    currency: text(row[M.currency]),
    revenue: asNumberField(row[M.revenue]),
    toolType: text(row[M.toolType]),
    createdBy: text(row[M.createdBy]),
    createdOn: text(row[M.createdOn]),
    modifiedBy: text(row[M.modifiedBy]) || undefined,
    modifiedOn: text(row[M.modifiedOn]) || undefined,
  };
}

/** A ci_main row as the form / import logic's CompetitiveRecord (NOT for grid display: see rowToFlatDisplayRecord). Text stays as stored; numbers are numbers; the wafer size shows its label when it is one of the approved three. */
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

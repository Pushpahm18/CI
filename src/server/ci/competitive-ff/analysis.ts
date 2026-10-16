import type { SessionIdentity } from "@/server/ci/current-user";
import { CiError, NotConfiguredError, ValidationError } from "@/server/ci/errors";
import { authorizeCorporateMarketing } from "@/server/ci/authorization/ci-access";
import { authorizedReads } from "@/server/ci/authorized-reads";
import { requireConnected } from "@/server/ci/connection";
import { executeReadOnlyQuery } from "@/server/db/read-only";
import { COMPETITIVE_GALLERY_LABEL, COMPETITIVE_GALLERY_SOURCE, tableName, type TableRef } from "@/server/db/schema";
import { MAIN_COLUMNS } from "@/server/db/main-columns";
import { qCol, qTable, sqlLiteral } from "@/server/db/sql";
import {
  FF_FILTER_KEYS,
  FF_GROUP_KEYS,
  comparePeriods,
  type FfAggregate,
  type FfAnalysisResponse,
  type FfFilterKey,
  type FfFilters,
  type FfGroupKey,
  type FfRevenue,
} from "@/lib/ci/ff-analysis";

/**
 * Competitive FF Analysis (Corporate Marketing only). Every figure is calculated by Databricks over ALL live rows of ci_main that
 * match the filters, so there is no row cap and no partial total. Read-only. Numbers are read with TRY_CAST (a value that is not a
 * number is left out of a sum, never changed); revenue is kept per currency and never added across currencies.
 */

export interface AnalysisDeps {
  source(): TableRef | null;
  requireConnected(): void;
  authorize(identity: SessionIdentity): Promise<unknown>;
  query(statement: string): Promise<Record<string, unknown>[]>;
}

const defaultDeps: AnalysisDeps = {
  source: () => COMPETITIVE_GALLERY_SOURCE,
  requireConnected,
  authorize: (identity) => authorizeCorporateMarketing(identity),
  query: (statement) => executeReadOnlyQuery(statement),
};

/** The filters and group a request asks for; an unknown group is refused, empty or oversized filter values are dropped. */
export function parseAnalysisQuery(url: URL): { filters: FfFilters; group: FfGroupKey } {
  const group = (url.searchParams.get("group") ?? "customer") as FfGroupKey;
  if (!(FF_GROUP_KEYS as readonly string[]).includes(group)) throw new ValidationError(["Unknown group."]);
  const filters: FfFilters = {};
  for (const key of FF_FILTER_KEYS) {
    const values = url.searchParams.getAll(key).filter((v) => v.length > 0 && v.length <= 200).slice(0, 500);
    if (values.length > 0) filters[key as FfFilterKey] = values;
  }
  return { filters, group };
}

const M = MAIN_COLUMNS;
const asText = (column: string) => `CAST(${qCol(column)} AS STRING)`;
const asNumber = (column: string) => `TRY_CAST(${qCol(column)} AS DOUBLE)`;

/** WHERE: live rows, plus `CAST(col AS STRING) IN (...)` for each filter that has a selection. */
export function buildAnalysisWhere(filters: FfFilters): string {
  const parts = [`${qCol(M.active)} = TRUE`];
  for (const key of FF_FILTER_KEYS) {
    const values = filters[key as FfFilterKey];
    if (values && values.length > 0) parts.push(`${asText(M[key])} IN (${values.map(sqlLiteral).join(", ")})`);
  }
  return `WHERE ${parts.join(" AND ")}`;
}

export function buildAnalysisStatements(table: string, filters: FfFilters, groupKey: FfGroupKey) {
  const from = qTable(table);
  const where = buildAnalysisWhere(filters);
  const sums = `COUNT(*) AS n, SUM(${asNumber(M.actualOrder)}) AS qty, SUM(${asNumber(M.revenue)}) AS rev`;
  const distinct = (c: string) => `COUNT(DISTINCT NULLIF(TRIM(${asText(c)}), ''))`;
  const grouped = (dims: string[]) => {
    const cols = [...dims, M.currency];
    return `SELECT ${cols.map((c, i) => `${asText(c)} AS d${i}`).join(", ")}, ${sums} FROM ${from} ${where} GROUP BY ${cols.map(asText).join(", ")}`;
  };
  const option = (key: FfFilterKey) =>
    `SELECT ${sqlLiteral(key)} AS k, ${asText(M[key])} AS v FROM ${from} WHERE ${qCol(M.active)} = TRUE AND ${qCol(M[key])} IS NOT NULL AND TRIM(${asText(M[key])}) <> '' GROUP BY ${asText(M[key])}`;
  return {
    totals: `SELECT COUNT(*) AS n, ${distinct(M.customer)} AS customers, ${distinct(M.topCompetitor)} AS competitors, SUM(${asNumber(M.actualOrder)}) AS qty FROM ${from} ${where}`,
    groups: grouped([M[groupKey]]),
    periods: grouped([M.year, M.quarter]),
    options: FF_FILTER_KEYS.map((k) => option(k as FfFilterKey)).join(" UNION ALL "),
  };
}

const text = (v: unknown) => (v == null ? "" : String(v));
const amount = (v: unknown) => (v == null || v === "" ? 0 : Number(v) || 0);

/** Adds the rows of one (dimension, currency) result into per-dimension aggregates. */
function fold(rows: Record<string, unknown>[], dims: number): Map<string, FfAggregate & { parts: string[] }> {
  const out = new Map<string, FfAggregate & { parts: string[] }>();
  for (const r of rows) {
    const parts = Array.from({ length: dims }, (_, i) => text(r[`d${i}`]));
    const id = JSON.stringify(parts);
    const agg = out.get(id) ?? { parts, rows: 0, quantity: 0, revenue: [] as FfRevenue[] };
    agg.rows += amount(r.n);
    agg.quantity += amount(r.qty);
    if (r.rev != null && r.rev !== "") agg.revenue.push({ currency: text(r[`d${dims}`]), amount: amount(r.rev) });
    out.set(id, agg);
  }
  return out;
}

const byCurrency = (a: FfRevenue, b: FfRevenue) => a.currency.localeCompare(b.currency);

export async function loadFfAnalysis(
  identity: SessionIdentity,
  filters: FfFilters,
  groupKey: FfGroupKey,
  deps: AnalysisDeps = defaultDeps
): Promise<FfAnalysisResponse> {
  const ref = deps.source();
  if (!ref) throw new NotConfiguredError([COMPETITIVE_GALLERY_LABEL]);
  const sql = buildAnalysisStatements(tableName(ref), filters, groupKey);
  deps.requireConnected();
  try {
    const [, [totals, groups, periods, options]] = await authorizedReads(
      () => deps.authorize(identity),
      () => Promise.all([deps.query(sql.totals), deps.query(sql.groups), deps.query(sql.periods), deps.query(sql.options)])
    );
    const t = totals[0] ?? {};
    const optionLists = Object.fromEntries(FF_FILTER_KEYS.map((k) => [k, [] as string[]])) as Record<FfFilterKey, string[]>;
    for (const o of options) optionLists[text(o.k) as FfFilterKey]?.push(text(o.v));
    for (const k of FF_FILTER_KEYS) optionLists[k as FfFilterKey].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return {
      totals: { rows: amount(t.n), customers: amount(t.customers), competitors: amount(t.competitors), quantity: amount(t.qty) },
      groups: Array.from(fold(groups, 1).values())
        .map(({ parts, ...a }) => ({ key: parts[0], ...a, revenue: a.revenue.sort(byCurrency) }))
        .sort((a, b) => b.quantity - a.quantity || a.key.localeCompare(b.key)),
      periods: Array.from(fold(periods, 2).values())
        .map(({ parts, ...a }) => ({ year: parts[0], quarter: parts[1], ...a, revenue: a.revenue.sort(byCurrency) }))
        .sort(comparePeriods),
      options: optionLists,
    };
  } catch (error) {
    if (error instanceof CiError) throw error;
    console.error("[CI] competitive FF analysis: reading from Databricks failed:", error instanceof Error ? error.message : error);
    throw new CiError("The Competitive Info analysis could not be calculated in Databricks. Check the server log for details.", 502, "INTERNAL");
  }
}

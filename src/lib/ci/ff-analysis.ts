/**
 * Competitive FF "Analysis" tab: which fields can filter / group, and the shapes the server returns. Shared by the server (which
 * builds the Databricks queries) and the screen. Everything shown on the tab is calculated by Databricks over every live ci_main
 * row that matches the filters; nothing is estimated, sampled or hardcoded.
 */
import type { CompetitiveRecord } from "@/types/ci";

export const FF_FILTER_KEYS = ["year", "quarter", "customer", "fabLocation", "fabRegion", "servedMarket", "topCompetitor", "orderType"] as const;
export const FF_GROUP_KEYS = [
  "customer",
  "fabLocation",
  "fabRegion",
  "servedMarket",
  "technologyNode",
  "topCompetitor",
  "productName",
  "year",
  "quarter",
  "orderType",
  "toolType",
] as const;

export type FfFilterKey = (typeof FF_FILTER_KEYS)[number] & keyof CompetitiveRecord;
export type FfGroupKey = (typeof FF_GROUP_KEYS)[number] & keyof CompetitiveRecord;
export type FfFilters = Partial<Record<FfFilterKey, string[]>>;

export const FF_MEASURES = [
  { key: "quantity", label: "Order quantity" },
  { key: "revenue", label: "Revenue (Sales Currency)" },
  { key: "rows", label: "Number of rows" },
] as const;
export type FfMeasure = (typeof FF_MEASURES)[number]["key"];

/** Revenue is never added across currencies: one amount per currency code ("" = the row has no currency). */
export interface FfRevenue {
  currency: string;
  amount: number;
}

export interface FfAggregate {
  rows: number;
  quantity: number;
  revenue: FfRevenue[];
}

export interface FfAnalysisGroup extends FfAggregate {
  /** The value as stored; "" stays blank. */
  key: string;
}

export interface FfAnalysisPeriod extends FfAggregate {
  year: string;
  quarter: string;
}

export interface FfAnalysisResponse {
  totals: { rows: number; customers: number; competitors: number; quantity: number };
  groups: FfAnalysisGroup[];
  /** Chronological: by year, then quarter. */
  periods: FfAnalysisPeriod[];
  /** Every filter's choices, from all live rows. */
  options: Record<FfFilterKey, string[]>;
}

/** Orders year then quarter chronologically (2025 Q4 before 2026 Q1). Anything not numeric goes last, by text. */
export function comparePeriods(a: { year: string; quarter: string }, b: { year: string; quarter: string }): number {
  const num = (s: string, re: RegExp) => {
    const m = s.match(re);
    return m ? Number(m[0]) : Number.POSITIVE_INFINITY;
  };
  const y = num(a.year, /\d+/) - num(b.year, /\d+/);
  if (y !== 0 && !Number.isNaN(y)) return y;
  const q = num(a.quarter, /\d+/) - num(b.quarter, /\d+/);
  if (q !== 0 && !Number.isNaN(q)) return q;
  return a.year.localeCompare(b.year) || a.quarter.localeCompare(b.quarter);
}

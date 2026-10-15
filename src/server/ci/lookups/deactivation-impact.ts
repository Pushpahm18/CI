import { createHash } from "node:crypto";
import { CASCADING_CATEGORIES, isCascadingCategory } from "@/lib/ci/field-spec";
import { DEPENDENT_MAPPINGS, type DependentLookupRow } from "@/server/ci/databricks/dependent-lookups";
import type { LookupDeactivationImpact } from "@/types/ci-api";

/**
 * What deactivating an independent dropdown value does to ci_lookup_dependent. There are no foreign keys: a dependent row
 * refers to its parents by text (parent_value_1 / parent_value_2 / child_value, compared case-insensitively like every other
 * lookup check), and only ACTIVE rows of the four approved relationships (DEPENDENT_MAPPINGS) count.
 *
 *   Customer       -> Fab Location rows (parent 1; they carry the Fab Region) and Technology Node rows (parent 1)
 *   Served Market  -> Process Location rows (parent 1) and Technology Node rows (parent 2)
 *   Top Competitor -> Product Name rows (parent 1)
 *   Fab Region     -> Fab Location rows whose Fab Region (child value) it is
 *
 * Rows are soft-deactivated, never deleted, so their history stays.
 */

type Rule = { label: string; match: (row: DependentLookupRow, value: string) => boolean; describe: (row: DependentLookupRow) => string };

const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const isMapping = (row: DependentLookupRow, key: keyof typeof DEPENDENT_MAPPINGS) =>
  row.parentType1 === DEPENDENT_MAPPINGS[key].parentType1 && row.parentType2 === DEPENDENT_MAPPINGS[key].parentType2 && row.childType === DEPENDENT_MAPPINGS[key].childType;

const fabText = (r: DependentLookupRow) => `${r.parentValue1} · ${r.parentValue2} (${r.childValue})`;
const nodeText = (r: DependentLookupRow) => `${r.parentValue1} · ${r.parentValue2} · ${r.childValue}`;

const RULES: Record<(typeof CASCADING_CATEGORIES)[number], Rule[]> = {
  Customer: [
    { label: "Fab Locations (with their Fab Region)", match: (r, v) => isMapping(r, "fab") && eq(r.parentValue1, v), describe: fabText },
    { label: "Technology Node mappings", match: (r, v) => isMapping(r, "node") && eq(r.parentValue1, v), describe: nodeText },
  ],
  "Served Market": [
    { label: "Process Location mappings", match: (r, v) => isMapping(r, "proc") && eq(r.parentValue1, v), describe: (r) => `${r.parentValue1} · ${r.childValue}` },
    { label: "Technology Node mappings", match: (r, v) => isMapping(r, "node") && eq(r.parentValue2, v), describe: nodeText },
  ],
  "Top Competitor": [{ label: "Competitor Product (Product Name) mappings", match: (r, v) => isMapping(r, "comp") && eq(r.parentValue1, v), describe: (r) => `${r.parentValue1} · ${r.childValue}` }],
  "Fab Region": [{ label: "Fab Locations using this Fab Region", match: (r, v) => isMapping(r, "fab") && eq(r.childValue, v), describe: fabText }],
};

/** How many names the confirmation lists per group; the count is always the full number. */
export const IMPACT_SAMPLE = 12;

export interface DependentImpact {
  /** The active dependent rows that will be deactivated with the value. */
  rows: DependentLookupRow[];
  summary: LookupDeactivationImpact;
}

/** Identifies exactly which rows an impact covers (their ids, order-independent), so a confirmation can be checked against what the person reviewed. */
export function impactFingerprint(ids: string[]): string {
  return createHash("sha256").update([...ids].sort().join("\n")).digest("hex").slice(0, 16);
}

export function dependentImpactOf(category: string, value: string, rows: DependentLookupRow[]): DependentImpact {
  const rules = isCascadingCategory(category) ? RULES[category as (typeof CASCADING_CATEGORIES)[number]] : [];
  const affected: DependentLookupRow[] = [];
  const groups = rules.map((rule) => {
    const hits = rows.filter((r) => r.active && rule.match(r, value));
    affected.push(...hits);
    return { label: rule.label, count: hits.length, names: hits.slice(0, IMPACT_SAMPLE).map(rule.describe) };
  });
  return { rows: affected, summary: { category, value, total: affected.length, fingerprint: impactFingerprint(affected.map((r) => r.id)), groups } };
}

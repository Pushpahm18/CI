import { randomUUID } from "node:crypto";
import { executeReadOnlyQuery } from "@/server/db/read-only";
import { str, num } from "@/server/db/row-values";
import { CI_TABLES, DEPENDENT_LOOKUP_COLUMNS, ciTableName, type CiTables } from "@/server/db/schema";
import { buildMerge, buildMergeMany, qCol, qTable, sqlLiteral, tsLiteral } from "@/server/db/sql";
import { executeStatement } from "@/server/db/warehouse";
import { hasWarehouseBackend } from "@/server/config";
import type { CompetitorProduct, CustomerFab, CustomerMarketNode, MarketProcessLocation } from "@/types/ci";

/**
 * corp_marketing_dev.ci.ci_lookup_dependent (columns: server/db/schema.ts
 * DEPENDENT_LOOKUP_COLUMNS). Rows come back exactly as stored. Writes (add,
 * rename, deactivate, reorder) are single MERGE / UPDATE statements of this table
 * only (assertDependentWriteStatement); nothing is ever deleted. The parent_type /
 * child_type strings are in DEPENDENT_MAPPINGS below (Fab is approved; the other
 * three follow the same convention and are proposed).
 */

const C = DEPENDENT_LOOKUP_COLUMNS;

export interface DependentLookupRow {
  id: string;
  parentType1: string;
  parentValue1: string;
  parentType2: string;
  parentValue2: string;
  childType: string;
  childValue: string;
  sortOrder: number;
  /** True only when the stored flag is exactly true. */
  active: boolean;
}

export interface DependentLookupDeps {
  query(statement: string): Promise<Record<string, unknown>[]>;
}

export function buildDependentListStatement(table: string): string {
  const cols = [C.id, C.parentType1, C.parentValue1, C.parentType2, C.parentValue2, C.childType, C.childValue, C.order, C.active];
  return `SELECT ${cols.map(qCol).join(", ")} FROM ${qTable(table)} ORDER BY ${qCol(C.childType)}, ${qCol(C.parentType1)}, ${qCol(C.parentValue1)}, ${qCol(C.parentValue2)}, ${qCol(C.order)}`;
}

export function rowToDependent(row: Record<string, unknown>): DependentLookupRow {
  return {
    id: str(row[C.id]),
    parentType1: str(row[C.parentType1]),
    parentValue1: str(row[C.parentValue1]),
    parentType2: str(row[C.parentType2]),
    parentValue2: str(row[C.parentValue2]),
    childType: str(row[C.childType]),
    childValue: str(row[C.childValue]),
    sortOrder: num(row[C.order], 0),
    active: String(row[C.active]).toLowerCase() === "true",
  };
}

// ---------------------------------------------------------------- writes

/** The columns a rename may change: the value the list shows lives in different columns for fabs and the rest. */
export type DependentValueColumn = "parentValue2" | "childValue";

export interface DependentInsert {
  id: string;
  list: DependentListId;
  parent1: string;
  parent2: string;
  value: string;
  region?: string;
  sortOrder: number;
  actor: string;
  now: string;
}

export function buildDependentInsertStatement(table: string, i: DependentInsert): string {
  const m = DEPENDENT_MAPPINGS[i.list];
  return buildMerge(table, C.id, {
    [C.id]: i.id,
    [C.parentType1]: m.parentType1,
    [C.parentValue1]: i.parent1,
    [C.parentType2]: m.parentType2,
    // Fab: the second parent is the Fab Location and the child is its Region. Node: the second parent is the Served Market.
    [C.parentValue2]: i.list === "fab" ? i.value : i.list === "node" ? i.parent2 : "",
    [C.childType]: m.childType,
    [C.childValue]: i.list === "fab" ? (i.region ?? "") : i.value,
    [C.order]: i.sortOrder,
    [C.active]: true,
    [C.createdBy]: i.actor,
    [C.createdOn]: tsLiteral(i.now),
    [C.modifiedBy]: i.actor,
    [C.modifiedOn]: tsLiteral(i.now),
  });
}

/** Changes one stored value of one row (rename, or a fab's region). */
export function buildDependentInsertManyStatement(table: string, inputs: DependentInsert[]): string {
  return buildMergeMany(
    table,
    C.id,
    inputs.map((i) => {
      const m = DEPENDENT_MAPPINGS[i.list];
      return {
        [C.id]: i.id,
        [C.parentType1]: m.parentType1,
        [C.parentValue1]: i.parent1,
        [C.parentType2]: m.parentType2,
        [C.parentValue2]: i.list === "fab" ? i.value : i.list === "node" ? i.parent2 : "",
        [C.childType]: m.childType,
        [C.childValue]: i.list === "fab" ? (i.region ?? "") : i.value,
        [C.order]: i.sortOrder,
        [C.active]: true,
        [C.createdBy]: i.actor,
        [C.createdOn]: tsLiteral(i.now),
        [C.modifiedBy]: i.actor,
        [C.modifiedOn]: tsLiteral(i.now),
      };
    })
  );
}

export function buildDependentSetStatement(table: string, i: { id: string; column: DependentValueColumn; value: string; actor: string; now: string }): string {
  return `UPDATE ${qTable(table)} SET ${qCol(C[i.column])} = ${sqlLiteral(i.value)}, ${qCol(C.modifiedBy)} = ${sqlLiteral(i.actor)}, ${qCol(C.modifiedOn)} = ${sqlLiteral(tsLiteral(i.now))} WHERE ${qCol(C.id)} = ${sqlLiteral(i.id)}`;
}

export function buildDependentDeactivateStatement(table: string, i: { id: string; actor: string; now: string }): string {
  return `UPDATE ${qTable(table)} SET ${qCol(C.active)} = FALSE, ${qCol(C.modifiedBy)} = ${sqlLiteral(i.actor)}, ${qCol(C.modifiedOn)} = ${sqlLiteral(tsLiteral(i.now))} WHERE ${qCol(C.id)} = ${sqlLiteral(i.id)}`;
}

/** One UPDATE for a group: position i+1 for the i-th id, only rows with those ids. */
export function buildDependentReorderStatement(table: string, i: { orderedIds: string[]; actor: string; now: string }): string {
  const cases = i.orderedIds.map((id, n) => `WHEN ${sqlLiteral(id)} THEN ${n + 1}`).join(" ");
  const ids = i.orderedIds.map((id) => sqlLiteral(id)).join(", ");
  return `UPDATE ${qTable(table)} SET ${qCol(C.order)} = CASE ${qCol(C.id)} ${cases} END, ${qCol(C.modifiedBy)} = ${sqlLiteral(i.actor)}, ${qCol(C.modifiedOn)} = ${sqlLiteral(tsLiteral(i.now))} WHERE ${qCol(C.id)} IN (${ids})`;
}

/** The only data-changing statements this table may receive: one MERGE INTO / UPDATE of itself. Never a DELETE. */
export function assertDependentWriteStatement(table: string, statement: string): void {
  const withoutLiterals = statement.replace(/'(?:[^']|'')*'/g, "''");
  const target = qTable(table).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^\\s*(MERGE INTO|UPDATE)\\s+${target}(\\s|$)`).test(withoutLiterals) || withoutLiterals.includes(";")) {
    throw new Error("Refused: unexpected write statement for the dependent lookups table.");
  }
}

export interface DependentLookupStore {
  list(): Promise<DependentLookupRow[]>;
  insert(input: Omit<DependentInsert, "id" | "now">): Promise<string>;
  /** Adds many rows with ONE statement (all or none); returns their ids in order. */
  insertMany(inputs: Omit<DependentInsert, "id" | "now">[]): Promise<string[]>;
  setValue(id: string, column: DependentValueColumn, value: string, actor: string): Promise<void>;
  deactivate(id: string, actor: string): Promise<void>;
  reorder(orderedIds: string[], actor: string): Promise<void>;
}

export interface DependentWriteDeps extends DependentLookupDeps {
  execute(statement: string): Promise<void>;
  now(): string;
  newId(): string;
}

const defaultWriteDeps: DependentWriteDeps = {
  query: (statement) => executeReadOnlyQuery(statement),
  execute: (statement) => executeStatement(statement),
  now: () => new Date().toISOString(),
  newId: () => randomUUID(),
};

export function createDependentLookupStore(table: string, overrides: Partial<DependentWriteDeps> = {}): DependentLookupStore {
  const deps: DependentWriteDeps = { ...defaultWriteDeps, ...overrides };
  const write = async (statement: string) => {
    assertDependentWriteStatement(table, statement);
    await deps.execute(statement);
  };
  return {
    list: async () => (await deps.query(buildDependentListStatement(table))).map(rowToDependent),
    async insert(input) {
      const id = deps.newId();
      await write(buildDependentInsertStatement(table, { ...input, id, now: deps.now() }));
      return id;
    },
    async insertMany(inputs) {
      if (inputs.length === 0) return [];
      const now = deps.now();
      const rows = inputs.map((i) => ({ ...i, id: deps.newId(), now }));
      await write(buildDependentInsertManyStatement(table, rows));
      return rows.map((r) => r.id);
    },
    setValue: (id, column, value, actor) => write(buildDependentSetStatement(table, { id, column, value, actor, now: deps.now() })),
    deactivate: (id, actor) => write(buildDependentDeactivateStatement(table, { id, actor, now: deps.now() })),
    async reorder(orderedIds, actor) {
      if (orderedIds.length > 0) await write(buildDependentReorderStatement(table, { orderedIds, actor, now: deps.now() }));
    },
  };
}

/** The store, or null while the table is not configured or no warehouse is available. */
export function getDependentLookupStore(tables: CiTables = CI_TABLES): DependentLookupStore | null {
  const table = ciTableName("dependentLookups", tables);
  return table && hasWarehouseBackend() ? createDependentLookupStore(table) : null;
}

/**
 * The ONLY relationship whose type strings are approved: Customer + Fab Location
 * -> Fab Region, one active row per Customer + Fab Location, e.g.
 *   parent_type_1 = Customer, parent_value_1 = <customer>,
 *   parent_type_2 = Fab Location, parent_value_2 = <fab>,
 *   child_type = Fab Region, child_value = <region>.
 * The other relationships (Process Location, Product Name, Technology Node) stay
 * unmapped until their strings are approved.
 */
export const FAB_MAPPING = { parentType1: "Customer", parentType2: "Fab Location", childType: "Fab Region" } as const;

/**
 * The other three cascading lists, read with the same convention as the approved
 * Fab row: the stored type strings are the field names used on the screens.
 * PROPOSED, NOT YET CONFIRMED by the business; change them here (one place) if the
 * stored strings differ. Rows that do not match exactly are ignored, never guessed.
 *   Top Competitor -> Product Name:  parent_type_1 = Top Competitor, child_type = Product Name
 *   Served Market  -> Process Location: parent_type_1 = Served Market, child_type = Process Location
 *   Customer + Served Market -> Technology Node: parent_type_1 = Customer, parent_type_2 = Served Market, child_type = Technology Node
 * The first two have no second parent (parent_type_2 and parent_value_2 empty).
 */
export const PRODUCT_MAPPING = { parentType1: "Top Competitor", parentType2: "", childType: "Product Name" } as const;
export const PROCESS_LOCATION_MAPPING = { parentType1: "Served Market", parentType2: "", childType: "Process Location" } as const;
export const NODE_MAPPING = { parentType1: "Customer", parentType2: "Served Market", childType: "Technology Node" } as const;

export type DependentListId = "comp" | "proc" | "fab" | "node";

type Mapping = { parentType1: string; parentType2: string; childType: string };

export const DEPENDENT_MAPPINGS: Record<DependentListId, Mapping> = {
  comp: PRODUCT_MAPPING,
  proc: PROCESS_LOCATION_MAPPING,
  fab: FAB_MAPPING,
  node: NODE_MAPPING,
};

/**
 * One row of a cascading list as the screens see it. `value` is what the list shows
 * (Product Name, Process Location, Fab Location, Technology Node); `parent` is the
 * group it sits under (Top Competitor, Served Market, Customer, "Customer · Served
 * Market"); `region` is only set for fabs. For fabs the Fab Location is stored in
 * parent_value_2 and the Fab Region in child_value; for the others the value is
 * child_value.
 */
export interface DependentEntry {
  id: string;
  list: DependentListId;
  parent1: string;
  /** Second parent where the relationship has one (Technology Node: Served Market); "" otherwise. */
  parent2: string;
  value: string;
  region?: string;
  sortOrder: number;
}

export interface DependentLists {
  customerFabs: CustomerFab[];
  competitorProducts: CompetitorProduct[];
  processLocations: MarketProcessLocation[];
  technologyNodes: CustomerMarketNode[];
  entries: DependentEntry[];
  issues: string[];
}

/** Active rows of one relationship, in display_order then name; incomplete or exactly repeated rows are left out and reported. */
function rowsFor(rows: DependentLookupRow[], m: Mapping, label: string, issues: string[]): DependentLookupRow[] {
  const out: DependentLookupRow[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.active || r.parentType1 !== m.parentType1 || r.parentType2 !== m.parentType2 || r.childType !== m.childType) continue;
    if (!r.parentValue1 || !r.childValue || (m.parentType2 && !r.parentValue2)) {
      issues.push(`A ${label} row (${r.id || "no id"}) is incomplete and was ignored.`);
      continue;
    }
    const key = [r.parentValue1, r.parentValue2, r.childValue].join("\u0000").toLowerCase();
    if (seen.has(key)) {
      issues.push(`${[r.parentValue1, r.parentValue2, r.childValue].filter(Boolean).join(" / ")} appears more than once in ${label}; the repeat was ignored.`);
      continue;
    }
    seen.add(key);
    out.push(r);
  }
  return out.sort((a, b) => a.sortOrder - b.sortOrder || a.childValue.localeCompare(b.childValue));
}

/** All four cascading lists from the dependent rows, in stored display order. Nothing is invented. */
export function dependentListsFrom(rows: DependentLookupRow[]): DependentLists {
  const fab = fabKept(rows);
  const issues = fab.issues.map((i) => `Fab Location: ${i}`);
  const comp = rowsFor(rows, PRODUCT_MAPPING, "Product Name", issues);
  const proc = rowsFor(rows, PROCESS_LOCATION_MAPPING, "Process Location", issues);
  const node = rowsFor(rows, NODE_MAPPING, "Technology Node", issues);
  const entry = (list: DependentListId, r: DependentLookupRow): DependentEntry =>
    list === "fab"
      ? { id: r.id, list, parent1: r.parentValue1, parent2: "", value: r.parentValue2, region: r.childValue, sortOrder: r.sortOrder }
      : { id: r.id, list, parent1: r.parentValue1, parent2: r.parentValue2, value: r.childValue, sortOrder: r.sortOrder };
  return {
    customerFabs: fab.kept.map((r) => ({ customer: r.parentValue1, fabLocation: r.parentValue2, fabRegion: r.childValue })),
    competitorProducts: comp.map((r) => ({ competitor: r.parentValue1, product: r.childValue })),
    processLocations: proc.map((r) => ({ servedMarket: r.parentValue1, processLocation: r.childValue })),
    technologyNodes: node.map((r) => ({ customer: r.parentValue1, servedMarket: r.parentValue2, technologyNode: r.childValue })),
    entries: [
      ...comp.map((r) => entry("comp", r)),
      ...proc.map((r) => entry("proc", r)),
      ...fab.kept.map((r) => entry("fab", r)),
      ...node.map((r) => entry("node", r)),
    ],
    issues,
  };
}

export interface FabMappingResult {
  fabs: CustomerFab[];
  /** Plain-language problems with rows that were left out (shown to the user; nothing is guessed or repaired). */
  issues: string[];
}

/**
 * Builds the Fab Location list (with its Fab Region) from the dependent rows.
 * Only exact-type, active rows count. A row missing its customer, fab or region
 * is left out and reported (no placeholder is substituted); two active rows for
 * the same Customer + Fab Location are both left out and reported, because the
 * right one cannot be known. Order: display_order, then name, within a customer.
 */
function fabKept(rows: DependentLookupRow[]): { kept: DependentLookupRow[]; issues: string[] } {
  const issues: string[] = [];
  const candidates = rows.filter(
    (r) => r.active && r.parentType1 === FAB_MAPPING.parentType1 && r.parentType2 === FAB_MAPPING.parentType2 && r.childType === FAB_MAPPING.childType
  );
  const valid: DependentLookupRow[] = [];
  for (const r of candidates) {
    if (!r.parentValue1 || !r.parentValue2) issues.push(`A Fab Region mapping row (${r.id || "no id"}) has no Customer or no Fab Location and was ignored.`);
    else if (!r.childValue) issues.push(`${r.parentValue1} / ${r.parentValue2} has no Fab Region and was ignored.`);
    else valid.push(r);
  }
  const byKey = new Map<string, DependentLookupRow[]>();
  for (const r of valid) byKey.set(`${r.parentValue1}\u0000${r.parentValue2}`, [...(byKey.get(`${r.parentValue1}\u0000${r.parentValue2}`) ?? []), r]);
  const kept: DependentLookupRow[] = [];
  for (const group of byKey.values()) {
    if (group.length === 1) kept.push(group[0]);
    else issues.push(`${group[0].parentValue1} / ${group[0].parentValue2} has ${group.length} active mappings and was ignored until only one remains.`);
  }
  kept.sort((a, b) => a.parentValue1.localeCompare(b.parentValue1) || a.sortOrder - b.sortOrder || a.parentValue2.localeCompare(b.parentValue2));
  return { kept, issues };
}

export function fabMappingsFrom(rows: DependentLookupRow[]): FabMappingResult {
  const { kept, issues } = fabKept(rows);
  return { fabs: kept.map((r) => ({ customer: r.parentValue1, fabLocation: r.parentValue2, fabRegion: r.childValue })), issues };
}

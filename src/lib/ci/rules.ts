import type {
  CiUser,
  CompetitiveInput,
  CompetitiveRecord,
  FieldChange,
  FormOptions,
  LookupValue,
  ReferenceData,
  ScopeValue,
} from "@/types/ci";
import { FIELDS, MANDATORY_FIELDS, USER_FIELDS, type FieldKey } from "@/lib/ci/field-spec";

/**
 * CI business rules, shared by the browser (form behaviour) and the server
 * (authoritative enforcement). Every rule here is traceable to the CI BRD or
 * the CI Prototype — see each function's comment.
 */

/** CI Prototype: a cascade with nothing on file offers only this, and the real name goes in the Change Note. */
export const OTHER_ADD_NOTE = "Other - Add note to Change Notes";
/** CI Prototype: a customer with no fabs on file offers this single Fab Location. */
export const NOT_ASSIGNED = "Not Assigned";

/** The 21 user-entered fields as the form holds them (numbers kept as typed strings). */
export type UserFieldKey = Exclude<FieldKey, "fabRegion" | "revenue" | "createdBy" | "createdOn">;
export type FormState = Record<UserFieldKey, string>;

export function blankForm(): FormState {
  return Object.fromEntries(USER_FIELDS.map((f) => [f.key, ""])) as FormState;
}

export function recordToForm(r: CompetitiveRecord): FormState {
  const form = blankForm();
  for (const f of USER_FIELDS) form[f.key as UserFieldKey] = String(r[f.key] ?? "");
  return form;
}

export function formToInput(form: FormState): CompetitiveInput {
  return { ...form, actualOrder: Number(form.actualOrder), asp: Number(form.asp) };
}

// ---------------------------------------------------------------- scope

/** Fails closed: a missing or malformed scope grants nothing (never "all", never an error). */
export function scopeIncludes(scope: ScopeValue | null | undefined, value: string): boolean {
  if (scope === "All") return true;
  return Array.isArray(scope) && scope.includes(value);
}

export type ScopedRow = Pick<CompetitiveRecord, "customer" | "servedMarket" | "fabRegion">;

/** The data-access scope a repository query must apply (CM: everything). */
export interface DataScope {
  customers: ScopeValue;
  segments: ScopeValue;
  regions: ScopeValue;
}

export const FULL_SCOPE: DataScope = { customers: "All", segments: "All", regions: "All" };

export function dataScopeFor(user: CiUser): DataScope {
  if (user.role === "CM") return FULL_SCOPE;
  return { customers: user.customerScope, segments: user.segmentScope, regions: user.regionScope };
}

export function rowInDataScope(scope: DataScope, row: ScopedRow): boolean {
  return (
    scopeIncludes(scope.customers, row.customer) &&
    scopeIncludes(scope.segments, row.servedMarket) &&
    scopeIncludes(scope.regions, row.fabRegion)
  );
}

/**
 * BRD 1.1 §4: each row belongs to a Customer, Segment (= Served Market) and
 * Region (the row's Fab Region); users see only rows within their assigned
 * scope. All three must match (CI Prototype / BRD open item 7); each
 * dimension is "All" or a list of allowed values. Corporate Marketing sees
 * every row.
 */
export function recordInScope(user: CiUser, row: ScopedRow): boolean {
  return rowInDataScope(dataScopeFor(user), row);
}

// ---------------------------------------------------------------- edit window

/** The calendar year a stored created_date ("2026-10-16", or a full timestamp) falls in; null when it cannot be read. */
function createdYear(createdOn: string): number | null {
  const m = /^(\d{4})-\d{2}-\d{2}/.exec(createdOn.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Edit window (owner decision, replacing the BRD §5.2 Year-field rule): an Account Team user can edit a row only until 31 December
 * of the calendar year it was CREATED in (created 16-Oct-2026 -> editable until 31-Dec-2026, locked from 1-Jan-2027), after which it
 * is view-only for them. Corporate Marketing is exempt. The date is the row's stored created_date; one that cannot be read is
 * treated as locked, never as open. The year is the UTC year, like the stored date.
 */
export function salesEditWindowOpen(createdOn: string, today: Date = new Date()): boolean {
  const y = createdYear(createdOn);
  return y !== null && today.getUTCFullYear() <= y;
}

export function editWindowMessage(createdOn: string): string {
  const y = createdYear(createdOn);
  return y === null
    ? "Locked: this row's created date could not be read. Ask Corporate Marketing to change it."
    : `Locked: this row was created in ${y}, so Account Team can edit it only until 31 Dec ${y}. Ask Corporate Marketing to change it.`;
}

/** BRD §4 / §5.1 step 3: CM may always edit; Sales only rows in their scope and inside the edit window. */
export function canEditRecord(user: CiUser, record: ScopedRow & Pick<CompetitiveRecord, "createdOn">, today = new Date()): boolean {
  if (user.role === "CM") return true;
  return recordInScope(user, record) && salesEditWindowOpen(record.createdOn, today);
}

/**
 * Region values for user scope — the distinct Fab Regions of the fab
 * master, so user Region and Fab Region share one authoritative list
 * (CI Prototype). "Not Assigned" is a placeholder, not a region.
 */
export function regionOptions(reference: ReferenceData): string[] {
  return Array.from(new Set(reference.customerFabs.map((f) => f.fabRegion)))
    .filter((r) => r && r !== NOT_ASSIGNED)
    .sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------- lookups / cascades

/** Active values of one Lookups category, in Sequential Dropdown Lookup order. */
export function lookupOptions(lookups: LookupValue[], category: string): string[] {
  return lookups
    .filter((l) => l.category === category && l.active)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((l) => l.value);
}

export function fabRegionFor(reference: ReferenceData, customer: string, fabLocation: string): string {
  return reference.customerFabs.find((f) => f.customer === customer && f.fabLocation === fabLocation)?.fabRegion ?? "";
}

/** BRD §5.4: Revenue = Actual Order x ASP (CI Prototype: only when both are positive; rounded to 2 decimals). */
export function computeRevenue(actualOrder: string | number, asp: string | number): number | null {
  const qty = Number(actualOrder);
  const price = Number(asp);
  if (!(qty > 0) || !(price > 0)) return null;
  return Math.round(qty * price * 100) / 100;
}

/** BRD §7.2 rule: changing a driver field clears the fields that depend on it (BRD §5.4 cascades). */
const DEPENDENTS: Partial<Record<UserFieldKey, UserFieldKey[]>> = {
  customer: ["fabLocation", "technologyNode"],
  servedMarket: ["technologyNode", "processLocation"],
  topCompetitor: ["productName"],
};

export function applyFieldChange(form: FormState, key: UserFieldKey, value: string): FormState {
  const next = { ...form, [key]: value };
  for (const dep of DEPENDENTS[key] ?? []) next[dep] = "";
  return next;
}

/** Which driver field a cascade needs before it can offer anything (CI Prototype help text). */
export function cascadeBlockedReason(key: UserFieldKey, form: FormState): string | null {
  if (key === "fabLocation" && !form.customer) return "Pick a customer first";
  if (key === "technologyNode" && (!form.customer || !form.servedMarket)) return "Depends on Customer and Served Market";
  if (key === "processLocation" && !form.servedMarket) return "Depends on Served Market";
  if (key === "productName" && !form.topCompetitor) return "Depends on Top Competitor";
  return null;
}

export interface OptionsContext extends FormOptions {
  user: CiUser | null;
}

/**
 * The values offered for one form field — BRD §5.4 cascades, with the CI
 * Prototype's fallbacks for drivers that have nothing on file. Returns []
 * while a cascade's driver is still empty.
 */
export function fieldOptions(key: UserFieldKey, form: FormState, ctx: OptionsContext): string[] {
  const { lookups, reference, user } = ctx;
  const sales = user?.role === "Sales" ? user : null;
  switch (key) {
    case "customer": {
      // CI Prototype: Sales only see the customers they cover.
      if (sales && sales.customerScope !== "All") return [...sales.customerScope].sort((a, b) => a.localeCompare(b));
      return reference.customers;
    }
    case "servedMarket": {
      // CI Prototype: limited to the Sales user's Segment scope.
      const markets = lookupOptions(lookups, "Served Market");
      return sales ? markets.filter((m) => scopeIncludes(sales.segmentScope, m)) : markets;
    }
    case "year":
      // The edit window follows the row's created date now, not its Year, so every Year in the list is offered.
      return lookupOptions(lookups, "Year");
    case "fabLocation": {
      if (!form.customer) return [];
      const all = reference.customerFabs.filter((f) => f.customer === form.customer);
      // No Fab Locations on file: an empty list (and the help text below), never a placeholder value.
      if (!all.length) return [];
      // CI Prototype: only fabs in the Sales user's Region scope.
      return all.filter((f) => !sales || scopeIncludes(sales.regionScope, f.fabRegion)).map((f) => f.fabLocation);
    }
    case "technologyNode": {
      if (!form.customer || !form.servedMarket) return [];
      const nodes = reference.technologyNodes
        .filter((n) => n.customer === form.customer && n.servedMarket === form.servedMarket)
        .map((n) => n.technologyNode);
      return nodes.length ? nodes : [OTHER_ADD_NOTE];
    }
    case "processLocation": {
      if (!form.servedMarket) return [];
      const locations = reference.processLocations
        .filter((p) => p.servedMarket === form.servedMarket)
        .map((p) => p.processLocation);
      // CI Prototype: a market with no cascade falls back to the flat Process Location list.
      return locations.length ? locations : lookupOptions(lookups, "Process Location");
    }
    case "productName": {
      if (!form.topCompetitor) return [];
      const products = reference.competitorProducts.filter((p) => p.competitor === form.topCompetitor).map((p) => p.product);
      return products.length ? products : [OTHER_ADD_NOTE];
    }
    default: {
      const category = FIELDS.find((f) => f.key === key)?.lookupCategory;
      return category ? lookupOptions(lookups, category) : [];
    }
  }
}

/** Help text shown when a cascade has nothing on file (CI Prototype). */
export const NO_FAB_LOCATIONS_MESSAGE = "No Fab Locations available for this customer.";

export function cascadeFallbackHelp(key: UserFieldKey, form: FormState, reference: ReferenceData): string | null {
  if (key === "fabLocation" && form.customer && !reference.customerFabs.some((f) => f.customer === form.customer)) return NO_FAB_LOCATIONS_MESSAGE;
  if (key === "technologyNode" && form.customer && form.servedMarket) {
    const any = reference.technologyNodes.some((n) => n.customer === form.customer && n.servedMarket === form.servedMarket);
    if (!any) return "No nodes on file. Choose “Other” and name it in the Change Note.";
  }
  if (key === "productName" && form.topCompetitor) {
    const any = reference.competitorProducts.some((p) => p.competitor === form.topCompetitor);
    if (!any) return "No products on file. Choose “Other” and name it in the Change Note.";
  }
  return null;
}

// ---------------------------------------------------------------- validation

/** Mandatory fields still missing (CI Prototype: numbers must be greater than zero). */
export function missingFields(form: FormState): UserFieldKey[] {
  return MANDATORY_FIELDS.filter((f) => {
    const v = form[f.key as UserFieldKey] ?? "";
    return f.input === "number" ? !(Number(v) > 0) : v.trim() === "";
  }).map((f) => f.key as UserFieldKey);
}

/**
 * Server-side check of one row against the same rules as manual entry (BRD
 * §7.5): mandatory fields, positive numbers, and every dropdown/cascade
 * value being one the form would offer. `previous` lets an Edit keep a value
 * that has since been removed from a list (the form keeps showing it too).
 */
export function validateInput(
  input: CompetitiveInput,
  ctx: OptionsContext,
  previous?: CompetitiveRecord
): string[] {
  return validateInputIssues(input, ctx, previous).map((i) => i.message);
}

export interface FieldIssue {
  field: UserFieldKey;
  label: string;
  value: string;
  message: string;
}

/** Same checks as validateInput(), keeping which field and value each problem belongs to (import error reports). */
export function validateInputIssues(input: CompetitiveInput, ctx: OptionsContext, previous?: CompetitiveRecord): FieldIssue[] {
  const form = Object.fromEntries(USER_FIELDS.map((f) => [f.key, String(input[f.key as UserFieldKey] ?? "").trim()])) as FormState;
  const issues: FieldIssue[] = [];
  for (const key of missingFields(form)) {
    const spec = FIELDS.find((f) => f.key === key)!;
    issues.push({
      field: key,
      label: spec.label,
      value: form[key],
      message: spec.input === "number" ? `${spec.label} must be a positive number` : `${spec.label} is empty`,
    });
  }
  for (const spec of USER_FIELDS) {
    if (spec.input !== "select" && spec.input !== "cascade") continue;
    const key = spec.key as UserFieldKey;
    const value = form[key];
    if (!value) continue;
    if (previous && String(previous[key]) === value) continue;
    if (!fieldOptions(key, form, ctx).includes(value)) {
      issues.push({ field: key, label: spec.label, value, message: `${spec.label} “${value}” is not in the list` });
    }
  }
  return issues;
}

/** Field-level differences for the audit trail (BRD §5.3), including the derived Fab Region and Revenue. */
export function diffRecords(before: CompetitiveRecord, after: CompetitiveRecord): FieldChange[] {
  return FIELDS.filter((f) => f.key !== "createdBy" && f.key !== "createdOn")
    .filter((f) => String(before[f.key] ?? "") !== String(after[f.key] ?? ""))
    .map((f) => ({ field: f.key, label: f.label, previous: String(before[f.key] ?? ""), current: String(after[f.key] ?? "") }));
}

/** CI Prototype: Edit can only be submitted once at least one field has changed. */
export function formChanged(original: FormState, current: FormState): boolean {
  return USER_FIELDS.some((f) => String(original[f.key as UserFieldKey]) !== String(current[f.key as UserFieldKey]));
}

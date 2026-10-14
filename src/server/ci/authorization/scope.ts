/**
 * User scope: Customer, Served Market and Region, each stored in its own
 * ci_user_management column (customer / segment / region, all STRING). The
 * existing columns are reused; nothing in the schema changes.
 *
 * Each dimension holds exactly ONE of:
 *   - the literal text  All            = every applicable value (a defined scope
 *                                         meaning "no restriction on this
 *                                         dimension", never an ordinary value), or
 *   - a JSON array of text  ["TSMC","UMC"]  = only those values.
 * Any other text is INVALID. All is never mixed into an array: ["All","TSMC"] is
 * invalid, because it is ambiguous. An empty array is invalid (it would mean
 * "nothing", so choose All or at least one value).
 *
 * Reading is strict and fails closed: a dimension that is blank, malformed, an
 * empty array, or holds a non-text / blank / duplicate / "All" item, or is over
 * the limits below, is INVALID, and a person with any invalid dimension gets no
 * Account Team access at all. A row is inside the scope only when ALL THREE
 * dimensions match (a dimension set to All always matches), by exact trimmed text.
 */

export const MAX_SCOPE_VALUES = 200;
export const MAX_SCOPE_VALUE_LENGTH = 200;
export const SCOPE_ALL = "All";

export type ScopeParse = { ok: true; values: string[] } | { ok: false; reason: string };

/** A JSON array of distinct, trimmed, non-blank text values. "All" is not a value. */
export function parseScopeArray(text: string | null | undefined): ScopeParse {
  const t = String(text ?? "").trim();
  if (!t) return { ok: false, reason: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: "not an array" };
  if (parsed.length === 0) return { ok: false, reason: "no values" };
  if (parsed.length > MAX_SCOPE_VALUES) return { ok: false, reason: "too many values" };
  const seen = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== "string") return { ok: false, reason: "a value is not text" };
    const v = item.trim();
    if (!v) return { ok: false, reason: "a value is blank" };
    if (v !== item) return { ok: false, reason: "a value has leading or trailing spaces" };
    if (v.length > MAX_SCOPE_VALUE_LENGTH) return { ok: false, reason: "a value is too long" };
    if (v.toLowerCase() === "all") return { ok: false, reason: "All cannot be listed with other values; choose All on its own" };
    if (seen.has(v)) return { ok: false, reason: "a value is repeated" };
    seen.add(v);
  }
  return { ok: true, values: parsed as string[] };
}

/** One dimension: "All" or a list of values. */
export type ScopeSetting = typeof SCOPE_ALL | string[];

export type DimensionParse = { ok: true; setting: ScopeSetting } | { ok: false; reason: string };

/** Reads one stored dimension: exactly "All", or a valid JSON array. Anything else is invalid. */
export function parseScopeDimension(text: string | null | undefined): DimensionParse {
  const t = String(text ?? "").trim();
  if (t === SCOPE_ALL) return { ok: true, setting: SCOPE_ALL };
  const p = parseScopeArray(t);
  return p.ok ? { ok: true, setting: p.values } : { ok: false, reason: p.reason };
}

/** The text to store for one dimension. Throws on anything the reader would refuse. Lists are trimmed and de-duplicated first. */
export function serializeScopeDimension(setting: ScopeSetting): string {
  if (setting === SCOPE_ALL) return SCOPE_ALL;
  const clean = Array.from(new Set(setting.map((v) => v.trim())));
  const text = JSON.stringify(clean);
  const check = parseScopeArray(text);
  if (!check.ok) throw new Error(`Invalid scope: ${check.reason}.`);
  return text;
}

/** The text to store for a list of values (never "All"). */
export function serializeScope(values: string[]): string {
  return serializeScopeDimension(values);
}

export interface AccountScope {
  customers: ScopeSetting;
  segments: ScopeSetting;
  regions: ScopeSetting;
}

export type ScopeResult = { ok: true; scope: AccountScope } | { ok: false; reason: string };

export function accountScopeFrom(record: { customer: string; segment: string; region: string }): ScopeResult {
  const dims = [
    ["Customer", record.customer],
    ["Served Market", record.segment],
    ["Region", record.region],
  ] as const;
  const out: ScopeSetting[] = [];
  for (const [label, text] of dims) {
    const p = parseScopeDimension(text);
    if (!p.ok) return { ok: false, reason: `${label} scope is invalid (${p.reason}).` };
    out.push(p.setting);
  }
  return { ok: true, scope: { customers: out[0], segments: out[1], regions: out[2] } };
}

const covers = (setting: ScopeSetting, value: string) => setting === SCOPE_ALL || setting.includes(value.trim());

/** A row is in scope only when its Customer AND Served Market AND Region are all covered (a dimension set to All covers any value). */
export function rowInAccountScope(scope: AccountScope, row: { customer: string; segment: string; region: string }): boolean {
  return covers(scope.customers, row.customer) && covers(scope.segments, row.segment) && covers(scope.regions, row.region);
}

/** True when the scope restricts nothing (All / All / All). */
export const scopeIsUnrestricted = (s: AccountScope) => s.customers === SCOPE_ALL && s.segments === SCOPE_ALL && s.regions === SCOPE_ALL;

import { parseScopeArray, parseScopeDimension, serializeScopeDimension, type ScopeSetting } from "@/server/ci/authorization/scope";
import type { CiUserRecordRaw } from "@/types/ci-api";

/**
 * Add / Edit User form rules (pure: no network, no database). The server runs the
 * same function again before any write; the browser copy only gives early feedback
 * and never grants anything.
 *
 *  - Roles: exactly "Account Team" or "Corporate Marketing". No Admin role.
 *  - Email: valid, lower-cased, and ONE record per email, compared case-insensitively
 *    (any existing record for the email blocks a new one, active or not).
 *  - Corporate Marketing: Customer, Served Market and Region are fixed to "All".
 *  - Account Team: each of the three is set to "All" (every applicable value) or to a
 *    list of specific values, in any combination. "All" is a defined scope, never a
 *    value in a list: a list may not contain "All", repeats, blanks or oversize
 *    entries, and an empty list is refused (choose All, or add a value).
 *  - Where an approved master list is supplied (`masters`), every selected value must be
 *    in it. A dimension with no master (Customer today) is checked for shape only.
 * Stored as the text "All" or a JSON array of text, in the existing customer / segment /
 * region columns.
 */

export const USER_ROLES = ["Account Team", "Corporate Marketing"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** "All", or the specific values chosen. */
export type ScopeInput = "All" | string[];

export interface UserFormValues {
  userName: string;
  email: string;
  role: string;
  customers: ScopeInput;
  segments: ScopeInput;
  regions: ScopeInput;
}

export const EMPTY_USER_FORM: UserFormValues = { userName: "", email: "", role: "", customers: [], segments: [], regions: [] };

export type UserFormField = "userName" | "email" | "role" | "customers" | "segments" | "regions";
type ScopeField = "customers" | "segments" | "regions";

/** The row a real save inserts into corp_marketing_dev.ci.ci_user_management. */
export interface ProposedUserRow {
  ci_user_id: string;
  user_name: string;
  user_email: string;
  role_name: string;
  customer: string;
  segment: string;
  region: string;
  status: string;
  last_sign_in: null;
  is_active: true;
  created_by: string;
  modified_by: string;
}

export interface UserFormContext {
  /** Every record already known (real list, mock users, local test entries). */
  existing: CiUserRecordRaw[];
  signedIn: { name: string; email: string } | null;
  newId?: () => string;
  /** Approved value lists per dimension. Only a non-empty list is enforced; absent / empty = shape check only. */
  masters?: Partial<Record<ScopeField, string[]>>;
}

export interface UserFormResult {
  errors: Partial<Record<UserFormField, string>>;
  warnings: string[];
  /** Present only when there are no errors. */
  proposed: ProposedUserRow | null;
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
// The local development login's identity is name@localhost (no dot in the domain). That form is accepted ONLY in a
// development build; every other build (including Production) still requires a real domain.
const LOCALHOST_EMAIL_RE = /^[^\s@,;]+@localhost$/i;
const isValidEmail = (email: string) => EMAIL_RE.test(email) || (process.env.NODE_ENV === "development" && LOCALHOST_EMAIL_RE.test(email));
export const SCOPE_LABELS: Record<ScopeField, string> = { customers: "Customer", segments: "Served Market", regions: "Region" };

function scopeError(field: ScopeField, input: ScopeInput, master: string[] | undefined): string | null {
  const label = SCOPE_LABELS[field];
  if (input === "All") return null;
  if (!Array.isArray(input)) return `${label}: choose All or add at least one value.`;
  if (input.length === 0) return `${label}: choose All, or add at least one value.`;
  const parsed = parseScopeArray(JSON.stringify(input));
  if (!parsed.ok) return `${label}: ${parsed.reason}.`;
  if (master && master.length > 0) {
    const unknown = parsed.values.filter((v) => !master.includes(v));
    if (unknown.length > 0) return `${label}: ${unknown.map((v) => `“${v}”`).join(", ")} ${unknown.length === 1 ? "is" : "are"} not in the approved ${label} list.`;
  }
  return null;
}

const domainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

export function validateUserForm(values: UserFormValues, ctx: UserFormContext): UserFormResult {
  const errors: UserFormResult["errors"] = {};
  const warnings: string[] = [];

  const userName = values.userName.trim();
  if (!userName) errors.userName = "Enter the user's name.";
  else if (userName.length > 200) errors.userName = "The name must be 200 characters or fewer.";

  const email = values.email.trim().toLowerCase();
  if (!email) errors.email = "Enter the user's email address.";
  else if (email.length > 254 || !isValidEmail(email)) errors.email = "Enter one valid email address.";
  else if (ctx.existing.some((u) => u.email.trim().toLowerCase() === email)) {
    errors.email = "This email already has a CI user record. CI keeps one record per email, so edit that record instead.";
  } else if (ctx.signedIn && domainOf(email) !== domainOf(ctx.signedIn.email)) {
    warnings.push(`This address is not in your domain (${domainOf(ctx.signedIn.email)}).`);
  }

  const role = USER_ROLES.find((r) => r === values.role);
  if (!values.role) errors.role = "Choose a role.";
  else if (!role) errors.role = "The role must be Account Team or Corporate Marketing.";

  if (role === "Account Team") {
    for (const field of ["customers", "segments", "regions"] as const) {
      const message = scopeError(field, values[field], ctx.masters?.[field]);
      if (message) errors[field] = message;
    }
  }

  if (Object.keys(errors).length > 0 || !role) return { errors, warnings, proposed: null };

  const isCm = role === "Corporate Marketing";
  const text = (v: ScopeInput) => (isCm ? "All" : serializeScopeDimension(v as ScopeSetting));
  const actor = ctx.signedIn?.name || ctx.signedIn?.email || "";
  return {
    errors,
    warnings,
    proposed: {
      ci_user_id: (ctx.newId ?? (() => crypto.randomUUID()))(),
      user_name: userName,
      user_email: email,
      role_name: role,
      customer: text(values.customers),
      segment: text(values.segments),
      region: text(values.regions),
      status: "Active",
      last_sign_in: null,
      is_active: true,
      created_by: actor,
      modified_by: actor,
    },
  };
}

/** A proposed row shown in the table as a clearly marked local test entry. */
export function toLocalTestRecord(row: ProposedUserRow, n: number): CiUserRecordRaw {
  return {
    id: `MOCK-LOCAL-${n}`,
    userName: `MOCK (local test) ${row.user_name}`,
    email: row.user_email,
    role: row.role_name,
    customer: row.customer,
    segment: row.segment,
    region: row.region,
    status: row.status,
    lastSignIn: "",
    isActive: true,
  };
}

/** The form values for an existing record (Edit). A dimension that is not "All" or a valid JSON array loads as an empty list, so it must be re-entered. */
export function valuesFromRecord(r: CiUserRecordRaw): UserFormValues {
  const dim = (text: string): ScopeInput => {
    const p = parseScopeDimension(text);
    return p.ok ? p.setting : [];
  };
  return { userName: r.userName, email: r.email, role: r.role, customers: dim(r.customer), segments: dim(r.segment), regions: dim(r.region) };
}

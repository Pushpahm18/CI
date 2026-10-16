"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { DirectoryUserPicker } from "@/components/ci/directory-user-picker";
import { ScopeSelect } from "@/components/ci/scope-select";
import { Input, Label, Select } from "@/components/ui/input";
import { ApiError } from "@/lib/ci/api";
import { MICROSOFT_DIRECTORY_PICKER_ENABLED } from "@/lib/ci/directory-picker";
import { isActiveRecord } from "@/lib/ci/user-rules";
import {
  EMPTY_USER_FORM,
  SCOPE_LABELS,
  USER_ROLES,
  validateUserForm,
  valuesFromRecord,
  type UserFormContext,
  type UserFormField,
  type UserFormResult,
  type UserFormValues,
} from "@/lib/ci/user-form";
import type { CiUserRecordRaw } from "@/types/ci-api";

/*
 * Add New User / Edit User, as a card above the table (the User Management layout of the reference
 * screen). The person is chosen from the Microsoft directory while the picker is on
 * (lib/ci/directory-picker.ts), otherwise the name and email are typed. Role is a dropdown; Customer,
 * Served Market and Region are checkbox dropdowns with Select All for Account Team, and fixed to All for
 * Corporate Marketing.
 *
 * Save checks the fields (errors show under them) and, when they are valid, sends the user to the server,
 * which checks them again and requires Corporate Marketing authorization. With `editing` set the same form
 * edits that one record: the email is fixed, and the server applies the lock-out rules (nobody changes their
 * own role; one active Corporate Marketing user always remains).
 */

type ScopeField = "customers" | "segments" | "regions";

const CUSTOM_HINT: Record<ScopeField, string> = {
  customers: "Add a customer and press Enter",
  segments: "Add a served market and press Enter",
  regions: "Add a region code and press Enter",
};

export function UserFormCard({
  existing,
  editing = null,
  signedIn,
  masters,
  suggestions,
  onCancel,
  onSave,
  onReactivate,
}: {
  /** Every OTHER record already known, for the one-record-per-email check. */
  existing: CiUserRecordRaw[];
  /** The record being edited; null for Add New User. */
  editing?: CiUserRecordRaw | null;
  signedIn: { name: string; email: string } | null;
  /** Approved value lists (only non-empty ones are enforced). */
  masters: UserFormContext["masters"];
  /** Values listed in the Customer / Served Market / Region dropdowns. */
  suggestions: Partial<Record<ScopeField, string[]>>;
  onCancel: () => void;
  /** Sends the user to the server. Throws on failure; the message is shown in the form. */
  onSave: (values: UserFormValues) => Promise<void>;
  /** Add New User only: reactivates the off-boarded record that has the typed email. Throws on failure. */
  onReactivate?: (record: CiUserRecordRaw) => Promise<void>;
}) {
  const [values, setValues] = React.useState<UserFormValues>(() => (editing ? valuesFromRecord(editing) : EMPTY_USER_FORM));
  const [result, setResult] = React.useState<UserFormResult | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string[]>([]);
  const cardRef = React.useRef<HTMLElement>(null);

  React.useEffect(() => {
    cardRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, []);

  const set = <K extends keyof UserFormValues>(key: K, value: UserFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setResult(null);
    setSaveError([]);
  };
  const err = (f: UserFormField) => result?.errors[f];
  const isCm = values.role === "Corporate Marketing";
  const isAccountTeam = values.role === "Account Team";
  // The picker blocks emails that already have an ACTIVE record; an off-boarded person can be picked, and is then offered Reactivate.
  const existingEmails = React.useMemo(() => new Set(existing.filter(isActiveRecord).map((u) => u.email.trim().toLowerCase())), [existing]);
  const offboarded = !editing && onReactivate ? existing.find((u) => !isActiveRecord(u) && u.email.trim().toLowerCase() === values.email.trim().toLowerCase()) : undefined;
  const [reactivating, setReactivating] = React.useState(false);

  async function reactivate(record: CiUserRecordRaw) {
    if (!onReactivate) return;
    setReactivating(true);
    setSaveError([]);
    try {
      await onReactivate(record);
    } catch (e) {
      setSaveError(e instanceof ApiError && e.details.length ? e.details : [e instanceof Error ? e.message : "Reactivating failed."]);
      setReactivating(false);
    }
  }
  const typed = Boolean(editing) || !MICROSOFT_DIRECTORY_PICKER_ENABLED;

  async function save() {
    const r = validateUserForm(values, { existing, signedIn, masters });
    setResult(r);
    if (!r.proposed) return;
    setSaving(true);
    setSaveError([]);
    try {
      await onSave(values);
    } catch (e) {
      setSaveError(e instanceof ApiError && e.details.length ? e.details : [e instanceof Error ? e.message : "Saving failed."]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section ref={cardRef} aria-label={editing ? "Edit User" : "Add New User"} className="mb-3 rounded-lg border border-border bg-surface shadow-sm">
      <div className="border-b border-border px-5 py-3">
        <h2 className="text-[15px] font-semibold text-foreground">{editing ? "Edit User" : "Add New User"}</h2>
      </div>

      <div className="space-y-4 px-5 py-4">
        {typed ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label className="mb-1 block text-[12px]">
                User Name <span className="text-danger">*</span>
              </Label>
              <Input className="h-9 text-[13px]" value={values.userName} onChange={(e) => set("userName", e.target.value)} aria-invalid={Boolean(err("userName"))} />
              {err("userName") && <p className="mt-1 text-[12px] text-danger">{err("userName")}</p>}
            </div>
            <div>
              <Label className="mb-1 block text-[12px]">
                User Email {!editing && <span className="text-danger">*</span>}
              </Label>
              {editing ? (
                <Input className="h-9 text-[13px]" value={values.email} readOnly aria-label="User Email (cannot be changed)" title="The email identifies the person and cannot be changed." />
              ) : (
                <Input
                  className="h-9 text-[13px]"
                  type="email"
                  value={values.email}
                  placeholder={signedIn ? `name@${signedIn.email.split("@")[1] ?? "domain.com"}` : "name@domain.com"}
                  onChange={(e) => set("email", e.target.value)}
                  aria-invalid={Boolean(err("email"))}
                />
              )}
              {!editing && err("email") && <p className="mt-1 text-[12px] text-danger">{err("email")}</p>}
            </div>
          </div>
        ) : (
          <DirectoryUserPicker
            userName={values.userName}
            email={values.email}
            existingEmails={existingEmails}
            nameError={err("userName")}
            emailError={err("email")}
            onSelect={(u) => {
              setValues((v) => ({ ...v, userName: u.userName, email: u.email }));
              setResult(null);
              setSaveError([]);
            }}
            onType={(field, value) => set(field, value)}
          />
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <Label className="mb-1 block text-[12px]">
              Role <span className="text-danger">*</span>
            </Label>
            <Select className="h-9 text-[13px]" value={values.role} onChange={(e) => set("role", e.target.value)} aria-invalid={Boolean(err("role"))}>
              <option value="">Select…</option>
              {USER_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
            {err("role") && <p className="mt-1 text-[12px] text-danger">{err("role")}</p>}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          {(["customers", "segments", "regions"] as const).map((f) => (
            <div key={f}>
              <Label className="mb-1 block text-[12px]">
                {SCOPE_LABELS[f]} {isAccountTeam && <span className="text-danger">*</span>}
              </Label>
              {isAccountTeam ? (
                <ScopeSelect
                  options={suggestions[f] ?? []}
                  value={values[f]}
                  onChange={(v) => set(f, v)}
                  invalid={Boolean(err(f))}
                  allowCustom
                  customPlaceholder={CUSTOM_HINT[f]}
                  ariaLabel={SCOPE_LABELS[f]}
                />
              ) : (
                <Input
                  className="h-9 text-[13px]"
                  value={isCm ? "All" : ""}
                  placeholder="Choose a role first"
                  readOnly
                  disabled
                  aria-label={isCm ? `${SCOPE_LABELS[f]}: All` : `${SCOPE_LABELS[f]} (choose a role first)`}
                />
              )}
              {isAccountTeam && err(f) && <p className="mt-1 text-[12px] text-danger">{err(f)}</p>}
            </div>
          ))}
        </div>
        <p className="-mt-1 text-[12px] text-muted">
          {isCm
            ? "Corporate Marketing has access to all customers, served markets and regions, so all three are saved as “All”."
            : isAccountTeam
              ? "For each one, choose Select All or tick specific values. Any mix works, for example one customer with all served markets and all regions."
              : "Choose a role to set the scope. Corporate Marketing gets All for all three; Account Team chooses All or specific values for each."}
        </p>

        {offboarded && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-accent-bg-strong bg-accent-bg px-3 py-2 text-[12.5px] text-accent">
            <p>
              <span className="font-medium">{offboarded.userName || offboarded.email}</span> was off-boarded. CI keeps one record per email, so reactivate that record instead of adding it again. It comes back with the
              role and scope stored on it.
            </p>
            <Button size="sm" onClick={() => void reactivate(offboarded)} disabled={reactivating || saving}>
              {reactivating ? "Reactivating…" : "Reactivate"}
            </Button>
          </div>
        )}

        {result && result.warnings.length > 0 && (
          <div className="rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-[12.5px] text-warning">
            {result.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </div>
        )}
        {result && Object.keys(result.errors).length > 0 && <div className="rounded-md bg-danger-bg px-3 py-2 text-[12.5px] text-danger">Fix the highlighted fields, then Save again.</div>}
        {saveError.length > 0 && (
          <div className="rounded-md bg-danger-bg px-3 py-2 text-[12.5px] text-danger">
            <p className="font-medium">Not saved</p>
            {saveError.map((m) => (
              <p key={m}>{m}</p>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </section>
  );
}

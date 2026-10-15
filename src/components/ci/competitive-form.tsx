"use client";

import * as React from "react";
import { AlertTriangle, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableWrap, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { ApiError, ciApi } from "@/lib/ci/api";
import { FIELDS, type FieldSpec } from "@/lib/ci/field-spec";
import {
  applyFieldChange,
  blankForm,
  cascadeBlockedReason,
  cascadeFallbackHelp,
  computeRevenue,
  fabRegionFor,
  fieldOptions,
  formChanged,
  formToInput,
  missingFields,
  recordToForm,
  type FormState,
  type UserFieldKey,
} from "@/lib/ci/rules";
import { cn, formatDate, formatDateTime } from "@/lib/utils";
import type { ChangeNote, CiUser, CompetitiveRecord, FormOptions } from "@/types/ci";
import type { SaveRecordResponse } from "@/types/ci-api";

// Required-and-empty treatment, as on SAMBA forms: a red box (2px inset outline + light red tint) on the cell, matching the asterisk in its
// column heading. An inset box-shadow, not `border-2 border-danger`: globals.css has an unlayered `* { border-color: var(--border) }` that beats
// Tailwind layered border utilities, so a border colour class silently stays the default sand border.
const MISSING = "[box-shadow:inset_0_0_0_2px_var(--danger)] bg-danger-bg/50";

function nowLabel(): string {
  return formatDateTime(new Date().toISOString());
}

/**
 * Add / Edit row, laid out like SAMBA's Add Application form (UI reference only): a Card holding one spreadsheet-style row of
 * cells under a solid brand-colour header, a Change Note card, the red box on required-and-empty cells, the "Submit is
 * disabled until..." hint and the red "Save failed" notice, then Cancel / Submit at the bottom right. All CI behaviour (fields,
 * cascades, validation, save) is unchanged. It replaces the grid while it is open (the screen decides that).
 */
export function CompetitiveForm({
  open,
  record,
  existingNotes,
  options,
  user,
  signedInName,
  applicationSuggestions,
  onClose,
  onSaved,
  saveBlockedReason,
}: {
  open: boolean;
  /** The row being edited; undefined for Add. */
  record?: CompetitiveRecord;
  existingNotes: ChangeNote[];
  options: FormOptions;
  user: CiUser | null;
  signedInName: string;
  /** CI Prototype: Application suggests values already used. */
  applicationSuggestions: string[];
  onClose: () => void;
  onSaved: (response: SaveRecordResponse) => void;
  /** When set, Submit is disabled and this is shown: the save cannot be done safely yet (never a button that silently fails). */
  saveBlockedReason?: string;
}) {
  const isEdit = Boolean(record);
  const ctx = React.useMemo(() => ({ ...options, user }), [options, user]);
  const [original] = React.useState<FormState>(() => (record ? recordToForm(record) : blankForm()));
  const [form, setForm] = React.useState<FormState>(() => {
    if (record) return original;
    // Add defaults (BRD §5.1 step 2 / CI Prototype): Wafer Size defaults to 300 mm,
    // and a Sales user who covers exactly one customer gets it preselected.
    const f = { ...original };
    const wafer300 = fieldOptions("waferSize", f, ctx).find((v) => /^300\s*mm/i.test(v));
    if (wafer300) f.waferSize = wafer300;
    if (user?.role === "Sales" && user.customerScope !== "All" && user.customerScope.length === 1) {
      f.customer = user.customerScope[0];
    }
    return f;
  });
  const [notes, setNotes] = React.useState<string[]>([""]);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; details: string[] } | null>(null);

  const missing = new Set(missingFields(form));
  const noteOk = notes[0].trim() !== "";
  const changed = !isEdit || formChanged(original, form);
  const canSubmit = missing.size === 0 && noteOk && changed && !submitting && !saveBlockedReason;

  // Escape goes back, like the prototype.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !submitting && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, submitting, onClose]);


  function update(key: UserFieldKey, value: string) {
    setForm((f) => applyFieldChange(f, key, value));
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const body = { input: formToInput(form), notes };
      const response = record ? await ciApi.updateRecord(record.recordId, body) : await ciApi.createRecord(body);
      onSaved(response);
    } catch (e) {
      setError({
        message: e instanceof Error ? e.message : "Save failed.",
        details: e instanceof ApiError ? e.details : [],
      });
    } finally {
      setSubmitting(false);
    }
  }

  function autoValue(key: FieldSpec["key"]): string {
    if (key === "fabRegion") return fabRegionFor(options.reference, form.customer, form.fabLocation) || "—";
    if (key === "revenue") {
      const r = computeRevenue(form.actualOrder, form.asp);
      return r === null ? "—" : r.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    if (key === "createdBy") return record?.createdBy ?? signedInName;
    if (key === "createdOn") return formatDate(record?.createdOn ?? new Date().toISOString());
    return "";
  }

  function autoHelp(key: FieldSpec["key"]): string | null {
    if (key === "revenue") return "Actual Order Qty × ASP";
    if (key === "fabRegion") return "From Customer and Fab Location";
    return null;
  }

  function help(spec: FieldSpec): string | null {
    if (spec.input === "auto") return autoHelp(spec.key);
    const key = spec.key as UserFieldKey;
    if (key === "waferSize") return "Defaults to 300mm";
    return cascadeBlockedReason(key, form) ?? cascadeFallbackHelp(key, form, options.reference);
  }

  function control(spec: FieldSpec) {
    const key = spec.key as UserFieldKey;
    const tip = help(spec) ?? undefined;
    if (spec.input === "auto") {
      return <Input id={`f_${spec.key}`} readOnly tabIndex={-1} value={autoValue(spec.key)} title={tip} aria-label={spec.label} className="min-w-[128px] bg-surface-alt text-muted" />;
    }
    if (spec.input === "select" || spec.input === "cascade") {
      const blocked = cascadeBlockedReason(key, form);
      const values = fieldOptions(key, form, ctx);
      // Keep showing a value the row already has even if it's no longer offered (CI Prototype).
      const list = form[key] && !values.includes(form[key]) ? [form[key], ...values] : values;
      return (
        <Select
          id={`f_${spec.key}`}
          value={form[key]}
          disabled={Boolean(blocked)}
          title={tip}
          aria-label={spec.label}
          className={"min-w-[128px]"}
          onChange={(e) => update(key, e.target.value)}
        >
          <option value="">{blocked ?? "Select…"}</option>
          {list.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </Select>
      );
    }
    if (spec.input === "number") {
      return (
        <Input
          id={`f_${spec.key}`}
          type="number"
          min={0}
          step="any"
          inputMode="decimal"
          value={form[key]}
          aria-label={spec.label}
          className={"min-w-[128px]"}
          onChange={(e) => update(key, e.target.value)}
        />
      );
    }
    return (
      <Input
        id={`f_${spec.key}`}
        value={form[key]}
        aria-label={spec.label}
        list={key === "processApplication" ? "ci-application-suggestions" : undefined}
        className={"min-w-[128px]"}
        onChange={(e) => update(key, e.target.value)}
      />
    );
  }

  if (!open) return null;

  // Guidance that matters while filling the row in (a list with nothing on file, and so on); the standard hints stay in each field's tooltip.
  const fieldNotes = FIELDS.filter((s) => s.input !== "auto" && (s.key as string) !== "waferSize")
    .map((s) => ({ label: s.label, text: cascadeFallbackHelp(s.key as UserFieldKey, form, options.reference) }))
    .filter((n): n is { label: string; text: string } => Boolean(n.text));

  // The required columns still empty, by name (plus the Change Note), so the person is told exactly what is left.
  const missingNames = [...FIELDS.filter((s) => s.mandatory && missing.has(s.key as UserFieldKey)).map((s) => s.label), ...(noteOk ? [] : ["Change Note"])];

  return (
    <div className="space-y-4">
      {saveBlockedReason && (
        <div className="rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-[12.5px] text-warning">
          <p className="font-medium">Saving is blocked</p>
          <p>{saveBlockedReason}</p>
        </div>
      )}

      {/* Same layout as SAMBA's Add Application: one horizontal, spreadsheet-style row of cells under a solid brand-colour header
          bar (the shared THead / TH / TD), scrolling sideways. A required column carries an asterisk in its heading; a required
          cell that is still empty gets the red box (see MISSING) from the start. */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>{record ? `Competitive Info · ${record.recordId}` : "Competitive Info"}</CardTitle>
          <p className="text-[12px] text-muted">
            <span className="text-danger">*</span> Required
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <TableWrap>
            <Table className="text-[12px]">
              <THead>
                <TR>
                  <TH>Record ID</TH>
                  {FIELDS.map((spec) => (
                    <TH key={spec.key}>
                      {spec.label}
                      {spec.mandatory && <span className="ml-0.5 text-asm-amber-light">*</span>}
                    </TH>
                  ))}
                </TR>
              </THead>
              <TBody>
                <TR>
                  <TD className="min-w-[140px] text-muted">{record?.recordId ?? "Auto-generated"}</TD>
                  {FIELDS.map((spec) => (
                    <TD key={spec.key} className={cn("min-w-[160px]", spec.mandatory && missing.has(spec.key as UserFieldKey) && MISSING)}>
                      {control(spec)}
                    </TD>
                  ))}
                </TR>
              </TBody>
            </Table>
          </TableWrap>
          <datalist id="ci-application-suggestions">
            {applicationSuggestions.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </CardContent>
        {record && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 border-t border-border px-4 py-3 text-[12.5px] sm:grid-cols-4">
            {[
              ["Created by", record.createdBy || "—"],
              ["Created on", record.createdOn ? formatDate(record.createdOn) : "—"],
              ["Last modified by", record.modifiedBy || "Not modified yet"],
              ["Last modified on", record.modifiedOn ? formatDateTime(record.modifiedOn) : "—"],
            ].map(([label, value]) => (
              <p key={label} className="min-w-0">
                <span className="block text-[11px] text-muted">{label}</span>
                <span className="break-words text-foreground">{value}</span>
              </p>
            ))}
          </div>
        )}
      </Card>

      {fieldNotes.length > 0 && (
        <ul className="space-y-0.5 rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-[12.5px] text-warning">
          {fieldNotes.map((n) => (
            <li key={n.label}>
              <span className="font-medium">{n.label}:</span> {n.text}
            </li>
          ))}
        </ul>
      )}

      {/* BRD §5.3: Change Note grid (Action Taken By, Date & Time, Additional Notes) with the inline note entry: the first
          note is mandatory (red box and red hint until it is filled in), "+" adds another. Earlier notes of an edited row are
          listed below the new ones. */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Change Note</CardTitle>
          <div className="flex items-center gap-3">
            <p className={cn("text-[12px]", noteOk ? "text-muted" : "text-danger")}>(Change Notes are mandatory. Please use the + icon to add more notes.)</p>
            <Button size="icon" variant="ghost" title="Add note" aria-label="Add note" onClick={() => setNotes((n) => [...n, ""])}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 p-0">
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>Action Taken By</TH>
                  <TH>Date &amp; Time</TH>
                  <TH>Additional Notes</TH>
                </TR>
              </THead>
              <TBody>
                {notes.map((text, i) => (
                  <TR key={`new-${i}`}>
                    <TD className="w-44">{signedInName}</TD>
                    <TD className="w-44 whitespace-nowrap tabular-nums">{nowLabel()}</TD>
                    <TD className={cn("text-left", i === 0 && !noteOk && MISSING)}>
                      <Textarea
                        rows={2}
                        value={text}
                        aria-label={`Change note ${i + 1}`}
                        placeholder={i === 0 ? `Why is this row being ${isEdit ? "changed" : "added"}? (required)` : "Optional extra note"}
                        onChange={(e) => setNotes((n) => n.map((v, j) => (j === i ? e.target.value : v)))}
                      />
                    </TD>
                  </TR>
                ))}
                {[...existingNotes]
                  .sort((a, b) => (a.dateTime < b.dateTime ? 1 : -1))
                  .map((n) => (
                    <TR key={n.id}>
                      <TD>{n.actionTakenBy || "—"}</TD>
                      <TD className="whitespace-nowrap tabular-nums">{formatDateTime(n.dateTime)}</TD>
                      <TD className="whitespace-pre-line text-left">{n.notes}</TD>
                    </TR>
                  ))}
              </TBody>
            </Table>
          </TableWrap>
        </CardContent>
      </Card>

      {error && (
        <p className="rounded-md border border-danger/40 bg-danger-bg px-3 py-2.5 text-[12.5px] text-danger">
          <span className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-4 w-4" /> Save failed
          </span>
          <span className="mt-0.5 block">{error.message}</span>
          {error.details.length > 0 && (
            <span className="mt-1 block">
              {error.details.map((d) => (
                <span key={d} className="block">
                  • {d}
                </span>
              ))}
            </span>
          )}
        </p>
      )}

      {/* Why Submit is disabled, in plain language right where the person is looking: every required column still empty, by name. */}
      {!submitting && !canSubmit && (
        <div className="space-y-1 text-right text-[12px]">
          {missingNames.length > 0 && (
            <p className="font-medium text-danger">
              Required {missingNames.length === 1 ? "column" : "columns"} missing ({missingNames.length}): {missingNames.join(", ")}
            </p>
          )}
          <p className="text-muted">
            {saveBlockedReason
              ? "Submit is disabled: saving is blocked — see the notice above."
              : missingNames.length > 0
                ? "Submit is disabled until every highlighted field above is filled in and at least one Change Note is added."
                : "Submit is disabled until something is changed."}
          </p>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!canSubmit} title={saveBlockedReason}>
          {submitting ? "Saving…" : "Submit"}
        </Button>
      </div>
    </div>
  );
}

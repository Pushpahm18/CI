"use client";

import * as React from "react";
import { AlertTriangle, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableWrap, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Drawer } from "@/components/ci/drawer";
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

// Required-and-empty treatment: a red
// box around the field, matching the red asterisk on its label.
const REQUIRED_BOX = "rounded-md border-2 border-danger bg-danger-bg/50 p-1.5 -m-1.5";

function Field({
  spec,
  missing,
  help,
  children,
}: {
  spec: FieldSpec;
  missing: boolean;
  help?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className={missing ? REQUIRED_BOX : ""}>
      <Label className="mb-1 flex items-center gap-1" htmlFor={`f_${spec.key}`}>
        {spec.label}
        {spec.mandatory && <span className="text-danger">*</span>}
        {spec.input === "auto" && (
          <Badge className="ml-auto" tone="neutral">
            Auto
          </Badge>
        )}
      </Label>
      {children}
      {help && <p className="mt-1 text-[11.5px] text-muted">{help}</p>}
    </div>
  );
}

function nowLabel(): string {
  return formatDateTime(new Date().toISOString());
}

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

  // CI Prototype footer hint, in its order of precedence.
  const hint = saveBlockedReason
    ? "Saving is blocked — see the notice above"
    : missing.size > 0
      ? `${missing.size} required field${missing.size > 1 ? "s" : ""} left`
      : !noteOk
        ? "Add a Change Note to submit"
        : !changed
          ? "No changes yet"
          : "";

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

  function control(spec: FieldSpec) {
    const key = spec.key as UserFieldKey;
    if (spec.input === "auto") {
      return <Input id={`f_${spec.key}`} readOnly tabIndex={-1} value={autoValue(spec.key)} className="bg-surface-alt text-muted" />;
    }
    if (spec.input === "select" || spec.input === "cascade") {
      const blocked = cascadeBlockedReason(key, form);
      const values = fieldOptions(key, form, ctx);
      // Keep showing a value the row already has even if it's no longer offered (CI Prototype).
      const list = form[key] && !values.includes(form[key]) ? [form[key], ...values] : values;
      return (
        <Select id={`f_${spec.key}`} value={form[key]} disabled={Boolean(blocked)} onChange={(e) => update(key, e.target.value)}>
          <option value="">Select…</option>
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
          onChange={(e) => update(key, e.target.value)}
        />
      );
    }
    return (
      <Input
        id={`f_${spec.key}`}
        value={form[key]}
        list={key === "processApplication" ? "ci-application-suggestions" : undefined}
        onChange={(e) => update(key, e.target.value)}
      />
    );
  }

  function help(spec: FieldSpec): string | null {
    if (spec.input === "auto") return autoHelp(spec.key);
    const key = spec.key as UserFieldKey;
    if (key === "waferSize") return "Defaults to 300mm";
    return cascadeBlockedReason(key, form) ?? cascadeFallbackHelp(key, form, options.reference);
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={record ? `Edit ${record.recordId}` : "Add Row"}
      subtitle={record ? `${record.customer} · ${record.servedMarket} · ${record.quarter} ${record.year}` : undefined}
      footer={
        <>
          <span className="mr-auto text-[12px] text-muted">{hint}</span>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit} title={saveBlockedReason}>
            {submitting ? "Saving…" : "Submit"}
          </Button>
        </>
      }
    >
      {saveBlockedReason && (
        <div className="mb-4 rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-[12.5px] text-warning">
          <p className="font-medium">Saving is blocked</p>
          <p>{saveBlockedReason}</p>
        </div>
      )}
      <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
        {FIELDS.map((spec) => (
          <Field key={spec.key} spec={spec} missing={spec.mandatory && missing.has(spec.key as UserFieldKey)} help={help(spec)}>
            {control(spec)}
          </Field>
        ))}
      </div>
      <datalist id="ci-application-suggestions">
        {applicationSuggestions.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>

      {/* BRD §5.3: Change Note grid (Action Taken By, Date & Time, Additional
          Notes) — the Notes grid, with the CI Prototype's inline note
          entry: the first note is mandatory, "+" adds another. */}
      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">Change Note</h3>
          <div className="flex items-center gap-2">
            <p className={cn("text-[12px]", noteOk ? "text-muted" : "text-danger")}>(Mandatory for every add or edit.)</p>
            <Button size="icon" variant="ghost" title="Add another note" onClick={() => setNotes((n) => [...n, ""])}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH>Action Taken By</TH>
                <TH>Date &amp; Time</TH>
                <TH>
                  Additional Notes <span className="text-asm-amber-light">*</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {notes.map((text, i) => (
                <TR key={`new-${i}`}>
                  <TD className="w-40">{signedInName}</TD>
                  <TD className="w-40 whitespace-nowrap tabular-nums">{nowLabel()}</TD>
                  <TD className={cn("text-left", i === 0 && !noteOk && "border-2 border-danger bg-danger-bg/50")}>
                    <Textarea
                      rows={2}
                      value={text}
                      aria-label={`Change note ${i + 1}`}
                      placeholder={
                        i === 0 ? `Why is this row being ${isEdit ? "changed" : "added"}? (required)` : "Optional extra note"
                      }
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
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-danger/40 bg-danger-bg px-3 py-2.5 text-[12.5px] text-danger">
          <span className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-4 w-4" /> Save failed
          </span>
          <span className="mt-0.5 block">{error.message}</span>
          {error.details.length > 0 && (
            <ul className="ml-5 mt-1 list-disc">
              {error.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Drawer>
  );
}

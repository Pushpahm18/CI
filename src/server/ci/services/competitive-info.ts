import type { AuditEntry, ChangeNote, CiUser, CompetitiveInput, CompetitiveRecord, FormOptions } from "@/types/ci";
import type { SaveRecordRequest, SaveRecordResponse } from "@/types/ci-api";
import { getCiRepository } from "@/server/ci/repository";
import { requireRole } from "@/server/ci/current-user";
import { CiError, EditWindowClosedError, ForbiddenError, NotFoundError, ValidationError } from "@/server/ci/errors";
import { notify, rowRecipients } from "@/server/ci/notifications";
import {
  canEditRecord,
  dataScopeFor,
  computeRevenue,
  diffRecords,
  editWindowMessage,
  fabRegionFor,
  recordInScope,
  type ScopedRow,
  validateInput,
} from "@/lib/ci/rules";
import { FIELDS } from "@/lib/ci/field-spec";

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function loadFormOptions(): Promise<FormOptions> {
  const repo = getCiRepository();
  const [lookups, reference] = await Promise.all([repo.listLookups(), repo.getReferenceData()]);
  return { lookups, reference };
}

/**
 * BRD 1.1 §5.1 step 1: only in-scope rows. The user's scope is passed to the
 * repository so the query itself filters (Corporate Marketing: all rows).
 */
export async function listRecordsFor(user: CiUser): Promise<CompetitiveRecord[]> {
  requireRole(user, ["Sales", "CM"]);
  const records = await getCiRepository().listRecords(dataScopeFor(user));
  // Defensive: enforce scope here too, whatever the query returned.
  return records.filter((r) => recordInScope(user, r));
}

/** BRD §7.4: Competitive FF is Corporate Marketing only. */
export async function listFlatFile(user: CiUser): Promise<CompetitiveRecord[]> {
  requireRole(user, ["CM"]);
  return getCiRepository().listRecords(dataScopeFor(user));
}

async function loadVisibleRecord(user: CiUser, recordId: string): Promise<CompetitiveRecord> {
  requireRole(user, ["Sales", "CM"]);
  const record = await getCiRepository().getRecord(recordId);
  // Out-of-scope rows are reported as not found, so their existence isn't disclosed.
  if (!record || !recordInScope(user, record)) throw new NotFoundError("Row not found.");
  return record;
}

/** Rejects a Customer / Served Market / Fab Region combination outside the Sales user's scope. */
function requireRowInScope(user: CiUser, row: ScopedRow): void {
  if (!recordInScope(user, row)) {
    throw new ForbiddenError("This Customer / Served Market / Region is outside your assigned scope.");
  }
}

export async function getRecordFor(user: CiUser, recordId: string): Promise<{ record: CompetitiveRecord; notes: ChangeNote[] }> {
  const record = await loadVisibleRecord(user, recordId);
  const notes = await getCiRepository().listNotes(recordId);
  return { record, notes };
}

/** BRD §7.3: any user with access to the row. */
export async function getAuditFor(user: CiUser, recordId: string): Promise<AuditEntry[]> {
  await loadVisibleRecord(user, recordId);
  return getCiRepository().listAudit(recordId);
}

function cleanNotes(notes: string[]): string[] {
  return notes.map((n) => n.trim()).filter(Boolean);
}

function requireChangeNote(notes: string[]): string[] {
  const cleaned = cleanNotes(notes);
  // BRD §5.3: every add and edit requires a Change Note.
  if (!notes[0]?.trim()) throw new ValidationError(["A Change Note is required."]);
  return cleaned;
}

/** Fields the server sets itself: whatever the browser sends for them is dropped, never trusted. */
const SYSTEM_KEYS = new Set<string>(["recordId", "fabRegion", "revenue", "createdBy", "createdOn", "modifiedBy", "modifiedOn"]);

/** Only the user-entered fields, trimmed. Anything else in the request (for example a client-sent createdBy or modifiedBy) is ignored. */
function normalise(input: CompetitiveInput): CompetitiveInput {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) {
    if (SYSTEM_KEYS.has(f.key)) continue;
    const value = (input as unknown as Record<string, unknown>)[f.key];
    out[f.key] = typeof value === "string" ? value.trim() : value;
  }
  out.actualOrder = Number(input.actualOrder);
  out.asp = Number(input.asp);
  return out as unknown as CompetitiveInput;
}

/** Fab Region and Revenue are always derived on the server (BRD §5.4), never taken from the client. */
function derive(input: CompetitiveInput, options: FormOptions) {
  return {
    fabRegion: fabRegionFor(options.reference, input.customer, input.fabLocation),
    revenue: computeRevenue(input.actualOrder, input.asp) ?? 0,
  };
}

/**
 * A row is saved together with its Change Note and its audit history entry. If either cannot be written, the row is put back
 * (a new row is set inactive; an edited row gets its previous values back) and the person is told nothing was saved.
 */
async function undoSave(undo: () => Promise<void>, error: unknown): Promise<never> {
  console.error("[CI] change note / audit history could not be written:", error instanceof Error ? error.message : error);
  let restored = true;
  try {
    await undo();
  } catch (undoError) {
    restored = false;
    console.error("[CI] could not undo the row after a failed note / audit write:", undoError instanceof Error ? undoError.message : undoError);
  }
  throw new CiError(
    restored
      ? "The row was not saved: its Change Note and audit history could not be written. Check the server log for details."
      : "The row was saved, but its Change Note or audit history could not be written, and the change could not be undone. Contact support; check the server log for details.",
    502,
    "INTERNAL"
  );
}

function rowLink(recordId: string): string {
  const base = process.env.AUTH_URL?.replace(/\/$/, "") ?? "";
  return `${base}/competitive-info?record=${encodeURIComponent(recordId)}`;
}

export async function createRecordFor(user: CiUser, request: SaveRecordRequest): Promise<SaveRecordResponse> {
  requireRole(user, ["Sales", "CM"]);
  const notes = requireChangeNote(request.notes);
  const input = normalise(request.input);
  const options = await loadFormOptions();

  // Scope is checked on the submitted values (Fab Region derived here), never trusted from the browser.
  requireRowInScope(user, { ...input, fabRegion: derive(input, options).fabRegion });
  const errors = validateInput(input, { ...options, user });
  if (errors.length) throw new ValidationError(errors);

  const repo = getCiRepository();
  const now = new Date().toISOString();
  const record = await repo.createRecord({
    ...input,
    ...derive(input, options),
    createdBy: user.name,
    createdOn: todayIso(),
  });

  const note = notes.join("\n");
  const changes = diffRecords({ ...emptyRecord(), recordId: record.recordId }, record);
  try {
    await repo.addNotes(notes.map((n) => ({ recordId: record.recordId, actionTakenBy: user.name, dateTime: now, notes: n })));
    await repo.addAudit([{ recordId: record.recordId, action: "Created", actionTakenBy: user.name, actorEmail: user.email, dateTime: now, changes, note }]);
  } catch (error) {
    await undoSave(() => repo.discardRecord(record.recordId), error);
  }

  const recipients = rowRecipients(await repo.listUsers(), record);
  const notification = await notify(
    {
      kind: "added",
      recordId: record.recordId,
      customer: record.customer,
      fabLocation: record.fabLocation,
      quarter: record.quarter,
      year: record.year,
      changedBy: user.name,
      changes: [],
      note,
      link: rowLink(record.recordId),
    },
    recipients
  );
  return { record, notification };
}

export async function updateRecordFor(user: CiUser, recordId: string, request: SaveRecordRequest): Promise<SaveRecordResponse> {
  const existing = await loadVisibleRecord(user, recordId);
  // Account Team may edit a row only until 31 Dec of the year it was created; Corporate Marketing is exempt.
  if (!canEditRecord(user, existing)) throw new EditWindowClosedError(editWindowMessage(existing.createdOn));

  const notes = requireChangeNote(request.notes);
  const input = normalise(request.input);
  const options = await loadFormOptions();
  // The edited values must stay inside the user's scope too (no moving a row out of — or into — scope).
  requireRowInScope(user, { ...input, fabRegion: derive(input, options).fabRegion });
  const errors = validateInput(input, { ...options, user }, existing);
  if (errors.length) throw new ValidationError(errors);

  const now = new Date().toISOString();
  const updated: CompetitiveRecord = {
    ...existing,
    ...input,
    ...derive(input, options),
    modifiedBy: user.name,
    modifiedOn: now,
  };
  const changes = diffRecords(existing, updated);
  // CI Prototype: an Edit can only be submitted once something has changed.
  if (changes.length === 0) throw new ValidationError(["No changes to save."]);

  const repo = getCiRepository();
  await repo.updateRecord(updated);
  const note = notes.join("\n");
  try {
    await repo.addNotes(notes.map((n) => ({ recordId, actionTakenBy: user.name, dateTime: now, notes: n })));
    await repo.addAudit([{ recordId, action: "Edited", actionTakenBy: user.name, actorEmail: user.email, dateTime: now, changes, note }]);
  } catch (error) {
    await undoSave(() => repo.updateRecord(existing), error);
  }

  const recipients = rowRecipients(await repo.listUsers(), updated);
  const notification = await notify(
    {
      kind: "edited",
      recordId,
      customer: updated.customer,
      fabLocation: updated.fabLocation,
      quarter: updated.quarter,
      year: updated.year,
      changedBy: user.name,
      changes,
      note,
      link: rowLink(recordId),
    },
    recipients
  );
  return { record: updated, notification };
}

export function emptyRecord(): CompetitiveRecord {
  const base = Object.fromEntries(FIELDS.map((f) => [f.key, ""])) as unknown as CompetitiveRecord;
  return { ...base, recordId: "", actualOrder: "" as unknown as number, asp: "" as unknown as number, revenue: "" as unknown as number };
}

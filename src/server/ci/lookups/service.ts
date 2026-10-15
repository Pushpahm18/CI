import type { SessionIdentity } from "@/server/ci/current-user";
import { CiError, ConflictError, NotFoundError, ValidationError } from "@/server/ci/errors";
import { getCiRepository, type CiRepository } from "@/server/ci/repository";
import { STANDALONE_REQUIRES, requireTablesConfigured } from "@/server/ci/readiness";
import { authorizeCorporateMarketing } from "@/server/ci/authorization/ci-access";
import { requireConnected } from "@/server/ci/connection";
import { authorizedReads } from "@/server/ci/authorized-reads";
import { getLookupStore, type LookupStore, type LookupUsage } from "@/server/ci/databricks/lookups";
import { getDependentLookupStore, type DependentLookupRow, type DependentLookupStore } from "@/server/ci/databricks/dependent-lookups";
import { dependentImpactOf } from "@/server/ci/lookups/deactivation-impact";
import { LOOKUP_CATEGORIES, isCascadingCategory } from "@/lib/ci/field-spec";
import { ENTITY_DEPENDENT_LOOKUP, ENTITY_LOOKUP, auditAfterChange, change, writeAuditHistory, type AuditWriter } from "@/server/ci/audit";
import type { AuditInput } from "@/server/ci/databricks/audit-history";
import type { LookupValue } from "@/types/ci";
import type { LookupDeactivationImpact, LookupsResponse } from "@/types/ci-api";

/**
 * The Lookups API on ci_lookup (dropdown values and their Sequential Dropdown
 * order). Order of every call: the table is configured (otherwise "CI database
 * table configuration is pending: Lookups", nothing attempted) → Databricks is
 * connected → the caller is authorized → the work.
 *
 * Authorization is the same single, replaceable function as the Competitive
 * Info gallery (server/ci/user-access/access.ts): Corporate Marketing, or the
 * local development login. It deliberately does not depend on the CI users
 * table, which is not connected yet. Account Team gets no access.
 *
 * Nothing here deletes: removing a value only sets it inactive. Removing a Customer, Served Market, Top Competitor or Fab Region
 * also deactivates the dependent mappings that reference it, after an explicit confirmation (see deactivation-impact.ts).
 */

export interface LookupsServiceDeps {
  requireTables(): void;
  requireConnected(): void;
  authorize(identity: SessionIdentity): Promise<{ userName: string; email?: string }>;
  repository(): Pick<CiRepository, "listLookups" | "addLookup" | "addLookups" | "renameLookup" | "deactivateLookup" | "reorderLookups">;
  usage(): Promise<LookupUsage>;
  /** The dependent lookups (ci_lookup_dependent), needed to deactivate Customer / Served Market / Top Competitor / Fab Region. */
  dependents?(): Pick<DependentLookupStore, "list" | "setActiveMany"> | null;
  /** Writes the audit history entries (corp_marketing_dev.audit.ci_audit_history). */
  audit: AuditWriter;
}

const defaultDeps: LookupsServiceDeps = {
  requireTables: () => requireTablesConfigured(STANDALONE_REQUIRES.lookupsView),
  requireConnected,
  authorize: (identity) => authorizeCorporateMarketing(identity),
  repository: getCiRepository,
  usage: async () => (getLookupStore() as LookupStore | null)?.usage() ?? { counts: {}, categories: [] },
  dependents: () => getDependentLookupStore(),
  audit: writeAuditHistory,
};

type Actor = { userName: string; email?: string };

/** One audit entry for a lookup value, attributed to the verified signed-in person. */
function lookupAudit(who: Actor, recordId: string, action: string, changes: AuditInput["changes"], note: string, at: string): AuditInput {
  return { entity: ENTITY_LOOKUP, recordId, action, changes, note, actionByName: who.userName, actionByEmail: who.email, at };
}

const MAX_VALUE_LENGTH = 200;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Expected, already-safe errors pass through; anything else is logged for the server and replaced by a safe sentence. */
export async function safely<T>(work: () => Promise<T>, what: string): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CiError) throw error;
    console.error(`[CI] lookups: ${what} failed:`, error instanceof Error ? error.message : error);
    throw new CiError(`Lookups could not be ${what}. Check the server log for details.`, 502, "INTERNAL");
  }
}

/**
 * Table and connection checks, then the authorization check and the list read AT THE SAME TIME (one round
 * trip, not two). Authorization is awaited first: if it refuses, nothing read is used.
 */
async function authorizedList(identity: SessionIdentity, deps: LookupsServiceDeps): Promise<[Actor, LookupValue[]]> {
  deps.requireTables();
  deps.requireConnected();
  const [who, all] = await authorizedReads(
    () => deps.authorize(identity),
    () => safely(() => deps.repository().listLookups(), "loaded")
  );
  return [{ userName: who.userName, email: who.email }, all];
}

function requireCategory(category: unknown): string {
  if (typeof category !== "string" || !(LOOKUP_CATEGORIES as readonly string[]).includes(category)) throw new ValidationError(["Unknown list."]);
  return category;
}

const activeIn = (all: LookupValue[], category: string) => all.filter((l) => l.category === category && l.active);
const asObject = (body: unknown) => (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

function cleanValue(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new ValidationError(["Enter a value."]);
  if (value.length > MAX_VALUE_LENGTH) throw new ValidationError([`A value must be ${MAX_VALUE_LENGTH} characters or fewer.`]);
  return value;
}

export async function loadLookups(identity: SessionIdentity, deps: LookupsServiceDeps = defaultDeps): Promise<LookupsResponse> {
  deps.requireTables();
  deps.requireConnected();
  const [, data] = await authorizedReads(
    () => deps.authorize(identity),
    () =>
      safely(async () => {
        const [lookups, usage] = await Promise.all([deps.repository().listLookups(), deps.usage()]);
        return { lookups, usage: usage.counts, usageCategories: usage.categories };
      }, "loaded")
  );
  return data;
}

export async function addLookupValue(identity: SessionIdentity, body: unknown, deps: LookupsServiceDeps = defaultDeps): Promise<LookupValue> {
  const [who, all] = await authorizedList(identity, deps);
  const actor = who.userName;
  const b = asObject(body);
  const category = requireCategory(b.category);
  const value = cleanValue(b.value);
  return safely(async () => {
    const inList = activeIn(all, category);
    // CI Prototype: the duplicate check is case-insensitive.
    if (inList.some((l) => l.value.toLowerCase() === value.toLowerCase())) throw new ValidationError([`“${value}” is already in the list.`]);
    const next = inList.reduce((max, l) => Math.max(max, l.sortOrder), 0) + 1;
    const created = await deps.repository().addLookup(category, value, next, actor);
    await auditAfterChange(deps.audit, [
      lookupAudit(who, created.id, "Created", [change("List", "", category), change("Value", "", value), change("Sort Order", "", next)], `List: ${category}`, new Date().toISOString()),
    ]);
    return created;
  }, "saved");
}

export type BulkAddResult = { ok: true; lookup: LookupValue } | { ok: false; error: string };

const MAX_BULK = 500;

/**
 * Adds many values at once (Excel import): one authorization, one read and ONE write statement for all the valid rows.
 * Every row is checked exactly like a single add (known list, non-empty, length, not already in the list, not repeated in the
 * batch); rows that fail are reported and left out, the rest are saved together.
 */
export async function addLookupValues(identity: SessionIdentity, body: unknown, deps: LookupsServiceDeps = defaultDeps): Promise<{ results: BulkAddResult[] }> {
  const [who, all] = await authorizedList(identity, deps);
  const actor = who.userName;
  const items = asObject(body).items;
  if (!Array.isArray(items) || items.length === 0) throw new ValidationError(["Nothing to add."]);
  if (items.length > MAX_BULK) throw new ValidationError([`At most ${MAX_BULK} values can be added at once.`]);
  return safely(async () => {
    const next = new Map<string, number>();
    const seen = new Set(all.filter((l) => l.active).map((l) => `${l.category}|${l.value.toLowerCase()}`));
    const toAdd: { category: string; value: string; sortOrder: number }[] = [];
    const slot: (number | string)[] = []; // index into toAdd, or the reason the row was refused
    for (const raw of items) {
      try {
        const b = asObject(raw);
        const category = requireCategory(b.category);
        const value = cleanValue(b.value);
        const key = `${category}|${value.toLowerCase()}`;
        if (seen.has(key)) throw new ValidationError([`“${value}” is already in ${category}.`]);
        seen.add(key);
        if (!next.has(category)) next.set(category, activeIn(all, category).reduce((m, l) => Math.max(m, l.sortOrder), 0));
        const order = next.get(category)! + 1;
        next.set(category, order);
        slot.push(toAdd.length);
        toAdd.push({ category, value, sortOrder: order });
      } catch (e) {
        slot.push(e instanceof ValidationError ? e.details?.[0] ?? "Invalid row." : "Invalid row.");
      }
    }
    const created = await deps.repository().addLookups(toAdd, actor);
    const at = new Date().toISOString();
    await auditAfterChange(
      deps.audit,
      created.map((c, i) => lookupAudit(who, c.id, "Created", [change("List", "", toAdd[i].category), change("Value", "", toAdd[i].value), change("Sort Order", "", toAdd[i].sortOrder)], `List: ${toAdd[i].category}`, at))
    );
    return { results: slot.map((s): BulkAddResult => (typeof s === "number" ? { ok: true, lookup: created[s] } : { ok: false, error: s })) };
  }, "saved");
}

/** Renames a value in its list. Rows already using the old text keep it (CI Prototype). */
export async function renameLookupValue(identity: SessionIdentity, id: string, body: unknown, deps: LookupsServiceDeps = defaultDeps): Promise<void> {
  const [who, all] = await authorizedList(identity, deps);
  const actor = who.userName;
  if (typeof id !== "string" || !ID_RE.test(id)) throw new ValidationError(["Invalid value id."]);
  const value = cleanValue(asObject(body).value);
  return safely(async () => {
    const current = all.find((l) => l.id === id && l.active);
    if (!current) throw new NotFoundError("That value was not found.");
    if (current.value === value) return;
    if (all.some((l) => l.active && l.category === current.category && l.id !== id && l.value.toLowerCase() === value.toLowerCase())) {
      throw new ValidationError([`“${value}” is already in the list.`]);
    }
    await deps.repository().renameLookup(id, value, actor);
    await auditAfterChange(deps.audit, [lookupAudit(who, id, "Edited", [change("Value", current.value, value)], `List: ${current.category}`, new Date().toISOString())]);
  }, "saved");
}

function dependentStore(deps: LookupsServiceDeps) {
  const store = deps.dependents?.();
  if (!store) throw new CiError("The dependent lists are not available, so this value cannot be deactivated safely.", 503, "NOT_CONFIGURED");
  return store;
}

/** Read-only: what deactivating this value would also deactivate. Customer, Served Market, Top Competitor and Fab Region only; for any other list nothing is affected. */
export async function previewLookupRemoval(identity: SessionIdentity, id: string, deps: LookupsServiceDeps = defaultDeps): Promise<LookupDeactivationImpact> {
  const [, all] = await authorizedList(identity, deps);
  if (typeof id !== "string" || !ID_RE.test(id)) throw new ValidationError(["Invalid value id."]);
  return safely(async () => {
    const current = all.find((l) => l.id === id && l.active);
    if (!current) throw new NotFoundError("That value was not found.");
    if (!isCascadingCategory(current.category)) return dependentImpactOf(current.category, current.value, []).summary;
    return dependentImpactOf(current.category, current.value, await dependentStore(deps).list()).summary;
  }, "loaded");
}

/** One audit entry for a dependent mapping that was switched off together with its parent value. */
function cascadeAudit(who: Actor, r: DependentLookupRow, note: string, at: string): AuditInput {
  return {
    entity: ENTITY_DEPENDENT_LOOKUP,
    recordId: r.id,
    action: "Deactivated",
    changes: [change("Active", "true", "false")],
    note: `${r.childType}: ${[r.parentValue1, r.parentValue2, r.childValue].filter(Boolean).join(" · ")}; ${note}`,
    actionByName: who.userName,
    actionByEmail: who.email,
    at,
  };
}

/**
 * CI Prototype: removing a value keeps it on existing rows; it only stops appearing in new dropdowns. Soft deactivation only
 * (is_active = FALSE): no row of ci_lookup, ci_lookup_dependent or ci_main is ever deleted or rewritten.
 *
 * Customer, Served Market, Top Competitor and Fab Region also switch off their dependent mappings, and need `confirmedImpact`,
 * the fingerprint of the impact the person reviewed:
 *   1. No fingerprint -> 409, nothing changes.
 *   2. The dependents are read again NOW; if they are not the rows that were reviewed -> 409, nothing changes (the person
 *      reviews the new impact and confirms again).
 *   3. The mappings are deactivated in ONE statement (all or none), then the value itself.
 *   4. The two tables cannot share a transaction here (the SQL Statement API runs one statement at a time and the write guards
 *      refuse anything else), so if the second write fails the mappings are switched back on (compensation). If THAT also
 *      fails the error says so, the ids are logged and audited, and a retry is safe: it finds the value still active and
 *      the mappings already off, and completes the deactivation.
 *   5. After the value is off, the dependents are read once more; a mapping added in the meantime is switched off too, so no
 *      active mapping is left under an inactive value.
 */
export async function removeLookupValue(identity: SessionIdentity, id: string, deps: LookupsServiceDeps = defaultDeps, options: { confirmedImpact?: string } = {}): Promise<void> {
  const [who, all] = await authorizedList(identity, deps);
  const actor = who.userName;
  if (typeof id !== "string" || !ID_RE.test(id)) throw new ValidationError(["Invalid value id."]);
  return safely(async () => {
    const current = all.find((l) => l.id === id && l.active);
    if (!current) throw new NotFoundError("That value was not found.");
    const cascade = isCascadingCategory(current.category);
    if (cascade && !options.confirmedImpact) {
      throw new ConflictError(`Deactivating “${current.value}” needs confirmation, because it also affects its dependent mappings. Review the impact and confirm.`);
    }
    const dependents = cascade ? dependentStore(deps) : null;
    // Re-read at confirmation time: what is deactivated is exactly what the person reviewed, or nothing is.
    const impact = dependents ? dependentImpactOf(current.category, current.value, await dependents.list()) : null;
    if (impact && impact.summary.fingerprint !== options.confirmedImpact) {
      throw new ConflictError(
        `The dependent mappings of “${current.value}” changed since you reviewed them (now ${impact.summary.total}). Nothing was deactivated. Review the updated impact and confirm again.`
      );
    }
    const ids = impact ? impact.rows.map((r) => r.id) : [];
    if (dependents && ids.length > 0) await dependents.setActiveMany(ids, false, actor); // one statement: all or none

    try {
      await deps.repository().deactivateLookup(id, actor);
    } catch (error) {
      if (dependents && ids.length > 0) {
        try {
          await dependents.setActiveMany(ids, true, actor);
        } catch (undoError) {
          console.error(
            `[CI] lookups: “${current.value}” (${id}) could not be deactivated AND its mappings could not be switched back on. Mapping ids still inactive: ${ids.join(", ")}.`,
            undoError instanceof Error ? undoError.message : undoError
          );
          // Leave a trace of the state the data was left in; if even this fails the server log above has the ids.
          const note = `deactivated, but ${current.category} “${current.value}” was NOT deactivated and switching this back on failed; retry the deactivation or re-activate it`;
          await deps
            .audit((impact?.rows ?? []).map((r) => cascadeAudit(who, r, note, new Date().toISOString())))
            .catch((auditError) => console.error("[CI] lookups: the rollback failure could not be audited:", auditError instanceof Error ? auditError.message : auditError));
          throw new CiError(
            `“${current.value}” was not deactivated, but ${ids.length} of its dependent mapping(s) were switched off and could not be switched back on. Retry the deactivation to finish it (it is safe to repeat), or contact support. Details are in the server log.`,
            502,
            "INTERNAL"
          );
        }
      }
      throw error;
    }

    // A mapping added after the re-read above would now be active under an inactive value: switch it off too.
    let late: DependentLookupRow[] = [];
    let sweepFailed = false;
    if (dependents) {
      try {
        late = dependentImpactOf(current.category, current.value, await dependents.list()).rows;
        if (late.length > 0) await dependents.setActiveMany(late.map((r) => r.id), false, actor);
      } catch (error) {
        sweepFailed = true;
        late = [];
        console.error(`[CI] lookups: “${current.value}” was deactivated but the check for newly added mappings failed:`, error instanceof Error ? error.message : error);
      }
    }

    const at = new Date().toISOString();
    const total = ids.length + late.length;
    await auditAfterChange(deps.audit, [
      lookupAudit(who, id, "Deactivated", [change("Active", "true", "false")], `List: ${current.category}; Value: ${current.value}${total ? `; Also deactivated ${total} dependent mapping(s)` : ""}`, at),
      ...(impact?.rows ?? []).map((r) => cascadeAudit(who, r, `deactivated because ${current.category} “${current.value}” was deactivated`, at)),
      ...late.map((r) => cascadeAudit(who, r, `added while ${current.category} “${current.value}” was being deactivated; deactivated with it`, at)),
    ]);
    if (sweepFailed) {
      throw new CiError(
        `“${current.value}” and its dependent mappings were deactivated, but the final check for mappings added at the same moment failed. Open the dependent lists and confirm nothing active remains under “${current.value}”. Details are in the server log.`,
        502,
        "INTERNAL"
      );
    }
  }, "saved");
}

/** The ids must be exactly the active values of that list, each once, so a save can never touch another list or leave a gap. */
export async function reorderLookupValues(identity: SessionIdentity, body: unknown, deps: LookupsServiceDeps = defaultDeps): Promise<void> {
  const [who, all] = await authorizedList(identity, deps);
  const actor = who.userName;
  const b = asObject(body);
  const category = requireCategory(b.category);
  const ids = b.orderedIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !ID_RE.test(id))) throw new ValidationError(["Invalid order."]);
  return safely(async () => {
    const current = activeIn(all, category).map((l) => l.id);
    const wanted = ids as string[];
    if (new Set(wanted).size !== wanted.length || wanted.length !== current.length || wanted.some((id) => !current.includes(id))) {
      throw new ValidationError(["The order must list every value of this list exactly once. Reload and try again."]);
    }
    await deps.repository().reorderLookups(category, wanted, actor);
    // One entry per value whose position changed (positions are numbered from 1, as the store writes them).
    const at = new Date().toISOString();
    const moved = wanted
      .map((wantedId, i) => ({ entry: activeIn(all, category).find((l) => l.id === wantedId)!, position: i + 1 }))
      .filter(({ entry, position }) => entry.sortOrder !== position)
      .map(({ entry, position }) => lookupAudit(who, entry.id, "Reordered", [change("Sort Order", entry.sortOrder, position)], `List: ${category}; Value: ${entry.value}`, at));
    await auditAfterChange(deps.audit, moved);
  }, "saved");
}

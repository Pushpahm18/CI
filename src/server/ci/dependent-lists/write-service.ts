import type { SessionIdentity } from "@/server/ci/current-user";
import { NotFoundError, ValidationError } from "@/server/ci/errors";
import { STANDALONE_REQUIRES, requireTablesConfigured } from "@/server/ci/readiness";
import { safely } from "@/server/ci/lookups/service";
import { authorizeCorporateMarketing } from "@/server/ci/authorization/ci-access";
import { requireConnected } from "@/server/ci/connection";
import { authorizedReads } from "@/server/ci/authorized-reads";
import { getCiRepository, type CiRepository } from "@/server/ci/repository";
import { ENTITY_DEPENDENT_LOOKUP, auditAfterChange, change, writeAuditHistory, type AuditWriter } from "@/server/ci/audit";
import type { AuditInput } from "@/server/ci/databricks/audit-history";
import {
  dependentListsFrom,
  getDependentLookupStore,
  type DependentEntry,
  type DependentListId,
  type DependentLookupStore,
} from "@/server/ci/databricks/dependent-lookups";

/**
 * Add / rename / remove / reorder for the cascading lists in ci_lookup_dependent.
 * Order of every call: tables configured -> Databricks connected -> Corporate
 * Marketing (checked at the same time as the reads, but decisive: if it refuses,
 * nothing read is used and nothing is written) -> the work. Nothing is deleted:
 * removing a row only sets it inactive.
 *
 * Validation against what is stored, never against built-in lists: a Top Competitor
 * parent must be a value of the Top Competitor dropdown list, a Served Market parent
 * a value of the Served Market list, a Customer (fab or node) a value of the Customer list,
 * a Fab Region one already used by a fab or in the Fab Region list. Duplicates are refused case-insensitively within the same group.
 */

export interface DependentWriteServiceDeps {
  requireTables(): void;
  requireConnected(): void;
  authorize(identity: SessionIdentity): Promise<{ userName: string; email?: string }>;
  store(): DependentLookupStore;
  lookups(): ReturnType<CiRepository["listLookups"]>;
  /** Writes the audit history entries (corp_marketing_dev.audit.ci_audit_history). */
  audit: AuditWriter;
}

const defaultDeps: DependentWriteServiceDeps = {
  requireTables: () => requireTablesConfigured([...STANDALONE_REQUIRES.dependentLookupsView, ...STANDALONE_REQUIRES.lookupsView]),
  requireConnected,
  authorize: (identity) => authorizeCorporateMarketing(identity),
  store: () => {
    const s = getDependentLookupStore();
    if (!s) throw new ValidationError(["The dependent lists are not available."]);
    return s;
  },
  lookups: () => getCiRepository().listLookups(),
  audit: writeAuditHistory,
};

const LIST_LABEL: Record<DependentListId, string> = { comp: "Product Name", proc: "Process Location", fab: "Fab Location", node: "Technology Node" };
const PARENT1_LABEL: Record<DependentListId, string> = { comp: "Top Competitor", proc: "Served Market", fab: "Customer", node: "Customer" };

type Actor = { userName: string; email?: string };

const groupOf = (e: { parent1: string; parent2: string }) => [e.parent1, e.parent2].filter(Boolean).join(" · ");

/** One audit entry for a dependent value, attributed to the verified signed-in person. */
function dependentAudit(who: Actor, recordId: string, action: string, changes: AuditInput["changes"], note: string, at: string): AuditInput {
  return { entity: ENTITY_DEPENDENT_LOOKUP, recordId, action, changes, note, actionByName: who.userName, actionByEmail: who.email, at };
}

/** The "Created" changes of a new value: where it sits, what it is, and its position. */
function createdChanges(c: { list: DependentListId; parent1: string; parent2: string; value: string; region?: string; sortOrder: number }) {
  return [
    change("List", "", LIST_LABEL[c.list]),
    change(PARENT1_LABEL[c.list], "", c.parent1),
    ...(c.parent2 ? [change("Served Market", "", c.parent2)] : []),
    change(LIST_LABEL[c.list], "", c.value),
    ...(c.region !== undefined ? [change("Fab Region", "", c.region)] : []),
    change("Sort Order", "", c.sortOrder),
  ];
}

const LISTS: DependentListId[] = ["comp", "proc", "fab", "node"];
const MAX = 200;
const MAX_BULK = 500;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const body = (b: unknown) => (typeof b === "object" && b !== null ? b : {}) as Record<string, unknown>;

function requireList(v: unknown): DependentListId {
  if (typeof v !== "string" || !(LISTS as string[]).includes(v)) throw new ValidationError(["Unknown list."]);
  return v as DependentListId;
}

function requireId(v: unknown): string {
  if (typeof v !== "string" || !ID_RE.test(v)) throw new ValidationError(["Invalid id."]);
  return v;
}

function requireText(v: unknown, what: string): string {
  const t = text(v);
  if (!t) throw new ValidationError([`Enter ${what}.`]);
  if (t.length > MAX) throw new ValidationError([`${what[0].toUpperCase()}${what.slice(1)} must be ${MAX} characters or fewer.`]);
  return t;
}

type Lookups = Awaited<ReturnType<DependentWriteServiceDeps["lookups"]>>;

/** Checks, then the authorization and both reads (stored rows, dropdown lists) at the same time. */
async function authorizedState(identity: SessionIdentity, deps: DependentWriteServiceDeps): Promise<{ actor: string; who: Actor; entries: DependentEntry[]; lookups: Lookups }> {
  deps.requireTables();
  deps.requireConnected();
  const [who, state] = await authorizedReads(
    () => deps.authorize(identity),
    () =>
      safely(async () => {
        const [rows, lookups] = await Promise.all([deps.store().list(), deps.lookups()]);
        return { entries: dependentListsFrom(rows).entries, lookups };
      }, "loaded")
  );
  return { actor: who.userName, who: { userName: who.userName, email: who.email }, ...state };
}

const sameGroup = (a: DependentEntry, b: { list: DependentListId; parent1: string; parent2: string }) =>
  a.list === b.list && a.parent1.toLowerCase() === b.parent1.toLowerCase() && a.parent2.toLowerCase() === b.parent2.toLowerCase();

const names = (all: Lookups, category: string) => all.filter((l) => l.active && l.category === category).map((l) => l.value.toLowerCase());

interface Clean {
  list: DependentListId;
  parent1: string;
  parent2: string;
  value: string;
  region?: string;
}

function clean(input: unknown): Clean {
  const b = body(input);
  const list = requireList(b.list);
  const parent1 = requireText(b.parent1, list === "comp" ? "a Top Competitor" : list === "proc" ? "a Served Market" : "a Customer");
  const parent2 = list === "node" ? requireText(b.parent2, "a Served Market") : "";
  const value = requireText(b.value, list === "comp" ? "a Product Name" : list === "proc" ? "a Process Location" : list === "fab" ? "a Fab Location" : "a Technology Node");
  const region = list === "fab" ? requireText(b.region, "a Fab Region") : undefined;
  return { list, parent1, parent2, value, region };
}

/** The rules of one add against the current rows (which a bulk add keeps up to date as it goes). */
function checkAdd(c: Clean, entries: DependentEntry[], lookups: Lookups): number {
  if ((c.list === "fab" || c.list === "node") && !names(lookups, "Customer").includes(c.parent1.toLowerCase())) throw new ValidationError([`“${c.parent1}” is not in the Customer list.`]);
  if (c.list === "comp" && !names(lookups, "Top Competitor").includes(c.parent1.toLowerCase())) throw new ValidationError([`“${c.parent1}” is not in the Top Competitor list.`]);
  if (c.list === "proc" && !names(lookups, "Served Market").includes(c.parent1.toLowerCase())) throw new ValidationError([`“${c.parent1}” is not in the Served Market list.`]);
  if (c.list === "node" && !names(lookups, "Served Market").includes(c.parent2.toLowerCase())) throw new ValidationError([`“${c.parent2}” is not in the Served Market list.`]);
  if (c.region !== undefined) {
    const known = new Set([...entries.filter((e) => e.list === "fab").map((e) => (e.region ?? "").toLowerCase()), ...names(lookups, "Fab Region")]);
    if (!known.has(c.region.toLowerCase())) throw new ValidationError([`“${c.region}” is not a known Fab Region.`]);
  }
  const group = entries.filter((e) => sameGroup(e, c));
  if (group.some((e) => e.value.toLowerCase() === c.value.toLowerCase())) throw new ValidationError([`“${c.value}” already exists under ${[c.parent1, c.parent2].filter(Boolean).join(" · ")}.`]);
  return group.reduce((m, e) => Math.max(m, e.sortOrder), 0) + 1;
}

export async function addDependentEntry(identity: SessionIdentity, input: unknown, deps: DependentWriteServiceDeps = defaultDeps): Promise<{ id: string }> {
  const { actor, who, entries, lookups } = await authorizedState(identity, deps);
  const c = clean(input);
  return safely(async () => {
    const sortOrder = checkAdd(c, entries, lookups);
    const id = await deps.store().insert({ ...c, sortOrder, actor });
    await auditAfterChange(deps.audit, [dependentAudit(who, id, "Created", createdChanges({ ...c, sortOrder }), `List: ${LIST_LABEL[c.list]}; ${groupOf(c)}`, new Date().toISOString())]);
    return { id };
  }, "saved");
}

export type BulkDependentResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * Adds many rows at once (Excel import): one authorization, one read and ONE write statement for the valid rows. Every row
 * is checked like a single add, against the stored rows AND the rows already accepted earlier in the same batch.
 */
export async function addDependentEntries(identity: SessionIdentity, input: unknown, deps: DependentWriteServiceDeps = defaultDeps): Promise<{ results: BulkDependentResult[] }> {
  const { actor, who, entries, lookups } = await authorizedState(identity, deps);
  const items = body(input).items;
  if (!Array.isArray(items) || items.length === 0) throw new ValidationError(["Nothing to add."]);
  if (items.length > MAX_BULK) throw new ValidationError([`At most ${MAX_BULK} values can be added at once.`]);
  return safely(async () => {
    const working = [...entries];
    const accepted: (Clean & { sortOrder: number; actor: string })[] = [];
    const slot: (number | string)[] = [];
    for (const raw of items) {
      try {
        const c = clean(raw);
        const sortOrder = checkAdd(c, working, lookups);
        working.push({ id: `pending-${accepted.length}`, list: c.list, parent1: c.parent1, parent2: c.parent2, value: c.value, region: c.region, sortOrder });
        slot.push(accepted.length);
        accepted.push({ ...c, sortOrder, actor });
      } catch (e) {
        slot.push(e instanceof ValidationError ? e.details?.[0] ?? "Invalid row." : "Invalid row.");
      }
    }
    const ids = await deps.store().insertMany(accepted);
    const at = new Date().toISOString();
    await auditAfterChange(
      deps.audit,
      accepted.map((a, i) => dependentAudit(who, ids[i], "Created", createdChanges(a), `List: ${LIST_LABEL[a.list]}; ${groupOf(a)}`, at))
    );
    return { results: slot.map((s): BulkDependentResult => (typeof s === "number" ? { ok: true, id: ids[s] } : { ok: false, error: s })) };
  }, "saved");
}

/** Renames a value; for a fab it can also change the Fab Region. At least one must change. */
export async function renameDependentEntry(identity: SessionIdentity, id: unknown, input: unknown, deps: DependentWriteServiceDeps = defaultDeps): Promise<void> {
  const { actor, who, entries, lookups } = await authorizedState(identity, deps);
  const entryId = requireId(id);
  const b = body(input);
  return safely(async () => {
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) throw new NotFoundError("That value was not found.");
    const value = b.value === undefined ? entry.value : requireText(b.value, "a value");
    const region = b.region === undefined ? entry.region : requireText(b.region, "a Fab Region");
    if (value === entry.value && region === entry.region) return;
    if (value.toLowerCase() !== entry.value.toLowerCase() && entries.some((e) => e.id !== entry.id && sameGroup(e, entry) && e.value.toLowerCase() === value.toLowerCase())) {
      throw new ValidationError([`“${value}” already exists in this group.`]);
    }
    if (entry.list === "fab" && region !== entry.region) {
      const known = new Set([...entries.filter((e) => e.list === "fab").map((e) => (e.region ?? "").toLowerCase()), ...names(lookups, "Fab Region")]);
      if (!known.has((region ?? "").toLowerCase())) throw new ValidationError([`“${region}” is not a known Fab Region.`]);
    }
    const store = deps.store();
    if (value !== entry.value) await store.setValue(entry.id, entry.list === "fab" ? "parentValue2" : "childValue", value, actor);
    if (entry.list === "fab" && region !== entry.region) await store.setValue(entry.id, "childValue", region as string, actor);
    const changes = [
      ...(value !== entry.value ? [change(LIST_LABEL[entry.list], entry.value, value)] : []),
      ...(entry.list === "fab" && region !== entry.region ? [change("Fab Region", entry.region, region)] : []),
    ];
    await auditAfterChange(deps.audit, [dependentAudit(who, entry.id, "Edited", changes, `List: ${LIST_LABEL[entry.list]}; ${groupOf(entry)}`, new Date().toISOString())]);
  }, "saved");
}

export async function removeDependentEntry(identity: SessionIdentity, id: unknown, deps: DependentWriteServiceDeps = defaultDeps): Promise<void> {
  const { actor, who, entries } = await authorizedState(identity, deps);
  const entryId = requireId(id);
  return safely(async () => {
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) throw new NotFoundError("That value was not found.");
    await deps.store().deactivate(entryId, actor);
    await auditAfterChange(deps.audit, [
      dependentAudit(who, entryId, "Deactivated", [change("Active", "true", "false")], `List: ${LIST_LABEL[entry.list]}; ${groupOf(entry)}; Value: ${entry.value}`, new Date().toISOString()),
    ]);
  }, "saved");
}

/** The ids must be exactly the active values of that group, each once, so a save can never touch another group or leave a gap. */
export async function reorderDependentEntries(identity: SessionIdentity, input: unknown, deps: DependentWriteServiceDeps = defaultDeps): Promise<void> {
  const { actor, who, entries } = await authorizedState(identity, deps);
  const b = body(input);
  const list = requireList(b.list);
  const parent1 = requireText(b.parent1, "a parent");
  const parent2 = text(b.parent2);
  const ids = b.orderedIds;
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string" || !ID_RE.test(x))) throw new ValidationError(["Invalid order."]);
  return safely(async () => {
    const group = entries.filter((e) => sameGroup(e, { list, parent1, parent2 })).map((e) => e.id);
    const wanted = ids as string[];
    if (new Set(wanted).size !== wanted.length || wanted.length !== group.length || wanted.some((x) => !group.includes(x))) {
      throw new ValidationError(["The order must list every value of this group exactly once. Reload and try again."]);
    }
    await deps.store().reorder(wanted, actor);
    // One entry per value whose position changed (positions are numbered from 1, as the store writes them).
    const at = new Date().toISOString();
    const byId = new Map(entries.map((e) => [e.id, e]));
    const moved = wanted
      .map((wantedId, i) => ({ entry: byId.get(wantedId)!, position: i + 1 }))
      .filter(({ entry, position }) => entry.sortOrder !== position)
      .map(({ entry, position }) =>
        dependentAudit(who, entry.id, "Reordered", [change("Sort Order", entry.sortOrder, position)], `List: ${LIST_LABEL[entry.list]}; ${groupOf(entry)}; Value: ${entry.value}`, at)
      );
    await auditAfterChange(deps.audit, moved);
  }, "saved");
}

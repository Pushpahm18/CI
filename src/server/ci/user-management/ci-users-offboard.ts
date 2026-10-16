import type { SessionIdentity } from "@/server/ci/current-user";
import { NotConfiguredError, NotFoundError, ValidationError } from "@/server/ci/errors";
import { requireTablesConfigured } from "@/server/ci/readiness";
import { safely } from "@/server/ci/lookups/service";
import { authorizeUserManagement } from "@/server/ci/authorization/dev-access";
import { requireConnected } from "@/server/ci/connection";
import { getUserRecordWriter, type UserRecordWriter } from "@/server/ci/databricks/user-records";
import { ENTITY_COMPETITIVE_INFO, getAuditHistoryStore } from "@/server/ci/databricks/audit-history";
import type { AuditEntry } from "@/types/ci";
import { ENTITY_USER, auditBeforeChange, change, writeAuditHistory, type AuditWriter } from "@/server/ci/audit";
import { executeReadOnlyQuery } from "@/server/db/read-only";
import { COMPETITIVE_GALLERY_LABEL, COMPETITIVE_GALLERY_SOURCE, tableName, type TableRef } from "@/server/db/schema";
import { MAIN_COLUMNS as M } from "@/server/db/main-columns";
import { qCol, qTable, sqlLiteral } from "@/server/db/sql";
import { STATUS_OFFBOARDED } from "@/lib/ci/user-rules";
import { checkOffboard, inheritsScope, mergedScope } from "@/lib/ci/user-offboard";
import type { CiOffboardDetailsResponse, CiOffboardPreviewResponse, CiOffboardResponse, CiUserRecordRaw } from "@/types/ci-api";

/**
 * Off-board a CI user (Corporate Marketing only), from the tables Databricks holds:
 *
 *   ci_user_management   who is active, and each person's scope; the leaver is marked Off-boarded, a new Account Team owner
 *                        inherits the leaver's scope
 *   ci_main              the rows the leaver created (is_active rows whose created_by is exactly the leaver's user name);
 *                        READ ONLY here - created_by is not changed
 *   ci_audit_history     one "Reassigned" entry per row (Created By: leaver -> new owner), then the user entries
 *
 * Order: every audit entry is written first; if that fails nothing else is changed. Then the new owner's scope, then the leaver's
 * status. Nothing is deleted. Audit rows are inserted in chunks, so a failure part-way leaves some "Reassigned" entries without
 * the user change; running the off-board again writes the remaining entries and completes it.
 */

export const REASSIGN_NOTE = "Owner off-boarded; rows reassigned by Corporate Marketing.";
const SCOPE_NOTE_PREFIX = "Scope combined with ";

/** The note on the leaver's "Deactivated" entry, and its reader (the details panel). */
export const offboardNote = (rows: number, name: string, email: string) => `Off-boarded; ${rows} row${rows === 1 ? "" : "s"} reassigned to ${name} (${email}).`;
export function parseOffboardNote(note: string): { rows: number; name: string; email: string } | null {
  const m = note.match(/^Off-boarded; (\d+) rows? reassigned to (.*) \(([^()]*)\)\.$/);
  return m ? { rows: Number(m[1]), name: m[2], email: m[3] } : null;
}
const AUDIT_CHUNK = 500;

export interface OffboardDeps {
  requireTables(): void;
  requireConnected(): void;
  authorize(identity: SessionIdentity): Promise<{ email: string; userName: string }>;
  writer(): UserRecordWriter;
  /** ci_id of every live ci_main row created by this exact name. */
  ownedRowIds(name: string): Promise<string[]>;
  audit: AuditWriter;
}

function mainTable(): string {
  const source: TableRef | null = COMPETITIVE_GALLERY_SOURCE;
  if (!source) throw new NotConfiguredError([COMPETITIVE_GALLERY_LABEL]);
  return tableName(source);
}

export function buildOwnedRowIdsStatement(table: string, name: string): string {
  return `SELECT ${qCol(M.recordId)} FROM ${qTable(table)} WHERE ${qCol(M.active)} = TRUE AND CAST(${qCol(M.createdBy)} AS STRING) = ${sqlLiteral(name)}`;
}

export function buildOwnedCountsStatement(table: string): string {
  return `SELECT CAST(${qCol(M.createdBy)} AS STRING) AS owner, COUNT(*) AS n FROM ${qTable(table)} WHERE ${qCol(M.active)} = TRUE GROUP BY CAST(${qCol(M.createdBy)} AS STRING)`;
}

/** Live rows per created_by name, as counted by Databricks. Used by the "Rows owned" column. */
export async function loadOwnedRowCounts(query: (s: string) => Promise<Record<string, unknown>[]> = (s) => executeReadOnlyQuery(s)): Promise<Record<string, number>> {
  const rows = await query(buildOwnedCountsStatement(mainTable()));
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const name = String(r.owner ?? "");
    const n = Number(r.n);
    if (name && Number.isFinite(n)) counts[name] = n;
  }
  return counts;
}

/** ci_id of every live ci_main row created by this exact name. */
export async function ownedRowIdsFor(name: string): Promise<string[]> {
  return (await executeReadOnlyQuery(buildOwnedRowIdsStatement(mainTable(), name))).map((r) => String(r[M.recordId] ?? "")).filter(Boolean);
}

const defaultDeps: OffboardDeps = {
  requireTables: () => requireTablesConfigured(["userManagement", "competitiveInfo", "auditTrail"]),
  requireConnected,
  authorize: (identity) => authorizeUserManagement(identity),
  writer: () => {
    const w = getUserRecordWriter();
    if (!w) throw new NotConfiguredError(["CI User Management"]);
    return w;
  },
  ownedRowIds: ownedRowIdsFor,
  audit: writeAuditHistory,
};

async function prepare(identity: SessionIdentity, deps: OffboardDeps) {
  deps.requireTables();
  deps.requireConnected();
  return deps.authorize(identity);
}

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
function requireId(id: unknown, what: string): string {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new ValidationError([`Invalid ${what}.`]);
  return id;
}

/** The alert: how many rows the leaver created, or why the off-board is not possible. */
export async function previewOffboard(identity: SessionIdentity, idInput: unknown, deps: OffboardDeps = defaultDeps): Promise<CiOffboardPreviewResponse> {
  const actor = await prepare(identity, deps);
  const id = requireId(idInput, "user id");
  return safely(async () => {
    const all = await deps.writer().list();
    const leaver = all.find((u) => u.id === id);
    if (!leaver) throw new NotFoundError("That user was not found.");
    const blocked = checkOffboard(leaver, all, actor.email);
    const ownedRows = blocked ? 0 : (await deps.ownedRowIds(leaver.userName)).length;
    return { ownedRows, blocked };
  }, "checked");
}

/**
 * Read-only: who took over from an off-boarded user, taken from the audit history written at off-board time
 * (the leaver's "Deactivated" entry, and the new owner's "Scope combined" entry). Nothing is written.
 */
export async function offboardDetails(
  identity: SessionIdentity,
  idInput: unknown,
  deps: OffboardDeps & { auditList?(recordId: string): Promise<AuditEntry[]> } = defaultDeps
): Promise<CiOffboardDetailsResponse> {
  await prepare(identity, deps);
  const id = requireId(idInput, "user id");
  const auditList = deps.auditList ?? ((recordId: string) => listUserAudit(recordId));
  return safely(async () => {
    const all = await deps.writer().list();
    const leaver = all.find((u) => u.id === id);
    if (!leaver) throw new NotFoundError("That user was not found.");
    const entry = (await auditList(leaver.id)).find((e) => e.action === ("Deactivated" as AuditEntry["action"]) && parseOffboardNote(e.note ?? ""));
    const parsed = entry ? parseOffboardNote(entry.note ?? "") : null;
    if (!entry || !parsed) return { found: false, leaverName: leaver.userName };
    const owner = all.find((u) => u.email.trim().toLowerCase() === parsed.email.trim().toLowerCase());
    const marker = `${SCOPE_NOTE_PREFIX}${leaver.userName} (${leaver.email})`;
    const scopeEntry = owner ? (await auditList(owner.id)).find((e) => (e.note ?? "").startsWith(marker)) : undefined;
    return {
      found: true,
      leaverName: leaver.userName,
      newOwner: { name: parsed.name, email: parsed.email, role: owner?.role ?? "" },
      rows: parsed.rows,
      at: entry.dateTime,
      by: entry.actionTakenBy,
      scope: (scopeEntry?.changes ?? []).map((c) => ({ label: c.label, before: c.previous, after: c.current })),
      scopeCombined: !!scopeEntry,
    };
  }, "loaded");
}

async function listUserAudit(recordId: string): Promise<AuditEntry[]> {
  const store = getAuditHistoryStore();
  if (!store) throw new NotConfiguredError(["Audit history"]);
  return store.list(ENTITY_USER, recordId);
}

export async function offboardCiUser(identity: SessionIdentity, idInput: unknown, body: unknown, deps: OffboardDeps = defaultDeps): Promise<CiOffboardResponse> {
  const actor = await prepare(identity, deps);
  const id = requireId(idInput, "user id");
  const sent = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const ownerId = requireId(sent.reassignToUserId, "new owner");
  return safely(async () => {
    const writer = deps.writer();
    const all = await writer.list();
    const leaver = all.find((u) => u.id === id);
    if (!leaver) throw new NotFoundError("That user was not found.");
    const blocked = checkOffboard(leaver, all, actor.email);
    if (blocked) throw new ValidationError([blocked]);
    const owner = all.find((u) => u.id === ownerId);
    if (!owner || owner.id === leaver.id || owner.isActive !== true || owner.status.trim().toLowerCase() !== "active") {
      throw new ValidationError(["Choose an active user to take over the rows."]);
    }

    const inherit = inheritsScope(leaver, owner);
    const merged = inherit ? mergedScope(owner, leaver) : null;
    if (inherit && !merged) throw new ValidationError(["A stored scope is not valid, so it cannot be combined. Fix the scope on the user record first. Nothing was changed."]);

    const at = writer.now();
    const by = { actionByName: actor.userName, actionByEmail: actor.email, at };
    const rowIds = await deps.ownedRowIds(leaver.userName);
    for (let i = 0; i < rowIds.length; i += AUDIT_CHUNK) {
      await auditBeforeChange(
        deps.audit,
        rowIds.slice(i, i + AUDIT_CHUNK).map((recordId) => ({
          entity: ENTITY_COMPETITIVE_INFO,
          recordId,
          action: "Reassigned",
          changes: [change("Created By", leaver.userName, owner.userName)],
          note: REASSIGN_NOTE,
          ...by,
        }))
      );
    }

    let newOwner: CiUserRecordRaw = owner;
    if (merged) {
      const changes = (
        [
          ["Customer", owner.customer, merged.customer],
          ["Served Market", owner.segment, merged.segment],
          ["Region", owner.region, merged.region],
        ] as const
      )
        .filter(([, before, after]) => before !== after)
        .map(([label, before, after]) => change(label, before, after));
      if (changes.length > 0) {
        await auditBeforeChange(deps.audit, [
          { entity: ENTITY_USER, recordId: owner.id, action: "Edited", changes, note: `${SCOPE_NOTE_PREFIX}${leaver.userName} (${leaver.email}), who was off-boarded.`, ...by },
        ]);
        await writer.update({ id: owner.id, userName: owner.userName, role: owner.role, ...merged, actor: actor.userName });
        newOwner = { ...owner, ...merged };
      }
    }

    await auditBeforeChange(deps.audit, [
      {
        entity: ENTITY_USER,
        recordId: leaver.id,
        action: "Deactivated",
        changes: [change("Active", "true", "false"), change("Status", leaver.status, STATUS_OFFBOARDED)],
        note: offboardNote(rowIds.length, owner.userName, owner.email),
        ...by,
      },
    ]);
    await writer.setActive({ id: leaver.id, active: false, status: STATUS_OFFBOARDED, actor: actor.userName });
    return { reassignedRows: rowIds.length, user: { ...leaver, isActive: false, status: STATUS_OFFBOARDED }, newOwner };
  }, "saved");
}

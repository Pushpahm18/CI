import type { FieldChange } from "@/types/ci";
import { CiError, NotConfiguredError } from "@/server/ci/errors";
import { getAuditHistoryStore, type AuditInput } from "@/server/ci/databricks/audit-history";
import { CI_TABLE_LABELS } from "@/server/db/schema";

/**
 * Audit history for the changes made outside the competitive rows (users, lookups, dependent lookups), written to
 * corp_marketing_dev.audit.ci_audit_history through server/ci/databricks/audit-history.ts. The competitive rows' own
 * audit goes through the repository (services/competitive-info.ts).
 *
 * Who made the change is always the verified signed-in person (name + email), passed in by the service from its
 * authorization step; nothing here reads a request.
 *
 * Two orders, chosen per operation:
 *  - auditBeforeChange: the audit is written FIRST; if that fails nothing is saved. Used where the record's id is known
 *    in advance (users).
 *  - auditAfterChange: the audit is written after the change (its id is only known afterwards). If that fails the
 *    person is told plainly that the change WAS saved but its audit entry was not, and the reason is logged.
 */

export const ENTITY_USER = "User";
export const ENTITY_USER_ACCESS = "User Access";
export const ENTITY_LOOKUP = "Lookup";
export const ENTITY_DEPENDENT_LOOKUP = "Dependent Lookup";

export type AuditWriter = (inputs: AuditInput[]) => Promise<void>;

/** The real writer: refuses (never silently skips) when the audit table is not available. */
export const writeAuditHistory: AuditWriter = async (inputs) => {
  if (inputs.length === 0) return;
  const store = getAuditHistoryStore();
  if (!store) throw new NotConfiguredError([CI_TABLE_LABELS.auditTrail]);
  await store.add(inputs);
};

/** One changed field; blank / missing values become "". */
export function change(label: string, previous: unknown, current: unknown): FieldChange {
  return { field: label, label, previous: String(previous ?? ""), current: String(current ?? "") };
}

/** The change, or null when the value did not change. */
export function diff(label: string, previous: unknown, current: unknown): FieldChange | null {
  return String(previous ?? "") === String(current ?? "") ? null : change(label, previous, current);
}

export async function auditBeforeChange(write: AuditWriter, inputs: AuditInput[]): Promise<void> {
  try {
    await write(inputs);
  } catch (error) {
    console.error("[CI] audit history could not be written; nothing was saved:", error instanceof Error ? error.message : error);
    throw new CiError("The audit history could not be written, so nothing was saved. Check the server log for details.", 502, "INTERNAL");
  }
}

export async function auditAfterChange(write: AuditWriter, inputs: AuditInput[]): Promise<void> {
  try {
    await write(inputs);
  } catch (error) {
    console.error("[CI] audit history could not be written after the change was saved:", error instanceof Error ? error.message : error);
    throw new CiError("The change was saved, but its audit history entry could not be written. Check the server log for details.", 502, "INTERNAL");
  }
}

import type { CiUser, FieldChange } from "@/types/ci";
import type { NotificationOutcome } from "@/types/ci-api";
import { recordInScope, type ScopedRow } from "@/lib/ci/rules";

/**
 * BRD §6 notifications, a log-only notification abstraction until an email provider is configured: recipients
 * are resolved from real User Management data and the email content is
 * built, but no email provider is configured yet, so delivery is PENDING.
 * This module never claims an email was sent, never contacts a provider
 * that isn't configured, and never throws — a save must not fail because
 * notification delivery has a problem.
 *
 * To enable delivery later: implement deliver() against the chosen provider,
 * reading its credentials from server-side environment variables only.
 */

export interface RowChangeEmail {
  kind: "added" | "edited";
  recordId: string;
  customer: string;
  fabLocation: string;
  quarter: string;
  year: string;
  changedBy: string;
  changes: FieldChange[];
  note: string;
  link: string;
}

export interface ImportSummaryEmail {
  kind: "imported";
  importedBy: string;
  rowCount: number;
  /** An Excel import that adds and updates rows reports both counts. */
  added?: number;
  updated?: number;
}

type NotificationEvent = RowChangeEmail | ImportSummaryEmail;

/**
 * BRD §6 / BRD 1.1 §7.6: active users whose scope includes the row (scope
 * applies to notifications too), and Corporate Marketing.
 */
export function rowRecipients(users: CiUser[], row: ScopedRow): CiUser[] {
  return users.filter((u) => u.status === "Active" && recordInScope(u, row));
}

/** CI Prototype: an import sends one summary email to Corporate Marketing. */
export function importRecipients(users: CiUser[]): CiUser[] {
  return users.filter((u) => u.status === "Active" && u.role === "CM");
}

function subject(event: NotificationEvent): string {
  if (event.kind === "imported") {
    return event.added !== undefined ? `[CI] Import completed – ${event.added} added, ${event.updated ?? 0} updated` : `[CI] Import completed – ${event.rowCount} rows`;
  }
  return `[CI] Row ${event.recordId} ${event.kind} – ${event.customer}`;
}

function body(event: NotificationEvent): string {
  if (event.kind === "imported") {
    return event.added !== undefined
      ? `${event.importedBy} imported ${event.added} new rows and updated ${event.updated ?? 0} existing rows in Competitive Intelligence.`
      : `${event.importedBy} imported ${event.rowCount} rows into Competitive Intelligence.`;
  }
  const lines = event.changes.length
    ? event.changes.map((c) => `  • ${c.label}: ${c.previous || "(empty)"} → ${c.current || "(empty)"}`)
    : [];
  return [
    `Row ${event.recordId} was ${event.kind} by ${event.changedBy}.`,
    "",
    `Customer: ${event.customer}`,
    `Fab Location: ${event.fabLocation}`,
    `Quarter: ${event.quarter} ${event.year}`,
    ...(lines.length ? ["", "What changed:", ...lines] : []),
    "",
    "Change Note:",
    event.note,
    "",
    `Open the row: ${event.link}`,
  ].join("\n");
}

interface EmailMessage {
  to: CiUser[];
  subject: string;
  body: string;
}

async function deliver(message: EmailMessage): Promise<boolean> {
  // PENDING: no email provider is configured for CI yet, so nothing is sent.
  void message;
  return false;
}

export async function notify(event: NotificationEvent, recipients: CiUser[]): Promise<NotificationOutcome> {
  try {
    const delivered = await deliver({ to: recipients, subject: subject(event), body: body(event) });
    if (!delivered) {
      console.info(
        `[CI] Email not sent (delivery not configured): "${subject(event)}" → ${recipients.map((r) => r.email).join(", ") || "no recipients"}`
      );
    }
    return { recipients: recipients.length, delivered };
  } catch (error) {
    console.error("[CI] Notification failed:", error instanceof Error ? error.message : error);
    return { recipients: recipients.length, delivered: false };
  }
}

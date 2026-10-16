"use client";

import * as React from "react";
import { FilePlus2, Pencil, Upload, UserRoundCog } from "lucide-react";
import { Drawer } from "@/components/ci/drawer";
import { NotConnectedState } from "@/components/ci/not-connected";
import { ApiError, ciApi, isNotConfigured } from "@/lib/ci/api";
import { formatDateTime } from "@/lib/utils";
import type { AuditAction, AuditEntry, CompetitiveRecord } from "@/types/ci";

const ICONS: Record<AuditAction, { Icon: React.ComponentType<{ className?: string }>; tone: string }> = {
  Created: { Icon: FilePlus2, tone: "text-spark-teal bg-spark-teal-bg" },
  Edited: { Icon: Pencil, tone: "text-spark-teal bg-spark-teal-bg" },
  Imported: { Icon: Upload, tone: "text-spark-gold bg-spark-gold-bg" },
  Reassigned: { Icon: UserRoundCog, tone: "text-muted bg-surface-alt" },
};

const VERB: Record<AuditAction, string> = { Created: "Created by", Edited: "Modified by", Imported: "Uploaded by", Reassigned: "Reassigned by" };

/** How the entry came about: a form entry, or an Import (Historic Load / Bulk Update / Excel Import, including older Imported entries with no stored type). */
function sourceOf(entry: AuditEntry): { label: string; detail?: string; tone: string } | null {
  if (entry.importType || entry.action === "Imported") {
    return { label: "Bulk Import", detail: [entry.importType, entry.sourceFile].filter(Boolean).join(" · ") || undefined, tone: "bg-surface-alt text-accent" };
  }
  if (entry.action === "Created") return { label: "Manual entry", tone: "bg-accent-bg text-accent" };
  return null;
}

function FieldChanges({ entry }: { entry: AuditEntry }) {
  // A new row has no "before": list each field and its value (blank values are left out) instead of "(empty) → value".
  if (entry.action === "Created" || entry.action === "Imported") {
    const filled = entry.changes.filter((c) => c.current !== "");
    return (
      <details className="mt-2 overflow-hidden rounded-md border border-border bg-surface">
        <summary className="cursor-pointer select-none bg-accent-bg px-3 py-2 text-[12.5px] font-semibold text-accent">
          Initial values ({filled.length} fields)
        </summary>
        <dl className="divide-y divide-border">
          {filled.map((c) => (
            <div key={c.field} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 px-3 py-1.5 text-[12.5px]">
              <dt className="text-muted">{c.label}</dt>
              <dd className="break-words font-medium text-foreground">{c.current}</dd>
            </div>
          ))}
        </dl>
      </details>
    );
  }
  // An edit: what it was, then what it is now.
  return (
    <div className="mt-2 divide-y divide-border overflow-hidden rounded-md border border-border bg-surface">
      {entry.changes.map((c) => (
        <div key={c.field} className="px-3 py-1.5 text-[12.5px]">
          <p className="text-muted">{c.label}</p>
          <p className="break-words">
            <span className="text-muted line-through decoration-border-strong">{c.previous || "(empty)"}</span>
            <span className="px-1.5 text-muted-2">→</span>
            <span className="font-semibold text-accent">{c.current || "(empty)"}</span>
          </p>
        </div>
      ))}
    </div>
  );
}

function Entry({ entry, isLast }: { entry: AuditEntry; isLast: boolean }) {
  const { Icon, tone } = ICONS[entry.action] ?? ICONS.Edited;
  const source = sourceOf(entry);
  const verb = VERB[entry.action] ?? "By";
  return (
    <div className="relative flex gap-3 pb-6 last:pb-0">
      {!isLast && <span className="absolute left-[15px] top-8 h-[calc(100%-1.75rem)] w-px bg-border" />}
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${tone}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 pt-1">
        <p className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-foreground">
          {entry.action}
          {source && <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${source.tone}`}>{source.label}</span>}
        </p>
        <p className="mt-0.5 text-[12px] text-muted">
          {verb} <span className="font-medium text-foreground" title={entry.actorEmail || undefined}>{entry.actionTakenBy || "Unknown"}</span> ·{" "}
          <span className="tabular-nums">{entry.dateTime ? formatDateTime(entry.dateTime) : "—"}</span>
        </p>
        {source?.detail && <p className="mt-0.5 text-[12px] text-muted">Source: {source.detail}</p>}
        {entry.changes.length > 0 && <FieldChanges entry={entry} />}
        {entry.note && (
          <p className="mt-2 whitespace-pre-line rounded-r-md border-l-4 border-accent bg-accent-bg-strong px-3 py-2 text-[12.5px] font-medium text-foreground">
            {entry.note}
          </p>
        )}
      </div>
    </div>
  );
}

/** BRD §7.3 Audit Trail: who, when, field-level previous/new values and the Change Note. Append-only. */
export function AuditDrawer({
  record,
  onClose,
}: {
  /** The history is looked up by recordId (ci_id); the title shows the row's Application ID when it has one. */
  record: (Pick<CompetitiveRecord, "recordId" | "customer" | "servedMarket" | "quarter" | "year"> & { applicationId?: string }) | null;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={Boolean(record)}
      onClose={onClose}
      width="max-w-xl"
      title={record ? `Audit Trail · ${record.applicationId || record.recordId}` : "Audit Trail"}
      subtitle={record ? `${record.customer} · ${record.servedMarket} · ${record.quarter} ${record.year}` : undefined}
    >
      <p className="mb-4 text-[12px] text-muted">Entries are append-only and cannot be edited or deleted.</p>
      {/* Keyed by row so each opened row starts from a fresh "loading" state. */}
      {record && <AuditHistory key={record.recordId} recordId={record.recordId} />}
    </Drawer>
  );
}

function AuditHistory({ recordId }: { recordId: string }) {
  const [entries, setEntries] = React.useState<AuditEntry[] | null>(null);
  const [error, setError] = React.useState<unknown>(null);

  React.useEffect(() => {
    let cancelled = false;
    ciApi
      .audit(recordId)
      .then((r) => !cancelled && setEntries(r.entries))
      .catch((e) => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, [recordId]);

  // Newest first (CI Prototype).
  const ordered = React.useMemo(
    () => (entries ? [...entries].sort((a, b) => (a.dateTime < b.dateTime ? 1 : -1)) : null),
    [entries]
  );

  return (
    <>
      {error ? (
        isNotConfigured(error) ? (
          <NotConnectedState what="Audit history" pending={error instanceof ApiError ? error.details : []} />
        ) : (
          <p className="py-10 text-center text-[13px] text-danger">{error instanceof Error ? error.message : "Failed to load audit history."}</p>
        )
      ) : ordered === null ? (
        <p className="py-10 text-center text-[13px] text-muted">Loading audit history…</p>
      ) : ordered.length === 0 ? (
        <p className="py-10 text-center text-[13px] text-muted">No audit history yet.</p>
      ) : (
        ordered.map((e, i) => <Entry key={e.id} entry={e} isLast={i === ordered.length - 1} />)
      )}
    </>
  );
}

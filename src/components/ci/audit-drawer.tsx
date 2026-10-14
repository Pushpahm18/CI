"use client";

import * as React from "react";
import { FilePlus2, Pencil, Upload, UserRoundCog } from "lucide-react";
import { Drawer } from "@/components/ci/drawer";
import { NotConnectedState } from "@/components/ci/not-connected";
import { ApiError, ciApi, isNotConfigured } from "@/lib/ci/api";
import { formatDateTime } from "@/lib/utils";
import type { AuditAction, AuditEntry, CompetitiveRecord } from "@/types/ci";

const ICONS: Record<AuditAction, { Icon: React.ComponentType<{ className?: string }>; tone: string }> = {
  Created: { Icon: FilePlus2, tone: "text-accent bg-accent-bg" },
  Edited: { Icon: Pencil, tone: "text-info bg-info-bg" },
  Imported: { Icon: Upload, tone: "text-success bg-success-bg" },
  Reassigned: { Icon: UserRoundCog, tone: "text-muted bg-surface-alt" },
};

function Entry({ entry, isLast }: { entry: AuditEntry; isLast: boolean }) {
  const { Icon, tone } = ICONS[entry.action] ?? ICONS.Edited;
  return (
    <div className="relative flex gap-3 pb-6 last:pb-0">
      {!isLast && <span className="absolute left-[15px] top-8 h-[calc(100%-1.75rem)] w-px bg-border" />}
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${tone}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 pt-1">
        <p className="text-[13px] font-medium text-foreground">{entry.action}</p>
        <p className="mt-0.5 text-[12px] text-muted">
          {entry.actionTakenBy} · <span className="tabular-nums">{formatDateTime(entry.dateTime)}</span>
        </p>
        {entry.changes.length > 0 && (
          <div className="mt-2 space-y-1 rounded-md border border-border bg-surface-alt p-2.5">
            {entry.changes.map((c) => (
              <p key={c.field} className="text-[12.5px] text-foreground">
                <span className="font-medium">{c.label}:</span>{" "}
                <span className="text-muted line-through decoration-danger/50">{c.previous || "(empty)"}</span>
                {" → "}
                <span className="font-semibold text-success">{c.current || "(empty)"}</span>
              </p>
            ))}
          </div>
        )}
        {entry.note && (
          <p className="mt-2 whitespace-pre-line rounded-r-md border-l-2 border-accent bg-accent-bg px-2.5 py-1.5 text-[12.5px] text-foreground">
            {entry.note}
          </p>
        )}
      </div>
    </div>
  );
}

/** BRD §7.3 Audit Trail: who, when, field-level previous/new values and the Change Note. Append-only. */
export function AuditDrawer({ record, onClose }: { record: Pick<CompetitiveRecord, "recordId" | "customer" | "servedMarket" | "quarter" | "year"> | null; onClose: () => void }) {
  return (
    <Drawer
      open={Boolean(record)}
      onClose={onClose}
      width="max-w-xl"
      title={record ? `Audit Trail · ${record.recordId}` : "Audit Trail"}
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

"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Label, Select } from "@/components/ui/input";
import { ApiError, ciApi } from "@/lib/ci/api";
import { ACCOUNT_TEAM_ROLE, inheritsScope, takeoverCandidates } from "@/lib/ci/user-offboard";
import { parseScopeText } from "@/lib/ci/user-scope";
import type { CiOffboardPreviewResponse, CiOffboardResponse, CiUserRecordRaw } from "@/types/ci-api";

const scopeText = (text: string) => {
  const s = parseScopeText(text);
  return s.kind === "all" ? "All" : s.kind === "list" ? s.values.join(", ") : s.kind === "raw" ? s.text : "—";
};

const messageOf = (e: unknown, fallback: string) => (e instanceof ApiError && e.details.length ? e.details.join(" ") : e instanceof Error ? e.message : fallback);

/**
 * Off-board a user (CI Prototype): the alert says how many rows the leaver created (counted by Databricks on ci_main), the
 * leaver's rows are handed to another active user, and the leaver is marked Off-boarded. Everything shown comes from the
 * user and row tables; the people offered are the other Active users in ci_user_management.
 */
export function OffboardDialog({
  user,
  all,
  onClose,
  onDone,
}: {
  user: CiUserRecordRaw;
  all: CiUserRecordRaw[];
  onClose: () => void;
  onDone: (result: CiOffboardResponse) => void;
}) {
  const [preview, setPreview] = React.useState<{ id: string; data: CiOffboardPreviewResponse | null; error: string }>({ id: "", data: null, error: "" });
  const [ownerId, setOwnerId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    ciApi
      .ciOffboardPreview(user.id)
      .then((data) => !cancelled && setPreview({ id: user.id, data, error: "" }))
      .catch((e) => !cancelled && setPreview({ id: user.id, data: null, error: messageOf(e, "The row count could not be loaded.") }));
    return () => {
      cancelled = true;
    };
  }, [user.id]);

  const loading = preview.id !== user.id;
  const candidates = takeoverCandidates(user, all);
  const owner = candidates.find((c) => c.id === ownerId) ?? null;
  const blocked = preview.data?.blocked ?? null;
  const owned = preview.data?.ownedRows ?? 0;
  const name = user.userName || user.email;

  async function confirm() {
    if (!owner) return;
    setBusy(true);
    setError("");
    try {
      onDone(await ciApi.ciOffboard(user.id, owner.id));
    } catch (e) {
      setError(messageOf(e, "The user could not be off-boarded."));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()} maxWidthClass="max-w-xl">
      <DialogContent>
        <DialogHeader title={`Off-board ${name}`} onClose={busy ? undefined : onClose} />
        <DialogBody className="space-y-3 text-[13px] text-foreground">
          {loading && <p className="text-muted">Counting the rows created by {name} in Databricks…</p>}
          {preview.error && <p className="rounded-md border border-danger/30 bg-danger-bg px-3 py-2 text-danger">{preview.error}</p>}
          {blocked && <p className="rounded-md border border-danger/30 bg-danger-bg px-3 py-2 text-danger">{blocked}</p>}
          {!loading && !blocked && !preview.error && (
            <div className="space-y-1 rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-warning">
              <p className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <span className="font-semibold">Alert:</span>{" "}
                  {owned > 0 ? `${owned.toLocaleString("en-US")} row${owned === 1 ? "" : "s"} created by ${name} need a new owner.` : `${name} has not created any rows.`}
                </span>
              </p>
              {user.role === ACCOUNT_TEAM_ROLE && (
                <p className="pl-6">
                  Current scope: Customer {scopeText(user.customer)} · Served Market {scopeText(user.segment)} · Region {scopeText(user.region)}
                </p>
              )}
            </div>
          )}
          {!loading && !blocked && !preview.error && (
            <div className="space-y-1">
              <Label htmlFor="offboard-owner">Reassign to *</Label>
              <Select id="offboard-owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} disabled={busy}>
                <option value="">Select a user…</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.userName || c.email} ({c.role || "No role"})
                  </option>
                ))}
              </Select>
              <p className="text-[12px] text-muted">
                Each row is recorded in the audit history as reassigned to the new owner. The Created By value stored on the row is not changed.
                {owner && inheritsScope(user, owner) ? ` ${owner.userName || owner.email} also inherits ${name}'s scope (combined with their own).` : " An Account Team user who takes over from another Account Team user also inherits the leaver's scope."}
              </p>
            </div>
          )}
          {error && <p className="rounded-md border border-danger/30 bg-danger-bg px-3 py-2 text-danger">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy || loading || !!blocked || !!preview.error || !owner}>
            {busy ? "Off-boarding…" : "Off-board and reassign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

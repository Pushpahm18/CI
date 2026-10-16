"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { ApiError, ciApi } from "@/lib/ci/api";
import { formatModifiedOn } from "@/lib/ci/format-when";
import { parseScopeText } from "@/lib/ci/user-scope";
import type { CiOffboardDetailsResponse, CiUserRecordRaw } from "@/types/ci-api";

const scopeText = (text: string) => {
  const s = parseScopeText(text);
  return s.kind === "all" ? "All" : s.kind === "list" ? s.values.join(", ") : s.kind === "raw" ? s.text : "—";
};

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1">
      <dt className="w-32 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-foreground">{children}</dd>
    </div>
  );
}

/** Read-only: who took over from an off-boarded user, from the audit history written when they were off-boarded. */
export function OffboardDetailsDialog({ user, onClose }: { user: CiUserRecordRaw; onClose: () => void }) {
  const [state, setState] = React.useState<{ id: string; data: CiOffboardDetailsResponse | null; error: string }>({ id: "", data: null, error: "" });

  React.useEffect(() => {
    let cancelled = false;
    ciApi
      .ciOffboardDetails(user.id)
      .then((data) => !cancelled && setState({ id: user.id, data, error: "" }))
      .catch((e) => !cancelled && setState({ id: user.id, data: null, error: e instanceof ApiError || e instanceof Error ? e.message : "The details could not be loaded." }));
    return () => {
      cancelled = true;
    };
  }, [user.id]);

  const loading = state.id !== user.id;
  const d = state.data;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} maxWidthClass="max-w-lg">
      <DialogContent>
        <DialogHeader title={`${user.userName || user.email} was off-boarded`} onClose={onClose} />
        <DialogBody className="text-[13px]">
          {loading && <p className="text-muted">Loading from the audit history…</p>}
          {state.error && <p className="text-danger">{state.error}</p>}
          {d && !d.found && <p className="text-muted">No off-board details were found in the audit history for this user.</p>}
          {d && d.found && (
            <dl>
              <Line label="Taken over by">
                {d.newOwner.name} ({d.newOwner.email}){d.newOwner.role ? ` · ${d.newOwner.role}` : ""}
              </Line>
              <Line label="Rows moved">{d.rows.toLocaleString("en-US")}</Line>
              <Line label="Off-boarded on">
                {formatModifiedOn(d.at)} by {d.by}
              </Line>
              <Line label="Their scope">
                Customer {scopeText(user.customer)} · Served Market {scopeText(user.segment)} · Region {scopeText(user.region)}
              </Line>
              <Line label="New owner's scope">
                {d.scopeCombined ? (
                  <ul className="space-y-0.5">
                    {d.scope.map((s) => (
                      <li key={s.label}>
                        {s.label}: {scopeText(s.before)} → {scopeText(s.after)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  "No scope change."
                )}
              </Line>
            </dl>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

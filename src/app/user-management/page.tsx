"use client";

import * as React from "react";
import { Pencil, RotateCcw, ShieldAlert, Trash2, UserPlus, Users } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { RoleGuard } from "@/components/ci/role-guard";
import { UserFormCard } from "@/components/ci/user-form-card";
import { DataGrid, type GridColumn } from "@/components/ci/data-grid";
import { NotConnectedState } from "@/components/ci/not-connected";
import { StatusBanner, type StatusMessage } from "@/components/ci/status-banner";
import { useCiSession } from "@/context/ci-session-context";
import { useCiData } from "@/hooks/use-ci-data";
import { ApiError, ciApi } from "@/lib/ci/api";
import { formatModifiedOn } from "@/lib/ci/format-when";
import { parseScopeText } from "@/lib/ci/user-scope";
import { isActiveRecord } from "@/lib/ci/user-rules";
import type { UserFormContext, UserFormValues } from "@/lib/ci/user-form";
import type { CiUserRecordRaw } from "@/types/ci-api";

/*
 * User Management (User Role Management), backed by
 * corp_marketing_dev.ci.ci_user_management through /api/user-management/ci-users.
 * It never reads or writes a SAMBA table.
 *
 * Layout (the reference User Management screen): "Add New User" in the top bar opens the form as a card
 * above the table; the table shows User Name, User Email, Role, Customer, Served Market, Region,
 * Modified By, Modified On and Actions (at the end).
 *
 *   Add New User  Save inserts ONE row; the server requires Corporate Marketing, re-validates, and
 *                 keeps one record per email (case-insensitive).
 *   Edit          pencil icon: the same card for that record (email fixed; name, role and scope can
 *                 change). The server applies the lock-out rules (nobody changes their own role; one
 *                 active Corporate Marketing user always remains).
 *   Deactivate    trash icon, after a confirmation: the person loses access at once. The record is
 *                 kept (is_active = false, status Off-boarded) because CI keeps one record per
 *                 email; a deactivated row shows a reactivate icon instead.
 *
 * States, each distinct: loading, table not set up, not authorized (the server's reason,
 * never shown as "no users"), failed, zero rows, rows.
 */

function ScopeCell({ text }: { text: string }) {
  const s = parseScopeText(text);
  if (s.kind === "empty") return <span className="text-muted-2">—</span>;
  if (s.kind === "all") return <Badge tone="accent">All</Badge>;
  if (s.kind === "raw") return <span title="Shown exactly as stored">{s.text}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {s.values.map((v) => (
        <Badge key={v}>{v}</Badge>
      ))}
    </span>
  );
}

function buildColumns(): GridColumn<CiUserRecordRaw>[] {
  const scope = (key: "customer" | "segment" | "region", label: string): GridColumn<CiUserRecordRaw> => ({
    key,
    label,
    filter: "text",
    value: (u) => u[key],
    render: (u) => <ScopeCell text={u[key]} />,
  });
  return [
    {
      key: "userName",
      label: "User Name",
      filter: "text",
      value: (u) => u.userName,
      // A deactivated person stays in the list (CI keeps one record per email); the tag says so.
      render: (u) => (
        <span className="inline-flex items-center gap-1.5">
          <span className={isActiveRecord(u) ? undefined : "text-muted"}>{u.userName || <span className="text-muted-2">—</span>}</span>
          {!isActiveRecord(u) && <Badge tone="neutral">Inactive</Badge>}
        </span>
      ),
    },
    { key: "email", label: "User Email", filter: "text", value: (u) => u.email },
    { key: "role", label: "Role", filter: "select", value: (u) => u.role },
    scope("customer", "Customer"),
    scope("segment", "Served Market"),
    scope("region", "Region"),
    { key: "modifiedBy", label: "Modified By", filter: "text", value: (u) => u.modifiedBy ?? "" },
    {
      key: "modifiedOn",
      label: "Modified On",
      filter: "text",
      value: (u) => formatModifiedOn(u.modifiedOn),
      sortValue: (u) => (u.modifiedOn ? new Date(u.modifiedOn).getTime() || 0 : 0),
    },
  ];
}

export default function UserManagementPage() {
  const records = useCiData(() => ciApi.ciUserRecords());
  // Customer, Served Market and Region (Fab Region) lists from ci_lookup: the dropdown values, and validation when a list has values.
  const lookups = useCiData(() => ciApi.listLookups());
  const { session } = useCiSession();
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<CiUserRecordRaw | null>(null);
  const [removing, setRemoving] = React.useState<CiUserRecordRaw | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<StatusMessage | null>(null);

  const rows = React.useMemo(() => records.data?.users ?? [], [records.data]);
  const columns = React.useMemo(() => buildColumns(), []);
  const signedIn = session ? { name: session.name, email: session.email } : null;

  const lists = React.useMemo(() => {
    const active = (lookups.data?.lookups ?? []).filter((l) => l.active);
    const of = (category: string) => active.filter((l) => l.category === category).sort((a, b) => a.sortOrder - b.sortOrder).map((l) => l.value);
    return { customers: of("Customer"), segments: of("Served Market"), regions: of("Fab Region") };
  }, [lookups.data]);
  // Customer has no approved master yet, so only Served Market and Region are enforced (the server applies the same lists).
  const masters: UserFormContext["masters"] = { segments: lists.segments, regions: lists.regions };

  async function saveUser(values: UserFormValues): Promise<void> {
    const res = await ciApi.createCiUser(values);
    setMessage({ kind: "ok", text: `${res.user.email} added to ci_user_management.` });
    setAdding(false);
    await records.reload();
  }

  async function saveEdit(values: UserFormValues): Promise<void> {
    if (!editing) return;
    const res = await ciApi.updateCiUser(editing.id, values);
    setMessage({ kind: "ok", text: `${res.user.email} updated.` });
    setEditing(null);
    await records.refresh();
  }

  async function changeActive(user: CiUserRecordRaw, active: boolean): Promise<void> {
    setBusy(true);
    try {
      if (active) await ciApi.reactivateCiUser(user.id);
      else await ciApi.deactivateCiUser(user.id);
      setMessage({ kind: "ok", text: `${user.email} ${active ? "reactivated" : "deactivated"}.` });
      await records.refresh();
    } catch (e) {
      setMessage({ kind: "bad", text: e instanceof ApiError && e.details.length ? e.details.join(" ") : e instanceof Error ? e.message : "The change could not be saved." });
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  }

  const iconButton = "rounded-md p-1.5 text-muted transition-colors hover:bg-accent-bg disabled:cursor-not-allowed disabled:opacity-50";

  const error = records.error;
  const denied = error instanceof ApiError && error.status === 403;

  let emptyState: React.ReactNode;
  if (records.notConfigured) emptyState = <NotConnectedState what="Users" pending={records.pendingTables} />;
  else if (denied) {
    emptyState = <EmptyState icon={<ShieldAlert className="h-7 w-7" />} title="You don't have access to CI user data" description={error.message} />;
  } else if (records.errorMessage) {
    emptyState = <EmptyState icon={<ShieldAlert className="h-7 w-7" />} title="Users could not be loaded" description={records.errorMessage} />;
  } else if (!records.loading && rows.length === 0) {
    emptyState = (
      <EmptyState
        icon={<Users className="h-7 w-7" />}
        title="No users in ci_user_management yet"
        description="The table is connected and empty. Users will appear here once Corporate Marketing users are set up."
      />
    );
  }

  const headerActions = React.useMemo(
    () => (
      <Button
        size="sm"
        onClick={() => {
          setEditing(null);
          setAdding(true);
        }}
      >
        <UserPlus className="h-3.5 w-3.5" /> Add New User
      </Button>
    ),
    []
  );

  return (
    <RoleGuard roles={["CM"]}>
      <PageHeader eyebrow="7.6" title="User Management" description="Add and edit users, their role, and data scope." actions={headerActions} />

      {message && <StatusBanner message={message} onDismiss={() => setMessage(null)} />}
      {records.errorMessage && !denied && <StatusBanner message={{ kind: "bad", text: records.errorMessage }} />}

      {adding && !editing && <UserFormCard existing={rows} signedIn={signedIn} masters={masters} suggestions={lists} onCancel={() => setAdding(false)} onSave={saveUser} />}
      {editing && (
        <UserFormCard
          key={editing.id}
          existing={rows.filter((r) => r.id !== editing.id)}
          editing={editing}
          signedIn={signedIn}
          masters={masters}
          suggestions={lists}
          onCancel={() => setEditing(null)}
          onSave={saveEdit}
        />
      )}

      <DataGrid
        columns={columns}
        rows={rows}
        rowKey={(u) => `${u.id}:${u.email}`}
        loading={records.loading}
        onReload={() => void records.reload()}
        actionsLabel="Actions"
        actionsAt="end"
        actions={(u) => (
          <span className="flex items-center gap-0.5">
            <button
              type="button"
              className={`${iconButton} hover:text-accent`}
              title="Edit user"
              aria-label={`Edit ${u.userName || u.email}`}
              disabled={busy}
              onClick={() => {
                setAdding(false);
                setEditing(u);
              }}
            >
              <Pencil className="h-4 w-4" />
            </button>
            {isActiveRecord(u) ? (
              <button type="button" className={`${iconButton} hover:text-danger`} title="Deactivate user" aria-label={`Deactivate ${u.userName || u.email}`} disabled={busy} onClick={() => setRemoving(u)}>
                <Trash2 className="h-4 w-4" />
              </button>
            ) : (
              <button type="button" className={`${iconButton} hover:text-success`} title="Reactivate user" aria-label={`Reactivate ${u.userName || u.email}`} disabled={busy} onClick={() => void changeActive(u, true)}>
                <RotateCcw className="h-4 w-4" />
              </button>
            )}
          </span>
        )}
        searchPlaceholder="Search through keywords"
        searchText={(u) => `${u.userName} ${u.email} ${u.role} ${u.modifiedBy ?? ""}`}
        emptyState={emptyState}
      />

      {removing && (
        <Dialog open onOpenChange={(o) => !o && !busy && setRemoving(null)}>
          <DialogContent>
            <DialogHeader title="Deactivate user" onClose={busy ? undefined : () => setRemoving(null)} />
            <DialogBody className="space-y-2 text-[13px] text-foreground">
              <p>
                <span className="font-medium">{removing.userName || removing.email}</span> ({removing.email}) will lose access to Competitive Intelligence immediately.
              </p>
              <p className="text-muted">The record is kept and marked Off-boarded, so you can reactivate this person later.</p>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRemoving(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => void changeActive(removing, false)} disabled={busy}>
                {busy ? "Deactivating…" : "Deactivate"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </RoleGuard>
  );
}

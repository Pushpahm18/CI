"use client";

import * as React from "react";
import { Info, Pencil, RotateCcw, ShieldAlert, UserMinus, UserPlus, Users } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { OffboardDetailsDialog } from "@/components/ci/offboard-details-dialog";
import { OffboardDialog } from "@/components/ci/offboard-dialog";
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
import type { CiOffboardResponse, CiUserRecordRaw } from "@/types/ci-api";

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
 *   Off-board     "Off-board" button beside Edit: opens the Off-board dialog (components/ci/offboard-dialog.tsx),
 *                 which shows how many rows the person created, asks who takes over, and then marks the
 *                 person Off-boarded (is_active = false). An off-boarded row is highlighted, shows its
 *                 stored Status, and keeps the Off-board button disabled and shows a Reactivate icon
 *                 (the same reactivation is offered when an off-boarded person's email is added again).
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

function buildColumns(owned: Record<string, number> | undefined, onDetails: (u: CiUserRecordRaw) => void): GridColumn<CiUserRecordRaw>[] {
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
        </span>
      ),
    },
    { key: "email", label: "User Email", filter: "text", value: (u) => u.email },
    { key: "role", label: "Role", filter: "select", value: (u) => u.role },
    scope("customer", "Customer"),
    scope("segment", "Served Market"),
    scope("region", "Region"),
    // Status exactly as stored in ci_user_management.status (Active / Off-boarded); an off-boarded row is also highlighted.
    {
      key: "status",
      label: "Status",
      filter: "select",
      value: (u) => u.status,
      render: (u) =>
        u.status ? (
          <span className="inline-flex items-center gap-2">
            <Badge tone={isActiveRecord(u) ? "accent" : "neutral"}>{u.status}</Badge>
            {!isActiveRecord(u) && (
              <button type="button" className="text-[12px] font-medium text-accent underline-offset-2 hover:underline" onClick={() => onDetails(u)}>
                Details
              </button>
            )}
          </span>
        ) : (
          <span className="text-muted-2">—</span>
        ),
    },
    // Rows owned: live ci_main rows whose created_by is this user's name, counted by Databricks (hidden when ci_main cannot be read).
    ...(owned
      ? [
          {
            key: "rowsOwned",
            label: "Rows owned",
            filter: "text",
            value: (u: CiUserRecordRaw) => String(owned[u.userName] ?? 0),
            sortValue: (u: CiUserRecordRaw) => owned[u.userName] ?? 0,
          } satisfies GridColumn<CiUserRecordRaw>,
        ]
      : []),
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
  const [viewing, setViewing] = React.useState<CiUserRecordRaw | null>(null);
  const [reactivatingId, setReactivatingId] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<StatusMessage | null>(null);

  const rows = React.useMemo(() => records.data?.users ?? [], [records.data]);
  const columns = React.useMemo(() => buildColumns(records.data?.ownedRows, setViewing), [records.data]);
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

  // Adding the email of an off-boarded person reactivates their existing record (CI keeps one record per email).
  async function reactivate(user: CiUserRecordRaw): Promise<void> {
    await ciApi.reactivateCiUser(user.id);
    setMessage({ kind: "ok", text: `${user.userName || user.email} reactivated.` });
    setAdding(false);
    await records.refresh();
  }

  // The Reactivate icon on an off-boarded row; a refused reactivation (for example an invalid stored scope) shows the server's reason.
  async function reactivateRow(user: CiUserRecordRaw): Promise<void> {
    setReactivatingId(user.id);
    try {
      await reactivate(user);
    } catch (e) {
      setMessage({ kind: "bad", text: e instanceof ApiError && e.details.length ? e.details.join(" ") : e instanceof Error ? e.message : "The user could not be reactivated." });
    } finally {
      setReactivatingId(null);
    }
  }

  async function offboarded(result: CiOffboardResponse): Promise<void> {
    const who = result.user.userName || result.user.email;
    const to = result.newOwner.userName || result.newOwner.email;
    setRemoving(null);
    setMessage({ kind: "ok", text: `${who} off-boarded. ${result.reassignedRows.toLocaleString("en-US")} row${result.reassignedRows === 1 ? "" : "s"} reassigned to ${to}.` });
    await records.refresh();
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

      <p className="mb-2 flex shrink-0 items-start gap-2 text-[12.5px] text-muted">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
        <span>
          <span className="font-semibold text-foreground">Off-boarding alert.</span> When you off-board a user who created rows, CI tells you how many rows they created (counted in
          Databricks) and asks you to choose a new owner. Each row is recorded in the audit history, and the leaver&apos;s name stays in the audit trail.
        </span>
      </p>

      {adding && !editing && <UserFormCard existing={rows} signedIn={signedIn} masters={masters} suggestions={lists} onCancel={() => setAdding(false)} onSave={saveUser} onReactivate={reactivate} />}
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
        rowClassName={(u) => (isActiveRecord(u) ? undefined : "bg-accent-bg even:bg-accent-bg text-muted")}
        actions={(u) => (
          <span className="flex items-center gap-0.5">
            <button
              type="button"
              className={`${iconButton} hover:text-accent`}
              title={isActiveRecord(u) ? "Edit user" : "Off-boarded users cannot be edited. Reactivate first."}
              aria-label={`Edit ${u.userName || u.email}`}
              disabled={!isActiveRecord(u)}
              onClick={() => {
                setAdding(false);
                setEditing(u);
              }}
            >
              <Pencil className="h-4 w-4" />
            </button>
            {/* Always shown; disabled for an off-boarded user (already done) and for yourself. */}
            <Button
              size="sm"
              variant="outline"
              className="ml-1 h-7 border-accent px-2.5 text-[12.5px] text-accent hover:bg-accent-bg"
              title={
                !isActiveRecord(u)
                  ? "Already off-boarded"
                  : signedIn && u.email.trim().toLowerCase() === signedIn.email.trim().toLowerCase()
                    ? "You cannot off-board yourself"
                    : "Off-board user"
              }
              aria-label={`Off-board ${u.userName || u.email}`}
              disabled={!isActiveRecord(u) || (!!signedIn && u.email.trim().toLowerCase() === signedIn.email.trim().toLowerCase())}
              onClick={() => setRemoving(u)}
            >
              <UserMinus className="h-3.5 w-3.5" /> Off-board
            </Button>
            {!isActiveRecord(u) && (
              <button
                type="button"
                className={`${iconButton} hover:text-accent`}
                title="Reactivate user"
                aria-label={`Reactivate ${u.userName || u.email}`}
                disabled={reactivatingId !== null}
                onClick={() => void reactivateRow(u)}
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            )}
          </span>
        )}
        searchPlaceholder="Search through keywords"
        searchText={(u) => `${u.userName} ${u.email} ${u.role} ${u.modifiedBy ?? ""}`}
        emptyState={emptyState}
      />

      {viewing && <OffboardDetailsDialog user={viewing} onClose={() => setViewing(null)} />}
      {removing && <OffboardDialog user={removing} all={rows} onClose={() => setRemoving(null)} onDone={(r) => void offboarded(r)} />}
    </RoleGuard>
  );
}

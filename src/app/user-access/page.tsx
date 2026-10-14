"use client";

import * as React from "react";
import { KeyRound, ShieldAlert, UserPlus } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { RoleGuard } from "@/components/ci/role-guard";
import { DirectoryUserDropdown } from "@/components/ci/directory-user-dropdown";
import { NotConnectedState } from "@/components/ci/not-connected";
import { StatusBanner, type StatusMessage } from "@/components/ci/status-banner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Label } from "@/components/ui/input";
import { PaginationFooter, usePagination } from "@/components/ui/pagination";
import { SearchToolbar } from "@/components/ui/search-toolbar";
import { Table, TableWrap, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useCiData } from "@/hooks/use-ci-data";
import { ApiError, ciApi } from "@/lib/ci/api";
import { formatDateTime } from "@/lib/utils";

/*
 * User Access, as in SAMBA (Admin > User Access) and separate from User Management: an ADD-ONLY list of the people added to the
 * application (corp_marketing_dev.ci.ci_user_access). To add someone you pick them from the Microsoft directory (their email fills
 * in, read-only); a person already in the table is refused ("For the selected values, the user is already included in the Table.").
 * There is no edit and no delete here, and no role or scope: those are configured separately in User Management.
 *
 * It is the first step of the sign-in gate: an Account Team person also needs a row here; Corporate Marketing does not, so this
 * screen can always be opened to add people. The server enforces all of it; only Corporate Marketing sees this screen.
 */

type Picked = { displayName: string; email: string };

export default function UserAccessPage() {
  const access = useCiData(() => ciApi.userAccess());
  const directory = useCiData(() => ciApi.userAccessDirectory());
  const [showForm, setShowForm] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [selected, setSelected] = React.useState<Picked | null>(null);
  const [manual, setManual] = React.useState({ name: "", email: "" });
  const [error, setError] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [message, setMessage] = React.useState<StatusMessage | null>(null);

  const entries = React.useMemo(() => access.data?.entries ?? [], [access.data]);
  const existingEmails = React.useMemo(() => new Set(entries.map((e) => e.email.trim().toLowerCase())), [entries]);
  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.name.toLowerCase().includes(q) || e.email.toLowerCase().includes(q) || e.modifiedBy.toLowerCase().includes(q));
  }, [entries, search]);
  const { pageItems, page, pageCount, pageSize, total, setPage, setPageSize } = usePagination(filtered, 100);

  // Typing a name and email is offered ONLY when the server says so (local development while the directory cannot be read).
  const manualEntry = directory.data?.manualEntryAllowed === true;
  const directoryError = directory.errorMessage ?? (directory.data && !directory.data.configured && !manualEntry ? "Microsoft directory search is not configured on this server." : "");
  const person = manualEntry ? (manual.name.trim() && manual.email.trim() ? { displayName: manual.name.trim(), email: manual.email.trim() } : null) : selected;

  function resetForm() {
    setSelected(null);
    setManual({ name: "", email: "" });
    setError("");
  }

  async function submit() {
    if (!person) {
      setError("Search and select a username from the organization directory.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await ciApi.addUserAccess({ email: person.email, username: person.displayName });
      setMessage({ kind: "ok", text: `${res.entry.email} added to User Access.` });
      setShowForm(false);
      resetForm();
      await access.reload();
    } catch (e) {
      setError(e instanceof ApiError && e.details.length ? e.details.join(" ") : e instanceof Error ? e.message : "Failed to save user.");
    } finally {
      setSubmitting(false);
    }
  }

  const loadError = access.error;
  const denied = loadError instanceof ApiError && loadError.status === 403;

  const headerActions = React.useMemo(
    () => (
      <Button size="sm" onClick={() => setShowForm((s) => !s)}>
        <UserPlus className="h-3.5 w-3.5" /> Add User
      </Button>
    ),
    []
  );

  return (
    <RoleGuard roles={["CM"]}>
      <PageHeader
        title="User Access"
        description="Who can sign into Competitive Intelligence. Role and data scope are configured separately in User Management."
        actions={headerActions}
      />

      {message && <StatusBanner message={message} onDismiss={() => setMessage(null)} />}

      {showForm && (
        <Card className="mb-3">
          <CardHeader>
            <CardTitle>Add User</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-[12.5px] text-danger">{error}</p>}
            {manualEntry && (
              <p className="rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-[12.5px] text-warning">
                Local development only: type the name and email by hand. {directory.data?.unavailable ?? "Microsoft directory search is not configured on this server."}
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label className="mb-1 block">Username</Label>
                {manualEntry ? (
                  <Input value={manual.name} onChange={(e) => setManual((m) => ({ ...m, name: e.target.value }))} aria-label="Username" />
                ) : (
                  <DirectoryUserDropdown
                    users={directory.data?.users ?? []}
                    loading={directory.loading}
                    error={directoryError}
                    selected={selected}
                    onSelect={(u) => {
                      setSelected(u);
                      setError("");
                    }}
                    existingEmails={existingEmails}
                  />
                )}
              </div>
              <div>
                <Label className="mb-1 block">User Email</Label>
                {/* Filled in from the selected directory user and read-only: the Admin never types it. */}
                {manualEntry ? (
                  <Input type="email" value={manual.email} onChange={(e) => setManual((m) => ({ ...m, email: e.target.value }))} aria-label="User Email" />
                ) : (
                  <div className="flex h-9 items-center rounded-md border border-border-strong bg-surface-alt px-2.5 text-[13px] text-muted" aria-label="User Email">
                    {selected?.email || "Select a username first…"}
                  </div>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  resetForm();
                  setShowForm(false);
                }}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button onClick={() => void submit()} disabled={submitting || !person}>
                <UserPlus className="h-4 w-4" /> {submitting ? "Saving…" : "Add User"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="mb-2">
        <SearchToolbar value={search} onChange={setSearch} onRefresh={() => void access.reload()} placeholder="Search through keywords" />
      </div>

      {access.loading ? (
        <TableWrap>
          <p className="py-10 text-center text-[13px] text-muted">Loading User Access records from Databricks…</p>
        </TableWrap>
      ) : access.notConfigured ? (
        <TableWrap>
          <NotConnectedState what="User Access" pending={access.pendingTables} />
        </TableWrap>
      ) : denied ? (
        <TableWrap>
          <EmptyState icon={<ShieldAlert className="h-7 w-7" />} title="You don't have access to CI user data" description={loadError.message} />
        </TableWrap>
      ) : access.errorMessage ? (
        <TableWrap>
          <p className="py-10 text-center text-[13px] text-danger">{access.errorMessage}</p>
        </TableWrap>
      ) : pageItems.length === 0 ? (
        <TableWrap>
          <EmptyState
            icon={<KeyRound className="h-7 w-7" />}
            title={entries.length === 0 ? "No users added yet" : "No users match your search"}
            description={entries.length === 0 ? "Use Add User to add the first person." : undefined}
          />
        </TableWrap>
      ) : (
        <>
          <TableWrap>
            <Table>
              <THead>
                <TR>
                  <TH>User Name</TH>
                  <TH>User Email</TH>
                  <TH>Modified By</TH>
                  <TH>Modified On</TH>
                </TR>
              </THead>
              <TBody>
                {pageItems.map((e) => (
                  <TR key={e.id}>
                    <TD className="font-medium">{e.name || "—"}</TD>
                    <TD>{e.email}</TD>
                    <TD>{e.modifiedBy || "—"}</TD>
                    <TD className="whitespace-nowrap tabular-nums">{e.modifiedOn ? formatDateTime(e.modifiedOn) : "—"}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
          <PaginationFooter page={page} pageCount={pageCount} pageSize={pageSize} total={total} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </>
      )}
    </RoleGuard>
  );
}

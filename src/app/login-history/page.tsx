"use client";

import * as React from "react";
import { Download, RotateCw } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { NotConnectedState } from "@/components/ci/not-connected";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableWrap, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { SearchToolbar } from "@/components/ui/search-toolbar";
import { PaginationFooter, usePagination } from "@/components/ui/pagination";
import { EmptyState } from "@/components/ui/empty-state";
import { useCiData } from "@/hooks/use-ci-data";
import { ciApi } from "@/lib/ci/api";
import { downloadXlsx } from "@/lib/xlsx";
import { cn, formatDateTime } from "@/lib/utils";
import type { LoginHistoryOptionalColumn, LoginHistoryRecord } from "@/types/ci-api";

/*
 * Login History — the CI Prototype screen: three summary tiles, search,
 * Event and User filters, Export to Excel, and a table of sign-in activity.
 * Corporate Marketing sees every user's sign-ins; everyone else sees only
 * their own ("My Login History"). The server decides which (the verified
 * session email), never the browser.
 *
 * The prototype's Role, Event, Result, Device, IP address and Note columns
 * are shown ONLY when the CI Login History table has them
 * (server/db/schema.ts LOGIN_HISTORY_COLUMNS), so nothing is invented for a
 * column that is not there. PENDING-CI-TABLE: until the table is configured
 * the screen shows "CI database table configuration is pending" and no rows.
 *
 * TEMPORARY-DEV-ACCESS: no page-level guard while CI login is not built; the
 * API decides who may see what (server/ci/login-history/service.ts).
 */

const OPTIONAL_LABELS: Record<LoginHistoryOptionalColumn, string> = {
  role: "Role",
  event: "Event",
  result: "Result",
  device: "Device",
  ipAddress: "IP address",
  note: "Note",
};

function Tile({ value, label }: { value: string; label: string }) {
  return (
    <Card className="px-3.5 py-3">
      <p className="text-[22px] font-semibold tabular-nums text-foreground">{value}</p>
      <p className="text-[12px] text-muted">{label}</p>
    </Card>
  );
}

function Pill({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span className={cn("inline-block rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold", ok ? "bg-success-bg text-success" : "bg-danger-bg text-danger")}>
      {children}
    </span>
  );
}

const isSuccess = (r: LoginHistoryRecord) => r.result === undefined || /^(success|ok)/i.test(r.result);

export default function LoginHistoryPage() {
  const history = useCiData(() => ciApi.loginHistory());
  const [search, setSearch] = React.useState("");
  const [event, setEvent] = React.useState("");
  const [user, setUser] = React.useState("");

  const records = React.useMemo(() => history.data?.records ?? [], [history.data]);
  const optional = React.useMemo(() => history.data?.optionalColumns ?? [], [history.data]);
  const all = history.data?.scope !== "own";
  const hasEvent = optional.includes("event");
  const hasResult = optional.includes("result");

  const users = React.useMemo(() => Array.from(new Set(records.map((r) => r.name || r.email))).sort((a, b) => a.localeCompare(b)), [records]);
  const events = React.useMemo(
    () => Array.from(new Set(records.map((r) => r.event).filter((e): e is string => Boolean(e)))).sort(),
    [records]
  );

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return records.filter((r) => {
      if (event && r.event !== event) return false;
      if (user && (r.name || r.email) !== user) return false;
      if (!q) return true;
      const text = [r.name, r.email, r.loginTime ? formatDateTime(r.loginTime) : "", ...optional.map((k) => r[k] ?? "")].join(" ").toLowerCase();
      return text.includes(q);
    });
  }, [records, search, event, user, optional]);

  const { pageItems, page, pageCount, pageSize, total, setPage, setPageSize } = usePagination(filtered, 25);

  // Tiles. Without an Event column every recorded row is a sign-in; without a Result column
  // failures are not recorded, so the tile says so instead of showing a made-up 0.
  const successful = records.filter((r) => (hasEvent ? r.event === "Signed in" : true) && isSuccess(r)).length;
  const failed = hasResult ? records.filter((r) => !isSuccess(r)).length : null;
  const people = new Set(records.map((r) => r.email.toLowerCase())).size;

  async function exportRows() {
    const heads = ["When", ...(all ? ["User"] : []), "Email", ...optional.map((k) => OPTIONAL_LABELS[k])];
    await downloadXlsx("CI_Login_History.xlsx", [
      {
        name: "Login History",
        rows: [heads, ...filtered.map((r) => [r.loginTime ? formatDateTime(r.loginTime) : "", ...(all ? [r.name] : []), r.email, ...optional.map((k) => r[k] ?? "")])],
      },
    ]);
  }

  function reset() {
    setSearch("");
    setEvent("");
    setUser("");
    setPage(1);
  }

  const selectClass = "h-7 rounded-md border border-border-strong bg-surface px-2 text-[12.5px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

  return (
    <>
      <PageHeader
        title={all ? "Login History" : "My Login History"}
        description="Single sign-on activity for the application. Corporate Marketing sees all users; Sales sees their own."
      />

      {!history.notConfigured && (
        <div className="mb-2 grid shrink-0 grid-cols-1 gap-2.5 sm:grid-cols-3">
          <Tile value={history.loading ? "—" : String(successful)} label="Successful sign-ins" />
          <Tile value={history.loading || failed === null ? "—" : String(failed)} label={failed === null && !history.loading ? "Failed attempts (not recorded)" : "Failed attempts"} />
          <Tile value={history.loading ? "—" : String(people)} label={all ? "Users with activity" : "Your account"} />
        </div>
      )}

      <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2">
        <SearchToolbar value={search} onChange={setSearch} onRefresh={() => void history.reload()} placeholder="Search through keywords" />
        {hasEvent && (
          <select value={event} onChange={(e) => setEvent(e.target.value)} aria-label="Event" className={selectClass}>
            <option value="">All events</option>
            {events.map((e) => (
              <option key={e}>{e}</option>
            ))}
          </select>
        )}
        {all && (
          <select value={user} onChange={(e) => setUser(e.target.value)} aria-label="User" className={selectClass}>
            <option value="">All users</option>
            {users.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={reset}
          title="Reset filters"
          aria-label="Reset filters"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border-strong bg-surface text-muted transition-colors hover:bg-accent-bg hover:text-accent"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>
        <span className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => void exportRows()} disabled={history.loading || history.notConfigured || !filtered.length}>
          <Download className="h-3.5 w-3.5" /> Export to Excel
        </Button>
      </div>

      {history.loading ? (
        <TableWrap>
          <p className="py-10 text-center text-[13px] text-muted">Loading Login History from Databricks…</p>
        </TableWrap>
      ) : history.notConfigured ? (
        <TableWrap>
          <NotConnectedState what="Login History" pending={history.pendingTables} />
        </TableWrap>
      ) : history.errorMessage ? (
        <TableWrap>
          <p className="py-10 text-center text-[13px] text-danger">{history.errorMessage}</p>
        </TableWrap>
      ) : pageItems.length === 0 ? (
        <TableWrap>
          <EmptyState title="No login events match." />
        </TableWrap>
      ) : (
        <>
          <TableWrap scroll>
            <Table>
              <THead>
                <TR>
                  <TH>When</TH>
                  {all && <TH>User</TH>}
                  <TH>Email</TH>
                  {optional.map((k) => (
                    <TH key={k}>{OPTIONAL_LABELS[k]}</TH>
                  ))}
                </TR>
              </THead>
              <TBody>
                {pageItems.map((r) => (
                  <TR key={r.id}>
                    <TD className="whitespace-nowrap tabular-nums">{r.loginTime ? formatDateTime(r.loginTime) : "—"}</TD>
                    {all && <TD className="font-medium">{r.name || "—"}</TD>}
                    <TD>{r.email}</TD>
                    {optional.map((k) => (
                      <TD key={k} className={k === "note" ? "min-w-[180px] whitespace-normal" : undefined}>
                        {k === "result" && r.result ? <Pill ok={isSuccess(r)}>{r.result}</Pill> : r[k] || "—"}
                      </TD>
                    ))}
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
          <PaginationFooter page={page} pageCount={pageCount} pageSize={pageSize} total={total} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </>
      )}
    </>
  );
}

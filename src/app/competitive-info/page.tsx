"use client";

import * as React from "react";
import { useSession } from "next-auth/react";
import { Download, History, Pencil, Plus } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { RoleGuard } from "@/components/ci/role-guard";
import { DataGrid, type GridColumn } from "@/components/ci/data-grid";
import { AuditDrawer } from "@/components/ci/audit-drawer";
import { CompetitiveForm } from "@/components/ci/competitive-form";
import { NotConnectedState } from "@/components/ci/not-connected";
import { StatusBanner, type StatusMessage } from "@/components/ci/status-banner";
import { useCiSession } from "@/context/ci-session-context";
import { useCiData } from "@/hooks/use-ci-data";
import { ApiError, ciApi } from "@/lib/ci/api";
import { RECORD_COLUMNS } from "@/lib/ci/main-columns";
import { editWindowMessage, salesEditWindowOpen } from "@/lib/ci/rules";
import { formatStoredDate } from "@/lib/ci/stored-date";
import { downloadXlsx } from "@/lib/xlsx";
import { EMPTY_FORM_OPTIONS } from "@/lib/ci/empty";
import type { ChangeNote, CompetitiveRecord } from "@/types/ci";
import type { SaveRecordResponse, GalleryResponse } from "@/types/ci-api";

type GalleryRow = Record<string, string>;

/** Column types the database reports as numbers sort numerically. */
const NUMERIC_TYPE = /^(tinyint|smallint|int|integer|bigint|float|double|decimal|numeric|real)\b/i;
/** A column with this few distinct values gets a dropdown filter (like the prototype's list columns); others a text filter. */
const SELECT_FILTER_MAX_DISTINCT = 25;

function savedMessage(response: SaveRecordResponse, verb: string): StatusMessage {
  const { recipients, delivered } = response.notification;
  return {
    kind: "ok",
    text: delivered
      ? `Row ${response.record.recordId} ${verb}. Email sent to ${recipients} ${recipients === 1 ? "person" : "people"}.`
      : `Row ${response.record.recordId} ${verb}. Email notification not sent — email delivery is not configured yet.`,
  };
}

/** Columns that are not shown in the grid. Their values are still in every row (the Edit and Audit actions read the Record ID from it). */
const HIDDEN_COLUMNS = new Set<string>([RECORD_COLUMNS.recordId, RECORD_COLUMNS.active]);

/**
 * Grid columns built from the table's real columns (except HIDDEN_COLUMNS). Every value is shown exactly as it is stored in Databricks, except the two
 * date columns: created_date and modified_date show as dd-mmm-yyyy, e.g. 06-Jan-2024 (lib/ci/stored-date.ts). They still sort
 * and filter by the stored value.
 */
function buildColumns(gallery: GalleryResponse): GridColumn<GalleryRow>[] {
  // application_id (the row's visible id) comes first; every other column keeps the table's own order.
  const shown = gallery.columns.filter((c) => !HIDDEN_COLUMNS.has(c.name));
  const ordered = [...shown.filter((c) => c.name === RECORD_COLUMNS.applicationId), ...shown.filter((c) => c.name !== RECORD_COLUMNS.applicationId)];
  return ordered.map((c) => {
    const numeric = NUMERIC_TYPE.test(c.type);
    const isDate = c.name === RECORD_COLUMNS.createdOn || c.name === RECORD_COLUMNS.modifiedOn;
    const show = (r: GalleryRow) => (isDate ? formatStoredDate(r[c.name] ?? "") : (r[c.name] ?? ""));
    const distinct = new Set(gallery.rows.map(show).filter((v) => v !== ""));
    return {
      key: c.name,
      label: c.name,
      filter: distinct.size > 0 && distinct.size <= SELECT_FILTER_MAX_DISTINCT ? "select" : "text",
      numeric,
      value: show,
      sortValue: numeric
        ? (r) => (r[c.name] === "" ? Number.NEGATIVE_INFINITY : Number(r[c.name]))
        : isDate
          ? (r) => Date.parse(r[c.name] ?? "") || Number.NEGATIVE_INFINITY
          : undefined,
    };
  });
}

/**
 * All Competitive Info View. The gallery shows the actual columns and rows of
 * the configured table (server/db/schema.ts COMPETITIVE_GALLERY_SOURCE), read
 * through GET /api/competitive-info/gallery: read-only, no assumed column
 * names, no sample data. Search, per-column filters, sort, Show Columns,
 * pagination and Export run over whatever columns the table has.
 *
 * Every row has an Actions column at the end (as in SAMBA): a pencil opens the Edit form for that row (the row and its
 * Change Notes are read fresh from the server; Save needs a new Change Note), and a history icon opens that row's Audit
 * Trail (who changed what and when, with the Change Notes). The server decides who may edit or see each row.
 */
export default function AllCompetitiveInfoPage() {
  const { user } = useCiSession();
  const { data: session } = useSession();
  const gallery = useCiData(() => ciApi.competitiveGallery());
  const options = useCiData(() => ciApi.formOptions());
  const [form, setForm] = React.useState<boolean>(false);
  const [editing, setEditing] = React.useState<{ record: CompetitiveRecord; notes: ChangeNote[] } | null>(null);
  const [opening, setOpening] = React.useState<string | null>(null);
  const [auditRow, setAuditRow] = React.useState<{ recordId: string; applicationId: string; customer: string; servedMarket: string; quarter: string; year: string } | null>(null);

  // Home's "Add a new row" opens this screen with ?add=1: open the form once, then tidy the address.
  React.useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("add") !== "1") return;
    url.searchParams.delete("add");
    window.history.replaceState(null, "", url.pathname + url.search);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time reaction to the address, not derivable during render
    setForm(true);
  }, []);
  const [message, setMessage] = React.useState<StatusMessage | null>(null);

  const formOpen = form || editing !== null;
  const data = gallery.data;
  const rows = React.useMemo(() => data?.rows ?? [], [data]);
  const columns = React.useMemo(() => (data ? buildColumns(data) : []), [data]);
  // The grid keeps its own column-visibility state, so it is rebuilt whenever the table's columns change.
  const gridKey = data ? `${data.table}|${data.columns.map((c) => c.name).join(",")}` : "pending";

  // Account Team can edit a row only until 31 Dec of the year it was created (lib/ci/rules.ts); Corporate Marketing is exempt.
  // The server enforces the same rule on every save.
  const isLocked = (row: GalleryRow) => user?.role === "Sales" && !salesEditWindowOpen(row[RECORD_COLUMNS.createdOn] ?? "");

  const hasRecordId = Boolean(data?.columns.some((c) => c.name === RECORD_COLUMNS.recordId));

  async function openEdit(row: GalleryRow) {
    const id = row[RECORD_COLUMNS.recordId];
    if (!id) return;
    setOpening(id);
    try {
      setEditing(await ciApi.getRecord(id));
    } catch (e) {
      setMessage({ kind: "bad", text: e instanceof ApiError || e instanceof Error ? e.message : "The row could not be opened." });
    } finally {
      setOpening(null);
    }
  }

  const iconButton = "rounded-md p-1.5 text-muted transition-colors hover:bg-accent-bg hover:text-accent disabled:cursor-not-allowed disabled:opacity-50";

  // Export uses every row matching the current search and filters (never just the current
  // page) and only the columns currently shown in Show Columns, in the order displayed.
  // It is an Excel workbook (CI Prototype); numeric columns are written as numbers.
  async function exportRows(filtered: GalleryRow[], shown: GridColumn<GalleryRow>[]) {
    if (shown.length === 0) {
      setMessage({ kind: "warn", text: "No columns are selected. Choose at least one column in Show Columns before exporting." });
      return;
    }
    await downloadXlsx("CI_Competitive_Info.xlsx", [
      {
        name: "Competitive Info",
        rows: [
          shown.map((c) => c.label),
          ...filtered.map((r) => shown.map((c) => (c.numeric && r[c.key] !== "" && Number.isFinite(Number(r[c.key])) ? Number(r[c.key]) : (r[c.key] ?? "")))),
        ],
      },
    ]);
    setMessage(
      filtered.length === 0
        ? { kind: "warn", text: "Export saved — 0 rows matched the current view, so only the column headings were downloaded." }
        : { kind: "ok", text: `Exported ${filtered.length} row${filtered.length === 1 ? "" : "s"} to Excel.` }
    );
  }

  return (
    <RoleGuard roles={["Sales", "CM"]}>
      {formOpen ? (
        <PageHeader
          title={editing ? `Edit ${editing.record.recordId}` : "Add New"}
          description={
            editing
              ? "Change this row. Saving takes effect at once, is audited and notifies the customer team."
              : "Add a competitive row. Fill every column across; saving takes effect at once and notifies the customer team."
          }
        />
      ) : (
        <PageHeader
          eyebrow="7.1"
          title="All Competitive Info View"
          description="Competitive wins, losses and pricing by customer, fab and technology node."
        />
      )}

      {/* The grid stays mounted (so its filters and page are kept) but is hidden while the Add / Edit page is open. */}
      <div className={formOpen ? "hidden" : "contents"}>
      {message && <StatusBanner message={message} onDismiss={() => setMessage(null)} />}
      {gallery.errorMessage && <StatusBanner message={{ kind: "bad", text: gallery.errorMessage }} />}
      {options.errorMessage && <StatusBanner message={{ kind: "warn", text: `Form dropdowns: ${options.errorMessage}` }} />}
      {(options.data?.pendingSources.length ?? 0) > 0 && (
        <StatusBanner message={{ kind: "warn", text: `Not available in the Add/Edit form yet: ${options.data!.pendingSources.join("; ")}.` }} />
      )}
      {data?.truncated && (
        <StatusBanner
          message={{ kind: "warn", text: `Showing the first ${data.rowLimit.toLocaleString()} rows of ${data.table}; the table has more.` }}
        />
      )}

      <DataGrid
        key={gridKey}
        columns={columns}
        rows={rows}
        rowKey={(r) => String(rows.indexOf(r))}
        loading={gallery.loading}
        onReload={() => void gallery.reload()}
        searchPlaceholder="Search all columns"
        actionsLabel="Actions"
        actionsAt="end"
        actions={
          hasRecordId
            ? (r) => (
                <span className="flex items-center gap-0.5">
                  <button
                    type="button"
                    className={iconButton}
                    title={isLocked(r) ? editWindowMessage(r[RECORD_COLUMNS.createdOn] ?? "") : "Edit row"}
                    aria-label={`Edit row ${r[RECORD_COLUMNS.applicationId] || r[RECORD_COLUMNS.recordId]}`}
                    disabled={options.loading || Boolean(options.error) || opening !== null || isLocked(r)}
                    onClick={() => void openEdit(r)}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className={iconButton}
                    title="Audit history"
                    aria-label={`Audit history of row ${r[RECORD_COLUMNS.applicationId] || r[RECORD_COLUMNS.recordId]}`}
                    onClick={() =>
                      setAuditRow({
                        recordId: r[RECORD_COLUMNS.recordId],
                        applicationId: r[RECORD_COLUMNS.applicationId] ?? "",
                        customer: r[RECORD_COLUMNS.customer] ?? "",
                        servedMarket: r[RECORD_COLUMNS.servedMarket] ?? "",
                        quarter: r[RECORD_COLUMNS.quarter] ?? "",
                        year: r[RECORD_COLUMNS.year] ?? "",
                      })
                    }
                  >
                    <History className="h-4 w-4" />
                  </button>
                </span>
              )
            : undefined
        }
        emptyState={gallery.notConfigured ? <NotConnectedState what="Competitive rows" pending={gallery.pendingTables} /> : undefined}
        toolbar={(filtered, shown) => (
          <>
            <Button size="sm" onClick={() => setForm(true)} disabled={options.loading || Boolean(options.error)}>
              <Plus className="h-3.5 w-3.5" /> Add New
            </Button>
            <Button size="sm" variant="outline" onClick={() => void exportRows(filtered, shown)} disabled={gallery.loading || !data}>
              <Download className="h-3.5 w-3.5" /> Export to Excel
            </Button>
            {data && <span className="text-[12px] text-muted">{data.table}</span>}
          </>
        )}
      />

      </div>

      {form && (
        <CompetitiveForm
          key="add"
          open
          existingNotes={[]}
          options={options.data ?? EMPTY_FORM_OPTIONS}
          user={user}
          signedInName={user?.name ?? session?.user?.name ?? ""}
          applicationSuggestions={[]}
          onClose={() => setForm(false)}
          onSaved={(response) => {
            setMessage(savedMessage(response, "added"));
            setForm(false);
            void gallery.reload();
          }}
        />
      )}
      {editing && (
        <CompetitiveForm
          key={`edit-${editing.record.recordId}`}
          open
          record={editing.record}
          existingNotes={editing.notes}
          options={options.data ?? EMPTY_FORM_OPTIONS}
          user={user}
          signedInName={user?.name ?? session?.user?.name ?? ""}
          applicationSuggestions={[]}
          onClose={() => setEditing(null)}
          onSaved={(response) => {
            setMessage(savedMessage(response, "updated"));
            setEditing(null);
            void gallery.reload();
          }}
        />
      )}

      <AuditDrawer record={auditRow} onClose={() => setAuditRow(null)} />
    </RoleGuard>
  );
}

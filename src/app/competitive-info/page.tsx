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
import { downloadXlsx } from "@/lib/xlsx";
import { EMPTY_FORM_OPTIONS } from "@/lib/ci/empty";
import { unexpectedWaferValues, waferDisplay, WAFER_SIZE_COLUMN } from "@/lib/ci/wafer-size";
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

/** Grid columns built from the table's real columns. The only column treated specially is Wafer Size, shown with its approved label (lib/ci/wafer-size.ts). */
function buildColumns(gallery: GalleryResponse): GridColumn<GalleryRow>[] {
  return gallery.columns.map((c) => {
    const numeric = NUMERIC_TYPE.test(c.type);
    const distinct = new Set(gallery.rows.map((r) => r[c.name]).filter((v) => v !== ""));
    return {
      key: c.name,
      label: c.name,
      filter: distinct.size > 0 && distinct.size <= SELECT_FILTER_MAX_DISTINCT ? "select" : "text",
      numeric,
      value: c.name === WAFER_SIZE_COLUMN ? (r) => waferDisplay(r[c.name] ?? "") : (r) => r[c.name] ?? "",
      sortValue: numeric ? (r) => (r[c.name] === "" ? Number.NEGATIVE_INFINITY : Number(r[c.name])) : undefined,
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
  const [auditRow, setAuditRow] = React.useState<{ recordId: string; customer: string; servedMarket: string; quarter: string; year: string } | null>(null);

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

  const data = gallery.data;
  const rows = React.useMemo(() => data?.rows ?? [], [data]);
  const columns = React.useMemo(() => (data ? buildColumns(data) : []), [data]);
  // Wafer Size values outside 150 / 200 / 300 are shown exactly as stored and reported, never converted.
  const oddWafers = React.useMemo(() => unexpectedWaferValues(rows.map((r) => r[WAFER_SIZE_COLUMN] ?? "")), [rows]);
  // The grid keeps its own column-visibility state, so it is rebuilt whenever the table's columns change.
  const gridKey = data ? `${data.table}|${data.columns.map((c) => c.name).join(",")}` : "pending";

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
      <PageHeader
        eyebrow="7.1"
        title="All Competitive Info View"
        description="Competitive wins, losses and pricing by customer, fab and technology node."
      />

      {message && <StatusBanner message={message} onDismiss={() => setMessage(null)} />}
      {gallery.errorMessage && <StatusBanner message={{ kind: "bad", text: gallery.errorMessage }} />}
      {oddWafers.length > 0 && (
        <StatusBanner message={{ kind: "warn", text: `Wafer Size has unexpected stored value${oddWafers.length === 1 ? "" : "s"} (shown as stored): ${oddWafers.join(", ")}.` }} />
      )}
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
                    title="Edit row"
                    aria-label={`Edit row ${r[RECORD_COLUMNS.recordId]}`}
                    disabled={options.loading || Boolean(options.error) || opening !== null}
                    onClick={() => void openEdit(r)}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className={iconButton}
                    title="Audit history"
                    aria-label={`Audit history of row ${r[RECORD_COLUMNS.recordId]}`}
                    onClick={() =>
                      setAuditRow({
                        recordId: r[RECORD_COLUMNS.recordId],
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

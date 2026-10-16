"use client";

import * as React from "react";
import { Download } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { RoleGuard } from "@/components/ci/role-guard";
import { DataGrid } from "@/components/ci/data-grid";
import { FfAnalysisPanel } from "@/components/ci/ff-analysis-panel";
import { recordColumn } from "@/components/ci/record-columns";
import { NotConnectedState } from "@/components/ci/not-connected";
import { StatusBanner, type StatusMessage } from "@/components/ci/status-banner";
import { useCiData } from "@/hooks/use-ci-data";
import { ciApi } from "@/lib/ci/api";
import { FF_FIELD_KEYS, FIELDS } from "@/lib/ci/field-spec";
import { downloadXlsx } from "@/lib/xlsx";
import { cn } from "@/lib/utils";
import type { CompetitiveRecord } from "@/types/ci";

// The flat-file fields only (no Record ID and no Last Modified By / On columns).
const FF_COLUMNS = FF_FIELD_KEYS.map(recordColumn);

type Tab = "data" | "analysis";

/**
 * BRD §7.4 Competitive FF — Corporate Marketing only (CI Prototype). Two tabs: Data, a read-only flat file with a filter on every
 * column, sort, Columns and Export to Excel; and Analysis, filters, totals and charts calculated in Databricks over every matching
 * row (components/ci/ff-analysis-panel.tsx). Edits are made in All Competitive Info View.
 */
export default function CompetitiveFfPage() {
  const [tab, setTab] = React.useState<Tab>("data");
  return (
    <RoleGuard roles={["CM"]}>
      <PageHeader
        eyebrow="7.4"
        title="Competitive FF"
        description="Read-only flat file of every row for Corporate Marketing: query it on the Data tab, chart it on the Analysis tab (no editing here)"
      />
      <div className="mb-2 flex shrink-0 gap-1.5" role="tablist">
        {(["data", "analysis"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              "rounded-full border px-3.5 py-1 text-[12.5px] font-semibold transition-colors",
              tab === t ? "border-accent bg-accent text-white" : "border-border-strong bg-surface text-muted hover:bg-accent-bg hover:text-accent"
            )}
          >
            {t === "data" ? "Data" : "Analysis"}
          </button>
        ))}
      </div>
      {tab === "data" ? <FlatFileData /> : <FfAnalysisPanel />}
    </RoleGuard>
  );
}

function FlatFileData() {
  const flat = useCiData(() => ciApi.flatFile());
  const records = { ...flat, data: flat.data?.records ?? null };
  const [message, setMessage] = React.useState<StatusMessage | null>(null);
  const rows = React.useMemo(() => records.data ?? [], [records.data]);

  // The export carries every column shown, as an Excel workbook. Numeric columns are written as numbers; every other value,
  // including the dates, is written exactly as stored.
  async function exportRows(filtered: CompetitiveRecord[]) {
    await downloadXlsx("CI_Competitive_FF.xlsx", [
      {
        name: "Competitive FF",
        rows: [
          FIELDS.map((f) => f.label),
          ...filtered.map((r) =>
            FIELDS.map((f) => {
              const v = r[f.key];
              return f.numeric && v !== "" && v != null && Number.isFinite(Number(v)) ? Number(v) : String(v ?? "");
            })
          ),
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
    <>
      {message && <StatusBanner message={message} onDismiss={() => setMessage(null)} />}
      {records.errorMessage && <StatusBanner message={{ kind: "bad", text: records.errorMessage }} />}
      {flat.data?.truncated && (
        <StatusBanner message={{ kind: "warn", text: `Only the newest ${flat.data.rowLimit} rows are shown in this grid; the table holds more. The Analysis tab covers every row.` }} />
      )}
      <DataGrid
        columns={FF_COLUMNS}
        rows={rows}
        rowKey={(r) => r.recordId}
        loading={records.loading}
        onReload={() => void records.reload()}
        searchPlaceholder="Search all columns"
        emptyState={records.notConfigured ? <NotConnectedState what="The flat file" pending={records.pendingTables} /> : undefined}
        toolbar={(filtered) => (
          <Button size="sm" variant="outline" onClick={() => void exportRows(filtered)} disabled={records.loading || records.notConfigured}>
            <Download className="h-3.5 w-3.5" /> Export to Excel
          </Button>
        )}
      />
    </>
  );
}

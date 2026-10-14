"use client";

import * as React from "react";
import { Download } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { RoleGuard } from "@/components/ci/role-guard";
import { DataGrid } from "@/components/ci/data-grid";
import { RECORD_ID_COLUMN, recordColumn } from "@/components/ci/record-columns";
import { NotConnectedState } from "@/components/ci/not-connected";
import { StatusBanner, type StatusMessage } from "@/components/ci/status-banner";
import { useCiData } from "@/hooks/use-ci-data";
import { ciApi } from "@/lib/ci/api";
import { FF_FIELD_KEYS, FIELDS, RECORD_ID_LABEL } from "@/lib/ci/field-spec";
import { downloadXlsx } from "@/lib/xlsx";
import type { CompetitiveRecord } from "@/types/ci";

// CI Prototype FF columns: Record ID, then the flat-file fields.
const FF_COLUMNS = [RECORD_ID_COLUMN, ...FF_FIELD_KEYS.map(recordColumn)];

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <Card className="px-3.5 py-3">
      <p className="text-[22px] font-semibold tabular-nums text-foreground">{value}</p>
      <p className="text-[12px] text-muted">{label}</p>
    </Card>
  );
}

/**
 * BRD §7.4 Competitive FF — Corporate Marketing only. Read-only flat file of
 * all competitive data with summary tiles, a filter on every column, header
 * sort, a bar chart of order quantity by top competitor, and Export to Excel
 * (CI Prototype). Edits are made in All Competitive Info View.
 *
 * Everything here is computed from the rows the API returns; until the CI
 * Competitive Info table is configured the screen shows "configuration is
 * pending" and no numbers.
 */
export default function CompetitiveFfPage() {
  const flat = useCiData(() => ciApi.flatFile());
  const records = { ...flat, data: flat.data?.records ?? null };
  const [message, setMessage] = React.useState<StatusMessage | null>(null);
  const rows = React.useMemo(() => records.data ?? [], [records.data]);

  const stats = React.useMemo(() => {
    const byCompetitor = new Map<string, number>();
    for (const r of rows) byCompetitor.set(r.topCompetitor, (byCompetitor.get(r.topCompetitor) ?? 0) + (Number(r.actualOrder) || 0));
    const top = Array.from(byCompetitor.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    return {
      customers: new Set(rows.map((r) => r.customer)).size,
      competitors: byCompetitor.size,
      totalOrders: rows.reduce((sum, r) => sum + (Number(r.actualOrder) || 0), 0),
      top,
      topMax: top[0]?.[1] || 1,
    };
  }, [rows]);

  // CI Prototype: the flat-file export carries Record ID plus every column (not just the
  // ones shown here), as an Excel workbook, so the same file doubles as the import template.
  async function exportRows(filtered: CompetitiveRecord[]) {
    await downloadXlsx("CI_Competitive_FF.xlsx", [
      {
        name: "Competitive FF",
        rows: [
          [RECORD_ID_LABEL, ...FIELDS.map((f) => f.label)],
          ...filtered.map((r) => [
            r.recordId,
            ...FIELDS.map((f) => {
              const v = r[f.key];
              return f.numeric && v !== "" && v != null && Number.isFinite(Number(v)) ? Number(v) : String(v ?? "");
            }),
          ]),
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
    <RoleGuard roles={["CM"]}>
      <PageHeader
        eyebrow="7.4"
        title="Competitive FF"
        description="Flat-file view for analysis, with Excel export (Corporate Marketing only)"
      />

      {message && <StatusBanner message={message} onDismiss={() => setMessage(null)} />}
      {records.errorMessage && <StatusBanner message={{ kind: "bad", text: records.errorMessage }} />}
      {flat.data?.truncated && (
        <StatusBanner message={{ kind: "warn", text: `Only the newest ${flat.data.rowLimit} rows are shown; the table holds more.` }} />
      )}

      {!records.notConfigured && (
        <div className="mb-2 grid shrink-0 grid-cols-2 gap-2.5 md:grid-cols-4">
          <Stat value={records.loading ? "—" : fmt(rows.length)} label="Rows in the table" />
          <Stat value={records.loading ? "—" : fmt(stats.customers)} label="Customers" />
          <Stat value={records.loading ? "—" : fmt(stats.competitors)} label="Competitors tracked" />
          <Stat value={records.loading ? "—" : fmt(stats.totalOrders)} label="Total order quantity" />
        </div>
      )}

      <DataGrid
        columns={FF_COLUMNS}
        rows={rows}
        rowKey={(r) => r.recordId}
        loading={records.loading}
        onReload={() => void records.reload()}
        defaultSort={{ key: "recordId", dir: -1 }}
        searchPlaceholder="Search flat file"
        emptyState={records.notConfigured ? <NotConnectedState what="The flat file" pending={records.pendingTables} /> : undefined}
        toolbar={(filtered) => (
          <Button size="sm" variant="outline" onClick={() => void exportRows(filtered)} disabled={records.loading || records.notConfigured}>
            <Download className="h-3.5 w-3.5" /> Export to Excel
          </Button>
        )}
      />

      {!records.notConfigured && !records.loading && stats.top.length > 0 && (
        <Card className="mt-3 shrink-0 p-4">
          <p className="mb-2 text-[13px] font-semibold text-foreground">Order quantity by top competitor</p>
          <div className="grid gap-1.5">
            {stats.top.map(([competitor, qty]) => (
              <div key={competitor} className="grid grid-cols-[110px_1fr_70px] items-center gap-2.5 text-[12.5px]">
                <span className="truncate text-foreground">{competitor}</span>
                <div className="h-2.5 overflow-hidden rounded-full bg-surface-alt">
                  <div className="h-full rounded-full bg-spark-teal" style={{ width: `${Math.round((qty / stats.topMax) * 100)}%` }} />
                </div>
                <span className="text-right tabular-nums text-foreground">{fmt(qty)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </RoleGuard>
  );
}

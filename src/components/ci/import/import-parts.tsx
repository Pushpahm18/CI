"use client";

import * as React from "react";
import { Download, FileSpreadsheet, Upload, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableWrap, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { PaginationFooter, usePagination } from "@/components/ui/pagination";
import { downloadCsv } from "@/lib/csv";
import { cn } from "@/lib/utils";
import type { ImportIssue, IssueSeverity } from "@/lib/ci/import/types";

/**
 * Building blocks of the Import screen, laid out as in the CI Prototype's
 * Import screen and styled only with the app's globals.css tokens.
 */

const SIZE_UNITS = ["B", "KB", "MB"];
export function formatBytes(bytes: number): string {
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < SIZE_UNITS.length - 1) {
    n /= 1024;
    u++;
  }
  return `${n.toFixed(u === 0 ? 0 : 1)} ${SIZE_UNITS[u]}`;
}

/** CI Prototype "vbox": a soft, rounded message box. */
export function VBox({
  tone = "neutral",
  className,
  children,
}: {
  tone?: "neutral" | "warning" | "danger" | "success";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-[10px] px-3 py-2.5 text-[13px] text-foreground",
        tone === "neutral" && "bg-surface-alt",
        tone === "warning" && "bg-warning-bg",
        tone === "danger" && "bg-danger-bg",
        tone === "success" && "bg-success-bg",
        className
      )}
    >
      {children}
    </div>
  );
}

/** CI Prototype ".sec": small uppercase section heading. */
export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 font-sans text-[12px] font-bold uppercase tracking-[0.8px] text-muted">{children}</h3>;
}

export type PillTone = "ok" | "warn" | "danger" | "role" | "off";
const PILL_CLASS: Record<PillTone, string> = {
  ok: "",
  warn: "",
  danger: "",
  role: "border-spark-teal/20 bg-spark-teal-bg text-spark-teal",
  off: "",
};
const PILL_BADGE_TONE: Record<PillTone, "success" | "warning" | "danger" | "neutral"> = {
  ok: "success",
  warn: "warning",
  danger: "danger",
  role: "neutral",
  off: "neutral",
};

/** CI Prototype ".pill" status chip (ui/Badge underneath). */
export function Pill({ tone, children }: { tone: PillTone; children: React.ReactNode }) {
  return (
    <Badge tone={PILL_BADGE_TONE[tone]} className={cn("px-2 text-[11.5px] font-semibold", PILL_CLASS[tone])}>
      {children}
    </Badge>
  );
}

/** CI Prototype "Choose file" (small outline button) + the chosen file's name, type and size, with Remove. */
export function FileChooser({
  file,
  accept,
  disabled,
  onChoose,
  onRemove,
  label = "Choose file",
}: {
  label?: string;
  file: File | null;
  accept: string;
  disabled?: boolean;
  onChoose: (file: File) => void;
  onRemove: () => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <>
      <label
        className={cn(
          buttonVariants({ variant: "outline" }),
          "relative cursor-pointer overflow-hidden",
          disabled && "pointer-events-none opacity-50"
        )}
      >
        <Upload className="h-4 w-4" /> {label}
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          title="Choose file"
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (inputRef.current) inputRef.current.value = "";
            if (f) onChoose(f);
          }}
        />
      </label>
      {file && (
        <span className="inline-flex items-center gap-2 rounded-md border border-border-strong bg-surface px-2.5 py-1 text-[12.5px] text-foreground">
          <FileSpreadsheet className="h-3.5 w-3.5 text-accent" />
          <span className="font-medium">{file.name}</span>
          <span className="text-muted">
            {file.name.split(".").pop()?.toUpperCase()} · {formatBytes(file.size)}
          </span>
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            aria-label="Remove file"
            title="Remove file"
            className="rounded p-0.5 text-muted hover:bg-danger-bg hover:text-danger disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      )}
    </>
  );
}

/** CI Prototype ".stat" summary tile. */
export function Stat({ value, label, tone }: { value: number | string; label: string; tone?: "danger" }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-3.5 py-3">
      <p className={cn("block text-[22px] font-semibold tabular-nums leading-tight", tone === "danger" ? "text-danger" : "text-foreground")}>
        {value}
      </p>
      <p className="text-[12px] text-muted">{label}</p>
    </div>
  );
}

export function StatRow({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">{children}</div>;
}

/** The paste-CSV box of the CI Prototype (monospace, 150px tall). */
export const PasteArea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function PasteArea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      spellCheck={false}
      className={cn(
        "min-h-[150px] w-full rounded-lg border border-border-strong bg-surface px-2.5 py-2 font-mono text-[12px] leading-relaxed text-foreground",
        "focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60",
        className
      )}
      {...props}
    />
  );
});

const SEVERITY_TONE: Record<IssueSeverity, PillTone> = { error: "danger", warning: "warn", info: "off" };
const SEVERITY_LABEL: Record<IssueSeverity, string> = { error: "Error", warning: "Warning", info: "Info" };

export function downloadIssues(issues: ImportIssue[], fileName: string) {
  downloadCsv(
    `${fileName.replace(/\.[^.]+$/, "")}-validation-report.csv`,
    issues.map((i) => ({ Row: i.row, Field: i.field, Value: i.value, Error: i.message, Severity: SEVERITY_LABEL[i.severity] }))
  );
}

/** Row-level validation report (Row, Field, Value, Error, Severity) with CSV download. */
export function IssuesReport({ issues, fileName }: { issues: ImportIssue[]; fileName: string }) {
  const [filter, setFilter] = React.useState<IssueSeverity | "all">("error");
  const shown = React.useMemo(() => (filter === "all" ? issues : issues.filter((i) => i.severity === filter)), [issues, filter]);
  const { pageItems, page, pageCount, pageSize, total, setPage, setPageSize } = usePagination(shown, 25);
  const counts = (s: IssueSeverity) => issues.filter((i) => i.severity === s).length;
  if (issues.length === 0) return null;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <SectionTitle>Validation report</SectionTitle>
        <select
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value as IssueSeverity | "all");
            setPage(1);
          }}
          aria-label="Show"
          className="mb-2 h-7 rounded-md border border-border-strong bg-surface px-1.5 text-[12.5px] text-foreground"
        >
          <option value="error">Errors ({counts("error")})</option>
          <option value="warning">Warnings ({counts("warning")})</option>
          <option value="info">Info ({counts("info")})</option>
          <option value="all">All ({issues.length})</option>
        </select>
        <Button size="sm" variant="outline" className="mb-2 ml-auto" onClick={() => downloadIssues(issues, fileName)}>
          <Download className="h-3.5 w-3.5" /> Download report
        </Button>
      </div>
      <TableWrap>
        <Table>
          <THead>
            <TR>
              <TH>Row</TH>
              <TH>Field</TH>
              <TH>Value</TH>
              <TH>Error</TH>
              <TH>Severity</TH>
            </TR>
          </THead>
          <TBody>
            {pageItems.map((i, n) => (
              <TR key={`${i.row}-${i.field}-${n}`}>
                <TD className="tabular-nums">{i.row}</TD>
                <TD>{i.field}</TD>
                <TD className="max-w-[200px] truncate" title={i.value}>
                  {i.value || <span className="text-muted-2">—</span>}
                </TD>
                <TD className="text-left">{i.message}</TD>
                <TD>
                  <Pill tone={SEVERITY_TONE[i.severity]}>{SEVERITY_LABEL[i.severity]}</Pill>
                </TD>
              </TR>
            ))}
            {pageItems.length === 0 && (
              <TR>
                <TD colSpan={5} className="py-6 text-center text-muted">
                  Nothing to show for this filter.
                </TD>
              </TR>
            )}
          </TBody>
        </Table>
      </TableWrap>
      {total > 25 && (
        <PaginationFooter page={page} pageCount={pageCount} pageSize={pageSize} total={total} onPageChange={setPage} onPageSizeChange={setPageSize} />
      )}
    </div>
  );
}
